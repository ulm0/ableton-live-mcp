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
assert.equal(tools.length, 46, `expected exactly 46 tools, got ${tools.length}`);

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
    "midi_clip_get_notes", "device_get", "chain_get", "parameter_get", "mixer_get", "render_track_audio",
    "parameter_find", "device_preset_list"]],
  [write(false, true), ["song_set", "track_set", "take_lane_set", "scene_set", "cue_point_set",
    "clip_set", "drum_chain_set", "parameter_set", "mixer_set", "device_set"]],
  [write(false, false), ["track_create", "track_duplicate", "take_lane_create", "scene_create",
    "scene_duplicate", "cue_point_create", "clip_create", "device_insert", "device_duplicate",
    "rack_insert_chain", "import_file"]],
  // device_preset_save may overwrite a preset (overwrite:true)
  [write(true, true), ["track_delete", "scene_delete", "clip_delete", "cue_point_delete",
    "device_delete", "track_clear_clips_in_range", "simpler_replace_sample", "device_preset_save"]],
  // device_copy move deletes the original; device_preset_load replaces a Simpler's sample
  [write(true, false), ["midi_clip_set_notes", "midi_clip_edit_notes", "device_copy", "device_preset_load"]],
  [{ ...write(false, false), openWorldHint: true }, ["show_dialog"]],
  [{ ...write(true, false), openWorldHint: true }, ["execute_command"]],
];
for (const [expected, names] of annotationGroups)
  for (const n of names) assert.deepEqual(toolByName[n]?.annotations, expected, `${n}: annotations`);
assert.equal(new Set(annotationGroups.flatMap(([, n]) => n)).size, 46, "snapshot lists every tool once");

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
await call("simpler_replace_sample", { simpler_device_id: kickSimpler.id, file_path: "/tmp/kick.wav" });
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
