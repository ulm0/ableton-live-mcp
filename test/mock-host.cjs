// Mock Extension Host implementing the ExtensionsApi_1_0_0 surface with a tiny
// in-memory Live Set: 1 MIDI track, 1 audio track, 1 return, main, 2 scenes,
// 1 cue point. Enough to E2E-test the MCP pipeline without Ableton Live.
"use strict";

const fs = require("node:fs");

let nextId = 1n;
const objects = new Map(); // idString -> mock object

function make(classes, props) {
  const handle = { id: nextId++ };
  const obj = { handle, classes, ...props };
  objects.set(handle.id.toString(), obj);
  return obj;
}
const get = (h) => {
  const o = objects.get(h.id.toString());
  if (!o) throw new Error(`mock: unknown handle ${h.id}`);
  return o;
};

function makeParam(name, opts = {}) {
  return make(["DeviceParameter"], {
    name,
    min: opts.min ?? 0,
    max: opts.max ?? 1,
    def: opts.def ?? 0.5,
    quantized: opts.quantized ?? false,
    valueItems: opts.valueItems ?? [],
    value: opts.value ?? 0.5,
  });
}
function makeMixer(cls, sendCount) {
  return make([cls], {
    volume: makeParam("Volume", { max: 1, value: 0.85 }),
    panning: makeParam("Panning", { min: -1, max: 1, value: 0 }),
    sends: Array.from({ length: sendCount }, (_, i) =>
      makeParam(`Send ${String.fromCharCode(65 + i)}`, { value: 0 }),
    ),
  });
}

// --- build the set ---------------------------------------------------------
const app = make(["Application"], {});
const songObj = make(["Song"], {
  tempo: 120,
  grid: 6,
  gridTriplet: false,
  rootNote: 0n,
  scaleName: "Major",
  scaleMode: false,
  scaleIntervals: [0n, 2n, 4n, 5n, 7n, 9n, 11n],
});

const opParams = [makeParam("Osc-A Level"), makeParam("Filter Freq", { max: 135, value: 60 })];
const operatorDev = make(["Device"], { name: "Operator", params: opParams });
// parentObj wired to the midi track after it is created below

const midiClip = make(["MidiClip", "Clip"], {
  name: "Bassline",
  startTime: 0, endTime: 4, startMarker: 0, endMarker: 4,
  looping: true, loopStart: 0, loopEnd: 4, color: 0xff5500, muted: false,
  notes: [
    { pitch: 36, startTime: 0, duration: 1, velocity: 100 },
    { pitch: 43, startTime: 2, duration: 0.5, velocity: 90 },
  ],
});

// Canonical parents (DataModelObject.parent), as in Live's object model: a
// clip slot's is its track, a track's the song, a sample's its Simpler; clips,
// devices, chains and take lanes set theirs where they are created.
function makeSlot(clip, track) {
  return make(["ClipSlot"], { clip: clip ?? null, parentObj: track });
}
// A regular track has one clip slot per scene (index-aligned with Song.scenes).
function makeTrack(classes, name, extra = {}) {
  const t = make(classes, {
    name, mute: false, solo: false, arm: false,
    slots: [], takeLanes: [], arrClips: [], devices: [],
    mixer: makeMixer("MixerDevice", songObj.returns.length), group: null, parentObj: songObj, ...extra,
  });
  t.slots = songObj.scenes.map(() => makeSlot(null, t));
  return t;
}
const midiTrack = make(["MidiTrack", "Track"], {
  name: "Bass", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [operatorDev],
  mixer: makeMixer("MixerDevice", 1), group: null, parentObj: songObj,
});
const midiSlots = [makeSlot(midiClip, midiTrack), makeSlot(null, midiTrack)];
midiTrack.slots = midiSlots;
midiClip.parentSlot = midiSlots[0];
operatorDev.parentObj = midiTrack;

const audioTrack = make(["AudioTrack", "Track"], {
  name: "Drums", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 1), group: null, parentObj: songObj,
});
audioTrack.slots = [makeSlot(null, audioTrack), makeSlot(null, audioTrack)];
const returnTrack = make(["Track"], {
  name: "A-Reverb", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 0), group: null, parentObj: songObj,
});
const mainTrack = make(["Track"], {
  name: "Main", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 0), group: null, parentObj: songObj,
});
songObj.tracks = [midiTrack, audioTrack];
songObj.returns = [returnTrack];
songObj.main = mainTrack;
songObj.scenes = [
  make(["Scene"], { name: "Intro", tempo: 120, sigN: 4, sigD: 4 }),
  make(["Scene"], { name: "Drop", tempo: 120, sigN: 4, sigD: 4 }),
];
songObj.cues = [make(["CuePoint"], { name: "Start", time: 0 })];

// Built-in device names the mock can insert, with their parameters. The API
// only gives names, ranges and value items; a quantized parameter's value is
// its value_items index.
const items = (...names) => names.map((name) => ({ name, shortName: name.slice(0, 4) }));
const deviceOn = () => makeParam("Device On", { quantized: true, value: 1, def: 1, max: 1, valueItems: items("Off", "On") });
const BUILTIN_DEVICES = {
  "Operator": () => [deviceOn(), makeParam("Osc-A Level")],
  "Reverb": () => [deviceOn(), makeParam("Dry/Wet")],
  "Auto Filter": () => [
    deviceOn(), makeParam("Frequency", { min: 20, max: 135, value: 135, def: 135 }), makeParam("Resonance"),
    makeParam("Filter Type", { quantized: true, max: 3, value: 0, def: 0,
      valueItems: items("Lowpass", "Highpass", "Bandpass", "Notch") }),
  ],
  "Compressor": () => [deviceOn(), makeParam("Threshold"), makeParam("Ratio", { min: 1, max: 100, value: 4, def: 4 })],
  // two parameters share a name, as some Live devices' parameters do
  "EQ Eight": () => [deviceOn(), makeParam("Frequency", { value: 0.2 }), makeParam("Frequency", { value: 0.8 })],
  "Utility": () => [deviceOn(), makeParam("Gain")],
  "Drum Rack": () => [deviceOn()],
  "Instrument Rack": () => [deviceOn()],
  "Simpler": () => [deviceOn(), makeParam("Volume", { value: 0.7, def: 0.7 }),
    makeParam("Transpose", { min: -48, max: 48, value: 0, def: 0 })],
  // "Device On" is a naming convention only: this one's switch is named otherwise
  "Switch Fx": () => [
    makeParam("Active", { quantized: true, value: 1, def: 1, max: 1, valueItems: items("Off", "On") }),
    makeParam("Amount"),
  ],
};
// Parameter names whose writes the host refuses (fixtures.refuseWrites), and
// whether Simpler sample loads fail (fixtures.refuseSamples).
const refusedWrites = new Set();
let refuseSamples = false;

// Drum Racks whose new chains are plain Chains (fixtures.plainChains): the SDK
// types insertChain as returning Chain, so the server must check.
let plainChains = false;
// Whether importIntoProject fails (fixtures.refuseImports).
let refuseImports = false;

// --- audio files -------------------------------------------------------------
// A file's natural length in beats, for the files the mock renders (and their
// imported copies); any other file counts as 4 beats long.
const fileBeats = new Map();
const naturalBeats = (file) => fileBeats.get(file) ?? 4;

// Where a clip is in its own time after `p` beats of playback from its start
// marker: through the marker region, or into the loop and around it.
function clipTimeAt(c, p) {
  if (!c.looping) return c.startMarker + p;
  const pre = Math.max(0, c.loopEnd - c.startMarker);
  if (p < pre) return c.startMarker + p;
  return c.loopStart + ((p - pre) % (c.loopEnd - c.loopStart));
}

// The region and length of a new audio clip, by AudioTrack.createAudioClip's
// rules (index.d.mts ClipLoopSettings); null when the API rejects the args.
function audioClipFields(args, withDuration) {
  const ls = args.loopSettings;
  if (ls) {
    if (args.isWarped === undefined) return null;
    if (ls.startMarker > ls.endMarker) return null;
    if (ls.loopEnd - ls.loopStart < 0.25) return null;
    if (!ls.looping && (ls.loopStart !== ls.startMarker || ls.loopEnd !== ls.endMarker)) return null;
    const positions = [ls.startMarker, ls.endMarker, ls.loopStart, ls.loopEnd];
    if (args.isWarped === false && (ls.looping || positions.some((v) => v < 0))) return null;
  }
  const natural = naturalBeats(args.filePath);
  const region = ls
    ? { looping: ls.looping, startMarker: ls.startMarker, endMarker: ls.endMarker, loopStart: ls.loopStart, loopEnd: ls.loopEnd }
    : { looping: false, startMarker: 0, endMarker: natural, loopStart: 0, loopEnd: natural };
  // the duration is capped at the region for non-looping clips; looping ones repeat to fill it
  const own = region.looping ? region.loopEnd - region.loopStart : region.endMarker - region.startMarker;
  const length = withDuration && args.duration !== undefined
    ? (region.looping ? args.duration : Math.min(args.duration, own))
    : own;
  return { ...region, length, warping: !!args.isWarped };
}
function makeAudioClip(args, startTime, withDuration) {
  const f = audioClipFields(args, withDuration);
  if (!f) return null;
  return make(["AudioClip", "Clip"], {
    name: "", startTime, endTime: startTime + f.length,
    startMarker: f.startMarker, endMarker: f.endMarker, looping: f.looping, loopStart: f.loopStart, loopEnd: f.loopEnd,
    color: 0, muted: false, filePath: args.filePath, warping: f.warping, warpMode: 0, warpMarkers: [],
  });
}

// WAV files as renderPreFxAudio writes them (fixtures.renderFormat): PCM
// 8/16/24/32-bit or IEEE float 32/64, optionally WAVE_FORMAT_EXTENSIBLE, and
// optionally with a LIST chunk (odd-sized, so padded) before the data, or
// not a WAV at all (garbage).
let renderFormat = { sampleRate: 8000, channels: 2, bits: 32, float: true, extensible: false, listChunk: false };
// The level of a track's render where its arrangement clips play (fixtures.renderLevel).
const renderLevels = new Map();
function writeWav(file, fmt, frames, sampleAt) {
  const bytes = fmt.bits / 8;
  const block = bytes * fmt.channels;
  const data = Buffer.alloc(frames * block);
  const full = 2 ** (fmt.bits - 1);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < fmt.channels; ch++) {
      const v = sampleAt(f, ch);
      const at = f * block + ch * bytes;
      if (fmt.float) {
        if (fmt.bits === 32) data.writeFloatLE(v, at);
        else data.writeDoubleLE(v, at);
        continue;
      }
      const code = Math.max(-full, Math.min(full - 1, Math.round(v * (full - 1))));
      if (fmt.bits === 8) data.writeUInt8(code + 128, at);
      else if (fmt.bits === 16) data.writeInt16LE(code, at);
      else if (fmt.bits === 24) data.writeIntLE(code, at, 3);
      else data.writeInt32LE(code, at);
    }
  const code = fmt.float ? 3 : 1;
  const fmtBody = Buffer.alloc(fmt.extensible ? 40 : 16);
  fmtBody.writeUInt16LE(fmt.extensible ? 0xfffe : code, 0);
  fmtBody.writeUInt16LE(fmt.channels, 2);
  fmtBody.writeUInt32LE(fmt.sampleRate, 4);
  fmtBody.writeUInt32LE(fmt.sampleRate * block, 8);
  fmtBody.writeUInt16LE(block, 12);
  fmtBody.writeUInt16LE(fmt.bits, 14);
  if (fmt.extensible) {
    fmtBody.writeUInt16LE(22, 16);
    fmtBody.writeUInt16LE(fmt.bits, 18);
    fmtBody.writeUInt32LE(fmt.channels === 2 ? 3 : 4, 20);
    // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT: the format code, then a fixed GUID tail
    fmtBody.writeUInt16LE(code, 24);
    Buffer.from("000000001000800000aa00389b71", "hex").copy(fmtBody, 26);
  }
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const chunks = [chunk("fmt ", fmtBody)];
  if (fmt.listChunk) chunks.push(chunk("LIST", Buffer.from("INFOISFT\x05\x00\x00\x00mock\x00", "latin1")));
  chunks.push(chunk("data", data));
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  fs.writeFileSync(file, Buffer.concat([riff, body]));
}
let renders = 0;
// Pre-FX render of a track: a 440 Hz tone (the right channel 6 dB lower)
// where its unmuted arrangement clips play, silence elsewhere.
function renderTrack(tempDir, track, start, end) {
  const fmt = renderFormat;
  const seconds = ((end - start) * 60) / songObj.tempo;
  const frames = Math.round(seconds * fmt.sampleRate);
  const level = renderLevels.get(track.handle.id.toString()) ?? 0.5;
  const clips = track.arrClips.filter((c) => !c.muted);
  const file = `${tempDir}/render-${track.handle.id}-${++renders}.wav`;
  fileBeats.set(file, end - start);
  // a file that is not a WAV at all (fixtures.renderFormat({garbage: true}))
  if (fmt.garbage) return fs.writeFileSync(file, "not a wav file"), file;
  writeWav(file, fmt, frames, (f, ch) => {
    const t = f / fmt.sampleRate;
    const beat = start + (t * songObj.tempo) / 60;
    if (!clips.some((c) => c.startTime <= beat && beat < c.endTime)) return 0;
    return level * (ch === 0 ? 1 : 0.5) * Math.sin(2 * Math.PI * 440 * t);
  });
  return file;
}

let selectedTrack = null;
function insertAfterSelection(song, track) {
  const i = selectedTrack ? song.tracks.indexOf(selectedTrack) : -1;
  i < 0 ? song.tracks.push(track) : song.tracks.splice(i + 1, 0, track);
}

// --- api modules -----------------------------------------------------------
// The context-menu scopes of API 1.0.0 (index.d.mts ContextMenuScope), and the
// argument each passes to its command: the clicked object's handle, or a
// selection.
const HANDLE_SCOPES = ["AudioClip", "AudioTrack", "ClipSlot", "DrumRack", "MidiClip", "MidiTrack", "Sample", "Scene", "Simpler"];
const SELECTION_SCOPES = ["ClipSlotSelection", "AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"];

// What the extension asked the host to do. `transactions.outer` counts
// outermost withinTransaction calls — the undo steps a user would see, since
// nested transactions collapse into the outermost one (index.d.mts
// withinTransaction); `transactions.all` also counts the nested ones that the
// SDK opens around every setter and async operation.
const calls = { dialogs: [], commands: {}, menus: [], imports: [], transactions: { outer: 0, all: 0 } };
let transactionDepth = 0;
// Modal dialogs (index.d.mts showModalDialog): by default the user closes each
// one at once with "mock-dialog-result"; with holdDialogs they stay open until
// a fixture closes them, as a real dialog does until the user clicks.
let holdDialogs = false;
const openDialogs = [];

const dataModel = {
  getObjectIsOfClass: (h, cls) => get(h).classes.includes(cls),
  getObjectCanonicalParent: (h) => {
    const o = get(h);
    const parent = o.parentSlot ?? o.parentTrack ?? o.parentObj;
    return parent ? parent.handle : null;
  },
  getRoot: () => app.handle,
  rootGetSong: () => songObj.handle,
  songGetTempo: (h) => get(h).tempo,
  songSetTempo: (h, t) => { get(h).tempo = t; },
  songGetTracks: (h) => get(h).tracks.map((t) => t.handle),
  songGetReturnTracks: (h) => get(h).returns.map((t) => t.handle),
  songGetMainTrack: (h) => get(h).main.handle,
  songGetGridQuantization: (h) => get(h).grid,
  songGetGridIsTriplet: (h) => get(h).gridTriplet,
  songGetRootNote: (h) => get(h).rootNote,
  songGetScaleName: (h) => get(h).scaleName,
  songGetScaleMode: (h) => get(h).scaleMode,
  songGetScaleIntervals: (h) => get(h).scaleIntervals,
  songGetScenes: (h) => get(h).scenes.map((s) => s.handle),
  songGetCuePoints: (h) => get(h).cues.map((c) => c.handle),
  // "Inserted after the last selected track, or appended if no track is
  // selected" (Song.createMidiTrack): tests select a track via selectTrack().
  songCreateMidiTrack: (h, ok) => {
    const t = makeTrack(["MidiTrack", "Track"], "New MIDI");
    insertAfterSelection(get(h), t);
    ok(t.handle);
  },
  songCreateAudioTrack: (h, ok) => {
    const t = makeTrack(["AudioTrack", "Track"], "New Audio");
    insertAfterSelection(get(h), t);
    ok(t.handle);
  },
  // Deleting a group track deletes the tracks inside it too, as in Live.
  songDeleteTrack: (h, th, ok) => {
    const s = get(h);
    const inside = (t) => t.handle.id === th.id || (t.group !== null && inside(t.group));
    for (const t of s.tracks.filter(inside)) objects.delete(t.handle.id.toString());
    s.tracks = s.tracks.filter((t) => !inside(t));
    ok();
  },
  // Scenes and the tracks' clip slots stay index-aligned, as in Live.
  songCreateScene: (h, index, ok, err) => {
    const s = get(h);
    const i = Number(index);
    if (i < -1 || i > s.scenes.length) return err(); // the host rejects without details
    const sc = make(["Scene"], { name: "", tempo: 120, sigN: 4, sigD: 4 });
    const at = i < 0 ? s.scenes.length : i;
    s.scenes.splice(at, 0, sc);
    for (const t of s.tracks) t.slots.splice(at, 0, makeSlot(null, t));
    ok(sc.handle);
  },
  songDeleteScene: (h, sh, ok) => {
    const s = get(h);
    const at = s.scenes.findIndex((x) => x.handle.id === sh.id);
    s.scenes.splice(at, 1);
    for (const t of s.tracks) t.slots.splice(at, 1);
    objects.delete(sh.id.toString());
    ok();
  },
  songDuplicateTrack: (h, th, ok) => {
    const src = get(th);
    const t = makeTrack([...src.classes], src.name + " Copy", {
      mute: src.mute, solo: src.solo, arm: src.arm, group: src.group,
    });
    const s = get(h);
    s.tracks.splice(s.tracks.findIndex((x) => x.handle.id === th.id) + 1, 0, t);
    ok(t.handle);
  },
  songDuplicateScene: (h, sh, ok) => {
    const src = get(sh);
    const sc = make(["Scene"], { name: src.name + " Copy", tempo: src.tempo, sigN: src.sigN, sigD: src.sigD });
    const s = get(h);
    const at = s.scenes.findIndex((x) => x.handle.id === sh.id) + 1;
    s.scenes.splice(at, 0, sc);
    for (const t of s.tracks) t.slots.splice(at, 0, makeSlot(null, t));
    ok(sc.handle);
  },
  // Arrangement positions start at 0: the mock rejects earlier ones (without
  // an error value, like most host rejections).
  songCreateCuePoint: (h, time, ok, err) => {
    if (time < 0) return err();
    const c = make(["CuePoint"], { name: "Locator", time });
    get(h).cues.push(c);
    ok(c.handle);
  },
  songDeleteCuePoint: (h, ch, ok) => {
    const s = get(h);
    s.cues = s.cues.filter((x) => x.handle.id !== ch.id);
    objects.delete(ch.id.toString());
    ok();
  },
  trackGetName: (h) => get(h).name,
  trackSetName: (h, v) => { get(h).name = v; },
  trackGetMute: (h) => get(h).mute,
  trackSetMute: (h, v) => { get(h).mute = v; },
  trackGetSolo: (h) => get(h).solo,
  trackSetSolo: (h, v) => { get(h).solo = v; },
  trackGetMutedViaSolo: () => false,
  trackGetArm: (h) => get(h).arm,
  trackSetArm: (h, v) => { get(h).arm = v; },
  trackGetGroupTrack: (h) => (get(h).group ? get(h).group.handle : null),
  trackGetClipSlots: (h) => get(h).slots.map((s) => s.handle),
  trackGetTakeLanes: (h) => get(h).takeLanes.map((l) => l.handle),
  trackGetArrangementClips: (h) => get(h).arrClips.map((c) => c.handle),
  trackGetDevices: (h) => get(h).devices.map((d) => d.handle),
  trackGetMixerDevice: (h) => get(h).mixer.handle,
  trackCreateTakeLane: (h, ok) => {
    const lane = make(["TakeLane"], { name: "Take 1", clips: [] });
    lane.parentObj = get(h);
    get(h).takeLanes.push(lane);
    ok(lane.handle);
  },
  trackCreateMidiClip: (h, start, dur, ok) => {
    const c = make(["MidiClip", "Clip"], {
      name: "", startTime: start, endTime: start + dur, startMarker: 0, endMarker: dur,
      looping: false, loopStart: 0, loopEnd: dur, color: 0, muted: false, notes: [],
    });
    c.parentTrack = get(h);
    get(h).arrClips.push(c);
    ok(c.handle);
  },
  // Audio clips follow createAudioClip's rules (audioClipFields): arguments
  // the API rejects are rejected without an error value.
  trackCreateAudioClip: (h, args, ok, err) => {
    const c = makeAudioClip(args, args.startTime, true);
    if (!c) return err();
    c.parentTrack = get(h);
    get(h).arrClips.push(c);
    ok(c.handle);
  },
  // Like Live, only known built-in device names insert; anything else is
  // rejected without an error value.
  trackInsertDevice: (h, name, index, ok, err) => {
    if (!BUILTIN_DEVICES[name]) return err();
    const classes =
      name === "Drum Rack" ? ["DrumRackDevice", "RackDevice", "Device"]
      : name === "Instrument Rack" ? ["RackDevice", "Device"]
      : name === "Simpler" ? ["Simpler", "Device"]
      : ["Device"];
    const d = make(classes, { name, params: BUILTIN_DEVICES[name]() });
    if (classes.includes("RackDevice")) d.chains = [];
    if (classes.includes("Simpler")) d.sample = null;
    d.parentObj = get(h);
    get(h).devices.splice(Number(index), 0, d);
    ok(d.handle);
  },
  // A deleted device's handle is invalid from then on, as in Live.
  trackDeleteDevice: (h, dh, ok) => {
    const t = get(h);
    t.devices = t.devices.filter((d) => d.handle.id !== dh.id);
    objects.delete(dh.id.toString());
    ok();
  },
  trackDuplicateDevice: (h, dh, ok) => {
    const src = get(dh);
    const d = make([...src.classes], { name: src.name, params: [makeParam("Device On", { quantized: true })] });
    if (src.chains) d.chains = [];
    if ("sample" in src) d.sample = null;
    d.parentObj = get(h);
    const t = get(h);
    t.devices.splice(t.devices.findIndex((x) => x.handle.id === dh.id) + 1, 0, d);
    ok(d.handle);
  },
  // A deleted clip's handle is invalid from then on, as in Live.
  trackDeleteClip: (h, ch, ok) => {
    const t = get(h);
    t.arrClips = t.arrClips.filter((c) => c.handle.id !== ch.id);
    // take-lane clips are arrangement clips too: the server deletes them via
    // their lane's track
    for (const lane of t.takeLanes) lane.clips = lane.clips.filter((c) => c.handle.id !== ch.id);
    objects.delete(ch.id.toString());
    ok();
  },
  // "Deletes clips within the range. Clips that overlap a boundary are
  // truncated to the range edge" (Track.clearClipsInRange): a truncated clip
  // keeps its id. A clip spanning the whole range keeps its part before it,
  // and its part after it becomes a new clip (assumed: Live splits it). Take
  // lanes are left alone.
  trackClearClipsInRange: (h, s, e, ok) => {
    const t = get(h);
    if (!(e > s)) return ok();
    const kept = [];
    // the part of a clip from `at` on (playback continues where it was)
    const cutStart = (c, at) => {
      c.startMarker = clipTimeAt(c, at - c.startTime);
      c.startTime = at;
    };
    const cutEnd = (c, at) => {
      if (!c.looping) c.endMarker = c.startMarker + (at - c.startTime);
      c.endTime = at;
    };
    for (const c of t.arrClips) {
      if (c.endTime <= s || c.startTime >= e) {
        kept.push(c);
      } else if (c.startTime >= s && c.endTime <= e) {
        objects.delete(c.handle.id.toString());
      } else if (c.startTime < s && c.endTime > e) {
        const { handle: _h, ...props } = c;
        const right = make([...c.classes], { ...props, notes: c.notes && c.notes.map((n) => ({ ...n })) });
        cutStart(right, e);
        cutEnd(c, s);
        kept.push(c, right);
      } else {
        if (c.startTime < s) cutEnd(c, s);
        else cutStart(c, e);
        kept.push(c);
      }
    }
    t.arrClips = kept.sort((a, b) => a.startTime - b.startTime);
    ok();
  },
  withinTransaction: (fn) => {
    calls.transactions.all++;
    if (transactionDepth === 0) calls.transactions.outer++;
    transactionDepth++;
    try {
      return fn();
    } finally {
      transactionDepth--;
    }
  },
  clipGetName: (h) => get(h).name,
  clipSetName: (h, v) => { get(h).name = v; },
  clipGetStartTime: (h) => get(h).startTime,
  clipGetEndTime: (h) => get(h).endTime,
  clipGetStartMarker: (h) => get(h).startMarker,
  clipGetEndMarker: (h) => get(h).endMarker,
  clipGetLooping: (h) => get(h).looping,
  clipSetLooping: (h, v) => { get(h).looping = v; },
  clipGetLoopStart: (h) => get(h).loopStart,
  clipGetLoopEnd: (h) => get(h).loopEnd,
  clipGetColor: (h) => get(h).color,
  clipSetColor: (h, v) => { get(h).color = v; },
  clipGetMuted: (h) => get(h).muted,
  clipSetMuted: (h, v) => { get(h).muted = v; },
  // Notes cross the host boundary as copies: changing a note object the
  // extension read changes nothing until it writes the notes back.
  midiclipGetNotes: (h) => get(h).notes.map((n) => ({ ...n })),
  midiclipSetNotes: (h, notes) => { get(h).notes = notes.map((n) => ({ ...n })); },
  audioclipGetFilePath: (h) => get(h).filePath,
  audioclipGetWarping: (h) => get(h).warping,
  audioclipSetWarping: (h, v) => { get(h).warping = v; },
  audioclipGetWarpMode: (h) => get(h).warpMode,
  audioclipSetWarpMode: (h, v) => { get(h).warpMode = v; },
  audioclipGetWarpMarkers: (h) => get(h).warpMarkers,
  clipslotGetClip: (h) => (get(h).clip ? get(h).clip.handle : null),
  clipslotDeleteClip: (h, ok) => {
    const slot = get(h);
    if (slot.clip) objects.delete(slot.clip.handle.id.toString());
    slot.clip = null;
    ok();
  },
  clipslotCreateMidiClip: (h, length, ok) => {
    const c = make(["MidiClip", "Clip"], {
      name: "", startTime: 0, endTime: length, startMarker: 0, endMarker: length,
      looping: true, loopStart: 0, loopEnd: length, color: 0, muted: false, notes: [],
    });
    c.parentSlot = get(h);
    get(h).clip = c;
    ok(c.handle);
  },
  clipslotCreateAudioClip: (h, args, ok, err) => {
    const c = makeAudioClip(args, 0, false);
    if (!c) return err();
    c.parentSlot = get(h);
    get(h).clip = c;
    ok(c.handle);
  },
  takelaneGetClips: (h) => get(h).clips.map((c) => c.handle),
  takelaneGetName: (h) => get(h).name,
  takelaneSetName: (h, v) => { get(h).name = v; },
  // TakeLane mocks hold their clips in `clips` (not `arrClips`); the clip's
  // canonical parent is the lane.
  takelaneCreateMidiClip: (h, start, dur, ok) => {
    const c = make(["MidiClip", "Clip"], {
      name: "", startTime: start, endTime: start + dur, startMarker: 0, endMarker: dur,
      looping: false, loopStart: 0, loopEnd: dur, color: 0, muted: false, notes: [],
    });
    c.parentObj = get(h);
    get(h).clips.push(c);
    ok(c.handle);
  },
  takelaneCreateAudioClip: (h, args, ok, err) => {
    const c = makeAudioClip(args, args.startTime, true);
    if (!c) return err();
    c.parentObj = get(h);
    get(h).clips.push(c);
    ok(c.handle);
  },
  deviceGetName: (h) => get(h).name,
  deviceGetParameters: (h) => get(h).params.map((p) => p.handle),
  sampleGetFilePath: (h) => get(h).filePath,
  simplerGetSample: (h) => (get(h).sample ? get(h).sample.handle : null),
  simplerReplaceSample: (h, fp, ok, err) => {
    if (refuseSamples) return err(); // without details, like most host rejections
    const s = make(["Sample"], { filePath: fp, parentObj: get(h) });
    get(h).sample = s;
    ok(s.handle);
  },
  chainGetDevices: (h) => get(h).devices.map((d) => d.handle),
  chainGetMixerDevice: (h) => get(h).mixer.handle,
  chainInsertDevice: (h, name, index, ok, err) => dataModel.trackInsertDevice(h, name, index, ok, err),
  chainDeleteDevice: (h, dh, ok) => dataModel.trackDeleteDevice(h, dh, ok),
  chainDuplicateDevice: (h, dh, ok) => ok(dh),
  rackdeviceGetChains: (h) => get(h).chains.map((c) => c.handle),
  rackdeviceInsertChain: (h, index, ok) => {
    const rack = get(h);
    const isDrum = rack.classes.includes("DrumRackDevice") && !plainChains;
    const c = make(isDrum ? ["DrumChain", "Chain"] : ["Chain"], {
      devices: [], mixer: makeMixer("ChainMixerDevice", 0),
      ...(isDrum ? { receivingNote: 60 } : {}),
    });
    c.parentObj = rack;
    rack.chains.splice(Number(index), 0, c);
    ok(c.handle);
  },
  drumchainGetReceivingNote: (h) => BigInt(get(h).receivingNote),
  drumchainSetReceivingNote: (h, v) => { get(h).receivingNote = Number(v); },
  sceneGetName: (h) => get(h).name,
  sceneSetName: (h, v) => { get(h).name = v; },
  sceneGetTempo: (h) => get(h).tempo,
  sceneGetSignatureNumerator: (h) => get(h).sigN,
  sceneGetSignatureDenominator: (h) => get(h).sigD,
  cuePointGetTime: (h) => get(h).time,
  cuePointGetName: (h) => get(h).name,
  cuePointSetName: (h, v) => { get(h).name = v; },
  deviceParameterGetName: (h) => get(h).name,
  deviceParameterGetInternalMin: (h) => get(h).min,
  deviceParameterGetInternalMax: (h) => get(h).max,
  deviceParameterGetIsQuantized: (h) => get(h).quantized,
  deviceParameterGetDefaultValue: (h) => get(h).def,
  deviceParameterGetValueItems: (h) => get(h).valueItems,
  deviceParameterGetInternalValue: (h, ok) => ok(get(h).value),
  // The only setter with an error value (index.d.mts deviceParameterSetInternalValue).
  deviceParameterSetInternalValue: (h, v, ok, err) => {
    const p = get(h);
    if (refusedWrites.has(p.name)) return err(`mock: ${p.name} is not settable right now`);
    p.value = v;
    ok();
  },
  mixerdeviceGetVolume: (h) => get(h).volume.handle,
  mixerdeviceGetPanning: (h) => get(h).panning.handle,
  mixerdeviceGetSends: (h) => get(h).sends.map((s) => s.handle),
  chainmixerdeviceGetVolume: (h) => get(h).volume.handle,
  chainmixerdeviceGetPanning: (h) => get(h).panning.handle,
  chainmixerdeviceGetSends: (h) => get(h).sends.map((s) => s.handle),
};

// `sink` collects commands, dialogs and menu entries of this activation; pass
// a fresh one to run a second extension instance against the same Live Set.
function makeActivation(storageDir, tempDir, sink = calls) {
  return {
    hostApiVersion: "1.0.0",
    initializeExtensionHost: () => ({
      commands: {
        registerCommand: (id, cb) => { sink.commands[id] = cb; },
        executeCommand: (id, ...args) => {
          if (!sink.commands[id]) throw new Error(`mock: unknown command ${id}`);
          sink.commands[id](...args);
        },
      },
      dataModel,
      environment: { storageDirectory: storageDir, tempDirectory: tempDir, language: "EN" },
      resources: {
        // Writes a real WAV file (see renderTrack); AudioTracks only.
        renderPreFxAudio: (lane, args, ok, err) => {
          const t = get(lane);
          if (!t.classes.includes("AudioTrack") || !(args.endTime > args.startTime)) return err();
          ok(renderTrack(tempDir, t, args.startTime, args.endTime));
        },
        // The copy is not written anywhere: its path only stands for it.
        importIntoProject: (fp, ok, err) => {
          if (refuseImports) return err(`mock: could not copy ${fp} into the project`);
          calls.imports.push(fp);
          const imported = `/mock-project/Samples/Imported/${fp.split(/[\\/]/).pop()}`;
          if (fileBeats.has(fp)) fileBeats.set(imported, fileBeats.get(fp));
          ok(imported);
        },
      },
      ui: {
        registerContextMenuAction: (scope, title, commandId, onOk) => {
          if (!HANDLE_SCOPES.includes(scope) && !SELECTION_SCOPES.includes(scope))
            throw new Error(`mock: unknown context-menu scope ${scope}`);
          sink.menus.push({ scope, title, commandId });
          onOk((onUnreg) => onUnreg());
        },
        showModalDialog: (url, w, hgt, ok, err) => {
          sink.dialogs.push({ url, w, hgt });
          if (holdDialogs) openDialogs.push({ url, ok, err });
          else ok("mock-dialog-result");
        },
        showProgressDialog: (opts, onShow) => onShow({ update: (o, cb) => cb && cb(), close: (cb) => cb && cb() }),
      },
    }),
  };
}

// Test fixtures for what the extension cannot do itself (Live's UI can).
const fixtures = {
  // Add a regular track at the end; kind "group" makes a group track that
  // others join with `group: <its id>`.
  addTrack: ({ kind, name, group }) => {
    const classes =
      kind === "midi" ? ["MidiTrack", "Track"] : kind === "audio" ? ["AudioTrack", "Track"] : ["Track"];
    const t = makeTrack(classes, name, { group: group ? objects.get(group) : null });
    songObj.tracks.push(t);
    return t.handle.id.toString();
  },
  // The track Live would insert new tracks after (null = none selected).
  selectTrack: (id) => { selectedTrack = id ? objects.get(id) : null; },
  // Make the host refuse writes to parameters of this name (null = none).
  refuseWrites: (name) => { refusedWrites.clear(); if (name) refusedWrites.add(name); },
  // Make Simpler.replaceSample fail (e.g. an unreadable file).
  refuseSamples: (on) => { refuseSamples = on; },
  // The user's note selection in a clip's editor: NoteDescription.selected
  // is true for the given pitches and false for the others; null removes the
  // field (a host that reports no selection state).
  selectNotes: (clipId, pitches) => {
    for (const n of objects.get(clipId).notes) {
      if (pitches === null) delete n.selected;
      else n.selected = pitches.includes(Number(n.pitch));
    }
  },
  // Live's arrangement grid (a GridQuantization value) and scale, which the
  // API can only read.
  setGrid: (quantization, triplet = false) => { songObj.grid = quantization; songObj.gridTriplet = triplet; },
  setScale: ({ root, name, intervals }) => {
    songObj.rootNote = BigInt(root);
    songObj.scaleName = name;
    songObj.scaleIntervals = intervals.map(BigInt);
  },
  // Append `count` plain devices to a track (a big set, without MCP calls).
  addDevices: (trackId, count, name = "Utility") => {
    const t = objects.get(trackId);
    for (let i = 0; i < count; i++) {
      const d = make(["Device"], { name, params: BUILTIN_DEVICES.Utility() });
      d.parentObj = t;
      t.devices.push(d);
    }
  },
  // Append `count` 4-beat MIDI clips to a track's arrangement, back to back.
  addClips: (trackId, count) => {
    const t = objects.get(trackId);
    const from = t.arrClips.reduce((end, c) => Math.max(end, c.endTime), 0);
    for (let i = 0; i < count; i++) {
      const start = from + 4 * i;
      const c = make(["MidiClip", "Clip"], {
        name: `Clip ${i}`, startTime: start, endTime: start + 4, startMarker: 0, endMarker: 4,
        looping: false, loopStart: 0, loopEnd: 4, color: 0, muted: false, notes: [],
      });
      c.parentTrack = t;
      t.arrClips.push(c);
    }
  },
  // Append `count` scenes (every track gets their slots), or drop the scenes
  // from index `keep` on again, as Live's UI can.
  addScenes: (count) => {
    for (let i = 0; i < count; i++) {
      songObj.scenes.push(make(["Scene"], { name: `Scene ${i}`, tempo: 120, sigN: 4, sigD: 4, parentObj: songObj }));
      for (const t of songObj.tracks) t.slots.push(makeSlot(null, t));
    }
  },
  removeScenes: (keep) => {
    for (const sc of songObj.scenes.splice(keep)) objects.delete(sc.handle.id.toString());
    for (const t of songObj.tracks) t.slots.splice(keep);
  },
  // Keep dialogs open until closeDialog / failDialog (or not: false).
  holdDialogs: (on) => { holdDialogs = on; },
  // The open dialogs' URLs, oldest first.
  openDialogs: () => openDialogs.map((d) => d.url),
  // The user closes the oldest open dialog: its page posted close_and_send
  // with `result`. failDialog: the host rejects it instead (no error value,
  // like most host callbacks).
  closeDialog: (result) => {
    if (!openDialogs.length) throw new Error("mock: no open dialog");
    openDialogs.shift().ok(result);
  },
  failDialog: () => {
    if (!openDialogs.length) throw new Error("mock: no open dialog");
    openDialogs.shift().err();
  },
  // A handle Live never handed out (a deleted or unknown object).
  bogusHandle: () => ({ id: 987654321n }),
  // New chains of Drum Racks are plain Chains (on), or DrumChains as usual.
  plainChains: (on) => { plainChains = on; },
  // Make importIntoProject fail (with an error message, as its onError allows).
  refuseImports: (on) => { refuseImports = on; },
  // The WAV format of renders ({sampleRate, channels, bits, float, extensible,
  // listChunk, garbage}, merged into the current one), and a track's render level.
  renderFormat: (fmt) => { renderFormat = { ...renderFormat, ...fmt }; },
  renderLevel: (trackId, level) => { renderLevels.set(trackId, level); },
  // A clip's position, markers and loop, which the API can only read.
  setClipRegion: (clipId, region) => { Object.assign(objects.get(clipId), region); },
  // A clip's warp markers (read-only in the API).
  setWarpMarkers: (clipId, markers) => { objects.get(clipId).warpMarkers = markers; },
  // The user picks `title` in the context menu of `scope`, as Live invokes it:
  // the command gets the clicked object's handle, or for selection scopes a
  // ClipSlotSelection ({slots: [ids]}) or an ArrangementSelection ({start,
  // end, lanes: [ids]}). Ids are object ids; handle objects pass as they are.
  contextMenu: (scope, target, { title = "MCP: Use as selection", sink = calls } = {}) => {
    const menu = sink.menus.find((m) => m.scope === scope && m.title === title);
    if (!menu) throw new Error(`mock: no "${title}" entry in the ${scope} context menu`);
    const handle = (x) => (typeof x === "string" ? objects.get(x).handle : x);
    const arg =
      scope === "ClipSlotSelection" ? { selected_clip_slots: target.slots.map(handle) }
      : scope.endsWith(".ArrangementSelection")
        ? { time_selection_start: target.start, time_selection_end: target.end, selected_lanes: target.lanes.map(handle) }
        : handle(target);
    sink.commands[menu.commandId](arg);
  },
};

module.exports = { makeActivation, calls, fixtures, ids: {
  midiTrack: midiTrack.handle.id.toString(),
  audioTrack: audioTrack.handle.id.toString(),
  midiClip: midiClip.handle.id.toString(),
  emptySlot: midiSlots[1].handle.id.toString(),
} };
