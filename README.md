# Meridian

An interactive 3D Earth. Every country is drawn from real Natural Earth vector
borders, every land dot is sampled from a real land mask, and the whole thing
runs on WebGPU with a WebGL2 fallback and a still 2D poster below that.

Live: <https://region-earth.vercel.app>

## What it does

- Turn the globe by dragging, zoom with the wheel or a pinch, reset with `R` or
  a double click. It drifts on its own after four seconds idle, and not at all
  under `prefers-reduced-motion`.
- Hover or click any country. The readout names it, gives its official long
  form, ISO codes, capital, region, area and land neighbours, and lights that
  country's dots and border on the sphere.
- Search any of 241 countries and territories by name, ISO alpha-2 or alpha-3,
  or official long form. The camera slerps to it.
- Toggle borders, the 15 degree graticule, and a network overlay of 40 real
  cities with great-circle arcs between them. Arc labels quote the physical
  floor for light in fibre, which is a distance calculation and is labelled as
  such, not a measured latency.
- Drag the density slider to resample the dot field live, from about 14,000 to
  about 140,000 dots.

## Running it

There is no build step and no dependency at runtime. Serve the directory:

```sh
python3 -m http.server 8000    # or any static server
```

Then open <http://localhost:8000>. Append `?backend=webgl2` to force the
fallback renderer on a machine that has WebGPU.

Tests:

```sh
node --test test/geo.test.js
```

## How it is put together

```
index.html          chrome, readout, control strip
styles.css          :root tokens, the single source of truth for colour and scale
app.js              state, input, search, layer toggles, the frame loop
globe/
  backend.js        capability probe, WebGPU -> WebGL2 -> poster
  webgpu.js         WGSL pipelines
  webgl2.js         GLSL pipelines, the same image
  camera.js         orbit with inertia, projection, ray unprojection
  geo.js            payload decode, ray-sphere pick, lat/lon <-> xyz, great circles
  layers.js         dot field, border, graticule and arc geometry
  params.js         every constant both backends share
  poster.js         2D canvas fallback
data/               generated and committed: borders.bin, idmap.bin, countries.json, network.json
build/make-geo.mjs  topojson -> the three geography payloads
build/make-fonts.mjs @fontsource woff2 -> fonts/ plus the @font-face rules
```

### Two backends, one set of numbers

`params.js` holds everything the two renderers share, including the sixteen
constants that appear inside shader source. Both backends interpolate those into
their GLSL and WGSL at compile time. A number typed into two shader strings is a
number that will eventually be tuned in one of them and not the other, so there
is exactly one definition of each and no way for the fresnel or the limb falloff
to drift between APIs.

The uniform block uses one vec4-aligned layout that satisfies both GLSL `std140`
and WGSL, so a single `Float32Array` feeds either path with no second packing
rule to keep in step.

Colours are not in the JavaScript at all. `readPalette()` reads the tokens out of
`styles.css` at boot, so the stylesheet stays the only place a colour is written.

### Where the geography comes from

`build/make-geo.mjs` reads `world-atlas@2.0.2` `countries-50m.json` and writes
three payloads, all committed so Vercel runs nothing:

- **`borders.bin`** (188 KB). TopoJSON arcs deduplicated, so a border shared by
  two countries is stored once and both reference it. Long segments are
  subdivided so lines hug the sphere instead of chording through it. Coordinates
  are delta encoded and packed as zigzag LEB128 varints.
- **`idmap.bin`** (57 KB). Every land ring scanline-filled into a 1440x720 grid
  of country indices, run-length encoded. This is what makes hover resolution
  O(1) and what stamps each generated dot with its country, and it is why the
  dots are real geography rather than a scatter. Antarctica gets a synthesized
  polar cap, because its ring closes along the antimeridian rather than around
  the pole.
- **`countries.json`** (68 KB). Facts joined from `world-countries@5.1.0`. Four
  Natural Earth territories have no ISO record (Somaliland, Northern Cyprus,
  Indian Ocean Territories, Siachen Glacier); they carry `null` facts and the
  interface says so rather than printing a blank.

The npm tarballs those scripts read are gitignored. Re-fetch them before
re-running the generators.

### Framing

The dot field is sampled on latitude rings whose counts scale with the cosine of
the latitude, so density is even across the surface rather than piling up at the
poles.

The camera's field of view is vertical, so on a portrait viewport the horizontal
field is the narrow one and a sphere sized to the height runs off both sides.
`fitFov()` opens the vertical angle below square by exactly enough to hold the
horizontal field at its square-viewport value.

The projection is also lifted by `measureFrame()`, which finds the band of canvas
the interface is not sitting on top of and aims the globe at its centre. Only
chrome crossing the vertical centre line counts, which is what lets one rule
serve both layouts: on a wide screen the readout sits in the left margin and
hides nothing, while the same panel on a phone spans the full width and takes the
bottom third. Nothing reads a breakpoint, so the widths in between work too.

Shifting the frustum rather than the camera keeps the globe a sphere, and because
it lives in the matrix the inverse used by the ray picker follows it for free.

### Picking

Both backends resolve hover and click on the CPU with a ray-sphere test. The
globe never moves and its radius is exactly 1, so the intersection is four lines
of algebra that answer on the same frame as the pointer event. A GPU id readback
would be asynchronous and would differ between the two APIs.

## Deploying

Static, no build. Vercel serves the committed files and runs nothing, so a deploy
costs no build minutes. `vercel.json` carries a hardened CSP with no `unsafe-inline`
anywhere, plus immutable cache headers on the fonts and stale-while-revalidate on
the data.

## Licence and attribution

Boundaries from [Natural Earth](https://www.naturalearthdata.com) via
[world-atlas](https://github.com/topojson/world-atlas), public domain. Country
facts from [world-countries](https://github.com/mledoze/countries), ODbL. Type is
Archivo, Public Sans and IBM Plex Mono, all OFL, self-hosted.
