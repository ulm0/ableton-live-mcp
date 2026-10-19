Controls the running Ableton Live Set through Live's Extensions API.
- Start with song_get: it returns the ids every other tool takes (`include` limits the sections;
  "devices", "mixer", "clips" add each track's device tree, levels and clips). Tools acting on a
  track also take track_name or track_index, scene tools scene_name or scene_index. Ids go stale
  when an object is deleted or moved, or another set is loaded: call song_get again, re-resolve.
- Across tracks: scene_get (a scene row), session_grid, arrangement_get (a beat range), song_audit.
  For "this clip", "these slots" or "the selected range", ask the user to right-click it in Live and
  choose "MCP: Use as selection", then call selection_wait (selection_get: the last one).
- One call and one undo step for many objects: the *_set tools take `items`, clip_set a track
  `select`, mixer_set `targets` or `all_tracks`. track_create also takes a name and devices. For
  dependent chains, batch (batch_read: reads only) runs up to 50 calls; {"$ref": "0.id"} = a result.
- Times, positions and durations are beats (quarter notes), never seconds or bars: at 4/4 a bar
  is 4 beats; seconds to beats = seconds * tempo / 60. MIDI pitch is 0-127 or a name, C3 = 60
  (the kick pad is usually "C1" = 36); velocity 0-127, probability 0-1, colors "#RRGGBB".
- Mixer volume is 0-1 (0.85 = 0 dB, 1.0 = +6 dB), panning -1..1. Device parameters are internal
  units within min/max (no dB/Hz); quantized ones take a value_items index or a value_item name.
  Address parameters as {track_name, device, parameter}, device a name, index or rack path like
  ["Drum Rack", {pad:36}, "Simpler"] (pad = receiving note); device_set sets several, or on/off.
- Create MIDI clips with their notes in one clip_create call (drum lines as step `patterns`,
  `repeat` to fill); layer with midi_clip_set_notes "merge"; edit with midi_clip_edit_notes. Also
  one call each: drum_kit_build (files: sample_search), clip_copy, arrangement_copy_range.
- Writes apply asynchronously (a read right after one may return the old value). Deletes, clearing
  a range, replacing notes or a sample change the project: confirm bulk edits not spelled out —
  in Live: show_dialog {form, wait:false}, then dialog_result (a waiting call can time out).
- Not possible: transport (play/stop/record), launching clips or scenes, the browser, plug-ins and
  Live presets, automation, track color, routing and sidechain, reordering or grouping tracks, new
  return tracks, metering, editing clip markers or loops, the song time signature. Say so.
