/* Run: node --test test/
   Exercises the parts that can be wrong silently: the binary decoders, the
   coordinate maths the picker depends on, and the integrity of the committed
   data. Anything that needs a GPU is checked by screenshot instead. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  arcPoints,
  countryAt,
  decodeBorders,
  decodeIdMap,
  greatCircleKm,
  latLonToVec3,
  rankCountries,
  raySphere,
  vec3ToLatLon,
} from "../globe/geo.js";
import { buildDotField, buildSphere } from "../globe/layers.js";
import { fitFov, perspective } from "../globe/camera.js";
import { CAMERA } from "../globe/params.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (name) => {
  const buf = readFileSync(join(root, "data", name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const borders = decodeBorders(bytes("borders.bin"));
const idmap = decodeIdMap(bytes("idmap.bin"));
const countries = JSON.parse(readFileSync(join(root, "data", "countries.json"), "utf8"));
const network = JSON.parse(readFileSync(join(root, "data", "network.json"), "utf8"));

const nameAt = (lat, lon) => countries[countryAt(idmap, lat, lon)]?.name ?? null;

test("borders decode into plausible arcs", () => {
  assert.ok(borders.arcs.length > 1000, "expected the full 50m arc set");
  assert.equal(borders.countryArcs.length, countries.length - 1);
  for (const arc of borders.arcs) {
    assert.ok(arc.length >= 4, "an arc needs at least two points");
    for (let i = 0; i < arc.length; i += 2) {
      assert.ok(arc[i] >= -180.5 && arc[i] <= 180.5, `longitude out of range: ${arc[i]}`);
      assert.ok(arc[i + 1] >= -90.5 && arc[i + 1] <= 90.5, `latitude out of range: ${arc[i + 1]}`);
    }
  }
});

test("every country's arc list points at arcs that exist", () => {
  for (let i = 0; i < borders.countryArcs.length; i++) {
    for (const index of borders.countryArcs[i]) {
      assert.ok(borders.arcs[index], `country ${i + 1} references missing arc ${index}`);
    }
  }
});

test("id map covers the grid exactly", () => {
  assert.equal(idmap.cells.length, idmap.width * idmap.height);
  const land = idmap.cells.reduce((n, id) => n + (id ? 1 : 0), 0);
  const fraction = land / idmap.cells.length;
  /* Land is about 29% of the surface, and an equirectangular grid over-weights
     the poles, which pushes the cell fraction up. Anything outside this band
     means the scanline fill has gone wrong. */
  assert.ok(fraction > 0.25 && fraction < 0.45, `land fraction ${fraction.toFixed(3)}`);
  for (const id of idmap.cells) {
    assert.ok(id < countries.length, `id ${id} has no country record`);
  }
});

test("known coordinates resolve to the right country", () => {
  const cases = [
    [28.61, 77.21, "India"],
    [51.51, -0.13, "United Kingdom"],
    [-23.55, -46.63, "Brazil"],
    [35.68, 139.65, "Japan"],
    [-33.92, 18.42, "South Africa"],
    [64.15, -21.94, "Iceland"],
    [1.35, 103.82, "Singapore"],
    [-89.5, 0, "Antarctica"],
    [64.73, 177.5, "Russia"],
    [-17.75, 178.0, "Fiji"],
    /* The Lau group sits east of the antimeridian, so this one only resolves if
       the wrap in the build's scanline fill is right. */
    [-17.1, -179.1, "Fiji"],
    [51.88, -176.65, "United States"],
  ];
  for (const [lat, lon, expected] of cases) {
    assert.equal(nameAt(lat, lon), expected, `${lat}, ${lon}`);
  }
});

test("open water resolves to nothing", () => {
  const cases = [
    [0, -140, "mid Pacific"],
    [-40, -30, "South Atlantic"],
    [-45, 80, "Southern Indian Ocean"],
    [58, -35, "North Atlantic"],
    [90, 0, "North Pole"],
  ];
  for (const [lat, lon, where] of cases) {
    assert.equal(countryAt(idmap, lat, lon), 0, where);
  }
});

test("longitude wraps rather than clamping", () => {
  /* 190E is 170W. A clamp would answer with whatever sits at the 180 edge. */
  assert.equal(countryAt(idmap, 64.73, 177.5), countryAt(idmap, 64.73, 537.5));
  assert.equal(countryAt(idmap, 51.51, -0.13), countryAt(idmap, 51.51, 359.87));
});

test("lat lon survives a round trip through xyz", () => {
  for (const [lat, lon] of [[0, 0], [45, 90], [-33.87, 151.21], [70, -179.9], [-60, 12]]) {
    const [x, y, z] = latLonToVec3(lat, lon);
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-6, "not on the unit sphere");
    const back = vec3ToLatLon(x, y, z);
    assert.ok(Math.abs(back.lat - lat) < 1e-4, `lat ${back.lat} vs ${lat}`);
    assert.ok(Math.abs(((back.lon - lon + 540) % 360) - 180) < 1e-4, `lon ${back.lon} vs ${lon}`);
  }
});

test("a ray down the z axis hits the near face of the sphere", () => {
  const hit = raySphere([0, 0, 4], [0, 0, -1], 1);
  assert.ok(hit, "expected a hit");
  assert.ok(Math.abs(hit[2] - 1) < 1e-9, `hit at z=${hit[2]}, expected the near side`);
  assert.equal(raySphere([0, 0, 4], [0, 1, 0], 1), null, "a ray pointing away must miss");
  assert.equal(raySphere([0, 3, 4], [0, 0, -1], 1), null, "a ray beside the sphere must miss");
});

test("great-circle distances match published figures", () => {
  /* Within 0.5%: these are the standard spherical-Earth values. */
  const near = (got, want) => Math.abs(got - want) / want < 0.005;
  assert.ok(near(greatCircleKm(51.51, -0.13, 40.71, -74.01), 5570), "London to New York");
  assert.ok(near(greatCircleKm(-33.87, 151.21, 35.68, 139.65), 7823), "Sydney to Tokyo");
  assert.equal(greatCircleKm(12, 34, 12, 34), 0, "a point is zero from itself");
});

test("arc points start and end on the surface and bow outward", () => {
  const pts = arcPoints(51.51, -0.13, -33.87, 151.21, 32);
  const radius = (i) => Math.hypot(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  assert.ok(Math.abs(radius(0) - 1) < 1e-5, "starts on the surface");
  assert.ok(Math.abs(radius(32) - 1) < 1e-5, "ends on the surface");
  assert.ok(radius(16) > 1.02, `midpoint should lift, got ${radius(16)}`);
});

test("the dot field lands only on land", () => {
  const field = buildDotField(idmap, 3.0);
  assert.ok(field.count > 500, `expected a populated field, got ${field.count}`);
  for (let i = 0; i < field.count; i++) {
    const [x, y, z] = [field.data[i * 4], field.data[i * 4 + 1], field.data[i * 4 + 2]];
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-5, "dot off the sphere");
    const id = field.data[i * 4 + 3];
    assert.ok(id >= 1 && id < countries.length, `dot carries bad country id ${id}`);
  }
});

test("dot density responds to spacing", () => {
  const coarse = buildDotField(idmap, 3.0).count;
  const fine = buildDotField(idmap, 1.5).count;
  /* Halving the spacing quarters the cell area, so the count should roughly
     quadruple. A loose band is enough to catch the mapping being inverted. */
  assert.ok(fine > coarse * 3, `${coarse} then ${fine}`);
});

test("the sphere is wound counter-clockwise seen from outside", () => {
  const { positions, indices } = buildSphere(8, 6, 1);
  let checked = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => {
      const at = indices[t + k] * 3;
      return [positions[at], positions[at + 1], positions[at + 2]];
    });
    const u = p[1].map((v, i) => v - p[0][i]);
    const v = p[2].map((c, i) => c - p[0][i]);
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const outward = n[0] * p[0][0] + n[1] * p[0][1] + n[2] * p[0][2];
    /* Degenerate triangles at the poles have a zero-length normal; skip those
       and require every real one to face away from the centre. */
    if (Math.hypot(...n) < 1e-9) continue;
    assert.ok(outward > 0, `triangle ${t / 3} faces inward`);
    checked++;
  }
  assert.ok(checked > 50, "expected most triangles to be non-degenerate");
});

test("every network route joins two known sites", () => {
  const ids = new Set(network.sites.map((s) => s.id));
  assert.equal(ids.size, network.sites.length, "duplicate site id");
  for (const [a, b] of network.routes) {
    assert.ok(ids.has(a), `unknown site ${a}`);
    assert.ok(ids.has(b), `unknown site ${b}`);
    assert.notEqual(a, b, "a route to itself");
  }
  /* A grid cell is about 0.2 degrees, so a coastal city like Miami or Singapore
     legitimately falls in a cell the fill called ocean. What this catches is a
     transposed sign or a digit typo, which puts a site hundreds of kilometres
     out to sea, so the probe covers the neighbourhood rather than one cell. */
  const nearLand = (lat, lon) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (countryAt(idmap, lat + dy * 0.25, lon + dx * 0.25) !== 0) return true;
      }
    }
    return false;
  };
  for (const site of network.sites) {
    assert.ok(Math.abs(site.lat) <= 90 && Math.abs(site.lon) <= 180, site.id);
    assert.ok(nearLand(site.lat, site.lon), `${site.city} landed in open water`);
  }
});

test("country records carry the fields the readout prints", () => {
  assert.equal(countries[0], null, "index zero is reserved for ocean");
  for (let i = 1; i < countries.length; i++) {
    const c = countries[i];
    if (!c) continue;
    assert.equal(typeof c.name, "string", `country ${i} has no name`);
    for (const key of ["official", "cca2", "cca3", "region", "area"]) {
      assert.ok(key in c, `country ${i} is missing ${key}`);
    }
  }
});

test("the territories with no ISO record are exactly the ones we know about", () => {
  /* Natural Earth draws these; world-countries has no entry to join them to, so
     every fact is null. The readout and the search both have to survive that,
     and one unguarded toLowerCase on this set used to empty the result list. If
     this name set changes, the code paths that special-case them need another
     look rather than a quiet update to the expected list. */
  const unlisted = countries
    .map((c, i) => [i, c])
    .filter(([, c]) => c && c.cca3 === null)
    .map(([, c]) => c.name)
    .sort();
  assert.deepEqual(unlisted, [
    "Indian Ocean Ter.",
    "N. Cyprus",
    "Siachen Glacier",
    "Somaliland",
  ]);
  for (const name of unlisted) {
    const c = countries.find((x) => x && x.name === name);
    for (const key of ["official", "cca2", "region", "area", "latlng"]) {
      assert.equal(c[key], null, `${name}.${key} should be null, not undefined`);
    }
  }
});

test("search ranks the country you meant above the one that merely contains it", () => {
  const name = (i) => countries[i].name;
  /* The case that caught this: "india" used to return British Indian Ocean
     Territory first, because it sits earlier in the file than India does. */
  assert.equal(name(rankCountries(countries, "india")[0]), "India");
  assert.equal(name(rankCountries(countries, "IND")[0]), "India");
  assert.equal(name(rankCountries(countries, "in")[0]), "India", "prefix beats substring");
  assert.equal(name(rankCountries(countries, "united kingdom")[0]), "United Kingdom");
  assert.equal(name(rankCountries(countries, "NZ")[0]), "New Zealand", "cca2 is exact");
  assert.equal(name(rankCountries(countries, "republic of india")[0]), "India",
    "the official long form still finds it");

  assert.deepEqual(rankCountries(countries, "z"), [], "one character is too broad to answer");
  assert.deepEqual(rankCountries(countries, "  "), []);
  assert.deepEqual(rankCountries(countries, "zzzznotaplace"), []);
  assert.ok(rankCountries(countries, "land").length <= 8, "the list is capped");

  /* The records with no ISO code must be searchable and must not throw. */
  assert.equal(name(rankCountries(countries, "somaliland")[0]), "Somaliland");
});

test("the globe fits the frame on any viewport shape", () => {
  const RAD = Math.PI / 180;
  /* The sphere has radius 1 and the camera sits at startDistance, so it
     subtends asin(1 / d). Both half-fields have to clear that or the limb runs
     off an edge, which is what portrait viewports used to do. */
  const subtend = Math.asin(1 / CAMERA.startDistance);
  for (const [w, h] of [[1440, 900], [1920, 1080], [1024, 1366], [393, 852], [852, 393], [800, 800]]) {
    const aspect = w / h;
    const halfV = (fitFov(aspect) * RAD) / 2;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    assert.ok(halfV > subtend, `${w}x${h}: vertical ${(halfV / RAD).toFixed(1)} deg is too tight`);
    assert.ok(halfH > subtend, `${w}x${h}: horizontal ${(halfH / RAD).toFixed(1)} deg is too tight`);
  }
  assert.equal(fitFov(1.6), CAMERA.fov, "landscape is left alone");
  assert.equal(fitFov(1), CAMERA.fov, "square is the hinge, and is continuous");
  assert.ok(fitFov(0.5) > CAMERA.fov, "portrait has to open up");
});

test("lifting the frustum moves the globe up without moving the camera", () => {
  const proj = new Float32Array(16);
  const biased = new Float32Array(16);
  perspective(proj, CAMERA.fov, 1, CAMERA.near, CAMERA.far);
  perspective(biased, CAMERA.fov, 1, CAMERA.near, CAMERA.far, 0.28);

  /* The globe sits at the origin, one metre in front of the eye. Where that
     point lands vertically in NDC is exactly what the bias is for. */
  const project = (m, z) => {
    const y = m[5] * 0 + m[9] * z;
    const w = -z;
    return y / w;
  };
  assert.ok(Math.abs(project(proj, -1)) < 1e-9, "unbiased centres on zero");
  assert.ok(
    Math.abs(project(biased, -1) - 0.28) < 1e-6,
    "a positive bias lifts the centre by that many NDC units",
  );

  /* Everything else must be untouched, or the globe would squash as it moved. */
  for (const i of [0, 5, 10, 11, 14]) {
    assert.equal(biased[i], proj[i], `element ${i} should not change`);
  }
});
