// Smoke test against a REAL running Ableton Live with the extension loaded.
// Creates its own tracks/scenes, verifies behavior, and cleans up after itself.
// Usage: node test/live-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:8722/mcp";
const client = new Client({ name: "live-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};
const step = (msg) => console.log(`  ✓ ${msg}`);

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
const notes = await call("midi_clip_get_notes", { clip_id: clip.id });
assert.equal(notes.notes[0].pitch, 60);
step("one-call session MIDI clip: scene_index target, 3 inline notes, named, colored");

// merge + server-side edit
await call("midi_clip_set_notes", { clip_id: clip.id, mode: "merge", notes: [{ pitch: 42, start_time: 0.5, duration: 0.25 }] });
const edited = await call("midi_clip_edit_notes", { clip_id: clip.id, select: { pitch_min: 42, pitch_max: 42 }, transpose: 12, velocity_scale: 0.8 });
assert.equal(edited.note_count, 4);
assert.equal(edited.changed_count, 1);
const afterEdit = await call("midi_clip_get_notes", { clip_id: clip.id });
assert.ok(afterEdit.notes.some((n) => n.pitch === 54));
step("merge + midi_clip_edit_notes (transpose selected) verified");

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
fs.rmSync(wavPath, { force: true });
step("duplicated + deleted all smoke tracks (cleanup)");

const after = await call("song_get");
assert.equal(after.tracks.length, song.tracks.length);
console.log("LIVE SMOKE OK — set restored to", after.tracks.length, "tracks");
await client.close();
process.exit(0);
