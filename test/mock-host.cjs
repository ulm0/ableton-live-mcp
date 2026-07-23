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

// --- api modules -----------------------------------------------------------
const calls = { dialogs: [], commands: {} };

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
  songCreateMidiTrack: (h, ok) => {
    const t = make(["MidiTrack", "Track"], {
      name: "New MIDI", mute: false, solo: false, arm: false,
      slots: [makeSlot(null), makeSlot(null)], takeLanes: [], arrClips: [], devices: [],
      mixer: makeMixer("MixerDevice", 1), group: null,
    });
    get(h).tracks.push(t);
    ok(t.handle);
  },
  songCreateAudioTrack: (h, ok) => {
    const t = make(["AudioTrack", "Track"], {
      name: "New Audio", mute: false, solo: false, arm: false,
      slots: [makeSlot(null), makeSlot(null)], takeLanes: [], arrClips: [], devices: [],
      mixer: makeMixer("MixerDevice", 1), group: null,
    });
    get(h).tracks.push(t);
    ok(t.handle);
  },
  songDeleteTrack: (h, th, ok) => {
    const s = get(h);
    s.tracks = s.tracks.filter((t) => t.handle.id !== th.id);
    objects.delete(th.id.toString());
    ok();
  },
  songCreateScene: (h, index, ok) => {
    const sc = make(["Scene"], { name: "New Scene", tempo: 120, sigN: 4, sigD: 4 });
    const s = get(h);
    const i = Number(index);
    i < 0 ? s.scenes.push(sc) : s.scenes.splice(i, 0, sc);
    ok(sc.handle);
  },
  songDeleteScene: (h, sh, ok) => {
    const s = get(h);
    s.scenes = s.scenes.filter((x) => x.handle.id !== sh.id);
    ok();
  },
  songDuplicateTrack: (h, th, ok) => {
    const src = get(th);
    const t = make([...src.classes], {
      name: src.name + " Copy", mute: src.mute, solo: src.solo, arm: src.arm,
      slots: [makeSlot(null), makeSlot(null)], takeLanes: [], arrClips: [], devices: [],
      mixer: makeMixer("MixerDevice", 1), group: null,
    });
    const s = get(h);
    s.tracks.splice(s.tracks.findIndex((x) => x.handle.id === th.id) + 1, 0, t);
    ok(t.handle);
  },
  songDuplicateScene: (h, sh, ok) => {
    const src = get(sh);
    const sc = make(["Scene"], { name: src.name + " Copy", tempo: src.tempo, sigN: src.sigN, sigD: src.sigD });
    const s = get(h);
    s.scenes.splice(s.scenes.findIndex((x) => x.handle.id === sh.id) + 1, 0, sc);
    ok(sc.handle);
  },
  songCreateCuePoint: (h, time, ok) => {
    const c = make(["CuePoint"], { name: "Locator", time });
    get(h).cues.push(c);
    ok(c.handle);
  },
  songDeleteCuePoint: (h, ch, ok) => {
    const s = get(h);
    s.cues = s.cues.filter((x) => x.handle.id !== ch.id);
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
  trackGetGroupTrack: () => null,
  trackGetClipSlots: (h) => get(h).slots.map((s) => s.handle),
  trackGetTakeLanes: (h) => get(h).takeLanes.map((l) => l.handle),
  trackGetArrangementClips: (h) => get(h).arrClips.map((c) => c.handle),
  trackGetDevices: (h) => get(h).devices.map((d) => d.handle),
  trackGetMixerDevice: (h) => get(h).mixer.handle,
  trackCreateTakeLane: (h, ok) => {
    const lane = make(["TakeLane"], { name: "Take 1", clips: [] });
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
  trackInsertDevice: (h, name, index, ok) => {
    const classes =
      name === "Drum Rack" ? ["DrumRackDevice", "RackDevice", "Device"]
      : name === "Instrument Rack" ? ["RackDevice", "Device"]
      : name === "Simpler" ? ["Simpler", "Device"]
      : ["Device"];
    const d = make(classes, { name, params: [makeParam("Device On", { quantized: true })] });
    if (classes.includes("RackDevice")) d.chains = [];
    if (classes.includes("Simpler")) d.sample = null;
    d.parentObj = get(h);
    get(h).devices.splice(Number(index), 0, d);
    ok(d.handle);
  },
  trackDeleteDevice: (h, dh, ok) => {
    const t = get(h);
    t.devices = t.devices.filter((d) => d.handle.id !== dh.id);
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
    ok();
  },
  trackClearClipsInRange: (h, s, e, ok) => ok(),
  withinTransaction: (fn) => fn(),
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
  takelaneCreateMidiClip: (h, start, dur, ok) => dataModel.trackCreateMidiClip(h, start, dur, ok),
  takelaneCreateAudioClip: (h, args, ok) => dataModel.trackCreateAudioClip(h, args, ok),
  deviceGetName: (h) => get(h).name,
  deviceGetParameters: (h) => get(h).params.map((p) => p.handle),
  sampleGetFilePath: (h) => get(h).filePath,
  simplerGetSample: (h) => (get(h).sample ? get(h).sample.handle : null),
  simplerReplaceSample: (h, fp, ok) => {
    const s = make(["Sample"], { filePath: fp });
    get(h).sample = s;
    ok(s.handle);
  },
  chainGetDevices: (h) => get(h).devices.map((d) => d.handle),
  chainGetMixerDevice: (h) => get(h).mixer.handle,
  chainInsertDevice: (h, name, index, ok) => dataModel.trackInsertDevice(h, name, index, ok),
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
  deviceParameterSetInternalValue: (h, v, ok) => { get(h).value = v; ok(); },
  mixerdeviceGetVolume: (h) => get(h).volume.handle,
  mixerdeviceGetPanning: (h) => get(h).panning.handle,
  mixerdeviceGetSends: (h) => get(h).sends.map((s) => s.handle),
  chainmixerdeviceGetVolume: (h) => get(h).volume.handle,
  chainmixerdeviceGetPanning: (h) => get(h).panning.handle,
  chainmixerdeviceGetSends: (h) => get(h).sends.map((s) => s.handle),
};

function makeActivation(storageDir, tempDir) {
  return {
    hostApiVersion: "1.0.0",
    initializeExtensionHost: () => ({
      commands: {
        registerCommand: (id, cb) => { calls.commands[id] = cb; },
        executeCommand: (id, ...args) => {
          if (!calls.commands[id]) throw new Error(`mock: unknown command ${id}`);
          calls.commands[id](...args);
        },
      },
      dataModel,
      environment: { storageDirectory: storageDir, tempDirectory: tempDir, language: "EN" },
      resources: {
        renderPreFxAudio: (lane, args, ok) => ok(`${tempDir}/render-${args.startTime}-${args.endTime}.wav`),
        importIntoProject: (fp, ok) => ok(`/mock-project/Samples/Imported/${fp.split("/").pop()}`),
      },
      ui: {
        registerContextMenuAction: (scope, title, commandId, onOk) => onOk((onUnreg) => onUnreg()),
        showModalDialog: (url, w, hgt, ok) => { calls.dialogs.push({ url, w, hgt }); ok("mock-dialog-result"); },
        showProgressDialog: (opts, onShow) => onShow({ update: (o, cb) => cb && cb(), close: (cb) => cb && cb() }),
      },
    }),
  };
}

module.exports = { makeActivation, calls, ids: {
  midiTrack: midiTrack.handle.id.toString(),
  audioTrack: audioTrack.handle.id.toString(),
  midiClip: midiClip.handle.id.toString(),
  emptySlot: midiSlots[1].handle.id.toString(),
} };
