import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  // The Extension Host evaluates the bundle in a VM context without `global`.
  define: { global: "globalThis", __EXT_VERSION__: JSON.stringify(manifest.version) },
  // That VM context also lacks web globals (Request, Response, ReadableStream,
  // fetch, EventTarget, ...) that the MCP SDK needs at load time. Core modules
  // are shared with the main Node context, so a core-module function's Function
  // constructor evaluates in the main context and hands us its globalThis.
  banner: {
    js: `(() => {
  const names = [
    "fetch","Request","Response","Headers","FormData","Blob","File",
    "ReadableStream","WritableStream","TransformStream","ByteLengthQueuingStrategy","CountQueuingStrategy",
    "TextEncoder","TextDecoder","TextEncoderStream","TextDecoderStream","CompressionStream","DecompressionStream",
    "URL","URLSearchParams","AbortController","AbortSignal",
    "Event","EventTarget","CustomEvent","MessageEvent","MessageChannel","MessagePort",
    "DOMException","structuredClone","crypto","performance","queueMicrotask","setImmediate","clearImmediate",
    "atob","btoa",
  ];
  try {
    // Evaluate inside the main context (a core-module function's Function
    // constructor) so Node's lazy global getters run where they are safe.
    const src = "return {" + names.map((n) => n + ": typeof " + n + " === 'undefined' ? undefined : " + n).join(",") + "};";
    const picked = require("node:fs").readFileSync.constructor(src)();
    for (const k of names) {
      if (globalThis[k] === undefined && picked[k] !== undefined) globalThis[k] = picked[k];
    }
  } catch {
    // main-context escape unavailable — run with whatever globals exist
  }
})();`,
  },
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});
