// Load dist/extension.cjs the way the Live Extension Host does: evaluated in a
// bare V8 context with no `global` and none of the web globals (fetch,
// Request, Response, ReadableStream, URL, TextEncoder, ...). The build.ts
// banner must fill those in before the MCP SDK loads, and activation must get
// as far as listen. e2e.mjs loads the bundle with plain require(), so it never
// runs this path.
//
// What the context does get (assumed host behaviour, not documented in the
// SDK): a CommonJS wrapper (require/module/exports) whose `require` is the
// main context's, so core modules are shared; plus console and timers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PORT = 8897;
const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "dist", "extension.cjs");
const require = createRequire(import.meta.url);
const { makeActivation } = require("./mock-host.cjs");

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-vm-"));
fs.writeFileSync(path.join(storageDir, "config.json"), JSON.stringify({ port: PORT }));

const logs = [];
const sandbox = {
  console: {
    log: (...a) => logs.push(a.map(String).join(" ")),
    error: (...a) => {
      logs.push(a.map(String).join(" "));
      console.error(...a);
    },
    warn: (...a) => logs.push(a.map(String).join(" ")),
    info: (...a) => logs.push(a.map(String).join(" ")),
    debug: () => {},
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
const context = vm.createContext(sandbox);
const missing = ["global", "fetch", "Request", "Response", "ReadableStream", "URL", "TextEncoder", "EventTarget"];
for (const name of missing)
  assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", `${name} leaked into the bare context`);

const module = { exports: {} };
const wrapper = vm.runInContext(
  `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(bundlePath, "utf8")}\n})`,
  context,
  { filename: bundlePath },
);
wrapper(module.exports, createRequire(bundlePath), module, bundlePath, path.dirname(bundlePath));

// the banner pulled the web globals in from the main context
for (const name of missing.slice(1))
  assert.notEqual(vm.runInContext(`typeof ${name}`, context), "undefined", `banner did not provide ${name}`);
assert.equal(typeof module.exports.activate, "function");

module.exports.activate(makeActivation(storageDir, storageDir, { dialogs: [], commands: {}, menus: [] }));

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
  } catch {
    if (i > 50) throw new Error(`server did not start in the VM context. Log:\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
assert.ok(logs.some((l) => l.includes(`listening on http://127.0.0.1:${PORT}/mcp`)));

// one full MCP round trip through the SDK running inside the context
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return r.json();
};
const init = await post({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vm", version: "1" } },
});
assert.match(init.result.instructions, /song_get/);
const song = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "song_get" } });
assert.ok(!song.result.isError, song.result.content[0].text);
assert.equal(typeof JSON.parse(song.result.content[0].text).tempo, "number");
// file reading code runs inside the context too: no Node globals such as Buffer there
const toolCall = async (id, name, args) => {
  const r = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  assert.ok(!r.result.isError, `${name}: ${r.result.content[0].text}`);
  return JSON.parse(r.result.content[0].text);
};
const rendered = await toolCall(3, "render_track_audio", { track_name: "Drums", start_time: 0, end_time: 4, analyze: true });
assert.ok(rendered.analysis, `analysis failed in the VM context: ${rendered.analysis_error}`);
assert.equal(rendered.analysis.silent, true, "the mock's Drums track has no clips: a silent render");
assert.ok(Array.isArray((await toolCall(4, "sample_search", { limit: 1, time_limit_s: 1 })).results));

fs.rmSync(storageDir, { recursive: true, force: true });
console.log("OK — bundle activates and serves MCP in a bare VM context");
process.exit(0);
