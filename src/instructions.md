Controls the running Ableton Live Set through Live's Extensions API.

- Start with song_get: it returns the ids every other tool takes (`include` limits the
  sections). Tools acting on a track also take track_name or track_index, scene tools
  scene_name or scene_index. Ids go stale when an object is deleted or moved, or another
  Live Set is loaded: on a stale-id error, call song_get again and re-resolve.
- One call and one undo step for many objects: the *_set tools take `items`, clip_set a track
  `select`, mixer_set `targets` or `all_tracks`. track_create also takes a name and devices.
- All times, positions and durations are in beats (quarter notes), never seconds or bars.
  At 4/4 one bar = 4 beats; seconds to beats = seconds * tempo / 60.
- MIDI pitch is 0-127 with C3 = 60 (the kick pad is usually C1 = 36). Velocity 0-127,
  probability 0-1, colors "#RRGGBB".
- Mixer volume is normalized 0-1 (0.85 = 0 dB, 1.0 = +6 dB), panning -1..1. Device parameters
  use internal units within their min/max; quantized ones take a value_items index.
- A Drum Rack pad is a drum chain addressed by its receiving MIDI note:
  device_get {include_chain_devices:true} maps pad -> note -> sample, drum_chain_set remaps.
- Create MIDI clips with their notes in one clip_create call. Layer notes with
  midi_clip_set_notes mode "merge"; transform them with midi_clip_edit_notes.
- Writes apply asynchronously: a read right after a write can still return the old value.
- Deletes, clearing a range, replacing notes or a sample change the user's project. Confirm
  bulk destructive edits the user did not spell out.
- Not possible with this API: transport (play/stop/record), launching clips or scenes, the
  browser, third-party plug-ins and presets, automation, track color, routing and sidechain,
  reordering or grouping tracks, creating return tracks, metering, editing clip markers or
  loops after creation, and the song time signature. Say so instead of working around it.
