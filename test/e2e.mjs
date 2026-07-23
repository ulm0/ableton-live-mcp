// E2E: activate the bundled extension against the mock Extension Host, then
// drive the MCP server over HTTP with the real MCP client.
import assert from "node:assert/strict";
import fs from "node:fs";
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
assert.ok(tools.length >= 35, `expected >=35 tools, got ${tools.length}`);

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
assert.equal(track.clip_slots[0].clip.note_count, 2);
assert.equal(track.mixer.volume.value, 0.85);
const clipId = track.clip_slots[0].clip.id;
const emptySlotId = track.clip_slots[1].id;
const deviceId = track.devices[0].id;

// track_set
assert.equal((await call("track_set", { track_id: midiTrackId, name: "Bass 2", mute: true })).name, "Bass 2");

// midi notes roundtrip
const notes = await call("midi_clip_get_notes", { clip_id: clipId });
assert.equal(notes.note_count, 2);
await call("midi_clip_set_notes", {
  clip_id: clipId,
  notes: [
    { pitch: 36, start_time: 0, duration: 1, velocity: 100 },
    { pitch: 38, start_time: 1, duration: 1 },
    { pitch: 43, start_time: 2, duration: 0.5, probability: 0.8 },
  ],
});
assert.equal((await call("midi_clip_get_notes", { clip_id: clipId })).note_count, 3);

// clip_create midi in empty session slot
const newClip = await call("clip_create", { type: "midi", target_id: emptySlotId, duration: 8 });
assert.equal(newClip.class, "MidiClip");
assert.equal(newClip.duration, 8);

// clip_set + clip_get
const colored = await call("clip_set", { clip_id: newClip.id, name: "Lead", color: "#00ff88" });
assert.equal(colored.name, "Lead");
assert.equal(colored.color, "#00ff88");

// clip_delete (session clip, via parent slot)
await call("clip_delete", { clip_id: newClip.id });
const trackAfter = await call("track_get", { track_id: midiTrackId });
assert.equal(trackAfter.clip_slots[1].clip, null);

// device_get + parameters
const device = await call("device_get", { device_id: deviceId });
assert.equal(device.name, "Operator");
assert.equal(device.parameters.length, 2);
const paramId = device.parameters[1].id;

// parameter set/get roundtrip
const setRes = await call("parameter_set", { values: [{ parameter_id: paramId, value: 90 }] });
assert.equal(setRes[0].value, 90);
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

// ui + commands
await call("execute_command", { command_id: "ableton-live-mcp.status" });
assert.equal(calls.dialogs.length, 1);
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

await client.close();
fs.rmSync(storageDir, { recursive: true, force: true });
console.log(`OK — ${tools.length} tools, all assertions passed`);
process.exit(0);
