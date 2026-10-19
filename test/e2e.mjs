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
