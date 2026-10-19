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
   parameters, chains). `track_get` takes an `include` selector to skip sections you don't
   need.
3. **Address tracks and scenes by name when the user does.** Every tool that acts on one track
   (`track_get`, `track_set`, `track_delete`, `track_duplicate`, `track_clear_clips_in_range`,
   `take_lane_create`, `render_track_audio`, `mixer_get`, `mixer_set`, `device_insert`,
   `clip_create`) takes `track_id`, `track_index` (0-based, regular tracks) or `track_name`
   (exact first, then case-insensitive; also finds return and main tracks). The scene tools
   and `clip_create` take `scene_id`, `scene_index` or `scene_name`. "Mute the Drums" is one
   call: `track_set {track_name:"Drums", mute:true}`. If you give several fields they must name
   the same object. An ambiguous name fails with the matching candidates — pick one by id or
   index. `track_delete` and `scene_delete` only accept the exact name. Parameters work the same
   way: see [Devices & sound design](#devices--sound-design).
4. Ids become stale when objects are deleted/moved or a different set is loaded. On a stale-id
   error, re-run `song_get` and re-resolve. Errors about your arguments (unknown name, index
   out of range, missing or conflicting fields) come without the stale-id hint: fix the call
   instead.
5. Writes apply asynchronously: a read right after a write can still return the old value.

## Batch edits (one call, one undo step)

- `track_set`, `scene_set`, `cue_point_set`, `clip_set`, `take_lane_set` and `mixer_set` take
  `items: [...]` — one entry per object, each with its address and values:
  `track_set {items:[{track_name:"Bass", mute:true}, {track_name:"Keys", solo:false}]}`,
  `scene_set {items:[{scene_index:0, name:"Intro"}, {scene_index:1, name:"Verse"}]}`.
- `clip_set {select:{track_name:"Drums", scope:"all", name_contains?}, warp_mode:"ComplexPro"}`
  changes every matching clip of one track (scope: `session`, `arrangement`, `take_lanes` or
  `all`).
- Every entry is validated first: one bad entry (unknown name, bad color, warp settings on a
  MIDI clip) fails the whole call and changes nothing; the error names the entry
  (`items[2]: ...`). The user undoes the whole batch with one Cmd/Ctrl-Z.
- Prefer one batched call over a loop of single calls.

## Units and conventions

- All times, positions, durations are **beats** (quarter notes), not seconds or bars.
  At 4/4, one bar = 4 beats. Seconds → beats: `seconds * tempo / 60`.
- MIDI pitch: 0–127, C3 = 60 in Live's naming (C-2 = 0). Kick drum pad usually C1 = 36.
  Wherever a pitch is taken (notes, patterns, `select` ranges, drum pads, `drum_chain_set`) a
  note name works too: `"C1"`, `"F#1"`, `"Bb2"` (sharps `#`, flats `b`).
- Colors: `"#RRGGBB"` strings.
- Velocity 0–127, probability 0–1.
- Device parameters use internal units within each parameter's `min`/`max` (no dB/Hz/ms
  display values). Quantized parameters (switches, choosers) take the `value_items` index, or
  the choice by name with `value_item`.

## MIDI composition

- Create track: `track_create {type:"midi", name:"Bass", devices:["Operator"]}` names it and
  inserts devices in the same call (`{name:"Auto Filter", parameters:[{name:"Frequency",
  value:80}]}` sets initial values). Live inserts the new track after the selected one, so use
  the returned `index`/`id`, not "the last track". A device that fails to insert is reported
  in `errors` (and its `devices` entry); the track and the other devices are still created.
- Then create clip + notes in ONE call:
  - Session: `clip_create {type:"midi", track_name:"Bass", scene_name:"Verse", duration:4, notes:[...], name, color}`
    (or `target_id:<track_id>, scene_index:0`)
  - Arrangement: `clip_create {type:"midi", target_id:<midi_track_id>, start_time, duration, notes:[...]}`
  - Take lane: `clip_create {type:"midi", target_id:<take_lane_id>, start_time, duration, ...}`
  - MIDI clips reject the audio-only `file_path`, `is_warped` and `loop_settings`.
- Drum lines and other repetitive parts: step `patterns` instead of one note per hit — one
  pitch per string, `"x"` a hit, `"X"` an accent (`accent_velocity`, default 127), `"."` or `"-"`
  a rest, spaces and `|` ignored; `step` is the beats per character (default 0.25 = 1/16).
  `repeat {length}` copies the notes and patterns every `length` beats up to the clip's end
  (`times` for an exact count). A two-bar beat in one call:
  `clip_create {type:"midi", track_name:"Drums", scene_index:0, duration:8, repeat:{length:4},
  patterns:[{note:"C1", steps:"x...x...x...x..."}, {note:"D1", steps:"....X.......X..."},
  {note:"F#1", steps:"x.x.x.x.x.x.x.x.", velocity:80}]}`. `midi_clip_set_notes` takes the
  same `patterns` and `repeat`.
- Layer more notes: `midi_clip_set_notes {mode:"merge", notes:[...]}` (default mode `replace`
  wipes the clip — only use it when rewriting everything).
- Reading notes: `midi_clip_get_notes {select?, format?}`. `select` filters like the edit's
  (below); `format:"compact"` returns `[pitch, start_time, duration, velocity]` tuples plus an
  object of the fields that differ from the result's `defaults` — use it for dense clips.
- Mechanical edits: `midi_clip_edit_notes` — server-side, no need to read and resend the note
  list. Note times are relative to the clip start.
  - `select` (all filters must match): `pitch_min`/`pitch_max` (numbers or names),
    `time_min`/`time_max` (start, beats), `in_scale` (true/false against the song's scale, or
    `snap_to_scale`'s), `every_nth` (`2` = 1st, 3rd, ... in time order; `{n:2, offset:1}` = 2nd,
    4th, ...), `only_selected` (the notes the user selected in Live's editor).
  - Transforms, in this order: `transpose`; `snap_to_scale` (`"song"` or `{root:"D",
    intervals:[0,2,3,5,7,9,10]}`; out-of-key notes move to the nearest scale note, ties go
    down); `set {velocity, probability, velocity_deviation, release_velocity, muted}`;
    `velocity_scale`, `velocity_offset`; `time_shift`; `quantize {grid, strength}`; `swing
    {amount, grid}` (0 = straight, ~0.67 = triplet feel, 1 = dotted); `duration_set` or
    `duration_scale`; `legato` (each note runs to the next start; notes starting together are
    a chord and end together; the last keep their length); `humanize {timing, velocity, seed}`.
    Or `delete:true`.
  - A grid of `"song"` (quantize, swing) uses Live's grid setting — the arrangement grid, not
    the clip editor's; bar grids assume the first scene's time signature, "No Grid" fails.
  - `humanize` is reproducible: pass `seed`, or reuse the returned `humanize_seed`.
  - `clip_ids:[...]` edits several clips alike in one undo step (one notes write per clip):
    "humanize these 8 drum clips" is one call.
  - "Fix the out-of-key notes" = `{clip_id, snap_to_scale:"song"}`; "mute every second hi-hat"
    = `{select:{pitch_min:"F#1", pitch_max:"F#1", every_nth:{n:2, offset:1}}, set:{muted:true}}`.
- The user's note selection: `only_selected` (and each note's `selected` in reads) comes from
  `NoteDescription.selected`. Whether Live fills it in for extensions is unverified: when no
  note reports a selection, results carry a `warning` — then ask the user which notes they
  mean instead of guessing.
- Respect the song scale from `song_get` (`scale.root_note`, `scale.intervals`) when composing.

## Devices & sound design

- `device_insert` takes built-in Live device names: "Operator", "Wavetable", "Drum Rack",
  "Simpler", "Reverb", "Delay", "Auto Filter", "EQ Eight", "Compressor", "Saturator", ...
  Third-party plug-ins cannot be inserted. One instrument per track — inserting a second
  instrument fails.
- **Address parameters by name — no id lookup needed.** `parameter_get` and `parameter_set`
  entries take `{track_name, device, parameter}` (or `{device_id, parameter}`, or the old
  `{parameter_id}`):
  - `device`: a name (exact, then case-insensitive), a 0-based index on the track, or a path
    into racks: `["Drum Rack", {pad:36}, "Simpler"]` (a pad is the drum chain with that
    receiving note) or `["Instrument Rack", {chain:1}, 0]` (chains by index; chains have no
    names).
  - `parameter`: exact name first, then case-insensitive, then a unique substring (`"freq"` →
    "Frequency"). Ambiguous matches fail with the candidates and their ids.
  - Each write gives exactly one of `value` (internal units), `value_item` (a quantized
    parameter's choice by name or short name, matched like `parameter`: `"high"` →
    "Highpass"), `reset:true` (back to the default) or `delta` (relative to the current value,
    clamped).
  - "Switch the bass filter to high-pass" is one call, e.g.
    `parameter_set {values:[{track_name:"Bass", device:"Auto Filter", parameter:"Filter Type", value_item:"high"}]}`
    (when unsure of the exact names, `parameter_find` first).
- `device_set {track_name, device, enabled?, parameters?:[{name, value|value_item|reset|delta}]}`
  bypasses or enables a device and sets several of its parameters in one undo step. `enabled`
  uses the "Device On" parameter (a Live convention, not an API field); a device without one
  falls back to a two-state first parameter, and `on_parameter.fallback` says so. Some devices
  have no switch at all — that fails with a clear error.
- Don't know the parameter name? `parameter_find {track_name, query:"cutoff"}` (or the whole set,
  or one device; `value_item:"saw"` finds choosers with that choice) returns ids, device names and
  paths like "Drums > Drum Rack > pad 36 > Simpler". Big devices have 100+ params: prefer
  `parameter_find` or `device_get {parameter_filter, include_values:true}` over dumping all.
- `device_insert` and `track_create` devices take initial `parameters:[{name, value|value_item|…}]`.
- dB, Hz and ms are not available: values are internal units only. Read `min`/`max` and the
  current value first, and say that any unit conversion is approximate.
- Drum racks: `device_get {include_chain_devices:true}` maps the whole kit (pad → note →
  sample) in one call; drum chains report `receiving_note` and `receiving_note_name` (`"C1"`).
  `drum_chain_set` maps a pad to a MIDI note (`receiving_note: 38` or `"D1"`), and pads in
  device paths take names too (`["Drum Rack", {pad:"C1"}, "Simpler"]`);
  `simpler_replace_sample` swaps samples.

## Copying, moving and presets (lossy)

- Live's API cannot move, reorder or copy devices. `device_copy {device_id, track_name |
  target_id, index?}` inserts a fresh built-in device of the same name and copies its parameter
  values by name (a Simpler also gets its sample). `move:true` deletes the original afterwards:
  "move the compressor before the EQ" = `device_copy {device_id:<comp>, index:<EQ's index>,
  move:true}` (target omitted = the same track or chain; `index` counts the current devices).
- It is lossy and you must say so: automation, modulation and MIDI/macro mappings, a custom
  device name and any state that is not a parameter are lost, and the device gets a new id
  (the old one is gone after a move). Racks are refused (use `device_duplicate` in place). If
  some values could not be copied (`not_copied`), a move keeps the original.
- If the user renamed the device in Live, pass the built-in name as `device_name`.
- Presets: `device_preset_save {name, track_name, device}` stores the parameter values (and a
  Simpler's sample path) as JSON in the extension's storage directory; `device_preset_load
  {name, track_name}` inserts the device with those values (add `device` or `device_id` to
  load onto an existing one); `device_preset_list` shows them. These are this server's
  snapshots, not Live presets (`.adv`): no automation, mappings or other device state.

## Mixing

- `mixer_set {track_name | target_id, volume?, panning?, sends?}` sets levels in one call (one
  undo step). Volume is normalized 0–1 (0.85 = 0 dB unity, 1.0 = +6 dB), panning -1..1.
- Sends are addressed by `index` (aligned with the return tracks) or `return_name`:
  `sends:[{return_name:"A-Reverb", value:0.3}]`.
- Many mixers at once, still one undo step: `targets:[{track_name:"Bass"}, {track_name:"Keys"}]`
  (same values), `items:[{track_name, volume}, ...]` (own values), or
  `all_tracks:true, exclude:[{track_name:"Vocals"}]` (every regular track but those).
  `all_tracks` only sets the top-most tracks: a group covers its tracks (they are not set
  again), tracks inside an excluded group are left alone, and a group holding an excluded
  track is skipped while its other tracks are set. The result's `skipped` says why.
- There is no relative or dB setting: read the current values with `mixer_get` first if the
  user asks for "3 dB quieter", and say that the dB mapping is approximate.
- `mixer_get` returns the same values with parameter ids (for `parameter_set` automation).

## Audio

- Audio clips: `clip_create {type:"audio", file_path:"/abs/path.wav", ...}` — the file is
  imported into the project automatically (keep `import_into_project: true`).
- Warping: `clip_set {warping, warp_mode}` — modes: Beats, Tones, Texture, Repitch, Complex,
  ComplexPro. For all clips of a track: `clip_set {select:{track_name:"Drums"}, warping:true,
  warp_mode:"ComplexPro"}`.
- `render_track_audio` renders the pre-FX audio of an audio track (its clip audio before the
  device chain: no effects, mixer or sends) to a WAV file and returns the path — useful for
  analysis or resampling. Since Live 12.4.15 the render is not normalized. The file lives in
  the extension's temp directory, which may be cleaned: `import_file` it (or `clip_create`
  with it, which imports by default) to keep it.

## Song structure

- Scenes: `scene_create {items:[{name:"Intro"}, {name:"Verse"}, {name:"Chorus"}]}` appends
  them in order (an entry's `index` refers to the list after the previous entries).
- Locators: `cue_point_create {items:[{time:0, name:"Intro"}, {time:32, name:"Verse"}]}`.
- Moving a locator: `cue_point_set {cue_point_id, time}`. Live cannot change a cue point's
  time, so it is re-created at the new time with its name and the old one is deleted: use the
  returned `id` from then on (`replaced_id` is the old, now invalid one). A move onto a beat
  that already has a cue point is refused.

## Interacting with the user in Live

- `show_dialog` displays HTML inside Live and blocks until closed — use sparingly, e.g. to
  confirm a destructive batch edit or present a summary. The HTML must call
  `close_and_send` (see tool description) to return a value. Dialogs keep no state between
  calls: each one starts from the HTML you pass.

## What is NOT possible

The Extensions API (1.0.0) has no access to:

- transport (play/stop/record), song position, clip or scene launching;
- the browser, third-party plug-ins, Live's own device presets (`.adv`/`.adg`) — the
  `device_preset_*` tools keep this server's JSON snapshots instead;
- moving, reordering or renaming devices (`device_copy` emulates move/reorder, lossily);
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
`track_clear_clips_in_range`, `simpler_replace_sample` (discards the current sample),
`device_copy` with `move` (deletes the original, lossy) and `device_preset_load` onto a Simpler
(replaces its sample) change the user's project (each step is undoable in Live).
`device_preset_save` with `overwrite` replaces a saved preset file. `track_delete` and `scene_delete`
by name need the exact name, so a case-insensitive guess can't delete the wrong object. They carry the MCP
`destructiveHint` annotation; read-only tools carry `readOnlyHint`. For bulk destructive edits
the user didn't explicitly enumerate, confirm first.
