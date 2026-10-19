// Smoke test against a REAL running Ableton Live with the extension loaded.
// Creates its own tracks/scenes, verifies behavior, and cleans up after itself.
// Usage: node test/live-smoke.mjs (MCP_TOKEN=<auth_token> when config.json sets one)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:8722/mcp";
const client = new Client({ name: "live-smoke", version: "1.0.0" });
const headers = process.env.MCP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_TOKEN}` } : undefined;
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers } }));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};
const step = (msg) => console.log(`  ✓ ${msg}`);
// Live applies data-model writes asynchronously; immediate read-back can lag
// by tens of ms. Retry read-based assertions briefly instead of racing.
const eventually = async (fn, tries = 25) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
};

console.log("live smoke vs", URL_);
const song = await call("song_get");
assert.ok(song.tempo > 0 && song.tracks.length >= 1);
step(`song_get: ${song.tracks.length} tracks @ ${song.tempo} bpm, scale ${song.scale.name}`);

// --- MIDI track + device + params ------------------------------------------
const midi = await call("track_create", { type: "midi" });
step(`created MIDI track ${midi.id}`);
await call("track_set", { track_id: midi.id, name: "MCP Smoke" });

const op = await call("device_insert", { target_id: midi.id, device_name: "Operator" });
assert.equal(op.name, "Operator");
const opDetail = await call("device_get", { device_id: op.id });
assert.ok(opDetail.parameters.length > 10);
step(`inserted Operator with ${opDetail.parameters.length} parameters`);

// filtered + valued parameter fetch
const volOnly = await call("device_get", { device_id: op.id, parameter_filter: "volume", include_values: true });
assert.ok(volOnly.parameters.length >= 1 && volOnly.parameters.length < opDetail.parameters.length);
assert.equal(typeof volOnly.parameters[0].value, "number");
step(`parameter_filter "volume" -> ${volOnly.parameters.length} params with values`);

const vol = opDetail.parameters.find((p) => p.name === "Volume") ?? opDetail.parameters[1];
const target = (vol.min + vol.max) / 2;
await call("parameter_set", { values: [{ parameter_id: vol.id, value: target }] });
const [volNow] = await call("parameter_get", { parameter_ids: [vol.id] });
assert.ok(Math.abs(volNow.value - target) < 1e-6);
step(`parameter roundtrip on "${vol.name}" = ${volNow.value}`);

// --- MIDI clip + notes ------------------------------------------------------
// one-call create: track target + scene_index + inline notes + name/color
const clip = await call("clip_create", {
  type: "midi", target_id: midi.id, scene_index: 0, duration: 4,
  name: "Smoke Chord", color: "#00ff88",
  notes: [
    { pitch: 60, start_time: 0, duration: 1, velocity: 100 },
    { pitch: 64, start_time: 1, duration: 1, velocity: 90 },
    { pitch: 67, start_time: 2, duration: 2, velocity: 80, probability: 0.9 },
  ],
});
assert.equal(clip.name, "Smoke Chord");
assert.equal(clip.note_count, 3);
await eventually(async () => {
  const notes = await call("midi_clip_get_notes", { clip_id: clip.id });
  assert.equal(notes.notes[0].pitch, 60);
});
step("one-call session MIDI clip: scene_index target, 3 inline notes, named, colored");

// merge + server-side edit
await call("midi_clip_set_notes", { clip_id: clip.id, mode: "merge", notes: [{ pitch: 42, start_time: 0.5, duration: 0.25 }] });
const edited = await eventually(async () => {
  const r = await call("midi_clip_edit_notes", { clip_id: clip.id, select: { pitch_min: 42, pitch_max: 42 }, transpose: 12, velocity_scale: 0.8 });
  assert.equal(r.note_count, 4);
  assert.equal(r.changed_count, 1);
  return r;
});
await eventually(async () => {
  const afterEdit = await call("midi_clip_get_notes", { clip_id: clip.id });
  assert.ok(afterEdit.notes.some((n) => n.pitch === 54), "transposed note (54) not visible yet");
});
step("merge + midi_clip_edit_notes (transpose selected) verified");

// MIDI shortcuts: a step pattern repeated to fill the 4-beat clip, read back compact
await call("midi_clip_set_notes", { clip_id: clip.id, patterns: [{ note: "C1", steps: "x...x..." }], repeat: { length: 2 } });
await eventually(async () => {
  const r = await call("midi_clip_get_notes", { clip_id: clip.id, format: "compact" });
  assert.deepEqual(r.notes.map((n) => [n[0], n[1]]).sort((a, b) => a[1] - b[1]), [[36, 0], [36, 1], [36, 2], [36, 3]]);
});
step("patterns + repeat fill the clip; compact read");
// Whether Live reports NoteDescription.selected to extensions is not documented:
// report it (select some notes in the clip first to see them counted).
const reportsSelection = (await call("midi_clip_get_notes", { clip_id: clip.id })).notes
  .some((n) => typeof n.selected === "boolean");
const selection = await call("midi_clip_get_notes", { clip_id: clip.id, only_selected: true });
step(`NoteDescription.selected ${reportsSelection ? "is" : "is NOT"} reported; ` +
  `${selection.warning ?? `${selection.note_count} selected note(s)`}`);

// track addressing by name
const byName = await call("track_get", { track_name: "MCP Smoke", include: ["devices"] });
assert.equal(byName.devices.length, 1);
step("track_get by name with include selector");

// arrangement clip
const arr = await call("clip_create", { type: "midi", target_id: midi.id, start_time: 8, duration: 4 });
assert.equal(arr.start_time, 8);
await call("clip_delete", { clip_id: arr.id });
step("arrangement MIDI clip created at beat 8 and deleted");

// --- drum rack + chains (own track: Live allows one instrument per track) ---
const drumTrack = await call("track_create", { type: "midi" });
await call("track_set", { track_id: drumTrack.id, name: "MCP Smoke Drums" });
const rack = await call("device_insert", { target_id: drumTrack.id, device_name: "Drum Rack" });
const chain = await call("rack_insert_chain", { rack_device_id: rack.id, index: 0 });
const chainDetail = await call("chain_get", { chain_id: chain.id });
assert.ok(chainDetail.mixer.volume.id);
if (chainDetail.receiving_note !== undefined) {
  await call("drum_chain_set", { drum_chain_id: chain.id, receiving_note: 36 });
  step("drum rack chain inserted, pad mapped to C1 (36)");
} else {
  step("rack chain inserted (not a drum chain)");
}

// --- mixer ------------------------------------------------------------------
const mixer = await call("mixer_get", { target_id: midi.id });
assert.ok(mixer.volume.id && mixer.panning.id);
assert.match(mixer.volume.hint, /0 dB/);
step(`mixer_get: volume=${mixer.volume.value.toFixed(3)}, ${mixer.sends.length} sends`);

const origVol = mixer.volume.value;
const setMix = await call("mixer_set", { target_id: midi.id, volume: 0.7, panning: -0.2 });
assert.ok(Math.abs(setMix.volume.value - 0.7) < 1e-6);
await call("mixer_set", { target_id: midi.id, volume: origVol, panning: 0 });
step("mixer_set volume+pan roundtrip, restored");

// --- audio: generate wav -> import -> clip -> warp -> render ----------------
const wavPath = path.join(os.tmpdir(), "mcp-smoke-tone.wav");
{
  // minimal 1s 440Hz 16-bit mono 44.1kHz wav
  const sr = 44100, n = sr;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([hdr, data]));
}
const audio = await call("track_create", { type: "audio" });
await call("track_set", { track_id: audio.id, name: "MCP Smoke Audio" });
const aclip = await call("clip_create", {
  type: "audio", target_id: audio.id, start_time: 0, file_path: wavPath,
});
assert.ok(aclip.imported_path);
step(`audio clip from generated wav, imported to ${aclip.imported_path}`);

const warped = await call("clip_set", { clip_id: aclip.id, warping: true, warp_mode: "Tones" });
assert.equal(warped.warp_mode, "Tones");
const aclipDetail = await call("clip_get", { clip_id: aclip.id });
assert.ok(Array.isArray(aclipDetail.warp_markers));
step(`warp mode set to Tones, ${aclipDetail.warp_markers.length} warp markers (clip_get)`);

const render = await call("render_track_audio", { track_id: audio.id, start_time: 0, end_time: 2 });
assert.ok(fs.existsSync(render.audio_path), `rendered audio missing: ${render.audio_path}`);
step(`rendered pre-FX audio: ${render.audio_path} (${fs.statSync(render.audio_path).size} bytes)`);

// --- scenes, cue points, take lanes ----------------------------------------
const scene = await call("scene_create", { index: -1 });
await call("scene_set", { scene_id: scene.id, name: "MCP Scene" });
await call("scene_delete", { scene_id: scene.id });
const cue = await call("cue_point_create", { time: 16 });
await call("cue_point_set", { cue_point_id: cue.id, name: "MCP Cue" });
await call("cue_point_delete", { cue_point_id: cue.id });
const lane = await call("take_lane_create", { track_id: midi.id });
await call("take_lane_set", { take_lane_id: lane.id, name: "MCP Take" });
step("scene, cue point, take lane: create/rename/delete OK");

// --- names, batches, moves: host behaviour the mock can only assume ---------
const named = await call("track_create", {
  type: "midi", name: "MCP Smoke Named", devices: ["Operator", "MCP No Such Device"],
});
const tracksAfterCreate = (await call("song_get", { include: ["tracks"] })).tracks;
assert.equal(named.index, tracksAfterCreate.findIndex((t) => t.id === named.id), "returned index is the track's position");
assert.equal(named.devices[0].name, "Operator");
assert.ok(named.devices[1].error && named.errors.length === 1, "unknown device reported, not thrown");
await eventually(async () =>
  assert.equal((await call("track_get", { track_name: "MCP Smoke Named", include: [] })).id, named.id));
step(`track_create with name + devices landed at index ${named.index}; unknown device reported`);

const scenesBefore = (await call("song_get", { include: ["scenes"] })).scenes.length;
const madeScenes = await call("scene_create", { items: [{ name: "MCP S1" }, { index: 0, name: "MCP S0" }] });
await eventually(async () => {
  const scenes = (await call("song_get", { include: ["scenes"] })).scenes;
  assert.equal(scenes.length, scenesBefore + 2);
  assert.deepEqual([scenes[0].id, scenes[0].name], [madeScenes.items[1].id, "MCP S0"], "index 0 entry first");
  assert.deepEqual([scenes.at(-1).id, scenes.at(-1).name], [madeScenes.items[0].id, "MCP S1"], "appended entry last");
});
for (const sc of madeScenes.items) await call("scene_delete", { scene_id: sc.id });
step("scene_create items: creates applied in call order, then named");

// odd beat positions so a user's own locators are never touched
const cueToMove = await call("cue_point_create", { time: 997.25, name: "MCP Move" });
const movedCue = await call("cue_point_set", { cue_point_id: cueToMove.id, time: 1001.75 });
assert.equal(movedCue.replaced_id, cueToMove.id);
await eventually(async () => {
  const cues = (await call("song_get", { include: ["cue_points"] })).cue_points;
  assert.ok(!cues.some((c) => c.id === cueToMove.id || c.time === 997.25), "old cue point deleted");
  const now = cues.find((c) => c.id === movedCue.id);
  assert.deepEqual([now?.time, now?.name], [1001.75, "MCP Move"]);
});
await call("cue_point_delete", { cue_point_id: movedCue.id });
step("cue_point_set time: re-created at the new beat with its name, old one deleted");

const batchMix = await call("mixer_set", { targets: [{ track_id: midi.id }, { track_name: "MCP Smoke Named" }], panning: 0.25 });
assert.equal(batchMix.items.length, 2);
await call("mixer_set", { targets: [{ track_id: midi.id }, { track_id: named.id }], panning: 0 });
step("mixer_set targets: two tracks in one call, restored");

// --- parameters by name, device on/off, copy/move, presets ------------------
// Host behaviour the mock can only assume: built-in devices have "Device On",
// a quantized value is its value_items index, a fresh Simpler takes a sample.
const opOff = await call("device_set", { track_id: midi.id, device: "Operator", enabled: false });
assert.equal(opOff.on_parameter.name, "Device On", "built-in devices have a Device On parameter");
assert.equal(opOff.on_parameter.fallback, undefined);
await eventually(async () => {
  const [on] = await call("parameter_get", { parameters: [{ track_id: midi.id, device: 0, parameter: "Device On" }] });
  assert.equal(on.value_item, "Off");
});
await call("device_set", { track_id: midi.id, device: "Operator", enabled: true });
step('device_set enabled: Operator switched off and on via "Device On"');

const chooser = (await call("parameter_find", { track_id: midi.id, device: "Operator", limit: 500 })).matches
  .find((m) => m.is_quantized && m.value_items?.length > 2);
assert.ok(chooser, "Operator has a chooser with more than two items");
assert.equal(chooser.min, 0, "quantized parameters start at 0 (value = value_items index)");
const [choiceBefore] = await call("parameter_get", { parameter_ids: [chooser.id] });
const pick = chooser.value_items.find((v) => v.index !== choiceBefore.value);
await call("parameter_set", { values: [{ parameter_id: chooser.id, value_item: pick.name }] });
await eventually(async () => {
  const [now] = await call("parameter_get", { parameter_ids: [chooser.id] });
  assert.deepEqual([now.value, now.value_item], [pick.index, pick.name]);
});
await call("parameter_set", { values: [{ parameter_id: chooser.id, value: choiceBefore.value }] });
step(`value_item: "${chooser.name}" set to "${pick.name}" = index ${pick.index}, restored`);

const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const valuesOf = async (id) =>
  (await call("parameter_find", { device_id: id, include_values: true, include_value_items: false, limit: 500 }))
    .matches.map((m) => [m.name, m.value]);
const af = await call("device_insert", { track_id: midi.id, device_name: "Auto Filter",
  parameters: [{ name: "Device On", value: 0 }] });
const afCopy = await call("device_copy", { device_id: af.id, track_id: audio.id });
assert.equal(afCopy.not_copied, undefined, `not copied: ${JSON.stringify(afCopy.not_copied)}`);
await eventually(async () => {
  const [src, dst] = [await valuesOf(af.id), await valuesOf(afCopy.id)];
  assert.deepEqual(dst.map(([n]) => n), src.map(([n]) => n));
  dst.forEach(([n, v], i) => assert.ok(near(v, src[i][1]), `${n}: ${v} vs ${src[i][1]}`));
});
step(`device_copy: Auto Filter to the audio track, ${afCopy.copied_parameters} values equal`);

const rv = await call("device_insert", { track_id: midi.id, device_name: "Reverb" });
const rvMoved = await call("device_copy", { device_id: rv.id, index: 1, move: true });
assert.equal(rvMoved.moved, true);
await eventually(async () => {
  const names = (await call("track_get", { track_id: midi.id, include: ["devices"] })).devices.map((d) => d.name);
  assert.deepEqual(names, ["Operator", "Reverb", "Auto Filter"]);
});
step("device_copy move: Reverb reordered before Auto Filter");

if (chainDetail.receiving_note !== undefined) {
  const simpler = await call("device_insert", { target_id: chain.id, device_name: "Simpler" });
  await call("simpler_replace_sample", { simpler_device_id: simpler.id, file_path: wavPath });
  const chain2 = await call("rack_insert_chain", { rack_device_id: rack.id, index: 1 });
  await call("drum_chain_set", { drum_chain_id: chain2.id, receiving_note: 38 });
  const simplerCopy = await call("device_copy", { device_id: simpler.id, target_id: chain2.id });
  assert.ok(simplerCopy.sample?.file_path, "replaceSample works on a freshly inserted Simpler");
  const viaPad = await call("parameter_get", { parameters: [
    { track_id: drumTrack.id, device: ["Drum Rack", { pad: 36 }, "Simpler"], parameter: "Device On" }] });
  assert.equal(viaPad[0].device_id, simpler.id);
  step("Simpler copied to a new pad with its sample; pad path addressing resolves");
}

const presetName = `MCP Smoke ${Date.now()}`;
const savedPreset = await call("device_preset_save", { name: presetName, device_id: af.id });
const loadedPreset = await call("device_preset_load", { name: presetName, track_id: audio.id });
assert.equal(loadedPreset.not_applied, undefined, `not applied: ${JSON.stringify(loadedPreset.not_applied)}`);
assert.ok((await call("device_preset_list")).presets.some((p) => p.name === presetName));
fs.rmSync(path.join(savedPreset.directory, `${presetName}.json`), { force: true });
step(`device preset saved to ${savedPreset.directory}, loaded as a new device, removed`);

// --- whole-set reads and locations: canonical parents the mock can only assume
const clipLoc = (await call("clip_get", { clip_id: clip.id })).location;
assert.deepEqual([clipLoc?.view, clipLoc?.track_id, clipLoc?.scene_index], ["session", midi.id, 0],
  `clip location (ClipSlot -> Track parents): ${JSON.stringify(clipLoc)}`);
const aclipLoc = (await call("clip_get", { clip_id: aclip.id })).location;
assert.deepEqual([aclipLoc?.view, aclipLoc?.track_id], ["arrangement", audio.id], `arrangement clip location: ${JSON.stringify(aclipLoc)}`);
const rackLoc = (await call("device_get", { device_id: rack.id })).location;
assert.equal(rackLoc?.track_id, drumTrack.id, `device location (Device -> Track parent): ${JSON.stringify(rackLoc)}`);
const chainLoc = (await call("chain_get", { chain_id: chain.id })).location;
assert.equal(chainLoc?.rack_device_id, rack.id, `chain location (Chain -> RackDevice parent): ${JSON.stringify(chainLoc)}`);
step(`locations: session clip in scene "${clipLoc.scene_name}", chain at "${chainLoc.path}"`);
const deepSong = await call("song_get", { include: ["devices", "mixer", "clips"] });
const smokeRow = deepSong.tracks.find((t) => t.id === midi.id);
assert.ok(smokeRow.devices.length >= 1 && smokeRow.mixer && smokeRow.clips.session.some((c) => c.id === clip.id));
const groupCount = deepSong.tracks.filter((t) => t.type === "group").length;
step(`song_get deep: ${deepSong.tracks.length} tracks (${groupCount} group tracks), ` +
  `${smokeRow.devices[0].name} enabled=${smokeRow.devices[0].enabled}, truncated=${JSON.stringify(deepSong.truncated ?? null)}`);
const sceneRow = await call("scene_get", { scene_index: 0 });
assert.ok(sceneRow.slots.some((s) => s.clip?.id === clip.id));
const smokeGrid = await call("session_grid", { scene_index_max: 3 });
const smokeArr = await call("arrangement_get", { start_time: 0, end_time: 8, tracks: [{ track_id: audio.id }] });
assert.ok(smokeArr.tracks[0].clips.some((c) => c.id === aclip.id));
const smokeAudit = await call("song_audit");
step(`scene_get, session_grid (${smokeGrid.clip_count} clips in scenes 0-3), arrangement_get ` +
  `(song_end ${smokeArr.song_end}), song_audit (${smokeAudit.issue_count} issues: ${JSON.stringify(smokeAudit.counts)})`);
// The selection arrives only through "MCP: Use as selection" (right-click in Live): report what is there.
const lastSelection = await call("selection_get");
step(`selection_get: ${lastSelection.captured
  ? `seq ${lastSelection.seq} from ${lastSelection.scope}: ${JSON.stringify(lastSelection.items ?? lastSelection.lanes).slice(0, 200)}`
  : 'nothing captured yet (right-click a clip -> "MCP: Use as selection", then rerun)'}`);

// --- samples, kits, copies, renders: host behaviour the mock can only assume -
// drum_kit_build: insertChain on a Drum Rack yields DrumChains, a fresh Simpler takes a sample
const kitSmoke = await call("track_create", { type: "midi", name: "MCP Smoke Kit" });
const kitBuilt = await call("drum_kit_build", { track_id: kitSmoke.id, pads: [
  { note: "C1", sample_path: wavPath, volume: 0.7 }, { note: "D1", sample_path: wavPath, panning: -0.3 }] });
assert.equal(kitBuilt.errors, undefined, `kit errors: ${JSON.stringify(kitBuilt.errors)}`);
assert.ok(kitBuilt.rack_created && kitBuilt.pads.every((p) => p.chain_created && p.simpler_created && p.sample?.file_path));
await eventually(async () => {
  const rackNow = await call("device_get", { device_id: kitBuilt.rack_device_id, include_chain_devices: true });
  assert.deepEqual(rackNow.chains.map((c) => c.receiving_note).sort(), [36, 38]);
  assert.ok(rackNow.chains.every((c) => c.devices[0]?.sample?.file_path), "every pad has its sample");
});
step(`drum_kit_build: Drum Rack with pads C1, D1 (DrumChains, Simplers, imported samples: ${kitBuilt.pads[0].imported_path})`);

// render analysis: the generated tone (16-bit, 12000 / 32768 = -8.7 dBFS) is what the clip plays
const analyzed = await call("render_track_audio", { track_id: audio.id, start_time: 0, end_time: 2, analyze: true });
assert.ok(analyzed.analysis, `the render could not be analyzed: ${analyzed.analysis_error}`);
assert.equal(analyzed.analysis.silent, false, "the render holds the clip's tone");
const an = analyzed.analysis;
step(`render analysis: ${an.format} ${an.bits_per_sample}-bit, ${an.channels} ch, ${an.sample_rate} Hz, ` +
  `${an.duration_s} s, peak ${an.peak_dbfs} dBFS, rms ${an.rms_dbfs} dBFS, ${an.clipped_samples} clipped`);

// clip_copy: MIDI notes re-based into the arrangement; audio re-created with its markers
const midiCopy = await call("clip_copy", { clip_id: clip.id, track_id: midi.id, start_time: 64 });
await eventually(async () => {
  const [src, dst] = [await call("midi_clip_get_notes", { clip_id: clip.id }), await call("midi_clip_get_notes", { clip_id: midiCopy.id })];
  assert.equal(dst.note_count, src.note_count);
});
const audioCopy = await call("clip_copy", { clip_id: aclip.id, track_id: audio.id, start_time: 64 });
step(`clip_copy: MIDI copy at beat 64 (${midiCopy.note_count} notes); audio copy warp_markers_match=` +
  `${audioCopy.warp_markers_match}, differs=${JSON.stringify(audioCopy.differs ?? null)}`);

// arrangement_copy_range: overwrite 96-100 on the smoke tracks with 64-68
const copiedRange = await call("arrangement_copy_range", { start_time: 64, end_time: 68, to_time: 96,
  tracks: [{ track_id: midi.id }, { track_id: audio.id }] });
assert.equal(copiedRange.errors, undefined, JSON.stringify(copiedRange.errors));
await eventually(async () => {
  const at96 = await call("arrangement_get", { start_time: 96, end_time: 100, tracks: [{ track_id: midi.id }, { track_id: audio.id }] });
  assert.ok(at96.tracks.every((t) => t.clips.length >= 1), "both tracks have a copy at beat 96");
});
step(`arrangement_copy_range: ${copiedRange.copied_count} clips copied, ${copiedRange.skipped_count} skipped`);

// audio_track_consolidate: the copies at 96 become one unwarped clip
const consolidated = await call("audio_track_consolidate", { track_id: audio.id, start_time: 96, end_time: 100, name: "MCP Consolidated" });
assert.equal(consolidated.warping, false);
await eventually(async () => {
  const at96 = await call("arrangement_get", { start_time: 96, end_time: 100, tracks: [{ track_id: audio.id }] });
  assert.deepEqual(at96.tracks[0].clips.map((c) => c.id), [consolidated.id]);
});
step(`audio_track_consolidate: one unwarped clip ${consolidated.start_time}-${consolidated.end_time} from ${consolidated.imported_path}`);

const samples = await call("sample_search", { query: "wav", limit: 3, time_limit_s: 2 });
step(`sample_search: roots ${samples.roots.filter((r) => r.exists).map((r) => r.name).join(", ") || "none"}; ` +
  `${samples.results.length} results (complete=${samples.complete})`);

// --- progress on SSE responses, batches: the host path the bare VM test can only approximate
// A long call with a progressToken is the one request answered as an SSE stream: a progress
// notification, then the result. If this fails, set "progress_notifications": false.
const sseRes = await fetch(URL_, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "render_track_audio",
    arguments: { track_id: audio.id, start_time: 0, end_time: 2 }, _meta: { progressToken: "smoke" } } }),
});
assert.match(sseRes.headers.get("content-type"), /^text\/event-stream/);
const sseEvents = (await sseRes.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
assert.equal(sseEvents[0].method, "notifications/progress");
assert.ok(JSON.parse(sseEvents.at(-1).result.content[0].text).audio_path, "SSE result");
const progressed = [];
const viaClient = await client.callTool({ name: "selection_wait", arguments: { timeout_s: 1 } }, undefined,
  { onprogress: (p) => progressed.push(p) });
assert.equal(JSON.parse(viaClient.content[0].text).timed_out, true);
assert.ok(progressed.length >= 1, "the SDK client received progress");
step(`SSE progress responses work in Live (${sseEvents.length} events, ${progressed.length} via the client)`);
const chained = await call("batch", { steps: [
  { tool: "track_create", args: { type: "midi", name: "MCP Smoke Batch" }, as: "t" },
  { tool: "clip_create", args: { type: "midi", track_id: { $ref: "t.id" }, start_time: 0, duration: 4,
    patterns: [{ note: "C1", steps: "x...x...x...x..." }] } },
  { tool: "track_delete", args: { track_id: { $ref: "t.id" } } },
] });
assert.deepEqual([chained.ok, chained.completed], [true, 3], JSON.stringify(chained));
step("batch: create, clip by $ref, delete");

// --- resources and prompts ----------------------------------------------------
const songResource = JSON.parse((await client.readResource({ uri: "live://song" })).contents[0].text);
assert.equal(songResource.tracks.length, song.tracks.length);
const firstName = song.tracks[0].name;
const trackResource = await client.readResource({ uri: `live://tracks/${encodeURIComponent(firstName)}` }).catch((e) => e);
// a name several tracks share is ambiguous: an error that lists them
assert.ok(trackResource.contents || /Ambiguous/.test(trackResource.message), String(trackResource.message));
assert.match((await client.readResource({ uri: "live://guide" })).contents[0].text, /^# Ableton Live via MCP/);
const chordPrompt = (await client.getPrompt({ name: "chord_progression", arguments: {} })).messages[0].content.text;
assert.match(chordPrompt, /Key: .*Live's current scale/, "the prompt reads Live's scale");
// the prompt's default instrument, which the API only takes by name
const driftTrack = await call("track_create", { type: "midi", name: "MCP Smoke Drift", devices: ["Drift"] });
assert.equal(driftTrack.errors, undefined, `Drift could not be inserted: ${JSON.stringify(driftTrack.errors)}`);
await call("track_delete", { track_id: driftTrack.id });
step(`resources live://song, live://tracks/..., live://guide; chord_progression in ${song.scale.name}; Drift inserts`);

// --- tempo ------------------------------------------------------------------
const origTempo = song.tempo;
await call("song_set", { tempo: origTempo + 5 });
assert.equal((await call("song_get")).tempo, origTempo + 5);
await call("song_set", { tempo: origTempo });
step("tempo set and restored");

// --- duplicate + cleanup ----------------------------------------------------
const dup = await call("track_duplicate", { track_id: midi.id });
await call("track_delete", { track_id: dup.id });
await call("track_delete", { track_id: midi.id });
await call("track_delete", { track_id: drumTrack.id });
await call("track_delete", { track_id: audio.id });
await call("track_delete", { track_id: named.id });
await call("track_delete", { track_id: kitSmoke.id });
fs.rmSync(wavPath, { force: true });
step("duplicated + deleted all smoke tracks (cleanup)");

const after = await call("song_get");
assert.equal(after.tracks.length, song.tracks.length);
console.log("LIVE SMOKE OK — set restored to", after.tracks.length, "tracks");
await client.close();
process.exit(0);
