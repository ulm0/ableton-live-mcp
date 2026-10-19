import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { z, type ZodRawShape } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AudioClip,
  AudioTrack,
  Chain,
  ChainMixer,
  Clip,
  ClipSlot,
  CuePoint,
  DataModelObject,
  Device,
  DeviceParameter,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  RackDevice,
  Sample,
  Scene,
  Simpler,
  TakeLane,
  Track,
  TrackMixer,
  WarpMode,
  type ExtensionContext,
  type NoteDescription,
} from "@ableton-extensions/sdk";
import { UsageError } from "./errors.js";
import INSTRUCTIONS from "./instructions.md";
import { SelectionStore, registerSelectionMenus, type Selection } from "./selection.js";
import { remember, resolve } from "./store.js";
import {
  chainSummary,
  classOf,
  num,
  clipBrief,
  clipSlotSummary,
  clipSummary,
  colorToHex,
  cuePointSummary,
  deviceSummary,
  gridName,
  hexToColor,
  parameterSummary,
  parsePitch,
  parsePitchClass,
  parameterWithValue,
  sceneSummary,
  takeLaneSummary,
  trackSummary,
} from "./serialize.js";

type Ctx = ExtensionContext<"1.0.0">;

declare const __EXT_VERSION__: string | undefined;

const DEFAULT_PORT = 8722;
const SERVER_INFO = {
  name: "ableton-live",
  version: typeof __EXT_VERSION__ !== "undefined" ? __EXT_VERSION__ : "dev",
};

const WARP_MODES = ["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"] as const;

// ---------------------------------------------------------------------------
// helpers

function json(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      },
    ],
  };
}

const STALE_HINT =
  "If this object was deleted or moved, or the Live Set changed, its id is stale — re-fetch ids via song_get / track_get.";

// Tool annotation presets. The MCP defaults (destructiveHint:true,
// openWorldHint:true) would make every tool, song_get included, look like a
// destructive write to the outside world, so every hint is spelled out.
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
// Sets properties to the given values: repeating the call changes nothing more.
const SET: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
// Adds objects (tracks, clips, devices, ...); each call adds another one.
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
// Removes or overwrites content. Repeating the call (same ids) has no further effect.
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
// Destructive and cumulative: a repeated merge or transform applies again.
const DESTRUCTIVE_CUMULATIVE: ToolAnnotations = { ...DESTRUCTIVE, idempotentHint: false };
// show_dialog: blocks Live's UI with a modal whose HTML may load https: content.
const DIALOG: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
// execute_command: runs arbitrary commands, including other extensions' ones.
const COMMAND: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

type ToolMeta = { title: string; annotations: ToolAnnotations };
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// A MIDI pitch: 0-127, or a note name in Live's naming (C3 = 60), converted
// with parsePitch. A fresh instance per use (see deviceStep).
const pitchSchema = (what: string) =>
  z
    .union([z.number().int().min(0).max(127), z.string().min(1)])
    .describe(`${what}: 0-127, or a note name such as "C3" (= 60), "F#1" or "Bb2"`);

const noteShape = {
  pitch: pitchSchema("MIDI pitch"),
  start_time: z.number().describe("Start in beats, relative to clip start"),
  duration: z.number().positive().describe("Length in beats"),
  velocity: z.number().min(0).max(127).optional(),
  muted: z.boolean().optional(),
  probability: z.number().min(0).max(1).optional().describe("Play probability, 0-1"),
  velocity_deviation: z.number().optional(),
  release_velocity: z.number().min(0).max(127).optional(),
};
type NoteInput = z.objectOutputType<typeof noteShape, z.ZodTypeAny>;

function toNoteDescription(n: NoteInput, what = "pitch"): NoteDescription {
  return {
    pitch: parsePitch(n.pitch, what),
    startTime: n.start_time,
    duration: n.duration,
    velocity: n.velocity,
    muted: n.muted,
    probability: n.probability,
    velocityDeviation: n.velocity_deviation,
    releaseVelocity: n.release_velocity,
  };
}

// MIDI write shortcuts (clip_create, midi_clip_set_notes): a step pattern
// writes one pitch's hits from a string, `repeat` copies the notes along.
const patternSchema = () =>
  z.object({
    note: pitchSchema("Pitch of every hit"),
    steps: z
      .string()
      .min(1)
      .describe(
        'One character per step: "x" a hit, "X" an accented hit, "." or "-" a rest; spaces and "|" ' +
          'are ignored, e.g. "x...x...|x...x.x."',
      ),
    step: z.number().positive().default(0.25).describe("Length of one step in beats (0.25 = 1/16)"),
    start_time: z.number().min(0).default(0).describe("Where the first step starts, in beats"),
    velocity: z.number().min(1).max(127).default(100).describe('Velocity of "x" hits'),
    accent_velocity: z.number().min(1).max(127).default(127).describe('Velocity of "X" hits'),
    duration: z.number().positive().optional().describe("Length of each hit in beats; default one step"),
  });
type PatternInput = z.output<ReturnType<typeof patternSchema>>;
const repeatSchema = () =>
  z
    .object({
      length: z
        .number()
        .positive()
        .describe("Beats the given notes span, e.g. 4 = one 4/4 bar: copy k starts k × length later"),
      times: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Copies in total, counting the original (written even past the clip's end); omitted = fill " +
            "the clip: copies up to its end, without the notes that would start at or after it",
        ),
    })
    .describe("Repeat the notes and patterns of this write");
type RepeatInput = { length: number; times?: number };

// Shortcuts must not flood Live with notes by a typo (a tiny repeat length).
const MAX_EXPANDED_NOTES = 50_000;

// The notes a MIDI write sends: `notes`, then the hits of `patterns`, all
// repeated per `repeat` up to `end` (the clip's length) unless `times` is
// given. Throws before anything is written; `copies` is set with `repeat`.
function noteList(
  input: { notes?: NoteInput[]; patterns?: PatternInput[]; repeat?: RepeatInput },
  end: number,
): { notes: NoteDescription[]; copies?: number } {
  const base = (input.notes ?? []).map((n, i) => toNoteDescription(n, `notes[${i}].pitch`));
  for (const [i, p] of (input.patterns ?? []).entries()) {
    const pitch = parsePitch(p.note, `patterns[${i}].note`);
    let k = 0; // step index: separators do not count
    for (const c of p.steps) {
      if (c === "|" || /\s/.test(c)) continue;
      if (c === "x" || c === "X")
        base.push({
          pitch,
          startTime: p.start_time + k * p.step,
          duration: p.duration ?? p.step,
          velocity: c === "X" ? p.accent_velocity : p.velocity,
        });
      else if (c !== "." && c !== "-")
        throw new UsageError(
          `patterns[${i}].steps: unexpected ${JSON.stringify(c)}; use x, X, . or - (spaces and | are ignored).`,
        );
      k++;
    }
  }
  // filling: every copy that starts before the end (float noise aside)
  const fillCopies = (r: RepeatInput) => Math.max(1, Math.ceil(end / r.length - 1e-9));
  const copies = input.repeat ? (input.repeat.times ?? fillCopies(input.repeat)) : 1;
  const total = base.length * copies;
  if (total > MAX_EXPANDED_NOTES && total > (input.notes?.length ?? 0))
    throw new UsageError(
      `patterns and repeat would write ${total} notes; at most ${MAX_EXPANDED_NOTES} are allowed.`,
    );
  if (!input.repeat) return { notes: base };
  if (!base.length) throw new UsageError("repeat needs notes or patterns to repeat.");
  const { length, times } = input.repeat;
  const out = [...base];
  for (let k = 1; k < copies; k++)
    for (const n of base) {
      const startTime = n.startTime + k * length;
      if (times === undefined && startTime >= end - 1e-9) continue;
      out.push({ ...n, startTime });
    }
  return { notes: out, copies };
}

// Which notes a MIDI read or edit applies to: all given filters must match.
const noteSelectSchema = () =>
  z.object({
    pitch_min: pitchSchema("Lowest pitch").optional(),
    pitch_max: pitchSchema("Highest pitch").optional(),
    time_min: z.number().optional().describe("Earliest start time, in beats"),
    time_max: z.number().optional().describe("Latest start time, in beats"),
    in_scale: z
      .boolean()
      .optional()
      .describe(
        "true: only notes in the scale, false: only notes outside it. The scale is the song's (in " +
          "midi_clip_edit_notes: snap_to_scale's, when given)",
      ),
    only_selected: z
      .boolean()
      .optional()
      .describe(
        "Only the notes selected in Live's MIDI editor. Whether Live reports the selection to " +
          "extensions is unverified: a `warning` says when it reported none",
      ),
    every_nth: z
      .union([
        z.number().int().min(1),
        z.object({ n: z.number().int().min(1), offset: z.number().int().min(0).default(0) }),
      ])
      .optional()
      .describe(
        "Every n-th of the notes the other filters match, in time order (start, then pitch): 2 = the " +
          "1st, 3rd, 5th, ...; {n: 2, offset: 1} = the 2nd, 4th, ...",
      ),
  });
type NoteSelect = z.output<ReturnType<typeof noteSelectSchema>>;

// A scale: Live's current one, or a root and semitone intervals.
const scaleSchema = () =>
  z.union([
    z.literal("song"),
    z.object({
      root: z
        .union([z.number().int().min(0).max(11), z.string().min(1)])
        .describe('Root as 0-11 (C = 0) or a note name such as "D" or "F#"'),
      intervals: z
        .array(z.number().int())
        .min(1)
        .describe("Semitone offsets from the root, e.g. [0, 2, 3, 5, 7, 8, 10] (natural minor)"),
    }),
  ]);
type ScaleSpec = z.output<ReturnType<typeof scaleSchema>>;
type Scale = { root_note: number; intervals: number[]; name?: string };

const pitchClass = (pitch: number, root: number) => (((pitch - root) % 12) + 12) % 12;
const inScale = (pitch: number, s: Scale) => s.intervals.includes(pitchClass(pitch, s.root_note));

// The nearest pitch in the scale, the lower one on a tie (within 0-127).
function snapToScale(pitch: number, s: Scale): number {
  for (let d = 0; d < 12; d++) {
    if (pitch - d >= 0 && inScale(pitch - d, s)) return pitch - d;
    if (pitch + d <= 127 && inScale(pitch + d, s)) return pitch + d;
  }
  return pitch; // unreachable: every octave holds a scale degree
}

// A grid in beats, or "song": Live's arrangement grid setting.
const gridSchema = (what: string) =>
  z
    .union([z.number().positive(), z.literal("song")])
    .describe(
      `${what} in beats (0.25 = 1/16), or "song" for Live's grid setting (the arrangement grid, ` +
        "not the clip editor's; bar grids assume the first scene's time signature)",
    );

// Indices of notes in time order: start, then pitch, then list position.
const timeOrder = (notes: NoteDescription[]) =>
  notes
    .map((_, i) => i)
    .sort(
      (a, b) =>
        num(notes[a].startTime) - num(notes[b].startTime) || num(notes[a].pitch) - num(notes[b].pitch) || a - b,
    );

// Validates a `select` and returns which of a clip's notes it matches.
function noteFilter(sel: NoteSelect, scale?: Scale): (notes: NoteDescription[]) => boolean[] {
  const lo = sel.pitch_min === undefined ? 0 : parsePitch(sel.pitch_min, "select.pitch_min");
  const hi = sel.pitch_max === undefined ? 127 : parsePitch(sel.pitch_max, "select.pitch_max");
  const nth = typeof sel.every_nth === "number" ? { n: sel.every_nth, offset: 0 } : sel.every_nth;
  const matches = (n: NoteDescription) => {
    const pitch = num(n.pitch);
    const start = num(n.startTime);
    return (
      pitch >= lo &&
      pitch <= hi &&
      (sel.time_min === undefined || start >= sel.time_min) &&
      (sel.time_max === undefined || start <= sel.time_max) &&
      (sel.in_scale === undefined || inScale(pitch, scale!) === sel.in_scale) &&
      (!sel.only_selected || n.selected === true)
    );
  };
  return (notes) => {
    const mask = notes.map(matches);
    if (nth) {
      let k = 0; // position among the matching notes
      for (const i of timeOrder(notes)) {
        if (!mask[i]) continue;
        mask[i] = k >= nth.offset && (k - nth.offset) % nth.n === 0;
        k++;
      }
    }
    return mask;
  };
}

// only_selected matched nothing because Live reports no selection: say so.
function selectionWarning(notes: NoteDescription[]): string | undefined {
  if (!notes.length || notes.some((n) => n.selected === true)) return undefined;
  return notes.some((n) => typeof n.selected === "boolean")
    ? "No note of this clip is selected in Live."
    : "Live reported no selection state for this clip's notes, so none counts as selected.";
}

// A note as midi_clip_get_notes returns it. `selected` is the user's note
// selection in Live, when the host reports it.
function noteOut(n: NoteDescription) {
  const opt = (v: number | bigint | undefined) => (v === undefined ? undefined : num(v));
  return {
    pitch: num(n.pitch),
    start_time: num(n.startTime),
    duration: num(n.duration),
    velocity: opt(n.velocity),
    muted: n.muted,
    probability: opt(n.probability),
    velocity_deviation: opt(n.velocityDeviation),
    release_velocity: opt(n.releaseVelocity),
    selected: n.selected,
  };
}
type NoteOut = ReturnType<typeof noteOut>;

// format "compact": each note is [pitch, start_time, duration, velocity], plus
// an object of its other fields that differ from `defaults`: each field's most
// common value in this result. A field the host leaves out counts as Live's
// default value for it (NOTE_DEFAULTS), as it does when notes are written.
const NOTE_DEFAULTS = {
  muted: false,
  probability: 1,
  velocity_deviation: 0,
  release_velocity: 64,
  selected: false,
};
const COMPACT_EXTRAS = Object.keys(NOTE_DEFAULTS) as Array<keyof typeof NOTE_DEFAULTS>;
function compactNotes(notes: NoteOut[]) {
  const value = (n: NoteOut, f: (typeof COMPACT_EXTRAS)[number]) => n[f] ?? NOTE_DEFAULTS[f];
  const defaults: Record<string, unknown> = { ...NOTE_DEFAULTS };
  for (const f of COMPACT_EXTRAS) {
    const counts = new Map<unknown, number>();
    for (const n of notes) counts.set(value(n, f), (counts.get(value(n, f)) ?? 0) + 1);
    let best = 0;
    for (const [v, c] of counts)
      if (c > best) {
        best = c;
        defaults[f] = v;
      }
  }
  return {
    format: "compact",
    fields: ["pitch", "start_time", "duration", "velocity"],
    defaults,
    notes: notes.map((n) => {
      const tuple: unknown[] = [n.pitch, n.start_time, n.duration, n.velocity ?? null];
      const differs = COMPACT_EXTRAS.filter((f) => value(n, f) !== defaults[f]);
      if (differs.length) tuple.push(Object.fromEntries(differs.map((f) => [f, value(n, f)])));
      return tuple;
    }),
  };
}

// Swing: in each pair of grid steps the off-beat step moves amount × grid/2
// later; the positions between move proportionally, on-beat steps stay.
function swingTime(t: number, grid: number, amount: number): number {
  const pair = 2 * grid;
  const base = Math.floor(t / pair) * pair;
  const p = t - base;
  const off = grid * (1 + amount / 2); // where the off-beat step lands
  return base + (p <= grid ? (p * off) / grid : off + ((p - grid) * (pair - off)) / grid);
}

// Notes starting less than this many beats apart are one chord for legato.
const CHORD_WINDOW = 1 / 64;
// Durations a transform shortens stay at least this long (beats).
const MIN_NOTE_DURATION = 1 / 256;

// legato: each chord (notes starting less than CHORD_WINDOW apart) lasts until
// the next chord starts; the last chord keeps its length.
function legato(notes: NoteDescription[]) {
  const chords: NoteDescription[][] = [];
  for (const t of [...notes].sort((a, b) => a.startTime - b.startTime)) {
    const chord = chords[chords.length - 1];
    if (chord && t.startTime - chord[0].startTime < CHORD_WINDOW) chord.push(t);
    else chords.push([t]);
  }
  for (let c = 0; c + 1 < chords.length; c++)
    for (const t of chords[c]) t.duration = Math.max(MIN_NOTE_DURATION, chords[c + 1][0].startTime - t.startTime);
}

// Seeded PRNG (mulberry32): one seed humanizes the same notes the same way.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const loopSettingsShape = z
  .object({
    looping: z.boolean(),
    start_marker: z.number(),
    end_marker: z.number(),
    loop_start: z.number(),
    loop_end: z.number(),
  })
  .describe(
    "Initial clip region/loop, all positions in beats. Loop must be >= 0.25 beats. " +
      "When looping is false, loop_start/loop_end must equal start_marker/end_marker. " +
      "Unwarped clips require looping=false and non-negative positions.",
  );

// The host rejects most async operations with no error value at all — surface
// something actionable instead of "undefined".
function errorMessage(e: unknown): string {
  return e instanceof Error
    ? e.message
    : e === undefined
      ? "the Live host rejected the operation without details — check argument " +
        "values (device name spelling, index ranges, file paths, clip overlaps)."
      : String(e);
}

// Shared addressing: a tool that acts on one track takes any of track_id,
// track_index and track_name, a scene tool any of scene_id, scene_index and
// scene_name. When several are given they must name the same object.
const trackAddress = {
  track_id: z.string().optional().describe("Track id"),
  track_index: z.number().int().min(0).optional().describe("0-based index among the regular tracks"),
  track_name: z
    .string()
    .optional()
    .describe("Track name, exact match first, then case-insensitive (regular, return and main tracks)"),
};
const sceneAddress = {
  scene_id: z.string().optional().describe("Scene id"),
  scene_index: z.number().int().min(0).optional().describe("0-based scene index"),
  scene_name: z.string().optional().describe("Scene name, exact match first, then case-insensitive"),
};
// Destructive tools match names exactly: a case-insensitive guess must not delete.
const exactTrackName = z.string().optional().describe("Exact track name (case-sensitive)");
const exactSceneName = z.string().optional().describe("Exact scene name (case-sensitive)");

type TrackAddress = { track_id?: string; track_index?: number; track_name?: string };
type SceneAddress = { scene_id?: string; scene_index?: number; scene_name?: string };

// Device addressing: device_id, or the device's track plus `device`, a device
// name or index on the track or a path into racks. In a path, a name or index
// picks from the current device list; after a rack, {chain: index} or a Drum
// Rack {pad: note} picks the chain whose devices the next step picks from.
const chainStep = z.union([
  z.object({ chain: z.number().int().min(0).describe("0-based chain index in the rack") }).strict(),
  z.object({ pad: pitchSchema("Drum Rack pad: the chain's receiving MIDI note") }).strict(),
]);
// A fresh instance per use: a schema used twice in one tool becomes a JSON
// Schema $ref, which some clients do not resolve.
const deviceStep = () =>
  z.union([
    z.string().min(1).describe("Device name, exact match first, then case-insensitive"),
    z.number().int().min(0).describe("0-based position in the device list"),
  ]);
const deviceAddress = {
  device_id: z.string().optional().describe("Device id"),
  ...trackAddress,
  device: z
    .union([deviceStep(), z.array(z.union([deviceStep(), chainStep])).min(1)])
    .optional()
    .describe(
      "With a track instead of device_id: the device's name or 0-based index on the track, or a " +
        'path into racks, e.g. ["Drum Rack", {"pad": 36}, "Simpler"] or [0, {"chain": 1}, "Reverb"]',
    ),
};
type ChainStep = { chain: number } | { pad: number | string };
type DeviceAddress = TrackAddress & {
  device_id?: string;
  device?: string | number | Array<string | number | ChainStep>;
};

// A parameter by id, or by its device and name.
const parameterAddress = {
  parameter_id: z.string().optional().describe("Parameter id (from device_get, mixer_get, parameter_find, ...)"),
  ...deviceAddress,
  parameter: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Instead of parameter_id: the parameter's name on the device (device_id, or track + device); " +
        "exact match first, then case-insensitive, then unique substring",
    ),
};
type ParameterAddress = DeviceAddress & { parameter_id?: string; parameter?: string };

// One parameter write: exactly one of value, value_item, reset and delta.
// Values are internal units: the API has no display values (dB, Hz, ms).
const parameterWrite = {
  value: z
    .number()
    .optional()
    .describe("Internal units within [min, max]; a quantized parameter takes its value_items index"),
  value_item: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Quantized parameters: the choice by value_items name or short name (exact, then " +
        'case-insensitive, then unique substring), e.g. "Saw"',
    ),
  reset: z.boolean().optional().describe("true: set the parameter to its default value"),
  delta: z
    .number()
    .optional()
    .describe("Add this to the current value, clamped to [min, max] (whole steps for quantized parameters)"),
};
type ParameterWrite = { value?: number; value_item?: string; reset?: boolean; delta?: number };
const parameterName = z
  .string()
  .min(1)
  .describe("Parameter name: exact match first, then case-insensitive, then unique substring");
// Initial values of a device that is being inserted (track_create, device_insert).
const initialParameter = z.object({ name: parameterName, ...parameterWrite });

const given = (o: object, keys: readonly string[]) =>
  keys.some((k) => (o as Record<string, unknown>)[k] !== undefined);
const hasTrackAddress = (a: TrackAddress) => given(a, ["track_id", "track_index", "track_name"]);
const hasSceneAddress = (a: SceneAddress) => given(a, ["scene_id", "scene_index", "scene_name"]);

// Batch form of the *_set and create tools: `items`, one entry per object with
// the same fields as the single form. Returns the entries to apply and whether
// the call was a batch (batch results are wrapped in {items}).
function entries<T extends object>(
  args: T,
  items: T[] | undefined,
  fields: readonly string[],
): { list: T[]; batch: boolean } {
  if (items === undefined) return { list: [args], batch: false };
  const top = fields.filter((k) => given(args, [k]));
  if (top.length)
    throw new UsageError(`Give either items or ${top.join(", ")} at the top level, not both.`);
  return { list: items, batch: true };
}

const itemLabel = (batch: boolean, i: number) => (batch ? `items[${i}]` : undefined);

// Runs one entry's validation and prefixes its errors with the entry's label
// (a function when building it costs host calls). The error keeps its class,
// so a UsageError stays one.
function at<R>(label: string | (() => string) | undefined, fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (label && e instanceof Error)
      e.message = `${typeof label === "function" ? label() : label}: ${e.message}`;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// device presets: this server's own JSON files in <storageDirectory>/presets

const PRESET_FORMAT = "ableton-live-mcp/device-preset";
const presetSchema = z.object({
  format: z.literal(PRESET_FORMAT),
  version: z.literal(1),
  name: z.string(),
  device_name: z.string().min(1),
  device_class: z.string().optional(),
  saved_at: z.string().optional(),
  parameters: z.array(z.object({ name: z.string(), value: z.number() })),
  sample: z.object({ file_path: z.string().min(1) }).nullable().optional(),
});
type Preset = z.infer<typeof presetSchema>;

// A preset name is also its file name, so it must be one safe path component
// on every OS: letters (with combining marks), digits, spaces and a few
// punctuation marks, starting with a letter or digit (so never ".", ".." or a
// hidden file), not ending in a dot (Windows drops those), and not a Windows
// device name. Path separators, ":" and control characters can never pass.
const PRESET_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _\-.,()'+&#]*$/u;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function presetBaseName(raw: string): string {
  const name = raw.normalize("NFC").trim();
  if (!name || name.length > 64) throw new UsageError("Preset names are 1-64 characters long.");
  if (!PRESET_NAME.test(name) || /[. ]$/.test(name) || WINDOWS_DEVICE_NAME.test(name))
    throw new UsageError(
      `Invalid preset name ${JSON.stringify(raw)}: use letters, digits, spaces and - _ . , ( ) ' + & #, ` +
        "starting with a letter or digit and not ending with a dot.",
    );
  return name;
}

function readPresetFile(file: string): Preset {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file.`);
  if (stat.size > 4_000_000) throw new Error(`${file} is too large for a preset.`);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(e)}`);
  }
  const parsed = presetSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join(".") || "file";
    throw new Error(`${file} is not a device preset of this server (${where}: ${issue.message}).`);
  }
  return parsed.data;
}

function presetStore(storageDirectory: string | undefined) {
  if (!storageDirectory)
    throw new Error("Live provides no storage directory for this extension, so presets cannot be stored.");
  const dir = path.join(storageDirectory, "presets");
  // Every path stays a direct child of dir (names are checked, this is the backstop).
  const inside = (file: string) => {
    const full = path.resolve(dir, file);
    if (path.dirname(full) !== path.resolve(dir)) throw new Error(`Refusing a preset path outside ${dir}.`);
    return full;
  };
  // Regular *.json files only: a symlink is never followed out of dir, and
  // temporary files (dot names) are not presets.
  const files = (): string[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names
      .filter((f) => {
        if (!f.endsWith(".json") || f.startsWith(".")) return false;
        try {
          return fs.lstatSync(inside(f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  };
  // The name a file is loaded by: its base name (NFC, as names are compared).
  const nameOf = (file: string) => path.basename(file, ".json").normalize("NFC");
  // A name's file: exact first, then case-insensitive (macOS and Windows
  // file systems treat "Bass" and "bass" as one file anyway).
  const fileOf = (base: string) => {
    const all = files();
    const hit =
      all.find((f) => nameOf(f) === base) ?? all.find((f) => nameOf(f).toLowerCase() === base.toLowerCase());
    return hit === undefined ? undefined : inside(hit);
  };
  return {
    dir,
    find: fileOf,
    list() {
      const presets: Array<{ name: string; preset: Preset }> = [];
      const unreadable: Array<{ file: string; error: string }> = [];
      for (const f of files()) {
        try {
          presets.push({ name: nameOf(f), preset: readPresetFile(inside(f)) });
        } catch (e) {
          unreadable.push({ file: f, error: errorMessage(e) });
        }
      }
      return { presets, unreadable };
    },
    // Returns the name the preset is stored (and loaded) under.
    write(base: string, preset: Preset, overwrite: boolean): { name: string; replaced: boolean } {
      const existing = fileOf(base);
      if (existing && !overwrite)
        throw new UsageError(
          `A preset named ${JSON.stringify(nameOf(existing))} already exists. ` +
            "Pass overwrite:true to replace it.",
        );
      fs.mkdirSync(dir, { recursive: true });
      // an overwrite keeps the existing file, and so its name's case
      const name = existing ? nameOf(existing) : base;
      const data = `${JSON.stringify({ ...preset, name }, null, 2)}\n`;
      if (!existing) {
        // "wx": fails instead of replacing a file (or symlink) created meanwhile
        fs.writeFileSync(inside(`${base}.json`), data, { flag: "wx" });
        return { name, replaced: false };
      }
      // Replace atomically: rename swaps the directory entry, so it never
      // writes through a symlink.
      const tmp = inside(`.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(tmp, data, { flag: "wx" });
      try {
        fs.renameSync(tmp, existing);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      return { name, replaced: true };
    },
  };
}

// ---------------------------------------------------------------------------
// tool registration

function buildServer(
  context: Ctx,
  hostApiVersion: string,
  port: number,
  selections: SelectionStore,
): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const song = () => context.application.song;
  // Transport-level failures (unparsable bodies, bad headers) are answered to
  // the client by the SDK; log them so they leave a trace in ExtensionHost.txt.
  server.server.onerror = (e) => console.error("[ableton-live-mcp] MCP error:", e.message);

  function tool<S extends ZodRawShape>(
    name: string,
    meta: ToolMeta,
    description: string,
    shape: S,
    handler: (
      args: z.objectOutputType<S, z.ZodTypeAny>,
      extra: ToolExtra,
    ) => Promise<unknown> | unknown,
  ) {
    // A tools/call without `arguments` is validated as `{}` by the SDK, so the
    // plain shape works; `?? {}` only guards the handler contract.
    const config = { ...meta, description, inputSchema: shape as never };
    server.registerTool(name, config, (async (args: never, extra: ToolExtra) => {
      const started = Date.now();
      try {
        return json(await handler(args ?? ({} as never), extra));
      } catch (e) {
        const msg = errorMessage(e);
        // Never log the arguments: they can carry the user's content.
        console.error(`[ableton-live-mcp] ${name} failed after ${Date.now() - started} ms: ${msg}`);
        // Argument errors the server detects itself have nothing to do with stale ids.
        const text = e instanceof UsageError ? `Error: ${msg}` : `Error: ${msg}\n${STALE_HINT}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }) as never);
  }

  // -- song ------------------------------------------------------------------

  // song_get sections: the default ones, and the deep ones that are only
  // included when asked for. The deep ones add to every track entry.
  const SONG_SECTIONS = ["tracks", "scenes", "cue_points", "environment"] as const;
  const DEEP_SECTIONS = ["devices", "mixer", "clips"] as const;
  // Deep sections stop at this many devices / clips (payload size).
  const MAX_SONG_DEVICES = 500;
  const MAX_SONG_CLIPS = 500;
  // Racks inside racks are followed this deep (song_get, song_audit).
  const MAX_RACK_DEPTH = 8;

  tool(
    "song_get",
    { title: "Get Live Set", annotations: READ },
    "Get the state of the current Live Set: tempo, scale, grid, all tracks " +
      "(with ids, `index`, and the group hierarchy: `depth`, `group_track_id`, type " +
      "'group' with `child_track_ids` for group tracks), return tracks (with " +
      "`send_index`), main track, scenes, cue points, and extension environment " +
      "info. This is the entry point — object ids returned here are used by every " +
      "other tool. Times are in beats throughout the API. Use `include` to fetch " +
      "only some sections (tempo/grid/scale always included). Deep sections, only " +
      "included when listed, add to every track entry (and imply the tracks): " +
      "`devices` (each track's device tree through racks: chains with their devices; " +
      "every device with its on-state `enabled`), `mixer` (volume, panning and sends " +
      "with values and return track names; mixer_get has the parameter ids), " +
      "`clips` (regular tracks: session clips with their scene_index and arrangement " +
      "clips with their position, in brief — clip_get has the detail). Deep sections " +
      `stop at ${MAX_SONG_DEVICES} devices and ${MAX_SONG_CLIPS} clips: from the track ` +
      "that does not fit on, tracks lack that section and `truncated` says so " +
      "(use track_get / device_get for them).",
    {
      include: z
        .array(z.enum([...SONG_SECTIONS, ...DEEP_SECTIONS]))
        .optional()
        .describe(
          "Sections to include; omit for tracks, scenes, cue_points and environment. " +
            "devices, mixer and clips are only included when listed",
        ),
    },
    async ({ include }) => {
      const s = song();
      const want = (k: string) =>
        include ? include.includes(k as never) : (SONG_SECTIONS as readonly string[]).includes(k);
      const deep = DEEP_SECTIONS.filter(want);
      const withTracks = want("tracks") || deep.length > 0;
      let tracks: Record<string, unknown>[] | undefined;
      let returnTracks: Record<string, unknown>[] | undefined;
      let mainTrack: Record<string, unknown> | undefined;
      let truncated: Record<string, string> | undefined;
      if (withTracks) {
        const regular = s.tracks;
        const returns = s.returnTracks;
        tracks = groupHierarchy(regular.map((t, index) => ({ ...summarizeTrack(t, regular), index })));
        returnTracks = returns.map((t, i) => ({ ...trackSummary(t, "return"), send_index: i }));
        mainTrack = trackSummary(s.mainTrack, "main");
        if (deep.length)
          truncated = await addDeepSections(
            [...regular, ...returns, s.mainTrack],
            [...tracks, ...returnTracks, mainTrack],
            regular.length,
            deep,
          );
      }
      return {
        tempo: num(s.tempo),
        grid: { quantization: gridName(s.gridQuantization), is_triplet: s.gridIsTriplet },
        scale: {
          root_note: num(s.rootNote),
          name: s.scaleName,
          mode_enabled: s.scaleMode,
          intervals: s.scaleIntervals.map(num),
        },
        tracks,
        return_tracks: returnTracks,
        main_track: mainTrack,
        scenes: want("scenes") ? s.scenes.map(sceneSummary) : undefined,
        cue_points: want("cue_points") ? s.cuePoints.map(cuePointSummary) : undefined,
        environment: want("environment")
          ? {
              storage_directory: context.environment.storageDirectory,
              temp_directory: context.environment.tempDirectory,
              language: context.environment.language,
              host_api_version: hostApiVersion,
              server_version: SERVER_INFO.version,
              mcp_port: port,
            }
          : undefined,
        truncated,
      };
    },
  );

  // The group hierarchy of song_get's track entries, from their group_track_id:
  // `depth` (0 = top level) on every track, `child_track_ids` (direct children,
  // in track order) on group tracks.
  function groupHierarchy<T extends { id: string; type: string; group_track_id: string | null }>(rows: T[]) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children = new Map<string, string[]>();
    for (const r of rows)
      if (r.group_track_id !== null) children.set(r.group_track_id, [...(children.get(r.group_track_id) ?? []), r.id]);
    return rows.map((r) => {
      let depth = 0;
      for (let g = r.group_track_id; g !== null && depth < 64; g = byId.get(g)?.group_track_id ?? null) depth++;
      return { ...r, depth, child_track_ids: r.type === "group" ? (children.get(r.id) ?? []) : undefined };
    });
  }

  // song_get's deep sections, added to the track entries (rows[i] belongs to
  // tracks[i]; the first `regularCount` are the regular tracks). All parameter
  // values (on-states, mixers) are read in one batch. Returns what was cut.
  async function addDeepSections(
    tracks: Track<"1.0.0">[],
    rows: Record<string, unknown>[],
    regularCount: number,
    deep: ReadonlyArray<(typeof DEEP_SECTIONS)[number]>,
  ): Promise<Record<string, string> | undefined> {
    const truncated: Record<string, string> = {};
    const cut = (what: string, limit: number, track: Track<"1.0.0">, instead: string) =>
      `Only ${limit} ${what} are listed: ${describeTrack(track)} and the tracks after it have no ` +
      `\`${what}\`. Use ${instead} for them.`;
    const states: OnState[] = [];
    if (deep.includes("devices")) {
      const budget = { left: MAX_SONG_DEVICES };
      for (const [i, track] of tracks.entries()) {
        const own: OnState[] = [];
        const tree = deviceTree(track.devices, budget, own);
        if (!tree) {
          truncated.devices = cut("devices", MAX_SONG_DEVICES, track, "track_get or device_get {include_chain_devices}");
          break;
        }
        rows[i].devices = tree;
        states.push(...own);
      }
    }
    const returnNames = song().returnTracks.map((t) => t.name);
    const [onValues, mixers] = await Promise.all([
      Promise.all(states.map((st) => st.param.getValue().then(num, () => undefined))),
      deep.includes("mixer") ? Promise.all(tracks.map((t) => mixerSnapshot(t.mixer, returnNames))) : undefined,
    ]);
    states.forEach((st, i) => {
      if (onValues[i] !== undefined) st.node.enabled = onValues[i] !== st.off;
    });
    mixers?.forEach((m, i) => (rows[i].mixer = m));
    if (deep.includes("clips")) {
      let left = MAX_SONG_CLIPS;
      for (const [i, track] of tracks.slice(0, regularCount).entries()) {
        const slots = track.clipSlots.map((slot) => ({ slot, clip: slot.clip }));
        const arrangement = track.arrangementClips;
        const count = slots.filter((x) => x.clip).length + arrangement.length;
        if (count > left) {
          truncated.clips = cut("clips", MAX_SONG_CLIPS, track, "track_get or session_grid / arrangement_get");
          break;
        }
        left -= count;
        rows[i].clips = {
          session: slots.flatMap(({ slot, clip }, scene_index) =>
            clip ? [{ scene_index, slot_id: remember(slot), ...clipBrief(clip) }] : [],
          ),
          arrangement: arrangement.map((c) => clipBrief(c, true)),
        };
      }
    }
    return Object.keys(truncated).length ? truncated : undefined;
  }

  // A device on/off switch whose value song_get reads in its batch.
  type OnState = { node: Record<string, unknown>; param: DeviceParameter<"1.0.0">; off: number };

  // song_get devices: a device list as a tree through racks, or null when the
  // budget runs out. On-states to read are collected in `states`.
  function deviceTree(
    devices: Device<"1.0.0">[],
    budget: { left: number },
    states: OnState[],
    depth = 0,
  ): Record<string, unknown>[] | null {
    const nodes: Record<string, unknown>[] = [];
    for (const device of devices) {
      if (budget.left <= 0) return null;
      budget.left--;
      const node = deviceSummary(device);
      node.enabled = undefined; // filled in once the values are read (keeps the key order)
      try {
        const onOff = onOffParameter(device);
        states.push({ node, param: onOff.param, off: onOff.off });
        // not "Device On": say which parameter tells the on-state
        if (onOff.fallback) node.on_parameter = onOff.param.name;
      } catch {
        // no on/off switch: no `enabled`
      }
      if (device instanceof RackDevice && depth < MAX_RACK_DEPTH) {
        const chains: Record<string, unknown>[] = [];
        for (const chain of device.chains) {
          const inner = deviceTree(chain.devices, budget, states, depth + 1);
          if (!inner) return null;
          chains.push({ ...chainSummary(chain), devices: inner });
        }
        delete node.chain_ids; // `chains` carries them
        node.chains = chains;
      }
      nodes.push(node);
    }
    return nodes;
  }

  // song_get mixer: values only (mixer_get has the parameter ids and ranges).
  async function mixerSnapshot(mixer: TrackMixer<"1.0.0">, returnNames: string[]) {
    const sends = mixer.sends;
    const [volume, panning, ...sendValues] = await Promise.all(
      [mixer.volume, mixer.panning, ...sends].map((p) => p.getValue()),
    );
    return {
      id: remember(mixer),
      volume: num(volume),
      panning: num(panning),
      sends: sendValues.map((v, index) => ({ index, return_track: returnNames[index], value: num(v) })),
    };
  }

  tool(
    "song_set",
    { title: "Set song properties", annotations: SET },
    "Set song-level properties of the Live Set.",
    { tempo: z.number().min(20).max(999).optional().describe("Tempo in BPM") },
    ({ tempo }) => {
      if (tempo !== undefined) song().tempo = tempo;
      return { tempo: num(song().tempo) };
    },
  );

  const AUDIT_CHECKS = ["missing_media", "empty_simplers", "empty_drum_chains", "duplicate_track_names"] as const;
  type AuditCheck = (typeof AUDIT_CHECKS)[number];
  const MAX_AUDIT_ENTRIES = 100; // listed per check; `counts` has them all
  const MAX_AUDIT_DEVICES = 5000;
  const MAX_AUDIT_CLIPS = 10_000;

  // Why a media file a clip or sample refers to is unusable, or undefined if
  // it is a readable file. The paths are assumed to be absolute paths on this
  // computer (the SDK only calls them file paths).
  function mediaProblem(file: string): string | undefined {
    if (!file) return "no file path";
    if (!path.isAbsolute(file)) return "not an absolute path, so it could not be checked";
    try {
      return fs.statSync(file).isFile() ? undefined : "not a file";
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "file not found" : `cannot be read (${code ?? errorMessage(e)})`;
    }
  }

  tool(
    "song_audit",
    { title: "Audit Live Set", annotations: READ },
    "Check the Live Set for common problems without changing anything: " +
      "`missing_media` (audio clips — session, arrangement and take lanes — and " +
      "Simpler samples whose file is not found on this computer, or that have no " +
      "file path), `empty_simplers` (Simplers without a sample), `empty_drum_chains` " +
      "(Drum Rack pads without devices) and `duplicate_track_names` (track names " +
      "that are equal ignoring case, which makes track_name ambiguous). Searches " +
      "regular, return and main tracks, through racks. Every entry has the ids to act " +
      "on and a `location` (track, path through racks, or a clip's slot or lane); at " +
      `most ${MAX_AUDIT_ENTRIES} entries are listed per check, \`counts\` has the totals. ` +
      "`checks` runs only some of them.",
    {
      checks: z
        .array(z.enum(AUDIT_CHECKS))
        .min(1)
        .optional()
        .describe("Checks to run; omit for all four"),
    },
    ({ checks }) => {
      const run = (c: AuditCheck) => !checks || checks.includes(c);
      const ran = AUDIT_CHECKS.filter(run);
      const s = song();
      const regular = s.tracks;
      const all = [...regular, ...s.returnTracks, s.mainTrack];
      const counts = Object.fromEntries(ran.map((c) => [c, 0])) as Record<AuditCheck, number>;
      const lists = Object.fromEntries(ran.map((c) => [c, [] as unknown[]])) as Record<AuditCheck, unknown[]>;
      const add = (check: AuditCheck, entry: () => unknown) => {
        counts[check]++;
        if (lists[check].length < MAX_AUDIT_ENTRIES) lists[check].push(entry());
      };
      const refs = new Map<bigint, ReturnType<typeof trackRef>>();
      const ref = (track: Track<"1.0.0">) => {
        if (!refs.has(track.handle.id)) refs.set(track.handle.id, trackRef(track, regular));
        return refs.get(track.handle.id)!;
      };
      const files = new Map<string, string | undefined>();
      const fileProblem = (file: string) => {
        if (!files.has(file)) files.set(file, mediaProblem(file));
        return files.get(file);
      };
      const incomplete: string[] = [];
      let devicesSearched = 0;
      let devicesStopped = false;
      let clipsSearched = 0;

      // devices: Simplers and their samples, Drum Rack pads
      if (run("missing_media") || run("empty_simplers") || run("empty_drum_chains")) {
        const walk = (devices: Device<"1.0.0">[], track: Track<"1.0.0">, labels: string[], depth: number) => {
          for (const device of devices) {
            if (devicesSearched >= MAX_AUDIT_DEVICES) {
              devicesStopped = true;
              return;
            }
            devicesSearched++;
            const here = [...labels, device.name];
            const location = () => ({ ...ref(track), path: here.join(" > ") });
            if (device instanceof Simpler) {
              const sample = device.sample;
              if (!sample) {
                if (run("empty_simplers")) add("empty_simplers", () => ({ device_id: remember(device), location: location() }));
              } else if (run("missing_media")) {
                const filePath = sample.filePath;
                const problem = fileProblem(filePath);
                if (problem)
                  add("missing_media", () => ({
                    kind: "simpler_sample",
                    device_id: remember(device),
                    sample_id: remember(sample),
                    file_path: filePath,
                    problem,
                    location: location(),
                  }));
              }
            }
            if (device instanceof RackDevice && depth < MAX_RACK_DEPTH)
              device.chains.forEach((chain, i) => {
                const label = chainLabel(chain, i);
                const inner = chain.devices;
                if (chain instanceof DrumChain && !inner.length && run("empty_drum_chains"))
                  add("empty_drum_chains", () => ({
                    ...chainSummary(chain),
                    rack_device_id: remember(device),
                    location: { ...ref(track), path: [...here, label].join(" > ") },
                  }));
                walk(inner, track, [...here, label], depth + 1);
              });
          }
        };
        for (const track of all) walk(track.devices, track, [track.name], 0);
        if (devicesStopped)
          incomplete.push(`Stopped after ${MAX_AUDIT_DEVICES} devices: later devices were not checked.`);
      }

      // audio clips' files
      if (run("missing_media")) {
        clips: for (const track of regular)
          for (const clip of clipsOf(track, "all")) {
            if (clipsSearched >= MAX_AUDIT_CLIPS) {
              incomplete.push(`Stopped after ${MAX_AUDIT_CLIPS} clips: later clips were not checked.`);
              break clips;
            }
            clipsSearched++;
            if (!(clip instanceof AudioClip)) continue;
            const filePath = clip.filePath;
            const problem = fileProblem(filePath);
            if (problem)
              add("missing_media", () => ({
                kind: "audio_clip",
                clip_id: remember(clip),
                clip_name: clip.name,
                file_path: filePath,
                problem,
                location: clipLocation(clip),
              }));
          }
      }

      // names that make track_name ambiguous
      if (run("duplicate_track_names")) {
        const byName = new Map<string, Track<"1.0.0">[]>();
        for (const track of all) {
          const key = track.name.toLowerCase();
          byName.set(key, [...(byName.get(key) ?? []), track]);
        }
        for (const same of byName.values())
          if (same.length > 1)
            add("duplicate_track_names", () => ({
              name: same[0].name,
              case_differs: same.some((t) => t.name !== same[0].name) || undefined,
              tracks: same.map(ref),
            }));
      }

      const issues = ran.reduce((n, c) => n + counts[c], 0);
      return {
        issue_count: issues,
        counts,
        ...lists,
        truncated: ran.some((c) => counts[c] > lists[c].length)
          ? `At most ${MAX_AUDIT_ENTRIES} entries are listed per check; counts has the totals.`
          : undefined,
        searched: { tracks: all.length, devices: devicesSearched, clips: clipsSearched, files: files.size },
        incomplete: incomplete.length ? incomplete : undefined,
      };
    },
  );

  // -- addressing ------------------------------------------------------------

  const outOfRange = (what: string, i: number, n: number) =>
    new UsageError(`${what} ${i} out of range (${n ? `0-${n - 1}` : "there are none"}).`);

  // Name lookup: exact match first, then case-insensitive unless `exact`. An
  // ambiguous name lists only the candidates it matched, then `hint`.
  function byName<T>(
    what: string,
    name: string,
    all: T[],
    nameOf: (x: T) => string,
    describe: (x: T) => string,
    { exact = false, hint = "" }: { exact?: boolean; hint?: string } = {},
  ): T {
    const exactHits = all.filter((x) => nameOf(x) === name);
    const ciHits = all.filter((x) => nameOf(x).toLowerCase() === name.toLowerCase());
    const hits = exactHits.length || exact ? exactHits : ciHits;
    if (hits.length === 1) return hits[0];
    const quoted = JSON.stringify(name);
    if (hits.length)
      throw new UsageError(
        `Ambiguous ${what} name ${quoted}: it matches ${hits.map(describe).join(", ")}.${hint && ` ${hint}`}`,
      );
    if (exact && ciHits.length)
      throw new UsageError(
        `No ${what} named exactly ${quoted} (this tool needs the exact name). ` +
          `Did you mean ${ciHits.map(describe).join(", ")}?`,
      );
    const names = all.map((x) => JSON.stringify(nameOf(x)));
    const more = names.length > 50 ? `, ... (${names.length - 50} more)` : "";
    throw new UsageError(
      `No ${what} named ${quoted}. Available: ${names.slice(0, 50).join(", ") || "none"}${more}.`,
    );
  }

  // `"Drums" (track_index 2, id 15)`: enough for the caller to pick one.
  function describeTrack(t: Track<"1.0.0">): string {
    const s = song();
    const i = s.tracks.findIndex((x) => x.handle.id === t.handle.id);
    const where =
      i >= 0 ? `track_index ${i}` : t.handle.id === s.mainTrack.handle.id ? "main track" : "return track";
    return `${JSON.stringify(t.name)} (${where}, id ${remember(t)})`;
  }

  // Track addressing without a prior song_get: by id, by index (regular tracks)
  // or by name across regular, return and main tracks. Several fields must
  // agree, so a stale id cannot silently win over the name the caller meant.
  function findTrack(a: TrackAddress, opts: { exactName?: boolean } = {}): Track<"1.0.0"> {
    const s = song();
    const found: Track<"1.0.0">[] = [];
    if (a.track_id !== undefined) found.push(resolve(a.track_id, Track));
    if (a.track_index !== undefined) {
      const t = s.tracks[a.track_index];
      if (!t) throw outOfRange("track_index", a.track_index, s.tracks.length);
      found.push(t);
    }
    if (a.track_name !== undefined) {
      const all = [...s.tracks, ...s.returnTracks, s.mainTrack];
      found.push(
        byName("track", a.track_name, all, (t) => t.name, describeTrack, {
          exact: opts.exactName,
          hint: "Use track_id or track_index.",
        }),
      );
    }
    if (!found.length) throw new UsageError("Provide track_id, track_index, or track_name.");
    if (found.some((t) => t.handle.id !== found[0].handle.id))
      throw new UsageError(
        `track_id, track_index and track_name name different tracks: ${found.map(describeTrack).join(" vs ")}.`,
      );
    return found[0];
  }

  const describeScene = (scene: Scene<"1.0.0">, index: number) =>
    `${JSON.stringify(scene.name)} (scene_index ${index}, id ${remember(scene)})`;

  // Scenes by id, index or name; returns the scene and its index.
  function findScene(a: SceneAddress, opts: { exactName?: boolean } = {}) {
    const scenes = song().scenes;
    const found: number[] = [];
    if (a.scene_id !== undefined) {
      const scene = resolve(a.scene_id, Scene);
      const i = scenes.findIndex((x) => x.handle.id === scene.handle.id);
      // not a UsageError: a deleted scene's id is stale
      if (i < 0) throw new Error(`Scene "${a.scene_id}" is no longer in the Live Set.`);
      found.push(i);
    }
    if (a.scene_index !== undefined) {
      if (a.scene_index >= scenes.length) throw outOfRange("scene_index", a.scene_index, scenes.length);
      found.push(a.scene_index);
    }
    if (a.scene_name !== undefined) {
      const indexed = scenes.map((scene, index) => ({ scene, index }));
      const describe = (x: (typeof indexed)[number]) => describeScene(x.scene, x.index);
      const options = { exact: opts.exactName, hint: "Use scene_id or scene_index." };
      found.push(byName("scene", a.scene_name, indexed, (x) => x.scene.name, describe, options).index);
    }
    if (!found.length) throw new UsageError("Provide scene_id, scene_index, or scene_name.");
    if (found.some((i) => i !== found[0]))
      throw new UsageError(
        `scene_id, scene_index and scene_name name different scenes: ` +
          `${found.map((i) => describeScene(scenes[i], i)).join(" vs ")}.`,
      );
    return { scene: scenes[found[0]], index: found[0] };
  }

  // Tools that take a target_id (track, chain, slot, ...) accept a track
  // address in its place.
  function findTarget(a: { target_id?: string } & TrackAddress): DataModelObject<"1.0.0"> {
    if (a.target_id === undefined) {
      if (!hasTrackAddress(a))
        throw new UsageError("Provide target_id, or a track via track_id, track_index or track_name.");
      return findTrack(a);
    }
    if (hasTrackAddress(a))
      throw new UsageError("Give target_id or track_id/track_index/track_name, not both.");
    return resolve(a.target_id, DataModelObject);
  }

  function findMixer(a: { target_id?: string } & TrackAddress) {
    const owner = findTarget(a);
    const mixer =
      owner instanceof Track || owner instanceof Chain
        ? owner.mixer
        : owner instanceof TrackMixer || owner instanceof ChainMixer
          ? owner
          : null;
    if (!mixer) throw new UsageError(`Expected a Track, Chain, or mixer id, got ${classOf(owner)}.`);
    return { mixer, owner };
  }

  // -- track kinds and object locations ---------------------------------------

  const indexIn = (list: DataModelObject<"1.0.0">[], obj: DataModelObject<"1.0.0">) =>
    list.findIndex((x) => x.handle.id === obj.handle.id);

  // The API has no group-track class: a regular track that is neither an audio
  // nor a MIDI track is a group track. `regular` is song().tracks, passed in
  // by callers that already hold it.
  const isGroupTrack = (track: Track<"1.0.0">, regular = song().tracks) =>
    !(track instanceof AudioTrack) && !(track instanceof MidiTrack) && indexIn(regular, track) >= 0;

  // audio, midi, group, return or main.
  function trackKind(track: Track<"1.0.0">, regular = song().tracks): string {
    if (track instanceof AudioTrack) return "audio";
    if (track instanceof MidiTrack) return "midi";
    if (indexIn(regular, track) >= 0) return "group";
    const s = song();
    if (indexIn(s.returnTracks, track) >= 0) return "return";
    return track.handle.id === s.mainTrack.handle.id ? "main" : "other";
  }

  // trackSummary with type "group" for group tracks (return and main tracks
  // keep "other" here; song_get labels them by section).
  const summarizeTrack = (track: Track<"1.0.0">, regular = song().tracks) =>
    trackSummary(track, isGroupTrack(track, regular) ? "group" : undefined);

  // A track as locations name it: track_index only for regular tracks.
  function trackRef(track: Track<"1.0.0">, regular = song().tracks) {
    const i = indexIn(regular, track);
    return {
      track_id: remember(track),
      track_name: track.name,
      track_index: i >= 0 ? i : undefined,
      track_type: trackKind(track, regular),
    };
  }

  // Locations are derived from DataModelObject.parent, which the SDK only
  // documents as the "canonical parent". Assumed, as in Live's object model:
  // a clip slot's parent is its track; a clip's its slot, track (arrangement)
  // or take lane; a take lane's its track; a device's its track or chain; a
  // chain's its rack; a sample's its Simpler. A parent that is not what is
  // expected makes the location say less, never fail the call.
  function parentOf(obj: DataModelObject<"1.0.0">): DataModelObject<"1.0.0"> | null {
    try {
      return obj.parent;
    } catch {
      return null; // e.g. a parent of a class the SDK does not know
    }
  }

  // Session: the track and scene of a clip slot. When the slot's parent is not
  // its track, the tracks' slot lists are searched instead.
  function slotLocation(slot: ClipSlot<"1.0.0">) {
    const regular = song().tracks;
    let track = parentOf(slot);
    let index = track instanceof Track ? indexIn(track.clipSlots, slot) : -1;
    for (let t = 0; index < 0 && t < regular.length; t++) {
      index = indexIn(regular[t].clipSlots, slot);
      if (index >= 0) track = regular[t];
    }
    if (!(track instanceof Track) || index < 0) return { view: "session", clip_slot_id: remember(slot) };
    const scene = song().scenes[index];
    return {
      view: "session",
      ...trackRef(track, regular),
      scene_index: index,
      scene_id: scene ? remember(scene) : undefined,
      scene_name: scene?.name,
      clip_slot_id: remember(slot),
    };
  }

  function laneLocation(lane: TakeLane<"1.0.0">) {
    let track = parentOf(lane);
    if (!(track instanceof Track)) track = song().tracks.find((t) => indexIn(t.takeLanes, lane) >= 0) ?? null;
    const own = { take_lane_id: remember(lane), take_lane_name: lane.name };
    if (!(track instanceof Track)) return { view: "take_lane", ...own };
    return { view: "take_lane", ...trackRef(track), ...own, take_lane_index: indexIn(track.takeLanes, lane) };
  }

  function clipLocation(clip: Clip<"1.0.0">) {
    const parent = parentOf(clip);
    if (parent instanceof ClipSlot) return slotLocation(parent);
    if (parent instanceof TakeLane) return laneLocation(parent);
    if (parent instanceof Track) return { view: "arrangement", ...trackRef(parent) };
    return null;
  }

  // The track a device is on, and the labels from there down to it: racks and
  // their chains (as chainLabel names them), then the device.
  function devicePath(device: Device<"1.0.0">): { track?: Track<"1.0.0">; labels: string[] } {
    const labels = [device.name];
    let up = parentOf(device);
    for (let depth = 0; up && depth < 16; depth++) {
      if (up instanceof Track) return { track: up, labels };
      const chain = up;
      const rack = chain instanceof Chain ? parentOf(chain) : null;
      if (!(chain instanceof Chain) || !(rack instanceof RackDevice)) break;
      labels.unshift(rack.name, chainLabel(chain, indexIn(rack.chains, chain)));
      up = parentOf(rack);
    }
    return { labels };
  }
  // "Kit > Drum Rack > pad 36 > Simpler", as parameter_find shows paths.
  const pathText = (track: Track<"1.0.0"> | undefined, labels: string[]) =>
    (track ? [track.name, ...labels] : labels).join(" > ");

  function deviceLocation(device: Device<"1.0.0">) {
    const holder = parentOf(device);
    const rack = holder instanceof Chain ? parentOf(holder) : null;
    const { track, labels } = devicePath(device);
    return {
      ...(track ? trackRef(track) : {}),
      path: pathText(track, labels),
      device_index: holder instanceof Track || holder instanceof Chain ? indexIn(holder.devices, device) : undefined,
      chain_id: holder instanceof Chain ? remember(holder) : undefined,
      rack_device_id: rack instanceof RackDevice ? remember(rack) : undefined,
    };
  }

  function chainLocation(chain: Chain<"1.0.0">) {
    const rack = parentOf(chain);
    if (!(rack instanceof RackDevice)) return null;
    const index = indexIn(rack.chains, chain);
    const { track, labels } = devicePath(rack);
    return {
      ...(track ? trackRef(track) : {}),
      path: pathText(track, [...labels, chainLabel(chain, index)]),
      rack_device_id: remember(rack),
      chain_index: index,
    };
  }

  // Where an object sits (clip_get, device_get, chain_get, selection_get), or
  // null when that cannot be told.
  function locate(obj: DataModelObject<"1.0.0">): object | null {
    try {
      if (obj instanceof Clip) return clipLocation(obj);
      if (obj instanceof ClipSlot) return slotLocation(obj);
      if (obj instanceof TakeLane) return laneLocation(obj);
      if (obj instanceof Device) return deviceLocation(obj);
      if (obj instanceof Chain) return chainLocation(obj);
      if (obj instanceof Track) return trackRef(obj);
      if (obj instanceof Scene) {
        const index = indexIn(song().scenes, obj);
        return index >= 0 ? { scene_index: index } : null;
      }
      if (obj instanceof Sample) {
        const simpler = parentOf(obj);
        return simpler instanceof Simpler ? { simpler_device_id: remember(simpler), ...deviceLocation(simpler) } : null;
      }
    } catch {
      // a location is extra information: never fail the call over it
    }
    return null;
  }

  // Whether a clip spanning [start, end) overlaps the range [from, to); an
  // empty range (from = to) is a point in time, covered from a clip's start.
  const overlapsRange = (start: number, end: number, from: number, to: number) =>
    to > from ? start < to && end > from : start <= from && end > from;
  // The clips overlapping [from, to), by start time.
  function clipsInRange(clips: Clip<"1.0.0">[], from: number, to: number) {
    return clips
      .map((clip) => ({ clip, start: num(clip.startTime), end: num(clip.endTime) }))
      .filter((c) => overlapsRange(c.start, c.end, from, to))
      .sort((a, b) => a.start - b.start)
      .map((c) => c.clip);
  }

  // Overviews (session_grid, arrangement_get): the given tracks, in that order
  // and each once, or every regular track. Every address is checked first.
  function trackSelection(list: TrackAddress[] | undefined, regular: Track<"1.0.0">[]) {
    if (!list) return regular;
    const picked = list.map((a, i) => at(`tracks[${i}]`, () => findTrack(a)));
    return picked.filter((t, i) => indexIn(picked, t) === i);
  }
  // A track as an overview row.
  const trackRow = (track: Track<"1.0.0">, regular: Track<"1.0.0">[]) => {
    const index = indexIn(regular, track);
    return {
      id: remember(track),
      name: track.name,
      index: index >= 0 ? index : undefined,
      type: trackKind(track, regular),
    };
  };

  // -- devices and parameters by name ----------------------------------------

  const quote = (s: string) => JSON.stringify(s);
  const describeDevice = (d: Device<"1.0.0">) => `${quote(d.name)} (id ${remember(d)})`;
  // Chains have no names: drum pads are called by their note, others by index.
  const chainLabel = (c: Chain<"1.0.0">, i: number) =>
    c instanceof DrumChain ? `pad ${num(c.receivingNote)}` : `chain ${i}`;

  // A rack's chain by {chain: index} or, in a Drum Rack, {pad: receiving note}.
  function findChain(rack: RackDevice<"1.0.0">, step: ChainStep) {
    const chains = rack.chains;
    if ("chain" in step) {
      const chain = chains[step.chain];
      if (!chain)
        throw new UsageError(
          `chain ${step.chain} out of range in ${describeDevice(rack)} ` +
            `(${chains.length ? `0-${chains.length - 1}` : "it has no chains"}).`,
        );
      return { chain, label: chainLabel(chain, step.chain) };
    }
    if (!(rack instanceof DrumRack))
      throw new UsageError(`${describeDevice(rack)} is not a Drum Rack: address its chains by {chain: index}.`);
    const pad = parsePitch(step.pad, "pad");
    const notes = chains.map((c) => (c instanceof DrumChain ? num(c.receivingNote) : undefined));
    const hits = notes.flatMap((n, i) => (n === pad ? [i] : []));
    if (hits.length === 1) return { chain: chains[hits[0]], label: `pad ${pad}` };
    if (hits.length)
      throw new UsageError(
        `Ambiguous pad ${pad} in ${describeDevice(rack)}: chains ${hits.join(", ")} all receive ` +
          `note ${pad}. Use {chain: index}.`,
      );
    const pads = [...new Set(notes.filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
    throw new UsageError(
      `No pad receives note ${pad} in ${describeDevice(rack)} (pads: ${pads.join(", ") || "none"}).`,
    );
  }

  // A device by device_id, or by its track and `device` (see deviceAddress).
  // Also returns where it sits: the track (when addressed through one) and
  // the readable path down to it, e.g. ["Drums", "Drum Rack", "pad 36", "Simpler"].
  function locateDevice(a: DeviceAddress): {
    device: Device<"1.0.0">;
    track?: Track<"1.0.0">;
    path: string[];
  } {
    if (a.device_id !== undefined) {
      if (a.device !== undefined || hasTrackAddress(a))
        throw new UsageError("Give device_id, or a track and device, not both.");
      const device = resolve(a.device_id, Device);
      return { device, path: [device.name] };
    }
    if (a.device === undefined)
      throw new UsageError("Provide device_id, or a track (track_id, track_index or track_name) and device.");
    if (!hasTrackAddress(a))
      throw new UsageError("device needs its track: give track_id, track_index or track_name (or use device_id).");
    const track = findTrack(a);
    const steps = Array.isArray(a.device) ? a.device : [a.device];
    const path = [track.name];
    let list: Device<"1.0.0">[] | null = track.devices; // what the next name or index picks from
    let where = `track ${describeTrack(track)}`;
    let current: Device<"1.0.0"> | null = null;
    for (const [i, step] of steps.entries()) {
      const label = Array.isArray(a.device) ? `device[${i}]` : "device";
      if (typeof step === "object") {
        if (!current) throw new UsageError(`${label}: a {chain} or {pad} step must follow a rack device.`);
        const rack = current;
        if (!(rack instanceof RackDevice))
          throw new UsageError(
            `${label}: ${describeDevice(rack)} is not a rack, so the path cannot go into a chain.`,
          );
        const { chain, label: name } = at(label, () => findChain(rack, step));
        path.push(name);
        list = chain.devices;
        where = `${name} of ${describeDevice(rack)}`;
        current = null;
        continue;
      }
      if (!list) {
        const prev = current!;
        throw new UsageError(
          prev instanceof RackDevice
            ? `${label}: pick a chain of ${describeDevice(prev)} first, with {chain: index} or {pad: note}.`
            : `${label}: ${describeDevice(prev)} is not a rack, so the path cannot continue.`,
        );
      }
      const devices: Device<"1.0.0">[] = list;
      if (typeof step === "number") {
        if (!devices[step])
          throw new UsageError(
            `${label}: device index ${step} out of range on ${where} ` +
              `(${devices.length ? `0-${devices.length - 1}` : "it has no devices"}).`,
          );
        current = devices[step];
      } else {
        const indexed = devices.map((device, index) => ({ device, index }));
        const describe = (x: (typeof indexed)[number]) =>
          `${quote(x.device.name)} (index ${x.index}, id ${remember(x.device)})`;
        current = at(`${label} on ${where}`, () =>
          byName("device", step, indexed, (x) => x.device.name, describe, {
            hint: "Use the device index or device_id.",
          }),
        ).device;
      }
      path.push(current.name);
      list = null;
    }
    if (!current)
      throw new UsageError("device: the path ends at a chain; add the device in it (a name or index).");
    return { device: current, track, path };
  }
  const findDevice = (a: DeviceAddress) => locateDevice(a).device;

  // Name matching for parameters and value items: exact, then case-insensitive,
  // then case-insensitive substring. The first tier with a hit decides; more
  // than one hit there is ambiguous.
  function tieredMatch<T>(all: T[], namesOf: (x: T) => string[], query: string): T[] {
    const lower = query.toLowerCase();
    const tiers: Array<(n: string) => boolean> = [
      (n) => n === query,
      (n) => n.toLowerCase() === lower,
      (n) => n.toLowerCase().includes(lower),
    ];
    for (const test of tiers) {
      const hits = all.filter((x) => namesOf(x).some(test));
      if (hits.length) return hits;
    }
    return [];
  }

  // A device's parameter by name (tieredMatch). Live devices can repeat a
  // name: that is ambiguous, and the candidates' ids are listed.
  function findParameter(device: Device<"1.0.0">, name: string): DeviceParameter<"1.0.0"> {
    const params = device.parameters.map((p, index) => ({ p, index, name: p.name }));
    const hits = tieredMatch(params, (x) => [x.name], name);
    if (hits.length === 1) return hits[0].p;
    if (!hits.length)
      throw new UsageError(
        `No parameter named ${quote(name)} (or containing it) on ${describeDevice(device)}. ` +
          "Find names with parameter_find or device_get {parameter_filter}.",
      );
    const shown = hits.slice(0, 20).map((x) => `${quote(x.name)} (index ${x.index}, id ${remember(x.p)})`);
    const more = hits.length > 20 ? `, ... (${hits.length - 20} more)` : "";
    throw new UsageError(
      `Ambiguous parameter ${quote(name)} on ${describeDevice(device)}: it matches ` +
        `${shown.join(", ")}${more}. Use the exact name or the parameter_id.`,
    );
  }

  // A quantized parameter's value_items index, by item name or short name.
  function valueItemIndex(param: DeviceParameter<"1.0.0">, item: string): number {
    const items = param.valueItems.map((v, index) => ({
      index,
      label: `${quote(v.name)} (${index})`,
      names: [v.name, v.shortName].filter((n): n is string => typeof n === "string"),
    }));
    const hits = tieredMatch(items, (x) => x.names, item);
    if (hits.length === 1) return hits[0].index;
    const list = (xs: typeof items) => xs.map((x) => x.label).join(", ");
    throw new UsageError(
      hits.length
        ? `Ambiguous value_item ${quote(item)} for ${quote(param.name)}: it matches ${list(hits)}.`
        : `No value item ${quote(item)} for ${quote(param.name)}. Items: ${list(items) || "none"}.`,
    );
  }

  const WRITE_KINDS = ["value", "value_item", "reset", "delta"] as const;
  function writeKind(w: ParameterWrite): (typeof WRITE_KINDS)[number] {
    const kinds = WRITE_KINDS.filter((k) => (k === "reset" ? w.reset === true : w[k] !== undefined));
    if (kinds.length === 1) return kinds[0];
    throw new UsageError(
      kinds.length
        ? `give only one of value, value_item, reset and delta, got ${kinds.join(" + ")}.`
        : "give one of value, value_item, reset (true) or delta.",
    );
  }

  // A validated write. `target` maps the current value (read only when
  // `relative`, i.e. for delta) to the value to set.
  type PlannedWrite = {
    param: DeviceParameter<"1.0.0">;
    relative: boolean;
    target: (current: number) => number;
  };

  function planWrite(param: DeviceParameter<"1.0.0">, w: ParameterWrite): PlannedWrite {
    const kind = writeKind(w);
    const min = num(param.min);
    const max = num(param.max);
    const quantized = param.isQuantized;
    const name = quote(param.name);
    const fixed = (v: number, what: string): PlannedWrite => {
      // tolerate float noise at the edges, then send an in-range value
      const slack = 1e-9 * Math.max(1, Math.abs(max - min));
      if (!(v >= min - slack && v <= max + slack))
        throw new UsageError(`${what} ${v} is out of range for ${name} (${min} to ${max}).`);
      if (quantized && !Number.isInteger(v))
        throw new UsageError(
          `${name} is quantized: give a whole value_items index or a value_item, not ${v}.`,
        );
      const value = Math.min(max, Math.max(min, v));
      return { param, relative: false, target: () => value };
    };
    switch (kind) {
      case "value":
        return fixed(w.value!, "value");
      case "value_item":
        if (!quantized)
          throw new UsageError(
            `${name} is not quantized: give a value from ${min} to ${max}, not a value_item.`,
          );
        return fixed(valueItemIndex(param, w.value_item!), "value_items index");
      case "reset": {
        const value = num(param.defaultValue);
        return { param, relative: false, target: () => value };
      }
      case "delta": {
        const delta = w.delta!;
        if (quantized && !Number.isInteger(delta))
          throw new UsageError(
            `${name} is quantized: delta must be a whole number of steps, not ${delta}.`,
          );
        return { param, relative: true, target: (current) => Math.min(max, Math.max(min, current + delta)) };
      }
    }
  }

  // Applies validated writes as one undo step. The current values a delta
  // needs are read first: the transaction callback must be synchronous, so
  // it only starts the setValue calls. labels[i] names entry i in errors.
  // Returns the values written.
  async function applyWrites(
    plan: PlannedWrite[],
    labels: Array<string | undefined> = [],
  ): Promise<number[]> {
    plan.forEach((w, i) => {
      const first = plan.findIndex((o) => o.param.handle.id === w.param.handle.id);
      if (first !== i)
        throw new UsageError(
          `${labels[i] ? `${labels[i]}: ` : ""}parameter ${quote(w.param.name)} (id ${remember(w.param)}) ` +
            `is set twice${labels[first] ? `, also by ${labels[first]}` : ""}.`,
        );
    });
    const current = await Promise.all(plan.map((w) => (w.relative ? w.param.getValue().then(num) : 0)));
    const values = plan.map((w, i) => w.target(current[i]));
    if (plan.length)
      await context.withinTransaction(() =>
        Promise.all(
          plan.map((w, i) =>
            w.param.setValue(values[i]).catch((e: unknown) => {
              const where = labels[i] ? `${labels[i]}: ` : "";
              throw new Error(`${where}could not set ${quote(w.param.name)} to ${values[i]}: ${errorMessage(e)}`);
            }),
          ),
        ),
      );
    return values;
  }

  // parameter_get / parameter_set entries: parameter_id, or device + name.
  function findParameterEntry(a: ParameterAddress) {
    if (a.parameter_id !== undefined) {
      if (a.parameter !== undefined || given(a, ["device_id", "device"]) || hasTrackAddress(a))
        throw new UsageError("give parameter_id, or a device and parameter, not both.");
      return { param: resolve(a.parameter_id, DeviceParameter), device: undefined };
    }
    if (a.parameter === undefined)
      throw new UsageError("give parameter_id, or parameter with device_id or a track and device.");
    const device = findDevice(a);
    return { param: findParameter(device, a.parameter), device };
  }
  // parameter_get / parameter_set results: entries found by device name their device.
  const withValue = async ({ param, device }: { param: DeviceParameter<"1.0.0">; device?: Device<"1.0.0"> }) => ({
    ...(await parameterWithValue(param)),
    ...(device ? { device_id: remember(device), device_name: device.name } : {}),
  });

  // Initial values for a device that was just inserted: every name first,
  // then the values as one undo step. The device already exists, so a failure
  // (which sets none of them) is returned instead of thrown.
  async function setInitialParameters(
    device: Device<"1.0.0">,
    parameters: Array<{ name: string } & ParameterWrite>,
  ): Promise<{ parameters?: Array<{ id: string; name: string; value: number }>; error?: string }> {
    try {
      const plan = parameters.map((p) => planWrite(findParameter(device, p.name), p));
      const values = await applyWrites(plan);
      return {
        parameters: plan.map((w, i) => ({ id: remember(w.param), name: w.param.name, value: values[i] })),
      };
    } catch (e) {
      return { error: `parameters: ${errorMessage(e)}` };
    }
  }

  // The parameter that switches a device on and off. "Device On" is Live's
  // naming convention, not an SDK field: without it, a first parameter that is
  // a two-state switch is used instead (`fallback`). On and off are its
  // "On"/"Off" items when it has both, else its max and min.
  function onOffParameter(device: Device<"1.0.0">) {
    const params = device.parameters;
    let param = params.find((p) => p.name === "Device On");
    const fallback = !param;
    if (!param && params[0]?.isQuantized && params[0].valueItems.length === 2) param = params[0];
    if (!param)
      throw new UsageError(
        `${describeDevice(device)} has no "Device On" parameter (and its first parameter is not a ` +
          "two-state switch), so it cannot be switched on or off.",
      );
    const items = param.isQuantized ? param.valueItems.map((v) => v.name.toLowerCase()) : [];
    const [on, off] = [items.indexOf("on"), items.indexOf("off")];
    const named = on >= 0 && off >= 0;
    return { param, fallback, on: named ? on : num(param.max), off: named ? off : num(param.min) };
  }

  // Parameter values by name, as device_copy and the presets carry them.
  type SavedValue = { name: string; value: number };
  async function readValues(device: Device<"1.0.0">): Promise<SavedValue[]> {
    const params = device.parameters;
    const values = await Promise.all(params.map((p) => p.getValue()));
    return params.map((p, i) => ({ name: p.name, value: num(values[i]) }));
  }

  // Writes saved values onto a device by exact name, as one undo step. The
  // k-th value of a name goes to the device's k-th parameter of that name, so
  // repeated names line up. Values the device already has are not written.
  // Lenient: what cannot be applied is listed in `skipped`, never thrown.
  async function applySavedValues(device: Device<"1.0.0">, saved: SavedValue[]) {
    const byParamName = new Map<string, DeviceParameter<"1.0.0">[]>();
    for (const p of device.parameters) byParamName.set(p.name, [...(byParamName.get(p.name) ?? []), p]);
    const seen = new Map<string, number>();
    const skipped: Array<{ name: string; reason: string }> = [];
    const writes: Array<{ param: DeviceParameter<"1.0.0">; value: number }> = [];
    for (const { name, value } of saved) {
      const k = seen.get(name) ?? 0;
      seen.set(name, k + 1);
      const param = byParamName.get(name)?.[k];
      if (!param) {
        const reason = k
          ? `${describeDevice(device)} has only ${k} parameter${k > 1 ? "s" : ""} of that name`
          : `${describeDevice(device)} has no parameter of that name`;
        skipped.push({ name, reason });
        continue;
      }
      try {
        writes.push({ param, value: planWrite(param, { value }).target(value) });
      } catch (e) {
        skipped.push({ name, reason: errorMessage(e) });
      }
    }
    const current = await Promise.all(writes.map((w) => w.param.getValue().then(num)));
    const changed = writes.filter((w, i) => current[i] !== w.value);
    const settled = changed.length
      ? await context.withinTransaction(() =>
          Promise.allSettled(changed.map((w) => w.param.setValue(w.value))),
        )
      : [];
    let refused = 0;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") return;
      refused++;
      const { param, value } = changed[i];
      skipped.push({ name: param.name, reason: `Live refused ${value}: ${errorMessage(r.reason)}` });
    });
    return { applied: writes.length - refused, skipped };
  }

  // Racks rebuild nothing by name: their chains and devices are not parameters.
  function rejectRack(device: Device<"1.0.0">, what: string) {
    if (device instanceof RackDevice)
      throw new UsageError(
        `${describeDevice(device)} is a rack: its chains and their devices are not parameters, so ` +
          `it cannot be ${what}. device_duplicate copies a rack in place.`,
      );
  }

  // Inserts a built-in device for device_copy / device_preset_load.
  type DeviceHolder = Track<"1.0.0"> | Chain<"1.0.0">;
  async function insertBuiltIn(target: DeviceHolder, name: string, index: number, renamedHint: boolean) {
    try {
      return await target.insertDevice(name, index);
    } catch (e) {
      const hint = renamedHint ? " If the device was renamed in Live, pass its built-in name as device_name." : "";
      throw new Error(`Could not insert ${quote(name)}: ${errorMessage(e)}${hint} Nothing was changed.`);
    }
  }

  // Undoes insertBuiltIn after a later step failed, then reports that failure.
  async function removeInserted(target: DeviceHolder, device: Device<"1.0.0">, why: string): Promise<never> {
    try {
      await target.deleteDevice(device);
    } catch (e) {
      throw new Error(`${why} The new device ${remember(device)} could not be removed again: ${errorMessage(e)}.`);
    }
    throw new Error(`${why} The new device was removed again; nothing else was changed.`);
  }

  // device_copy / device_preset_load: a Simpler's sample first (loading one
  // may reset sample-dependent parameters), then the values. A sample that
  // cannot be loaded fails the call; a device inserted for it is removed again.
  async function restoreDevice(
    device: Device<"1.0.0">,
    saved: SavedValue[],
    samplePath: string | undefined,
    insertedInto?: DeviceHolder,
  ) {
    const skipped: Array<{ name: string; reason: string }> = [];
    let sample: { file_path: string } | undefined;
    if (samplePath !== undefined) {
      if (!(device instanceof Simpler)) {
        skipped.push({ name: "sample", reason: `${describeDevice(device)} is not a Simpler` });
      } else {
        try {
          sample = { file_path: (await device.replaceSample(samplePath)).filePath };
        } catch (e) {
          const why = `Could not load the sample ${samplePath}: ${errorMessage(e)}.`;
          if (insertedInto) await removeInserted(insertedInto, device, why);
          throw new Error(`${why} Nothing was changed.`);
        }
      }
    }
    const values = await applySavedValues(device, saved);
    return { sample, applied: values.applied, skipped: [...skipped, ...values.skipped] };
  }

  const presets = () => presetStore(context.environment.storageDirectory);

  // -- tracks ----------------------------------------------------------------

  async function mixerDetail(mixer: TrackMixer<"1.0.0"> | ChainMixer<"1.0.0">) {
    const returnNames = mixer instanceof TrackMixer ? song().returnTracks.map((t) => t.name) : [];
    const [volume, panning, sends] = await Promise.all([
      parameterWithValue(mixer.volume),
      parameterWithValue(mixer.panning),
      Promise.all(mixer.sends.map((p) => parameterWithValue(p))),
    ]);
    return {
      id: remember(mixer),
      volume: { ...volume, hint: "normalized 0-1 (0.85 = 0 dB unity, 1.0 = +6 dB)" },
      panning: { ...panning, hint: "-1 = full left, 0 = center, 1 = full right" },
      sends: sends.map((s, i) => ({ ...s, return_track: returnNames[i] })),
    };
  }

  tool(
    "track_get",
    { title: "Get track", annotations: READ },
    "Get detail for one track: properties, clip slots (session view, with " +
      "clips), take lanes, arrangement clips, devices, and mixer (volume/pan/sends " +
      "with current values). Works for regular, return, and main tracks; group " +
      "tracks have type 'group' (return and main tracks 'other'). Address " +
      "by track_id, track_index (0-based, regular tracks only), or track_name. " +
      "Use `include` to fetch only some sections.",
    {
      ...trackAddress,
      include: z
        .array(z.enum(["clip_slots", "take_lanes", "arrangement_clips", "devices", "mixer"]))
        .optional()
        .describe("Sections to include; omit for everything"),
    },
    async (args) => {
      const track = findTrack(args);
      const want = (k: string) => !args.include || args.include.includes(k as never);
      return {
        ...summarizeTrack(track),
        clip_slots: want("clip_slots") ? track.clipSlots.map(clipSlotSummary) : undefined,
        take_lanes: want("take_lanes") ? track.takeLanes.map(takeLaneSummary) : undefined,
        arrangement_clips: want("arrangement_clips")
          ? track.arrangementClips.map((c) => clipSummary(c))
          : undefined,
        devices: want("devices") ? track.devices.map(deviceSummary) : undefined,
        mixer: want("mixer") ? await mixerDetail(track.mixer) : undefined,
      };
    },
  );

  const trackProps = {
    name: z.string().optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    arm: z.boolean().optional(),
  };
  const TRACK_PROPS = Object.keys(trackProps);

  tool(
    "track_set",
    { title: "Set track properties", annotations: SET },
    "Set track properties (name, mute, solo, arm). Address the track by track_id, " +
      "track_index or track_name, or pass `items` (one entry per track, same " +
      "fields) to change many tracks at once, e.g. mute all but the vocals. All " +
      "changes form one undo step; nothing is changed if any entry is invalid.",
    {
      ...trackAddress,
      ...trackProps,
      items: z
        .array(z.object({ ...trackAddress, ...trackProps }))
        .min(1)
        .optional()
        .describe("Batch form: one entry per track; returns {items}"),
    },
    (args) => {
      const { list, batch } = entries(args, args.items, [...Object.keys(trackAddress), ...TRACK_PROPS]);
      // Validate every entry before the first setter runs.
      const plan = list.map((it, i) =>
        at(itemLabel(batch, i), () => {
          const track = findTrack(it);
          if (batch && !given(it, TRACK_PROPS))
            throw new UsageError("nothing to set — give name, mute, solo and/or arm.");
          return { track, it };
        }),
      );
      if (plan.some(({ it }) => given(it, TRACK_PROPS)))
        context.withinTransaction(() => {
          for (const { track, it } of plan) {
            if (it.name !== undefined) track.name = it.name;
            if (it.mute !== undefined) track.mute = it.mute;
            if (it.solo !== undefined) track.solo = it.solo;
            if (it.arm !== undefined) track.arm = it.arm;
          }
        });
      const regular = song().tracks;
      const out = plan.map(({ track }) => summarizeTrack(track, regular));
      return batch ? { items: out } : out[0];
    },
  );

  tool(
    "track_create",
    { title: "Create track", annotations: CREATE },
    "Create a new audio or MIDI track, optionally named and with built-in devices " +
      "inserted in order (each a name, or {name, parameters:[{name, value | " +
      "value_item | reset | delta}]} to set initial parameter values: internal " +
      "units, or a quantized parameter's choice by name). The track is inserted after " +
      "the last selected track in Live, or appended if none is selected, so the " +
      "result carries its `index`. Once the track exists, a failing name or device " +
      "does not fail the call: it is reported in `errors` (and on its `devices` " +
      "entry) while the rest is still applied.",
    {
      type: z.enum(["audio", "midi"]),
      name: z.string().optional(),
      devices: z
        .array(
          z.union([
            z.string().min(1).describe("Built-in device name, e.g. 'Operator', 'Reverb'"),
            z.object({
              name: z.string().min(1).describe("Built-in device name"),
              parameters: z.array(initialParameter).optional(),
            }),
          ]),
        )
        .optional()
        .describe("Devices to insert, in chain order"),
    },
    async ({ type, name, devices }) => {
      // Each initial value gives exactly one kind of write: checked before the track exists.
      for (const [i, spec] of (devices ?? []).entries())
        if (typeof spec !== "string")
          spec.parameters?.forEach((p, k) => at(`devices[${i}].parameters[${k}]`, () => writeKind(p)));
      const track =
        type === "audio" ? await song().createAudioTrack() : await song().createMidiTrack();
      // From here on the track exists: report failures instead of throwing.
      const errors: string[] = [];
      if (name !== undefined) {
        try {
          track.name = name;
        } catch (e) {
          errors.push(`name: ${errorMessage(e)}`);
        }
      }
      const inserted: Record<string, unknown>[] = [];
      for (const [i, spec] of (devices ?? []).entries()) {
        const { name: deviceName, parameters } =
          typeof spec === "string" ? { name: spec, parameters: [] } : spec;
        let device: Device<"1.0.0">;
        try {
          device = await track.insertDevice(deviceName, track.devices.length);
        } catch (e) {
          const msg = errorMessage(e);
          errors.push(`devices[${i}] (${deviceName}): ${msg}`);
          inserted.push({ requested: deviceName, error: msg });
          continue;
        }
        const entry: Record<string, unknown> = { requested: deviceName, ...deviceSummary(device) };
        if (parameters?.length) {
          const result = await setInitialParameters(device, parameters);
          entry.parameters = result.parameters;
          if (result.error) {
            errors.push(`devices[${i}] (${deviceName}): ${result.error}`);
            entry.error = result.error;
          }
        }
        inserted.push(entry);
      }
      return {
        ...trackSummary(track),
        index: song().tracks.findIndex((t) => t.handle.id === track.handle.id),
        devices: devices ? inserted : undefined,
        errors: errors.length ? errors : undefined,
      };
    },
  );

  tool(
    "track_delete",
    { title: "Delete track", annotations: DESTRUCTIVE },
    "Delete a track, addressed by track_id, track_index or its exact track_name.",
    { ...trackAddress, track_name: exactTrackName },
    async (args) => {
      const track = findTrack(args, { exactName: true });
      const deleted = { deleted: remember(track), name: track.name };
      await song().deleteTrack(track);
      return deleted;
    },
  );

  tool(
    "track_duplicate",
    { title: "Duplicate track", annotations: CREATE },
    "Duplicate a track. The copy is inserted right after the original.",
    { ...trackAddress },
    async (args) => summarizeTrack(await song().duplicateTrack(findTrack(args))),
  );

  tool(
    "track_clear_clips_in_range",
    { title: "Clear arrangement clips in range", annotations: DESTRUCTIVE },
    "Delete all arrangement clips of a track within a beat range. Clips " +
      "overlapping a boundary are truncated to the range edge.",
    { ...trackAddress, start_time: z.number(), end_time: z.number() },
    async ({ start_time, end_time, ...address }) => {
      await findTrack(address).clearClipsInRange(start_time, end_time);
      return { cleared: [start_time, end_time] };
    },
  );

  tool(
    "take_lane_create",
    { title: "Create take lane", annotations: CREATE },
    "Create a new take lane on a track (appended after existing lanes).",
    { ...trackAddress },
    async (args) => takeLaneSummary(await findTrack(args).createTakeLane()),
  );

  tool(
    "take_lane_set",
    { title: "Rename take lane", annotations: SET },
    "Rename a take lane, or several with `items` (one undo step).",
    {
      take_lane_id: z.string().optional(),
      name: z.string().optional(),
      items: z
        .array(z.object({ take_lane_id: z.string(), name: z.string() }))
        .min(1)
        .optional()
        .describe("Batch form: one entry per take lane; returns {items}"),
    },
    (args) => {
      const { list, batch } = entries(args, args.items, ["take_lane_id", "name"]);
      const plan = list.map((it, i) =>
        at(itemLabel(batch, i), () => {
          if (it.take_lane_id === undefined || it.name === undefined)
            throw new UsageError("take_lane_id and name are required.");
          return { lane: resolve(it.take_lane_id, TakeLane), name: it.name };
        }),
      );
      context.withinTransaction(() => {
        for (const { lane, name } of plan) lane.name = name;
      });
      const out = plan.map(({ lane }) => takeLaneSummary(lane));
      return batch ? { items: out } : out[0];
    },
  );

  // -- scenes / cue points ---------------------------------------------------

  const sceneIndexOf = (scene: Scene<"1.0.0">) =>
    song().scenes.findIndex((s) => s.handle.id === scene.handle.id);

  // Batch creation (scene_create / cue_point_create items): every create in one
  // undo step, then every name in one more. Once something exists, failures
  // are reported per entry instead of thrown.
  async function createBatch<T extends Scene<"1.0.0"> | CuePoint<"1.0.0">>(
    list: { name?: string }[],
    create: (i: number) => Promise<T>,
  ): Promise<Array<{ created: T; error?: string } | { created?: undefined; error: string }>> {
    const settled = await context.withinTransaction(() =>
      Promise.allSettled(list.map((_, i) => create(i))),
    );
    if (settled.every((r) => r.status === "rejected"))
      throw new Error(`Nothing was created: ${errorMessage((settled[0] as PromiseRejectedResult).reason)}`);
    const nameErrors: Array<string | undefined> = [];
    if (list.some((it) => it.name !== undefined)) {
      context.withinTransaction(() =>
        settled.forEach((r, i) => {
          const name = list[i].name;
          if (r.status !== "fulfilled" || name === undefined) return;
          try {
            r.value.name = name;
          } catch (e) {
            nameErrors[i] = `name: ${errorMessage(e)}`;
          }
        }),
      );
    }
    return settled.map((r, i) =>
      r.status === "fulfilled"
        ? { created: r.value, error: nameErrors[i] }
        : { error: errorMessage(r.reason) },
    );
  }

  const sceneCreateItem = {
    index: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe("0-based insert position; -1 or omitted = append at the end"),
    name: z.string().optional(),
  };

  tool(
    "scene_create",
    { title: "Create scene", annotations: CREATE },
    "Create a scene at the given index (0-based; -1 or omitted appends at the end), " +
      "optionally named. `items` creates several scenes in one call, in order: each " +
      "entry's index refers to the scene list after the previous entries were " +
      "inserted. A batch takes two undo steps (creates, then names) and reports a " +
      "failed entry as {error} instead of failing the call.",
    {
      ...sceneCreateItem,
      items: z
        .array(z.object(sceneCreateItem))
        .min(1)
        .optional()
        .describe("Batch form: one entry per new scene; returns {items}"),
    },
    async (args) => {
      const { list, batch } = entries(args, args.items, ["index", "name"]);
      const count = song().scenes.length;
      list.forEach((it, i) =>
        at(itemLabel(batch, i), () => {
          if (it.index !== undefined && it.index > count + i)
            throw new UsageError(`index ${it.index} out of range (0-${count + i}, or -1 to append).`);
        }),
      );
      if (!batch) {
        const scene = await song().createScene(args.index ?? -1);
        if (args.name !== undefined) scene.name = args.name;
        return sceneSummary(scene, sceneIndexOf(scene));
      }
      // The host is expected to apply the creates in call order, which is what
      // gives each index its "after the previous entries" meaning.
      const results = await createBatch(list, (i) => song().createScene(list[i].index ?? -1));
      return {
        items: results.map((r) =>
          r.created ? { ...sceneSummary(r.created, sceneIndexOf(r.created)), error: r.error } : r,
        ),
      };
    },
  );

  tool(
    "scene_set",
    { title: "Rename scene", annotations: SET },
    "Rename a scene, addressed by scene_id, scene_index or scene_name; or rename " +
      "several with `items` (one entry per scene). All renames form one undo step.",
    {
      ...sceneAddress,
      name: z.string().optional().describe("New name (required unless items is given)"),
      items: z
        .array(z.object({ ...sceneAddress, name: z.string() }))
        .min(1)
        .optional()
        .describe("Batch form: one entry per scene; returns {items}"),
    },
    (args) => {
      const { list, batch } = entries(args, args.items, [...Object.keys(sceneAddress), "name"]);
      const plan = list.map((it, i) =>
        at(itemLabel(batch, i), () => {
          if (it.name === undefined) throw new UsageError("name is required.");
          return { ...findScene(it), name: it.name };
        }),
      );
      context.withinTransaction(() => {
        for (const { scene, name } of plan) scene.name = name;
      });
      const out = plan.map(({ scene, index }) => sceneSummary(scene, index));
      return batch ? { items: out } : out[0];
    },
  );

  tool(
    "scene_delete",
    { title: "Delete scene", annotations: DESTRUCTIVE },
    "Delete a scene, addressed by scene_id, scene_index or its exact scene_name.",
    { ...sceneAddress, scene_name: exactSceneName },
    async (args) => {
      const { scene } = findScene(args, { exactName: true });
      const deleted = { deleted: remember(scene), name: scene.name };
      await song().deleteScene(scene);
      return deleted;
    },
  );

  tool(
    "scene_duplicate",
    { title: "Duplicate scene", annotations: CREATE },
    "Duplicate a scene. The copy is inserted right after the original.",
    { ...sceneAddress },
    async (args) => {
      const scene = await song().duplicateScene(findScene(args).scene);
      return sceneSummary(scene, sceneIndexOf(scene));
    },
  );

  tool(
    "scene_get",
    { title: "Get scene", annotations: READ },
    "Get one session row: a scene (scene_id, scene_index or scene_name) and, for " +
      "every regular track in order, its clip slot in that scene with the clip in it " +
      "(clip summary, or null for an empty slot; group tracks' slots hold no clips). " +
      "only_clips leaves out the empty slots. For the whole session at a glance use " +
      "session_grid.",
    {
      ...sceneAddress,
      only_clips: z.boolean().default(false).describe("Leave out the tracks whose slot in this scene is empty"),
    },
    ({ only_clips, ...address }) => {
      const { scene, index } = findScene(address);
      const regular = song().tracks;
      const slots = regular.map((track, i) => {
        // group tracks may not have a slot per scene: tolerate a missing one
        const slot = track.clipSlots[index];
        const clip = slot?.clip ?? null;
        return {
          track_index: i,
          track_id: remember(track),
          track_name: track.name,
          track_type: trackKind(track, regular),
          slot_id: slot ? remember(slot) : null,
          clip: clip ? clipSummary(clip) : null,
        };
      });
      return {
        ...sceneSummary(scene, index),
        clip_count: slots.filter((x) => x.clip).length,
        slots: only_clips ? slots.filter((x) => x.clip) : slots,
      };
    },
  );

  const MAX_GRID_CELLS = 10_000;

  tool(
    "session_grid",
    { title: "Get session grid", annotations: READ },
    "The Session View at a glance, as a track × scene matrix: `scenes` are the " +
      "columns (index, id, name); each entry of `tracks` (id, name, index, type, " +
      "group_track_id) has one cell per column — null for an empty slot, or the clip " +
      "in brief {id, class, name, duration, muted, looping} (clip_get has the " +
      "detail). Narrow it with `tracks` (in that order) and scene_index_min / " +
      `scene_index_max (inclusive); at most ${MAX_GRID_CELLS} cells per call. For ` +
      "one scene with full clip summaries use scene_get.",
    {
      tracks: z
        .array(z.object(trackAddress))
        .min(1)
        .optional()
        .describe("Only these tracks (each by track_id, track_index or track_name); omit for every regular track"),
      scene_index_min: z.number().int().min(0).optional().describe("First scene (0-based); default 0"),
      scene_index_max: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Last scene, inclusive; default (and at most) the last scene"),
    },
    ({ tracks: list, scene_index_min, scene_index_max }) => {
      const scenes = song().scenes;
      const first = scene_index_min ?? 0;
      if (scene_index_max !== undefined && scene_index_max < first)
        throw new UsageError(`scene_index_max ${scene_index_max} is before scene_index_min ${first}.`);
      if (first > 0 && first >= scenes.length) throw outOfRange("scene_index_min", first, scenes.length);
      const last = Math.min(scene_index_max ?? scenes.length - 1, scenes.length - 1);
      const columns = scenes.slice(first, last + 1).map((scene, k) => ({
        index: first + k,
        id: remember(scene),
        name: scene.name,
      }));
      const regular = song().tracks;
      const tracks = trackSelection(list, regular);
      const cells = tracks.length * columns.length;
      if (cells > MAX_GRID_CELLS)
        throw new UsageError(
          `${tracks.length} tracks × ${columns.length} scenes = ${cells} cells, at most ${MAX_GRID_CELLS} ` +
            "per call: narrow it with tracks or scene_index_min / scene_index_max.",
        );
      let clipCount = 0;
      const rows = tracks.map((track) => {
        const slots = track.clipSlots;
        const group = track.groupTrack;
        return {
          ...trackRow(track, regular),
          group_track_id: group ? remember(group) : null,
          cells: columns.map(({ index }) => {
            const clip = slots[index]?.clip;
            if (!clip) return null;
            clipCount++;
            return clipBrief(clip);
          }),
        };
      });
      return { scenes: columns, tracks: rows, clip_count: clipCount };
    },
  );

  tool(
    "cue_point_create",
    { title: "Create cue point", annotations: CREATE },
    "Create an arrangement cue point (locator) at a beat position, optionally " +
      "named. `items` creates several in one call (two undo steps: creates, then " +
      "names) and reports a failed entry as {error} instead of failing the call.",
    {
      time: z
        .number()
        .optional()
        .describe("Position in the arrangement in beats (required unless items is given)"),
      name: z.string().optional(),
      items: z
        .array(
          z.object({
            time: z.number().describe("Position in the arrangement in beats"),
            name: z.string().optional(),
          }),
        )
        .min(1)
        .optional()
        .describe("Batch form: one entry per cue point; returns {items}"),
    },
    async (args) => {
      const { list, batch } = entries(args, args.items, ["time", "name"]);
      const times = list.map((it, i) =>
        at(itemLabel(batch, i), () => {
          if (it.time === undefined) throw new UsageError("time is required.");
          if (list.findIndex((o) => o.time === it.time) !== i)
            throw new UsageError(`time ${it.time} is given twice.`);
          return it.time;
        }),
      );
      if (!batch) {
        const cue = await song().createCuePoint(times[0]);
        if (args.name !== undefined) cue.name = args.name;
        return cuePointSummary(cue);
      }
      const results = await createBatch(list, (i) => song().createCuePoint(times[i]));
      return {
        items: results.map((r) => (r.created ? { ...cuePointSummary(r.created), error: r.error } : r)),
      };
    },
  );

  tool(
    "cue_point_set",
    { title: "Rename or move cue point", annotations: SET },
    "Rename and/or move a cue point (locator), or several with `items`. Live " +
      "cannot change a cue point's time, so a move creates a cue point at `time` " +
      "with the same (or the given) name, then deletes the old one: the result " +
      "carries the new id and `replaced_id` (the old id is gone). A move onto a " +
      "beat where another cue point sits is refused. Renames form one undo step; " +
      "moves take up to three (creates, names, deletes). If no replacement can be " +
      "created, nothing is changed; if an old cue point cannot be deleted, its " +
      "entry reports `error` next to the new cue point.",
    {
      cue_point_id: z.string().optional(),
      name: z.string().optional(),
      time: z.number().optional().describe("Move to this arrangement position in beats"),
      items: z
        .array(
          z.object({
            cue_point_id: z.string(),
            name: z.string().optional(),
            time: z.number().optional().describe("Move to this arrangement position in beats"),
          }),
        )
        .min(1)
        .optional()
        .describe("Batch form: one entry per cue point; returns {items}"),
    },
    async (args) => {
      const { list, batch } = entries(args, args.items, ["cue_point_id", "name", "time"]);
      const existing = song().cuePoints.map((c) => ({ id: remember(c), time: num(c.time) }));
      const plan = list.map((it, i) =>
        at(itemLabel(batch, i), () => {
          if (it.cue_point_id === undefined) throw new UsageError("cue_point_id is required.");
          if (it.name === undefined && it.time === undefined)
            throw new UsageError("nothing to set — give name and/or time.");
          if (list.findIndex((o) => o.cue_point_id === it.cue_point_id) !== i)
            throw new UsageError(`cue point ${it.cue_point_id} is given twice.`);
          const cue = resolve(it.cue_point_id, CuePoint);
          const moveTo = it.time !== undefined && it.time !== num(cue.time) ? it.time : undefined;
          if (moveTo !== undefined) {
            const taken = existing.find((c) => c.time === moveTo);
            if (taken) throw new UsageError(`cue point ${taken.id} is already at beat ${moveTo}.`);
            if (list.slice(0, i).some((o) => o.time === moveTo))
              throw new UsageError(`time ${moveTo} is given twice.`);
          }
          return { id: it.cue_point_id, cue, name: it.name, oldName: cue.name, moveTo, i };
        }),
      );
      const moves = plan.filter((p) => p.moveTo !== undefined);

      // 1. Create the replacements in one undo step. If one fails, remove the
      //    others again so the call changes nothing.
      const replacement = new Map<(typeof plan)[number], CuePoint<"1.0.0">>();
      if (moves.length) {
        const known = new Set(existing.map((c) => c.id));
        const settled = await context.withinTransaction(() =>
          Promise.allSettled(moves.map((m) => song().createCuePoint(m.moveTo!))),
        );
        // A create that hands back an existing cue point did not create one;
        // never rename or roll back (delete) the user's cue point for it.
        const fresh = settled.map((r) =>
          r.status === "fulfilled" && !known.has(remember(r.value)) ? r.value : null,
        );
        const bad = fresh.findIndex((c) => !c);
        if (bad >= 0) {
          const made = fresh.filter((c): c is CuePoint<"1.0.0"> => c !== null);
          const undone = made.length
            ? await context.withinTransaction(() =>
                Promise.allSettled(made.map((c) => song().deleteCuePoint(c))),
              )
            : [];
          const left = made.filter((_, k) => undone[k].status === "rejected").map((c) => remember(c));
          const r = settled[bad];
          const why =
            r.status === "rejected"
              ? errorMessage(r.reason)
              : `Live returned the existing cue point ${remember(r.value)} instead of a new one`;
          const where = itemLabel(batch, moves[bad].i);
          throw new Error(
            `${where ? `${where}: ` : ""}could not create a cue point at beat ${moves[bad].moveTo}: ${why}. ` +
              (left.length
                ? `The replacement cue points ${left.join(", ")} could not be removed again; ` +
                  "nothing else was changed."
                : "Nothing was changed."),
          );
        }
        moves.forEach((m, k) => replacement.set(m, fresh[k]!));
      }

      // 2. Names: renames, and the moved cue points' names (one undo step).
      const names = plan.flatMap((p) => {
        const name = p.name ?? (p.moveTo !== undefined ? p.oldName : undefined);
        return name === undefined ? [] : [{ target: replacement.get(p) ?? p.cue, name }];
      });
      if (names.length)
        context.withinTransaction(() => {
          for (const { target, name } of names) target.name = name;
        });

      // 3. Delete the moved originals (one undo step).
      const deleted = moves.length
        ? await context.withinTransaction(() =>
            Promise.allSettled(moves.map((m) => song().deleteCuePoint(m.cue))),
          )
        : [];
      const out = plan.map((p) => {
        const k = moves.indexOf(p);
        if (k < 0) return cuePointSummary(p.cue);
        const summary = cuePointSummary(replacement.get(p)!);
        const r = deleted[k];
        return r.status === "fulfilled"
          ? { ...summary, replaced_id: p.id }
          : {
              ...summary,
              error: `moved, but the old cue point ${p.id} could not be deleted: ${errorMessage(r.reason)}`,
            };
      });
      return batch ? { items: out } : out[0];
    },
  );

  tool(
    "cue_point_delete",
    { title: "Delete cue point", annotations: DESTRUCTIVE },
    "Delete a cue point.",
    { cue_point_id: z.string() },
    async ({ cue_point_id }) => {
      await song().deleteCuePoint(resolve(cue_point_id, CuePoint));
      return { deleted: cue_point_id };
    },
  );

  const MAX_ARRANGEMENT_CLIPS = 500;

  tool(
    "arrangement_get",
    { title: "Get arrangement range", annotations: READ },
    "What happens in the arrangement between start_time and end_time (beats; " +
      "default: from 0 to the end of the song): the cue points in the range, and for " +
      "every regular track (or only `tracks`) the arrangement clips that overlap it — " +
      "clip summaries by start time, a clip overlaps when it starts before end_time " +
      "and ends after start_time — plus, with include_take_lanes, each take lane's " +
      "overlapping clips. `song_end` is derived: the latest end of any arrangement " +
      "clip on a regular track (Live's API has no song length; take lanes and cue " +
      "points do not count). At 4/4, bar n starts at beat (n - 1) × 4. At most " +
      `${MAX_ARRANGEMENT_CLIPS} clips are listed: \`clip_count\` counts them all and ` +
      "`truncated` says when some were left out.",
    {
      start_time: z.number().optional().describe("Range start in beats; default 0"),
      end_time: z
        .number()
        .optional()
        .describe("Range end in beats (exclusive); default: everything after start_time"),
      tracks: z
        .array(z.object(trackAddress))
        .min(1)
        .optional()
        .describe("Only these tracks (each by track_id, track_index or track_name); omit for every regular track"),
      include_take_lanes: z.boolean().default(false).describe("Also list each take lane's clips in the range"),
    },
    ({ start_time, end_time, tracks: list, include_take_lanes }) => {
      const from = start_time ?? 0;
      if (end_time !== undefined && end_time <= from)
        throw new UsageError(`end_time ${end_time} must be after start_time ${from}.`);
      const to = end_time ?? Infinity;
      const regular = song().tracks;
      const tracks = trackSelection(list, regular);
      let songEnd = 0;
      for (const track of regular) for (const clip of track.arrangementClips) songEnd = Math.max(songEnd, num(clip.endTime));
      let listed = 0;
      let total = 0;
      const pick = (clips: Clip<"1.0.0">[]) => {
        const hits = clipsInRange(clips, from, to);
        const room = Math.max(0, MAX_ARRANGEMENT_CLIPS - listed);
        total += hits.length;
        listed += Math.min(room, hits.length);
        return hits.slice(0, room).map((c) => clipSummary(c));
      };
      const rows = tracks.map((track) => ({
        ...trackRow(track, regular),
        clips: pick(track.arrangementClips),
        take_lanes: include_take_lanes
          ? track.takeLanes.map((lane, index) => ({
              id: remember(lane),
              name: lane.name,
              index,
              clips: pick(lane.clips),
            }))
          : undefined,
      }));
      const cuePoints = song()
        .cuePoints.map(cuePointSummary)
        .filter((c) => c.time >= from && c.time < to)
        .sort((a, b) => a.time - b.time);
      return {
        start_time: from,
        end_time: end_time ?? Math.max(songEnd, from),
        song_end: songEnd,
        cue_points: cuePoints,
        tracks: rows,
        clip_count: total,
        truncated:
          total > listed
            ? `Only the first ${MAX_ARRANGEMENT_CLIPS} of ${total} clips are listed (tracks in order): ` +
              "narrow the range or the tracks."
            : undefined,
      };
    },
  );

  // -- clips -----------------------------------------------------------------

  tool(
    "clip_create",
    { title: "Create clip", annotations: CREATE },
    "Create a MIDI or audio clip. Target: a clip slot id (session view), a track " +
      "(target_id, or track_id/track_index/track_name; arrangement — MidiTrack for " +
      "midi, AudioTrack for audio; requires start_time — OR the session slot of a " +
      "scene when scene_index/scene_id/scene_name is given), or a take lane id " +
      "(requires start_time). MIDI clips require duration and can be created with " +
      "their notes inline: `notes`, step `patterns` (one pitch per string, e.g. " +
      "{note:\"C1\", steps:\"x...x...\"}) and `repeat` {length} to copy them along " +
      "the clip (file_path, is_warped and loop_settings are rejected). " +
      "Audio clips require file_path; by default the file is first imported " +
      "into the Live project (recommended). Optional name/color apply right " +
      "after creation.",
    {
      type: z.enum(["midi", "audio"]),
      target_id: z
        .string()
        .optional()
        .describe("ClipSlot, Track, or TakeLane id; or give the track by track_id/track_index/track_name"),
      ...trackAddress,
      scene_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("With a track target: create in this session clip slot instead of the arrangement"),
      scene_id: z.string().optional().describe("With a track target: the session clip slot of this scene"),
      scene_name: z
        .string()
        .optional()
        .describe("With a track target: the session clip slot of the scene with this name"),
      start_time: z.number().optional().describe("Arrangement position in beats (track/take-lane targets)"),
      duration: z.number().positive().optional().describe("Clip length in beats"),
      notes: z.array(z.object(noteShape)).optional().describe("MIDI only: initial notes"),
      patterns: z
        .array(patternSchema())
        .optional()
        .describe("MIDI only: step patterns, written with the notes, e.g. a drum line per pad"),
      repeat: repeatSchema().optional(),
      name: z.string().optional(),
      color: z.string().optional().describe("#RRGGBB"),
      file_path: z.string().optional().describe("Audio file path (audio clips only)"),
      is_warped: z.boolean().optional().describe("Audio only. Required when loop_settings is set"),
      loop_settings: loopSettingsShape.optional(),
      import_into_project: z
        .boolean()
        .default(true)
        .describe("Audio only: copy the file into the Live project first"),
    },
    async (args) => {
      if (args.type === "midi") {
        const audioOnly = (["file_path", "is_warped", "loop_settings"] as const).filter(
          (k) => args[k] !== undefined,
        );
        if (audioOnly.length)
          throw new UsageError(`MIDI clips take no ${audioOnly.join(", ")} (audio clips only).`);
      } else {
        const midiOnly = (["notes", "patterns", "repeat"] as const).filter((k) => args[k] !== undefined);
        if (midiOnly.length) throw new UsageError(`${midiOnly.join(", ")} only apply to MIDI clips.`);
      }
      let target = findTarget(args);
      if (hasSceneAddress(args)) {
        if (!(target instanceof Track))
          throw new UsageError(
            `scene_index/scene_id/scene_name require a Track target, got ${classOf(target)}.`,
          );
        const { index } = findScene(args);
        const slot = target.clipSlots[index];
        if (!slot)
          throw new UsageError(
            `scene_index ${index} out of range (track has ${target.clipSlots.length} slots).`,
          );
        target = slot;
      }
      const need = (cond: unknown, what: string) => {
        if (cond === undefined || cond === null)
          throw new UsageError(`${what} is required for this target/type.`);
      };
      const parsedColor = args.color !== undefined ? hexToColor(args.color) : undefined;
      const finish = (clip: Clip<"1.0.0">, extra?: Record<string, unknown>) => {
        if (args.name !== undefined) clip.name = args.name;
        if (parsedColor !== undefined) clip.color = parsedColor;
        return { ...clipSummary(clip, true), ...extra };
      };

      if (args.type === "midi") {
        need(args.duration, "duration");
        // every note is built (and checked) before the clip exists
        const { notes } = noteList(args, args.duration!);
        let clip: MidiClip<"1.0.0">;
        if (target instanceof ClipSlot) {
          clip = await target.createMidiClip(args.duration!);
        } else if (target instanceof MidiTrack || target instanceof TakeLane) {
          need(args.start_time, "start_time");
          clip = await target.createMidiClip(args.start_time!, args.duration!);
        } else {
          throw new UsageError(
            `MIDI clips need a ClipSlot, MidiTrack, or TakeLane target, got ${classOf(target)}.`,
          );
        }
        if (notes.length) clip.notes = notes;
        return finish(clip);
      }

      need(args.file_path, "file_path");
      // Validate the target before importing so a bad target doesn't leave an
      // orphan copy in the project folder.
      if (!(target instanceof ClipSlot) && !(target instanceof AudioTrack) && !(target instanceof TakeLane))
        throw new UsageError(
          `Audio clips need a ClipSlot, AudioTrack, or TakeLane target, got ${classOf(target)}.`,
        );
      if (!(target instanceof ClipSlot)) need(args.start_time, "start_time");
      if (args.loop_settings && args.is_warped === undefined)
        throw new UsageError("is_warped is required when loop_settings is set.");
      const filePath = args.import_into_project
        ? await context.resources.importIntoProject(args.file_path!)
        : args.file_path!;
      const loopSettings = args.loop_settings && {
        looping: args.loop_settings.looping,
        startMarker: args.loop_settings.start_marker,
        endMarker: args.loop_settings.end_marker,
        loopStart: args.loop_settings.loop_start,
        loopEnd: args.loop_settings.loop_end,
      };
      let clip: AudioClip<"1.0.0">;
      if (target instanceof ClipSlot) {
        clip = await target.createAudioClip({ filePath, isWarped: args.is_warped, loopSettings });
      } else {
        clip = await target.createAudioClip({
          filePath,
          startTime: args.start_time!,
          duration: args.duration,
          isWarped: args.is_warped,
          loopSettings,
        });
      }
      return finish(clip, { imported_path: args.import_into_project ? filePath : undefined });
    },
  );

  tool(
    "clip_get",
    { title: "Get clip", annotations: READ },
    "Get full detail for one clip (MIDI: note count; audio: file, warp settings " +
      "and warp markers) and its `location`: view 'session' (track, scene_index, " +
      "scene and clip slot), 'arrangement' (track) or 'take_lane' (track and take " +
      "lane). Use midi_clip_get_notes for the actual notes.",
    { clip_id: z.string() },
    ({ clip_id }) => {
      const clip = resolve(clip_id, Clip);
      return { ...clipSummary(clip, true), location: locate(clip) };
    },
  );

  const clipProps = {
    name: z.string().optional(),
    color: z.string().optional().describe("#RRGGBB"),
    muted: z.boolean().optional(),
    looping: z.boolean().optional(),
    warping: z.boolean().optional().describe("Audio clips only"),
    warp_mode: z.enum(WARP_MODES).optional().describe("Audio clips only"),
  };
  const CLIP_PROPS = Object.keys(clipProps);
  type ClipProps = z.objectOutputType<typeof clipProps, z.ZodTypeAny>;

  // Validates one clip's changes and returns the setters, so that a batch can
  // check every clip before the first write.
  function clipWrites(clip: Clip<"1.0.0">, p: ClipProps): () => void {
    const parsedColor = p.color !== undefined ? hexToColor(p.color) : undefined;
    if ((p.warping !== undefined || p.warp_mode !== undefined) && !(clip instanceof AudioClip))
      throw new UsageError("warping/warp_mode only apply to audio clips.");
    return () => {
      if (p.name !== undefined) clip.name = p.name;
      if (parsedColor !== undefined) clip.color = parsedColor;
      if (p.muted !== undefined) clip.muted = p.muted;
      if (p.looping !== undefined) clip.looping = p.looping;
      if (clip instanceof AudioClip) {
        if (p.warping !== undefined) clip.warping = p.warping;
        if (p.warp_mode !== undefined) clip.warpMode = WarpMode[p.warp_mode];
      }
    };
  }

  const CLIP_SCOPES = ["all", "session", "arrangement", "take_lanes"] as const;

  // A track's clips in the given scope; a clip listed twice counts once.
  function clipsOf(track: Track<"1.0.0">, scope: (typeof CLIP_SCOPES)[number], nameContains?: string) {
    const want = (s: string) => scope === "all" || scope === s;
    const all = [
      ...(want("session") ? track.clipSlots.flatMap((s) => s.clip ?? []) : []),
      ...(want("arrangement") ? track.arrangementClips : []),
      ...(want("take_lanes") ? track.takeLanes.flatMap((l) => l.clips) : []),
    ];
    const seen = new Set<bigint>();
    const q = nameContains?.toLowerCase();
    return all.filter((c) => {
      if (seen.has(c.handle.id)) return false;
      seen.add(c.handle.id);
      return q === undefined || c.name.toLowerCase().includes(q);
    });
  }

  tool(
    "clip_set",
    { title: "Set clip properties", annotations: SET },
    "Set clip properties. color is '#RRGGBB'. warping/warp_mode apply to audio " +
      "clips only. Note: enabling looping on an unwarped audio clip enables warping. " +
      "Address one clip by clip_id; several by `items` (one entry per clip, each " +
      "with its own values); or every clip of one track by `select` {track_id | " +
      "track_index | track_name, scope, name_contains} with the values at the top " +
      "level, e.g. warp all clips of the Drums track. All changes form one undo " +
      "step; nothing is changed if any clip is invalid.",
    {
      clip_id: z.string().optional(),
      ...clipProps,
      items: z
        .array(z.object({ clip_id: z.string(), ...clipProps }))
        .min(1)
        .optional()
        .describe("Batch form: one entry per clip; returns {items}"),
      select: z
        .object({
          ...trackAddress,
          scope: z
            .enum(CLIP_SCOPES)
            .default("all")
            .describe("session slots, arrangement, take lanes, or all of them"),
          name_contains: z
            .string()
            .optional()
            .describe("Only clips whose name contains this (case-insensitive)"),
        })
        .optional()
        .describe("Apply the top-level values to the matching clips of one track; returns {items}"),
    },
    (args) => {
      let plan: Array<{ clip: Clip<"1.0.0">; write: () => void }>;
      let writes = true; // false only for a single clip_id with nothing to set
      let batch: boolean;
      if (args.select) {
        if (args.clip_id !== undefined || args.items)
          throw new UsageError("Give one of clip_id, items, or select.");
        if (!given(args, CLIP_PROPS))
          throw new UsageError(`Nothing to set — give ${CLIP_PROPS.join(", ")}.`);
        const { scope, name_contains, ...address } = args.select;
        batch = true;
        plan = clipsOf(findTrack(address), scope, name_contains).map((clip) =>
          at(() => `clip ${remember(clip)} (${JSON.stringify(clip.name)})`, () => ({
            clip,
            write: clipWrites(clip, args),
          })),
        );
      } else {
        const e = entries(args, args.items, ["clip_id", ...CLIP_PROPS]);
        batch = e.batch;
        plan = e.list.map((it, i) =>
          at(itemLabel(batch, i), () => {
            if (it.clip_id === undefined) throw new UsageError("Provide clip_id, items, or select.");
            const clip = resolve(it.clip_id, Clip);
            if (!given(it, CLIP_PROPS)) {
              if (batch) throw new UsageError(`nothing to set — give ${CLIP_PROPS.join(", ")}.`);
              writes = false;
            }
            return { clip, write: clipWrites(clip, it) };
          }),
        );
      }
      // Validation is done: apply every clip's setters as one undo step.
      if (plan.length && writes)
        context.withinTransaction(() => {
          for (const { write } of plan) write();
        });
      const out = plan.map(({ clip }) => clipSummary(clip));
      return batch ? { items: out } : out[0];
    },
  );

  tool(
    "clip_delete",
    { title: "Delete clip", annotations: DESTRUCTIVE },
    "Delete a clip (session or arrangement). The clip's parent determines how it " +
      "is removed.",
    { clip_id: z.string() },
    async ({ clip_id }) => {
      const clip = resolve(clip_id, Clip);
      const parent = clip.parent;
      if (parent instanceof ClipSlot) {
        await parent.deleteClip();
      } else if (parent instanceof Track) {
        await parent.deleteClip(clip);
      } else if (parent instanceof TakeLane && parent.parent instanceof Track) {
        await (parent.parent as Track<"1.0.0">).deleteClip(clip);
      } else {
        throw new Error(`Cannot determine how to delete clip with parent ${parent ? classOf(parent) : "null"}.`);
      }
      return { deleted: clip_id };
    },
  );

  // -- MIDI notes ------------------------------------------------------------

  function resolveScale(spec: ScaleSpec): Scale {
    const classes = (intervals: number[]) =>
      [...new Set(intervals.map((i) => pitchClass(i, 0)))].sort((a, b) => a - b);
    if (spec !== "song")
      return { root_note: parsePitchClass(spec.root, "snap_to_scale.root"), intervals: classes(spec.intervals) };
    const s = song();
    const intervals = classes(s.scaleIntervals.map(num));
    if (!intervals.length) throw new Error("Live reported no intervals for the song's scale.");
    return { root_note: num(s.rootNote), intervals, name: s.scaleName };
  }

  // Live's grid setting in beats. Song has no time signature, so a bar is the
  // first scene's (4/4 without scenes).
  const GRID_BEATS: Record<string, number> = {
    Half: 2,
    Quarter: 1,
    Eighth: 0.5,
    Sixteenth: 0.25,
    ThirtySecond: 0.125,
  };
  const GRID_BARS: Record<string, number> = { EightBars: 8, FourBars: 4, TwoBars: 2, Bar: 1 };
  function songGrid() {
    const s = song();
    const quantization = gridName(s.gridQuantization);
    const isTriplet = s.gridIsTriplet;
    const scene = s.scenes[0];
    const bar = scene ? (num(scene.signatureNumerator) * 4) / num(scene.signatureDenominator) : 4;
    const bars = GRID_BARS[quantization];
    const beats = GRID_BEATS[quantization] ?? (bars === undefined ? undefined : bars * bar);
    if (beats === undefined)
      throw new UsageError(
        `Live's grid is ${quantization === "NoGrid" ? "off" : quote(String(quantization))}: ` +
          'give the grid in beats instead of "song".',
      );
    return { beats: isTriplet ? (beats * 2) / 3 : beats, quantization, is_triplet: isTriplet };
  }

  tool(
    "midi_clip_get_notes",
    { title: "Get MIDI notes", annotations: READ },
    "Get the MIDI notes of a clip. Times/durations in beats relative to clip start. " +
      "`select` returns only the matching notes (pitch range, also as note names like " +
      "\"C1\"; start time range; in_scale against the song's scale; every_nth; " +
      "only_selected: the notes the user selected in Live, when Live reports them — " +
      "unverified, a `warning` says when it reported no selection). Notes carry " +
      "`selected` when Live reports it. format \"compact\" returns each note as " +
      "[pitch, start_time, duration, velocity], plus an object of its other fields " +
      "that differ from `defaults`: several times smaller for dense clips.",
    {
      clip_id: z.string(),
      select: noteSelectSchema().optional().describe("Only the notes matching every given filter"),
      only_selected: z.boolean().optional().describe("Same as select.only_selected"),
      format: z
        .enum(["full", "compact"])
        .default("full")
        .describe("full: one object per note; compact: one tuple per note"),
    },
    ({ clip_id, select, only_selected, format }) => {
      const sel: NoteSelect = { ...select, only_selected: only_selected || select?.only_selected };
      const scale = sel.in_scale !== undefined ? resolveScale("song") : undefined;
      const matches = noteFilter(sel, scale);
      const all = resolve(clip_id, MidiClip).notes;
      const mask = matches(all);
      const notes = all.filter((_, i) => mask[i]).map(noteOut);
      return {
        note_count: notes.length,
        total_note_count: select !== undefined || only_selected ? all.length : undefined,
        scale,
        warning: sel.only_selected ? selectionWarning(all) : undefined,
        ...(format === "compact" ? compactNotes(notes) : { notes }),
      };
    },
  );

  tool(
    "midi_clip_set_notes",
    { title: "Write MIDI notes", annotations: DESTRUCTIVE_CUMULATIVE },
    "Write notes to a MIDI clip. mode 'replace' (default) replaces ALL notes; " +
      "mode 'merge' adds the given notes on top of the existing ones (layering " +
      "without re-sending the current content). Pitches are 0-127 or note names " +
      "(C3 = 60). Shortcuts: `patterns` writes one pitch per string, e.g. " +
      "{note:\"F#1\", steps:\"x.x.x.x.\", step:0.25} (\"X\" = accent), and `repeat` " +
      "{length, times?} copies the notes and patterns every `length` beats, filling " +
      "the clip (to its loop end when looping) when times is omitted. For mechanical " +
      "edits of existing notes (transpose, shift, quantize, ...) prefer midi_clip_edit_notes.",
    {
      clip_id: z.string(),
      notes: z
        .array(z.object(noteShape))
        .optional()
        .describe("Notes to write; [] in mode replace clears the clip"),
      patterns: z.array(patternSchema()).optional().describe("Step patterns, written with the notes"),
      repeat: repeatSchema().optional(),
      mode: z.enum(["replace", "merge"]).default("replace"),
    },
    (args) => {
      if (args.notes === undefined && args.patterns === undefined)
        throw new UsageError("Give notes and/or patterns (notes: [] with mode replace clears the clip).");
      const clip = resolve(args.clip_id, MidiClip);
      // Filling needs the clip's end, in the same clip beats as note times.
      const fill = args.repeat !== undefined && args.repeat.times === undefined;
      const end = fill ? num(clip.looping ? clip.loopEnd : clip.endMarker) : Infinity;
      const { notes, copies } = noteList(args, end);
      const merge = args.mode === "merge";
      clip.notes = merge ? [...clip.notes, ...notes] : notes;
      return {
        note_count: merge ? undefined : notes.length,
        added: merge ? notes.length : undefined,
        copies,
      };
    },
  );

  tool(
    "midi_clip_edit_notes",
    { title: "Edit MIDI notes", annotations: DESTRUCTIVE_CUMULATIVE },
    "Transform the existing notes of a MIDI clip (clip_id), or of several clips alike " +
      "(clip_ids), server-side — no need to read and rewrite the note list. Optional " +
      "`select` restricts which notes are affected (pitch/time range, in_scale, " +
      "every_nth, only_selected = the user's note selection in Live, when Live reports " +
      "it: unverified); others pass through untouched. Transforms, applied in this " +
      "order: transpose (semitones), snap_to_scale (\"song\" or {root, intervals}: notes " +
      "outside the scale move to the nearest scale note, ties go down), set (velocity, " +
      "probability, velocity_deviation, release_velocity, muted), velocity_scale, " +
      "velocity_offset, time_shift (beats), quantize (start times to a grid in beats or " +
      "Live's \"song\" grid, strength 0-1), swing, duration_set or duration_scale, " +
      "legato (each note lasts until the next later start among the selected notes; " +
      "notes starting together are a chord and end together; the last ones keep their " +
      "length), humanize (random ±timing beats and ±velocity, reproducible with `seed`; " +
      "the seed used is returned) — or delete=true to remove the selected notes. " +
      "Results are clamped to valid MIDI ranges. Each clip gets one notes write, all " +
      "clips together form one undo step, and nothing is written if an argument or a " +
      "clip is invalid.",
    {
      clip_id: z.string().optional().describe("The MIDI clip (or give clip_ids)"),
      clip_ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Several MIDI clips, edited alike; returns {items}"),
      select: noteSelectSchema().optional().describe("Only transform the notes matching every given filter"),
      transpose: z.number().int().optional().describe("Semitones, negative = down"),
      snap_to_scale: scaleSchema()
        .optional()
        .describe('Move notes outside the scale to the nearest scale note; "song" = Live\'s current scale'),
      set: z
        .object({
          velocity: z.number().min(0).max(127).optional(),
          probability: z.number().min(0).max(1).optional(),
          velocity_deviation: z.number().optional(),
          release_velocity: z.number().min(0).max(127).optional(),
          muted: z.boolean().optional(),
        })
        .optional()
        .describe("Set these fields on every selected note"),
      time_shift: z.number().optional().describe("Beats, negative = earlier"),
      velocity_scale: z.number().min(0).optional(),
      velocity_offset: z.number().optional(),
      quantize: z
        .object({ grid: gridSchema("Grid"), strength: z.number().min(0).max(1).default(1) })
        .optional(),
      swing: z
        .object({
          amount: z
            .number()
            .min(0)
            .max(1)
            .describe("0 = straight, about 0.67 = triplet feel, 1 = dotted: the off-beat moves amount × grid/2"),
          grid: gridSchema("Swing grid").default(0.25),
        })
        .optional()
        .describe("Delay every second grid step; positions in between move proportionally"),
      duration_set: z.number().positive().optional().describe("New length of every selected note, in beats"),
      duration_scale: z.number().positive().optional().describe("Multiply lengths, e.g. 0.5 = shorter"),
      legato: z
        .boolean()
        .optional()
        .describe(
          "Lengthen or cut each selected note to the next later start among the selected notes; notes " +
            "starting less than 1/64 beat apart are a chord and end together; the last ones keep their length",
        ),
      humanize: z
        .object({
          timing: z.number().min(0).default(0).describe("Largest random start shift, ± beats (e.g. 0.02)"),
          velocity: z.number().min(0).default(0).describe("Largest random velocity change, ± (whole steps)"),
          seed: z
            .number()
            .int()
            .optional()
            .describe(
              "Same seed, clips and notes: same result; omitted = a random seed, returned as humanize_seed",
            ),
        })
        .optional(),
      delete: z.boolean().optional().describe("Delete the selected notes instead of transforming"),
    },
    (args) => {
      if ((args.clip_id === undefined) === (args.clip_ids === undefined))
        throw new UsageError("Give clip_id or clip_ids (one of them).");
      if (args.duration_set !== undefined && args.duration_scale !== undefined)
        throw new UsageError("Give duration_set or duration_scale, not both.");
      const hz = args.humanize;
      if (hz && !hz.timing && !hz.velocity) throw new UsageError("humanize: give timing and/or velocity.");
      const sel = args.select ?? {};
      const scale =
        args.snap_to_scale !== undefined || sel.in_scale !== undefined
          ? resolveScale(args.snap_to_scale ?? "song")
          : undefined;
      const matches = noteFilter(sel, scale);
      const grid = args.quantize?.grid === "song" || args.swing?.grid === "song" ? songGrid() : undefined;
      const gridBeats = (g: number | "song") => (g === "song" ? grid!.beats : g);
      const seed = hz ? (hz.seed ?? Math.floor(Math.random() * 2 ** 31)) : undefined;
      const random = seed === undefined ? undefined : seededRandom(seed);
      // Every clip is resolved before the first write.
      const ids = args.clip_ids ?? [args.clip_id!];
      const clips = ids.map((id, i) =>
        at(args.clip_ids ? `clip_ids[${i}]` : undefined, () => resolve(id, MidiClip)),
      );
      clips.forEach((clip, i) => {
        const first = clips.findIndex((c) => c.handle.id === clip.handle.id);
        if (first !== i)
          throw new UsageError(`clip_ids[${i}]: clip ${ids[i]} is listed twice, also as clip_ids[${first}].`);
      });
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const edits = clips.map((clip) => {
        const notes = clip.notes;
        const mask = matches(notes);
        const changed = mask.filter(Boolean).length;
        const warning = sel.only_selected ? selectionWarning(notes) : undefined;
        if (args.delete) return { clip, out: notes.filter((_, i) => !mask[i]), changed, warning };
        const out = notes.slice();
        const edited: NoteDescription[] = []; // the selected notes, transformed, in time order
        for (const i of timeOrder(notes)) {
          if (!mask[i]) continue;
          const n = notes[i];
          const t = { ...n, pitch: num(n.pitch), startTime: num(n.startTime), duration: num(n.duration) };
          if (args.transpose) t.pitch = clamp(t.pitch + args.transpose, 0, 127);
          if (args.snap_to_scale !== undefined) t.pitch = snapToScale(t.pitch, scale!);
          const set = args.set;
          if (set?.velocity !== undefined) t.velocity = set.velocity;
          if (set?.probability !== undefined) t.probability = set.probability;
          if (set?.velocity_deviation !== undefined) t.velocityDeviation = set.velocity_deviation;
          if (set?.release_velocity !== undefined) t.releaseVelocity = set.release_velocity;
          if (set?.muted !== undefined) t.muted = set.muted;
          if (args.velocity_scale !== undefined || args.velocity_offset !== undefined) {
            const v = num(t.velocity ?? 100) * (args.velocity_scale ?? 1) + (args.velocity_offset ?? 0);
            t.velocity = clamp(v, 1, 127);
          }
          if (args.time_shift) t.startTime = Math.max(0, t.startTime + args.time_shift);
          if (args.quantize) {
            const g = gridBeats(args.quantize.grid);
            const snapped = Math.round(t.startTime / g) * g;
            t.startTime = t.startTime + (snapped - t.startTime) * args.quantize.strength;
          }
          if (args.swing) t.startTime = swingTime(t.startTime, gridBeats(args.swing.grid), args.swing.amount);
          if (args.duration_set !== undefined) t.duration = args.duration_set;
          if (args.duration_scale !== undefined)
            t.duration = Math.max(MIN_NOTE_DURATION, t.duration * args.duration_scale);
          out[i] = t;
          edited.push(t);
        }
        if (args.legato) legato(edited);
        // Two draws per note, in time order (clip by clip), whether timing,
        // velocity or both are used: a seed always gives a note the same draws.
        if (random && hz)
          for (const t of edited) {
            const dt = random() * 2 - 1;
            const dv = random() * 2 - 1;
            if (hz.timing) t.startTime = Math.max(0, t.startTime + dt * hz.timing);
            if (hz.velocity) t.velocity = clamp(num(t.velocity ?? 100) + Math.round(dv * hz.velocity), 1, 127);
          }
        return { clip, out, changed, warning };
      });
      // One notes write per clip (none where nothing is selected), all in one undo step.
      const writes = edits.filter((e) => e.changed > 0);
      if (writes.length)
        context.withinTransaction(() => {
          for (const e of writes) e.clip.notes = e.out;
        });
      const summary = (e: (typeof edits)[number]) => ({
        note_count: e.out.length,
        changed_count: e.changed,
        warning: e.warning,
      });
      const extra = { humanize_seed: seed, song_grid: grid, scale };
      return args.clip_ids
        ? { items: edits.map((e) => ({ clip_id: remember(e.clip), ...summary(e) })), ...extra }
        : { ...summary(edits[0]), ...extra };
    },
  );

  // -- devices ---------------------------------------------------------------

  tool(
    "device_get",
    { title: "Get device", annotations: READ },
    "Get detail for one device: parameters (metadata + ids), rack chains, drum " +
      "rack pads, or Simpler sample. Big devices have 100+ parameters — use " +
      "parameter_filter (case-insensitive substring on the name) to fetch only " +
      "what you need, include_values to read current values in the same call, " +
      "and include_chain_devices to inline each rack chain's devices (e.g. map " +
      "a whole drum kit pad→note→sample in one call). `location` says where the " +
      "device sits: its track, the path through racks (\"Kit > Drum Rack > pad 36 > " +
      "Simpler\"), its device_index, and the chain and rack it is in.",
    {
      device_id: z.string(),
      parameter_filter: z.string().optional(),
      include_value_items: z.boolean().default(true),
      include_values: z.boolean().default(false),
      include_chain_devices: z.boolean().default(false),
    },
    async ({ device_id, parameter_filter, include_value_items, include_values, include_chain_devices }) => {
      const device = resolve(device_id, Device);
      let params = device.parameters;
      if (parameter_filter !== undefined) {
        const q = parameter_filter.toLowerCase();
        params = params.filter((par) => par.name.toLowerCase().includes(q));
      }
      const parameters = include_values
        ? await Promise.all(params.map((par) => parameterWithValue(par)))
        : params.map((par) => parameterSummary(par, include_value_items));
      return {
        ...deviceSummary(device),
        parameters,
        chains:
          device instanceof RackDevice
            ? device.chains.map((c) => ({
                ...chainSummary(c),
                devices: include_chain_devices ? c.devices.map(deviceSummary) : undefined,
              }))
            : undefined,
        location: locate(device),
      };
    },
  );

  tool(
    "device_insert",
    { title: "Insert device", annotations: CREATE },
    "Insert a built-in Live device (by name, e.g. 'Reverb', 'Auto Filter', 'EQ " +
      "Eight', 'Compressor', 'Simpler', 'Drum Rack', 'Operator', 'Wavetable') into " +
      "a track or rack chain. Third-party plug-ins cannot be loaded. index is the " +
      "0-based position in the device chain; omitted = append at the end. The " +
      "target is a Track or Chain id, or a track given by track_id/track_index/track_name. " +
      "`parameters` sets initial values right after the insert, in one undo step " +
      "(each {name, value | value_item | reset | delta}, as in device_set); if one " +
      "cannot be set, none are, and the device is still inserted with `errors` saying why.",
    {
      target_id: z.string().optional().describe("Track or Chain id"),
      ...trackAddress,
      device_name: z.string(),
      index: z.number().int().min(0).optional(),
      parameters: z.array(initialParameter).min(1).optional().describe("Initial parameter values"),
    },
    async ({ device_name, index, parameters, ...address }) => {
      parameters?.forEach((p, i) => at(`parameters[${i}]`, () => writeKind(p)));
      const target = findTarget(address);
      if (!(target instanceof Track) && !(target instanceof Chain))
        throw new UsageError(`Devices can be inserted into a Track or Chain, got ${classOf(target)}.`);
      const device = await target.insertDevice(device_name, index ?? target.devices.length);
      if (!parameters) return deviceSummary(device);
      // The device exists now: a failing value is reported, not thrown.
      const result = await setInitialParameters(device, parameters);
      return {
        ...deviceSummary(device),
        parameters: result.parameters,
        errors: result.error ? [result.error] : undefined,
      };
    },
  );

  tool(
    "device_set",
    { title: "Set device", annotations: SET },
    "Switch a device on or off and/or set several of its parameters, in one call and " +
      "one undo step (nothing is changed if any entry is invalid). Address the device " +
      "by device_id, or by its track (track_id/track_index/track_name) and `device`: a " +
      'name, an index, or a path into racks such as ["Drum Rack", {"pad": 36}, ' +
      '"Simpler"]. `enabled` sets the device\'s "Device On" parameter — a Live naming ' +
      "convention, not an API field: a device without one falls back to its first " +
      "parameter if that is a two-state switch, and `on_parameter` reports which " +
      "parameter was used (`fallback: true`). Each `parameters` entry names the " +
      "parameter (name: exact, then case-insensitive, then unique substring; or " +
      "parameter_id) and gives one of value (internal units), value_item (a " +
      'quantized parameter\'s choice by name, e.g. "Saw"), reset:true (the default) or ' +
      "delta (added to the current value, clamped).",
    {
      ...deviceAddress,
      enabled: z.boolean().optional().describe("true = on, false = off (bypassed)"),
      parameters: z
        .array(
          z.object({
            name: parameterName.optional(),
            parameter_id: z.string().optional().describe("Instead of name: the parameter's id"),
            ...parameterWrite,
          }),
        )
        .min(1)
        .optional(),
    },
    async ({ enabled, parameters, ...address }) => {
      if (enabled === undefined && !parameters)
        throw new UsageError("Nothing to set — give enabled and/or parameters.");
      const device = findDevice(address);
      // Validate everything before the first write.
      const onOff = enabled !== undefined ? onOffParameter(device) : undefined;
      const plan: PlannedWrite[] = [];
      const labels: string[] = [];
      if (onOff) {
        plan.push(planWrite(onOff.param, { value: enabled ? onOff.on : onOff.off }));
        labels.push("enabled");
      }
      const own = new Set(device.parameters.map((p) => p.handle.id));
      (parameters ?? []).forEach((p, i) =>
        at(`parameters[${i}]`, () => {
          if ((p.name === undefined) === (p.parameter_id === undefined))
            throw new UsageError("give exactly one of name and parameter_id.");
          const param =
            p.parameter_id !== undefined
              ? resolve(p.parameter_id, DeviceParameter)
              : findParameter(device, p.name!);
          if (!own.has(param.handle.id))
            throw new UsageError(`parameter ${p.parameter_id} is not a parameter of ${describeDevice(device)}.`);
          plan.push(planWrite(param, p));
          labels.push(`parameters[${i}]`);
        }),
      );
      await applyWrites(plan, labels);
      // Report the on-state even when only parameters were set, if the device has one.
      let state = onOff;
      if (!state)
        try {
          state = onOffParameter(device);
        } catch {
          // no on/off switch: leave `enabled` out
        }
      const [values, onValue] = await Promise.all([
        Promise.all(plan.filter((w) => w.param !== onOff?.param).map((w) => parameterWithValue(w.param))),
        state ? state.param.getValue().then(num) : undefined,
      ]);
      return {
        ...deviceSummary(device),
        enabled: state ? onValue !== state.off : undefined,
        on_parameter: state
          ? { id: remember(state.param), name: state.param.name, fallback: state.fallback || undefined }
          : undefined,
        parameters: parameters ? values : undefined,
      };
    },
  );

  tool(
    "parameter_find",
    { title: "Find parameters", annotations: READ },
    "Find device parameters by name without walking device_get: in the whole Live Set " +
      "(every regular, return and main track), on one track (track_id/track_index/" +
      "track_name), or in one device (device_id, or track + device); racks are searched " +
      "through all their chains. `query` is a case-insensitive substring of the " +
      "parameter name (omit it to list everything in scope); `value_item` keeps only " +
      'quantized parameters with a matching choice (e.g. "saw"). Each match carries its ' +
      "id (for parameter_set, parameter_get, device_set), its device's id and name, the " +
      'track, and a readable path such as "Drums > Drum Rack > pad 36 > Simpler". ' +
      "include_values adds current values (internal units). At most `limit` matches " +
      "are returned; `total` counts them all.",
    {
      query: z.string().optional().describe("Case-insensitive substring of the parameter name"),
      value_item: z
        .string()
        .min(1)
        .optional()
        .describe("Only quantized parameters with a value item whose name or short name contains this"),
      ...deviceAddress,
      include_values: z.boolean().default(false),
      include_value_items: z.boolean().default(true),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ query, value_item, include_values, include_value_items, limit, ...address }) => {
      type Root = { devices: Device<"1.0.0">[]; track?: Track<"1.0.0">; prefix: string[] };
      let roots: Root[];
      if (address.device_id !== undefined || address.device !== undefined) {
        const { device, track, path } = locateDevice(address);
        roots = [{ devices: [device], track, prefix: path.slice(0, -1) }];
      } else if (hasTrackAddress(address)) {
        const track = findTrack(address);
        roots = [{ devices: track.devices, track, prefix: [track.name] }];
      } else {
        const s = song();
        roots = [...s.tracks, ...s.returnTracks, s.mainTrack].map((track) => ({
          devices: track.devices,
          track,
          prefix: [track.name],
        }));
      }
      const q = query?.toLowerCase();
      const item = value_item?.toLowerCase();
      const wanted = (p: DeviceParameter<"1.0.0">) =>
        (q === undefined || p.name.toLowerCase().includes(q)) &&
        (item === undefined ||
          (p.isQuantized &&
            p.valueItems.some((v) => [v.name, v.shortName].some((n) => n?.toLowerCase().includes(item)))));
      const MAX_DEVICES = 1000;
      type Match = { param: DeviceParameter<"1.0.0">; device: Device<"1.0.0">; root: Root; path: string[] };
      const found: Match[] = [];
      let total = 0;
      let searched = 0;
      let stopped = false;
      const walk = (devices: Device<"1.0.0">[], root: Root, prefix: string[], depth: number) => {
        for (const device of devices) {
          if (searched >= MAX_DEVICES) {
            stopped = true;
            return;
          }
          searched++;
          const path = [...prefix, device.name];
          for (const param of device.parameters) {
            if (!wanted(param)) continue;
            total++;
            if (found.length < limit) found.push({ param, device, root, path });
          }
          if (device instanceof RackDevice && depth < 8)
            device.chains.forEach((c, i) => walk(c.devices, root, [...path, chainLabel(c, i)], depth + 1));
        }
      };
      for (const root of roots) walk(root.devices, root, root.prefix, 0);
      const matches = await Promise.all(
        found.map(async ({ param, device, root, path }) => ({
          ...(include_values
            ? await parameterWithValue(param, include_value_items)
            : parameterSummary(param, include_value_items)),
          device_id: remember(device),
          device_name: device.name,
          track_id: root.track ? remember(root.track) : undefined,
          track_name: root.track?.name,
          path: path.join(" > "),
        })),
      );
      return {
        matches,
        total,
        truncated: total > matches.length,
        devices_searched: searched,
        // the search stopped early: total counts only what was searched
        device_limit_reached: stopped || undefined,
      };
    },
  );

  tool(
    "device_delete",
    { title: "Delete device", annotations: DESTRUCTIVE },
    "Delete a device from its track or chain.",
    { device_id: z.string() },
    async ({ device_id }) => {
      const device = resolve(device_id, Device);
      const parent = device.parent;
      if (parent instanceof Track || parent instanceof Chain) {
        await parent.deleteDevice(device);
      } else {
        throw new Error(`Cannot delete device with parent ${parent ? classOf(parent) : "null"}.`);
      }
      return { deleted: device_id };
    },
  );

  tool(
    "device_duplicate",
    { title: "Duplicate device", annotations: CREATE },
    "Duplicate a device; the copy is inserted right after the original.",
    { device_id: z.string() },
    async ({ device_id }) => {
      const device = resolve(device_id, Device);
      const parent = device.parent;
      if (parent instanceof Track || parent instanceof Chain)
        return deviceSummary(await parent.duplicateDevice(device));
      throw new Error(`Cannot duplicate device with parent ${parent ? classOf(parent) : "null"}.`);
    },
  );

  // What a rebuilt device (device_copy, device_preset_load) does not carry over.
  const LOST =
    "automation, modulation and MIDI/macro mappings, a custom device name, and any device " +
    "state that is not a parameter";

  tool(
    "device_copy",
    { title: "Copy or move device", annotations: DESTRUCTIVE_CUMULATIVE },
    "Copy a device to a track or rack chain, or to another position in its own chain; " +
      "with move:true the original is deleted afterwards, which is how a device is moved " +
      "or reordered (Live's API has no device move, reorder or copy). LOSSY: a fresh " +
      "built-in device is inserted at the target and the parameter values are copied by " +
      `name (a Simpler also gets its sample); ${LOST} are lost, and the copy has a new ` +
      "id (after a move the old id is gone). Racks cannot be copied this way: " +
      "device_duplicate copies one in place. Target: target_id (Track or Chain id) or " +
      "track_id/track_index/track_name; omitted = the device's own track or chain. " +
      "`index` counts the target's current devices, before a move removes the original " +
      "(omitted = append). `device_name` is the built-in device to insert when the " +
      "device was renamed in Live (default: its name). Live allows one instrument per " +
      "track or chain, so an instrument cannot be copied next to another one. Undo " +
      "steps: insert, sample, values, delete. If the copy cannot be inserted or its " +
      "sample cannot be loaded, nothing is changed; values that cannot be copied are " +
      "listed in `not_copied`, and then a move keeps the original.",
    {
      device_id: z.string().describe("The device to copy or move"),
      target_id: z
        .string()
        .optional()
        .describe("Track or Chain id; or give the track by track_id/track_index/track_name"),
      ...trackAddress,
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0-based position among the target's current devices; omitted = append"),
      device_name: z
        .string()
        .min(1)
        .optional()
        .describe("Built-in device to insert; default: the device's name"),
      move: z.boolean().default(false).describe("Delete the original once everything was copied"),
    },
    async ({ device_id, index, device_name, move, ...address }) => {
      const source = resolve(device_id, Device);
      rejectRack(source, "copied by name");
      const from = source.parent;
      const target =
        address.target_id !== undefined || hasTrackAddress(address) ? findTarget(address) : from;
      if (!(target instanceof Track) && !(target instanceof Chain))
        throw new UsageError(
          `Devices can be copied into a Track or Chain, got ${target ? classOf(target) : "none"}.`,
        );
      if (move && !(from instanceof Track) && !(from instanceof Chain))
        throw new Error(`Cannot move a device whose parent is ${from ? classOf(from) : "null"}.`);
      const count = target.devices.length;
      if (index !== undefined && index > count)
        throw new UsageError(`index ${index} out of range (0-${count}, or omit it to append).`);
      const insertAt = index ?? count;
      const position =
        from && from.handle.id === target.handle.id
          ? target.devices.findIndex((d) => d.handle.id === source.handle.id)
          : -1;
      // Moving a device onto its own position would only lose state.
      if (move && position >= 0 && (insertAt === position || insertAt === position + 1))
        return {
          ...deviceSummary(source),
          index: position,
          source_id: device_id,
          moved: false,
          unchanged: "the device is already at that position",
        };

      // Read everything from the original before the first write.
      const saved = await readValues(source);
      const samplePath = (source instanceof Simpler && source.sample?.filePath) || undefined;
      const copy = await insertBuiltIn(target, device_name ?? source.name, insertAt, device_name === undefined);
      const { sample, applied, skipped: notCopied } = await restoreDevice(copy, saved, samplePath, target);
      let moved = false;
      let error: string | undefined;
      let kept: string | undefined;
      if (move) {
        if (notCopied.length) {
          kept = "the copy is incomplete (see not_copied), so the original was kept";
        } else {
          try {
            await (from as DeviceHolder).deleteDevice(source);
            moved = true;
          } catch (e) {
            error = `copied, but the original ${device_id} could not be deleted: ${errorMessage(e)}`;
          }
        }
      }
      return {
        ...deviceSummary(copy),
        index: target.devices.findIndex((d) => d.handle.id === copy.handle.id),
        source_id: device_id,
        moved,
        fidelity: "approximate",
        lost: LOST,
        copied_parameters: applied,
        not_copied: notCopied.length ? notCopied : undefined,
        sample,
        original_kept: kept,
        error,
      };
    },
  );

  // -- device presets (JSON files of this server, not Live presets) ----------

  tool(
    "device_preset_save",
    { title: "Save device preset", annotations: DESTRUCTIVE },
    "Save a device's parameter values (and a Simpler's sample path) as a named preset " +
      "of this server: a JSON file in the extension's storage directory " +
      "(presets/<name>.json). It is not a Live preset (.adv): Live's API cannot read or " +
      "write those. Address the device by device_id, or track + device as in " +
      "device_set. Racks cannot be saved. `device_name` records the built-in device a " +
      "load inserts (default: the device's name; pass it if the device was renamed in " +
      "Live). The sample is referenced by its path, not copied. An existing preset of " +
      "the same name (case-insensitive) is only replaced with overwrite:true. Names are " +
      "1-64 letters, digits, spaces and - _ . , ( ) ' + & #, starting with a letter or digit.",
    {
      name: z.string().describe("Preset name"),
      ...deviceAddress,
      device_name: z
        .string()
        .min(1)
        .optional()
        .describe("Built-in device a load inserts; default: the device's name"),
      overwrite: z.boolean().default(false).describe("Replace an existing preset of the same name"),
    },
    async ({ name, device_name, overwrite, ...address }) => {
      const base = presetBaseName(name);
      const device = findDevice(address);
      rejectRack(device, "saved as a preset");
      const store = presets();
      const samplePath = (device instanceof Simpler && device.sample?.filePath) || undefined;
      const preset: Preset = {
        format: PRESET_FORMAT,
        version: 1,
        name: base,
        device_name: device_name ?? device.name,
        device_class: classOf(device),
        saved_at: new Date().toISOString(),
        parameters: await readValues(device),
        sample: samplePath ? { file_path: samplePath } : undefined,
      };
      const { name: stored, replaced } = store.write(base, preset, overwrite);
      return {
        name: stored,
        device_name: preset.device_name,
        parameter_count: preset.parameters.length,
        sample: preset.sample,
        replaced,
        directory: store.dir,
      };
    },
  );

  tool(
    "device_preset_list",
    { title: "List device presets", annotations: READ },
    "List the presets saved with device_preset_save: name, the built-in device they " +
      "insert, parameter count, sample, and when they were saved. Files in the presets " +
      "directory that are not valid presets are listed under `unreadable`.",
    {
      device_name: z.string().optional().describe("Only presets for this built-in device (case-insensitive)"),
    },
    ({ device_name }) => {
      const store = presets();
      const all = store.list();
      const want = device_name?.toLowerCase();
      return {
        directory: store.dir,
        presets: all.presets
          .filter(({ preset }) => want === undefined || preset.device_name.toLowerCase() === want)
          .map(({ name, preset }) => ({
            name,
            device_name: preset.device_name,
            parameter_count: preset.parameters.length,
            sample: preset.sample ?? undefined,
            saved_at: preset.saved_at,
          })),
        unreadable: all.unreadable.length ? all.unreadable : undefined,
      };
    },
  );

  tool(
    "device_preset_load",
    { title: "Load device preset", annotations: DESTRUCTIVE_CUMULATIVE },
    "Load a preset saved with device_preset_save. Onto an existing device (device_id, " +
      "or track + device as in device_set): its parameters are set by name in one undo " +
      "step, and a Simpler also loads the preset's sample in place of its own. Or as a " +
      "new device: give the target instead (target_id: Track or Chain id, or " +
      "track_id/track_index/track_name without `device`) and optionally `index`; the " +
      "preset's built-in device (or `device_name`) is inserted there first. Values the " +
      "device has no parameter for, or that Live refuses, are listed in `not_applied`. " +
      `A preset holds parameter values only: ${LOST} are not part of it.`,
    {
      name: z.string().describe("Preset name (case-insensitive)"),
      ...deviceAddress,
      target_id: z
        .string()
        .optional()
        .describe("Insert a new device into this Track or Chain instead of loading onto an existing one"),
      index: z.number().int().min(0).optional().describe("New device only: 0-based position; omitted = append"),
      device_name: z
        .string()
        .min(1)
        .optional()
        .describe("New device only: the built-in device to insert instead of the preset's"),
    },
    async ({ name, index, device_name, ...address }) => {
      const base = presetBaseName(name);
      const onto = address.device_id !== undefined || address.device !== undefined;
      if (onto && address.target_id !== undefined)
        throw new UsageError("Give a device to load onto, or target_id to insert a new one, not both.");
      if (onto && (index !== undefined || device_name !== undefined))
        throw new UsageError("index and device_name only apply when inserting a new device.");
      if (!onto && address.target_id === undefined && !hasTrackAddress(address))
        throw new UsageError(
          "Give the device to load onto (device_id, or a track and device), or where to insert " +
            "a new one (target_id, or track_id/track_index/track_name).",
        );
      const store = presets();
      const file = store.find(base);
      if (!file) {
        const names = store.list().presets.map((p) => quote(p.name));
        throw new UsageError(`No preset named ${quote(base)}. Saved presets: ${names.join(", ") || "none"}.`);
      }
      const presetName = path.basename(file, ".json");
      let preset: Preset;
      try {
        preset = readPresetFile(file);
      } catch (e) {
        // the file is broken, not the Live Set: no stale-id hint
        throw new UsageError(`Preset ${quote(presetName)} cannot be loaded: ${errorMessage(e)}`);
      }

      // Validate the destination before the first write.
      let device: Device<"1.0.0">;
      let inserted: { target: DeviceHolder } | undefined;
      if (onto) {
        device = findDevice(address);
        rejectRack(device, "loaded from a preset");
      } else {
        const target = findTarget(address);
        if (!(target instanceof Track) && !(target instanceof Chain))
          throw new UsageError(`Devices can be inserted into a Track or Chain, got ${classOf(target)}.`);
        const count = target.devices.length;
        if (index !== undefined && index > count)
          throw new UsageError(`index ${index} out of range (0-${count}, or omit it to append).`);
        device = await insertBuiltIn(target, device_name ?? preset.device_name, index ?? count, false);
        inserted = { target };
      }
      const { sample, applied, skipped: notApplied } = await restoreDevice(
        device,
        preset.parameters,
        preset.sample?.file_path,
        inserted?.target,
      );
      const mismatch = device.name.toLowerCase() !== preset.device_name.toLowerCase();
      return {
        ...deviceSummary(device),
        preset: presetName,
        inserted: inserted !== undefined,
        index: inserted
          ? inserted.target.devices.findIndex((d) => d.handle.id === device.handle.id)
          : undefined,
        applied_parameters: applied,
        not_applied: notApplied.length ? notApplied : undefined,
        sample,
        warning: mismatch
          ? `The preset was saved from ${quote(preset.device_name)}; only parameters with the same ` +
            "names were set."
          : undefined,
      };
    },
  );

  // -- racks / chains --------------------------------------------------------

  tool(
    "chain_get",
    { title: "Get rack chain", annotations: READ },
    "Get detail for a rack chain: its devices and mixer (volume/pan/sends with " +
      "values). Drum chains also report their receiving note. `location` gives the " +
      "track, the path to the chain, its rack and chain_index.",
    { chain_id: z.string() },
    async ({ chain_id }) => {
      const chain = resolve(chain_id, Chain);
      return {
        ...chainSummary(chain),
        devices: chain.devices.map(deviceSummary),
        mixer: await mixerDetail(chain.mixer),
        location: locate(chain),
      };
    },
  );

  tool(
    "rack_insert_chain",
    { title: "Insert rack chain", annotations: CREATE },
    "Insert a new chain into a rack device at the given 0-based index.",
    { rack_device_id: z.string(), index: z.number().int().min(0) },
    async ({ rack_device_id, index }) => {
      const rack = resolve(rack_device_id, RackDevice);
      return chainSummary(await rack.insertChain(index));
    },
  );

  tool(
    "drum_chain_set",
    { title: "Set drum pad note", annotations: SET },
    "Set the MIDI note a drum rack chain (pad) responds to: 0-127 or a note name (C1 = 36).",
    {
      drum_chain_id: z.string(),
      receiving_note: pitchSchema("The MIDI note the pad plays on"),
    },
    ({ drum_chain_id, receiving_note }) => {
      const note = parsePitch(receiving_note, "receiving_note");
      const chain = resolve(drum_chain_id, DrumChain);
      chain.receivingNote = note;
      return chainSummary(chain);
    },
  );

  tool(
    "simpler_replace_sample",
    { title: "Replace Simpler sample", annotations: DESTRUCTIVE },
    "Replace the sample loaded in a Simpler device with another audio file " +
      "(absolute path).",
    { simpler_device_id: z.string(), file_path: z.string() },
    async ({ simpler_device_id, file_path }) => {
      const simpler = resolve(simpler_device_id, Simpler);
      const sample = await simpler.replaceSample(file_path);
      return { id: remember(sample), file_path: sample.filePath };
    },
  );

  // -- parameters / mixer ----------------------------------------------------

  tool(
    "parameter_get",
    { title: "Get parameter values", annotations: READ },
    "Read current values (and metadata) of device or mixer parameters: by id " +
      "(`parameter_ids`) and/or by device and name (`parameters`: entries " +
      "{device_id | track_id/track_index/track_name + device, parameter}, where device " +
      'is a name, an index or a path into racks such as ["Drum Rack", {"pad": 36}, ' +
      '"Simpler"], and parameter matches exactly first, then case-insensitively, then ' +
      "by unique substring; an entry may also be {parameter_id}). Results follow that " +
      "order; entries found by device also carry device_id and device_name. Values are " +
      "internal units; quantized parameters also report the current `value_item`.",
    {
      parameter_ids: z.array(z.string()).min(1).optional(),
      parameters: z
        .array(z.object(parameterAddress))
        .min(1)
        .optional()
        .describe("Parameters by device and name (or parameter_id)"),
    },
    async ({ parameter_ids, parameters }) => {
      if (!parameter_ids && !parameters) throw new UsageError("Provide parameter_ids and/or parameters.");
      const list = [
        ...(parameter_ids ?? []).map((id) => ({ param: resolve(id, DeviceParameter), device: undefined })),
        ...(parameters ?? []).map((p, i) => at(`parameters[${i}]`, () => findParameterEntry(p))),
      ];
      return Promise.all(list.map(withValue));
    },
  );

  tool(
    "parameter_set",
    { title: "Set parameter values", annotations: SET },
    "Set one or more device or mixer parameters in one undo step; nothing is changed if " +
      "any entry is invalid. Each entry addresses its parameter by parameter_id, or by " +
      "device and name as in parameter_get ({device_id | track + device, parameter}), " +
      "and gives exactly one of: value (internal units within [min, max]; a quantized " +
      "parameter takes its value_items index), value_item (a quantized parameter's " +
      'choice by name or short name, e.g. "Saw"), reset:true (the default value) or ' +
      "delta (added to the current value, clamped to [min, max]). Returns the " +
      "parameters with their new values.",
    { values: z.array(z.object({ ...parameterAddress, ...parameterWrite })).min(1) },
    async ({ values }) => {
      const labels = values.map((_, i) => `values[${i}]`);
      const plan = values.map((v, i) =>
        at(labels[i], () => {
          const { param, device } = findParameterEntry(v);
          return { ...planWrite(param, v), device };
        }),
      );
      await applyWrites(plan, labels);
      return Promise.all(plan.map(withValue));
    },
  );

  tool(
    "mixer_get",
    { title: "Get mixer", annotations: READ },
    "Get the mixer of a track or rack chain: volume, panning, and sends with " +
      "current values and parameter ids (settable via parameter_set). Address it " +
      "by target_id, or the track by track_id/track_index/track_name.",
    { target_id: z.string().optional().describe("Track, Chain, or mixer id"), ...trackAddress },
    async (args) => await mixerDetail(findMixer(args).mixer),
  );

  const mixerTarget = {
    target_id: z.string().optional().describe("Track, Chain, or mixer id"),
    ...trackAddress,
  };
  const mixerValues = {
    volume: z.number().min(0).max(1).optional(),
    panning: z.number().min(-1).max(1).optional(),
    sends: z
      .array(
        z.object({
          index: z.number().int().min(0).optional().describe("Send index; order matches the return tracks"),
          return_name: z
            .string()
            .optional()
            .describe("Instead of index: the return track's name (track mixers only)"),
          value: z.number().min(0).max(1),
        }),
      )
      .optional(),
  };
  type MixerValues = z.objectOutputType<typeof mixerValues, z.ZodTypeAny>;
  type AnyMixer = TrackMixer<"1.0.0"> | ChainMixer<"1.0.0">;

  // Validates one mixer's values and returns its parameter writes.
  function mixerWrites(mixer: AnyMixer, v: MixerValues): Array<() => Promise<void>> {
    const writes: Array<() => Promise<void>> = [];
    if (v.volume !== undefined) writes.push(() => mixer.volume.setValue(v.volume!));
    if (v.panning !== undefined) writes.push(() => mixer.panning.setValue(v.panning!));
    for (const send of v.sends ?? []) {
      if ((send.index === undefined) === (send.return_name === undefined))
        throw new UsageError("Each send takes exactly one of index or return_name.");
      let index = send.index!;
      if (send.return_name !== undefined) {
        if (!(mixer instanceof TrackMixer))
          throw new UsageError("return_name only applies to track mixers; address rack chain sends by index.");
        const returns = song().returnTracks.map((track, i) => ({ track, i }));
        const describe = (r: (typeof returns)[number]) => `${JSON.stringify(r.track.name)} (send ${r.i})`;
        const hint = "Use the send index.";
        index = byName("return track", send.return_name, returns, (r) => r.track.name, describe, { hint }).i;
      }
      const p = mixer.sends[index];
      if (!p) throw new UsageError(`send index ${index} out of range (${mixer.sends.length} sends).`);
      writes.push(() => p.setValue(send.value));
    }
    if (!writes.length) throw new UsageError("Nothing to set — provide volume, panning, and/or sends.");
    return writes;
  }

  // all_tracks selection. Setting a group track already changes how its tracks
  // sound, so only the top-most tracks are set: a track inside a group that is
  // set is "covered" and left alone, so nothing is applied twice. Excluded
  // tracks and everything inside an excluded group are left alone; a group that
  // contains an excluded track is not set either (that would change the
  // excluded track too) — its other tracks are set one by one instead.
  function topmostTracks(exclude: TrackAddress[]) {
    const excluded = new Set(exclude.map((a, i) => at(`exclude[${i}]`, () => findTrack(a)).handle.id));
    const tracks = song().tracks.map((track) => {
      const groups: Track<"1.0.0">[] = []; // innermost first
      for (let g = track.groupTrack; g && groups.length < 64; g = g.groupTrack) groups.push(g);
      return { track, groups };
    });
    const holdsExcluded = new Set(
      tracks
        .filter(({ track }) => excluded.has(track.handle.id))
        .flatMap(({ groups }) => groups.map((g) => g.handle.id)),
    );
    const selected: Track<"1.0.0">[] = [];
    const skipped: Array<{ track_id: string; name: string; reason: string }> = [];
    for (const { track, groups } of tracks) {
      const skip = (reason: string) => skipped.push({ track_id: remember(track), name: track.name, reason });
      const excludedGroup = groups.find((g) => excluded.has(g.handle.id));
      // groups that will be set, innermost first: those holding no excluded track
      const setGroups = groups.filter((g) => !holdsExcluded.has(g.handle.id));
      if (excluded.has(track.handle.id)) skip("excluded");
      else if (excludedGroup) skip(`inside the excluded group ${JSON.stringify(excludedGroup.name)}`);
      else if (holdsExcluded.has(track.handle.id))
        skip("group containing an excluded track; its other tracks are set instead");
      else if (setGroups.length)
        skip(`covered by its group ${JSON.stringify(setGroups[setGroups.length - 1].name)}`);
      else selected.push(track);
    }
    return { selected, skipped };
  }

  tool(
    "mixer_set",
    { title: "Set mixer", annotations: SET },
    "Set volume, panning, and/or sends of track or rack chain mixers in one call " +
      "(single undo step; nothing is changed if any target is invalid). Volume is " +
      "normalized 0-1 (0.85 = 0 dB unity, 1.0 = +6 dB); panning is -1..1; each " +
      "send is addressed by index (order matches the return tracks) or return_name. " +
      "Choose the mixers with ONE of: target_id (Track, Chain, or mixer id) or " +
      "track_id/track_index/track_name; `targets` (the same values on several); " +
      "`all_tracks` (every regular track, minus `exclude`); or `items` (one entry " +
      "per mixer with its own values). all_tracks sets the top-most tracks only: a " +
      "group track covers the tracks inside it, which are left alone; tracks inside " +
      "an excluded group are left alone, and a group holding an excluded track is " +
      "not set itself — its other tracks are. A single target returns its mixer; " +
      "the other forms return {items} (plus `skipped` for all_tracks).",
    {
      ...mixerTarget,
      ...mixerValues,
      targets: z
        .array(z.object(mixerTarget))
        .min(1)
        .optional()
        .describe("Several mixers that get the top-level values"),
      all_tracks: z
        .boolean()
        .optional()
        .describe("Apply the top-level values to every regular track (top-most only, see description)"),
      exclude: z
        .array(z.object(trackAddress))
        .optional()
        .describe("With all_tracks: tracks to leave alone, including everything inside an excluded group"),
      items: z
        .array(z.object({ ...mixerTarget, ...mixerValues }))
        .min(1)
        .optional()
        .describe("One entry per mixer, each with its own values"),
    },
    async (args) => {
      const single = args.target_id !== undefined || hasTrackAddress(args);
      const forms = [
        single && "target_id/track_*",
        args.targets && "targets",
        args.all_tracks && "all_tracks",
        args.items && "items",
      ].filter(Boolean);
      if (forms.length !== 1)
        throw new UsageError(
          forms.length
            ? `Choose one way to address mixers, got ${forms.join(" + ")}.`
            : "Provide target_id or track_id/track_index/track_name, targets, all_tracks, or items.",
        );
      if (args.exclude && !args.all_tracks) throw new UsageError("exclude only applies with all_tracks.");
      const hasValues = given(args, Object.keys(mixerValues));
      if (args.items && hasValues)
        throw new UsageError("With items, give volume/panning/sends in each entry instead.");
      if (!args.items && !hasValues)
        throw new UsageError("Nothing to set — provide volume, panning, and/or sends.");

      // Validate every target before the first write.
      type Plan = { mixer: AnyMixer; owner: DataModelObject<"1.0.0">; writes: Array<() => Promise<void>> };
      let plan: Plan[];
      let skipped: ReturnType<typeof topmostTracks>["skipped"] | undefined;
      if (args.items) {
        plan = args.items.map((it, i) =>
          at(`items[${i}]`, () => {
            const { mixer, owner } = findMixer(it);
            return { mixer, owner, writes: mixerWrites(mixer, it) };
          }),
        );
      } else if (args.targets) {
        plan = args.targets.map((t, i) =>
          at(`targets[${i}]`, () => {
            const { mixer, owner } = findMixer(t);
            return { mixer, owner, writes: mixerWrites(mixer, args) };
          }),
        );
      } else if (args.all_tracks) {
        const sel = topmostTracks(args.exclude ?? []);
        skipped = sel.skipped;
        plan = sel.selected.map((track) =>
          at(() => `track ${describeTrack(track)}`, () => ({
            mixer: track.mixer,
            owner: track,
            writes: mixerWrites(track.mixer, args),
          })),
        );
      } else {
        const { mixer, owner } = findMixer(args);
        plan = [{ mixer, owner, writes: mixerWrites(mixer, args) }];
      }
      const writes = plan.flatMap((p) => p.writes);
      if (writes.length) await context.withinTransaction(() => Promise.all(writes.map((w) => w())));
      if (single) return await mixerDetail(plan[0].mixer);
      return {
        items: await Promise.all(
          plan.map(async ({ mixer, owner }) => ({
            target_id: remember(owner),
            name: owner instanceof Track ? owner.name : undefined,
            ...(await mixerDetail(mixer)),
          })),
        ),
        skipped,
      };
    },
  );

  // -- resources / files -----------------------------------------------------

  tool(
    "import_file",
    { title: "Import file into project", annotations: CREATE },
    "Copy a file into the Live project folder so Live manages it. Returns the " +
      "imported path — use that path (not the original) in subsequent calls.",
    { file_path: z.string() },
    async ({ file_path }) => ({
      imported_path: await context.resources.importIntoProject(file_path),
    }),
  );

  tool(
    "render_track_audio",
    { title: "Render track audio", annotations: READ },
    "Render the pre-FX audio of an audio track between two arrangement beat " +
      "positions and return the path of the WAV file. Pre-FX means the track's " +
      "clip audio before its device chain (no effects, mixer or sends). Since " +
      "Live 12.4.15 the render is not normalized, so its levels are meaningful. " +
      "The file is written to the extension's temp directory, which may be " +
      "cleaned between sessions: pass it to import_file (or clip_create, which " +
      "imports by default) to keep it. Audio tracks only, addressed by track_id, " +
      "track_index or track_name.",
    { ...trackAddress, start_time: z.number(), end_time: z.number() },
    async ({ start_time, end_time, ...address }) => {
      const track = findTrack(address);
      if (!(track instanceof AudioTrack))
        throw new UsageError(
          `Only audio tracks can be rendered; ${describeTrack(track)} is a ${classOf(track)}.`,
        );
      return { audio_path: await context.resources.renderPreFxAudio(track, start_time, end_time) };
    },
  );

  // -- the user's selection (captured through context menus) ----------------

  const HOW_TO_SELECT =
    'In Live, the user right-clicks a clip, clip slot, track, scene, Drum Rack, Simpler or sample — or a ' +
    "selection of clip slots, or a time selection in the arrangement — and chooses \"MCP: Use as selection\".";

  // A captured object as selection_get reports it: its summary and location.
  function describeCaptured(obj: DataModelObject<"1.0.0">): Record<string, unknown> {
    const location = locate(obj);
    if (obj instanceof Clip) return { ...clipSummary(obj), location };
    if (obj instanceof ClipSlot) {
      const clip = obj.clip;
      return { id: remember(obj), class: "ClipSlot", clip: clip ? clipSummary(clip) : null, location };
    }
    if (obj instanceof Track) return { class: classOf(obj), ...summarizeTrack(obj), location };
    if (obj instanceof Scene) return { class: "Scene", ...sceneSummary(obj, indexIn(song().scenes, obj)) };
    if (obj instanceof Sample) return { id: remember(obj), class: "Sample", file_path: obj.filePath, location };
    if (obj instanceof Device) return { ...deviceSummary(obj), location };
    if (obj instanceof Chain) return { ...chainSummary(obj), location };
    if (obj instanceof TakeLane) return { id: remember(obj), class: "TakeLane", name: obj.name, location };
    return { id: remember(obj), class: classOf(obj), location };
  }

  // A lane of an arrangement selection (a track or take lane, as assumed: the
  // SDK only says "lanes") with its clips that overlap the time selection.
  function describeLane(obj: DataModelObject<"1.0.0">, time: Selection["time"]): Record<string, unknown> {
    const base = { id: remember(obj), class: classOf(obj) };
    let clips: Clip<"1.0.0">[];
    let described: Record<string, unknown>;
    if (obj instanceof Track) {
      clips = obj.arrangementClips;
      described = { ...base, name: obj.name, location: trackRef(obj) };
    } else if (obj instanceof TakeLane) {
      clips = obj.clips;
      described = { ...base, name: obj.name, location: laneLocation(obj) };
    } else {
      return { ...base, location: locate(obj), error: "not a track or take lane, so no clips are listed" };
    }
    const hits = time ? clipsInRange(clips, time.start, time.end) : clips;
    return { ...described, clips: hits.map((c) => clipSummary(c)) };
  }

  // A capture as selection_get / selection_wait return it. Objects are
  // described now, not at capture time, so the result is current; one that
  // was deleted since reports an error instead.
  function describeSelection(sel: Selection) {
    const item = (c: Selection["objects"][number], describe: (o: DataModelObject<"1.0.0">) => Record<string, unknown>) => {
      if ("error" in c) return { error: c.error };
      try {
        return describe(c.object);
      } catch (e) {
        return {
          id: c.id,
          class: classOf(c.object),
          error: `${errorMessage(e)} (was it deleted or moved since it was captured?)`,
        };
      }
    };
    const time = sel.time;
    return {
      captured: true,
      seq: sel.seq,
      captured_at: new Date(sel.capturedAt).toISOString(),
      age_s: Math.round((Date.now() - sel.capturedAt) / 100) / 10,
      scope: sel.scope,
      kind: sel.kind,
      problems: sel.problems,
      ...(sel.kind === "arrangement"
        ? {
            time_selection: time && { start_time: time.start, end_time: time.end, length: time.end - time.start },
            lanes: sel.objects.map((c) => item(c, (o) => describeLane(o, time))),
          }
        : { items: sel.objects.map((c) => item(c, describeCaptured)) }),
    };
  }

  const SELECTION_RESULT =
    "`seq` (increases with every capture), `captured_at`, `age_s`, the menu `scope`, `kind` and: for a " +
    "clicked object (kind 'object') or a clip-slot selection ('clip_slots'), `items` — each with its id " +
    "(usable in every other tool), a summary and its `location` (track, scene index or take lane, device " +
    "path); for an arrangement time selection ('arrangement'), `time_selection` {start_time, end_time, " +
    "length} in beats and `lanes`, each selected track or take lane with its clips overlapping the time " +
    "selection. An object Live could not resolve, or that was deleted since, carries `error`.";

  tool(
    "selection_get",
    { title: "Get the user's selection", annotations: READ },
    "Get what the user last handed over from Live with the context-menu entry \"MCP: Use as " +
      "selection\": Live's API has no selection getter, so this is how \"quantize this\", " +
      "\"these slots\" or \"the selected range\" become ids. " +
      HOW_TO_SELECT +
      " Returns " +
      SELECTION_RESULT +
      " Check age_s: an old capture may not be what the user means now. Nothing captured yet: " +
      "captured false, seq 0. To wait for the user to choose, use selection_wait.",
    {},
    () => {
      const sel = selections.latest();
      return sel ? describeSelection(sel) : { captured: false, seq: 0, hint: HOW_TO_SELECT };
    },
  );

  tool(
    "selection_wait",
    { title: "Wait for the user's selection", annotations: READ },
    "Wait until the user hands over a selection from Live (" +
      HOW_TO_SELECT +
      ") and return it as selection_get does: " +
      SELECTION_RESULT +
      " Tell the user what to select and to choose \"MCP: Use as selection\" first, then call " +
      "this. It returns as soon as there is a capture newer than `after_seq` (default: the latest " +
      "capture when the call starts), or after timeout_s seconds with timed_out: true — then ask " +
      "again or call it again. Keep timeout_s under the client's request timeout (often 60 s).",
    {
      timeout_s: z
        .number()
        .min(1)
        .max(55)
        .default(50)
        .describe("Seconds to wait, 1-55"),
      after_seq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Return as soon as the latest capture's seq is higher than this (a seq from selection_get), " +
            "also for a capture made before this call; default: the latest seq now",
        ),
    },
    async ({ timeout_s, after_seq }, extra) => {
      // a seq that was never handed out would hide every capture until the timeout
      const after = Math.min(after_seq ?? Infinity, selections.latestSeq);
      const sel = await selections.wait(after, timeout_s * 1000, extra.signal);
      if (sel) return describeSelection(sel);
      return {
        captured: selections.latestSeq > 0,
        timed_out: true,
        seq: selections.latestSeq,
        hint: `No new selection within ${timeout_s} s. ${HOW_TO_SELECT}`,
      };
    },
  );

  // -- ui / commands ---------------------------------------------------------

  tool(
    "show_dialog",
    { title: "Show dialog in Live", annotations: DIALOG },
    "Show a modal HTML dialog inside Ableton Live and wait for the user to close " +
      "it. The HTML can return a result by posting " +
      "{method:'close_and_send', params:[resultString]} to " +
      "window.webkit.messageHandlers.live (macOS) or window.chrome.webview " +
      "(Windows). Useful to ask the user something or show a report. Blocks until " +
      "closed. Dialogs keep no state between calls: each one starts from the " +
      "given HTML, so include everything it needs.",
    {
      html: z.string(),
      width: z.number().int().min(100).max(2000).default(480),
      height: z.number().int().min(80).max(1500).default(360),
    },
    async ({ html, width, height }) => ({
      result: await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(html)}`,
        width,
        height,
      ),
    }),
  );

  tool(
    "execute_command",
    { title: "Execute host command", annotations: COMMAND },
    "Invoke a command registered with the Extension Host by its string id. " +
      "This extension registers 'ableton-live-mcp.status' (shows a status dialog " +
      "in Live). Commands registered by other extensions can also be invoked if " +
      "their id is known.",
    { command_id: z.string(), args: z.array(z.unknown()).optional() },
    ({ command_id, args }) => {
      context.commands.executeCommand(command_id, ...(args ?? []));
      return { executed: command_id };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// http server (stateless streamable-http MCP endpoint)

function readConfig(context: Ctx): { port: number; file?: string } {
  const dir = context.environment.storageDirectory;
  const fallback = { port: DEFAULT_PORT };
  if (!dir) return fallback;
  const file = path.join(dir, "config.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const port = (parsed as { port?: unknown }).port;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { port, file };
    }
    console.error(`[ableton-live-mcp] invalid port in ${file}, using ${DEFAULT_PORT}`);
    return { ...fallback, file };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      // exists but unreadable/malformed — leave the user's file alone
      console.error(`[ableton-live-mcp] could not read ${file}, using defaults:`, e);
      return { ...fallback, file };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    } catch {
      // storage dir not writable — run with defaults
    }
    return { ...fallback, file };
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

// DNS-rebinding protection (the Streamable HTTP spec requires servers to
// validate Origin). A web page whose domain rebinds to 127.0.0.1 reaches this
// port, but the browser still sends the page's Host and, on cross-origin
// requests, its Origin. Accept only a loopback Host (any port) and, when an
// Origin is sent, only an http(s) loopback one; "null" is refused too.
// Returns why the request is refused, or undefined to let it through.
function foreignRequestReason(req: http.IncomingMessage): string | undefined {
  const isLoopback = (url: string, schemes: string[]) => {
    try {
      const u = new URL(url);
      return schemes.includes(u.protocol) && LOOPBACK_HOSTNAMES.has(u.hostname);
    } catch {
      return false;
    }
  };
  const host = req.headers.host;
  if (!host) return "missing Host header";
  if (!isLoopback(`http://${host}`, ["http:"])) return `invalid Host header: ${host}`;
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopback(origin, ["http:", "https:"]))
    return `invalid Origin header: ${origin}`;
  return undefined;
}

function sendJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type ServerState =
  | { kind: "starting" }
  | { kind: "listening" }
  | { kind: "failed"; error: string; code?: string };

// In-Live status dialog, reachable from track context menus. Registered before
// listen so that a failed start (e.g. EADDRINUSE) can be seen from inside Live.
function registerStatus(
  context: Ctx,
  port: number,
  configFile: string | undefined,
  state: () => ServerState,
) {
  const statusHtml = () => {
    const s = state();
    const config = configFile
      ? `<code>${escapeHtml(configFile)}</code>`
      : "the extension's config.json (no storage directory available)";
    const body =
      s.kind === "listening"
        ? `<p>MCP endpoint: <code>http://127.0.0.1:${port}/mcp</code></p>` +
          `<p>Add it to an MCP client as a streamable-http server.</p>` +
          `<p style="font-size:smaller">Port set in ${config}</p>`
        : s.kind === "failed"
          ? `<p style="color:#ff8a80">The MCP server is not running: <code>${escapeHtml(s.error)}</code></p>` +
            (s.code === "EADDRINUSE"
              ? `<p>Port ${port} is already in use by another program.</p>`
              : "") +
            `<p>Set another <code>"port"</code> in ${config}, then restart Live.</p>`
          : `<p>The MCP server is starting on port ${port}...</p>`;
    return (
      // charset: the config path or error text may be non-ASCII
      `<!doctype html><meta charset="utf-8">` +
      `<body style="font-family:sans-serif;background:#363636;color:#b5b5b5;padding:16px">` +
      `<h3 style="margin-top:0;color:#fff">Ableton Live MCP</h3>` +
      body +
      `<button onclick="(window.webkit?.messageHandlers?.live??window.chrome?.webview).postMessage({method:'close_and_send',params:['ok']})">Close</button>` +
      `</body>`
    );
  };
  context.commands.registerCommand("ableton-live-mcp.status", () => {
    context.ui
      .showModalDialog(`data:text/html,${encodeURIComponent(statusHtml())}`, 480, 280)
      .catch((e) => console.error("[ableton-live-mcp] status dialog:", e));
  });
  for (const scope of ["AudioTrack", "MidiTrack"] as const) {
    context.ui
      .registerContextMenuAction(scope, "Ableton Live MCP: Status", "ableton-live-mcp.status")
      .catch((e: unknown) => console.error(`[ableton-live-mcp] could not add the ${scope} status entry:`, e));
  }
}

export async function startServer(context: Ctx, hostApiVersion: string): Promise<void> {
  const { port, file: configFile } = readConfig(context);
  let state: ServerState = { kind: "starting" };
  try {
    registerStatus(context, port, configFile, () => state);
  } catch (e) {
    // a convenience only: never let it keep the endpoint from starting
    console.error("[ableton-live-mcp] could not register the status command:", e);
  }
  // The user's selection arrives through context-menu commands; captures
  // outlive the per-request McpServer, so the store lives here.
  const selections = new SelectionStore(context);
  try {
    registerSelectionMenus(context, selections);
  } catch (e) {
    console.error("[ableton-live-mcp] could not register the selection menu entries:", e);
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      // Before routing, so a rebinding page can't even probe /health.
      const refused = foreignRequestReason(req);
      if (refused) {
        console.error(`[ableton-live-mcp] refused request: ${refused}`);
        sendJsonRpcError(res, 403, -32000, `Forbidden: ${refused}`);
        return;
      }
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...SERVER_INFO }));
        return;
      }
      if (pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found. MCP endpoint: POST /mcp");
        return;
      }
      if (req.method !== "POST") {
        // Stateless server: no standalone SSE stream to GET, no session to DELETE.
        // Clients treat 405 on GET as "no server-initiated stream".
        sendJsonRpcError(res, 405, -32000, "Method not allowed. MCP endpoint: POST /mcp", {
          allow: "POST",
        });
        return;
      }
      if (Number(req.headers["content-length"]) > 16_000_000) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Payload too large");
        return;
      }
      // Stateless mode: a fresh server+transport per request. Object ids live in
      // the module-level store, so state survives across requests regardless.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = buildServer(context, hostApiVersion, port, selections);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      // No pre-parsed body: the transport reads the stream itself and answers
      // spec-correct 400/-32700 (parse error), 406, and 415 responses.
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error("[ableton-live-mcp] request error:", e);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  try {
    await new Promise<void>((res, rej) => {
      httpServer.once("error", rej);
      httpServer.listen(port, "127.0.0.1", () => {
        httpServer.off("error", rej);
        res();
      });
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    state = { kind: "failed", error: err?.message ?? String(e), code: err?.code };
    throw e;
  }
  state = { kind: "listening" };
  // Keep a persistent handler so a later server 'error' (e.g. EMFILE on
  // accept) is logged instead of crashing the host.
  httpServer.on("error", (e) => console.error("[ableton-live-mcp] server error:", e));
  console.log(`[ableton-live-mcp] MCP server listening on http://127.0.0.1:${port}/mcp`);
}
