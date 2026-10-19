// E2E: activate the bundled extension against the mock Extension Host, then
// drive the MCP server over HTTP with the real MCP client.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const PORT = 8899;

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-test-"));
fs.writeFileSync(path.join(storageDir, "config.json"), JSON.stringify({ port: PORT }));

const { makeActivation, calls } = require("./mock-host.cjs");
const { activate } = require("../dist/extension.cjs");

// Capture the extension's error log (still printed) to check what it records.
const errorLog = [];
const consoleError = console.error;
console.error = (...a) => {
  errorLog.push(a.map(String).join(" "));
  consoleError(...a);
};

activate(makeActivation(storageDir, storageDir));

// wait for the server
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok) break;
  } catch {
    if (i > 50) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};

// tools/list
const { tools } = await client.listTools();
assert.equal(tools.length, 40, `expected exactly 40 tools, got ${tools.length}`);

// every tool has a title and explicit hints — the spec defaults
// (destructiveHint/openWorldHint true) must never apply by omission
for (const t of tools) {
  assert.ok(t.title, `${t.name}: missing title`);
  const a = t.annotations ?? {};
  assert.equal(typeof a.readOnlyHint, "boolean", `${t.name}: readOnlyHint not set`);
  assert.equal(typeof a.openWorldHint, "boolean", `${t.name}: openWorldHint not set`);
  if (!a.readOnlyHint) assert.equal(typeof a.destructiveHint, "boolean", `${t.name}: destructiveHint not set`);
}
// annotation snapshot of the tool groups
const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
const write = (destructive, idempotent) => ({
  readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false,
});
const annotationGroups = [
  [{ readOnlyHint: true, openWorldHint: false }, ["song_get", "track_get", "clip_get",
    "midi_clip_get_notes", "device_get", "chain_get", "parameter_get", "mixer_get", "render_track_audio"]],
  [write(false, true), ["song_set", "track_set", "take_lane_set", "scene_set", "cue_point_set",
    "clip_set", "drum_chain_set", "parameter_set", "mixer_set"]],
  [write(false, false), ["track_create", "track_duplicate", "take_lane_create", "scene_create",
    "scene_duplicate", "cue_point_create", "clip_create", "device_insert", "device_duplicate",
    "rack_insert_chain", "import_file"]],
  [write(true, true), ["track_delete", "scene_delete", "clip_delete", "cue_point_delete",
    "device_delete", "track_clear_clips_in_range", "simpler_replace_sample"]],
  [write(true, false), ["midi_clip_set_notes", "midi_clip_edit_notes"]],
  [{ ...write(false, false), openWorldHint: true }, ["show_dialog"]],
  [{ ...write(true, false), openWorldHint: true }, ["execute_command"]],
];
for (const [expected, names] of annotationGroups)
  for (const n of names) assert.deepEqual(toolByName[n]?.annotations, expected, `${n}: annotations`);
assert.equal(new Set(annotationGroups.flatMap(([, n]) => n)).size, 40, "snapshot lists the 40 original tools once");

// server instructions: a short digest, sent on initialize
const instructions = client.getInstructions();
assert.match(instructions, /song_get/);
assert.match(instructions, /beats/);
assert.ok(instructions.trim().split("\n").length <= 25, "instructions should stay a short digest");

// song_get with NO arguments key at all (spec-legal; regression for empty-shape validation)
const noArgs = await client.callTool({ name: "song_get" });
assert.ok(!noArgs.isError, `song_get without arguments failed: ${noArgs.content[0].text}`);

// song_get include selector: only tempo/grid/scale + scenes
const partial = await call("song_get", { include: ["scenes"] });
assert.ok(partial.scenes && !partial.tracks && !partial.cue_points && !partial.environment);

// song_get
let song = await call("song_get");
assert.equal(song.tempo, 120);
assert.equal(song.tracks.length, 2);
assert.equal(song.scenes.length, 2);
assert.equal(song.cue_points.length, 1);
assert.equal(song.main_track.type, "main");
assert.equal(song.grid.quantization, "Quarter");
assert.equal(song.environment.mcp_port, PORT);
const midiTrackId = song.tracks[0].id;
const audioTrackId = song.tracks[1].id;

// song_set
assert.equal((await call("song_set", { tempo: 100 })).tempo, 100);

// track_get
const track = await call("track_get", { track_id: midiTrackId });
assert.equal(track.name, "Bass");
assert.equal(track.devices.length, 1);
assert.equal(track.clip_slots.length, 2);
assert.equal(track.clip_slots[0].clip.class, "MidiClip");
assert.equal(track.mixer.volume.value, 0.85);
assert.match(track.mixer.volume.hint, /0 dB/);

// track addressing by index and name, include selector
const byIndex = await call("track_get", { track_index: 0, include: ["devices"] });
assert.equal(byIndex.name, "Bass");
assert.ok(byIndex.devices && !byIndex.clip_slots && !byIndex.mixer);
const byName = await call("track_get", { track_name: "drums", include: [] });
assert.equal(byName.name, "Drums");
const badName = await client.callTool({ name: "track_get", arguments: { track_name: "nope" } });
assert.equal(badName.isError, true);
assert.match(badName.content[0].text, /No track named/);
// the server's own argument errors carry no stale-id hint
const badIndex = await client.callTool({ name: "track_get", arguments: { track_index: 99 } });
assert.equal(badIndex.isError, true);
assert.match(badIndex.content[0].text, /out of range/);
assert.doesNotMatch(badIndex.content[0].text, /stale/);
const clipId = track.clip_slots[0].clip.id;
const emptySlotId = track.clip_slots[1].id;
const deviceId = track.devices[0].id;

// track_set
assert.equal((await call("track_set", { track_id: midiTrackId, name: "Bass 2", mute: true })).name, "Bass 2");

// midi notes roundtrip
const notes = await call("midi_clip_get_notes", { clip_id: clipId });
assert.equal(notes.note_count, 2);
assert.equal((await call("clip_get", { clip_id: clipId })).note_count, 2);
await call("midi_clip_set_notes", {
  clip_id: clipId,
  notes: [
    { pitch: 36, start_time: 0, duration: 1, velocity: 100 },
    { pitch: 38, start_time: 1, duration: 1 },
    { pitch: 43, start_time: 2, duration: 0.5, probability: 0.8 },
  ],
});
assert.equal((await call("midi_clip_get_notes", { clip_id: clipId })).note_count, 3);

// merge mode: layer 1 note on top without resending
await call("midi_clip_set_notes", {
  clip_id: clipId, mode: "merge",
  notes: [{ pitch: 42, start_time: 0.5, duration: 0.25, velocity: 70 }],
});
assert.equal((await call("midi_clip_get_notes", { clip_id: clipId })).note_count, 4);

// edit_notes: transpose only the hi-hat (pitch 42) up 12, then quantize + velocity scale all
const edit1 = await call("midi_clip_edit_notes", {
  clip_id: clipId, select: { pitch_min: 42, pitch_max: 42 }, transpose: 12,
});
assert.equal(edit1.changed_count, 1);
assert.ok((await call("midi_clip_get_notes", { clip_id: clipId })).notes.some((n) => n.pitch === 54));
const edit2 = await call("midi_clip_edit_notes", { clip_id: clipId, velocity_scale: 0.5, quantize: { grid: 1 } });
assert.equal(edit2.changed_count, 4);
const afterEdit = await call("midi_clip_get_notes", { clip_id: clipId });
assert.ok(afterEdit.notes.every((n) => n.start_time % 1 === 0));
assert.equal(afterEdit.notes.find((n) => n.pitch === 36).velocity, 50);
// delete selected
const edit3 = await call("midi_clip_edit_notes", { clip_id: clipId, select: { pitch_min: 54, pitch_max: 54 }, delete: true });
assert.equal(edit3.note_count, 3);

// clip_create midi via track + scene_index, with inline notes, name, color
const newClip = await call("clip_create", {
  type: "midi", target_id: midiTrackId, scene_index: 1, duration: 8,
  name: "Lead", color: "#00ff88",
  notes: [
    { pitch: 72, start_time: 0, duration: 1 },
    { pitch: 76, start_time: 1, duration: 1 },
  ],
});
assert.equal(newClip.class, "MidiClip");
assert.equal(newClip.duration, 8);
assert.equal(newClip.name, "Lead");
assert.equal(newClip.color, "#00ff88");
assert.equal(newClip.note_count, 2);
// midi clips reject audio-only arguments before creating anything
const slotsOf = async (id) => (await call("track_get", { track_id: id, include: ["clip_slots"] })).clip_slots;
const slotClipBefore = (await slotsOf(midiTrackId))[1].clip;
for (const extra of [{ file_path: "/tmp/kick.wav" }, { is_warped: true },
  { loop_settings: { looping: false, start_marker: 0, end_marker: 4, loop_start: 0, loop_end: 4 } }]) {
  const r = await client.callTool({
    name: "clip_create", arguments: { type: "midi", target_id: emptySlotId, duration: 8, ...extra },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /audio clips only/);
  assert.doesNotMatch(r.content[0].text, /stale/);
}
assert.deepEqual((await slotsOf(midiTrackId))[1].clip, slotClipBefore);
assert.equal((await call("clip_create", { type: "midi", target_id: emptySlotId, duration: 8 })).class, "MidiClip");

// clip_set roundtrip
const colored = await call("clip_set", { clip_id: newClip.id, name: "Lead 2" });
assert.equal(colored.name, "Lead 2");

// clip_delete (session clip, via parent slot)
await call("clip_delete", { clip_id: newClip.id });
const trackAfter = await call("track_get", { track_id: midiTrackId, include: ["clip_slots"] });
assert.equal(trackAfter.clip_slots[1].clip, null);

// device_get + parameters, filtered + with values
const device = await call("device_get", { device_id: deviceId });
assert.equal(device.name, "Operator");
assert.equal(device.parameters.length, 2);
const filtered = await call("device_get", { device_id: deviceId, parameter_filter: "filter", include_values: true });
assert.equal(filtered.parameters.length, 1);
assert.equal(filtered.parameters[0].name, "Filter Freq");
assert.equal(typeof filtered.parameters[0].value, "number");
const paramId = device.parameters[1].id;

// parameter set/get roundtrip; several values form exactly one undo step
const tx0 = calls.transactions.outer;
const setRes = await call("parameter_set", {
  values: [{ parameter_id: paramId, value: 90 }, { parameter_id: device.parameters[0].id, value: 0.25 }],
});
assert.equal(setRes[0].value, 90);
assert.equal(setRes[1].value, 0.25);
assert.equal(calls.transactions.outer - tx0, 1, "parameter_set must be one undo step");
const got = await call("parameter_get", { parameter_ids: [paramId] });
assert.equal(got[0].value, 90);

// device_insert + delete
const rev = await call("device_insert", { target_id: midiTrackId, device_name: "Reverb" });
assert.equal(rev.name, "Reverb");
await call("device_delete", { device_id: rev.id });

// mixer_get
const mixer = await call("mixer_get", { target_id: audioTrackId });
assert.equal(mixer.volume.name, "Volume");
assert.equal(mixer.sends.length, 1);
assert.equal(mixer.sends[0].return_track, "A-Reverb");

// mixer_set: volume + pan + send in one call, one undo step
const tx1 = calls.transactions.outer;
const mixed = await call("mixer_set", { target_id: audioTrackId, volume: 0.7, panning: -0.25, sends: [{ index: 0, value: 0.3 }] });
assert.equal(calls.transactions.outer - tx1, 1, "mixer_set must be one undo step");
assert.equal(mixed.volume.value, 0.7);
assert.equal(mixed.panning.value, -0.25);
assert.equal(mixed.sends[0].value, 0.3);

// drum rack family: insert -> chain -> pad note -> chain devices deep
const drumTrackE = await call("track_create", { type: "midi" });
const rackE = await call("device_insert", { target_id: drumTrackE.id, device_name: "Drum Rack" });
assert.equal(rackE.is_drum_rack, true);
const chainE = await call("rack_insert_chain", { rack_device_id: rackE.id, index: 0 });
assert.equal(chainE.receiving_note, 60);
await call("drum_chain_set", { drum_chain_id: chainE.id, receiving_note: 36 });
const chainDetail = await call("chain_get", { chain_id: chainE.id });
assert.equal(chainDetail.receiving_note, 36);
assert.equal(chainDetail.mixer.volume.name, "Volume");
const simplerE = await call("device_insert", { target_id: chainE.id, device_name: "Simpler" });
const sampleE = await call("simpler_replace_sample", { simpler_device_id: simplerE.id, file_path: "/tmp/kick.wav" });
assert.ok(sampleE.file_path.includes("kick.wav"));
const deepRack = await call("device_get", { device_id: rackE.id, include_chain_devices: true });
assert.equal(deepRack.chains[0].devices[0].name, "Simpler");
assert.ok(deepRack.chains[0].devices[0].sample.file_path.includes("kick.wav"));

// duplicates
const dupDev = await call("device_duplicate", { device_id: simplerE.id });
assert.equal(dupDev.name, "Simpler");
const dupTrack = await call("track_duplicate", { track_id: drumTrackE.id });
assert.match(dupTrack.name, /Copy/);
const dupScene = await call("scene_duplicate", { scene_id: song.scenes[0].id });
assert.match(dupScene.name, /Copy/);
await call("scene_delete", { scene_id: dupScene.id });
await call("track_delete", { track_id: dupTrack.id });

// stale id: delete the drum track, then use its id — error must carry re-fetch hint
await call("track_delete", { track_id: drumTrackE.id });
const stale = await client.callTool({ name: "track_get", arguments: { track_id: drumTrackE.id } });
assert.equal(stale.isError, true);
assert.match(stale.content[0].text, /re-fetch ids via song_get/);

// scenes / cue points
const scene = await call("scene_create", { index: -1 });
await call("scene_set", { scene_id: scene.id, name: "Outro" });
await call("scene_delete", { scene_id: scene.id });
const cue = await call("cue_point_create", { time: 32 });
await call("cue_point_set", { cue_point_id: cue.id, name: "Break" });
await call("cue_point_delete", { cue_point_id: cue.id });

// tracks create/delete
const newTrack = await call("track_create", { type: "audio" });
assert.equal(newTrack.type, "audio");
await call("track_delete", { track_id: newTrack.id });

// take lanes
const lane = await call("take_lane_create", { track_id: midiTrackId });
await call("take_lane_set", { take_lane_id: lane.id, name: "Take A" });
// clip on a take lane: lands in the lane (not the track's arrangement clips)
const laneClip = await call("clip_create", {
  type: "midi", target_id: lane.id, start_time: 8, duration: 4, name: "Take clip",
  notes: [{ pitch: 60, start_time: 0, duration: 1 }],
});
assert.equal(laneClip.start_time, 8);
assert.equal(laneClip.note_count, 1);
const laneSections = { track_id: midiTrackId, include: ["take_lanes", "arrangement_clips"] };
let laneTrack = await call("track_get", laneSections);
const laneView = laneTrack.take_lanes.find((l) => l.id === lane.id);
assert.equal(laneView.name, "Take A");
assert.deepEqual(laneView.clips.map((c) => c.id), [laneClip.id]);
assert.ok(!laneTrack.arrangement_clips.some((c) => c.id === laneClip.id));
const laneNoStart = await client.callTool({
  name: "clip_create", arguments: { type: "midi", target_id: lane.id, duration: 4 },
});
assert.equal(laneNoStart.isError, true);
assert.match(laneNoStart.content[0].text, /start_time is required/);
await call("clip_delete", { clip_id: laneClip.id });
laneTrack = await call("track_get", laneSections);
assert.equal(laneTrack.take_lanes.find((l) => l.id === lane.id).clips.length, 0);

// arrangement clips: midi on track, audio on audio track (auto-import)
const arrClip = await call("clip_create", { type: "midi", target_id: midiTrackId, start_time: 16, duration: 4 });
assert.equal(arrClip.start_time, 16);
const audioClip = await call("clip_create", {
  type: "audio", target_id: audioTrackId, start_time: 0, file_path: "/tmp/kick.wav",
});
assert.ok(audioClip.imported_path.includes("Imported"));
assert.ok(audioClip.file_path.includes("kick.wav"));

// audio clip warp settings
const warped = await call("clip_set", { clip_id: audioClip.id, warping: true, warp_mode: "Complex" });
assert.equal(warped.warp_mode, "Complex");

// clear range + render + import
await call("track_clear_clips_in_range", { track_id: audioTrackId, start_time: 0, end_time: 64 });
const render = await call("render_track_audio", { track_id: audioTrackId, start_time: 0, end_time: 8 });
assert.ok(render.audio_path.endsWith(".wav"));
const imp = await call("import_file", { file_path: "/tmp/loop.wav" });
assert.ok(imp.imported_path.includes("loop.wav"));

// ui + commands; the status command and its menu entries are registered
await call("execute_command", { command_id: "ableton-live-mcp.status" });
assert.equal(calls.dialogs.length, 1);
const statusPage = decodeURIComponent(calls.dialogs[0].url);
assert.match(statusPage, new RegExp(`http://127\\.0\\.0\\.1:${PORT}/mcp`));
assert.ok(statusPage.includes(path.join(storageDir, "config.json")), "status shows the config path");
assert.deepEqual(calls.menus.map((m) => m.scope).sort(), ["AudioTrack", "MidiTrack"]);
assert.ok(calls.menus.every((m) => m.commandId === "ableton-live-mcp.status"));
const dlg = await call("show_dialog", { html: "<b>hi</b>" });
assert.equal(dlg.result, "mock-dialog-result");

// error path: bogus id
const bad = await client.callTool({ name: "track_get", arguments: { track_id: "999999" } });
assert.equal(bad.isError, true);
assert.match(bad.content[0].text, /Unknown object id/);

// error path: malformed hex color rejected without mutating (name must survive)
const badColor = await client.callTool({
  name: "clip_set",
  arguments: { clip_id: clipId, name: "SHOULD NOT APPLY", color: "#fff" },
});
assert.equal(badColor.isError, true);
assert.match(badColor.content[0].text, /Invalid color/);
assert.equal((await call("clip_get", { clip_id: clipId })).name, "Bassline");
// failed calls are logged with tool name and duration, never with arguments
const failLog = errorLog.filter((l) => l.includes("clip_set failed after"));
assert.ok(failLog.some((l) => /clip_set failed after \d+ ms: Invalid color/.test(l)), "failure logged");
assert.ok(!errorLog.some((l) => l.includes("SHOULD NOT APPLY")), "arguments must not be logged");

// error path: warp args on a MIDI clip rejected before any mutation
const badWarp = await client.callTool({
  name: "clip_set",
  arguments: { clip_id: clipId, name: "SHOULD NOT APPLY", warp_mode: "Beats" },
});
assert.equal(badWarp.isError, true);
assert.equal((await call("clip_get", { clip_id: clipId })).name, "Bassline");

// protocol: malformed JSON body → 400 with -32700 parse error (not 500/-32603)
const rawRes = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: "{not json",
});
assert.equal(rawRes.status, 400);
assert.equal((await rawRes.json()).error.code, -32700);
// ...and the transport error reaches the server's onerror log
assert.ok(errorLog.some((l) => l.includes("MCP error: Parse error")), "transport errors are logged");

// http layer: raw requests with full control over Host/Origin/method
const raw = (method, urlPath, headers = {}, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, method, path: urlPath, agent: false,
        headers: { connection: "close", ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
const rpc = (headers = {}, urlPath = "/mcp") =>
  raw("POST", urlPath, {
    "content-type": "application/json", accept: "application/json, text/event-stream", ...headers,
  }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
const assertForbidden = (r, what) => {
  assert.equal(r.status, 403, `${what}: expected 403, got ${r.status}`);
  const b = JSON.parse(r.body);
  assert.equal(b.jsonrpc, "2.0");
  assert.equal(b.id, null);
  assert.equal(b.error.code, -32000);
};
// DNS rebinding: foreign Host, foreign or opaque Origin are refused before routing
const tempo = (await call("song_get", { include: [] })).tempo;
const rebound = await raw("POST", "/mcp", {
  host: `evil.example:${PORT}`, origin: "http://evil.example", "content-type": "application/json",
  accept: "application/json, text/event-stream",
}, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "song_set", arguments: { tempo: 133 } } }));
assertForbidden(rebound, "rebinding song_set");
assert.equal((await call("song_get", { include: [] })).tempo, tempo, "rebound request must not run");
assertForbidden(await rpc({ host: `evil.example:${PORT}` }), "foreign Host");
assertForbidden(await rpc({ host: "127.0.0.1.evil.example" }), "loopback-prefixed Host");
assertForbidden(await rpc({ host: `127.0.0.1:${PORT}@evil.example` }), "userinfo Host");
assertForbidden(await raw("GET", "/health", { host: "evil.example" }), "foreign Host on /health");
assertForbidden(await rpc({ origin: "http://evil.example" }), "foreign Origin");
assertForbidden(await rpc({ origin: "null" }), "Origin: null");
assertForbidden(await rpc({ origin: `ws://localhost:${PORT}` }), "non-http loopback Origin");
assertForbidden(await rpc({ origin: "http://localhost.evil.example" }), "localhost-prefixed Origin");
// loopback Host on any port, and loopback http(s) Origins, are fine
for (const headers of [
  { host: "localhost" }, { host: "localhost:1234" }, { host: `[::1]:${PORT}` },
  { origin: "http://localhost:3000" }, { origin: "https://127.0.0.1" }, { origin: "http://[::1]:8080" },
]) {
  const r = await rpc(headers);
  assert.equal(r.status, 200, `${JSON.stringify(headers)}: expected 200, got ${r.status} ${r.body}`);
  assert.equal(JSON.parse(r.body).result.tools.length, tools.length);
}
// exact routing; the query string is ignored
assert.equal((await raw("GET", "/health?x=1")).status, 200);
assert.equal(JSON.parse((await raw("GET", "/health")).body).ok, true);
assert.equal((await rpc({}, "/mcp?x=1")).status, 200);
assert.equal((await rpc({}, "/mcpfoo")).status, 404);
assert.equal((await raw("GET", "/healthz")).status, 404);
// stateless server: no GET stream, no DELETE session
for (const method of ["GET", "DELETE"]) {
  const r = await raw(method, "/mcp", { accept: "text/event-stream" });
  assert.equal(r.status, 405, `${method} /mcp`);
  assert.equal(r.headers.allow, "POST");
  assert.equal(JSON.parse(r.body).error.code, -32000);
}
// declared body over the limit is refused without reading it
const huge = await raw("POST", "/mcp", {
  "content-type": "application/json", accept: "application/json, text/event-stream",
  "content-length": "16000001",
});
assert.equal(huge.status, 413);

// a second instance on the same port fails to listen; its Status dialog says why
const storageDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-test-"));
fs.writeFileSync(path.join(storageDir2, "config.json"), JSON.stringify({ port: PORT }));
const second = { dialogs: [], commands: {}, menus: [] };
activate(makeActivation(storageDir2, storageDir2, second));
assert.ok(second.commands["ableton-live-mcp.status"], "status command registered before listen");
assert.equal(second.menus.length, 2, "context-menu entries registered before listen");
let failedPage = "";
for (let i = 0; i < 50 && !failedPage.includes("EADDRINUSE"); i++) {
  await new Promise((r) => setTimeout(r, 20));
  second.dialogs.length = 0;
  second.commands["ableton-live-mcp.status"]();
  failedPage = decodeURIComponent(second.dialogs[0].url);
}
assert.match(failedPage, /EADDRINUSE/);
assert.match(failedPage, new RegExp(`Port ${PORT} is already in use`));
assert.ok(failedPage.includes(path.join(storageDir2, "config.json")), "failed status shows the config path");
fs.rmSync(storageDir2, { recursive: true, force: true });

await client.close();
fs.rmSync(storageDir, { recursive: true, force: true });
console.log(`OK — ${tools.length} tools, all assertions passed`);
process.exit(0);
