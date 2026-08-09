/* Flattens the site into one self-contained HTML file for publishing as an
   Artifact, where a strict CSP blocks every external request and there is no
   server to serve ./data or ./fonts from.
 *
 * Three things have to be folded in:
 *
 * 1. The ES modules, which cannot resolve "./globe/geo.js" with no server. They
 *    are wrapped in a tiny registry instead of concatenated, because two modules
 *    are free to name a local helper the same thing and concatenation would let
 *    one quietly win. The rewrite is safe only because every import in this
 *    codebase is a plain named import and every export is `export const`,
 *    `export function` or `export class`; the script asserts that rather than
 *    trusting it.
 * 2. The four data payloads, inlined as base64 behind a fetch shim, so app.js
 *    keeps fetching exactly the paths it fetches in production.
 * 3. The fonts, as data URIs inside the @font-face rules.
 *
 * Run: node build/make-artifact.mjs [outfile]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "artifact.html"));

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const IMPORT = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?$/gm;
const EXPORT = /^export\s+(const|let|function|async function|class)\s+([A-Za-z0-9_$]+)/gm;

/* --------------------------------------------------------------- modules -- */

const modules = new Map();

function collect(spec) {
  if (modules.has(spec)) return;
  let src = read(spec);
  const dir = dirname(spec);
  const deps = [];

  src = src.replace(IMPORT, (_, names, from) => {
    if (!from.startsWith(".")) throw new Error(`${spec}: bare import ${from}`);
    const target = relative(ROOT, resolve(ROOT, dir, from)).replaceAll("\\", "/");
    deps.push(target);
    return `const {${names.replace(/\s+/g, " ")}} = __req(${JSON.stringify(target)});`;
  });

  /* Anything still starting with `export` is a form the rewrite below does not
     handle (default, re-export, `export {}` list). Fail loudly instead of
     emitting a bundle that is missing a binding. */
  const names = [...src.matchAll(EXPORT)].map((m) => m[2]);
  src = src.replace(EXPORT, "$1 $2");
  const leftover = src.match(/^export\b.*/m);
  if (leftover) throw new Error(`${spec}: unsupported export form: ${leftover[0]}`);

  modules.set(spec, { src, names });
  for (const dep of deps) collect(dep);
}

collect("app.js");

const registry = [...modules]
  .map(
    ([spec, m]) => `__def(${JSON.stringify(spec)}, () => {
${m.src}
return { ${m.names.join(", ")} };
});`,
  )
  .join("\n");

/* ---------------------------------------------------------------- assets -- */

const DATA = ["data/borders.bin", "data/idmap.bin", "data/countries.json", "data/network.json"];
const assets = Object.fromEntries(
  DATA.map((p) => [`./${p}`, readFileSync(join(ROOT, p)).toString("base64")]),
);

/* @font-face urls point at files that will not exist, so each one becomes the
   font itself. */
let fontCss = read("fonts/fonts.css");
fontCss = fontCss.replace(/url\("\.\/([^"]+)"\)/g, (_, file) => {
  const b64 = readFileSync(join(ROOT, "fonts", file)).toString("base64");
  return `url("data:font/woff2;base64,${b64}")`;
});

const css = read("styles.css").replace(/@import\s+(?:url\()?"\.\/fonts\/fonts\.css"\)?;?/, fontCss);

/* The chrome, lifted straight out of index.html so there is one definition of
   the markup and this script cannot drift from the page it mirrors. */
const html = read("index.html");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));

/* ------------------------------------------------------------------ emit -- */

const page = `<title>Meridian, an interactive model of the Earth</title>
<meta name="color-scheme" content="dark" />
<style>
${css}
</style>
${body}
<script>
(() => {
  const factories = new Map();
  const cache = new Map();
  const __def = (name, fn) => factories.set(name, fn);
  const __req = (name) => {
    if (!cache.has(name)) {
      const fn = factories.get(name);
      if (!fn) throw new Error("no module " + name);
      cache.set(name, fn());
    }
    return cache.get(name);
  };

  /* The payloads app.js fetches, carried inline. Everything else falls through
     to the real fetch, which the artifact CSP will refuse anyway. */
  const ASSETS = ${JSON.stringify(assets)};
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const key = typeof input === "string" ? input : input && input.url;
    const b64 = ASSETS[key];
    if (b64 == null) return realFetch(input, init);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return Promise.resolve(new Response(bytes, {
      status: 200,
      headers: { "content-type": key.endsWith(".json") ? "application/json" : "application/octet-stream" },
    }));
  };

  /* There is no ./sw.js to register here, and letting the attempt run would put
     a CSP warning in the console of an otherwise clean page. Swapping the whole
     object rather than hiding it, because app.js tests "serviceWorker" in
     navigator, and that stays true for an own property set to undefined. */
  if (navigator.serviceWorker) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve(), getRegistrations: () => Promise.resolve([]) },
    });
  }

${registry}

  __req("app.js");
})();
</script>
`;

writeFileSync(OUT, page);
console.log(
  `${relative(process.cwd(), OUT)}: ${(page.length / 1024).toFixed(0)} KB, ` +
    `${modules.size} modules, ${DATA.length} payloads inlined`,
);
