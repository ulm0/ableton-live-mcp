import {
  AudioClip,
  AudioTrack,
  Chain,
  Clip,
  ClipSlot,
  CuePoint,
  Device,
  DeviceParameter,
  DrumChain,
  DrumRack,
  GridQuantization,
  MidiClip,
  MidiTrack,
  RackDevice,
  Scene,
  Simpler,
  TakeLane,
  Track,
  WarpMode,
  type ApiVersion,
} from "@ableton-extensions/sdk";
import { UsageError } from "./errors.js";
import { remember } from "./store.js";

type V = ApiVersion;

export function classOf(obj: object): string {
  return (
    (obj.constructor as { className?: string }).className ??
    obj.constructor.name
  );
}

// The host hands some numerics over as bigint — normalize before arithmetic/JSON.
export function num(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

// Live colors are 0x00RRGGBB ints; hex strings are friendlier for clients.
export function colorToHex(color: number | bigint): string {
  return `#${(num(color) & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function hexToColor(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new UsageError(`Invalid color "${hex}", expected "#RRGGBB".`);
  return parseInt(m[1], 16);
}

// MIDI note names in Live's naming: C3 = 60, so C-2 = 0 and G8 = 127.
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const LETTER_PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_NAME = /^([a-g])([#♯b♭]{0,2})(-?\d+)?$/i;

export function noteName(pitch: number | bigint): string {
  const p = num(pitch);
  return `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 2}`;
}

// A note name's letter, accidentals and octave (null if it is not one).
function splitNoteName(name: string) {
  const m = NOTE_NAME.exec(name.trim());
  if (!m) return null;
  // the first character is the letter, so a "b" after it is a flat
  const shift = [...m[2]].reduce((s, c) => s + (c === "#" || c === "♯" ? 1 : -1), 0);
  return { semitone: LETTER_PITCH_CLASS[m[1].toLowerCase()] + shift, octave: m[3] };
}

// A MIDI pitch given as 0-127 (already range-checked by its schema) or as a
// note name such as "C3" (60), "F#1" (42) or "Bb2" (46); `what` names the
// argument in errors.
export function parsePitch(value: number | string, what = "pitch"): number {
  if (typeof value === "number") return value;
  const text = value.trim();
  let pitch = NaN;
  if (/^\d+$/.test(text)) pitch = Number(text);
  else {
    const parts = splitNoteName(text);
    if (parts?.octave !== undefined) pitch = (Number(parts.octave) + 2) * 12 + parts.semitone;
  }
  if (Number.isNaN(pitch))
    throw new UsageError(
      `${what}: ${JSON.stringify(value)} is not a MIDI pitch: give 0-127 or a note name such as ` +
        '"C3" (= 60), "F#1" or "Bb2".',
    );
  if (pitch < 0 || pitch > 127)
    throw new UsageError(`${what}: ${JSON.stringify(value)} is outside the MIDI range (C-2 = 0 to G8 = 127).`);
  return pitch;
}

// A pitch class 0-11 (C = 0), given as a number or a note name with or
// without octave ("D", "F#", "Bb3").
export function parsePitchClass(value: number | string, what = "root"): number {
  if (typeof value === "number") return value;
  const parts = splitNoteName(value);
  if (!parts)
    throw new UsageError(
      `${what}: ${JSON.stringify(value)} is not a note: give 0-11 (C = 0) or a name such as "D" or "F#".`,
    );
  return ((parts.semitone % 12) + 12) % 12;
}

export function trackType(track: Track<V>): string {
  if (track instanceof AudioTrack) return "audio";
  if (track instanceof MidiTrack) return "midi";
  // main, return, or group track: only the song's track lists tell them apart,
  // so the server passes the role ("group", "return", "main") to trackSummary
  return "other";
}

export function trackSummary(track: Track<V>, role?: string) {
  return {
    id: remember(track),
    type: role ?? trackType(track),
    name: track.name,
    mute: track.mute,
    solo: track.solo,
    arm: track.arm,
    muted_via_solo: track.mutedViaSolo,
    group_track_id: track.groupTrack ? remember(track.groupTrack) : null,
    device_count: track.devices.length,
    clip_slot_count: track.clipSlots.length,
    arrangement_clip_count: track.arrangementClips.length,
  };
}

// `detail` adds note_count / full warp_markers — both marshal every note/marker
// across the host boundary, so bulk listings (track_get) stay light and only
// clip_get pays for it.
export function clipSummary(clip: Clip<V>, detail = false) {
  const base: Record<string, unknown> = {
    id: remember(clip),
    class: classOf(clip),
    name: clip.name,
    color: colorToHex(clip.color),
    muted: clip.muted,
    looping: clip.looping,
    start_time: num(clip.startTime),
    end_time: num(clip.endTime),
    duration: num(clip.duration),
    start_marker: num(clip.startMarker),
    end_marker: num(clip.endMarker),
    loop_start: num(clip.loopStart),
    loop_end: num(clip.loopEnd),
  };
  if (clip instanceof MidiClip) {
    if (detail) base.note_count = clip.notes.length;
  } else if (clip instanceof AudioClip) {
    base.file_path = clip.filePath;
    base.warping = clip.warping;
    base.warp_mode = WarpMode[num(clip.warpMode)];
    if (detail) {
      base.warp_markers = clip.warpMarkers.map((m) => ({
        sample_time: num(m.sampleTime),
        beat_time: num(m.beatTime),
      }));
    }
  }
  return base;
}

// A clip in bulk overviews (song_get clips, session_grid): enough to tell
// clips apart, no notes or markers — clip_get has the full detail. Arrangement
// clips also carry their position.
export function clipBrief(clip: Clip<V>, withPosition = false) {
  return {
    id: remember(clip),
    class: classOf(clip),
    name: clip.name,
    duration: num(clip.duration),
    muted: clip.muted,
    looping: clip.looping,
    start_time: withPosition ? num(clip.startTime) : undefined,
    end_time: withPosition ? num(clip.endTime) : undefined,
  };
}

export function clipSlotSummary(slot: ClipSlot<V>, index: number) {
  const clip = slot.clip;
  return {
    id: remember(slot),
    scene_index: index,
    clip: clip ? clipSummary(clip) : null,
  };
}

export function takeLaneSummary(lane: TakeLane<V>) {
  return {
    id: remember(lane),
    name: lane.name,
    clips: lane.clips.map((c) => clipSummary(c)),
  };
}

export function deviceSummary(device: Device<V>) {
  const base: Record<string, unknown> = {
    id: remember(device),
    class: classOf(device),
    name: device.name,
    parameter_count: device.parameters.length,
  };
  if (device instanceof RackDevice) {
    base.chain_ids = device.chains.map((c) => remember(c));
    base.is_drum_rack = device instanceof DrumRack;
  }
  if (device instanceof Simpler) {
    const sample = device.sample;
    base.sample = sample
      ? { id: remember(sample), file_path: sample.filePath }
      : null;
  }
  return base;
}

export function parameterSummary(param: DeviceParameter<V>, includeValueItems = true) {
  return {
    id: remember(param),
    name: param.name,
    min: num(param.min),
    max: num(param.max),
    default_value: num(param.defaultValue),
    is_quantized: param.isQuantized,
    value_items: includeValueItems && param.isQuantized
      ? param.valueItems.map((v, i) => ({ index: i, name: v.name, short_name: v.shortName }))
      : undefined,
  };
}

// A quantized parameter's value is its value_items index (assumed host
// semantics: the SDK documents no mapping), so `value_item` names the current
// choice, e.g. "Saw". Internal units only: the API has no display values.
export async function parameterWithValue(param: DeviceParameter<V>, includeValueItems = true) {
  const summary = parameterSummary(param, includeValueItems);
  const value = num(await param.getValue());
  const items = summary.value_items ?? (summary.is_quantized ? param.valueItems : []);
  return { ...summary, value, value_item: items[value]?.name };
}

export function chainSummary(chain: Chain<V>) {
  const base: Record<string, unknown> = {
    id: remember(chain),
    class: classOf(chain),
    device_count: chain.devices.length,
  };
  if (chain instanceof DrumChain) {
    const note = num(chain.receivingNote);
    base.receiving_note = note;
    base.receiving_note_name = noteName(note);
  }
  return base;
}

export function sceneSummary(scene: Scene<V>, index: number) {
  return {
    id: remember(scene),
    index,
    name: scene.name,
    tempo: num(scene.tempo),
    signature: `${num(scene.signatureNumerator)}/${num(scene.signatureDenominator)}`,
  };
}

export function cuePointSummary(cue: CuePoint<V>) {
  return { id: remember(cue), name: cue.name, time: num(cue.time) };
}

export function gridName(q: GridQuantization): string {
  return GridQuantization[num(q)];
}
