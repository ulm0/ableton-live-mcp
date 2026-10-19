// E2E: activate the bundled extension against the mock Extension Host, then
// drive the MCP server over HTTP with the real MCP client.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const PORT = 8899;

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-test-"));
fs.writeFileSync(path.join(storageDir, "config.json"), JSON.stringify({ port: PORT }));

const { makeActivation, calls, fixtures } = require("./mock-host.cjs");
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
// A call that must fail with the server's own argument error (no stale-id hint).
const usageError = async (name, args, pattern) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  assert.equal(res.isError, true, `${name} should fail: ${text}`);
  assert.match(text, pattern);
  assert.doesNotMatch(text, /stale/, `${name}: argument errors carry no stale-id hint`);
  return text;
};

// tools/list
const { tools } = await client.listTools();
assert.equal(tools.length, 60, `expected exactly 60 tools, got ${tools.length}`);

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
    "midi_clip_get_notes", "device_get", "chain_get", "parameter_get", "mixer_get",
    "parameter_find", "device_preset_list", "scene_get", "session_grid", "arrangement_get", "song_audit",
    "selection_get", "selection_wait", "sample_search", "dialog_result", "batch_read"]],
  [write(false, true), ["song_set", "track_set", "take_lane_set", "scene_set", "cue_point_set",
    "clip_set", "drum_chain_set", "parameter_set", "mixer_set", "device_set"]],
  [write(false, false), ["track_create", "track_duplicate", "take_lane_create", "scene_create",
    "scene_duplicate", "cue_point_create", "clip_create", "device_insert", "device_duplicate",
    "rack_insert_chain", "import_file",
    // render_track_audio persist:true imports the render into the project
    "render_track_audio"]],
  // device_preset_save may overwrite a preset (overwrite:true); arrangement_copy_range overwrites its target
  [write(true, true), ["track_delete", "scene_delete", "clip_delete", "cue_point_delete",
    "device_delete", "track_clear_clips_in_range", "simpler_replace_sample", "device_preset_save",
    "arrangement_copy_range"]],
  // device_copy / clip_copy move delete the original; device_preset_load and drum_kit_build replace
  // Simpler samples; audio_track_consolidate clears its range
  // batch: as destructive as its steps
  [write(true, false), ["midi_clip_set_notes", "midi_clip_edit_notes", "device_copy", "device_preset_load",
    "clip_copy", "drum_kit_build", "audio_track_consolidate", "batch"]],
  [{ ...write(false, false), openWorldHint: true }, ["show_dialog"]],
  [{ ...write(true, false), openWorldHint: true }, ["execute_command"]],
];
for (const [expected, names] of annotationGroups)
  for (const n of names) assert.deepEqual(toolByName[n]?.annotations, expected, `${n}: annotations`);
assert.equal(new Set(annotationGroups.flatMap(([, n]) => n)).size, 60, "snapshot lists every tool once");

// server instructions: a short digest, sent on initialize
const instructions = client.getInstructions();
assert.match(instructions, /song_get/);
assert.match(instructions, /beats/);
assert.ok(instructions.trim().split("\n").length <= 27, "instructions should stay a short digest");
assert.match(instructions, /batch/);
assert.match(instructions, /dialog_result/);

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
// by default the sample is copied into the project and the copy is loaded
assert.deepEqual([sampleE.imported_path, sampleE.file_path],
  ["/mock-project/Samples/Imported/kick.wav", "/mock-project/Samples/Imported/kick.wav"]);
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

// clear range + render + import: clips inside the range are deleted, others stay
const toClear = await call("clip_create", { type: "audio", target_id: audioTrackId, start_time: 16, file_path: "/tmp/kick.wav" });
await call("track_clear_clips_in_range", { track_id: audioTrackId, start_time: 8, end_time: 64 });
assert.deepEqual((await call("track_get", { track_id: audioTrackId, include: ["arrangement_clips"] })).arrangement_clips.map((c) => c.id),
  [audioClip.id], "the clip in the range is gone");
assert.notEqual(toClear.id, audioClip.id);
const render = await call("render_track_audio", { track_id: audioTrackId, start_time: 0, end_time: 8 });
assert.ok(render.audio_path.endsWith(".wav"));
const imp = await call("import_file", { file_path: "/tmp/loop.wav" });
assert.ok(imp.imported_path.includes("loop.wav"));

// --- addressing: tracks and scenes by id, index or name ---------------------
const tracksNow = async () => (await call("song_get", { include: ["tracks"] })).tracks;
const scenesNow = async () => (await call("song_get", { include: ["scenes"] })).scenes;
const undoSteps = async (fn) => {
  const before = calls.transactions.outer;
  const result = await fn();
  return { result, steps: calls.transactions.outer - before };
};

// track_set by (case-insensitive) name, and by several fields that agree;
// the single form is one undo step now
let addressed = await undoSteps(() => call("track_set", { track_name: "drums", solo: true, arm: true }));
assert.equal(addressed.result.id, audioTrackId);
assert.equal(addressed.result.solo, true);
assert.equal(addressed.steps, 1, "track_set with two properties is one undo step");
addressed = await undoSteps(() =>
  call("track_set", { track_index: 1, track_id: audioTrackId, track_name: "Drums", solo: false, arm: false }));
assert.equal(addressed.result.solo, false);
await usageError("track_set", { track_index: 0, track_name: "Drums", mute: false }, /name different tracks/);
addressed = await undoSteps(() => call("track_set", { track_name: "Drums" }));
assert.equal(addressed.steps, 0, "nothing to set: no transaction");
assert.equal(addressed.result.id, audioTrackId);
await usageError("track_get", { track_index: 5 }, /track_index 5 out of range \(0-1\)/);

// ambiguous names list only the tracks they matched
const padA = fixtures.addTrack({ kind: "midi", name: "Pad" });
const padB = fixtures.addTrack({ kind: "midi", name: "Pad" });
await tracksNow();
let ambiguous = await usageError("track_get", { track_name: "Pad" }, /Ambiguous track name "Pad"/);
assert.ok(ambiguous.includes(`"Pad" (track_index 2, id ${padA})`) && ambiguous.includes(`"Pad" (track_index 3, id ${padB})`));
assert.ok(!ambiguous.includes("Drums") && !ambiguous.includes("Bass"), "only the candidates are listed");
assert.match(ambiguous, /Use track_id or track_index\./);
ambiguous = await usageError("track_get", { track_name: "PAD" }, /Ambiguous track name "PAD"/);
assert.ok(!ambiguous.includes("Drums"));
// return and main tracks are addressable by name too
assert.equal((await call("track_get", { track_name: "a-reverb", include: [] })).type, "other");

// track_delete wants the exact name; nothing is deleted on a near miss
const temp = await call("track_create", { type: "audio", name: "Temp" });
const nearMiss = await usageError("track_delete", { track_name: "temp" }, /No track named exactly "temp"/);
assert.ok(nearMiss.includes(`"Temp" (track_index`), "suggests the exact name");
assert.ok((await tracksNow()).some((x) => x.id === temp.id));
assert.deepEqual(await call("track_delete", { track_name: "Temp" }), { deleted: temp.id, name: "Temp" });
assert.ok(!(await tracksNow()).some((x) => x.id === temp.id));

// track_duplicate / take_lane_create / clear range / render by index or name
const padCopy = await call("track_duplicate", { track_index: 3 });
assert.equal(padCopy.name, "Pad Copy");
assert.equal((await tracksNow())[4].id, padCopy.id, "copy lands right after the original");
await call("track_delete", { track_id: padCopy.id });
const laneByName = await call("take_lane_create", { track_name: "Bass 2" });
assert.ok(laneByName.id);
assert.deepEqual(await call("track_clear_clips_in_range", { track_name: "Drums", start_time: 64, end_time: 72 }),
  { cleared: [64, 72] });
assert.ok((await call("render_track_audio", { track_name: "Drums", start_time: 0, end_time: 4 })).audio_path.endsWith(".wav"));
await usageError("render_track_audio", { track_name: "Bass 2", start_time: 0, end_time: 4 }, /Only audio tracks can be rendered; "Bass 2"/);

// mixer_get / device_insert by track name; target_id and a track address exclude each other
assert.equal((await call("mixer_get", { track_name: "Drums" })).sends[0].return_track, "A-Reverb");
await usageError("mixer_get", { target_id: audioTrackId, track_name: "Drums" }, /not both/);
await usageError("mixer_get", {}, /Provide target_id/);
const revByName = await call("device_insert", { track_name: "Bass 2", device_name: "Reverb" });
assert.equal(revByName.name, "Reverb");
await call("device_delete", { device_id: revByName.id });

// clip_create: track by name + session slot by scene name
const sceneClip = await call("clip_create", { type: "midi", track_name: "Bass 2", scene_name: "drop", duration: 4 });
assert.equal((await slotsOf(midiTrackId))[1].clip.id, sceneClip.id);
await call("clip_delete", { clip_id: sceneClip.id });
await usageError("clip_create", { type: "midi", target_id: emptySlotId, scene_name: "Drop", duration: 4 },
  /require a Track target/);
await usageError("clip_create", { type: "midi", track_name: "Bass 2", scene_index: 0, scene_name: "Drop", duration: 4 },
  /name different scenes/);

// scenes by index or name; scene_delete wants the exact name
let sceneRes = await call("scene_set", { scene_index: 1, name: "Drop!" });
assert.equal(sceneRes.name, "Drop!");
assert.equal(sceneRes.index, 1);
assert.equal(sceneRes.id, song.scenes[1].id);
const introCopy = await call("scene_duplicate", { scene_name: "intro" });
assert.equal(introCopy.index, 1);
await usageError("scene_delete", { scene_name: "intro copy" }, /No scene named exactly "intro copy"/);
assert.deepEqual(await call("scene_delete", { scene_name: "Intro Copy" }), { deleted: introCopy.id, name: "Intro Copy" });
await usageError("scene_set", { scene_index: 7, name: "x" }, /scene_index 7 out of range \(0-1\)/);
await usageError("scene_set", { scene_name: "Drop!" }, /name is required/);

// --- batched writes: one undo step, nothing applied when any entry is invalid -
let batch = await undoSteps(() => call("track_set", {
  items: [{ track_name: "Bass 2", mute: false }, { track_id: audioTrackId, arm: true }, { track_index: 2, name: "Pad 1" }],
}));
assert.equal(batch.steps, 1, "track_set items: one undo step");
assert.deepEqual(batch.result.items.map((x) => [x.name, x.mute, x.arm]),
  [["Bass 2", false, false], ["Drums", false, true], ["Pad 1", false, false]]);
await usageError("track_set", { items: [{ track_name: "Bass 2", name: "SHOULD NOT APPLY" }, { track_name: "nope", mute: true }] },
  /items\[1\]: No track named "nope"/);
assert.equal((await tracksNow())[0].name, "Bass 2", "an invalid entry leaves every track unchanged");
await usageError("track_set", { track_name: "Bass 2", items: [{ track_name: "Drums", mute: true }] }, /not both/);
await usageError("track_set", { items: [{ track_name: "Drums" }] }, /items\[0\]: nothing to set/);

batch = await undoSteps(() => call("scene_set", { items: [{ scene_index: 0, name: "Verse" }, { scene_name: "Drop!", name: "Chorus" }] }));
assert.equal(batch.steps, 1);
assert.deepEqual((await scenesNow()).map((x) => x.name), ["Verse", "Chorus"]);

batch = await undoSteps(() => call("take_lane_set", {
  items: [{ take_lane_id: lane.id, name: "Take 1" }, { take_lane_id: laneByName.id, name: "Take 2" }],
}));
assert.equal(batch.steps, 1);
assert.deepEqual(batch.result.items.map((x) => x.name), ["Take 1", "Take 2"]);
await usageError("take_lane_set", { take_lane_id: lane.id }, /take_lane_id and name are required/);

// clip_set items, and select: every clip of a track (session + arrangement)
batch = await undoSteps(() => call("clip_set", {
  items: [{ clip_id: clipId, muted: true }, { clip_id: arrClip.id, name: "Arr", color: "#112233" }],
}));
assert.equal(batch.steps, 1);
assert.deepEqual(batch.result.items.map((x) => [x.muted, x.name]), [[true, "Bassline"], [false, "Arr"]]);
await usageError("clip_set", { items: [{ clip_id: clipId, name: "SHOULD NOT APPLY" }, { clip_id: arrClip.id, color: "red" }] },
  /items\[1\]: Invalid color/);
assert.equal((await call("clip_get", { clip_id: clipId })).name, "Bassline");
assert.equal((await undoSteps(() => call("clip_set", { clip_id: clipId }))).steps, 0, "nothing to set: no transaction");
const loopClip = await call("clip_create", {
  type: "audio", track_name: "Drums", scene_index: 0, file_path: "/tmp/loop.wav", name: "Loop A",
});
await call("clip_create", { type: "audio", track_name: "Drums", start_time: 32, file_path: "/tmp/hat.wav" });
batch = await undoSteps(() => call("clip_set", { select: { track_name: "Drums" }, warping: true, warp_mode: "ComplexPro" }));
assert.equal(batch.steps, 1, "clip_set select: one undo step");
assert.equal(batch.result.items.length, 3, "all clips of the track, session and arrangement");
assert.ok(batch.result.items.every((c) => c.warp_mode === "ComplexPro" && c.warping));
const loops = await call("clip_set", { select: { track_name: "Drums", scope: "session", name_contains: "LOOP" }, muted: true });
assert.deepEqual(loops.items.map((c) => [c.id, c.muted]), [[loopClip.id, true]]);
assert.deepEqual((await call("clip_set", { select: { track_name: "Drums", name_contains: "nothing" }, muted: true })).items, []);
await usageError("clip_set", { select: { track_name: "Bass 2" }, name: "SHOULD NOT APPLY", warp_mode: "Beats" },
  new RegExp(`clip ${clipId} \\("Bassline"\\): warping/warp_mode only apply to audio clips`));
assert.equal((await call("clip_get", { clip_id: clipId })).name, "Bassline");
await usageError("clip_set", { select: { track_name: "Drums" }, clip_id: clipId, muted: true }, /one of clip_id, items, or select/);
await usageError("clip_set", { select: { track_name: "Drums" } }, /Nothing to set/);

// mixer_set: sends by return name, several targets, per-target items
const sendByName = await call("mixer_set", { track_name: "Drums", sends: [{ return_name: "a-reverb", value: 0.4 }] });
assert.equal(sendByName.sends[0].value, 0.4);
await usageError("mixer_set", { track_name: "Drums", sends: [{ index: 0, return_name: "A-Reverb", value: 0.4 }] },
  /exactly one of index or return_name/);
await usageError("mixer_set", { track_name: "Drums", sends: [{ return_name: "B-Delay", value: 0.4 }] },
  /No return track named "B-Delay"/);
batch = await undoSteps(() => call("mixer_set", { targets: [{ track_name: "Bass 2" }, { target_id: audioTrackId }], panning: 0.5 }));
assert.equal(batch.steps, 1, "mixer_set targets: one undo step");
assert.deepEqual(batch.result.items.map((x) => [x.target_id, x.name, x.panning.value]),
  [[midiTrackId, "Bass 2", 0.5], [audioTrackId, "Drums", 0.5]]);
batch = await undoSteps(() => call("mixer_set", { items: [{ track_name: "Bass 2", volume: 0.5 }, { track_index: 1, volume: 0.6, panning: 0 }] }));
assert.equal(batch.steps, 1);
assert.deepEqual(batch.result.items.map((x) => [x.volume.value, x.panning.value]), [[0.5, 0.5], [0.6, 0]]);
await usageError("mixer_set", { target_id: audioTrackId, targets: [{ track_name: "Bass 2" }], volume: 0.5 }, /one way/);
await usageError("mixer_set", { items: [{ track_name: "Bass 2", volume: 0.5 }], panning: 0 }, /in each entry/);
await usageError("mixer_set", { targets: [{ track_name: "Bass 2" }] }, /Nothing to set/);
await usageError("mixer_set", { targets: [{ track_name: "Bass 2" }, { track_name: "nope" }], volume: 0.1 },
  /targets\[1\]: No track named "nope"/);
assert.equal((await call("mixer_get", { track_name: "Bass 2" })).volume.value, 0.5, "invalid target: nothing changed");

// mixer_set all_tracks: the top-most tracks only; excluded groups keep their tracks
const drumBus = fixtures.addTrack({ kind: "group", name: "Drum Bus" });
const kick = fixtures.addTrack({ kind: "audio", name: "Kick", group: drumBus });
const perc = fixtures.addTrack({ kind: "group", name: "Perc", group: drumBus });
const shaker = fixtures.addTrack({ kind: "audio", name: "Shaker", group: perc });
const vocals = fixtures.addTrack({ kind: "group", name: "Vocals" });
const lead = fixtures.addTrack({ kind: "audio", name: "Lead", group: vocals });
const backing = fixtures.addTrack({ kind: "audio", name: "Backing", group: vocals });
await tracksNow(); // discover the fixture ids, like any client would
assert.equal((await call("track_get", { track_id: kick, include: [] })).group_track_id, drumBus);
const volumeOf = async (id) => (await call("mixer_get", { track_id: id })).volume.value;
batch = await undoSteps(() => call("mixer_set", { all_tracks: true, exclude: [{ track_name: "Vocals" }], volume: 0.3 }));
assert.equal(batch.steps, 1, "all_tracks: one undo step");
assert.deepEqual(batch.result.items.map((x) => x.name), ["Bass 2", "Drums", "Pad 1", "Pad", "Drum Bus"]);
assert.deepEqual(Object.fromEntries(batch.result.skipped.map((x) => [x.name, x.reason])), {
  Kick: 'covered by its group "Drum Bus"',
  Perc: 'covered by its group "Drum Bus"',
  Shaker: 'covered by its group "Drum Bus"',
  Vocals: "excluded",
  Lead: 'inside the excluded group "Vocals"',
  Backing: 'inside the excluded group "Vocals"',
});
assert.deepEqual(await Promise.all([drumBus, kick, shaker, vocals, lead].map(volumeOf)), [0.3, 0.85, 0.85, 0.85, 0.85]);
// excluding a track inside groups: its groups are not set, their other tracks are
batch = await undoSteps(() => call("mixer_set", { all_tracks: true, exclude: [{ track_id: shaker }, { track_name: "Lead" }], volume: 0.2 }));
assert.deepEqual(batch.result.items.map((x) => x.name), ["Bass 2", "Drums", "Pad 1", "Pad", "Kick", "Backing"]);
assert.match(batch.result.skipped.find((x) => x.name === "Drum Bus").reason, /group containing an excluded track/);
assert.match(batch.result.skipped.find((x) => x.name === "Perc").reason, /group containing an excluded track/);
assert.deepEqual(await Promise.all([drumBus, perc, kick, shaker, vocals, lead, backing].map(volumeOf)),
  [0.3, 0.85, 0.2, 0.85, 0.85, 0.85, 0.2]);
await usageError("mixer_set", { all_tracks: true, exclude: [{ track_name: "Vocal" }], volume: 0 }, /exclude\[0\]: No track named "Vocal"/);
assert.equal(await volumeOf(lead), 0.85, "a mistyped exclude changes nothing");
await usageError("mixer_set", { track_name: "Drums", exclude: [{ track_name: "Vocals" }], volume: 0 }, /only applies with all_tracks/);

// --- create with a name and initial config ----------------------------------
// track_create: name, devices with parameters; the position follows Live's selection
fixtures.selectTrack(midiTrackId);
const keys = await call("track_create", {
  type: "midi", name: "Keys",
  devices: ["Operator", { name: "Auto Filter", parameters: [{ name: "frequency", value: 80 }] },
    "No Such Device", { name: "Reverb", parameters: [{ name: "Nope", value: 1 }] }],
});
fixtures.selectTrack(null);
assert.equal(keys.index, 1, "inserted after the selected track");
assert.equal((await tracksNow())[1].id, keys.id);
assert.equal(keys.name, "Keys");
assert.equal(keys.device_count, 3);
assert.deepEqual(keys.devices.map((d) => [d.requested, d.name]),
  [["Operator", "Operator"], ["Auto Filter", "Auto Filter"], ["No Such Device", undefined], ["Reverb", "Reverb"]]);
assert.deepEqual(keys.devices[1].parameters.map((p) => [p.name, p.value]), [["Frequency", 80]]);
const keysFilter = await call("device_get", { device_id: keys.devices[1].id, parameter_filter: "freq", include_values: true });
assert.equal(keysFilter.parameters[0].value, 80);
assert.match(keys.devices[2].error, /rejected the operation without details/);
assert.match(keys.devices[3].error, /^parameters: No parameter named "Nope"/);
assert.equal(keys.errors.length, 2);
assert.match(keys.errors[0], /^devices\[2\] \(No Such Device\): /);
await call("track_delete", { track_name: "Keys" });
const plain = await call("track_create", { type: "audio" });
assert.equal(plain.index, (await tracksNow()).length - 1, "appended without a selection");
assert.equal(plain.devices, undefined);
assert.equal(plain.errors, undefined);
await call("track_delete", { track_id: plain.id });

// scene_create: name, and a batch in order (creates and names: two undo steps)
const bridge = await call("scene_create", { name: "Bridge" });
assert.deepEqual([bridge.index, bridge.name], [2, "Bridge"]);
batch = await undoSteps(() => call("scene_create", { items: [{ name: "Outro" }, { index: 0, name: "Intro" }, {}] }));
assert.equal(batch.steps, 2, "scene_create items: creates + names");
assert.deepEqual(batch.result.items.map((x) => [x.name, x.index]), [["Outro", 4], ["Intro", 0], ["", 5]]);
assert.deepEqual((await scenesNow()).map((x) => x.name), ["Intro", "Verse", "Chorus", "Bridge", "Outro", ""]);
assert.equal((await slotsOf(midiTrackId)).length, 6, "every track gets a clip slot per scene");
await usageError("scene_create", { items: [{ name: "ok" }, { index: 8 }] }, /items\[1\]: index 8 out of range \(0-7/);
assert.equal((await scenesNow()).length, 6, "an invalid entry creates nothing");
for (const name of ["Intro", "Bridge", "Outro"]) await call("scene_delete", { scene_name: name });
await call("scene_delete", { scene_index: 2 });
assert.deepEqual((await scenesNow()).map((x) => x.name), ["Verse", "Chorus"]);

// cue_point_create: name, and a batch
const verse = await call("cue_point_create", { time: 8, name: "Verse" });
assert.deepEqual([verse.name, verse.time], ["Verse", 8]);
batch = await undoSteps(() => call("cue_point_create", { items: [{ time: 16, name: "Chorus" }, { time: 24 }] }));
assert.equal(batch.steps, 2);
const [chorus, plainCue] = batch.result.items;
assert.deepEqual([chorus.name, chorus.time, plainCue.time], ["Chorus", 16, 24]);
await usageError("cue_point_create", { items: [{ time: 48 }, { time: 48 }] }, /items\[1\]: time 48 is given twice/);
await usageError("cue_point_create", { name: "x" }, /time is required/);

// cue_point_set: batch rename, and moves (re-created at the new time, old one deleted)
batch = await undoSteps(() => call("cue_point_set", { items: [{ cue_point_id: verse.id, name: "Verse 1" }, { cue_point_id: plainCue.id, name: "Drop" }] }));
assert.equal(batch.steps, 1, "renames: one undo step");
assert.deepEqual(batch.result.items.map((x) => x.name), ["Verse 1", "Drop"]);
const moved = await call("cue_point_set", { cue_point_id: chorus.id, time: 40 });
assert.notEqual(moved.id, chorus.id);
assert.deepEqual([moved.name, moved.time, moved.replaced_id], ["Chorus", 40, chorus.id]);
let cues = (await call("song_get", { include: ["cue_points"] })).cue_points;
assert.ok(!cues.some((c) => c.id === chorus.id || c.time === 16), "the old cue point is gone");
const staleCue = await client.callTool({ name: "cue_point_set", arguments: { cue_point_id: chorus.id, name: "x" } });
assert.equal(staleCue.isError, true);
// same time = plain rename; a move onto another cue point is refused
const sameTime = await call("cue_point_set", { cue_point_id: moved.id, time: 40, name: "Chorus 1" });
assert.deepEqual([sameTime.id, sameTime.name, sameTime.replaced_id], [moved.id, "Chorus 1", undefined]);
await usageError("cue_point_set", { cue_point_id: verse.id, time: 24 }, new RegExp(`cue point ${plainCue.id} is already at beat 24`));
await usageError("cue_point_set", { items: [{ cue_point_id: verse.id, time: 50 }, { cue_point_id: plainCue.id, time: 50 }] },
  /items\[1\]: time 50 is given twice/);
// batch: move with a new name + rename; three undo steps (creates, names, deletes)
batch = await undoSteps(() => call("cue_point_set", {
  items: [{ cue_point_id: verse.id, time: 12, name: "Verse 2" }, { cue_point_id: plainCue.id, name: "Drop 2" }],
}));
assert.equal(batch.steps, 3);
const [movedVerse, renamedDrop] = batch.result.items;
assert.deepEqual([movedVerse.name, movedVerse.time, movedVerse.replaced_id], ["Verse 2", 12, verse.id]);
assert.deepEqual([renamedDrop.id, renamedDrop.name, renamedDrop.replaced_id], [plainCue.id, "Drop 2", undefined]);
// a replacement that cannot be created rolls the others back: nothing changes
cues = (await call("song_get", { include: ["cue_points"] })).cue_points;
const failedMove = await client.callTool({ name: "cue_point_set", arguments: {
  items: [{ cue_point_id: movedVerse.id, time: 60 }, { cue_point_id: plainCue.id, time: -4 }] } });
assert.equal(failedMove.isError, true);
assert.match(failedMove.content[0].text, /items\[1\]: could not create a cue point at beat -4: .*Nothing was changed/);
assert.deepEqual((await call("song_get", { include: ["cue_points"] })).cue_points, cues);
for (const c of cues.filter((x) => x.name !== "Start")) await call("cue_point_delete", { cue_point_id: c.id });

// clean up the fixture tracks (a group takes its tracks with it) and the extra clip
for (const id of [padA, padB, drumBus, vocals]) await call("track_delete", { track_id: id });
assert.equal((await tracksNow()).length, 2);
await call("clip_delete", { clip_id: loopClip.id });

// --- parameters by name, device on/off, parameter_find ----------------------
// track_create: initial values by value_item and substring; every entry is checked first
await usageError("track_create", { type: "midi", name: "Never", devices: [{ name: "Auto Filter",
  parameters: [{ name: "Frequency", value: 80, reset: true }] }] },
  /devices\[0\]\.parameters\[0\]: give only one of value, value_item, reset and delta, got value \+ reset/);
assert.equal((await tracksNow()).length, 2, "an invalid initial value creates no track");
const synth = await call("track_create", {
  type: "midi", name: "Synth",
  devices: [{ name: "Auto Filter", parameters: [{ name: "filter type", value_item: "high" }, { name: "freq", value: 90 }] },
    "Compressor", "Switch Fx"],
});
assert.equal(synth.errors, undefined);
assert.deepEqual(synth.devices[0].parameters.map((p) => [p.name, p.value]), [["Filter Type", 1], ["Frequency", 90]]);
const [filterId, compId, switchId] = synth.devices.map((d) => d.id);

// parameter_get by device + name (exact, case-insensitive, unique substring), ids first
let byDevice = await call("parameter_get", {
  parameter_ids: [paramId],
  parameters: [
    { track_name: "synth", device: "Auto Filter", parameter: "type" },
    { track_name: "Synth", device: 0, parameter: "Frequency" },
    { device_id: compId, parameter: "RATIO" },
    { parameter_id: paramId },
  ],
});
assert.deepEqual(byDevice.map((p) => [p.name, p.value, p.value_item, p.device_name]), [
  ["Filter Freq", 90, undefined, undefined], ["Filter Type", 1, "Highpass", "Auto Filter"],
  ["Frequency", 90, undefined, "Auto Filter"], ["Ratio", 4, undefined, "Compressor"], ["Filter Freq", 90, undefined, undefined]]);
assert.equal(byDevice[1].device_id, filterId);

// parameter_set: value_item, delta (clamped), value, reset — one undo step
let pset = await undoSteps(() => call("parameter_set", { values: [
  { track_name: "Synth", device: "auto filter", parameter: "Filter Type", value_item: "band" },
  { track_name: "Synth", device: "Auto Filter", parameter: "Frequency", delta: -40 },
  { device_id: filterId, parameter: "Resonance", value: 0.9 },
  { device_id: compId, parameter: "Ratio", delta: 1000 },
] }));
assert.equal(pset.steps, 1, "parameter_set by name: one undo step");
assert.deepEqual(pset.result.map((p) => [p.name, p.value, p.value_item]),
  [["Filter Type", 2, "Bandpass"], ["Frequency", 50, undefined], ["Resonance", 0.9, undefined], ["Ratio", 100, undefined]]);
pset = await call("parameter_set", { values: [
  { device_id: filterId, parameter: "Resonance", reset: true }, { device_id: filterId, parameter: "Filter Type", delta: -1 }] });
assert.deepEqual(pset.map((p) => [p.value, p.value_item]), [[0.5, undefined], [1, "Highpass"]]);

// argument errors: nothing is written when any entry is invalid
const filterFreq = async () => (await call("parameter_get", { parameters: [{ device_id: filterId, parameter: "Frequency" }] }))[0].value;
const setOne = (entry) => ({ values: [{ device_id: filterId, ...entry }] });
await usageError("parameter_set", { values: [{ device_id: filterId, parameter: "Frequency", value: 60 },
  { device_id: filterId, parameter: "Resonance", value: 7 }] }, /values\[1\]: value 7 is out of range for "Resonance" \(0 to 1\)/);
assert.equal(await filterFreq(), 50, "an invalid entry changes nothing");
await usageError("parameter_set", setOne({ parameter: "Frequency", value: 60, delta: 1 }),
  /values\[0\]: give only one of value, value_item, reset and delta, got value \+ delta/);
await usageError("parameter_set", setOne({ parameter: "Frequency", reset: false }), /give one of value, value_item, reset \(true\) or delta/);
await usageError("parameter_set", setOne({ parameter: "Frequency", value_item: "x" }), /"Frequency" is not quantized/);
await usageError("parameter_set", setOne({ parameter: "Filter Type", value: 1.5 }), /"Filter Type" is quantized/);
await usageError("parameter_set", setOne({ parameter: "Filter Type", delta: 0.5 }), /delta must be a whole number/);
await usageError("parameter_set", setOne({ parameter: "Filter Type", value_item: "shelf" }),
  /No value item "shelf" for "Filter Type"\. Items: "Lowpass" \(0\), "Highpass" \(1\)/);
await usageError("parameter_set", setOne({ parameter: "Filter Type", value_item: "pass" }), /Ambiguous value_item "pass"/);
await usageError("parameter_set", setOne({ parameter: "e", value: 0 }), /Ambiguous parameter "e" on "Auto Filter" .*"Device On" \(index 0/);
await usageError("parameter_set", setOne({ parameter: "Cutoff", value: 0 }),
  /No parameter named "Cutoff" \(or containing it\) on "Auto Filter" .*parameter_find/);
await usageError("parameter_set", { values: [{ track_name: "Synth", device: "Phaser", parameter: "x", value: 0 }] },
  /values\[0\]: device on track "Synth" .*: No device named "Phaser"\. Available: "Auto Filter", "Compressor", "Switch Fx"/);
await usageError("parameter_set", { values: [{ parameter_id: paramId, device_id: filterId, value: 0 }] },
  /parameter_id, or a device and parameter, not both/);
await usageError("parameter_set", { values: [{ device_id: filterId, parameter: "Frequency", value: 60 },
  { track_name: "Synth", device: 0, parameter: "freq", delta: 1 }] },
  /values\[1\]: parameter "Frequency" \(id \d+\) is set twice, also by values\[0\]/);
await usageError("parameter_set", { values: [{ device: "Auto Filter", parameter: "Frequency", value: 60 }] }, /device needs its track/);
await usageError("parameter_set", { values: [{ device_id: filterId, track_name: "Synth", parameter: "Frequency", value: 60 }] }, /not both/);
await usageError("parameter_get", {}, /Provide parameter_ids and\/or parameters/);
assert.equal(await filterFreq(), 50);
// a value the host refuses is a host error, named by entry
fixtures.refuseWrites("Ratio");
const refusedSet = await client.callTool({ name: "parameter_set", arguments: { values: [{ device_id: compId, parameter: "Ratio", value: 50 }] } });
fixtures.refuseWrites(null);
assert.equal(refusedSet.isError, true);
assert.match(refusedSet.content[0].text, /values\[0\]: could not set "Ratio" to 50: mock: Ratio is not settable/);

// device paths through racks: drum pads by receiving note, chains by index
const kit = await call("track_create", { type: "midi", name: "Kit", devices: ["Drum Rack"] });
const kitRack = kit.devices[0].id;
const pads = [];
for (const [i, note] of [36, 38].entries()) {
  const ch = await call("rack_insert_chain", { rack_device_id: kitRack, index: i });
  await call("drum_chain_set", { drum_chain_id: ch.id, receiving_note: note });
  pads.push(ch.id);
}
// device_insert: initial parameters in one more undo step
const kickIns = await undoSteps(() => call("device_insert", { target_id: pads[0], device_name: "Simpler", parameters: [{ name: "volume", value: 0.4 }] }));
assert.equal(kickIns.steps, 2, "insert + initial values");
const kickSimpler = kickIns.result;
assert.deepEqual(kickSimpler.parameters.map((p) => [p.name, p.value]), [["Volume", 0.4]]);
const kickLoaded = await call("simpler_replace_sample", { simpler_device_id: kickSimpler.id, file_path: "/tmp/kick.wav", import_into_project: false });
assert.deepEqual([kickLoaded.file_path, kickLoaded.imported_path], ["/tmp/kick.wav", undefined]);
const snare = await call("device_insert", { target_id: pads[1], device_name: "Simpler" });
byDevice = await call("parameter_get", { parameters: [
  { track_name: "Kit", device: ["Drum Rack", { pad: 36 }, "Simpler"], parameter: "Volume" },
  { track_name: "Kit", device: [0, { chain: 1 }, 0], parameter: "Volume" },
] });
assert.deepEqual(byDevice.map((p) => [p.device_id, p.value]), [[kickSimpler.id, 0.4], [snare.id, 0.7]]);
// pads and receiving notes also by note name (C3 = 60, so C1 = 36, D1 = 38); chains report the name
const padNamed = await call("drum_chain_set", { drum_chain_id: pads[1], receiving_note: "D1" });
assert.deepEqual([padNamed.receiving_note, padNamed.receiving_note_name], [38, "D1"]);
const kitChains = (await call("device_get", { device_id: kitRack })).chains;
assert.deepEqual(kitChains.map((c) => [c.receiving_note, c.receiving_note_name]), [[36, "C1"], [38, "D1"]]);
byDevice = await call("parameter_get", { parameters: [
  { track_name: "Kit", device: ["Drum Rack", { pad: "C1" }, "Simpler"], parameter: "Volume" },
  { track_name: "Kit", device: ["Drum Rack", { pad: "d1" }, 0], parameter: "Volume" },
] });
assert.deepEqual(byDevice.map((p) => p.device_id), [kickSimpler.id, snare.id]);
const kitPath = (device) => ({ parameters: [{ track_name: "Kit", device, parameter: "Volume" }] });
await usageError("parameter_get", kitPath(["Drum Rack", { pad: "X1" }, 0]), /device\[1\]: pad: "X1" is not a MIDI pitch/);
await usageError("drum_chain_set", { drum_chain_id: pads[1], receiving_note: "G#8" }, /receiving_note: "G#8" is outside the MIDI range/);
await usageError("parameter_get", kitPath(["Drum Rack", { pad: 40 }, "Simpler"]),
  /device\[1\]: No pad receives note 40 in "Drum Rack" \(id \d+\) \(pads: 36, 38\)/);
await usageError("parameter_get", kitPath(["Drum Rack", { chain: 5 }, 0]), /device\[1\]: chain 5 out of range in "Drum Rack" \(id \d+\) \(0-1\)/);
await usageError("parameter_get", kitPath(["Drum Rack", { pad: 36 }]), /path ends at a chain/);
await usageError("parameter_get", kitPath(["Drum Rack", "Simpler"]), /device\[1\]: pick a chain of "Drum Rack"/);
await usageError("parameter_get", kitPath([{ pad: 36 }]), /device\[0\]: a \{chain\} or \{pad\} step must follow a rack device/);
// a step is a chain or a pad, never both (strict objects)
await usageError("parameter_get", kitPath(["Drum Rack", { pad: 36, chain: 0 }, 0]), /Input validation error/);
await usageError("parameter_get", { parameters: [{ track_name: "Synth", device: ["Auto Filter", { chain: 0 }], parameter: "x" }] },
  /device\[1\]: "Auto Filter" \(id \d+\) is not a rack/);
await usageError("parameter_get", { parameters: [{ track_name: "Synth", device: [7], parameter: "x" }] },
  /device\[0\]: device index 7 out of range on track "Synth" .*\(0-2\)/);
const instRack = await call("device_insert", { track_name: "Kit", device_name: "Instrument Rack" });
await call("rack_insert_chain", { rack_device_id: instRack.id, index: 0 });
await usageError("parameter_get", kitPath(["Instrument Rack", { pad: 36 }, 0]), /is not a Drum Rack: address its chains by \{chain: index\}/);
await call("device_delete", { device_id: instRack.id });
await call("drum_chain_set", { drum_chain_id: pads[1], receiving_note: 36 });
await usageError("parameter_get", kitPath(["Drum Rack", { pad: 36 }, 0]), /Ambiguous pad 36 in "Drum Rack" .*chains 0, 1 .*Use \{chain: index\}/);
await call("drum_chain_set", { drum_chain_id: pads[1], receiving_note: 38 });

// device_set: on/off and parameters in one undo step
let dset = await undoSteps(() => call("device_set", { track_name: "Synth", device: "Auto Filter", enabled: false,
  parameters: [{ name: "Frequency", value: 70 }, { name: "type", value_item: "notch" }] }));
assert.equal(dset.steps, 1, "device_set: one undo step");
assert.deepEqual([dset.result.id, dset.result.enabled, dset.result.on_parameter.name, dset.result.on_parameter.fallback],
  [filterId, false, "Device On", undefined]);
assert.deepEqual(dset.result.parameters.map((p) => [p.name, p.value]), [["Frequency", 70], ["Filter Type", 3]]);
assert.equal((await call("parameter_get", { parameters: [{ device_id: filterId, parameter: "Device On" }] }))[0].value_item, "Off");
dset = await call("device_set", { device_id: filterId, enabled: true });
assert.deepEqual([dset.enabled, dset.parameters], [true, undefined]);
// without "Device On", a first two-state parameter is used, and reported
dset = await call("device_set", { device_id: switchId, enabled: false });
assert.deepEqual([dset.enabled, dset.on_parameter.name, dset.on_parameter.fallback], [false, "Active", true]);
// parameters alone still report the on state
dset = await call("device_set", { device_id: compId, parameters: [{ name: "Threshold", reset: true }] });
assert.equal(dset.enabled, true);
// a device without an on/off switch (the original Operator) cannot be switched; nothing changes
await usageError("device_set", { device_id: deviceId, enabled: false, parameters: [{ name: "Osc-A Level", value: 0.1 }] },
  /has no "Device On" parameter .*cannot be switched on or off/);
assert.equal((await call("parameter_get", { parameters: [{ device_id: deviceId, parameter: "Osc-A Level" }] }))[0].value, 0.25);
await usageError("device_set", { device_id: filterId, enabled: false, parameters: [{ name: "device on", value: 1 }] },
  /parameters\[0\]: parameter "Device On" \(id \d+\) is set twice, also by enabled/);
await usageError("device_set", { device_id: filterId, parameters: [{ parameter_id: paramId, value: 1 }] },
  new RegExp(`parameters\\[0\\]: parameter ${paramId} is not a parameter of "Auto Filter"`));
await usageError("device_set", { device_id: filterId, parameters: [{ name: "Frequency", parameter_id: paramId, value: 1 }] },
  /exactly one of name and parameter_id/);
await usageError("device_set", { device_id: filterId }, /Nothing to set/);
await usageError("device_set", { device_id: filterId, track_name: "Synth", enabled: true }, /not both/);
assert.equal((await call("device_set", { device_id: switchId, enabled: true })).enabled, true);

// device_insert: a bad name keeps the device, sets none of the values and says why
const rev1 = await call("device_insert", { track_name: "Synth", device_name: "Reverb", parameters: [{ name: "dry", value: 0.2 }] });
assert.deepEqual(rev1.parameters.map((p) => [p.name, p.value]), [["Dry/Wet", 0.2]]);
const rev2 = await call("device_insert", { track_name: "Synth", device_name: "Reverb",
  parameters: [{ name: "dry", value: 0.2 }, { name: "Size", value: 1 }] });
assert.match(rev2.errors[0], /^parameters: No parameter named "Size"/);
assert.equal(rev2.parameters, undefined);
assert.equal((await call("parameter_get", { parameters: [{ device_id: rev2.id, parameter: "Dry/Wet" }] }))[0].value, 0.5);
const synthDevices = async () => (await call("track_get", { track_name: "Synth", include: ["devices"] })).devices;
const deviceCount = (await synthDevices()).length;
await usageError("device_insert", { track_name: "Synth", device_name: "Reverb", parameters: [{ name: "dry" }] },
  /parameters\[0\]: give one of value/);
assert.equal((await synthDevices()).length, deviceCount, "checked before the insert");
for (const d of [rev1, rev2]) await call("device_delete", { device_id: d.id });

// parameter_find: the whole set, a track (through racks), a device, by value item
let found = await call("parameter_find", { query: "freq" });
assert.deepEqual(found.matches.map((m) => [m.track_name, m.device_name, m.name, m.path]), [
  ["Bass 2", "Operator", "Filter Freq", "Bass 2 > Operator"], ["Synth", "Auto Filter", "Frequency", "Synth > Auto Filter"]]);
assert.deepEqual([found.total, found.truncated, found.matches[1].device_id, found.matches[1].track_id], [2, false, filterId, synth.id]);
assert.equal(found.matches[0].value, undefined, "values only on request");
found = await call("parameter_find", { track_name: "Kit", query: "VOL", include_values: true });
assert.deepEqual(found.matches.map((m) => [m.path, m.device_id, m.value]), [
  ["Kit > Drum Rack > pad 36 > Simpler", kickSimpler.id, 0.4], ["Kit > Drum Rack > pad 38 > Simpler", snare.id, 0.7]]);
found = await call("parameter_find", { track_name: "Synth", value_item: "notch" });
assert.deepEqual(found.matches.map((m) => [m.name, m.value_items.length]), [["Filter Type", 4]]);
found = await call("parameter_find", { track_name: "Kit", device: ["Drum Rack", { pad: 38 }, "Simpler"] });
assert.deepEqual(found.matches.map((m) => m.name), ["Device On", "Volume", "Transpose"]);
assert.ok(found.matches.every((m) => m.path === "Kit > Drum Rack > pad 38 > Simpler"));
found = await call("parameter_find", { device_id: kitRack, query: "o", limit: 2, include_value_items: false });
assert.deepEqual([found.total, found.truncated, found.matches.length, found.devices_searched], [7, true, 2, 3]);
assert.deepEqual(found.matches.map((m) => [m.path, m.track_id, m.value_items]),
  [["Drum Rack", undefined, undefined], ["Drum Rack > pad 36 > Simpler", undefined, undefined]]);
await usageError("parameter_find", { device: "Auto Filter" }, /device needs its track/);

// --- device_copy: copy and move (lossy), presets ------------------------------
const valuesOf = async (device_id) => Object.fromEntries(
  (await call("parameter_find", { device_id, include_values: true })).matches.map((m) => [m.name, m.value]));
await call("device_set", { device_id: filterId, enabled: false, parameters: [{ name: "Frequency", value: 66 }, { name: "Resonance", value: 0.3 }] });
let copied = await undoSteps(() => call("device_copy", { device_id: filterId, track_name: "Bass 2", index: 0 }));
assert.equal(copied.steps, 2, "device_copy: insert + values");
const filterCopy = copied.result;
assert.notEqual(filterCopy.id, filterId, "the copy has a new id");
assert.deepEqual([filterCopy.name, filterCopy.index, filterCopy.moved, filterCopy.fidelity, filterCopy.source_id,
  filterCopy.not_copied, filterCopy.copied_parameters], ["Auto Filter", 0, false, "approximate", filterId, undefined, 4]);
assert.match(filterCopy.lost, /automation/);
assert.deepEqual(await valuesOf(filterCopy.id), { "Device On": 0, Frequency: 66, Resonance: 0.3, "Filter Type": 3 });
assert.deepEqual(await valuesOf(filterCopy.id), await valuesOf(filterId));
// move = reorder: Switch Fx to the front of its own chain; the old id is gone
await call("device_set", { device_id: switchId, parameters: [{ name: "amount", value: 0.9 }] });
let moved2 = await undoSteps(() => call("device_copy", { device_id: switchId, index: 0, move: true }));
assert.equal(moved2.steps, 3, "move: insert + values + delete");
let movedDev = moved2.result;
assert.deepEqual([movedDev.moved, movedDev.index, movedDev.name], [true, 0, "Switch Fx"]);
assert.deepEqual((await synthDevices()).map((d) => d.name), ["Switch Fx", "Auto Filter", "Compressor"]);
const staleDevice = await client.callTool({ name: "device_get", arguments: { device_id: switchId } });
assert.equal(staleDevice.isError, true);
assert.match(staleDevice.content[0].text, /stale/);
// onto its own position: nothing happens; to the end: index counts before the original is removed
const noMove = await call("device_copy", { device_id: movedDev.id, index: 1, move: true });
assert.deepEqual([noMove.id, noMove.moved, noMove.index], [movedDev.id, false, 0]);
assert.match(noMove.unchanged, /already at that position/);
movedDev = await call("device_copy", { device_id: movedDev.id, move: true });
assert.deepEqual([movedDev.moved, movedDev.index], [true, 2]);
assert.deepEqual((await synthDevices()).map((d) => d.name), ["Auto Filter", "Compressor", "Switch Fx"]);
// a Simpler brings its sample (insert + sample + values)
copied = await undoSteps(() => call("device_copy", { device_id: kickSimpler.id, target_id: pads[1], index: 0 }));
assert.equal(copied.steps, 3);
assert.deepEqual(copied.result.sample, { file_path: "/tmp/kick.wav" });
assert.equal((await valuesOf(copied.result.id)).Volume, 0.4);
assert.ok((await call("device_get", { device_id: kickSimpler.id })).sample, "a copy keeps the original");
await call("device_delete", { device_id: copied.result.id });
// a sample that cannot be loaded removes the copy again
const padDevices = async (chain_id) => (await call("chain_get", { chain_id })).devices.map((d) => d.id);
const padBefore = await padDevices(pads[1]);
fixtures.refuseSamples(true);
const noSample = await client.callTool({ name: "device_copy", arguments: { device_id: kickSimpler.id, target_id: pads[1], move: true } });
fixtures.refuseSamples(false);
assert.equal(noSample.isError, true);
assert.match(noSample.content[0].text, /Could not load the sample \/tmp\/kick\.wav: .*The new device was removed again; nothing else was changed/);
assert.deepEqual(await padDevices(pads[1]), padBefore);
assert.equal((await call("device_get", { device_id: kickSimpler.id })).name, "Simpler", "the original is kept");
// racks are refused; a different device keeps the original and lists what it could not copy
await usageError("device_copy", { device_id: kitRack, track_name: "Synth" }, /is a rack: .*device_duplicate/);
const odd = await call("device_copy", { device_id: compId, device_name: "Reverb", move: true });
assert.deepEqual([odd.name, odd.moved], ["Reverb", false]);
assert.match(odd.original_kept, /incomplete/);
assert.deepEqual(odd.not_copied.map((x) => x.name), ["Threshold", "Ratio"]);
assert.match(odd.not_copied[0].reason, /has no parameter of that name/);
assert.equal((await call("device_get", { device_id: compId })).name, "Compressor");
await call("device_delete", { device_id: odd.id });
// a value Live refuses: listed, and a move keeps the original
fixtures.refuseWrites("Ratio");
const partial2 = await call("device_copy", { device_id: compId, track_name: "Bass 2", move: true });
fixtures.refuseWrites(null);
assert.deepEqual(partial2.not_copied.map((x) => x.name), ["Ratio"]);
assert.match(partial2.not_copied[0].reason, /Live refused 100: mock: Ratio is not settable/);
assert.equal(partial2.moved, false);
await call("device_delete", { device_id: partial2.id });
// an insert Live rejects changes nothing
const devicesOfBass = async () => (await call("track_get", { track_name: "Bass 2", include: ["devices"] })).devices.length;
const bassCount = await devicesOfBass();
const badCopy = await client.callTool({ name: "device_copy", arguments: { device_id: filterId, track_name: "Bass 2", device_name: "Nonexistent" } });
assert.equal(badCopy.isError, true);
assert.match(badCopy.content[0].text, /Could not insert "Nonexistent": .*Nothing was changed/);
assert.equal(await devicesOfBass(), bassCount);
await usageError("device_copy", { device_id: filterId, track_name: "Bass 2", index: 9 }, /index 9 out of range \(0-2/);
// repeated parameter names line up by order
const eq = await call("device_insert", { track_name: "Synth", device_name: "EQ Eight" });
const eqFreqs = (await call("parameter_find", { device_id: eq.id, query: "Frequency" })).matches.map((m) => m.id);
await call("parameter_set", { values: [{ parameter_id: eqFreqs[0], value: 0.3 }, { parameter_id: eqFreqs[1], value: 0.6 }] });
await usageError("parameter_get", { parameters: [{ device_id: eq.id, parameter: "Frequency" }] },
  /Ambiguous parameter "Frequency" on "EQ Eight" .*\(index 1, .*\(index 2, .*parameter_id/);
const eqCopy = await call("device_copy", { device_id: eq.id, track_name: "Bass 2" });
assert.deepEqual((await call("parameter_find", { device_id: eqCopy.id, query: "Frequency", include_values: true }))
  .matches.map((m) => m.value), [0.3, 0.6]);

// presets: JSON files in <storage>/presets
const presetDir = path.join(storageDir, "presets");
let saved = await call("device_preset_save", { name: "Bright Filter", device_id: filterId });
assert.deepEqual([saved.name, saved.device_name, saved.parameter_count, saved.replaced, saved.directory],
  ["Bright Filter", "Auto Filter", 4, false, presetDir]);
const presetFile = JSON.parse(fs.readFileSync(path.join(presetDir, "Bright Filter.json"), "utf8"));
assert.equal(presetFile.format, "ableton-live-mcp/device-preset");
assert.deepEqual(presetFile.parameters.map((p) => [p.name, p.value]),
  [["Device On", 0], ["Frequency", 66], ["Resonance", 0.3], ["Filter Type", 3]]);
await usageError("device_preset_save", { name: "bright filter", device_id: filterId },
  /A preset named "Bright Filter" already exists\. Pass overwrite:true/);
await call("device_set", { device_id: filterId, parameters: [{ name: "Frequency", value: 99 }] });
saved = await call("device_preset_save", { name: "bright filter", device_id: filterId, overwrite: true });
assert.deepEqual([saved.replaced, saved.name], [true, "Bright Filter"], "an overwrite keeps the stored name");
assert.deepEqual(fs.readdirSync(presetDir), ["Bright Filter.json"], "replaced in place, no temp file left");
const replacedFile = JSON.parse(fs.readFileSync(path.join(presetDir, "Bright Filter.json"), "utf8"));
assert.deepEqual([replacedFile.name, replacedFile.parameters[1].value], ["Bright Filter", 99]);
saved = await call("device_preset_save", { name: " Kick 1 ", track_name: "Kit", device: ["Drum Rack", { pad: 36 }, "Simpler"] });
assert.deepEqual([saved.name, saved.sample], ["Kick 1", { file_path: "/tmp/kick.wav" }]);
let plist = await call("device_preset_list");
assert.deepEqual(plist.presets.map((p) => [p.name, p.device_name, p.parameter_count, p.sample?.file_path]).sort(),
  [["Bright Filter", "Auto Filter", 4, undefined], ["Kick 1", "Simpler", 3, "/tmp/kick.wav"]]);
assert.equal(plist.unreadable, undefined);
assert.deepEqual((await call("device_preset_list", { device_name: "simpler" })).presets.map((p) => p.name), ["Kick 1"]);
// load as a new device (track by name, at an index)...
let loaded = await call("device_preset_load", { name: "BRIGHT FILTER", track_name: "Drums", index: 0 });
assert.deepEqual([loaded.name, loaded.inserted, loaded.index, loaded.preset, loaded.not_applied, loaded.warning],
  ["Auto Filter", true, 0, "Bright Filter", undefined, undefined]);
assert.equal((await valuesOf(loaded.id)).Frequency, 99);
const drumsFilter = loaded.id;
// ...onto an existing device (one undo step)...
await call("device_set", { device_id: filterCopy.id, parameters: [{ name: "Frequency", value: 20 }] });
loaded = await undoSteps(() => call("device_preset_load", { name: "Bright Filter", device_id: filterCopy.id }));
assert.equal(loaded.steps, 1);
assert.deepEqual([loaded.result.id, loaded.result.inserted, loaded.result.applied_parameters], [filterCopy.id, false, 4]);
assert.equal((await valuesOf(filterCopy.id)).Frequency, 99);
// ...a Simpler with its sample, into an empty pad...
const pad3 = await call("rack_insert_chain", { rack_device_id: kitRack, index: 2 });
loaded = await call("device_preset_load", { name: "kick 1", target_id: pad3.id });
assert.deepEqual([loaded.name, loaded.sample], ["Simpler", { file_path: "/tmp/kick.wav" }]);
assert.equal((await valuesOf(loaded.id)).Volume, 0.4);
// a failing sample load onto an existing Simpler changes nothing
fixtures.refuseSamples(true);
const loadFail = await client.callTool({ name: "device_preset_load", arguments: { name: "Kick 1", device_id: snare.id } });
fixtures.refuseSamples(false);
assert.equal(loadFail.isError, true);
assert.match(loadFail.content[0].text, /Could not load the sample \/tmp\/kick\.wav: .*Nothing was changed/);
assert.equal((await valuesOf(snare.id)).Volume, 0.7);
// ...or onto another kind of device: same names only, with a warning
loaded = await call("device_preset_load", { name: "Kick 1", device_id: compId });
assert.match(loaded.warning, /saved from "Simpler"/);
assert.deepEqual(loaded.not_applied.map((x) => x.name), ["sample", "Volume", "Transpose"]);
// names are one safe file name: no traversal, no hidden or reserved names
for (const bad of ["../evil", "a/b", "..", ".hidden", "CON", "x\\y", "a:b", "", "   ", "trailing.", "x".repeat(65), "tab\there"])
  await usageError("device_preset_save", { name: bad, device_id: filterId }, /Invalid preset name|1-64 characters/);
assert.deepEqual(fs.readdirSync(presetDir).sort(), ["Bright Filter.json", "Kick 1.json"]);
// letters with combining marks (NFC) are fine
saved = await call("device_preset_save", { name: "Re\u0301sonance Ü", device_id: filterId });
assert.equal(saved.name, "Résonance Ü");
fs.rmSync(path.join(presetDir, "Résonance Ü.json"));
assert.ok(!fs.existsSync(path.join(storageDir, "evil.json")) && !fs.existsSync(path.join(path.dirname(storageDir), "evil.json")));
await usageError("device_preset_load", { name: "../Bright Filter", device_id: filterCopy.id }, /Invalid preset name/);
await usageError("device_preset_load", { name: "Nope", device_id: filterCopy.id },
  /No preset named "Nope"\. Saved presets: "Bright Filter", "Kick 1"/);
await usageError("device_preset_save", { name: "Kit", device_id: kitRack }, /is a rack/);
await usageError("device_preset_load", { name: "Bright Filter", device_id: filterCopy.id, index: 0 }, /only apply when inserting/);
await usageError("device_preset_load", { name: "Bright Filter", device_id: filterCopy.id, target_id: kit.id }, /not both/);
await usageError("device_preset_load", { name: "Bright Filter" }, /Give the device to load onto/);
// a broken file is listed, not fatal; a symlink is never followed
fs.writeFileSync(path.join(presetDir, "Broken.json"), "{nope");
fs.symlinkSync(path.join(storageDir, "config.json"), path.join(presetDir, "Link.json"));
plist = await call("device_preset_list");
assert.deepEqual([plist.presets.length, plist.unreadable.map((u) => u.file)], [2, ["Broken.json"]]);
await usageError("device_preset_load", { name: "broken", device_id: filterCopy.id },
  /Preset "Broken" cannot be loaded: .*Broken\.json is not valid JSON/);
await usageError("device_preset_load", { name: "Link", device_id: filterCopy.id }, /No preset named "Link"/);
fs.rmSync(path.join(presetDir, "Broken.json"));
fs.rmSync(path.join(presetDir, "Link.json"));

for (const id of [filterCopy.id, eqCopy.id, drumsFilter]) await call("device_delete", { device_id: id });
for (const id of [synth.id, kit.id]) await call("track_delete", { track_id: id });
assert.equal((await tracksNow()).length, 2);

// MIDI write shortcuts: note names, step patterns ("X" = accent) and repeat
const notesTrack = await call("track_create", { type: "midi", name: "Notes" });
const notesOf = async (clip_id) => (await call("midi_clip_get_notes", { clip_id })).notes;
const startsOf = (notes, pitch) => notes.filter((n) => n.pitch === pitch).map((n) => n.start_time);
const beat = await call("clip_create", {
  type: "midi", track_name: "Notes", scene_index: 0, duration: 8,
  notes: [{ pitch: "C3", start_time: 0, duration: 4 }],
  patterns: [
    { note: "C1", steps: "x... x... | x... x..." },
    { note: "F#1", steps: "xX", step: 0.5, velocity: 80, accent_velocity: 120, duration: 0.1 },
  ],
  repeat: { length: 4 },
});
assert.equal(beat.note_count, 14, "7 notes per bar, repeated to fill the 8 beats");
let beatNotes = await notesOf(beat.id);
assert.deepEqual(startsOf(beatNotes, 60), [0, 4]);
assert.deepEqual(startsOf(beatNotes, 36), [0, 1, 2, 3, 4, 5, 6, 7]);
assert.deepEqual(beatNotes.find((n) => n.pitch === 36), { pitch: 36, start_time: 0, duration: 0.25, velocity: 100 },
  "a hit lasts one step by default");
assert.deepEqual(beatNotes.filter((n) => n.pitch === 42).map((n) => [n.start_time, n.velocity, n.duration]),
  [[0, 80, 0.1], [0.5, 120, 0.1], [4, 80, 0.1], [4.5, 120, 0.1]]);
// filling drops the notes of the last copy that would start at or after the clip's end
let written = await call("midi_clip_set_notes", { clip_id: beat.id, notes: [
  { pitch: "A2", start_time: 0, duration: 0.5 }, { pitch: 57, start_time: 2.5, duration: 0.5 },
], repeat: { length: 3 } });
assert.deepEqual([written.note_count, written.copies], [5, 3]);
assert.deepEqual(startsOf(await notesOf(beat.id), 57), [0, 2.5, 3, 5.5, 6]);
// `times` writes that many copies, also past the end; merge keeps what is there
written = await call("midi_clip_set_notes", {
  clip_id: beat.id, mode: "merge", patterns: [{ note: 38, steps: "x" }], repeat: { length: 4, times: 3 },
});
assert.deepEqual([written.added, written.copies, written.note_count], [3, 3, undefined]);
assert.deepEqual(startsOf(await notesOf(beat.id), 38), [0, 4, 8]);
// bad names, steps and shortcuts fail before anything is written
await usageError("midi_clip_set_notes", { clip_id: beat.id, patterns: [{ note: "C1", steps: "x.o." }] },
  /patterns\[0\]\.steps: unexpected "o"/);
await usageError("midi_clip_set_notes", { clip_id: beat.id, notes: [
  { pitch: 36, start_time: 0, duration: 1 }, { pitch: "H2", start_time: 0, duration: 1 },
] }, /notes\[1\]\.pitch: "H2" is not a MIDI pitch/);
await usageError("midi_clip_set_notes", { clip_id: beat.id, notes: [{ pitch: "G#8", start_time: 0, duration: 1 }] },
  /outside the MIDI range \(C-2 = 0 to G8 = 127\)/);
await usageError("midi_clip_set_notes", { clip_id: beat.id }, /Give notes and\/or patterns/);
await usageError("midi_clip_set_notes", { clip_id: beat.id, notes: [], repeat: { length: 1 } }, /repeat needs notes or patterns/);
await usageError("midi_clip_set_notes", { clip_id: beat.id, patterns: [{ note: 36, steps: "x" }], repeat: { length: 0.0001 } },
  /would write \d+ notes; at most 50000/);
assert.equal((await notesOf(beat.id)).length, 8, "failed writes change nothing");
await usageError("clip_create", { type: "midi", track_name: "Notes", scene_index: 1, duration: 4,
  patterns: [{ note: "Q1", steps: "x" }] }, /patterns\[0\]\.note: "Q1" is not a MIDI pitch/);
assert.equal((await slotsOf(notesTrack.id))[1].clip, null, "a bad pattern creates no clip");
await usageError("clip_create", { type: "audio", track_id: audioTrackId, start_time: 0, file_path: "/tmp/kick.wav",
  patterns: [{ note: 36, steps: "x" }], repeat: { length: 4 } }, /patterns, repeat only apply to MIDI clips/);

// reads: select (pitches by name too), compact tuples
const CHORDS = [
  { pitch: "C3", start_time: 0, duration: 1, velocity: 100 },
  { pitch: "E3", start_time: 0, duration: 1, velocity: 100 },
  { pitch: "F#3", start_time: 1, duration: 0.5, velocity: 100 },
  { pitch: "Bb3", start_time: 2, duration: 0.5, velocity: 100, probability: 0.5 },
  { pitch: "D#3", start_time: 3, duration: 0.25, velocity: 100 },
];
const chords = await call("clip_create", { type: "midi", track_name: "Notes", scene_index: 1, duration: 4, notes: CHORDS });
const resetChords = () => call("midi_clip_set_notes", { clip_id: chords.id, notes: CHORDS });
const chordPitches = async () => (await notesOf(chords.id)).map((n) => n.pitch);
assert.deepEqual(await chordPitches(), [60, 64, 66, 70, 63]);
let compact = await call("midi_clip_get_notes", { clip_id: chords.id, format: "compact" });
assert.deepEqual([compact.note_count, compact.total_note_count, compact.fields],
  [5, undefined, ["pitch", "start_time", "duration", "velocity"]]);
assert.deepEqual(compact.defaults, { muted: false, probability: 1, velocity_deviation: 0, release_velocity: 64, selected: false });
assert.deepEqual(compact.notes,
  [[60, 0, 1, 100], [64, 0, 1, 100], [66, 1, 0.5, 100], [70, 2, 0.5, 100, { probability: 0.5 }], [63, 3, 0.25, 100]]);
const outOfKey = await call("midi_clip_get_notes", { clip_id: chords.id, select: { in_scale: false }, format: "compact" });
assert.deepEqual([outOfKey.notes.map((n) => n[0]), outOfKey.note_count, outOfKey.total_note_count], [[66, 70, 63], 3, 5]);
assert.deepEqual(outOfKey.scale, { root_note: 0, intervals: [0, 2, 4, 5, 7, 9, 11], name: "Major" });
const pick = async (select) => (await call("midi_clip_get_notes", { clip_id: chords.id, select })).notes.map((n) => n.pitch);
assert.deepEqual(await pick({ pitch_min: "E3", pitch_max: "F#3", time_max: 1 }), [64, 66]);
// every_nth counts the matching notes in time order (start, then pitch)
assert.deepEqual(await pick({ every_nth: 2 }), [60, 66, 63]);
assert.deepEqual(await pick({ every_nth: { n: 2, offset: 1 } }), [64, 70]);
assert.deepEqual(await pick({ every_nth: 2, pitch_min: 64 }), [64, 70]);

// the user's note selection (NoteDescription.selected), when the host reports it
let picked = await call("midi_clip_get_notes", { clip_id: chords.id, only_selected: true });
assert.deepEqual([picked.note_count, picked.total_note_count], [0, 5]);
assert.match(picked.warning, /reported no selection state/);
fixtures.selectNotes(chords.id, [66, 70]);
picked = await call("midi_clip_get_notes", { clip_id: chords.id, only_selected: true });
assert.deepEqual([picked.notes.map((n) => n.pitch), picked.warning], [[66, 70], undefined]);
assert.deepEqual((await notesOf(chords.id)).map((n) => n.selected), [false, false, true, true, false]);
// compact defaults are this result's most common values
picked = await call("midi_clip_get_notes", { clip_id: chords.id, select: { only_selected: true, pitch_min: 70 }, format: "compact" });
assert.deepEqual([picked.notes, picked.defaults.selected, picked.defaults.probability], [[[70, 2, 0.5, 100]], true, 0.5]);
let edit = await call("midi_clip_edit_notes", { clip_id: chords.id, select: { only_selected: true }, transpose: 12 });
assert.deepEqual([edit.changed_count, edit.warning], [2, undefined]);
assert.deepEqual(await chordPitches(), [60, 64, 78, 82, 63]);
fixtures.selectNotes(chords.id, []);
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, select: { only_selected: true }, transpose: 12 });
assert.deepEqual([edit.changed_count, edit.warning], [0, "No note of this clip is selected in Live."]);
fixtures.selectNotes(chords.id, null);

// snap_to_scale: the nearest scale note, ties go down (every C major neighbour here is a tie)
await resetChords();
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, snap_to_scale: "song" });
assert.deepEqual([edit.changed_count, edit.scale.name], [5, "Major"]);
assert.deepEqual(await chordPitches(), [60, 64, 65, 69, 62]);
// a custom scale: root by name, intervals folded into one octave
await resetChords();
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, snap_to_scale: { root: "D", intervals: [7, 12] } });
assert.deepEqual(edit.scale, { root_note: 2, intervals: [0, 7] });
assert.deepEqual(await chordPitches(), [62, 62, 69, 69, 62]);
await resetChords();
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, select: { in_scale: false },
  snap_to_scale: { root: 2, intervals: [0, 2, 4, 5, 7, 9, 11, 12] } });
assert.deepEqual([edit.changed_count, await chordPitches()], [3, [59, 64, 66, 69, 62]]);
await usageError("midi_clip_edit_notes", { clip_id: chords.id, snap_to_scale: { root: "H", intervals: [0] } },
  /snap_to_scale\.root: "H" is not a note/);
// "song" follows Live's current scale: E major
await resetChords();
fixtures.setScale({ root: 4, name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] });
assert.deepEqual(await pick({ in_scale: false }), [60, 70]);
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, select: { in_scale: false }, snap_to_scale: "song" });
assert.deepEqual([edit.changed_count, edit.scale.root_note, await chordPitches()], [2, 4, [59, 64, 66, 69, 63]]);
fixtures.setScale({ root: 0, name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] });

// set: fields on the selected notes
await resetChords();
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, select: { every_nth: 2 },
  set: { velocity: 64, muted: true, probability: 0.25, velocity_deviation: 10, release_velocity: 30 } });
assert.equal(edit.changed_count, 3);
assert.deepEqual((await notesOf(chords.id))[0], { pitch: 60, start_time: 0, duration: 1, velocity: 64, muted: true,
  probability: 0.25, velocity_deviation: 10, release_velocity: 30 });
compact = await call("midi_clip_get_notes", { clip_id: chords.id, format: "compact" });
assert.deepEqual(compact.defaults, { muted: true, probability: 0.25, velocity_deviation: 10, release_velocity: 30, selected: false });
const unset = { muted: false, velocity_deviation: 0, release_velocity: 64 };
assert.deepEqual(compact.notes, [[60, 0, 1, 64], [64, 0, 1, 100, { ...unset, probability: 1 }], [66, 1, 0.5, 64],
  [70, 2, 0.5, 100, { ...unset, probability: 0.5 }], [63, 3, 0.25, 64]]);

// durations: scale or set, then legato
await resetChords();
await call("midi_clip_edit_notes", { clip_id: chords.id, select: { pitch_max: "E3" }, duration_scale: 0.5 });
assert.deepEqual((await notesOf(chords.id)).map((n) => n.duration), [0.5, 0.5, 0.5, 0.5, 0.125]);
await call("midi_clip_edit_notes", { clip_id: chords.id, select: { time_min: 3 }, duration_set: 2 });
assert.deepEqual((await notesOf(chords.id)).map((n) => n.duration), [0.5, 0.5, 0.5, 0.5, 2]);
await usageError("midi_clip_edit_notes", { clip_id: chords.id, duration_set: 1, duration_scale: 2 }, /not both/);
// legato: a chord (starts < 1/64 beat apart) ends together at the next start; the last keeps its length
await resetChords();
await call("midi_clip_set_notes", { clip_id: chords.id, mode: "merge", notes: [{ pitch: "G3", start_time: 0.01, duration: 0.1 }] });
await call("midi_clip_edit_notes", { clip_id: chords.id, legato: true });
assert.deepEqual((await notesOf(chords.id)).map((n) => [n.pitch, n.duration]),
  [[60, 1], [64, 1], [66, 1], [70, 1], [63, 0.25], [67, 0.99]]);

// humanize: seeded, so a call can be repeated exactly; the seed used is returned
await resetChords();
const human = { clip_id: chords.id, humanize: { timing: 0.05, velocity: 10, seed: 7 } };
edit = await call("midi_clip_edit_notes", human);
assert.equal(edit.humanize_seed, 7);
const humanized = await notesOf(chords.id);
for (const [i, n] of humanized.entries()) {
  assert.ok(n.start_time >= 0 && Math.abs(n.start_time - CHORDS[i].start_time) <= 0.05, `start ${n.start_time}`);
  assert.ok(Number.isInteger(n.velocity) && Math.abs(n.velocity - 100) <= 10, `velocity ${n.velocity}`);
}
assert.ok(humanized.some((n, i) => n.start_time !== CHORDS[i].start_time), "timing moved");
await resetChords();
await call("midi_clip_edit_notes", human);
assert.deepEqual(await notesOf(chords.id), humanized, "the same seed humanizes alike");
await resetChords();
edit = await call("midi_clip_edit_notes", { clip_id: chords.id, humanize: { velocity: 10 } });
assert.ok(Number.isInteger(edit.humanize_seed));
const unseeded = await notesOf(chords.id);
await resetChords();
await call("midi_clip_edit_notes", { clip_id: chords.id, humanize: { velocity: 10, seed: edit.humanize_seed } });
assert.deepEqual(await notesOf(chords.id), unseeded, "the returned seed reproduces the call");
await usageError("midi_clip_edit_notes", { clip_id: chords.id, humanize: { seed: 1 } }, /humanize: give timing and\/or velocity/);

// swing: every second grid step moves amount × grid/2 later, positions in between proportionally
const groove = await call("clip_create", { type: "midi", track_name: "Notes", start_time: 0, duration: 4,
  notes: [{ pitch: 42, start_time: 0.125, duration: 0.1 }], patterns: [{ note: 42, steps: "xxxx", duration: 0.1 }] });
await call("midi_clip_edit_notes", { clip_id: groove.id, swing: { amount: 1 } });
assert.deepEqual(startsOf(await notesOf(groove.id), 42), [0.1875, 0, 0.375, 0.5, 0.875]);
// grid "song": Live's grid setting (Quarter in the mock = 1 beat)
edit = await call("midi_clip_edit_notes", { clip_id: groove.id, quantize: { grid: "song" } });
assert.deepEqual(edit.song_grid, { beats: 1, quantization: "Quarter", is_triplet: false });
assert.deepEqual(startsOf(await notesOf(groove.id), 42), [0, 0, 0, 1, 1]);
fixtures.setGrid(8, true); // 1/16 triplets: 1/6 beat
await call("midi_clip_set_notes", { clip_id: groove.id, notes: [{ pitch: 42, start_time: 0.2, duration: 0.1 }] });
edit = await call("midi_clip_edit_notes", { clip_id: groove.id, quantize: { grid: "song" } });
assert.deepEqual([edit.song_grid.quantization, edit.song_grid.is_triplet], ["Sixteenth", true]);
assert.ok(Math.abs(edit.song_grid.beats - 1 / 6) < 1e-12);
assert.ok(Math.abs((await notesOf(groove.id))[0].start_time - 1 / 6) < 1e-12);
fixtures.setGrid(4); // Bar: the first scene's time signature, 4/4
await call("midi_clip_set_notes", { clip_id: groove.id, notes: [{ pitch: 42, start_time: 2.5, duration: 0.1 }] });
edit = await call("midi_clip_edit_notes", { clip_id: groove.id, quantize: { grid: "song" } });
assert.deepEqual([edit.song_grid.beats, (await notesOf(groove.id))[0].start_time], [4, 4]);
fixtures.setGrid(0); // No Grid
await usageError("midi_clip_edit_notes", { clip_id: groove.id, swing: { amount: 0.5, grid: "song" } },
  /Live's grid is off: give the grid in beats/);
fixtures.setGrid(6);

// clip_ids: several clips alike, one notes write each, all one undo step
await resetChords();
const multi = await undoSteps(() => call("midi_clip_edit_notes", { clip_ids: [chords.id, groove.id], transpose: 1 }));
assert.equal(multi.steps, 1);
assert.deepEqual(multi.result.items.map((it) => [it.clip_id, it.note_count, it.changed_count]),
  [[chords.id, 5, 5], [groove.id, 1, 1]]);
assert.deepEqual(await chordPitches(), [61, 65, 67, 71, 64]);
// every clip is checked before the first write
await usageError("midi_clip_edit_notes", { clip_ids: [chords.id, notesTrack.id], transpose: 1 },
  /clip_ids\[1\]: Object "\d+" is a MidiTrack, expected MidiClip/);
await usageError("midi_clip_edit_notes", { clip_ids: [chords.id, chords.id], transpose: 1 }, /clip_ids\[1\]: clip \d+ is listed twice/);
await usageError("midi_clip_edit_notes", { clip_id: chords.id, clip_ids: [beat.id], transpose: 1 }, /Give clip_id or clip_ids/);
await usageError("midi_clip_edit_notes", { transpose: 1 }, /Give clip_id or clip_ids/);
await usageError("midi_clip_edit_notes", { clip_ids: [beat.id], select: { pitch_min: "Z" }, transpose: 1 },
  /select\.pitch_min: "Z" is not a MIDI pitch/);
assert.deepEqual(await chordPitches(), [61, 65, 67, 71, 64], "failed edits change nothing");
assert.equal((await notesOf(beat.id)).length, 8);
// nothing selected: nothing written, no undo step
const untouched = await undoSteps(() => call("midi_clip_edit_notes", {
  clip_id: chords.id, select: { pitch_min: "C-2", pitch_max: 1 }, transpose: 1 }));
assert.deepEqual([untouched.steps, untouched.result.changed_count, untouched.result.note_count], [0, 0, 5]);
await call("track_delete", { track_id: notesTrack.id });
assert.equal((await tracksNow()).length, 2);

// --- whole-set reads: song_get hierarchy and deep sections --------------------
const SELECT_TITLE = "MCP: Use as selection";
const presentWav = path.join(storageDir, "present.wav");
const missingWav = path.join(storageDir, "missing.wav");
fs.writeFileSync(presentWav, "RIFF");
const busId = fixtures.addTrack({ kind: "group", name: "Bus" });
const synthIn = fixtures.addTrack({ kind: "midi", name: "Lead Synth", group: busId });
const subId = fixtures.addTrack({ kind: "group", name: "Sub", group: busId });
const voxId = fixtures.addTrack({ kind: "audio", name: "Vox", group: subId });
song = await call("song_get");
let rowOf = (id) => song.tracks.find((t) => t.id === id);
assert.deepEqual(song.tracks.map((t) => t.index), [0, 1, 2, 3, 4, 5]);
assert.deepEqual([rowOf(busId).type, rowOf(busId).depth, rowOf(busId).child_track_ids], ["group", 0, [synthIn, subId]]);
assert.deepEqual([rowOf(subId).type, rowOf(subId).depth, rowOf(subId).child_track_ids], ["group", 1, [voxId]]);
assert.deepEqual([rowOf(voxId).type, rowOf(voxId).depth, rowOf(voxId).child_track_ids, rowOf(voxId).group_track_id],
  ["audio", 2, undefined, subId]);
assert.deepEqual([rowOf(midiTrackId).depth, rowOf(midiTrackId).child_track_ids], [0, undefined]);
assert.deepEqual(song.return_tracks.map((t) => [t.name, t.type, t.send_index, t.index]), [["A-Reverb", "return", 0, undefined]]);
assert.equal(song.main_track.type, "main");
assert.equal(song.environment.server_version, JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/health`)).text())).version);
assert.ok(!("devices" in rowOf(midiTrackId)) && !("mixer" in rowOf(midiTrackId)) && !song.truncated, "deep sections are opt-in");
// group tracks are "group" everywhere; return tracks keep "other" outside song_get
assert.equal((await call("track_get", { track_id: subId, include: [] })).type, "group");
assert.equal((await call("track_set", { items: [{ track_id: busId, mute: false }] })).items[0].type, "group");

// a kit: pad C1 with a Simpler, an empty pad D1, a Reverb switched off; and a return device
const kitT = await call("track_create", { type: "midi", name: "Kit 2", devices: ["Drum Rack", "Reverb"] });
const [rackK, reverbK] = kitT.devices.map((d) => d.id);
const padK = await call("rack_insert_chain", { rack_device_id: rackK, index: 0 });
await call("drum_chain_set", { drum_chain_id: padK.id, receiving_note: "C1" });
const kickK = await call("device_insert", { target_id: padK.id, device_name: "Simpler" });
const kickSample = await call("simpler_replace_sample", { simpler_device_id: kickK.id, file_path: presentWav, import_into_project: false });
const emptyPad = await call("rack_insert_chain", { rack_device_id: rackK, index: 1 });
await call("drum_chain_set", { drum_chain_id: emptyPad.id, receiving_note: "D1" });
await call("device_set", { device_id: reverbK, enabled: false });
const returnFx = await call("device_insert", { track_name: "A-Reverb", device_name: "Reverb" });
const hook = await call("clip_create", { type: "midi", track_id: synthIn, scene_index: 1, duration: 4, name: "Hook" });

let deep = await call("song_get", { include: ["devices", "mixer", "clips"] });
rowOf = (id) => deep.tracks.find((t) => t.id === id);
assert.ok(deep.tracks && !deep.scenes && !deep.cue_points && !deep.environment, "deep sections imply tracks only");
assert.equal(deep.truncated, undefined);
const kitTree = rowOf(kitT.id).devices;
assert.deepEqual(kitTree.map((d) => [d.id, d.name, d.enabled]), [[rackK, "Drum Rack", true], [reverbK, "Reverb", false]]);
assert.equal(kitTree[0].chain_ids, undefined, "chains carry the chain ids");
assert.deepEqual(kitTree[0].chains.map((c) => [c.id, c.receiving_note_name, c.devices.map((d) => [d.id, d.enabled, d.sample?.file_path])]),
  [[padK.id, "C1", [[kickK.id, true, presentWav]]], [emptyPad.id, "D1", []]]);
assert.equal(rowOf(midiTrackId).devices[0].enabled, undefined, "a device without an on/off switch has no enabled");
assert.deepEqual(deep.return_tracks[0].devices.map((d) => [d.id, d.enabled]), [[returnFx.id, true]]);
// mixer values with return names, as mixer_get reads them
const drumsMixer = await call("mixer_get", { track_id: audioTrackId });
assert.deepEqual(rowOf(audioTrackId).mixer, {
  id: drumsMixer.id, volume: drumsMixer.volume.value, panning: drumsMixer.panning.value,
  sends: [{ index: 0, return_track: "A-Reverb", value: drumsMixer.sends[0].value }],
});
assert.deepEqual(deep.main_track.mixer.sends, []);
// clips: session (with scene_index) and arrangement (with position), in brief
const bassClips = rowOf(midiTrackId).clips;
assert.deepEqual(bassClips.session.map((c) => [c.scene_index, c.id, c.name]), [[0, clipId, "Bassline"]]);
assert.equal(bassClips.session[0].slot_id, (await slotsOf(midiTrackId))[0].id);
assert.deepEqual(bassClips.arrangement.map((c) => [c.id, c.start_time, c.end_time, c.duration]), [[arrClip.id, 16, 20, 4]]);
assert.equal(bassClips.arrangement[0].loop_start, undefined, "brief entries: clip_get has the detail");
assert.deepEqual(rowOf(synthIn).clips, { session: [{ scene_index: 1, slot_id: (await slotsOf(synthIn))[1].id,
  id: hook.id, class: "MidiClip", name: "Hook", duration: 4, muted: false, looping: true }], arrangement: [] });
assert.equal(deep.return_tracks[0].clips, undefined, "return tracks have no clips");
deep = await call("song_get", { include: ["mixer"] });
assert.ok(deep.tracks.every((t) => t.mixer && !t.devices && !t.clips));
// payload caps: a track that does not fit, and the tracks after it, lack the section
const big = fixtures.addTrack({ kind: "midi", name: "Big" });
fixtures.addDevices(big, 520);
fixtures.addClips(big, 520);
deep = await call("song_get", { include: ["devices", "clips"] });
rowOf = (id) => deep.tracks.find((t) => t.id === id);
assert.match(deep.truncated.devices, /^Only 500 devices are listed: "Big" \(track_index 7, id \d+\) and the tracks after it/);
assert.match(deep.truncated.clips, /^Only 500 clips are listed: "Big"/);
assert.ok(rowOf(kitT.id).devices && !rowOf(big).devices && !deep.return_tracks[0].devices && !deep.main_track.devices);
assert.ok(rowOf(kitT.id).clips && !rowOf(big).clips);

// --- scene_get, session_grid, arrangement_get --------------------------------
let scenes = await scenesNow();
let row = await call("scene_get", { scene_name: "verse" });
assert.deepEqual([row.id, row.index, row.name, row.clip_count, row.slots.length], [scenes[0].id, 0, "Verse", 1, 8]);
assert.deepEqual(row.slots[0], { track_index: 0, track_id: midiTrackId, track_name: "Bass 2", track_type: "midi",
  slot_id: (await slotsOf(midiTrackId))[0].id, clip: (await slotsOf(midiTrackId))[0].clip });
assert.deepEqual(row.slots.map((x) => x.track_type), ["midi", "audio", "group", "midi", "group", "audio", "midi", "midi"]);
row = await call("scene_get", { scene_index: 1, only_clips: true });
assert.deepEqual([row.name, row.clip_count, row.slots.map((x) => [x.track_id, x.clip.id])], ["Chorus", 1, [[synthIn, hook.id]]]);
await usageError("scene_get", { scene_index: 9 }, /scene_index 9 out of range \(0-1\)/);

let grid = await call("session_grid");
assert.deepEqual(grid.scenes, scenes.map((x) => ({ index: x.index, id: x.id, name: x.name })));
assert.equal(grid.tracks.length, 8);
const gridRow = (id) => grid.tracks.find((t) => t.id === id);
assert.deepEqual(gridRow(midiTrackId).cells.map((c) => c?.name ?? null), ["Bassline", null]);
assert.deepEqual(Object.keys(gridRow(midiTrackId).cells[0]).sort(), ["class", "duration", "id", "looping", "muted", "name"]);
assert.deepEqual([gridRow(synthIn).index, gridRow(synthIn).type, gridRow(synthIn).group_track_id, gridRow(synthIn).cells.map((c) => c?.id ?? null)],
  [3, "midi", busId, [null, hook.id]]);
assert.deepEqual([gridRow(busId).type, gridRow(busId).group_track_id], ["group", null]);
assert.equal(grid.clip_count, 2);
grid = await call("session_grid", { tracks: [{ track_name: "Lead Synth" }, { track_index: 0 }, { track_id: synthIn }], scene_index_min: 1 });
assert.deepEqual([grid.scenes.map((x) => x.index), grid.tracks.map((t) => [t.id, t.cells.length]), grid.clip_count],
  [[1], [[synthIn, 1], [midiTrackId, 1]], 1], "tracks in the given order, each once");
assert.equal((await call("session_grid", { scene_index_max: 99 })).scenes.length, 2, "scene_index_max is capped");
await usageError("session_grid", { scene_index_min: 1, scene_index_max: 0 }, /scene_index_max 0 is before scene_index_min 1/);
await usageError("session_grid", { scene_index_min: 5 }, /scene_index_min 5 out of range \(0-1\)/);
await usageError("session_grid", { tracks: [{ track_index: 0 }, { track_name: "nope" }] }, /tracks\[1\]: No track named "nope"/);
fixtures.addScenes(1300);
await usageError("session_grid", {}, /8 tracks × 1302 scenes = 10416 cells, at most 10000/);
assert.equal((await call("session_grid", { scene_index_max: 9 })).scenes.length, 10);
fixtures.removeScenes(2);
assert.equal((await scenesNow()).length, 2);
await call("track_delete", { track_id: big });

const drop = await call("cue_point_create", { time: 16, name: "Drop" });
const takeClip = await call("clip_create", { type: "midi", target_id: lane.id, start_time: 18, duration: 4, name: "Take clip" });
const drumsArr = (await call("track_get", { track_id: audioTrackId, include: ["arrangement_clips"] })).arrangement_clips;
const songEnd = Math.max(20, ...drumsArr.map((c) => c.end_time));
let arr = await call("arrangement_get", { start_time: 14, end_time: 33 });
assert.deepEqual([arr.start_time, arr.end_time, arr.song_end], [14, 33, songEnd]);
assert.deepEqual(arr.cue_points.map((c) => [c.id, c.name, c.time]), [[drop.id, "Drop", 16]]);
const arrRow = (id) => arr.tracks.find((t) => t.id === id);
assert.deepEqual(arr.tracks.map((t) => t.id), (await tracksNow()).map((t) => t.id));
assert.deepEqual(arrRow(midiTrackId).clips, [(await call("track_get", { track_id: midiTrackId, include: ["arrangement_clips"] })).arrangement_clips[0]]);
assert.deepEqual(arrRow(audioTrackId).clips.map((c) => c.id), drumsArr.filter((c) => c.start_time < 33 && c.end_time > 14).map((c) => c.id));
assert.deepEqual([arrRow(midiTrackId).take_lanes, arrRow(busId).clips, arr.clip_count],
  [undefined, [], drumsArr.filter((c) => c.start_time < 33 && c.end_time > 14).length + 1]);
// take lanes on request; tracks by name; a clip ending at start_time does not overlap
arr = await call("arrangement_get", { start_time: 4, end_time: 18.5, tracks: [{ track_name: "bass 2" }, { track_id: audioTrackId }], include_take_lanes: true });
assert.deepEqual(arr.tracks.map((t) => t.name), ["Bass 2", "Drums"]);
assert.deepEqual(arr.tracks[0].clips.map((c) => c.id), [arrClip.id]);
assert.deepEqual(arr.tracks[0].take_lanes.map((l) => [l.id, l.index, l.clips.map((c) => c.id)]),
  [[lane.id, 0, [takeClip.id]], [laneByName.id, 1, []]]);
assert.deepEqual(arr.tracks[1].clips.map((c) => c.start_time), drumsArr.filter((c) => c.start_time < 18.5 && c.end_time > 4).map((c) => c.start_time));
// default range: from 0 to the song's end, every cue point
arr = await call("arrangement_get");
assert.deepEqual([arr.start_time, arr.end_time], [0, songEnd]);
assert.deepEqual(arr.cue_points.map((c) => c.name), ["Start", "Drop"]);
await usageError("arrangement_get", { start_time: 8, end_time: 8 }, /end_time 8 must be after start_time 8/);
await usageError("arrangement_get", { tracks: [{ track_name: "nope" }] }, /tracks\[0\]: No track named "nope"/);
const many = fixtures.addTrack({ kind: "midi", name: "Many" });
fixtures.addClips(many, 520);
await tracksNow(); // discover the fixture id, like any client would
arr = await call("arrangement_get", { tracks: [{ track_id: many }] });
assert.deepEqual([arr.tracks[0].clips.length, arr.clip_count], [500, 520]);
assert.match(arr.truncated, /Only the first 500 of 520 clips are listed/);
await call("track_delete", { track_id: many });

// locations in clip_get, device_get, chain_get
const bassRef = { track_id: midiTrackId, track_name: "Bass 2", track_index: 0, track_type: "midi" };
assert.deepEqual((await call("clip_get", { clip_id: clipId })).location, { view: "session", ...bassRef,
  scene_index: 0, scene_id: scenes[0].id, scene_name: "Verse", clip_slot_id: (await slotsOf(midiTrackId))[0].id });
assert.deepEqual((await call("clip_get", { clip_id: arrClip.id })).location, { view: "arrangement", ...bassRef });
assert.deepEqual((await call("clip_get", { clip_id: takeClip.id })).location,
  { view: "take_lane", ...bassRef, take_lane_id: lane.id, take_lane_name: "Take 1", take_lane_index: 0 });
const kitRef = { track_id: kitT.id, track_name: "Kit 2", track_index: 6, track_type: "midi" };
assert.deepEqual((await call("device_get", { device_id: kickK.id })).location, { ...kitRef,
  path: "Kit 2 > Drum Rack > pad 36 > Simpler", device_index: 0, chain_id: padK.id, rack_device_id: rackK });
assert.deepEqual((await call("device_get", { device_id: reverbK })).location, { ...kitRef, path: "Kit 2 > Reverb", device_index: 1 });
assert.deepEqual((await call("device_get", { device_id: returnFx.id })).location,
  { track_id: song.return_tracks[0].id, track_name: "A-Reverb", track_type: "return", path: "A-Reverb > Reverb", device_index: 0 });
assert.deepEqual((await call("chain_get", { chain_id: emptyPad.id })).location,
  { ...kitRef, path: "Kit 2 > Drum Rack > pad 38", rack_device_id: rackK, chain_index: 1 });

// --- the user's selection, handed over through context menus -----------------
const selectMenus = calls.menus.filter((m) => m.title === SELECT_TITLE);
assert.deepEqual(selectMenus.map((m) => m.scope).sort(), ["AudioClip", "AudioTrack", "AudioTrack.ArrangementSelection",
  "ClipSlot", "ClipSlotSelection", "DrumRack", "MidiClip", "MidiTrack", "MidiTrack.ArrangementSelection", "Sample",
  "Scene", "Simpler"]);
assert.ok(selectMenus.every((m) => m.commandId === `ableton-live-mcp.select.${m.scope}`));
let sel = await call("selection_get");
assert.deepEqual([sel.captured, sel.seq], [false, 0]);
assert.match(sel.hint, /"MCP: Use as selection"/);

// a clicked clip: id, summary and location
fixtures.contextMenu("MidiClip", clipId);
sel = await call("selection_get");
assert.deepEqual([sel.captured, sel.seq, sel.scope, sel.kind, sel.items.length], [true, 1, "MidiClip", "object", 1]);
assert.ok(sel.age_s >= 0 && sel.age_s < 5 && Math.abs(Date.parse(sel.captured_at) - Date.now()) < 5000);
assert.deepEqual([sel.items[0].id, sel.items[0].class, sel.items[0].name], [clipId, "MidiClip", "Bassline"]);
assert.deepEqual(sel.items[0].location, (await call("clip_get", { clip_id: clipId })).location);
// a clip-slot selection: each slot with its clip; a handle Live cannot resolve is reported, not fatal
assert.equal((await slotsOf(midiTrackId))[1].id, emptySlotId);
fixtures.contextMenu("ClipSlotSelection", { slots: [(await slotsOf(synthIn))[1].id, emptySlotId, fixtures.bogusHandle()] });
sel = await call("selection_get");
assert.deepEqual([sel.seq, sel.kind, sel.items.length], [2, "clip_slots", 3]);
assert.deepEqual([sel.items[0].class, sel.items[0].clip.id, sel.items[0].location.track_id, sel.items[0].location.scene_name],
  ["ClipSlot", hook.id, synthIn, "Chorus"]);
assert.deepEqual([sel.items[1].id, sel.items[1].clip, sel.items[1].location.track_name, sel.items[1].location.scene_index],
  [emptySlotId, null, "Bass 2", 1]);
assert.match(sel.items[2].error, /^Live could not resolve the object: /);
// an arrangement time selection (here dragged right to left): the selected lanes with the clips overlapping it
fixtures.contextMenu("MidiTrack.ArrangementSelection", { start: 19, end: 15, lanes: [midiTrackId, lane.id] });
sel = await call("selection_get");
assert.deepEqual([sel.kind, sel.time_selection, sel.items], ["arrangement", { start_time: 15, end_time: 19, length: 4 }, undefined]);
assert.deepEqual(sel.lanes.map((l) => [l.id, l.class, l.name, l.clips.map((c) => c.id)]),
  [[midiTrackId, "MidiTrack", "Bass 2", [arrClip.id]], [lane.id, "TakeLane", "Take 1", [takeClip.id]]]);
assert.deepEqual(sel.lanes[1].location, (await call("clip_get", { clip_id: takeClip.id })).location);
fixtures.contextMenu("AudioTrack.ArrangementSelection", { start: 40, end: 40, lanes: [audioTrackId] });
sel = await call("selection_get");
assert.deepEqual(sel.lanes[0].clips, [], "no clip at beat 40");
// devices, samples, scenes, tracks
fixtures.contextMenu("Sample", kickSample.id);
sel = await call("selection_get");
assert.deepEqual(sel.items[0], { id: kickSample.id, class: "Sample", file_path: presentWav,
  location: { simpler_device_id: kickK.id, ...(await call("device_get", { device_id: kickK.id })).location } });
fixtures.contextMenu("Simpler", kickK.id);
sel = await call("selection_get");
assert.deepEqual([sel.scope, sel.items[0].id, sel.items[0].sample.file_path, sel.items[0].location.path],
  ["Simpler", kickK.id, presentWav, "Kit 2 > Drum Rack > pad 36 > Simpler"]);
fixtures.contextMenu("DrumRack", rackK);
sel = await call("selection_get");
assert.deepEqual([sel.items[0].is_drum_rack, sel.items[0].location], [true, { ...kitRef, path: "Kit 2 > Drum Rack", device_index: 0 }]);
fixtures.contextMenu("Scene", scenes[1].id);
sel = await call("selection_get");
assert.deepEqual(sel.items[0], { class: "Scene", ...scenes[1] });
fixtures.contextMenu("AudioTrack", audioTrackId);
sel = await call("selection_get");
assert.deepEqual([sel.items[0].class, sel.items[0].type, sel.items[0].location],
  ["AudioTrack", "audio", { track_id: audioTrackId, track_name: "Drums", track_index: 1, track_type: "audio" }]);
fixtures.contextMenu("AudioClip", audioClip.id);
sel = await call("selection_get");
assert.deepEqual(sel.items[0].location, { view: "arrangement", track_id: audioTrackId, track_name: "Drums", track_index: 1, track_type: "audio" });
fixtures.contextMenu("ClipSlot", emptySlotId);
assert.deepEqual((await call("selection_get")).items[0].location.clip_slot_id, emptySlotId);
// a captured id works in every tool; an object deleted since reports an error
const tempTrack = fixtures.addTrack({ kind: "audio", name: "Temp Sel" });
fixtures.contextMenu("AudioTrack", tempTrack);
assert.equal((await call("track_get", { track_id: tempTrack, include: [] })).name, "Temp Sel");
await call("track_delete", { track_id: tempTrack });
sel = await call("selection_get");
assert.deepEqual([sel.items[0].id, sel.items[0].class], [tempTrack, "AudioTrack"]);
assert.match(sel.items[0].error, /was it deleted or moved since it was captured\?/);
// arguments that are not what the API documents are reported; JSON cannot forge a handle
calls.commands["ableton-live-mcp.select.ClipSlotSelection"]({ nope: true });
sel = await call("selection_get");
assert.deepEqual([sel.items, sel.problems], [[], ["the argument has no selected_clip_slots list"]]);
calls.commands["ableton-live-mcp.select.MidiTrack.ArrangementSelection"]({ selected_lanes: [] });
sel = await call("selection_get");
assert.deepEqual([sel.time_selection, sel.problems], [undefined, ["the argument has no numeric time_selection_start / time_selection_end"]]);
await call("execute_command", { command_id: "ableton-live-mcp.select.MidiClip", args: [{ id: clipId }] });
sel = await call("selection_get");
assert.deepEqual(sel.items, [{ error: "Live passed an object without a bigint id where an object handle was expected" }]);

// selection_wait: wakes up on the next capture...
const seqNow = sel.seq;
const waiting = call("selection_wait", { after_seq: seqNow, timeout_s: 10 });
await new Promise((r) => setTimeout(r, 200));
fixtures.contextMenu("MidiTrack", midiTrackId);
sel = await waiting;
assert.deepEqual([sel.seq, sel.scope, sel.items[0].id], [seqNow + 1, "MidiTrack", midiTrackId]);
// ...returns at once for a capture newer than after_seq (one never handed out counts as the latest)...
assert.equal((await call("selection_wait", { after_seq: seqNow, timeout_s: 5 })).seq, seqNow + 1);
const futureWait = call("selection_wait", { after_seq: 999, timeout_s: 10 });
await new Promise((r) => setTimeout(r, 200));
calls.commands["ableton-live-mcp.select.Scene"]();
sel = await futureWait;
assert.deepEqual([sel.seq, sel.items], [seqNow + 2, [{ error: "Live passed nothing where an object handle was expected" }]]);
// ...and by default waits for a capture after the call, or times out
const waitStart = Date.now();
sel = await call("selection_wait", { timeout_s: 1 });
assert.deepEqual([sel.timed_out, sel.captured, sel.seq], [true, true, seqNow + 2]);
assert.ok(Date.now() - waitStart >= 900, "waited for the timeout");
await usageError("selection_wait", { timeout_s: 56 }, /Input validation error/);
// a client that goes away stops the wait (the request is aborted, nothing breaks)
const abort = new AbortController();
const abandoned = fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "POST", signal: abort.signal,
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "selection_wait", arguments: { timeout_s: 30 } } }),
}).catch((e) => e.name);
await new Promise((r) => setTimeout(r, 100));
abort.abort();
assert.equal(await abandoned, "AbortError");
assert.equal((await call("selection_get")).seq, seqNow + 2);

// --- song_audit ----------------------------------------------------------------
const snareK = await call("device_insert", { target_id: (await call("rack_insert_chain", { rack_device_id: rackK, index: 2 })).id, device_name: "Simpler" });
await call("simpler_replace_sample", { simpler_device_id: snareK.id, file_path: missingWav, import_into_project: false });
const emptySimpler = await call("device_insert", { track_id: synthIn, device_name: "Simpler" });
const relClip = await call("clip_create", { type: "audio", track_id: audioTrackId, start_time: 64, file_path: "relative.wav", import_into_project: false });
const okClip = await call("clip_create", { type: "audio", track_id: audioTrackId, start_time: 72, file_path: presentWav, import_into_project: false });
const twin = fixtures.addTrack({ kind: "audio", name: "bass 2" });
let audit = await call("song_audit");
const missingClips = [...drumsArr.map((c) => c.id), relClip.id];
assert.deepEqual(audit.counts, { missing_media: missingClips.length + 1, empty_simplers: 1, empty_drum_chains: 1, duplicate_track_names: 1 });
assert.equal(audit.issue_count, missingClips.length + 4);
const snareLocation = (await call("device_get", { device_id: snareK.id })).location;
assert.deepEqual(audit.missing_media.find((m) => m.kind === "simpler_sample"), {
  kind: "simpler_sample", device_id: snareK.id, sample_id: audit.missing_media.find((m) => m.kind === "simpler_sample").sample_id,
  file_path: missingWav, problem: "file not found", location: { ...kitRef, path: snareLocation.path },
});
assert.equal(snareLocation.path, "Kit 2 > Drum Rack > pad 60 > Simpler");
const clipEntries = audit.missing_media.filter((m) => m.kind === "audio_clip");
assert.deepEqual(clipEntries.map((m) => m.clip_id), missingClips);
assert.deepEqual(clipEntries.at(-1), { kind: "audio_clip", clip_id: relClip.id, clip_name: "", file_path: "relative.wav",
  problem: "not an absolute path, so it could not be checked",
  location: { view: "arrangement", track_id: audioTrackId, track_name: "Drums", track_index: 1, track_type: "audio" } });
assert.ok(clipEntries.slice(0, -1).every((m) => m.problem === "file not found"));
assert.ok(!audit.missing_media.some((m) => m.clip_id === okClip.id || m.file_path === presentWav), "present files pass");
assert.deepEqual(audit.empty_simplers, [{ device_id: emptySimpler.id,
  location: { track_id: synthIn, track_name: "Lead Synth", track_index: 3, track_type: "midi", path: "Lead Synth > Simpler" } }]);
assert.deepEqual(audit.empty_drum_chains.map((c) => [c.id, c.receiving_note_name, c.rack_device_id, c.location.path]),
  [[emptyPad.id, "D1", rackK, "Kit 2 > Drum Rack > pad 38"]]);
assert.deepEqual(audit.duplicate_track_names, [{ name: "Bass 2", case_differs: true, tracks: [
  bassRef, { track_id: twin, track_name: "bass 2", track_index: 7, track_type: "audio" }] }]);
assert.deepEqual([audit.truncated, audit.incomplete, audit.searched.tracks, audit.searched.files], [undefined, undefined, 10, 5]);
audit = await call("song_audit", { checks: ["duplicate_track_names", "empty_simplers"] });
assert.deepEqual([Object.keys(audit.counts), audit.missing_media, audit.empty_drum_chains, audit.issue_count],
  [["empty_simplers", "duplicate_track_names"], undefined, undefined, 2]);

// clean up: groups take their tracks with them
for (const id of [busId, kitT.id, twin]) await call("track_delete", { track_id: id });
for (const id of [relClip.id, okClip.id, takeClip.id]) await call("clip_delete", { clip_id: id });
await call("device_delete", { device_id: returnFx.id });
await call("cue_point_delete", { cue_point_id: drop.id });
assert.deepEqual((await tracksNow()).map((t) => t.name), ["Bass 2", "Drums"]);

// --- samples into Simplers, drum kits ---------------------------------------
const samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-samples-"));
const kickWav = path.join(samplesDir, "kick.wav");
const snareWav = path.join(samplesDir, "snare.wav");
const hatWav = path.join(samplesDir, "hat.wav");
for (const f of [kickWav, snareWav, hatWav]) fs.writeFileSync(f, "RIFF");
const imported = (f) => `/mock-project/Samples/Imported/${path.basename(f)}`;
const devicesOf = async (track_name) => (await call("track_get", { track_name, include: ["devices"] })).devices;

// device_insert sample_path: insert, sample, values — the sample is imported first by default
await call("track_create", { type: "midi", name: "Sampler T" });
const loadedSimpler = await undoSteps(() => call("device_insert", { track_name: "Sampler T", device_name: "Simpler",
  sample_path: kickWav, parameters: [{ name: "volume", value: 0.3 }] }));
assert.equal(loadedSimpler.steps, 3, "insert + sample + values");
assert.deepEqual([loadedSimpler.result.sample.file_path, loadedSimpler.result.imported_path, loadedSimpler.result.parameters[0].value],
  [imported(kickWav), imported(kickWav), 0.3]);
const plainLoad = await call("device_insert", { track_name: "Sampler T", device_name: "Simpler", sample_path: hatWav, import_into_project: false });
assert.deepEqual([plainLoad.sample.file_path, plainLoad.imported_path], [hatWav, undefined]);
// checked before the insert; a sample that cannot be loaded removes the Simpler again
const samplerCount = (await devicesOf("Sampler T")).length;
await usageError("device_insert", { track_name: "Sampler T", device_name: "Reverb", sample_path: kickWav }, /sample_path only applies to a Simpler, not "Reverb"/);
await usageError("device_insert", { track_name: "Sampler T", device_name: "Simpler", sample_path: path.join(samplesDir, "nope.wav") },
  /sample_path ".*nope\.wav": no such file/);
await usageError("device_insert", { track_name: "Sampler T", device_name: "Simpler", sample_path: "kick.wav" }, /not an absolute path/);
fixtures.refuseSamples(true);
const noLoad = await client.callTool({ name: "device_insert", arguments: { track_name: "Sampler T", device_name: "Simpler", sample_path: kickWav } });
fixtures.refuseSamples(false);
assert.equal(noLoad.isError, true);
assert.match(noLoad.content[0].text, /Could not load the sample .*kick\.wav: .*The new device was removed again/);
assert.equal((await devicesOf("Sampler T")).length, samplerCount, "nothing is left behind");
// simpler_replace_sample: a failing import changes nothing
fixtures.refuseImports(true);
const noImport = await client.callTool({ name: "simpler_replace_sample", arguments: { simpler_device_id: plainLoad.id, file_path: snareWav } });
fixtures.refuseImports(false);
assert.equal(noImport.isError, true);
assert.match(noImport.content[0].text, /Could not import .*snare\.wav into the project: mock: could not copy/);
assert.equal((await call("device_get", { device_id: plainLoad.id })).sample.file_path, hatWav);

// drum_kit_build: a new Drum Rack on a MIDI track, a chain + Simpler + sample per pad, pad levels
const kit3 = await call("track_create", { type: "midi", name: "Kit 3" });
const importsBefore = calls.imports.length;
let kitBuild = await undoSteps(() => call("drum_kit_build", { track_name: "Kit 3", pads: [
  { note: "C1", sample_path: kickWav, volume: 0.7 }, { note: 38, sample_path: snareWav, panning: -0.5 },
  { note: "F#1", sample_path: hatWav }, { note: 37, sample_path: kickWav }] }));
assert.equal(kitBuild.steps, 6, "rack, chains, notes, Simplers, samples, levels");
let kitRes = kitBuild.result;
assert.deepEqual([kitRes.rack_created, kitRes.track_id, kitRes.track_name, kitRes.built_count, kitRes.errors],
  [true, kit3.id, "Kit 3", 4, undefined]);
assert.deepEqual(kitRes.pads.map((p) => [p.note, p.note_name, p.chain_created, p.simpler_created, p.sample?.file_path, p.imported_path, p.error]), [
  [36, "C1", true, true, imported(kickWav), imported(kickWav), undefined],
  [38, "D1", true, true, imported(snareWav), imported(snareWav), undefined],
  [42, "F#1", true, true, imported(hatWav), imported(hatWav), undefined],
  [37, "C#1", true, true, imported(kickWav), imported(kickWav), undefined]]);
assert.deepEqual(calls.imports.slice(importsBefore), [kickWav, snareWav, hatWav], "each file is imported once");
let builtRack = await call("device_get", { device_id: kitRes.rack_device_id, include_chain_devices: true });
assert.deepEqual(builtRack.chains.map((c) => [c.id, c.receiving_note, c.devices.map((d) => [d.id, d.sample?.file_path])]),
  kitRes.pads.map((p) => [p.chain_id, p.note, [[p.simpler_device_id, p.sample.file_path]]]), "chains in the pads' order");
const padMixer = async (i) => (await call("chain_get", { chain_id: kitRes.pads[i].chain_id })).mixer;
assert.deepEqual([(await padMixer(0)).volume.value, (await padMixer(1)).panning.value, (await padMixer(2)).volume.value],
  [0.7, -0.5, 0.85]);
// reused pads keep their chain and Simpler and get the new sample; new pads are added
const firstPads = kitRes.pads;
kitBuild = await undoSteps(() => call("drum_kit_build", { rack_device_id: kitRes.rack_device_id, pads: [
  { note: 36, sample_path: snareWav }, { note: "E1", sample_path: snareWav }] }));
assert.equal(kitBuild.steps, 4, "chains, notes, Simplers, samples");
kitRes = kitBuild.result;
assert.deepEqual([kitRes.rack_created, kitRes.track_id], [false, kit3.id]);
assert.deepEqual(kitRes.pads.map((p) => [p.note, p.chain_created, p.simpler_created, p.sample.file_path]),
  [[36, false, false, imported(snareWav)], [40, true, true, imported(snareWav)]]);
assert.deepEqual([kitRes.pads[0].chain_id, kitRes.pads[0].simpler_device_id], [firstPads[0].chain_id, firstPads[0].simpler_device_id]);
const kitPadsAfter = await call("drum_kit_build", { track_name: "Kit 3", pads: [{ note: 42, sample_path: hatWav }], import_into_project: false });
assert.deepEqual([kitPadsAfter.rack_device_id, kitPadsAfter.pads[0].sample.file_path, kitPadsAfter.pads[0].imported_path],
  [kitRes.rack_device_id, hatWav, undefined], "the track's Drum Rack is found; no import");
// everything is checked first: nothing changes on a bad entry
const builtChains = async () => (await call("device_get", { device_id: kitRes.rack_device_id })).chains.map((c) => [c.id, c.receiving_note]);
const chainsBefore = await builtChains();
await usageError("drum_kit_build", { track_name: "Kit 3", pads: [{ note: 50, sample_path: kickWav }, { note: "D2", sample_path: kickWav }] },
  /pads\[1\]: note 50 \(D2\) is given twice, also by pads\[0\]/);
await usageError("drum_kit_build", { track_name: "Kit 3", pads: [{ note: 50, sample_path: kickWav }, { note: 51, sample_path: path.join(samplesDir, "nope.wav") }] },
  /pads\[1\]: sample_path ".*nope\.wav": no such file/);
await usageError("drum_kit_build", { track_name: "Kit 3", pads: [{ note: "Q1", sample_path: kickWav }] }, /pads\[0\]: note: "Q1" is not a MIDI pitch/);
await usageError("drum_kit_build", { pads: [{ note: 50, sample_path: kickWav }] }, /Give rack_device_id or a track/);
await usageError("drum_kit_build", { track_name: "Kit 3", rack_device_id: kitRes.rack_device_id, pads: [{ note: 50, sample_path: kickWav }] },
  /Give rack_device_id or a track/);
await usageError("drum_kit_build", { track_name: "Drums", pads: [{ note: 50, sample_path: kickWav }] },
  /"Drums" .* has no Drum Rack, and only a MIDI track can get one/);
await usageError("drum_kit_build", { rack_device_id: kitRes.pads[0].simpler_device_id, pads: [{ note: 50, sample_path: kickWav }] },
  /is a Simpler, expected DrumRackDevice/);
await call("drum_chain_set", { drum_chain_id: kitRes.pads[1].chain_id, receiving_note: 38 });
await usageError("drum_kit_build", { rack_device_id: kitRes.rack_device_id, pads: [{ note: 38, sample_path: kickWav }] },
  /pads\[0\]: 2 chains of "Drum Rack" .* receive note 38 .*ambiguous/);
await call("drum_chain_set", { drum_chain_id: kitRes.pads[1].chain_id, receiving_note: 40 });
const secondRack = await call("device_insert", { track_name: "Kit 3", device_name: "Drum Rack" });
await usageError("drum_kit_build", { track_name: "Kit 3", pads: [{ note: 50, sample_path: kickWav }] }, /has 2 Drum Racks .*give rack_device_id/);
await call("device_delete", { device_id: secondRack.id });
assert.deepEqual(await builtChains(), chainsBefore, "failed builds change nothing");
// an import that fails changes nothing in the set; a pad that fails later is reported, the call succeeds
await call("track_create", { type: "midi", name: "Kit 4" });
fixtures.refuseImports(true);
const kitNoImport = await client.callTool({ name: "drum_kit_build", arguments: { track_name: "Kit 4", pads: [{ note: 36, sample_path: kickWav }] } });
fixtures.refuseImports(false);
assert.equal(kitNoImport.isError, true);
assert.match(kitNoImport.content[0].text, /pads\[0\]: Could not import .*Nothing was changed in the Live Set\./);
assert.equal((await devicesOf("Kit 4")).length, 0);
fixtures.refuseSamples(true);
const kitNoSample = await call("drum_kit_build", { track_name: "Kit 4", pads: [{ note: 36, sample_path: kickWav }, { note: 38, sample_path: snareWav, volume: 0.1 }] });
fixtures.refuseSamples(false);
assert.deepEqual([kitNoSample.rack_created, kitNoSample.built_count, kitNoSample.errors.length], [true, 0, 2]);
assert.match(kitNoSample.pads[0].error, /^loading \/mock-project\/Samples\/Imported\/kick\.wav: .*rejected the operation/);
assert.deepEqual(kitNoSample.pads.map((p) => [p.chain_created, p.simpler_created, p.sample]), [[true, true, undefined], [true, true, undefined]]);
assert.equal((await call("chain_get", { chain_id: kitNoSample.pads[1].chain_id })).mixer.volume.value, 0.85, "a failed pad gets no level");
// insertChain is typed as returning a Chain: a chain that is not a DrumChain fails its pad
await call("track_create", { type: "midi", name: "Kit 5" });
fixtures.plainChains(true);
const kitPlain = await call("drum_kit_build", { track_name: "Kit 5", pads: [{ note: 36, sample_path: kickWav }] });
fixtures.plainChains(false);
assert.deepEqual([kitPlain.pads[0].chain_created, kitPlain.pads[0].simpler_device_id], [true, undefined]);
assert.match(kitPlain.pads[0].error, /^creating its chain: Live created Chain \d+, not a drum chain/);

// --- clip_copy -----------------------------------------------------------------
const copySrcTrack = await call("track_create", { type: "midi", name: "Copy Src" });
const riff = await call("clip_create", { type: "midi", track_name: "Copy Src", scene_index: 0, duration: 4, name: "Riff", color: "#123456", notes: [
  { pitch: 60, start_time: 0, duration: 0.5, velocity: 100 }, { pitch: 61, start_time: 1, duration: 0.5, velocity: 90, probability: 0.5 },
  { pitch: 62, start_time: 2, duration: 0.5, velocity: 100 }, { pitch: 63, start_time: 3, duration: 2, velocity: 100 }] });
const playOf = async (clip_id) => (await notesOf(clip_id)).map((n) => [n.pitch, n.start_time, n.duration]);
// session (looping 0-4) to the arrangement, twice as long: the loop repeats; a note is cut at the loop end
let copiedClip = await undoSteps(() => call("clip_copy", { clip_id: riff.id, track_name: "Copy Src", start_time: 8, duration: 8 }));
assert.equal(copiedClip.steps, 2, "create + notes and properties");
let cc = copiedClip.result;
assert.deepEqual([cc.class, cc.start_time, cc.end_time, cc.name, cc.color, cc.looping, cc.note_count, cc.moved, cc.fidelity, cc.source_id],
  ["MidiClip", 8, 16, "Riff", "#123456", true, 8, false, "notes", riff.id]);
assert.deepEqual(cc.location, { view: "arrangement", track_id: copySrcTrack.id, track_name: "Copy Src", track_index: copySrcTrack.index, track_type: "midi" });
assert.match(cc.lost.join(" "), /envelopes/);
assert.deepEqual(await playOf(cc.id), [[60, 0, 0.5], [61, 1, 0.5], [62, 2, 0.5], [63, 3, 1], [60, 4, 0.5], [61, 5, 0.5], [62, 6, 0.5], [63, 7, 1]]);
assert.deepEqual((await notesOf(cc.id))[1], { pitch: 61, start_time: 1, duration: 0.5, velocity: 90, probability: 0.5 }, "note fields are kept");
const arrCopy = cc;
// start marker 1, loop 2-4: plays 1-4, then the loop; re-based to start at 0, into an empty session slot
fixtures.setClipRegion(riff.id, { startMarker: 1, loopStart: 2, loopEnd: 4, looping: true });
cc = await call("clip_copy", { clip_id: riff.id, track_name: "Copy Src", scene_name: "Chorus", duration: 6 });
assert.deepEqual([cc.location.view, cc.location.scene_index, cc.duration, cc.looping], ["session", 1, 6, true]);
assert.deepEqual(await playOf(cc.id), [[61, 0, 0.5], [62, 1, 0.5], [63, 2, 1], [62, 3, 0.5], [63, 4, 1], [62, 5, 0.5]]);
const slotCopy = cc;
// not looping, markers 1-3: the region; a longer copy repeats it
fixtures.setClipRegion(riff.id, { looping: false, startMarker: 1, endMarker: 3, endTime: 2 });
cc = await call("clip_copy", { clip_id: riff.id, track_id: copySrcTrack.id, start_time: 20 });
assert.deepEqual([cc.start_time, cc.end_time, cc.looping], [20, 22, false]);
assert.deepEqual(await playOf(cc.id), [[61, 0, 0.5], [62, 1, 0.5]]);
const regionCopy = cc;
cc = await call("clip_copy", { clip_id: riff.id, track_id: copySrcTrack.id, start_time: 24, duration: 5, name: "Tiled", color: "#00ff00" });
assert.deepEqual([cc.name, cc.color], ["Tiled", "#00ff00"]);
assert.deepEqual((await playOf(cc.id)).map((n) => [n[0], n[1]]), [[61, 0], [62, 1], [61, 2], [62, 3], [61, 4]]);
const tiledCopy = cc;
// move: the copy first, then the source is deleted (three undo steps); onto its own place: nothing happens
const movedClip = await undoSteps(() => call("clip_copy", { clip_id: arrCopy.id, track_name: "Copy Src", start_time: 32, move: true }));
assert.equal(movedClip.steps, 3);
assert.deepEqual([movedClip.result.moved, movedClip.result.start_time, movedClip.result.note_count], [true, 32, 8]);
assert.equal((await client.callTool({ name: "clip_get", arguments: { clip_id: arrCopy.id } })).isError, true, "the source is gone");
const stay = await call("clip_copy", { clip_id: movedClip.result.id, track_name: "Copy Src", start_time: 32, move: true });
assert.deepEqual([stay.id, stay.moved, stay.unchanged], [movedClip.result.id, false, "the clip is already there"]);
// over existing clips: they are reported
cc = await call("clip_copy", { clip_id: movedClip.result.id, track_name: "Copy Src", start_time: 30, duration: 4 });
assert.deepEqual(cc.overlaps, [movedClip.result.id]);
const overlapCopy = cc;
// the target is checked first; nothing is created on a bad call
const arrCount = async (track_name) => (await call("track_get", { track_name, include: ["arrangement_clips"] })).arrangement_clips.length;
const copyClipsBefore = await arrCount("Copy Src");
await usageError("clip_copy", { clip_id: riff.id, track_name: "Copy Src", scene_index: 0 }, /The target is the clip's own slot/);
await usageError("clip_copy", { clip_id: riff.id, track_name: "Copy Src", scene_index: 1 },
  new RegExp(`already holds clip ${slotCopy.id} \\("Riff"\\): delete it first`));
await usageError("clip_copy", { clip_id: riff.id, track_name: "Drums", start_time: 0 },
  /A MIDI clip can only be copied to a MIDI track; "Drums" .* is of type audio/);
await usageError("clip_copy", { clip_id: riff.id, track_name: "Copy Src" }, /start_time is required/);
await usageError("clip_copy", { clip_id: riff.id, target_id: (await slotsOf(midiTrackId))[1].id, start_time: 4 }, /start_time only applies/);
await usageError("clip_copy", { clip_id: riff.id, track_name: "Copy Src", start_time: 40, color: "red" }, /Invalid color/);
await usageError("clip_copy", { clip_id: riff.id, target_id: kit3.id, start_time: 0, track_name: "Copy Src" }, /not both/);
assert.equal(await arrCount("Copy Src"), copyClipsBefore);
// audio: file, warping, warp mode and markers/loop; Live warps the copy itself
await call("track_create", { type: "audio", name: "Copy Audio" });
const loopSrc = await call("clip_create", { type: "audio", track_name: "Copy Audio", start_time: 0, duration: 8, file_path: "/tmp/loop.wav",
  import_into_project: false, is_warped: true, name: "Loop",
  loop_settings: { looping: true, start_marker: 0.5, end_marker: 3.5, loop_start: 1, loop_end: 3 } });
await call("clip_set", { clip_id: loopSrc.id, warp_mode: "Complex", muted: true });
fixtures.setWarpMarkers(loopSrc.id, [{ sampleTime: 0, beatTime: 0 }, { sampleTime: 1.5, beatTime: 4 }]);
cc = await call("clip_copy", { clip_id: loopSrc.id, track_name: "Copy Audio", start_time: 16 });
assert.deepEqual([cc.class, cc.file_path, cc.warping, cc.warp_mode, cc.muted, cc.name, cc.start_time, cc.end_time],
  ["AudioClip", "/tmp/loop.wav", true, "Complex", true, "Loop", 16, 24]);
assert.deepEqual([cc.looping, cc.start_marker, cc.end_marker, cc.loop_start, cc.loop_end], [true, 0.5, 3.5, 1, 3]);
assert.deepEqual([cc.fidelity, cc.warp_markers_match, cc.differs], ["approximate", false, undefined]);
assert.match(cc.lost.join(" "), /warp markers/);
const audioCopies = [cc.id];
cc = await call("clip_copy", { clip_id: loopSrc.id, track_name: "Copy Audio", scene_index: 0 });
assert.deepEqual([cc.location.view, cc.looping, cc.loop_start, cc.loop_end], ["session", true, 1, 3]);
audioCopies.push(cc.id);
await usageError("clip_copy", { clip_id: loopSrc.id, track_name: "Copy Audio", scene_index: 1, duration: 4 }, /takes no duration/);
await usageError("clip_copy", { clip_id: loopSrc.id, track_name: "Copy Src", start_time: 40 }, /An audio clip can only be copied to a audio track|can only be copied to a audio track/);
// a loop shorter than a new clip allows: copied without it, and said so
fixtures.setClipRegion(loopSrc.id, { loopStart: 1, loopEnd: 1.1 });
cc = await call("clip_copy", { clip_id: loopSrc.id, track_name: "Copy Audio", start_time: 40 });
assert.deepEqual([cc.looping, cc.loop_start, cc.loop_end, cc.differs], [false, 0.5, 3.5, [{ field: "duration", requested: 8, got: 3 }]],
  "without its loop the copy is only as long as its region");
assert.match(cc.lost.join(" "), /the loop: it is shorter than 0\.25 beats/);
audioCopies.push(cc.id);
// a longer copy of a clip that does not loop: Live caps it at the region, and `differs` says so
const hit = await call("clip_create", { type: "audio", track_name: "Copy Audio", start_time: 60, file_path: "/tmp/hit.wav", import_into_project: false });
cc = await call("clip_copy", { clip_id: hit.id, track_name: "Copy Audio", start_time: 70, duration: 8 });
assert.deepEqual([cc.warping, cc.warp_markers_match, cc.differs], [false, undefined, [{ field: "duration", requested: 8, got: 4 }]]);

// --- arrangement_copy_range ----------------------------------------------------
await call("track_create", { type: "midi", name: "ArrM" });
await call("track_create", { type: "audio", name: "ArrA" });
const mk = (start_time, duration, pitches, name) => call("clip_create", { type: "midi", track_name: "ArrM", start_time, duration, name,
  notes: pitches.map((pitch, i) => ({ pitch, start_time: i, duration: 0.5 })) });
const clipA = await mk(0, 4, [60, 61, 62, 63], "A");
const clipB = await mk(6, 4, [64, 65, 66, 67], "B"); // crosses the range end
const clipC = await mk(12, 2, [70], "C");
const inTarget = await mk(18, 2, [72], "T1");
const crossTarget = await mk(22, 4, [74, 75, 76, 77], "T2"); // crosses the target end
const clipD = await call("clip_create", { type: "audio", track_name: "ArrA", start_time: 0, file_path: "/tmp/kick.wav", name: "D" });
const clipE = await call("clip_create", { type: "audio", track_name: "ArrA", start_time: 7, file_path: "/tmp/kick.wav", name: "E" });
const arrLane = await call("take_lane_create", { track_name: "ArrM" });
await call("clip_create", { type: "midi", target_id: arrLane.id, start_time: 1, duration: 2 });
const partCue = await call("cue_point_create", { time: 2, name: "Part" });
const busyCue = await call("cue_point_create", { time: 5, name: "Busy" });
const takenCue = await call("cue_point_create", { time: 21, name: "Taken" });
const arrClipsOf = async (track_name) => (await call("track_get", { track_name, include: ["arrangement_clips"] })).arrangement_clips;
let copyRange = await undoSteps(() => call("arrangement_copy_range", { start_time: 0, end_time: 8, to_time: 16,
  tracks: [{ track_name: "ArrM" }, { track_name: "ArrA" }], include_cue_points: true }));
assert.equal(copyRange.steps, 5, "clear, create, notes and properties, cue points, their names");
let cr = copyRange.result;
assert.deepEqual([cr.source, cr.target, cr.copied_count, cr.skipped_count, cr.take_lane_clips_not_copied, cr.errors],
  [{ start_time: 0, end_time: 8 }, { start_time: 16, end_time: 24 }, 3, 1, 1, undefined]);
const [rowM, rowA] = cr.tracks;
assert.deepEqual(rowM.copies.map((c) => [c.source_id, c.name, c.start_time, c.end_time, c.trimmed]),
  [[clipA.id, "A", 16, 20, undefined], [clipB.id, "B", 22, 24, true]]);
assert.deepEqual(await playOf(rowM.copies[0].id), [[60, 0, 0.5], [61, 1, 0.5], [62, 2, 0.5], [63, 3, 0.5]]);
assert.deepEqual(await playOf(rowM.copies[1].id), [[64, 0, 0.5], [65, 1, 0.5]], "trimmed to the range");
assert.deepEqual(rowA.copies.map((c) => [c.source_id, c.start_time, c.end_time, c.warp_markers_match]), [[clipD.id, 16, 20, undefined]]);
assert.deepEqual(rowA.skipped.map((s) => [s.source_id, s.start_time, s.end_time]), [[clipE.id, 7, 11]]);
assert.match(rowA.skipped[0].reason, /crosses the edge of the range/);
assert.deepEqual([rowM.cleared, rowA.cleared, rowM.name, rowA.type], [true, true, "ArrM", "audio"]);
// the target was cleared first: the clip in it is gone, the one crossing its end is shortened
const arrMNow = (await arrClipsOf("ArrM")).sort((a, b) => a.start_time - b.start_time);
assert.deepEqual(arrMNow.map((c) => [c.name, c.start_time, c.end_time]),
  [["A", 0, 4], ["B", 6, 10], ["C", 12, 14], ["A", 16, 20], ["B", 22, 24], ["T2", 24, 26]]);
assert.equal(arrMNow[5].id, crossTarget.id, "a truncated clip keeps its id");
assert.ok(!arrMNow.some((c) => c.id === inTarget.id));
assert.deepEqual(cr.cue_points.map((c) => [c.name, c.time, c.skipped !== undefined]),
  [["Start", 16, false], ["Part", 18, false], ["Busy", 21, true]]);
assert.deepEqual(cr.cue_points.slice(0, 2).map((c) => c.source_id), [song.cue_points[0].id, partCue.id]);
// a clip crossing the range's start: its played part from there on, re-based
cr = await call("arrangement_copy_range", { start_time: 2, end_time: 8, to_time: 40, tracks: [{ track_name: "ArrM" }] });
assert.deepEqual(cr.tracks[0].copies.map((c) => [c.source_id, c.start_time, c.end_time, c.trimmed]),
  [[clipA.id, 40, 42, true], [clipB.id, 44, 46, true]]);
assert.deepEqual(await playOf(cr.tracks[0].copies[0].id), [[62, 0, 0.5], [63, 1, 0.5]]);
for (const c of cr.tracks[0].copies) await call("clip_delete", { clip_id: c.id });
// every regular audio and MIDI track by default (the empty ones are cleared too)
cr = await call("arrangement_copy_range", { start_time: 0, end_time: 4, to_time: 200 });
const byName2 = Object.fromEntries(cr.tracks.map((t) => [t.name, t.copies.map((c) => c.source_id)]));
assert.deepEqual(byName2, { "Bass 2": [], Drums: [audioClip.id], "Sampler T": [], "Kit 3": [], "Kit 4": [], "Kit 5": [],
  "Copy Src": [], "Copy Audio": [], ArrM: [clipA.id], ArrA: [clipD.id] });
assert.deepEqual(cr.tracks.find((t) => t.name === "Copy Audio").skipped.map((x) => x.source_id), [loopSrc.id], "beats 0-8 cross the range end");
assert.equal(cr.cue_points, undefined);
for (const t of cr.tracks) for (const c of t.copies) await call("clip_delete", { clip_id: c.id });
// checked first; nothing changes on a bad call
const arrMCount = (await arrClipsOf("ArrM")).length;
await usageError("arrangement_copy_range", { start_time: 8, end_time: 8, to_time: 32 }, /end_time 8 must be after start_time 8/);
await usageError("arrangement_copy_range", { start_time: 0, end_time: 8, to_time: 4 }, /target range 4-12 overlaps the source range 0-8/);
await usageError("arrangement_copy_range", { start_time: 0, end_time: 8, to_time: 32, tracks: [{ track_name: "ArrM" }, { track_name: "A-Reverb" }] },
  /"A-Reverb" .* is a return track: only audio and MIDI tracks/);
assert.equal((await arrClipsOf("ArrM")).length, arrMCount);

// --- render_track_audio: analysis, persist, several tracks ---------------------
await call("track_create", { type: "audio", name: "Render" });
await call("clip_create", { type: "audio", track_name: "Render", start_time: 0, file_path: "/tmp/kick.wav" }); // beats 0-4
const near = (a, b, tol = 0.2) => a !== null && Math.abs(a - b) <= tol;
let rendered = await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 8, analyze: true });
let an = rendered.analysis;
assert.ok(fs.existsSync(rendered.audio_path) && rendered.imported_path === undefined);
assert.deepEqual([an.format, an.bits_per_sample, an.sample_rate, an.channels, an.frames, an.duration_s, an.clipped_samples, an.silent],
  ["float", 32, 8000, 2, 38400, 4.8, 0, false], "8 beats at 100 bpm");
assert.ok(near(an.peak_dbfs, -6.02) && near(an.rms_dbfs, -14.08), `levels ${an.peak_dbfs} / ${an.rms_dbfs}`);
assert.ok(near(an.channel_levels[0].peak_dbfs, -6.02) && near(an.channel_levels[1].peak_dbfs, -12.04));
assert.ok(near(an.channel_levels[0].rms_dbfs, -12.04) && near(an.channel_levels[1].rms_dbfs, -18.06));
assert.equal(an.envelope.buckets, 32);
assert.ok(an.envelope.peak_dbfs.slice(0, 16).every((v) => near(v, -6.02, 0.3)), "sound while the clip plays");
assert.deepEqual(an.envelope.peak_dbfs.slice(16), Array(16).fill(null), "digital silence after it");
assert.ok(near(an.envelope.rms_dbfs[0], -11.07, 0.3), `bucket rms ${an.envelope.rms_dbfs[0]}`);
// every sample format the analysis reads
for (const [fmt, expected] of [
  [{ bits: 16, float: false }, ["pcm", 16]], [{ bits: 24, float: false }, ["pcm", 24]], [{ bits: 32, float: false }, ["pcm", 32]],
  [{ bits: 8, float: false }, ["pcm", 8]], [{ bits: 64, float: true }, ["float", 64]],
  [{ bits: 24, float: false, extensible: true, listChunk: true }, ["pcm", 24]], [{ bits: 32, float: true, extensible: true, channels: 1 }, ["float", 32]],
]) {
  fixtures.renderFormat({ extensible: false, listChunk: false, channels: 2, ...fmt });
  an = (await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 8, analyze: true })).analysis;
  assert.deepEqual([an.format, an.bits_per_sample, an.channels, an.frames], [...expected, fmt.channels ?? 2, 38400], JSON.stringify(fmt));
  assert.ok(near(an.peak_dbfs, -6.02) && an.clipped_samples === 0 && !an.silent, `${JSON.stringify(fmt)}: peak ${an.peak_dbfs}`);
}
// clipping: integer samples stop at full scale, float ones go over it
const renderId = (await tracksNow()).find((t) => t.name === "Render").id;
fixtures.renderLevel(renderId, 1.5);
fixtures.renderFormat({ bits: 16, float: false, extensible: false, listChunk: false, channels: 2 });
an = (await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 8, analyze: true })).analysis;
assert.ok(an.peak_dbfs === 0 && an.clipped_samples > 0 && an.channel_levels[0].clipped_samples > 0, `peak ${an.peak_dbfs}, ${an.clipped_samples} clipped`);
fixtures.renderFormat({ bits: 32, float: true });
an = (await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 8, analyze: true })).analysis;
assert.ok(near(an.peak_dbfs, 3.52) && an.clipped_samples > 0, `float peak ${an.peak_dbfs}`);
fixtures.renderLevel(renderId, 0.5);
// silence, a broken file (the render is still returned), persist, several tracks
an = (await call("render_track_audio", { track_name: "Render", start_time: 100, end_time: 104, analyze: true })).analysis;
assert.deepEqual([an.silent, an.peak_dbfs, an.rms_dbfs, an.clipped_samples, new Set(an.envelope.peak_dbfs).size], [true, null, null, 0, 1]);
fixtures.renderFormat({ garbage: true });
rendered = await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 4, analyze: true });
fixtures.renderFormat({ garbage: false });
assert.ok(rendered.audio_path && rendered.analysis === undefined);
assert.match(rendered.analysis_error, /could not be analyzed: not a WAV file/);
rendered = await call("render_track_audio", { track_name: "Render", start_time: 0, end_time: 4, persist: true });
assert.equal(rendered.imported_path, `/mock-project/Samples/Imported/${path.basename(rendered.audio_path)}`);
assert.equal(rendered.analysis, undefined, "analysis only on request");
const multi2 = await call("render_track_audio", { tracks: [{ track_name: "Render" }, { track_name: "ArrA" }], start_time: 0, end_time: 4, analyze: true });
assert.deepEqual(multi2.items.map((it) => [it.track_name, it.analysis.silent]), [["Render", false], ["ArrA", false]]);
assert.notEqual(multi2.items[0].audio_path, multi2.items[1].audio_path);
await usageError("render_track_audio", { tracks: [{ track_name: "Render" }, { track_name: "ArrM" }], start_time: 0, end_time: 4 },
  /Only audio tracks can be rendered; "ArrM"/);
await usageError("render_track_audio", { tracks: [{ track_name: "Render" }], track_name: "Render", start_time: 0, end_time: 4 }, /not both/);
await usageError("render_track_audio", { track_name: "Render", start_time: 4, end_time: 4 }, /end_time 4 must be after start_time 4/);

// --- audio_track_consolidate ---------------------------------------------------
await call("track_create", { type: "audio", name: "Comp" });
const compClips = [];
for (const start_time of [0, 4, 10]) compClips.push(await call("clip_create", { type: "audio", track_name: "Comp", start_time, file_path: "/tmp/take.wav" }));
const consolidated = await undoSteps(() => call("audio_track_consolidate", { track_name: "Comp", start_time: 0, end_time: 12, name: "Comp 1", color: "#ff0000" }));
assert.equal(consolidated.steps, 3, "clear, create, name and color");
const cons = consolidated.result;
assert.deepEqual([cons.class, cons.start_time, cons.end_time, cons.warping, cons.looping, cons.name, cons.color, cons.cleared],
  ["AudioClip", 0, 12, false, false, "Comp 1", "#ff0000", [0, 12]]);
assert.deepEqual([cons.file_path, cons.imported_path], [`/mock-project/Samples/Imported/${path.basename(cons.rendered_path)}`, cons.file_path]);
assert.ok(fs.existsSync(cons.rendered_path));
assert.equal(cons.location.view, "arrangement");
const compNow = (await arrClipsOf("Comp")).sort((a, b) => a.start_time - b.start_time);
assert.deepEqual(compNow.map((c) => [c.id, c.start_time, c.end_time]), [[cons.id, 0, 12], [compClips[2].id, 12, 14]],
  "the clips in the range are replaced; the one crossing its end is shortened");
await usageError("audio_track_consolidate", { track_name: "ArrM", start_time: 0, end_time: 4 }, /Only audio tracks can be consolidated; "ArrM"/);
await usageError("audio_track_consolidate", { track_name: "Comp", start_time: 4, end_time: 2 }, /end_time 2 must be after start_time 4/);
await usageError("audio_track_consolidate", { track_name: "Comp", start_time: 0, end_time: 4, color: "#12" }, /Invalid color/);
await usageError("audio_track_consolidate", { track_name: "Comp", start_time: 50, end_time: 60 }, /"Comp" .* has no arrangement clips between 50 and 60/);
fixtures.refuseImports(true);
const consFail = await client.callTool({ name: "audio_track_consolidate", arguments: { track_name: "Comp", start_time: 0, end_time: 12 } });
fixtures.refuseImports(false);
assert.equal(consFail.isError, true);
assert.match(consFail.content[0].text, /Could not render and import the range: .*Nothing was changed/);
assert.deepEqual((await arrClipsOf("Comp")).map((c) => c.id).sort(), compNow.map((c) => c.id).sort());

// --- sample_search ---------------------------------------------------------------
const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-root-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-outside-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-home-"));
const put = (base, rel) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), "RIFF");
};
for (const rel of ["Drums/Kicks/Kick 808.wav", "Drums/Kicks/Kick Acoustic.aiff", "Drums/Snares/Snare.aif", "Loops/Break.WAV",
  "readme.txt", ".hidden/secret.wav", "deep/a/b/c/Deep.wav"]) put(sampleRoot, rel);
put(outside, "Outside Kick.wav");
put(fakeHome, "Music/Ableton/User Library/Samples/Clap.wav");
fs.symlinkSync(outside, path.join(sampleRoot, "Linked Out"));
fs.symlinkSync(path.join(sampleRoot, "Drums"), path.join(sampleRoot, "Drums Alias"));
const configFile = path.join(storageDir, "config.json");
fs.writeFileSync(configFile, JSON.stringify({ port: PORT, sample_roots: [sampleRoot, "relative/samples", 42] }));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
try {
  let found2 = await call("sample_search", { query: "KICK 808" });
  const realRoot = fs.realpathSync(sampleRoot);
  assert.deepEqual(found2.results.map((r) => [r.path, r.name, r.root, r.relative_path, r.size_bytes]),
    [[path.join(realRoot, "Drums/Kicks/Kick 808.wav"), "Kick 808.wav", path.basename(realRoot), "Drums/Kicks/Kick 808.wav", 4]]);
  assert.deepEqual([found2.complete, found2.stopped], [true, undefined]);
  assert.deepEqual(found2.problems, ['sample_roots entry "relative/samples" is not an absolute path', "sample_roots entry 42 is not a folder path"]);
  assert.deepEqual(found2.roots.map((r) => [r.name, r.source, r.exists]), [[path.basename(sampleRoot), "config", true],
    ["User Library", "library", true], ["Factory Packs", "library", false], ["User Library", "library", false], ["Factory Packs", "library", false]]);
  // everything: audio files only, shallow first, no hidden folders, nothing outside the roots, no duplicates via links
  found2 = await call("sample_search");
  assert.deepEqual(found2.results.map((r) => r.relative_path), ["Loops/Break.WAV", "Samples/Clap.wav", "Drums/Kicks/Kick 808.wav",
    "Drums/Kicks/Kick Acoustic.aiff", "Drums/Snares/Snare.aif", "deep/a/b/c/Deep.wav"]);
  assert.ok(!found2.results.some((r) => /Outside|secret/.test(r.path)), "links out of the roots are not followed");
  assert.deepEqual((await call("sample_search", { query: "kick", limit: 1 })).stopped, "limit");
  assert.ok(!(await call("sample_search", { max_depth: 2 })).results.some((r) => r.name === "Deep.wav"));
  assert.deepEqual((await call("sample_search", { extensions: ["aif"] })).results.map((r) => r.name), ["Snare.aif"]);
  assert.deepEqual((await call("sample_search", { roots: ["user library"] })).results.map((r) => r.name), ["Clap.wav"]);
  await usageError("sample_search", { roots: ["Nope"] }, /No sample root named "Nope"\. Roots: /);
  // without any sample folder the result says how to add one
  fs.writeFileSync(configFile, JSON.stringify({ port: PORT }));
  process.env.HOME = outside;
  found2 = await call("sample_search");
  assert.deepEqual([found2.results, found2.complete], [[], true]);
  assert.match(found2.hint, /add folders to "sample_roots"/);
} finally {
  process.env.HOME = realHome;
  fs.writeFileSync(configFile, JSON.stringify({ port: PORT }));
}

// clean up
for (const name of ["Sampler T", "Kit 3", "Kit 4", "Kit 5", "Copy Src", "Copy Audio", "ArrM", "ArrA", "Render", "Comp"])
  await call("track_delete", { track_name: name });
for (const c of (await call("song_get", { include: ["cue_points"] })).cue_points.filter((x) => x.name !== "Start" || x.time !== 0))
  await call("cue_point_delete", { cue_point_id: c.id });
assert.deepEqual((await tracksNow()).map((t) => t.name), ["Bass 2", "Drums"]);
for (const dir of [samplesDir, sampleRoot, outside, fakeHome]) fs.rmSync(dir, { recursive: true, force: true });

// ui + commands; the status command and its menu entries are registered
await call("execute_command", { command_id: "ableton-live-mcp.status" });
assert.equal(calls.dialogs.length, 1);
const statusPage = decodeURIComponent(calls.dialogs[0].url);
assert.match(statusPage, new RegExp(`http://127\\.0\\.0\\.1:${PORT}/mcp`));
assert.ok(statusPage.includes(path.join(storageDir, "config.json")), "status shows the config path");
const statusMenus = calls.menus.filter((m) => m.title === "Ableton Live MCP: Status");
assert.deepEqual(statusMenus.map((m) => m.scope).sort(), ["AudioTrack", "MidiTrack"]);
assert.ok(statusMenus.every((m) => m.commandId === "ableton-live-mcp.status"));
assert.equal(calls.menus.length, 14, "2 status entries + 12 selection entries");
const dlg = await call("show_dialog", { html: "<b>hi</b>" });
assert.equal(dlg.result, "mock-dialog-result");
assert.deepEqual([dlg.status, dlg.dialog_id], ["closed", "dialog-2"], "the Status dialog was dialog-1");
assert.equal(calls.dialogs.at(-1).url, `data:text/html,${encodeURIComponent("<b>hi</b>")}`);

// --- show_dialog: url, form, non-blocking dialogs, dialog_result ---------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// until the call in flight has reached the server (a dialog is open in the mock)
const until = async (cond, what) => {
  for (let i = 0; i < 250; i++) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${what}`);
};
const dialogShown = () => until(() => fixtures.openDialogs().length === 1, "the dialog to open");
const dialogCount = calls.dialogs.length;
await usageError("show_dialog", {}, /Give exactly one of html, url and form/);
await usageError("show_dialog", { html: "x", url: "https://example.com/" }, /exactly one of html, url and form/);
for (const bad of ["http://example.com/form", "http://127.0.0.1:3000/", "javascript:alert(1)", "ftp://localhost/x"])
  await usageError("show_dialog", { url: bad }, /url must be https:, file: or http:\/\/localhost/);
await usageError("show_dialog", { url: "not a url" }, /Invalid url "not a url"/);
// the form's own contradictions are refused before Live sees anything
await usageError("show_dialog", { form: {} }, /form needs a title, a message or fields/);
await usageError("show_dialog", { form: { fields: [{ name: "a" }, { name: "a" }] } }, /fields\[1\] \("a"\): the field name is used twice/);
await usageError("show_dialog", { form: { fields: [{ name: "a", type: "select" }] } }, /a select needs them/);
await usageError("show_dialog", { form: { fields: [{ name: "a", options: ["x"] }] } }, /options go with type "select"/);
await usageError("show_dialog", { form: { fields: [{ name: "a", type: "select", options: ["x"], default: "y" }] } }, /one of the options/);
await usageError("show_dialog", { form: { fields: [{ name: "a", type: "checkbox", default: "yes" }] } }, /checkbox field's default is a boolean/);
await usageError("show_dialog", { form: { fields: [{ name: "a", min: 1 }] } }, /only apply to type "number"/);
await usageError("show_dialog", { form: { fields: [{ name: "a", type: "number", min: 5, max: 1 }] } }, /min 5 is above max 1/);
await usageError("show_dialog", { form: { message: "x", choices: ["A", "A"] } }, /each button label once/);
await usageError("show_dialog", { form: { fields: [{ name: "1st" }] } }, /Input validation error/);
await usageError("show_dialog", { form: { message: "x", color: "red" } }, /Input validation error/);
assert.equal(calls.dialogs.length, dialogCount, "refused dialogs never reach Live");
for (const [given, opened] of [["https://example.com/form?x=1", "https://example.com/form?x=1"],
  ["file:///tmp/My Report.html", "file:///tmp/My%20Report.html"], ["http://localhost:3000/ask", "http://localhost:3000/ask"]]) {
  assert.equal((await call("show_dialog", { url: given })).result, "mock-dialog-result");
  assert.equal(calls.dialogs.at(-1).url, opened);
}

// A form page as a webview runs it: the elements its script reads, built from
// the HTML, and the message it posts to the host.
function formPage(url) {
  assert.ok(url.startsWith("data:text/html,"));
  const html = decodeURIComponent(url.slice("data:text/html,".length));
  const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const attrsOf = (src) =>
    Object.fromEntries([...src.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, v === undefined ? "" : decode(v)]));
  const elements = [];
  for (const m of html.matchAll(/<(input|textarea|select|button)\b([^>]*)>/g)) {
    const attrs = attrsOf(m[2]);
    const rest = html.slice(m.index + m[0].length);
    const el = { tag: m[1], attrs, listeners: {}, getAttribute: (k) => attrs[k] ?? null,
      addEventListener: (type, fn) => { el.listeners[type] = fn; } };
    if (m[1] === "textarea") el.value = decode(rest.slice(0, rest.indexOf("</textarea>")));
    else if (m[1] === "select") {
      const options = [...rest.slice(0, rest.indexOf("</select>")).matchAll(/<option\b([^>]*)>/g)].map((o) => attrsOf(o[1]));
      el.options = options.map((o) => o.value);
      el.value = (options.find((o) => "selected" in o) ?? options[0]).value;
    } else if (m[1] === "button") el.label = decode(rest.slice(0, rest.indexOf("</button>")));
    else if (attrs.type === "checkbox") el.checked = "checked" in attrs;
    else el.value = attrs.value ?? "";
    elements.push(el);
  }
  const posted = [];
  const document = {
    querySelectorAll: (sel) =>
      sel === "[data-field]" ? elements.filter((e) => "data-field" in e.attrs)
      : sel === "button[data-choice]" ? elements.filter((e) => e.tag === "button" && "data-choice" in e.attrs)
      : assert.fail(`unexpected selector ${sel}`),
  };
  const window = { webkit: { messageHandlers: { live: { postMessage: (m) => posted.push(m) } } } };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "the page holds exactly the server's script");
  vm.runInNewContext(scripts[0][1], { window, document });
  const buttons = elements.filter((e) => e.tag === "button");
  return {
    html,
    field: (name) => elements.find((e) => e.attrs["data-field"] === name),
    buttons: buttons.map((b) => b.label),
    // the user clicks button i: the page posts close_and_send
    click(i) {
      buttons[i].listeners.click();
      const msg = posted.at(-1);
      assert.deepEqual([Object.keys(msg), msg.method, typeof msg.params[0]], [["method", "params"], "close_and_send", "string"]);
      return msg.params[0];
    },
  };
}

fixtures.holdDialogs(true);
const evil = '<script>alert("x")</script>';
const confirmForm = {
  title: `Delete ${evil} clips?`,
  message: "12 clips\non Drums & Bass",
  fields: [
    { name: "reason", label: "Why <b>?", default: "tidy", placeholder: '"quoted"' },
    { name: "notes", type: "textarea", default: "</textarea><script>bad()</script>" },
    { name: "count", type: "number", default: 4, min: 1, max: 16, step: 1 },
    { name: "keep_empty", type: "checkbox", label: "Keep empty tracks", default: true },
    { name: "mode", type: "select", options: ["Fast", 'Safe "mode"'], default: 'Safe "mode"' },
  ],
  choices: ["Delete <all>", "Cancel"],
};
const openedForm = await call("show_dialog", { form: confirmForm, wait: false, width: 520, height: 480 });
assert.deepEqual([openedForm.status, openedForm.open_s], ["open", 0]);
assert.match(openedForm.hint, new RegExp(`dialog_result \\{dialog_id: "${openedForm.dialog_id}"\\}`));
assert.deepEqual([calls.dialogs.at(-1).w, calls.dialogs.at(-1).hgt], [520, 480]);
const page = formPage(fixtures.openDialogs()[0]);
// caller text is escaped into text and attribute values, never markup
assert.ok(!page.html.includes(evil) && !page.html.includes("<b>?") && !page.html.includes("</textarea><script>"));
assert.ok(page.html.includes("<h3>Delete &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; clips?</h3>"));
assert.deepEqual(page.buttons, ["Delete <all>", "Cancel"]);
assert.equal(page.field("reason").value, "tidy");
assert.equal(page.field("reason").attrs.placeholder, '"quoted"');
assert.ok("autofocus" in page.field("reason").attrs, "the first field has the focus");
assert.equal(page.field("notes").value, "</textarea><script>bad()</script>");
assert.deepEqual([page.field("count").value, page.field("count").attrs.min, page.field("count").attrs.max], ["4", "1", "16"]);
assert.equal(page.field("keep_empty").checked, true);
assert.deepEqual([page.field("mode").options, page.field("mode").value], [["Fast", 'Safe "mode"'], 'Safe "mode"']);
// Live shows one dialog at a time
await usageError("show_dialog", { html: "<b>2</b>" },
  new RegExp(`A dialog is already open in Live \\(dialog_id "${openedForm.dialog_id}", opened \\d+ s ago\\)`));
// still open: dialog_result reports it at once, or after waiting
let dres = await call("dialog_result", { dialog_id: openedForm.dialog_id, wait_s: 0 });
assert.deepEqual([dres.status, dres.timed_out], ["open", undefined]);
const waitStart2 = Date.now();
dres = await call("dialog_result", { dialog_id: openedForm.dialog_id, wait_s: 1 });
assert.deepEqual([dres.status, dres.timed_out], ["open", true]);
assert.ok(Date.now() - waitStart2 >= 900, "waited wait_s");
await usageError("dialog_result", { wait_s: 51 }, /Input validation error/);
// the user edits the form and clicks "Delete <all>": a waiting dialog_result wakes up with the answer
page.field("reason").value = "cleanup";
page.field("count").value = " 8 ";
page.field("keep_empty").checked = false;
const answer = page.click(0);
const pendingResult = call("dialog_result", { wait_s: 10 }); // default: the last dialog shown
await sleep(100);
fixtures.closeDialog(answer);
dres = await pendingResult;
const formResult = {
  dialog_id: openedForm.dialog_id, status: "closed", choice: "Delete <all>", choice_index: 0,
  values: { reason: "cleanup", notes: "</textarea><script>bad()</script>", count: 8, keep_empty: false, mode: 'Safe "mode"' },
};
assert.deepEqual(dres, formResult);
assert.deepEqual(await call("dialog_result", { dialog_id: openedForm.dialog_id }), formResult, "answers are kept");

// wait:true (the default) blocks until the dialog closes; default buttons OK / Cancel with fields, OK without
const waitingForm = call("show_dialog", { form: { message: "How many bars?", fields: [{ name: "bars", type: "number" }] } });
await dialogShown();
const page2 = formPage(fixtures.openDialogs()[0]);
assert.deepEqual(page2.buttons, ["OK", "Cancel"]);
page2.field("bars").value = "abc"; // not a number: null
fixtures.closeDialog(page2.click(1));
const { dialog_id: barsId, ...bars } = await waitingForm;
assert.match(barsId, /^dialog-\d+$/);
assert.deepEqual(bars, { status: "closed", choice: "Cancel", choice_index: 1, values: { bars: null } });
const waitingNote = call("show_dialog", { form: { title: "Done" } });
await dialogShown();
const page3 = formPage(fixtures.openDialogs()[0]);
assert.deepEqual(page3.buttons, ["OK"]);
fixtures.closeDialog(""); // closed without a button (if Live allows that)
const noAnswer = await waitingNote;
assert.deepEqual([noAnswer.choice, noAnswer.result, noAnswer.values], [null, "", undefined]);
assert.match(noAnswer.problem, /without one of the form's buttons/);
// html dialogs return the page's string as `result`
const waitingHtml = call("show_dialog", { html: "<p>pick</p>" });
await dialogShown();
fixtures.closeDialog("picked: 3");
const { dialog_id: pickId, ...pickedHtml } = await waitingHtml;
assert.deepEqual([pickId.startsWith("dialog-"), pickedHtml], [true, { status: "closed", result: "picked: 3" }]);
// a dialog Live cannot show
const failing = client.callTool({ name: "show_dialog", arguments: { html: "x" } });
await dialogShown();
fixtures.failDialog();
const failed = await failing;
assert.equal(failed.isError, true);
assert.match(failed.content[0].text, /Live could not show the dialog: Live rejected the dialog without details/);
assert.doesNotMatch(failed.content[0].text, /stale/);
const failedLater = await call("show_dialog", { html: "x", wait: false });
fixtures.failDialog();
assert.deepEqual(await call("dialog_result", { dialog_id: failedLater.dialog_id }),
  { dialog_id: failedLater.dialog_id, status: "failed", error: "Live rejected the dialog without details" });
// force: a dialog the user closed without Live reporting it does not block the next one forever
const stuck = await call("show_dialog", { html: "<b>stuck</b>", wait: false });
await usageError("show_dialog", { html: "x", wait: false }, /If the user already closed it, pass force:true/);
const forced = await call("show_dialog", { html: "<b>forced</b>", wait: false, force: true });
fixtures.closeDialog("first");
fixtures.closeDialog("second");
assert.equal((await call("dialog_result", { dialog_id: stuck.dialog_id })).result, "first");
assert.equal((await call("dialog_result")).dialog_id, forced.dialog_id, "default: the last dialog shown");
// the Status dialog counts as open too, but is never "the last dialog shown"
await call("execute_command", { command_id: "ableton-live-mcp.status" });
await usageError("show_dialog", { html: "x" }, /A dialog is already open in Live/);
fixtures.closeDialog("ok");
assert.equal((await call("dialog_result")).dialog_id, forced.dialog_id);
// a client that goes away stops waiting; the dialog stays open and dialog_result still gets its answer
const abortDialog = new AbortController();
const cutOff = fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "POST", signal: abortDialog.signal,
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "show_dialog", arguments: { form: { message: "Still there?" } } } }),
}).catch((e) => e.name);
await dialogShown();
abortDialog.abort();
assert.equal(await cutOff, "AbortError");
assert.equal(fixtures.openDialogs().length, 1, "the dialog stays open in Live");
const lateAnswer = call("dialog_result", { wait_s: 10 });
await sleep(50);
fixtures.closeDialog(formPage(fixtures.openDialogs()[0]).click(0));
assert.deepEqual([(await lateAnswer).status, (await lateAnswer).choice], ["closed", "OK"]);
await usageError("dialog_result", { dialog_id: "dialog-999" }, /No dialog "dialog-999": answers are kept for 10 minutes/);

// progress: a long call whose client asks for it gets notifications/progress on an SSE response
const progressSeen = [];
const withProgress = client.callTool({ name: "show_dialog", arguments: { form: { message: "progress?" } } }, undefined,
  { onprogress: (p) => progressSeen.push(p), resetTimeoutOnProgress: true });
await dialogShown();
await until(() => progressSeen.length > 0, "a progress notification");
await sleep(50);
assert.equal(progressSeen.length, 1, "one progress notification right away");
assert.equal(progressSeen[0].progress, 1);
assert.match(progressSeen[0].message, /^Waiting for the user to close the dialog in Live \(0 s\)$/);
fixtures.closeDialog(JSON.stringify({ choice_index: 0, values: {} }));
const progressResult = await withProgress;
assert.equal(JSON.parse(progressResult.content[0].text).choice, "OK");
fixtures.holdDialogs(false);
// closed answers expire: only the newest 20 are kept
const oldest = await call("show_dialog", { html: "old" });
for (let i = 0; i < 20; i++) await call("show_dialog", { html: `n${i}` });
await usageError("dialog_result", { dialog_id: oldest.dialog_id }, /No dialog/);
await call("dialog_result", { dialog_id: `dialog-${Number(oldest.dialog_id.slice(7)) + 1}` });

// the response mode: JSON, except for a long tool called with a progressToken
const rawToolCall = (name, args, meta) =>
  fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name, arguments: args, _meta: meta } }),
  });
const sseEvents = async (r) =>
  (await r.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
let modeRes = await rawToolCall("song_get", { include: [] }, { progressToken: "t1" });
assert.match(modeRes.headers.get("content-type"), /^application\/json/, "not a long tool: JSON");
assert.equal(typeof JSON.parse((await modeRes.json()).result.content[0].text).tempo, "number");
modeRes = await rawToolCall("selection_wait", { timeout_s: 1 });
assert.match(modeRes.headers.get("content-type"), /^application\/json/, "no progressToken: JSON");
assert.equal(JSON.parse((await modeRes.json()).result.content[0].text).timed_out, true);
modeRes = await rawToolCall("selection_wait", { timeout_s: 1 }, { progressToken: 7 });
assert.match(modeRes.headers.get("content-type"), /^text\/event-stream/);
let events = await sseEvents(modeRes);
assert.deepEqual(events[0], { jsonrpc: "2.0", method: "notifications/progress",
  params: { progressToken: 7, progress: 1, message: "Waiting for the user's selection in Live (0 of 1 s)" } });
assert.deepEqual([events.length, events[1].id], [2, 21]);
assert.equal(JSON.parse(events[1].result.content[0].text).timed_out, true);
modeRes = await rawToolCall("render_track_audio", { track_name: "Drums", start_time: 0, end_time: 1 }, { progressToken: "r" });
events = await sseEvents(modeRes);
assert.match(events[0].params.message, /^Rendering "Drums" \(track_index 1, id \d+\) \(0 s\)$/);
assert.ok(JSON.parse(events.at(-1).result.content[0].text).audio_path.endsWith(".wav"));

// --- batch / batch_read ------------------------------------------------------------
const tracksBeforeBatch = (await tracksNow()).map((t) => t.name);
// a dependent chain no compound tool covers: a track, a clip on it, its notes, a mute
const chain = await call("batch", { steps: [
  { tool: "track_create", args: { type: "midi", name: "Batch Keys" }, as: "keys" },
  { tool: "clip_create", args: { type: "midi", track_id: { $ref: "keys.id" }, start_time: 0, duration: 4, name: "Chords" } },
  { tool: "midi_clip_set_notes", args: { clip_id: { $ref: "1.id" }, patterns: [{ note: "C3", steps: "x..." }], repeat: { length: 1 } } },
  { tool: "track_set", args: { items: [{ track_id: { $ref: "keys.id" }, mute: true }] } },
] });
assert.deepEqual([chain.ok, chain.completed, chain.failed, chain.not_run], [true, 4, undefined, undefined]);
assert.deepEqual(chain.results.map((r) => [r.step, r.tool, r.as]), [[0, "track_create", "keys"], [1, "clip_create", undefined],
  [2, "midi_clip_set_notes", undefined], [3, "track_set", undefined]]);
const keysId = chain.results[0].result.id;
assert.equal(chain.results[1].result.name, "Chords");
assert.equal((await call("midi_clip_get_notes", { clip_id: chain.results[1].result.id })).note_count, 4, "defaults applied (step 0.25, repeat)");
assert.equal((await call("track_get", { track_id: keysId, include: [] })).mute, true);
// batch_read: reads chained by $ref, also into arrays, and whole results
const reads = await call("batch_read", { steps: [
  { tool: "track_get", args: { track_name: "Batch Keys", include: ["arrangement_clips"] }, as: "t" },
  { tool: "clip_get", args: { clip_id: { $ref: "t.arrangement_clips.0.id" } } },
  { tool: "midi_clip_get_notes", args: { clip_id: { $ref: "1.id" }, format: "compact" } },
  { tool: "session_grid", args: { tracks: [{ track_id: { $ref: "t.id" } }, { track_name: "Drums" }] } },
] });
assert.deepEqual([reads.ok, reads.completed], [true, 4]);
assert.equal(reads.results[1].result.name, "Chords");
assert.equal(reads.results[2].result.notes.length, 4);
assert.deepEqual(reads.results[3].result.tracks.map((t) => t.name), ["Batch Keys", "Drums"]);
// everything that can be checked is checked before the first step: nothing runs
const txBatch = calls.transactions.all;
const refusals = [
  [{ steps: [{ tool: "track_set", args: { track_name: "Batch Keys", name: "X" } }, { tool: "nope" }] }, /steps\[1\]: no tool named "nope"/],
  [{ steps: [{ tool: "track_set", args: { track_name: "Batch Keys", name: "X" } },
    { tool: "track_set", args: { track_index: "zero" } }] }, /steps\[1\]: invalid arguments for track_set: track_index: Expected number, received string/],
  [{ steps: [{ tool: "track_set", args: { track_name: "Batch Keys", name: "X" } },
    { tool: "track_get", args: { track_id: { $ref: "2.id" } } }, { tool: "song_get" }] }, /steps\[1\]\.args\.track_id: \$ref "2\.id" names no earlier step/],
  [{ steps: [{ tool: "track_set", args: { track_name: "Batch Keys", name: "X" }, as: "a" },
    { tool: "track_get", args: { track_id: { $ref: "b.id" } } }] }, /\$ref "b\.id" names no earlier step/],
  [{ steps: [{ tool: "track_get", args: { track_id: { $ref: "0.id" } } }] }, /names no earlier step: use the index of a step before step 0/],
  [{ steps: [{ tool: "song_get", as: "a" }, { tool: "song_get", as: "a" }] }, /steps\[1\]: the name "a" is used by step 0/],
  [{ steps: [{ tool: "song_get" }, { tool: "track_get", args: { track_id: { $ref: "0.tracks.0.id", x: 1 } } }] }, /a \$ref is \{"\$ref": "<step>\.<path>"\} with a string and no other keys/],
  [{ steps: [{ tool: "song_get" }, { tool: "track_get", args: { track_id: { $ref: 0 } } }] }, /a \$ref is/],
  [{ steps: [{ tool: "song_get" }, { tool: "track_get", args: { track_id: { $ref: "0..id" } } }] }, /empty path segment/],
  [{ steps: [{ tool: "batch", args: { steps: [] } }] }, /steps\[0\]: batch cannot run inside batch/],
  [{ steps: [{ tool: "show_dialog", args: { html: "x" } }] }, /show_dialog reaches outside the Live Set/],
  [{ steps: [{ tool: "execute_command", args: { command_id: "ableton-live-mcp.status" } }] }, /execute_command reaches outside/],
  [{ steps: [] }, /Input validation error/],
  [{ steps: Array.from({ length: 51 }, () => ({ tool: "song_get" })) }, /Input validation error/],
  [{ steps: [{ tool: "song_get", arguments: {} }] }, /Input validation error/],
  [{ steps: [{ tool: "song_get", as: "1x" }] }, /Input validation error/],
];
for (const [args, pattern] of refusals) await usageError("batch", args, pattern);
await usageError("batch_read", { steps: [{ tool: "song_get" }, { tool: "track_set", args: { track_name: "Batch Keys", mute: false } }] },
  /steps\[1\]: track_set can change the Live Set; batch_read runs read-only tools only \(use batch\)/);
await usageError("batch_read", { steps: [{ tool: "batch_read", args: { steps: [] } }] }, /batch_read cannot run inside batch_read/);
assert.equal(calls.transactions.all, txBatch, "refused batches change nothing");
assert.equal((await call("track_get", { track_id: keysId, include: [] })).name, "Batch Keys");
// at run time: a failing step stops the batch (default), its error as a direct call reports it
const stopped = await call("batch", { steps: [
  { tool: "track_set", args: { track_id: keysId, name: "Batch Keys 2" } },
  { tool: "track_set", args: { track_index: 99, name: "x" } },
  { tool: "track_set", args: { track_id: keysId, name: "never" } },
] });
assert.deepEqual([stopped.ok, stopped.completed, stopped.failed, stopped.not_run], [false, 1, 1, [2]]);
assert.match(stopped.results[1].error, /^track_index 99 out of range/);
assert.doesNotMatch(stopped.results[1].error, /stale/, "argument errors carry no stale-id hint");
assert.equal((await call("track_get", { track_id: keysId, include: [] })).name, "Batch Keys 2");
assert.ok(errorLog.some((l) => /batch steps\[1\] \(track_set\) failed after \d+ ms: track_index 99/.test(l)), "step failures are logged");
// host-side failures carry the stale-id hint; a $ref to a failed step or a missing field fails that step
const continued = await call("batch", { on_error: "continue", steps: [
  { tool: "track_get", args: { track_id: "999999" } },
  { tool: "track_get", args: { track_id: { $ref: "0.id" } } },
  { tool: "song_get", args: { include: [] } },
  { tool: "track_get", args: { track_id: { $ref: "2.tracks.0.id" } } },
  { tool: "track_set", args: { track_id: { $ref: "2.tempo" }, name: "x" } },
] });
assert.deepEqual([continued.ok, continued.completed, continued.failed, continued.not_run], [false, 1, 4, undefined]);
assert.match(continued.results[0].error, /Unknown object id "999999".*stale/s);
assert.match(continued.results[1].error, /steps\[1\]\.args\.track_id: \$ref "0\.id": step 0 failed, so it has no result/);
assert.match(continued.results[3].error, /\$ref "2\.tracks\.0\.id": step 2's result has no "tracks"/);
assert.match(continued.results[4].error, /steps\[4\]: invalid arguments for track_set: track_id: Expected string, received number/);
// batch_read continues by default
const readOn = await call("batch_read", { steps: [{ tool: "track_get", args: { track_index: 99 } }, { tool: "song_get", args: { include: [] } }] });
assert.deepEqual([readOn.ok, readOn.completed, readOn.failed], [false, 1, 1]);
// progress: one notification per step, with the total
const batchProgress = [];
const progressed = await client.callTool({ name: "batch_read", arguments: { steps: [{ tool: "song_get", args: { include: [] } },
  { tool: "selection_get" }] } }, undefined, { onprogress: (p) => batchProgress.push(p) });
assert.equal(JSON.parse(progressed.content[0].text).completed, 2);
assert.deepEqual(batchProgress.map((p) => [p.progress, p.total]), [[0, 2], [1, 2], [2, 2]]);
assert.equal(batchProgress[2].message, "steps[1] (selection_get) done");
await call("track_delete", { track_id: keysId });
assert.deepEqual((await tracksNow()).map((t) => t.name), tracksBeforeBatch);

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
assert.equal(JSON.parse(huge.body).error.code, -32000);
// so is an undeclared (chunked) one once it passes the transport's 4 MiB limit
const chunked = await raw("POST", "/mcp", {
  "content-type": "application/json", accept: "application/json, text/event-stream",
}, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4 * 1024 * 1024) } }));
assert.equal(chunked.status, 413);
assert.match(JSON.parse(chunked.body).error.message, /must not exceed 4194304 bytes/);
// just under the limit is served
const nearLimitBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4 * 1024 * 1024 - 100) } });
assert.ok(nearLimitBody.length <= 4 * 1024 * 1024);
const nearLimit = await raw("POST", "/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream" }, nearLimitBody);
assert.equal(nearLimit.status, 200);
assert.equal(JSON.parse(nearLimit.body).result.tools.length, tools.length);

// a second instance on the same port fails to listen; its Status dialog says why
const storageDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-test-"));
fs.writeFileSync(path.join(storageDir2, "config.json"), JSON.stringify({ port: PORT }));
const second = { dialogs: [], commands: {}, menus: [] };
activate(makeActivation(storageDir2, storageDir2, second));
assert.ok(second.commands["ableton-live-mcp.status"], "status command registered before listen");
assert.equal(second.menus.length, 14, "context-menu entries registered before listen");
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

// "progress_notifications": false in config.json: every response is JSON, also for long calls
const PORT3 = PORT + 1;
const storageDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "ableton-mcp-test-"));
fs.writeFileSync(path.join(storageDir3, "config.json"), JSON.stringify({ port: PORT3, progress_notifications: false }));
const third = { dialogs: [], commands: {}, menus: [] };
const logged = [];
const consoleLog = console.log;
console.log = (...a) => { logged.push(a.map(String).join(" ")); consoleLog(...a); };
activate(makeActivation(storageDir3, storageDir3, third));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT3}/health`)).ok) break;
  } catch {
    if (i > 50) throw new Error("third instance did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
}
console.log = consoleLog;
assert.ok(logged.some((l) => l.includes("progress notifications are off")), "the switch is logged");
const noSse = await fetch(`http://127.0.0.1:${PORT3}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "selection_wait", arguments: { timeout_s: 1 }, _meta: { progressToken: 1 } } }),
});
assert.match(noSse.headers.get("content-type"), /^application\/json/);
assert.equal(JSON.parse((await noSse.json()).result.content[0].text).timed_out, true);
fs.rmSync(storageDir3, { recursive: true, force: true });

await client.close();
fs.rmSync(storageDir, { recursive: true, force: true });
console.log(`OK — ${tools.length} tools, all assertions passed`);
process.exit(0);
