/* Decoders for the build artefacts, plus the sphere maths every other module
   shares. Nothing in here touches the GPU or the DOM, which is what lets the
   tests run it under plain node. */

export const DEG = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;

/* ---------- varint reader ---------- */

class ByteReader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.pos = 0;
  }
  ascii(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos++]);
    return s;
  }
  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  uint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.bytes[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }
  int() {
    const v = this.uint();
    return v & 1 ? -(v + 1) / 2 : v / 2;
  }
}

/* ---------- borders.bin ---------- */

/**
 * @returns {{arcs: Float32Array[], countryArcs: Uint16Array[], pointCount: number}}
 *   Each arc is a flat [lon, lat, lon, lat, ...] run in degrees. `countryArcs[i]`
 *   lists the arcs forming country `i + 1`, matching the country table's
 *   one-based indexing.
 */
export function decodeBorders(buffer) {
  const r = new ByteReader(buffer);
  if (r.ascii(4) !== "RE01") throw new Error("borders.bin: bad magic");
  const sx = r.f64();
  const sy = r.f64();
  const tx = r.f64();
  const ty = r.f64();

  const arcCount = r.uint();
  const arcs = new Array(arcCount);
  let pointCount = 0;
  for (let a = 0; a < arcCount; a++) {
    const n = r.uint();
    const flat = new Float32Array(n * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      /* Position 0 is absolute in the source, the rest are deltas, and summing
         from zero handles both because the first delta starts at the origin. */
      x += r.int();
      y += r.int();
      flat[i * 2] = x * sx + tx;
      flat[i * 2 + 1] = y * sy + ty;
    }
    arcs[a] = flat;
    pointCount += n;
  }

  const countryCount = r.uint();
  const countryArcs = new Array(countryCount);
  for (let c = 0; c < countryCount; c++) {
    const n = r.uint();
    const list = new Uint16Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.int();
      list[i] = prev;
    }
    countryArcs[c] = list;
  }

  return { arcs, countryArcs, pointCount };
}

/* ---------- idmap.bin ---------- */

/** @returns {{width: number, height: number, cells: Uint16Array}} */
export function decodeIdMap(buffer) {
  const r = new ByteReader(buffer);
  if (r.ascii(4) !== "RE02") throw new Error("idmap.bin: bad magic");
  const width = r.uint();
  const height = r.uint();
  const cells = new Uint16Array(width * height);
  let at = 0;
  while (at < cells.length) {
    const id = r.uint();
    const run = r.uint();
    if (id !== 0) cells.fill(id, at, at + run);
    at += run;
  }
  return { width, height, cells };
}

/** Country index at a coordinate, or 0 for ocean. */
export function countryAt(map, lat, lon) {
  /* Wrap rather than clamp in longitude: dragging past the antimeridian is
     normal, and a clamp would smear the eastern edge of the map. */
  let l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const x = Math.min(map.width - 1, Math.floor(((l + 180) / 360) * map.width));
  const y = Math.min(
    map.height - 1,
    Math.max(0, Math.floor(((90 - lat) / 180) * map.height)),
  );
  return map.cells[y * map.width + x];
}

/* ---------- sphere maths ---------- */

/** Geographic coordinate to a point on the unit sphere. */
export function latLonToVec3(lat, lon, radius = 1, out = [0, 0, 0]) {
  const phi = lat * DEG;
  const theta = lon * DEG;
  const cosPhi = Math.cos(phi);
  out[0] = radius * cosPhi * Math.sin(theta);
  out[1] = radius * Math.sin(phi);
  out[2] = radius * cosPhi * Math.cos(theta);
  return out;
}

export function vec3ToLatLon(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(y / r) / DEG,
    lon: Math.atan2(x, z) / DEG,
  };
}

/**
 * Nearest intersection of a ray with the unit sphere.
 * @returns {[number, number, number] | null} the hit point, or null if it misses.
 */
export function raySphere(origin, dir, radius = 1) {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  /* Near root first; fall back to the far one when the camera is inside. */
  let t = -b - root;
  if (t < 0) t = -b + root;
  if (t < 0) return null;
  return [ox + dx * t, oy + dy * t, oz + dz * t];
}

/** Great-circle distance in kilometres. */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = (lat2 - lat1) * DEG;
  const dl = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Points along a great circle between two coordinates, lifted into an arc whose
 * height scales with the distance covered. Short hops stay near the surface,
 * intercontinental ones bow out, which is what makes a tangle of arcs readable.
 */
export function arcPoints(lat1, lon1, lat2, lon2, segments = 64, lift = 0.18) {
  const a = latLonToVec3(lat1, lon1);
  const b = latLonToVec3(lat2, lon2);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const height = lift * (omega / Math.PI);
  const pts = new Float32Array((segments + 1) * 3);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let x;
    let y;
    let z;
    if (sinOmega < 1e-6) {
      /* Coincident endpoints: slerp degenerates, so interpolate linearly. */
      x = a[0] + (b[0] - a[0]) * t;
      y = a[1] + (b[1] - a[1]) * t;
      z = a[2] + (b[2] - a[2]) * t;
    } else {
      const wa = Math.sin((1 - t) * omega) / sinOmega;
      const wb = Math.sin(t * omega) / sinOmega;
      x = a[0] * wa + b[0] * wb;
      y = a[1] * wa + b[1] * wb;
      z = a[2] * wa + b[2] * wb;
    }
    const len = Math.hypot(x, y, z) || 1;
    /* sin gives zero lift at both ends so the arc meets the surface cleanly. */
    const r = 1 + height * Math.sin(t * Math.PI);
    pts[i * 3] = (x / len) * r;
    pts[i * 3 + 1] = (y / len) * r;
    pts[i * 3 + 2] = (z / len) * r;
  }
  return pts;
}

/**
 * Rank country records against a search query, best first.
 *
 * Ranked rather than filtered: a plain substring scan returned "British Indian
 * Ocean Territory" above "India" for the query "india", purely because it sits
 * earlier in the file. Exact code or name wins, then a prefix, then a substring
 * of the common name, then the official long form. Shorter names break ties,
 * which is nearly always the one being reached for.
 *
 * The unrecognised territories carry null where a string is expected, so every
 * field goes through `lower`. One raw .toLowerCase() on this data used to throw
 * and empty the whole result list.
 */
export function rankCountries(countries, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

  const scored = [];
  for (let i = 1; i < countries.length; i++) {
    const c = countries[i];
    if (!c) continue;
    const name = lower(c.name);
    let rank = Infinity;
    if (name === q || lower(c.cca3) === q || lower(c.cca2) === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (lower(c.official).includes(q)) rank = 3;
    if (rank !== Infinity) scored.push({ index: i, rank, len: name.length });
  }

  scored.sort((a, b) => a.rank - b.rank || a.len - b.len);
  return scored.slice(0, limit).map((s) => s.index);
}
