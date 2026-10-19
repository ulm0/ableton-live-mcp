---
name: ableton-live
description: Control Ableton Live via the ableton-live MCP server — compose MIDI, arrange tracks, edit clips, tweak devices and mix. Use whenever the user asks to do anything in Ableton Live (create tracks/clips/notes, change tempo, add devices, mix levels, warp audio, render stems).
---

# Ableton Live via MCP

The `ableton-live` MCP server (streamable HTTP, `http://127.0.0.1:8722/mcp`) controls a running
Ableton Live 12. If tools fail to connect: Live is not running, the extension is not installed,
or the port was changed in the extension's `config.json` (default 8722).

## Core workflow

1. **Always start with `song_get`.** It returns the set with object ids. Every other tool
   takes those ids. Pass `include` to fetch only some sections.
2. Drill down with `track_get` / `device_get` / `clip_get` — they return child ids (clips,
   parameters, chains). `track_get` also accepts `track_name` or `track_index` directly, and
   an `include` selector to skip sections you don't need.
3. Ids become stale when objects are deleted/moved or a different set is loaded. On a stale-id
   error, re-run `song_get` and re-resolve. Errors about your arguments (index out of range,
   missing or conflicting fields) come without the stale-id hint: fix the call instead.
4. Writes apply asynchronously: a read right after a write can still return the old value.

## Units and conventions

- All times, positions, durations are **beats** (quarter notes), not seconds or bars.
  At 4/4, one bar = 4 beats. Seconds → beats: `seconds * tempo / 60`.
- MIDI pitch: 0–127, C3 = 60 in Live's naming (C-2 = 0). Kick drum pad usually C1 = 36.
- Colors: `"#RRGGBB"` strings.
- Velocity 0–127, probability 0–1.
- Device parameters use internal units within each parameter's `min`/`max` (no dB/Hz/ms
  display values).

## MIDI composition

- Create track: `track_create {type:"midi"}`, then create clip + notes in ONE call:
  - Session: `clip_create {type:"midi", target_id:<track_id>, scene_index:0, duration:4, notes:[...], name, color}`
  - Arrangement: `clip_create {type:"midi", target_id:<midi_track_id>, start_time, duration, notes:[...]}`
  - Take lane: `clip_create {type:"midi", target_id:<take_lane_id>, start_time, duration, ...}`
  - MIDI clips reject the audio-only `file_path`, `is_warped` and `loop_settings`.
- Layer more notes: `midi_clip_set_notes {mode:"merge", notes:[...]}` (default mode `replace`
  wipes the clip — only use it when rewriting everything).
- Mechanical edits (transpose, shift, quantize, velocity, delete a range): use
  `midi_clip_edit_notes` with an optional pitch/time `select` — server-side, no need to read
  and resend the note list. Note times are relative to the clip start.
- Respect the song scale from `song_get` (`scale.root_note`, `scale.intervals`) when composing.

## Devices & sound design

- `device_insert` takes built-in Live device names: "Operator", "Wavetable", "Drum Rack",
  "Simpler", "Reverb", "Delay", "Auto Filter", "EQ Eight", "Compressor", "Saturator", ...
  Third-party plug-ins cannot be inserted. One instrument per track — inserting a second
  instrument fails.
- Parameters: big devices have 100+ params — use `device_get {parameter_filter:"filter"}`
  (substring match) and `include_values:true` instead of dumping everything. Quantized
  parameters (switches/choosers) take the index from `value_items`. Set many at once with
  `parameter_set` (one undo step).
- Drum racks: `device_get {include_chain_devices:true}` maps the whole kit (pad → note →
  sample) in one call; `drum_chain_set` maps a pad to a MIDI note; `simpler_replace_sample`
  swaps samples.

## Mixing

- `mixer_set {target_id, volume?, panning?, sends?}` sets levels in one call (one undo step).
  Volume is normalized 0–1 (0.85 = 0 dB unity, 1.0 = +6 dB), panning -1..1.
- `mixer_get` returns the same values with parameter ids (for `parameter_set` automation).
- Sends align with return tracks by index (names included in the response).

## Audio

- Audio clips: `clip_create {type:"audio", file_path:"/abs/path.wav", ...}` — the file is
  imported into the project automatically (keep `import_into_project: true`).
- Warping: `clip_set {warping, warp_mode}` — modes: Beats, Tones, Texture, Repitch, Complex,
  ComplexPro.
- `render_track_audio` renders the pre-FX audio of an audio track (its clip audio before the
  device chain: no effects, mixer or sends) to a WAV file and returns the path — useful for
  analysis or resampling. Since Live 12.4.15 the render is not normalized. The file lives in
  the extension's temp directory, which may be cleaned: `import_file` it (or `clip_create`
  with it, which imports by default) to keep it.

## Interacting with the user in Live

- `show_dialog` displays HTML inside Live and blocks until closed — use sparingly, e.g. to
  confirm a destructive batch edit or present a summary. The HTML must call
  `close_and_send` (see tool description) to return a value. Dialogs keep no state between
  calls: each one starts from the HTML you pass.

## What is NOT possible

The Extensions API (1.0.0) has no access to:

- transport (play/stop/record), song position, clip or scene launching;
- the browser, third-party plug-ins, device presets;
- automation envelopes, modulation, MIDI/macro mapping;
- track color, routing and sidechain sources, MIDI routing;
- reordering or grouping tracks, creating return tracks;
- metering (no level readouts);
- editing clip start/end markers or loop positions after creation (a MIDI clip's loop can't
  be set even at creation);
- the song time signature (scenes report theirs, read-only).

Don't pretend otherwise or improvise workarounds — tell the user when asked.

## Destructive operations

`track_delete`, `scene_delete`, `clip_delete`, `cue_point_delete`, `device_delete`,
`midi_clip_set_notes` (mode `replace`), `midi_clip_edit_notes` (with `delete`),
`track_clear_clips_in_range`, and `simpler_replace_sample` (discards the current sample)
change the user's project (each is one undo step in Live). They carry the MCP
`destructiveHint` annotation; read-only tools carry `readOnlyHint`. For bulk destructive edits
the user didn't explicitly enumerate, confirm first.
