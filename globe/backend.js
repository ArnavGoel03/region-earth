/* Picks a renderer and owns the canvas element while doing it.

   The canvas is created here rather than passed in because getContext is
   sticky: a canvas that has been handed to WebGPU can never be handed to
   WebGL2. So each rung of the ladder gets a brand new element, and only the
   one that succeeds is attached to the page. */

import { createWebGPURenderer } from "./webgpu.js";
import { createWebGL2Renderer } from "./webgl2.js";

const LADDER = [
  { api: "webgpu", create: createWebGPURenderer },
  { api: "webgl2", create: (canvas) => createWebGL2Renderer(canvas) },
];

function makeCanvas() {
  const canvas = document.createElement("canvas");
  canvas.className = "globe-canvas";
  /* The globe is decorative to a screen reader; the readout rail carries the
     same information as text, and that is what assistive tech should read. */
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}

/**
 * Walk the ladder until something works.
 *
 * @param {HTMLElement} mount element the winning canvas is appended to
 * @param {{prefer?: string, onLost?: (reason: string) => void}} options
 * @returns {Promise<{renderer: object, canvas: HTMLCanvasElement} | null>}
 *   null when no rung succeeded, which is the cue to show the poster.
 */
export async function createBackend(mount, options = {}) {
  const prefer = options.prefer ?? null;
  const rungs = prefer ? LADDER.filter((r) => r.api === prefer) : LADDER;
  const notes = [];

  for (const rung of rungs) {
    const canvas = makeCanvas();
    let renderer = null;
    try {
      renderer = await rung.create(canvas);
    } catch (err) {
      notes.push(`${rung.api}: ${err?.message ?? err}`);
      continue;
    }
    if (!renderer) {
      notes.push(`${rung.api}: unavailable`);
      continue;
    }
    mount.appendChild(canvas);
    if (options.onLost && renderer.onLost) renderer.onLost(options.onLost);
    return { renderer, canvas, notes };
  }

  return null;
}

/** What the URL asks for, if it asks for anything. Used to test both paths. */
export function requestedBackend(search = location.search) {
  const value = new URLSearchParams(search).get("backend");
  return LADDER.some((r) => r.api === value) ? value : null;
}
