import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { z, type ZodRawShape } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

const DEFAULT_PORT = 8722;
const SERVER_INFO = { name: "ableton-live", version: "1.0.0" };

const WARP_MODES = ["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"] as const;

// ---------------------------------------------------------------------------
// helpers

function json(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

const STALE_HINT =
  "If this object was deleted or moved, or the Live Set changed, its id is stale — re-fetch ids via song_get / track_get.";

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

// ---------------------------------------------------------------------------
// tool registration

function buildServer(context: Ctx, hostApiVersion: string, port: number): McpServer {
  const server = new McpServer(SERVER_INFO);
  const song = () => context.application.song;

  function tool<S extends ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown> | unknown,
  ) {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: never) => {
      try {
        return json(await handler(args));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}\n${STALE_HINT}` }],
          isError: true,
        };
      }
    }) as never);
  }

  // -- song ------------------------------------------------------------------

  tool(
    "song_get",
    "Get the full state of the current Live Set: tempo, scale, grid, all tracks " +
      "(with ids), return tracks, main track, scenes, cue points, and extension " +
      "environment info. This is the entry point — object ids returned here are " +
      "used by every other tool. Times are in beats throughout the API.",
    {},
    () => {
      const s = song();
      return {
        tempo: num(s.tempo),
        grid: { quantization: gridName(s.gridQuantization), is_triplet: s.gridIsTriplet },
        scale: {
          root_note: num(s.rootNote),
          name: s.scaleName,
          mode_enabled: s.scaleMode,
          intervals: s.scaleIntervals.map(num),
        },
        tracks: s.tracks.map((t) => trackSummary(t)),
        return_tracks: s.returnTracks.map((t) => trackSummary(t, "return")),
        main_track: trackSummary(s.mainTrack, "main"),
        scenes: s.scenes.map(sceneSummary),
        cue_points: s.cuePoints.map(cuePointSummary),
        environment: {
          storage_directory: context.environment.storageDirectory,
          temp_directory: context.environment.tempDirectory,
          language: context.environment.language,
          host_api_version: hostApiVersion,
          mcp_port: port,
        },
      };
    },
  );

  tool(
    "song_set",
    "Set song-level properties of the Live Set.",
    { tempo: z.number().min(20).max(999).optional().describe("Tempo in BPM") },
    ({ tempo }) => {
      if (tempo !== undefined) song().tempo = tempo;
      return { tempo: num(song().tempo) };
    },
  );

  // -- tracks ----------------------------------------------------------------

  tool(
    "track_get",
    "Get full detail for one track: properties, clip slots (session view, with " +
      "clips), take lanes, arrangement clips, devices, and mixer (volume/pan/sends " +
      "with current values). Works for regular, return, and main tracks.",
    { track_id: z.string() },
    async ({ track_id }) => {
      const track = resolve(track_id, Track);
      const mixer = track.mixer;
      const returnNames = song().returnTracks.map((t) => t.name);
      const [volume, panning, sends] = await Promise.all([
        parameterWithValue(mixer.volume),
        parameterWithValue(mixer.panning),
        Promise.all(mixer.sends.map(parameterWithValue)),
      ]);
      return {
        ...trackSummary(track),
        clip_slots: track.clipSlots.map(clipSlotSummary),
        take_lanes: track.takeLanes.map(takeLaneSummary),
        arrangement_clips: track.arrangementClips.map(clipSummary),
        devices: track.devices.map(deviceSummary),
        mixer: {
          id: remember(mixer),
          volume,
          panning,
          sends: sends.map((s, i) => ({ ...s, return_track: returnNames[i] })),
        },
      };
    },
  );

  tool(
    "track_set",
    "Set track properties (name, mute, solo, arm).",
    {
      track_id: z.string(),
      name: z.string().optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      arm: z.boolean().optional(),
    },
    ({ track_id, name, mute, solo, arm }) => {
      const track = resolve(track_id, Track);
      if (name !== undefined) track.name = name;
      if (mute !== undefined) track.mute = mute;
      if (solo !== undefined) track.solo = solo;
      if (arm !== undefined) track.arm = arm;
      return trackSummary(track);
    },
  );

  tool(
    "track_create",
    "Create a new audio or MIDI track. Inserted after the last selected track, " +
      "or appended if none is selected.",
    { type: z.enum(["audio", "midi"]) },
    async ({ type }) => {
      const track =
        type === "audio" ? await song().createAudioTrack() : await song().createMidiTrack();
      return trackSummary(track);
    },
  );

  tool("track_delete", "Delete a track.", { track_id: z.string() }, async ({ track_id }) => {
    await song().deleteTrack(resolve(track_id, Track));
    return { deleted: track_id };
  });

  tool(
    "track_duplicate",
    "Duplicate a track. The copy is inserted right after the original.",
    { track_id: z.string() },
    async ({ track_id }) => trackSummary(await song().duplicateTrack(resolve(track_id, Track))),
  );

  tool(
    "track_clear_clips_in_range",
    "Delete all arrangement clips of a track within a beat range. Clips " +
      "overlapping a boundary are truncated to the range edge.",
    { track_id: z.string(), start_time: z.number(), end_time: z.number() },
    async ({ track_id, start_time, end_time }) => {
      await resolve(track_id, Track).clearClipsInRange(start_time, end_time);
      return { cleared: [start_time, end_time] };
    },
  );

  tool(
    "take_lane_create",
    "Create a new take lane on a track (appended after existing lanes).",
    { track_id: z.string() },
    async ({ track_id }) => takeLaneSummary(await resolve(track_id, Track).createTakeLane()),
  );

  tool(
    "take_lane_set",
    "Rename a take lane.",
    { take_lane_id: z.string(), name: z.string() },
    ({ take_lane_id, name }) => {
      const lane = resolve(take_lane_id, TakeLane);
      lane.name = name;
      return takeLaneSummary(lane);
    },
  );

  // -- scenes / cue points ---------------------------------------------------

  tool(
    "scene_create",
    "Create a scene at the given index (0-based). Pass -1 to append at the end.",
    { index: z.number().int().min(-1) },
    async ({ index }) => {
      const scene = await song().createScene(index);
      return sceneSummary(scene, song().scenes.findIndex((s) => s.handle.id === scene.handle.id));
    },
  );

  tool(
    "scene_set",
    "Rename a scene.",
    { scene_id: z.string(), name: z.string() },
    ({ scene_id, name }) => {
      const scene = resolve(scene_id, Scene);
      scene.name = name;
      return { id: scene_id, name: scene.name };
    },
  );

  tool("scene_delete", "Delete a scene.", { scene_id: z.string() }, async ({ scene_id }) => {
    await song().deleteScene(resolve(scene_id, Scene));
    return { deleted: scene_id };
  });

  tool(
    "scene_duplicate",
    "Duplicate a scene. The copy is inserted right after the original.",
    { scene_id: z.string() },
    async ({ scene_id }) => {
      const scene = await song().duplicateScene(resolve(scene_id, Scene));
      return sceneSummary(scene, song().scenes.findIndex((s) => s.handle.id === scene.handle.id));
    },
  );

  tool(
    "cue_point_create",
    "Create an arrangement cue point (locator) at a beat position.",
    { time: z.number().describe("Position in the arrangement in beats") },
    async ({ time }) => cuePointSummary(await song().createCuePoint(time)),
  );

  tool(
    "cue_point_set",
    "Rename a cue point.",
    { cue_point_id: z.string(), name: z.string() },
    ({ cue_point_id, name }) => {
      const cue = resolve(cue_point_id, CuePoint);
      cue.name = name;
      return cuePointSummary(cue);
    },
  );

  tool(
    "cue_point_delete",
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
    "Create a MIDI or audio clip. Target is one of: a clip slot id (session view), " +
      "a track id (arrangement — MidiTrack for midi, AudioTrack for audio; requires " +
      "start_time), or a take lane id (requires start_time). MIDI clips require " +
      "duration. Audio clips require file_path (absolute path to an audio file); by " +
      "default the file is first imported into the Live project (recommended).",
    {
      type: z.enum(["midi", "audio"]),
      target_id: z.string().describe("ClipSlot, Track, or TakeLane id"),
      start_time: z.number().optional().describe("Arrangement position in beats (track/take-lane targets)"),
      duration: z.number().positive().optional().describe("Clip length in beats"),
      file_path: z.string().optional().describe("Audio file path (audio clips only)"),
      is_warped: z.boolean().optional().describe("Audio only. Required when loop_settings is set"),
      loop_settings: loopSettingsShape.optional(),
      import_into_project: z
        .boolean()
        .default(true)
        .describe("Audio only: copy the file into the Live project first"),
    },
    async (args) => {
      const target = resolve(args.target_id, DataModelObject);
      const need = (cond: unknown, what: string) => {
        if (cond === undefined || cond === null) throw new Error(`${what} is required for this target/type.`);
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
          throw new Error(
            `MIDI clips need a ClipSlot, MidiTrack, or TakeLane target, got ${classOf(target)}.`,
          );
        }
        return clipSummary(clip);
      }

      need(args.file_path, "file_path");
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
      } else if (target instanceof AudioTrack || target instanceof TakeLane) {
        need(args.start_time, "start_time");
        clip = await target.createAudioClip({
          filePath,
          startTime: args.start_time!,
          duration: args.duration,
          isWarped: args.is_warped,
          loopSettings,
        });
      } else {
        throw new Error(
          `Audio clips need a ClipSlot, AudioTrack, or TakeLane target, got ${classOf(target)}.`,
        );
      }
      return { ...clipSummary(clip), imported_path: args.import_into_project ? filePath : undefined };
    },
  );

  tool(
    "clip_get",
    "Get full detail for one clip (MIDI: note count; audio: file, warp settings " +
      "and warp markers). Use midi_clip_get_notes for the actual notes.",
    { clip_id: z.string() },
    ({ clip_id }) => clipSummary(resolve(clip_id, Clip)),
  );

  tool(
    "clip_set",
    "Set clip properties. color is '#RRGGBB'. warping/warp_mode apply to audio " +
      "clips only. Note: enabling looping on an unwarped audio clip enables warping.",
    {
      clip_id: z.string(),
      name: z.string().optional(),
      color: z.string().optional(),
      muted: z.boolean().optional(),
      looping: z.boolean().optional(),
      warping: z.boolean().optional(),
      warp_mode: z.enum(WARP_MODES).optional(),
    },
    ({ clip_id, name, color, muted, looping, warping, warp_mode }) => {
      const clip = resolve(clip_id, Clip);
      // Validate everything before the first setter runs — each setter is its
      // own host transaction, so a late throw would leave partial changes.
      const parsedColor = color !== undefined ? hexToColor(color) : undefined;
      if ((warping !== undefined || warp_mode !== undefined) && !(clip instanceof AudioClip))
        throw new Error("warping/warp_mode only apply to audio clips.");
      if (name !== undefined) clip.name = name;
      if (parsedColor !== undefined) clip.color = parsedColor;
      if (muted !== undefined) clip.muted = muted;
      if (looping !== undefined) clip.looping = looping;
      if (clip instanceof AudioClip) {
        if (warping !== undefined) clip.warping = warping;
        if (warp_mode !== undefined) clip.warpMode = WarpMode[warp_mode];
      }
      return clipSummary(clip);
    },
  );

  tool(
    "clip_delete",
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
    "Replace ALL notes of a MIDI clip with the given notes. To edit incrementally, " +
      "first read with midi_clip_get_notes, modify, then write back the full list.",
    { clip_id: z.string(), notes: z.array(z.object(noteShape)) },
    ({ clip_id, notes }) => {
      const clip = resolve(clip_id, MidiClip);
      clip.notes = notes.map(
        (n): NoteDescription => ({
          pitch: n.pitch,
          startTime: n.start_time,
          duration: n.duration,
          velocity: n.velocity,
          muted: n.muted,
          probability: n.probability,
          velocityDeviation: n.velocity_deviation,
          releaseVelocity: n.release_velocity,
        }),
      );
      return { note_count: clip.notes.length };
    },
  );

  // -- devices ---------------------------------------------------------------

  tool(
    "device_get",
    "Get full detail for one device: all parameters (with metadata and ids), " +
      "rack chains, drum rack pads, or Simpler sample.",
    { device_id: z.string() },
    ({ device_id }) => {
      const device = resolve(device_id, Device);
      const base = deviceSummary(device);
      return {
        ...base,
        parameters: device.parameters.map(parameterSummary),
        chains: device instanceof RackDevice ? device.chains.map(chainSummary) : undefined,
      };
    },
  );

  tool(
    "device_insert",
    "Insert a built-in Live device (by name, e.g. 'Reverb', 'Auto Filter', 'EQ " +
      "Eight', 'Compressor', 'Simpler', 'Drum Rack', 'Operator', 'Wavetable') into " +
      "a track or rack chain. Third-party plug-ins cannot be loaded. index is the " +
      "0-based position in the device chain; omitted = append at the end.",
    {
      target_id: z.string().describe("Track or Chain id"),
      device_name: z.string(),
      index: z.number().int().min(0).optional(),
    },
    async ({ target_id, device_name, index }) => {
      const target = resolve(target_id, DataModelObject);
      if (!(target instanceof Track) && !(target instanceof Chain))
        throw new Error(`Devices can be inserted into a Track or Chain, got ${classOf(target)}.`);
      const device = await target.insertDevice(device_name, index ?? target.devices.length);
      return deviceSummary(device);
    },
  );

  tool(
    "device_delete",
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

  // -- racks / chains --------------------------------------------------------

  tool(
    "chain_get",
    "Get detail for a rack chain: its devices and mixer (volume/pan/sends with " +
      "values). Drum chains also report their receiving note.",
    { chain_id: z.string() },
    async ({ chain_id }) => {
      const chain = resolve(chain_id, Chain);
      const mixer = chain.mixer;
      const [volume, panning, sends] = await Promise.all([
        parameterWithValue(mixer.volume),
        parameterWithValue(mixer.panning),
        Promise.all(mixer.sends.map(parameterWithValue)),
      ]);
      return {
        ...chainSummary(chain),
        devices: chain.devices.map(deviceSummary),
        mixer: { id: remember(mixer), volume, panning, sends },
      };
    },
  );

  tool(
    "rack_insert_chain",
    "Insert a new chain into a rack device at the given 0-based index.",
    { rack_device_id: z.string(), index: z.number().int().min(0) },
    async ({ rack_device_id, index }) => {
      const rack = resolve(rack_device_id, RackDevice);
      return chainSummary(await rack.insertChain(index));
    },
  );

  tool(
    "drum_chain_set",
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
    "Read current values (and metadata) of one or more device/mixer parameters.",
    { parameter_ids: z.array(z.string()).min(1) },
    async ({ parameter_ids }) =>
      Promise.all(parameter_ids.map((id) => parameterWithValue(resolve(id, DeviceParameter)))),
  );

  tool(
    "parameter_set",
    "Set one or more device/mixer parameter values. Values must be within the " +
      "parameter's [min, max]; quantized parameters take the value_items index. " +
      "Multiple values are grouped into a single undo step.",
    {
      values: z
        .array(z.object({ parameter_id: z.string(), value: z.number() }))
        .min(1),
    },
    async ({ values }) => {
      const params = values.map((v) => ({
        param: resolve(v.parameter_id, DeviceParameter),
        value: v.value,
      }));
      await context.withinTransaction(() =>
        Promise.all(params.map(({ param, value }) => param.setValue(value))),
      );
      return Promise.all(params.map(({ param }) => parameterWithValue(param)));
    },
  );

  tool(
    "mixer_get",
    "Get the mixer of a track or rack chain: volume, panning, and sends with " +
      "current values and parameter ids (settable via parameter_set).",
    { target_id: z.string().describe("Track, Chain, or mixer id") },
    async ({ target_id }) => {
      const target = resolve(target_id, DataModelObject);
      const mixer =
        target instanceof Track
          ? target.mixer
          : target instanceof Chain
            ? target.mixer
            : target instanceof TrackMixer || target instanceof ChainMixer
              ? target
              : null;
      if (!mixer) throw new Error(`Expected a Track, Chain, or mixer id, got ${classOf(target)}.`);
      const returnNames =
        mixer instanceof TrackMixer ? song().returnTracks.map((t) => t.name) : [];
      const [volume, panning, sends] = await Promise.all([
        parameterWithValue(mixer.volume),
        parameterWithValue(mixer.panning),
        Promise.all(mixer.sends.map(parameterWithValue)),
      ]);
      return {
        id: remember(mixer),
        volume,
        panning,
        sends: sends.map((s, i) => ({ ...s, return_track: returnNames[i] })),
      };
    },
  );

  // -- resources / files -----------------------------------------------------

  tool(
    "import_file",
    "Copy a file into the Live project folder so Live manages it. Returns the " +
      "imported path — use that path (not the original) in subsequent calls.",
    { file_path: z.string() },
    async ({ file_path }) => ({
      imported_path: await context.resources.importIntoProject(file_path),
    }),
  );

  tool(
    "render_track_audio",
    "Render the pre-effects audio of an audio track between two arrangement beat " +
      "positions. Returns the path of an audio file (WAV/AIFF) in the extension's " +
      "temp directory.",
    { track_id: z.string(), start_time: z.number(), end_time: z.number() },
    async ({ track_id, start_time, end_time }) => ({
      audio_path: await context.resources.renderPreFxAudio(
        resolve(track_id, AudioTrack),
        start_time,
        end_time,
      ),
    }),
  );

  // -- ui / commands ---------------------------------------------------------

  tool(
    "show_dialog",
    "Show a modal HTML dialog inside Ableton Live and wait for the user to close " +
      "it. The HTML can return a result by posting " +
      "{method:'close_and_send', params:[resultString]} to " +
      "window.webkit.messageHandlers.live (macOS) or window.chrome.webview " +
      "(Windows). Useful to ask the user something or show a report. Blocks until " +
      "closed.",
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

function readConfig(context: Ctx): { port: number } {
  const dir = context.environment.storageDirectory;
  const fallback = { port: DEFAULT_PORT };
  if (!dir) return fallback;
  const file = path.join(dir, "config.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const port = (parsed as { port?: unknown }).port;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { port };
    }
    console.error(`[ableton-live-mcp] invalid port in ${file}, using ${DEFAULT_PORT}`);
    return fallback;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      // exists but unreadable/malformed — leave the user's file alone
      console.error(`[ableton-live-mcp] could not read ${file}, using defaults:`, e);
      return fallback;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    } catch {
      // storage dir not writable — run with defaults
    }
    return fallback;
  }
}

export async function startServer(context: Ctx, hostApiVersion: string): Promise<void> {
  const { port } = readConfig(context);

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...SERVER_INFO }));
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found. MCP endpoint: POST /mcp");
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
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((res, rej) => {
    httpServer.once("error", rej);
    httpServer.listen(port, "127.0.0.1", res);
  });
  // The startup once-handler is spent; keep a persistent one so a later server
  // 'error' (e.g. EMFILE on accept) is logged instead of crashing the host.
  httpServer.on("error", (e) => console.error("[ableton-live-mcp] server error:", e));
  console.log(`[ableton-live-mcp] MCP server listening on http://127.0.0.1:${port}/mcp`);

  // In-Live conveniences, registered only once the endpoint is actually up:
  // a status dialog reachable from track context menus.
  const statusHtml = () =>
    `<!doctype html><body style="font-family:sans-serif;background:#363636;color:#b5b5b5;padding:16px">` +
    `<h3 style="margin-top:0;color:#fff">Ableton Live MCP</h3>` +
    `<p>MCP endpoint: <code>http://127.0.0.1:${port}/mcp</code></p>` +
    `<p>Add it to an MCP client as a streamable-http server.</p>` +
    `<button onclick="(window.webkit?.messageHandlers?.live??window.chrome?.webview).postMessage({method:'close_and_send',params:['ok']})">Close</button>` +
    `</body>`;
  context.commands.registerCommand("ableton-live-mcp.status", () => {
    void context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(statusHtml())}`,
      420,
      220,
    );
  });
  for (const scope of ["AudioTrack", "MidiTrack"] as const) {
    void context.ui.registerContextMenuAction(
      scope,
      "Ableton Live MCP: Status",
      "ableton-live-mcp.status",
    );
  }
}
