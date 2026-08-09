/* The last rung of the ladder. When neither WebGPU nor WebGL2 is available,
   the page still owes the visitor an Earth, so this draws one with the 2D
   canvas API from the same country index map the GPU path samples.

   It is an orthographic projection, which is what a sphere viewed from far
   away actually is, so the result is the same globe without the depth cues:
   same dots, same geography, no rotation. */

import { DEG, countryAt } from "./geo.js";

const SPACING = 1.4; /* degrees; coarser than the GPU field, since each dot here
                        costs a fillRect rather than four vertices */

export function drawPoster(canvas, idmap, palette, center = { lat: 18, lon: 8 }) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.38;

  const rgb = (c, a) =>
    `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)} / ${a})`;

  ctx.fillStyle = rgb(palette.ink, 1);
  ctx.fillRect(0, 0, w, h);

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = rgb(palette.inkRaised, 1);
  ctx.fill();
  ctx.strokeStyle = rgb(palette.emberDeep, 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();

  const lat0 = center.lat * DEG;
  const lon0 = center.lon;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const size = Math.max(1.2, R / 190);

  const rings = Math.round(180 / SPACING);
  for (let r = 0; r < rings; r++) {
    const lat = -90 + ((r + 0.5) * 180) / rings;
    const perRing = Math.max(1, Math.round((360 / SPACING) * Math.cos(lat * DEG)));
    const sinLat = Math.sin(lat * DEG);
    const cosLat = Math.cos(lat * DEG);
    for (let i = 0; i < perRing; i++) {
      const lon = -180 + ((i + 0.5) * 360) / perRing;
      if (countryAt(idmap, lat, lon) === 0) continue;

      const dLon = (lon - lon0) * DEG;
      const cosC = sinLat0 * sinLat + cosLat0 * cosLat * Math.cos(dLon);
      if (cosC <= 0.02) continue; /* on the far side, or exactly on the limb */

      const x = cx + R * cosLat * Math.sin(dLon);
      const y = cy - R * (cosLat0 * sinLat - sinLat0 * cosLat * Math.cos(dLon));
      /* Fade toward the limb the same way the shader does, so the silhouette
         reads as curvature rather than as a cut-out. */
      const shade = 0.35 + 0.65 * cosC;
      ctx.fillStyle = rgb(palette.ember, shade.toFixed(2));
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }
  return true;
}
