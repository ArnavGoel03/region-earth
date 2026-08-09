/* Every tunable the two backends share. Colours are read from the stylesheet at
   boot rather than written here, so styles.css stays the single definition and
   a JS literal can never drift from the token it was copied from. */

export const RADII = {
  ocean: 0.994, /* under the dots, so it occludes the far side without z-fighting */
  dots: 1.0,
  graticule: 1.0015,
  border: 1.0025,
  highlight: 1.004,
  atmosphere: 1.05,
};

export const CAMERA = {
  fov: 32,
  near: 0.01,
  far: 100,
  minDistance: 1.7, /* any closer and the near plane clips the limb */
  maxDistance: 7,
  /* The sphere subtends asin(1 / distance). At 4.6 that is 12.6 degrees against
     a 16 degree half-field, so the globe fills about four fifths of the frame
     height and the limb never runs off the edge. */
  startDistance: 4.6,
  startLat: 18,
  startLon: 8,
  pitchLimit: 84, /* short of 90, where up and forward become parallel */
};

export const FIELD = {
  /* Degrees between dot samples. Lower is denser; the control strip drives it. */
  spacing: 0.64,
  spacingMin: 0.3,
  spacingMax: 1.5,
  /* Border segments longer than this get subdivided so they hug the sphere
     instead of chording through it. */
  maxSegmentDeg: 1.0,
  graticuleStep: 15,
};

export const LOOK = {
  dotSize: 2.0, /* pixels at the reference distance, scaled by depth and dpr */
  dotSizeMax: 4.2,
  rimPower: 3.1,
  rimGain: 0.85,
  /* How far around the limb dots survive. Fading them out before the true
     silhouette is what stops the edge reading as a hard cut-out. */
  limbFade: 0.16,
  arcSpeed: 0.22,
  autoRotate: 0.6, /* degrees per second */
  idleDelay: 4000, /* ms of no input before the globe drifts again */
};

/* Constants that appear inside shader source. Both backends interpolate these
   into their GLSL and WGSL at compile time, which is the only way to keep one
   definition: a number typed into two shader strings is a number that will
   eventually be tuned in one of them and not the other. */
export const SHADER = {
  oceanRim: 0.34, /* how much ember the fresnel adds to the ocean shell */
  keyDir: [0.42, 0.36, 0.83], /* fixed key light, well off axis */
  keyPower: 5.0,
  keyGain: 0.045,
  atmoPower: 4.2, /* tighter than the shell fresnel, so the halo hugs the limb */
  atmoGain: 0.15,
  dotEdge: 0.72, /* where the round dot starts fading to its rim */
  dotCut: 0.002, /* below this the fragment is discarded rather than blended */
  dotShade: 1.4, /* how fast a dot warms from deep to full ember as it faces you */
  hotScale: 0.35, /* extra size on the hovered country's dots */
  hotAlpha: 1.9,
  lineLimb: 1.6, /* lines survive further round the limb than dots do */
  pulseFalloff: 26.0, /* the width of the travelling pulse along an arc */
  pulseWhite: 0.55,
  arcBase: 0.24, /* the resting brightness of an arc between pulses */
  arcGain: 0.9,
};

/**
 * Format a number as a shader float. GLSL and WGSL both reject `1` where a
 * float is wanted, so every interpolated constant goes through here.
 */
export const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/* One uniform block, one memory layout, both backends. Every entry is vec4
   aligned so the same Float32Array satisfies GLSL std140 and WGSL without a
   second packing rule to keep in step. Offsets are in floats. */
export const U = {
  viewProj: 0,
  eye: 16, /* xyz, w unused */
  params: 20, /* time, dotSizePx, hoverId, selectId */
  ember: 24,
  emberDeep: 28,
  emberBright: 32,
  signal: 36,
  hairline: 40,
  ocean: 44,
  opacity: 48, /* dots, borders, graticule, arcs */
  misc: 52, /* limbFade, rimPower, rimGain, dpr */
  viewport: 56, /* width, height, aspect, unused */
  FLOATS: 64, /* 256 bytes, a whole number of uniform-buffer alignment units */
};

/* Per-draw line styling, bound separately so one pipeline draws borders,
   graticule and the hover outline. */
export const STYLE = { color: 0, opts: 4, FLOATS: 8 };

/** Parse a CSS colour token into premultiplied-friendly [r, g, b] floats 0..1. */
function parseColor(value) {
  const hex = value.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 0, 1];
  let body = m[1];
  if (body.length === 3) body = body.replace(/./g, (c) => c + c);
  const n = parseInt(body, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Pull the palette out of :root. Called once at boot and again if the page ever
 * needs to re-read tokens.
 */
export function readPalette(root = document.documentElement) {
  const style = getComputedStyle(root);
  const token = (name) => parseColor(style.getPropertyValue(name));
  return {
    ink: token("--ink"),
    inkRaised: token("--ink-raised"),
    hairline: token("--hairline"),
    ember: token("--ember"),
    emberDeep: token("--ember-deep"),
    emberBright: token("--ember-bright"),
    signal: token("--signal"),
    text: token("--text"),
  };
}
