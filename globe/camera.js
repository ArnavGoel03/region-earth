/* Orbit camera and the 4x4 maths it needs. The globe never moves: the camera
   flies around it. That keeps surface normals equal to vertex positions in every
   shader, and makes a pick ray something you can intersect with a unit sphere in
   four lines instead of round-tripping through an inverse model matrix. */

import { DEG, latLonToVec3, raySphere, vec3ToLatLon } from "./geo.js";
import { CAMERA, LOOK } from "./params.js";

/* ---------- mat4, column major, the layout both GL and WebGPU expect ---------- */

/**
 * Vertical field of view that keeps the globe framed on any viewport shape.
 *
 * CAMERA.fov is a vertical angle, so on a portrait screen the horizontal field
 * is the narrow one and a sphere sized to fit the height runs off both sides.
 * Below square, the vertical angle opens up by exactly enough to hold the
 * horizontal field at its square-viewport value, which is the axis actually
 * doing the constraining. Landscape is left alone.
 */
export function fitFov(aspect) {
  if (aspect >= 1) return CAMERA.fov;
  return (2 * Math.atan(Math.tan((CAMERA.fov * DEG) / 2) / aspect)) / DEG;
}

/**
 * @param yBias NDC units to lift the image by, for when chrome covers part of
 *   the frame. Shifting the frustum rather than the camera keeps the globe a
 *   sphere: moving the eye would swing it round and show a different face, and
 *   translating the canvas in CSS would put picking out of step with what is on
 *   screen. Because this lives in the matrix, the inverse used by the ray
 *   picker follows it for free.
 */
export function perspective(out, fovDeg, aspect, near, far, yBias = 0) {
  const f = 1 / Math.tan((fovDeg * DEG) / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  /* y_ndc works out to f * y_eye / -z_eye - out[9], so the sign flips here. */
  out[9] = -yBias;
  out[11] = -1;
  out[10] = (far + near) / (near - far);
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function lookAt(out, eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function invert(out, m) {
  const [
    a00, a01, a02, a03,
    a10, a11, a12, a13,
    a20, a21, a22, a23,
    a30, a31, a32, a33,
  ] = m;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/* ---------- orbit controller ---------- */

const shortestTurn = (delta) => ((((delta + 180) % 360) + 360) % 360) - 180;

export class Orbit {
  constructor() {
    this.lat = CAMERA.startLat;
    this.lon = CAMERA.startLon;
    this.distance = CAMERA.startDistance;
    this.targetDistance = CAMERA.startDistance;
    this.velLat = 0;
    this.velLon = 0;
    this.dragging = false;
    this.lastInput = 0;
    this.autoRotate = true;
    this.flight = null;

    this.eye = [0, 0, CAMERA.startDistance];
    this.view = new Float32Array(16);
    this.proj = new Float32Array(16);
    this.viewProj = new Float32Array(16);
    this.inverse = new Float32Array(16);
  }

  /** Pointer drag, in pixels, scaled so a drag tracks the surface under it. */
  drag(dx, dy, now) {
    const scale = 0.22 * (this.distance / CAMERA.startDistance);
    this.velLon = -dx * scale;
    this.velLat = dy * scale;
    this.lon += this.velLon;
    this.lat += this.velLat;
    this.clampPitch();
    this.lastInput = now;
  }

  zoom(factor, now) {
    this.targetDistance = Math.min(
      CAMERA.maxDistance,
      Math.max(CAMERA.minDistance, this.targetDistance * factor),
    );
    this.lastInput = now;
  }

  nudge(dLon, dLat, now) {
    this.lon += dLon;
    this.lat += dLat;
    this.clampPitch();
    this.lastInput = now;
    this.flight = null;
  }

  clampPitch() {
    this.lat = Math.min(CAMERA.pitchLimit, Math.max(-CAMERA.pitchLimit, this.lat));
  }

  /** Ease the camera to a coordinate, used by search and by marker clicks. */
  flyTo(lat, lon, distance, now, duration = 900) {
    this.flight = {
      fromLat: this.lat,
      fromLon: this.lon,
      fromDist: this.distance,
      toLat: Math.min(CAMERA.pitchLimit, Math.max(-CAMERA.pitchLimit, lat)),
      /* Take the short way round rather than unwinding the long way. */
      toLon: this.lon + shortestTurn(lon - this.lon),
      toDist: distance ?? this.targetDistance,
      start: now,
      duration,
    };
    this.targetDistance = this.flight.toDist;
    this.lastInput = now;
  }

  reset(now) {
    this.flyTo(CAMERA.startLat, CAMERA.startLon, CAMERA.startDistance, now);
  }

  update(now, dt, aspect, reducedMotion, yBias = 0) {
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.duration);
      /* Cubic ease-out: quick departure, settled arrival. */
      const e = 1 - (1 - t) ** 3;
      this.lat = this.flight.fromLat + (this.flight.toLat - this.flight.fromLat) * e;
      this.lon = this.flight.fromLon + (this.flight.toLon - this.flight.fromLon) * e;
      this.distance =
        this.flight.fromDist + (this.flight.toDist - this.flight.fromDist) * e;
      if (t >= 1) this.flight = null;
    } else {
      if (!this.dragging) {
        /* Inertia, then a slow drift once the pointer has been quiet a while. */
        this.lon += this.velLon;
        this.lat += this.velLat;
        this.clampPitch();
        const damping = 0.92 ** (dt / 16.7);
        this.velLat *= damping;
        this.velLon *= damping;
        if (Math.abs(this.velLat) < 1e-4) this.velLat = 0;
        if (Math.abs(this.velLon) < 1e-4) this.velLon = 0;

        const idle = now - this.lastInput > LOOK.idleDelay;
        if (this.autoRotate && idle && !reducedMotion && !this.velLon) {
          this.lon += (LOOK.autoRotate * dt) / 1000;
        }
      }
      this.distance += (this.targetDistance - this.distance) * (1 - 0.86 ** (dt / 16.7));
    }

    this.lon = ((((this.lon + 180) % 360) + 360) % 360) - 180;
    latLonToVec3(this.lat, this.lon, this.distance, this.eye);
    lookAt(this.view, this.eye, [0, 0, 0], [0, 1, 0]);
    perspective(this.proj, fitFov(aspect), aspect, CAMERA.near, CAMERA.far, yBias);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.inverse, this.viewProj);
    return this.viewProj;
  }

  /**
   * Where a screen position lands on the globe.
   * @returns {{lat: number, lon: number} | null} null when the ray misses.
   */
  pick(ndcX, ndcY) {
    const unproject = (z) => {
      const m = this.inverse;
      const w = m[3] * ndcX + m[7] * ndcY + m[11] * z + m[15];
      return [
        (m[0] * ndcX + m[4] * ndcY + m[8] * z + m[12]) / w,
        (m[1] * ndcX + m[5] * ndcY + m[9] * z + m[13]) / w,
        (m[2] * ndcX + m[6] * ndcY + m[10] * z + m[14]) / w,
      ];
    };
    const near = unproject(-1);
    const far = unproject(1);
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const hit = raySphere(near, [dx, dy, dz], 1);
    return hit ? vec3ToLatLon(hit[0], hit[1], hit[2]) : null;
  }
}
