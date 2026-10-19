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
import { remember, resolve } from "./store.js";
import {
  chainSummary,
  classOf,
  num,
  clipSlotSummary,
  clipSummary,
  colorToHex,
  cuePointSummary,
  deviceSummary,
  gridName,
  hexToColor,
  parameterSummary,
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

const noteShape = {
  pitch: z.number().int().min(0).max(127).describe("MIDI pitch, 0-127"),
  start_time: z.number().describe("Start in beats, relative to clip start"),
  duration: z.number().positive().describe("Length in beats"),
  velocity: z.number().min(0).max(127).optional(),
  muted: z.boolean().optional(),
  probability: z.number().min(0).max(1).optional().describe("Play probability, 0-1"),
  velocity_deviation: z.number().optional(),
  release_velocity: z.number().min(0).max(127).optional(),
};

function toNoteDescription(n: {
  pitch: number;
  start_time: number;
  duration: number;
  velocity?: number;
  muted?: boolean;
  probability?: number;
  velocity_deviation?: number;
  release_velocity?: number;
}): NoteDescription {
  return {
    pitch: n.pitch,
    startTime: n.start_time,
    duration: n.duration,
    velocity: n.velocity,
    muted: n.muted,
    probability: n.probability,
    velocityDeviation: n.velocity_deviation,
    releaseVelocity: n.release_velocity,
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
  z
    .object({ pad: z.number().int().min(0).max(127).describe("Drum Rack pad: the chain's receiving MIDI note") })
    .strict(),
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
type ChainStep = { chain: number } | { pad: number };
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

function buildServer(context: Ctx, hostApiVersion: string, port: number): McpServer {
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

  tool(
    "song_get",
    { title: "Get Live Set", annotations: READ },
    "Get the state of the current Live Set: tempo, scale, grid, all tracks " +
      "(with ids), return tracks, main track, scenes, cue points, and extension " +
      "environment info. This is the entry point — object ids returned here are " +
      "used by every other tool. Times are in beats throughout the API. Use " +
      "`include` to fetch only some sections (tempo/grid/scale always included).",
    {
      include: z
        .array(z.enum(["tracks", "scenes", "cue_points", "environment"]))
        .optional()
        .describe("Sections to include; omit for everything"),
    },
    ({ include }) => {
      const s = song();
      const want = (k: string) => !include || include.includes(k as never);
      return {
        tempo: num(s.tempo),
        grid: { quantization: gridName(s.gridQuantization), is_triplet: s.gridIsTriplet },
        scale: {
          root_note: num(s.rootNote),
          name: s.scaleName,
          mode_enabled: s.scaleMode,
          intervals: s.scaleIntervals.map(num),
        },
        tracks: want("tracks") ? s.tracks.map((t) => trackSummary(t)) : undefined,
        return_tracks: want("tracks") ? s.returnTracks.map((t) => trackSummary(t, "return")) : undefined,
        main_track: want("tracks") ? trackSummary(s.mainTrack, "main") : undefined,
        scenes: want("scenes") ? s.scenes.map(sceneSummary) : undefined,
        cue_points: want("cue_points") ? s.cuePoints.map(cuePointSummary) : undefined,
        environment: want("environment")
          ? {
              storage_directory: context.environment.storageDirectory,
              temp_directory: context.environment.tempDirectory,
              language: context.environment.language,
              host_api_version: hostApiVersion,
              mcp_port: port,
            }
          : undefined,
      };
    },
  );

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
    const notes = chains.map((c) => (c instanceof DrumChain ? num(c.receivingNote) : undefined));
    const hits = notes.flatMap((n, i) => (n === step.pad ? [i] : []));
    if (hits.length === 1) return { chain: chains[hits[0]], label: `pad ${step.pad}` };
    if (hits.length)
      throw new UsageError(
        `Ambiguous pad ${step.pad} in ${describeDevice(rack)}: chains ${hits.join(", ")} all receive ` +
          `note ${step.pad}. Use {chain: index}.`,
      );
    const pads = [...new Set(notes.filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
    throw new UsageError(
      `No pad receives note ${step.pad} in ${describeDevice(rack)} (pads: ${pads.join(", ") || "none"}).`,
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
      "with current values). Works for regular, return, and main tracks. Address " +
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
        ...trackSummary(track),
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
      const out = plan.map(({ track }) => trackSummary(track));
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
    async (args) => trackSummary(await song().duplicateTrack(findTrack(args))),
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

  // -- clips -----------------------------------------------------------------

  tool(
    "clip_create",
    { title: "Create clip", annotations: CREATE },
    "Create a MIDI or audio clip. Target: a clip slot id (session view), a track " +
      "(target_id, or track_id/track_index/track_name; arrangement — MidiTrack for " +
      "midi, AudioTrack for audio; requires start_time — OR the session slot of a " +
      "scene when scene_index/scene_id/scene_name is given), or a take lane id " +
      "(requires start_time). MIDI clips require duration and can be created with " +
      "their notes inline (file_path, is_warped and loop_settings are rejected). " +
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
        if (args.notes?.length) clip.notes = args.notes.map(toNoteDescription);
        return finish(clip);
      }

      need(args.file_path, "file_path");
      // Validate the target before importing so a bad target doesn't leave an
      // orphan copy in the project folder.
      if (!(target instanceof ClipSlot) && !(target instanceof AudioTrack) && !(target instanceof TakeLane))
        throw new UsageError(
          `Audio clips need a ClipSlot, AudioTrack, or TakeLane target, got ${classOf(target)}.`,
        );
      if (args.notes) throw new UsageError("notes only apply to MIDI clips.");
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
      "and warp markers). Use midi_clip_get_notes for the actual notes.",
    { clip_id: z.string() },
    ({ clip_id }) => clipSummary(resolve(clip_id, Clip), true),
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

  tool(
    "midi_clip_get_notes",
    { title: "Get MIDI notes", annotations: READ },
    "Get all MIDI notes of a clip. Times/durations in beats relative to clip start.",
    { clip_id: z.string() },
    ({ clip_id }) => {
      const notes = resolve(clip_id, MidiClip).notes;
      return {
        note_count: notes.length,
        notes: notes.map((n) => ({
          pitch: num(n.pitch),
          start_time: num(n.startTime),
          duration: num(n.duration),
          velocity: n.velocity === undefined ? undefined : num(n.velocity),
          muted: n.muted,
          probability: n.probability === undefined ? undefined : num(n.probability),
          velocity_deviation: n.velocityDeviation === undefined ? undefined : num(n.velocityDeviation),
          release_velocity: n.releaseVelocity === undefined ? undefined : num(n.releaseVelocity),
        })),
      };
    },
  );

  tool(
    "midi_clip_set_notes",
    { title: "Write MIDI notes", annotations: DESTRUCTIVE_CUMULATIVE },
    "Write notes to a MIDI clip. mode 'replace' (default) replaces ALL notes; " +
      "mode 'merge' adds the given notes on top of the existing ones (layering " +
      "without re-sending the current content). For mechanical edits of existing " +
      "notes (transpose, shift, quantize, ...) prefer midi_clip_edit_notes.",
    {
      clip_id: z.string(),
      notes: z.array(z.object(noteShape)),
      mode: z.enum(["replace", "merge"]).default("replace"),
    },
    ({ clip_id, notes, mode }) => {
      const clip = resolve(clip_id, MidiClip);
      const incoming = notes.map(toNoteDescription);
      clip.notes = mode === "merge" ? [...clip.notes, ...incoming] : incoming;
      return { note_count: mode === "merge" ? undefined : notes.length, added: mode === "merge" ? notes.length : undefined };
    },
  );

  tool(
    "midi_clip_edit_notes",
    { title: "Edit MIDI notes", annotations: DESTRUCTIVE_CUMULATIVE },
    "Transform existing notes of a MIDI clip server-side — no need to read and " +
      "rewrite the note list. Optional `select` restricts which notes are " +
      "affected (by pitch/time range); others pass through untouched. Transforms " +
      "(applied in this order): transpose (semitones), time_shift (beats), " +
      "velocity_scale, velocity_offset, quantize (snap start times to a beat " +
      "grid, strength 0-1), or delete=true to remove the selected notes. " +
      "Results are clamped to valid MIDI ranges.",
    {
      clip_id: z.string(),
      select: z
        .object({
          pitch_min: z.number().int().min(0).max(127).optional(),
          pitch_max: z.number().int().min(0).max(127).optional(),
          time_min: z.number().optional(),
          time_max: z.number().optional(),
        })
        .optional(),
      transpose: z.number().int().optional().describe("Semitones, negative = down"),
      time_shift: z.number().optional().describe("Beats, negative = earlier"),
      velocity_scale: z.number().min(0).optional(),
      velocity_offset: z.number().optional(),
      quantize: z
        .object({ grid: z.number().positive().describe("Grid in beats, e.g. 0.25 = 1/16"), strength: z.number().min(0).max(1).default(1) })
        .optional(),
      delete: z.boolean().optional().describe("Delete the selected notes instead of transforming"),
    },
    (args) => {
      const clip = resolve(args.clip_id, MidiClip);
      const sel = args.select ?? {};
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const selected = (n: NoteDescription) =>
        (sel.pitch_min === undefined || num(n.pitch) >= sel.pitch_min) &&
        (sel.pitch_max === undefined || num(n.pitch) <= sel.pitch_max) &&
        (sel.time_min === undefined || num(n.startTime) >= sel.time_min) &&
        (sel.time_max === undefined || num(n.startTime) <= sel.time_max);
      let changed = 0;
      const out: NoteDescription[] = [];
      for (const n of clip.notes) {
        if (!selected(n)) {
          out.push(n);
          continue;
        }
        if (args.delete) {
          changed++;
          continue;
        }
        const t = { ...n, pitch: num(n.pitch), startTime: num(n.startTime) };
        if (args.transpose) t.pitch = clamp(t.pitch + args.transpose, 0, 127);
        if (args.time_shift) t.startTime = Math.max(0, t.startTime + args.time_shift);
        if (args.velocity_scale !== undefined || args.velocity_offset !== undefined) {
          const v = num(t.velocity ?? 100) * (args.velocity_scale ?? 1) + (args.velocity_offset ?? 0);
          t.velocity = clamp(v, 1, 127);
        }
        if (args.quantize) {
          const snapped = Math.round(t.startTime / args.quantize.grid) * args.quantize.grid;
          t.startTime = t.startTime + (snapped - t.startTime) * args.quantize.strength;
        }
        changed++;
        out.push(t);
      }
      clip.notes = out;
      return { note_count: out.length, changed_count: changed };
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
      "a whole drum kit pad→note→sample in one call).",
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
      "values). Drum chains also report their receiving note.",
    { chain_id: z.string() },
    async ({ chain_id }) => {
      const chain = resolve(chain_id, Chain);
      return {
        ...chainSummary(chain),
        devices: chain.devices.map(deviceSummary),
        mixer: await mixerDetail(chain.mixer),
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
    "Set the MIDI note a drum rack chain (pad) responds to.",
    {
      drum_chain_id: z.string(),
      receiving_note: z.number().int().min(0).max(127),
    },
    ({ drum_chain_id, receiving_note }) => {
      const chain = resolve(drum_chain_id, DrumChain);
      chain.receivingNote = receiving_note;
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
    void context.ui.registerContextMenuAction(
      scope,
      "Ableton Live MCP: Status",
      "ableton-live-mcp.status",
    );
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
      const mcp = buildServer(context, hostApiVersion, port);
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
