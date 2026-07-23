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
  if (!m) throw new Error(`Invalid color "${hex}", expected "#RRGGBB".`);
  return parseInt(m[1], 16);
}

export function trackType(track: Track<V>): string {
  if (track instanceof AudioTrack) return "audio";
  if (track instanceof MidiTrack) return "midi";
  return "other"; // main, return, or group track
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

export async function parameterWithValue(param: DeviceParameter<V>) {
  return { ...parameterSummary(param), value: num(await param.getValue()) };
}

export function chainSummary(chain: Chain<V>) {
  const base: Record<string, unknown> = {
    id: remember(chain),
    class: classOf(chain),
    device_count: chain.devices.length,
  };
  if (chain instanceof DrumChain) {
    base.receiving_note = num(chain.receivingNote);
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
