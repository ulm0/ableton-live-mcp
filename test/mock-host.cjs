// Mock Extension Host implementing the ExtensionsApi_1_0_0 surface with a tiny
// in-memory Live Set: 1 MIDI track, 1 audio track, 1 return, main, 2 scenes,
// 1 cue point. Enough to E2E-test the MCP pipeline without Ableton Live.
"use strict";

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

function makeSlot(clip) {
  return make(["ClipSlot"], { clip: clip ?? null });
}
// A regular track has one clip slot per scene (index-aligned with Song.scenes).
const sceneSlots = () => songObj.scenes.map(() => makeSlot(null));
function makeTrack(classes, name, extra = {}) {
  return make(classes, {
    name, mute: false, solo: false, arm: false,
    slots: sceneSlots(), takeLanes: [], arrClips: [], devices: [],
    mixer: makeMixer("MixerDevice", songObj.returns.length), group: null, ...extra,
  });
}
const midiSlots = [makeSlot(midiClip), makeSlot(null)];
const midiTrack = make(["MidiTrack", "Track"], {
  name: "Bass", mute: false, solo: false, arm: false,
  slots: midiSlots, takeLanes: [], arrClips: [], devices: [operatorDev],
  mixer: makeMixer("MixerDevice", 1), group: null,
});
midiClip.parentSlot = midiSlots[0];
operatorDev.parentObj = midiTrack;

const audioTrack = make(["AudioTrack", "Track"], {
  name: "Drums", mute: false, solo: false, arm: false,
  slots: [makeSlot(null), makeSlot(null)], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 1), group: null,
});
const returnTrack = make(["Track"], {
  name: "A-Reverb", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 0), group: null,
});
const mainTrack = make(["Track"], {
  name: "Main", mute: false, solo: false, arm: false,
  slots: [], takeLanes: [], arrClips: [], devices: [],
  mixer: makeMixer("MixerDevice", 0), group: null,
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

let selectedTrack = null;
function insertAfterSelection(song, track) {
  const i = selectedTrack ? song.tracks.indexOf(selectedTrack) : -1;
  i < 0 ? song.tracks.push(track) : song.tracks.splice(i + 1, 0, track);
}

// --- api modules -----------------------------------------------------------
// What the extension asked the host to do. `transactions.outer` counts
// outermost withinTransaction calls — the undo steps a user would see, since
// nested transactions collapse into the outermost one (index.d.mts
// withinTransaction); `transactions.all` also counts the nested ones that the
// SDK opens around every setter and async operation.
const calls = { dialogs: [], commands: {}, menus: [], transactions: { outer: 0, all: 0 } };
let transactionDepth = 0;

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
    for (const t of s.tracks) t.slots.splice(at, 0, makeSlot(null));
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
    for (const t of s.tracks) t.slots.splice(at, 0, makeSlot(null));
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
  trackCreateAudioClip: (h, args, ok) => {
    const c = make(["AudioClip", "Clip"], {
      name: "", startTime: args.startTime, endTime: args.startTime + (args.duration ?? 4),
      startMarker: 0, endMarker: 4, looping: false, loopStart: 0, loopEnd: 4,
      color: 0, muted: false, filePath: args.filePath, warping: !!args.isWarped,
      warpMode: 0, warpMarkers: [],
    });
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
  trackDeleteClip: (h, ch, ok) => {
    const t = get(h);
    t.arrClips = t.arrClips.filter((c) => c.handle.id !== ch.id);
    // take-lane clips are arrangement clips too: the server deletes them via
    // their lane's track
    for (const lane of t.takeLanes) lane.clips = lane.clips.filter((c) => c.handle.id !== ch.id);
    ok();
  },
  trackClearClipsInRange: (h, s, e, ok) => ok(),
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
  midiclipGetNotes: (h) => get(h).notes,
  midiclipSetNotes: (h, notes) => { get(h).notes = notes; },
  audioclipGetFilePath: (h) => get(h).filePath,
  audioclipGetWarping: (h) => get(h).warping,
  audioclipSetWarping: (h, v) => { get(h).warping = v; },
  audioclipGetWarpMode: (h) => get(h).warpMode,
  audioclipSetWarpMode: (h, v) => { get(h).warpMode = v; },
  audioclipGetWarpMarkers: (h) => get(h).warpMarkers,
  clipslotGetClip: (h) => (get(h).clip ? get(h).clip.handle : null),
  clipslotDeleteClip: (h, ok) => { get(h).clip = null; ok(); },
  clipslotCreateMidiClip: (h, length, ok) => {
    const c = make(["MidiClip", "Clip"], {
      name: "", startTime: 0, endTime: length, startMarker: 0, endMarker: length,
      looping: true, loopStart: 0, loopEnd: length, color: 0, muted: false, notes: [],
    });
    c.parentSlot = get(h);
    get(h).clip = c;
    ok(c.handle);
  },
  clipslotCreateAudioClip: (h, args, ok) => {
    const c = make(["AudioClip", "Clip"], {
      name: "", startTime: 0, endTime: 4, startMarker: 0, endMarker: 4,
      looping: false, loopStart: 0, loopEnd: 4, color: 0, muted: false,
      filePath: args.filePath, warping: !!args.isWarped, warpMode: 0, warpMarkers: [],
    });
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
  takelaneCreateAudioClip: (h, args, ok) => {
    const c = make(["AudioClip", "Clip"], {
      name: "", startTime: args.startTime, endTime: args.startTime + (args.duration ?? 4),
      startMarker: 0, endMarker: 4, looping: false, loopStart: 0, loopEnd: 4,
      color: 0, muted: false, filePath: args.filePath, warping: !!args.isWarped,
      warpMode: 0, warpMarkers: [],
    });
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
    const s = make(["Sample"], { filePath: fp });
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
    const isDrum = rack.classes.includes("DrumRackDevice");
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
        renderPreFxAudio: (lane, args, ok) => ok(`${tempDir}/render-${args.startTime}-${args.endTime}.wav`),
        importIntoProject: (fp, ok) => ok(`/mock-project/Samples/Imported/${fp.split("/").pop()}`),
      },
      ui: {
        registerContextMenuAction: (scope, title, commandId, onOk) => {
          sink.menus.push({ scope, title, commandId });
          onOk((onUnreg) => onUnreg());
        },
        showModalDialog: (url, w, hgt, ok) => { sink.dialogs.push({ url, w, hgt }); ok("mock-dialog-result"); },
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
};

module.exports = { makeActivation, calls, fixtures, ids: {
  midiTrack: midiTrack.handle.id.toString(),
  audioTrack: audioTrack.handle.id.toString(),
  midiClip: midiClip.handle.id.toString(),
  emptySlot: midiSlots[1].handle.id.toString(),
} };
