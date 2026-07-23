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
   error, re-run `song_get` and re-resolve.

## Units and conventions

- All times, positions, durations are **beats** (quarter notes), not seconds or bars.
  At 4/4, one bar = 4 beats. Seconds → beats: `seconds * tempo / 60`.
- MIDI pitch: 0–127, C3 = 60 in Live's naming (C-2 = 0). Kick drum pad usually C1 = 36.
- Colors: `"#RRGGBB"` strings.
- Velocity 0–127, probability 0–1.

## MIDI composition

- Create track: `track_create {type:"midi"}`, then create clip + notes in ONE call:
  - Session: `clip_create {type:"midi", target_id:<track_id>, scene_index:0, duration:4, notes:[...], name, color}`
  - Arrangement: `clip_create {type:"midi", target_id:<midi_track_id>, start_time, duration, notes:[...]}`
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
- `render_track_audio` renders pre-FX audio of an audio track to WAV (path returned) — useful
  for analysis or resampling; combine with `import_file`/`clip_create` to bounce back in.

## Interacting with the user in Live

- `show_dialog` displays HTML inside Live and blocks until closed — use sparingly, e.g. to
  confirm a destructive batch edit or present a summary. The HTML must call
  `close_and_send` (see tool description) to return a value.

## What is NOT possible

Transport (play/stop/record), clip launching, browser access, automation envelopes, loading
third-party plug-ins, MIDI routing. Don't pretend otherwise — tell the user when asked.

## Destructive operations

`track_delete`, `scene_delete`, `clip_delete`, `cue_point_delete`, `device_delete`,
`midi_clip_set_notes` (mode `replace`), `midi_clip_edit_notes` (with `delete`),
`track_clear_clips_in_range`, and `simpler_replace_sample` (discards the current sample)
change the user's project (each is one undo step in Live). For bulk destructive edits the
user didn't explicitly enumerate, confirm first.
