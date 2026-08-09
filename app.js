/* Wiring. Loads the geography, picks a renderer, and turns pointer events into
   camera moves and country lookups.

   Two things worth knowing before reading further:

   1. Picking is a CPU ray-sphere test in both backends, not a GPU id readback.
      The globe never moves and its radius is exactly 1, so the intersection is
      four lines of algebra that answer synchronously, on the same frame as the
      pointer event. A readback path would be asynchronous, would differ between
      the two APIs, and would buy nothing.
   2. Nothing here holds a colour. Every value comes from readPalette(), which
      reads the tokens out of styles.css. */

import { createBackend, requestedBackend } from "./globe/backend.js";
import { drawPoster } from "./globe/poster.js";
import {
  arcPoints,
  countryAt,
  decodeBorders,
  decodeIdMap,
  greatCircleKm,
  latLonToVec3,
  rankCountries,
} from "./globe/geo.js";
import {
  buildBorders,
  buildCountryOutline,
  buildDotField,
  buildGraticule,
  buildSphere,
} from "./globe/layers.js";
import { Orbit } from "./globe/camera.js";
import { CAMERA, FIELD, LOOK, U, readPalette } from "./globe/params.js";
import { RELEASED, VERSION } from "./version.js";

/* Light in fibre travels at roughly two thirds of c. This is the physical floor
   on a one-way hop, not a measurement of anything, and the interface says so. */
const FIBRE_KM_PER_MS = 299792.458 * (2 / 3) / 1000;

const el = (id) => document.getElementById(id);
const dom = {
  stage: el("stage"),
  chrome: el("chrome"),
  boot: el("boot"),
  bootBar: el("boot-bar"),
  bootNote: el("boot-note"),
  eyebrow: el("eyebrow"),
  place: el("place"),
  official: el("official"),
  coords: el("coords"),
  lat: el("lat"),
  lon: el("lon"),
  facts: el("facts"),
  neighbours: el("neighbours"),
  readout: el("readout"),
  search: el("search"),
  results: el("results"),
  density: el("density"),
  reset: el("reset"),
  api: el("api"),
  fps: el("fps"),
  notice: el("notice"),
  statDots: el("stat-dots"),
  statCountries: el("stat-countries"),
  statRoutes: el("stat-routes"),
  version: el("version"),
};

dom.version.textContent = `v${VERSION}`;
dom.version.title = `Released ${RELEASED}`;

const state = {
  countries: [],
  byCca3: new Map(),
  idmap: null,
  arcs: null,
  countryArcs: null,
  network: null,
  palette: null,
  hover: 0,
  selected: 0,
  spacing: FIELD.spacing,
  layers: { borders: true, graticule: true, network: false },
  routeCount: 0,
};

const orbit = new Orbit();
const uniforms = new Float32Array(U.FLOATS);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let renderer = null;
let canvas = null;

/* ---------------------------------------------------------------- boot ---- */

function progress(fraction, note) {
  dom.bootBar.style.setProperty("--progress", String(fraction));
  if (note) dom.bootNote.textContent = note;
}

async function load(path, kind) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return kind === "json" ? res.json() : res.arrayBuffer();
}

async function boot() {
  progress(0.1, "Loading geography");
  const [bordersBuf, idmapBuf, countries, network] = await Promise.all([
    load("./data/borders.bin"),
    load("./data/idmap.bin"),
    load("./data/countries.json", "json"),
    load("./data/network.json", "json"),
  ]);

  progress(0.4, "Decoding borders");
  const borders = decodeBorders(bordersBuf);
  state.arcs = borders.arcs;
  state.countryArcs = borders.countryArcs;
  state.idmap = decodeIdMap(idmapBuf);
  state.countries = countries;
  state.network = network;
  countries.forEach((c, i) => {
    /* The unrecognised territories have no code, and a null key in here would
       be a lookup waiting to match the wrong thing. */
    if (c?.cca3) state.byCca3.set(c.cca3, i);
  });

  progress(0.6, "Starting the renderer");
  state.palette = readPalette();
  const found = await createBackend(dom.stage, {
    prefer: requestedBackend(),
    onLost: (reason) => {
      dom.notice.hidden = false;
      dom.notice.textContent = `The GPU dropped this page (${reason}). Reload to bring the Earth back.`;
    },
  });

  if (!found) {
    showPoster();
    return;
  }
  renderer = found.renderer;
  canvas = found.canvas;
  dom.api.textContent = renderer.api;
  dom.api.dataset.api = renderer.api;

  progress(0.8, "Building the dot field");
  renderer.setGeometry({
    sphere: buildSphere(),
    dots: buildDotField(state.idmap, state.spacing),
    borders: buildBorders(state.arcs),
    graticule: buildGraticule(),
  });
  renderer.setHighlight({ data: new Float32Array(0), count: 0 });
  renderer.setArcs({ data: new Float32Array(0), count: 0, ranges: [] });

  dom.statDots.textContent = renderer.counts.dots.toLocaleString();
  dom.statCountries.textContent = countries.filter(Boolean).length.toLocaleString();

  attachInput();
  attachControls();
  resize();
  /* Watching the element, not the window. The canvas is laid out by the chrome
     grid, so revealing the interface at the end of boot changed its height
     without ever firing a window resize: the backing store stayed at the boot
     size and CSS stretched it, which drew the globe as an ellipse on any
     portrait viewport. A ResizeObserver sees the box itself change.

     The chrome is watched too, for measureFrame rather than for the backing
     store: revealing the interface, or a panel growing as a long country name
     wraps it, changes what covers the globe without touching the canvas. */
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  observer.observe(dom.chrome);
  /* Dragging a window between a Retina and an external display changes dpr with
     no size change at all, so that one still needs the window. */
  window.addEventListener("resize", resize);

  progress(1, "Ready");
  dom.chrome.hidden = false;
  dom.boot.classList.add("done");
  setTimeout(() => {
    dom.boot.hidden = true;
  }, 600);

  requestAnimationFrame(loop);
  expose();
}

function showPoster() {
  const poster = document.createElement("canvas");
  poster.className = "poster-canvas";
  poster.setAttribute("aria-hidden", "true");
  dom.stage.appendChild(poster);
  drawPoster(poster, state.idmap, state.palette, {
    lat: CAMERA.startLat,
    lon: CAMERA.startLon,
  });
  window.addEventListener("resize", () =>
    drawPoster(poster, state.idmap, state.palette, {
      lat: CAMERA.startLat,
      lon: CAMERA.startLon,
    }),
  );

  dom.chrome.hidden = false;
  dom.boot.hidden = true;
  dom.api.textContent = "2d";
  dom.statDots.textContent = "still";
  dom.statCountries.textContent = state.countries.filter(Boolean).length.toLocaleString();
  dom.notice.hidden = false;
  dom.notice.textContent =
    "This browser exposes neither WebGPU nor WebGL2, so the Earth is drawn flat and still.";
  dom.density.disabled = true;
  dom.reset.disabled = true;
  for (const button of document.querySelectorAll(".toggle[data-layer]")) {
    button.disabled = true;
  }
}

/* ------------------------------------------------------------- viewport ---- */

/* NDC units the projection is lifted by, so the globe centres in the part of
   the frame nothing is sitting on top of. Recomputed from layout, never guessed
   from a breakpoint, because the panels wrap at whatever width their content
   needs rather than at a number written here. */
let frameBias = 0;

/**
 * Find the band of canvas the interface leaves clear and aim the globe at it.
 *
 * Only chrome crossing the vertical centre line counts, which is what lets one
 * rule serve both layouts: on a wide screen the readout sits in the left margin
 * beside the globe and hides none of it, while the same panel on a phone spans
 * the full width and takes the bottom third. Nothing here reads a breakpoint,
 * so the widths in between are handled as well as the two ends.
 */
function measureFrame() {
  const h = canvas.clientHeight;
  if (!h || dom.chrome.hidden) {
    frameBias = 0;
    return;
  }
  const midX = canvas.clientWidth / 2;
  let above = 0;
  let below = 0;
  for (const panel of dom.chrome.children) {
    if (panel.hidden) continue;
    const r = panel.getBoundingClientRect();
    if (!r.height || r.left >= midX || r.right <= midX) continue;
    /* Which half a panel belongs to is decided by its own middle, not by its
       edges, so a tall panel is not counted at both ends at once. */
    if (r.top + r.height / 2 < h / 2) above = Math.max(above, r.bottom);
    else below = Math.max(below, h - r.top);
  }
  /* Centring the clear band means moving by half the difference between the two
     obstructions, and an NDC unit is half the canvas, so the halves cancel. */
  const bias = (below - above) / h;
  frameBias = Math.max(-0.4, Math.min(0.4, bias));
}

function resize() {
  if (!renderer || !canvas) return;
  measureFrame();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (!width || !height) return;
  /* Assigning width or height clears the drawing buffer and, on WebGPU, forces
     the swap chain to be reconfigured, so a no-op resize is not free. The
     observer fires on every layout pass, most of which change nothing. */
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  renderer.resize(width, height);
}

/* ---------------------------------------------------------------- input ---- */

const pointers = new Map();
let pinchStart = 0;
let dragMoved = 0;

function ndcFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    1 - ((event.clientY - rect.top) / rect.height) * 2,
  ];
}

function pinchDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function attachInput() {
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) pinchStart = pinchDistance();
    orbit.dragging = true;
    orbit.flight = null;
    orbit.velLat = 0;
    orbit.velLon = 0;
    dragMoved = 0;
    dom.stage.dataset.dragging = "true";
  });

  canvas.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    const now = performance.now();

    if (!previous) {
      hoverAt(event);
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragMoved += Math.abs(dx) + Math.abs(dy);

    if (pointers.size === 2) {
      const spread = pinchDistance();
      if (pinchStart > 0) orbit.zoom(pinchStart / spread, now);
      pinchStart = spread;
      return;
    }
    orbit.drag(dx, dy, now);
  });

  const release = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (pointers.size === 0) {
      orbit.dragging = false;
      dom.stage.dataset.dragging = "false";
      /* Under a few pixels of travel this was a click, not a drag. */
      if (dragMoved < 6) selectAt(event);
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", (event) => {
    if (!pointers.has(event.pointerId)) setHover(0, null);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      orbit.zoom(Math.exp(event.deltaY * 0.0012), performance.now());
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", () => orbit.reset(performance.now()));

  window.addEventListener("keydown", (event) => {
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement;
    if (event.key === "/" && !typing) {
      event.preventDefault();
      dom.search.focus();
      return;
    }
    if (typing) {
      if (event.key === "Escape") dom.search.blur();
      return;
    }
    const now = performance.now();
    const step = 6;
    switch (event.key) {
      case "ArrowLeft":
        orbit.nudge(-step, 0, now);
        break;
      case "ArrowRight":
        orbit.nudge(step, 0, now);
        break;
      case "ArrowUp":
        orbit.nudge(0, step, now);
        break;
      case "ArrowDown":
        orbit.nudge(0, -step, now);
        break;
      case "+":
      case "=":
        orbit.zoom(0.85, now);
        break;
      case "-":
        orbit.zoom(1.18, now);
        break;
      case "r":
      case "R":
        orbit.reset(now);
        break;
      case "Escape":
        select(0);
        break;
      default:
        return;
    }
    event.preventDefault();
  });
}

function hoverAt(event) {
  const [x, y] = ndcFromEvent(event);
  const hit = orbit.pick(x, y);
  if (!hit) {
    setHover(0, null);
    return;
  }
  setHover(countryAt(state.idmap, hit.lat, hit.lon), hit);
}

function selectAt(event) {
  const [x, y] = ndcFromEvent(event);
  const hit = orbit.pick(x, y);
  select(hit ? countryAt(state.idmap, hit.lat, hit.lon) : 0);
}

/* ------------------------------------------------------------ selection ---- */

function setHover(id, hit) {
  if (hit) {
    /* Only a real ray hit produces a coordinate. Until one lands the row stays
       hidden rather than showing a line of dashes, which reads as a readout
       that has broken rather than one that has nothing to say yet. */
    dom.coords.hidden = false;
    dom.lat.textContent = formatLat(hit.lat);
    dom.lon.textContent = formatLon(hit.lon);
  }
  if (id === state.hover) return;
  state.hover = id;
  if (!state.selected) render();
  refreshOutline();
}

function select(id) {
  state.selected = id;
  refreshOutline();
  render();
  if (id) {
    const country = state.countries[id];
    if (country?.latlng) {
      orbit.flyTo(country.latlng[0], country.latlng[1], undefined, performance.now());
    }
  }
}

function refreshOutline() {
  if (!renderer) return;
  const id = state.selected || state.hover;
  if (!id || !state.countryArcs[id - 1]) {
    renderer.setHighlight({ data: new Float32Array(0), count: 0 });
    return;
  }
  renderer.setHighlight(buildCountryOutline(state.arcs, state.countryArcs[id - 1]));
}

const formatLat = (lat) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}`;
const formatLon = (lon) =>
  `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;

function fact(term, value, numeric = false) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (numeric) dd.className = "num";
  return [dt, dd];
}

function render() {
  const id = state.selected || state.hover;
  const country = id ? state.countries[id] : null;
  dom.facts.replaceChildren();
  dom.neighbours.replaceChildren();
  /* The panel serves two states and the label has to say which, or it claims
     something is under a cursor that has not moved since the search box flew
     the camera somewhere else. */
  dom.eyebrow.textContent = state.selected ? "Pinned" : "Under the cursor";

  if (!country) {
    dom.readout.dataset.empty = "true";
    dom.place.textContent = "Open ocean";
    dom.official.textContent = state.selected
      ? "Nothing pinned."
      : "Drag to turn the globe. Click to pin a country.";
    return;
  }

  dom.readout.dataset.empty = "false";
  dom.place.textContent = country.name;
  /* Natural Earth draws four places ISO does not recognise (Somaliland, N.
     Cyprus, Siachen Glacier, Indian Ocean Ter.), so they have no facts to join
     to. Saying that is better than printing a row of nulls, and every field
     below is guarded because those records carry null, not absent, keys. */
  dom.official.textContent =
    country.official ?? "Mapped by Natural Earth, not assigned an ISO code.";

  const rows = [];
  if (country.capital) rows.push(fact("Capital", country.capital));
  if (country.region) {
    rows.push(fact("Region", `${country.region}, ${country.subregion || "island"}`));
  }
  if (country.area) rows.push(fact("Area", `${country.area.toLocaleString()} km2`, true));
  if (country.languages?.length) {
    rows.push(fact("Language", country.languages.slice(0, 3).join(", ")));
  }
  if (country.currency) rows.push(fact("Currency", country.currency));
  if (country.cca3) rows.push(fact("Coast", country.landlocked ? "Landlocked" : "Coastal"));

  if (state.layers.network && country.latlng) {
    const near = nearestSite(country.latlng[0], country.latlng[1]);
    if (near) {
      rows.push(fact("Nearest node", `${near.site.city} ${near.site.id}`));
      rows.push(
        fact(
          "Fibre floor",
          `${near.km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km, ` +
            `${(near.km / FIBRE_KM_PER_MS).toFixed(1)} ms one way, theoretical`,
          true,
        ),
      );
    }
  }
  dom.facts.append(...rows.flat());

  for (const code of country.borders ?? []) {
    const index = state.byCca3.get(code);
    if (!index) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = code;
    button.title = `Fly to ${state.countries[index].name}`;
    button.addEventListener("click", () => select(index));
    dom.neighbours.appendChild(button);
  }
}

function nearestSite(lat, lon) {
  let best = null;
  for (const site of state.network.sites) {
    const km = greatCircleKm(lat, lon, site.lat, site.lon);
    if (!best || km < best.km) best = { site, km };
  }
  return best;
}

/* ------------------------------------------------------------- controls ---- */

let densityPending = false;

function attachControls() {
  for (const button of document.querySelectorAll(".toggle[data-layer]")) {
    button.addEventListener("click", () => {
      const layer = button.dataset.layer;
      const on = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(on));
      state.layers[layer] = on;
      if (layer === "network") {
        applyNetwork();
        render();
      }
    });
  }

  dom.density.addEventListener("input", () => {
    /* The slider reads sparse to dense while spacing runs the other way, so the
       mapping is inverted here rather than in the field builder. */
    const t = Number(dom.density.value) / 100;
    state.spacing = FIELD.spacingMax + (FIELD.spacingMin - FIELD.spacingMax) * t;
    if (densityPending) return;
    densityPending = true;
    requestAnimationFrame(() => {
      densityPending = false;
      renderer.setDots(buildDotField(state.idmap, state.spacing));
      dom.statDots.textContent = renderer.counts.dots.toLocaleString();
    });
  });

  dom.reset.addEventListener("click", () => {
    orbit.reset(performance.now());
    select(0);
  });

  dom.search.addEventListener("input", () => searchResults(dom.search.value));
  dom.search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = dom.results.querySelector("button");
    if (first) first.click();
  });
  dom.search.addEventListener("blur", () => {
    /* Let a click on a result land before the list disappears. */
    setTimeout(() => searchResults(""), 150);
  });

  /* FIELD.spacing is the one definition of the starting density, so the slider
     is positioned from it rather than carrying a default of its own in the
     markup. Dispatching input then builds the field through the same path a
     drag would, which keeps the control and the dots in step on frame one. */
  const span = FIELD.spacingMax - FIELD.spacingMin;
  dom.density.value = String(Math.round(((FIELD.spacingMax - FIELD.spacing) / span) * 100));
  dom.density.dispatchEvent(new Event("input"));
}

function applyNetwork() {
  if (!state.layers.network) {
    renderer.setArcs({ data: new Float32Array(0), count: 0, ranges: [] });
    state.routeCount = 0;
    dom.statRoutes.textContent = "0";
    return;
  }

  const sites = new Map(state.network.sites.map((s) => [s.id, s]));
  const segments = 48;
  const routes = state.network.routes.filter(
    ([a, b]) => sites.has(a) && sites.has(b),
  );
  const perRoute = segments + 1;
  const data = new Float32Array(routes.length * perRoute * 4);
  const ranges = [];
  let at = 0;

  routes.forEach((route, index) => {
    const a = sites.get(route[0]);
    const b = sites.get(route[1]);
    const pts = arcPoints(a.lat, a.lon, b.lat, b.lon, segments);
    for (let i = 0; i <= segments; i++) {
      data[at++] = pts[i * 3];
      data[at++] = pts[i * 3 + 1];
      data[at++] = pts[i * 3 + 2];
      /* Offsetting each route's phase keeps the pulses from marching in lockstep,
         which would read as one animation rather than many. */
      data[at++] = i / segments + index * 0.137;
    }
    ranges.push({ offset: index * perRoute, count: perRoute });
  });

  renderer.setArcs({ data, count: routes.length * perRoute, ranges });
  state.routeCount = routes.length;
  dom.statRoutes.textContent = String(routes.length);
}

function searchResults(query) {
  const q = query.trim().toLowerCase();
  dom.results.replaceChildren();
  dom.search.setAttribute("aria-expanded", q ? "true" : "false");

  const matches = rankCountries(state.countries, q);
  for (const index of matches) {
    const country = state.countries[index];
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const button = document.createElement("button");
    button.type = "button";
    const name = document.createElement("span");
    name.textContent = country.name;
    const code = document.createElement("span");
    code.textContent = country.cca3 ?? "no ISO";
    button.append(name, code);
    button.addEventListener("click", () => {
      select(index);
      dom.search.value = country.name;
      searchResults("");
    });
    li.appendChild(button);
    dom.results.appendChild(li);
  }
}

/* ------------------------------------------------------------- the loop ---- */

let last = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = last ? Math.min(64, now - last) : 16.7;
  last = now;

  const width = canvas.width || 1;
  const height = canvas.height || 1;
  const viewProj = orbit.update(now, dt, width / height, reducedMotion, frameBias);
  uniforms.set(viewProj, U.viewProj);
  uniforms.set(orbit.eye, U.eye);

  /* Pixel size is constant in the shader, so without this the field would look
     sparser the closer the camera gets. The square root keeps the growth gentle
     enough that dots never merge into a sheet. */
  const zoom = Math.sqrt(CAMERA.startDistance / orbit.distance);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  uniforms[U.params] = reducedMotion ? 0.5 : (now / 1000) * LOOK.arcSpeed;
  uniforms[U.params + 1] = Math.min(LOOK.dotSizeMax, LOOK.dotSize * zoom);
  uniforms[U.params + 2] = state.hover || state.selected;
  uniforms[U.params + 3] = state.selected;

  setVec(U.ember, state.palette.ember);
  setVec(U.emberDeep, state.palette.emberDeep);
  setVec(U.emberBright, state.palette.emberBright);
  setVec(U.signal, state.palette.signal);
  setVec(U.hairline, state.palette.hairline);
  setVec(U.ocean, state.palette.inkRaised);

  uniforms[U.opacity] = 1;
  uniforms[U.opacity + 1] = state.layers.borders ? 1 : 0;
  uniforms[U.opacity + 2] = state.layers.graticule ? 1 : 0;
  uniforms[U.opacity + 3] = state.layers.network ? 1 : 0;

  uniforms[U.misc] = LOOK.limbFade;
  uniforms[U.misc + 1] = LOOK.rimPower;
  uniforms[U.misc + 2] = LOOK.rimGain;
  uniforms[U.misc + 3] = dpr;

  uniforms[U.viewport] = width;
  uniforms[U.viewport + 1] = height;
  uniforms[U.viewport + 2] = width / height;

  renderer.frame(uniforms, {
    background: state.palette.ink,
    graticule: state.palette.hairline,
    graticuleOpacity: state.layers.graticule ? 0.55 : 0,
    border: state.palette.ember,
    borderOpacity: state.layers.borders ? 0.42 : 0,
    highlight: state.palette.emberBright,
    highlightOpacity: 1,
  });

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 500) {
    dom.fps.textContent = `${Math.round((fpsFrames * 1000) / fpsAccum)} fps`;
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

function setVec(offset, rgb) {
  uniforms[offset] = rgb[0];
  uniforms[offset + 1] = rgb[1];
  uniforms[offset + 2] = rgb[2];
  uniforms[offset + 3] = 1;
}

/* ---------------------------------------------------------------- debug ---- */

function expose() {
  window.__globe = {
    get api() {
      return renderer?.api ?? "none";
    },
    get counts() {
      return {
        ...renderer.counts,
        countries: state.countries.filter(Boolean).length,
        routes: state.routeCount,
      };
    },
    get camera() {
      return { lat: orbit.lat, lon: orbit.lon, distance: orbit.distance };
    },
    lookAt: (lat, lon, distance) => orbit.flyTo(lat, lon, distance, performance.now()),
    select,
    countryAt: (lat, lon) => state.countries[countryAt(state.idmap, lat, lon)] ?? null,
    /* Handy from the console: where a coordinate lands in model space. */
    toVec3: (lat, lon) => latLonToVec3(lat, lon),
  };
}

/* Registered after boot so the first visit spends its bandwidth on the globe
   rather than on filling a cache it will not read until the second visit. */
function registerWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const register = () =>
    navigator.serviceWorker
      .register(`./sw.js?v=${VERSION}`)
      .catch((err) => console.warn("service worker:", err.message));
  /* This runs once boot has resolved, which is after several network round
     trips, so load has almost always fired already. A listener added after its
     event will never run, and the worker silently never registered. */
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

boot().then(registerWorker).catch((err) => {
  console.error(err);
  dom.boot.hidden = true;
  dom.chrome.hidden = false;
  dom.notice.hidden = false;
  dom.notice.textContent = `The Earth failed to load: ${err.message}`;
});
