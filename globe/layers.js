/* Turns the decoded geography into the vertex buffers the GPU draws. Pure
   arithmetic over typed arrays, no GL calls, so both backends consume the same
   result and the tests can exercise it under node. */

import { DEG, countryAt, latLonToVec3 } from "./geo.js";
import { RADII, FIELD } from "./params.js";

/**
 * The dot field: one point per land cell on an equal-area sampling of the
 * sphere. Ring counts scale with cos(latitude) so dots stay evenly spread
 * instead of bunching at the poles, and every dot carries the country index it
 * landed in, which is what lets a whole nation light up on hover.
 *
 * @returns {{data: Float32Array, count: number}} interleaved x, y, z, countryId
 */
export function buildDotField(idmap, spacing = FIELD.spacing) {
  const rings = Math.max(2, Math.round(180 / spacing));

  /* Sweep once to count, allocate exactly, then sweep again to fill. The
     density slider rebuilds this on every change, so growing an array here
     would mean reallocating megabytes mid-drag. */
  const sweep = (visit) => {
    let n = 0;
    for (let r = 0; r < rings; r++) {
      const lat = -90 + ((r + 0.5) * 180) / rings;
      const perRing = Math.max(1, Math.round((360 / spacing) * Math.cos(lat * DEG)));
      for (let i = 0; i < perRing; i++) {
        const lon = -180 + ((i + 0.5) * 360) / perRing;
        const id = countryAt(idmap, lat, lon);
        if (id === 0) continue;
        if (visit) visit(lat, lon, id, n);
        n++;
      }
    }
    return n;
  };

  const count = sweep(null);
  const data = new Float32Array(count * 4);
  sweep((lat, lon, id, n) => {
    const at = n * 4;
    latLonToVec3(lat, lon, RADII.dots, scratch);
    data[at] = scratch[0];
    data[at + 1] = scratch[1];
    data[at + 2] = scratch[2];
    data[at + 3] = id;
  });
  return { data, count };
}

const scratch = [0, 0, 0];

/** Angular distance in radians between two coordinates. */
function angleBetween(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const a =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Walk one arc's coordinate list, subdividing any segment long enough to visibly
 * cut through the sphere, and hand each resulting point to `emit`.
 */
function walkArc(flat, radius, maxSegRad, emit) {
  const n = flat.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const lon1 = flat[i * 2];
    const lat1 = flat[i * 2 + 1];
    const lon2 = flat[i * 2 + 2];
    const lat2 = flat[i * 2 + 3];
    const omega = angleBetween(lat1, lon1, lat2, lon2);
    const steps = Math.max(1, Math.ceil(omega / maxSegRad));

    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      /* Linear interpolation of the coordinates then re-projection to the
         sphere. At these segment lengths it is indistinguishable from a slerp
         and avoids the degenerate case when endpoints coincide. */
      latLonToVec3(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t, radius, scratch);
      if (s > 0) emit(ax, ay, az, scratch[0], scratch[1], scratch[2]);
      ax = scratch[0];
      ay = scratch[1];
      az = scratch[2];
    }
  }
}

/**
 * Country outlines as an unindexed line list. Arcs are shared between
 * neighbours in the source, so drawing the arc set draws every border exactly
 * once with no doubled-up strokes along shared frontiers.
 */
export function buildBorders(arcs, radius = RADII.border) {
  const maxSegRad = FIELD.maxSegmentDeg * DEG;
  let segments = 0;
  for (const arc of arcs) {
    walkArc(arc, radius, maxSegRad, () => {
      segments++;
    });
  }
  const data = new Float32Array(segments * 6);
  let at = 0;
  for (const arc of arcs) {
    walkArc(arc, radius, maxSegRad, (x1, y1, z1, x2, y2, z2) => {
      data[at++] = x1;
      data[at++] = y1;
      data[at++] = z1;
      data[at++] = x2;
      data[at++] = y2;
      data[at++] = z2;
    });
  }
  return { data, count: segments * 2 };
}

/** The same treatment for one country's arcs, rebuilt whenever hover changes. */
export function buildCountryOutline(arcs, arcIndices, radius = RADII.highlight) {
  const maxSegRad = FIELD.maxSegmentDeg * DEG;
  let segments = 0;
  for (const idx of arcIndices) {
    walkArc(arcs[idx], radius, maxSegRad, () => {
      segments++;
    });
  }
  const data = new Float32Array(segments * 6);
  let at = 0;
  for (const idx of arcIndices) {
    walkArc(arcs[idx], radius, maxSegRad, (x1, y1, z1, x2, y2, z2) => {
      data[at++] = x1;
      data[at++] = y1;
      data[at++] = z1;
      data[at++] = x2;
      data[at++] = y2;
      data[at++] = z2;
    });
  }
  return { data, count: segments * 2 };
}

/** Meridians and parallels, as a line list. */
export function buildGraticule(step = FIELD.graticuleStep, radius = RADII.graticule) {
  const pts = [];
  const push = (lat1, lon1, lat2, lon2) => {
    latLonToVec3(lat1, lon1, radius, scratch);
    pts.push(scratch[0], scratch[1], scratch[2]);
    latLonToVec3(lat2, lon2, radius, scratch);
    pts.push(scratch[0], scratch[1], scratch[2]);
  };
  for (let lon = -180; lon < 180; lon += step) {
    for (let lat = -90; lat < 90; lat += 2) push(lat, lon, lat + 2, lon);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let lon = -180; lon < 180; lon += 2) push(lat, lon, lat, lon + 2);
  }
  const data = new Float32Array(pts);
  return { data, count: data.length / 3 };
}

/** A UV sphere for the ocean shell and the atmosphere halo. */
export function buildSphere(segments = 96, rings = 64, radius = RADII.ocean) {
  const positions = new Float32Array((rings + 1) * (segments + 1) * 3);
  let at = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI - Math.PI / 2;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const cosPhi = Math.cos(phi);
      positions[at++] = radius * cosPhi * Math.sin(theta);
      positions[at++] = radius * Math.sin(phi);
      positions[at++] = radius * cosPhi * Math.cos(theta);
    }
  }
  const indices = new Uint32Array(rings * segments * 6);
  at = 0;
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      /* Counter-clockwise seen from outside, which is what both APIs treat as
         front facing. Reversed, back-face culling would erase the globe. */
      indices[at++] = a;
      indices[at++] = a + 1;
      indices[at++] = b;
      indices[at++] = a + 1;
      indices[at++] = b + 1;
      indices[at++] = b;
    }
  }
  return { positions, indices, count: indices.length };
}
