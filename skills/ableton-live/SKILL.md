---
name: ableton-live
description: Control Ableton Live via the ableton-live MCP server — compose MIDI, arrange tracks, edit clips, tweak devices and mix. Use whenever the user asks to do anything in Ableton Live (create tracks/clips/notes, change tempo, add devices, mix levels, warp audio, render stems).
---

# Ableton Live via MCP

The `ableton-live` MCP server (streamable HTTP, `http://127.0.0.1:8722/mcp`) controls a running
Ableton Live 12. If tools fail to connect, Live is not running or the extension is not installed.

## Core workflow

1. **Always start with `song_get`.** It returns the whole set with object ids. Every other tool
   takes those ids.
2. Drill down with `track_get` / `device_get` / `clip_get` — they return child ids (clips,
   parameters, chains).
3. Ids become stale when objects are deleted/moved or a different set is loaded. On a stale-id
   error, re-run `song_get` and re-resolve.

## Units and conventions

- All times, positions, durations are **beats** (quarter notes), not seconds or bars.
  At 4/4, one bar = 4 beats. Seconds → beats: `seconds * tempo / 60`.
- MIDI pitch: 0–127, C3 = 60 in Live's naming (C-2 = 0). Kick drum pad usually C1 = 36.
- Colors: `"#RRGGBB"` strings.
- Velocity 0–127, probability 0–1.

## MIDI composition

- Create track: `track_create {type:"midi"}`, then a clip:
  - Session: `clip_create {type:"midi", target_id:<clip_slot_id>, duration:<beats>}`
  - Arrangement: `clip_create {type:"midi", target_id:<midi_track_id>, start_time, duration}`
- Notes: `midi_clip_set_notes` **replaces all notes**. To edit, `midi_clip_get_notes` first,
  modify the list, write it back. Note times are relative to the clip start.
- Respect the song scale from `song_get` (`scale.root_note`, `scale.intervals`) when composing.

## Devices & sound design

- `device_insert` takes built-in Live device names: "Operator", "Wavetable", "Drum Rack",
  "Simpler", "Reverb", "Delay", "Auto Filter", "EQ Eight", "Compressor", "Saturator", ...
  Third-party plug-ins cannot be inserted.
- Parameters: get ids + ranges from `device_get`. Quantized parameters (switches/choosers) take
  the index from `value_items`. Set many at once with `parameter_set` (one undo step).
- Drum racks: `device_get` on the rack → `chain_ids`; `chain_get` for pad devices;
  `drum_chain_set` maps a pad to a MIDI note; `simpler_replace_sample` swaps samples.

## Mixing

- `mixer_get` on a track/chain returns volume/panning/sends with parameter ids — write with
  `parameter_set`. Volume is normalized 0–1 (0.85 ≈ 0 dB), panning -1..1.
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

`track_delete`, `scene_delete`, `clip_delete`, `midi_clip_set_notes`, `track_clear_clips_in_range`
and `device_delete` change the user's project (each is one undo step in Live). For bulk
destructive edits the user didn't explicitly enumerate, confirm first.
