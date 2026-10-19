# Ableton Live MCP

An [MCP](https://modelcontextprotocol.io) server for **Ableton Live 12**, built on the official
[Ableton Extensions SDK](https://ableton.github.io/extensions-sdk). The MCP server runs *inside*
Live as an extension — no bridge process, no MIDI remote scripts. Any MCP client (Claude Code,
Claude Desktop, Cursor, ...) connects over streamable HTTP and gets full programmatic control of
the Live Set: tracks, clips, MIDI notes, devices, parameters, mixer, scenes, warping, rendering,
and more.

```
MCP client (Claude, ...) ──streamable HTTP──▶ http://127.0.0.1:8722/mcp
                                                      │
                                     Live Extension Host (Node.js)
                                                      │
                                              Ableton Live 12
```

## Requirements

- Ableton Live 12.4.5 or newer (Extensions support)
- Node.js >= 24.14 (build only)

## Install

```bash
npm install
npm run package        # builds and produces Ableton-Live-MCP-<version>.ablx
```

Then drag the `.ablx` file onto **Settings → Extensions** in Live. The MCP endpoint starts with
Live at `http://127.0.0.1:8722/mcp` (`GET /health` for a quick check: version, host API version,
tool count, uptime).

### Development mode

Enable **Settings → Extensions → Developer Mode** in Live, then:

```bash
npm start              # builds and runs the extension against the running Live
```

`.env` must point at your Live installation, e.g.
`EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app`.

### Connect a client

Claude Code:

```bash
claude mcp add --transport http ableton-live http://127.0.0.1:8722/mcp
```

Claude Desktop (or any stdio-only client) via `mcp-remote`:

```json
{
  "mcpServers": {
    "ableton-live": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:8722/mcp"]
    }
  }
}
```

With an `auth_token` in `config.json` (see [Security](#security)), the client sends it as a
bearer token:

```bash
claude mcp add --transport http ableton-live http://127.0.0.1:8722/mcp \
  --header "Authorization: Bearer <token>"
```

```json
{
  "mcpServers": {
    "ableton-live": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:8722/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

### Configuration

Settings live in `config.json` inside the extension's storage directory (created on first run
with the port; the path is reported by `song_get` under `environment.storage_directory` and by
the Status dialog in Live). It is read once, when the extension starts (`sample_roots` excepted):
restart Live after a change. Default:

```json
{ "port": 8722 }
```

| Setting | Default | Meaning |
|---|---|---|
| `port` | `8722` | TCP port on 127.0.0.1 |
| `progress_notifications` | `true` | `false` answers every request as plain JSON (no progress for long calls) |
| `sample_roots` | `[]` | Folders `sample_search` searches (read on every search) |
| `read_only` | `false` | `true` registers only the tools that read the Live Set (`readOnlyHint`) |
| `disabled_tools` | `[]` | Tool names not to register, e.g. `["execute_command", "show_dialog"]` |
| `auth_token` | `null` | Require `Authorization: Bearer <token>` on `/mcp` (16+ visible ASCII characters) |

Every value is validated at startup. Problems are logged to `ExtensionHost.txt` (prefixed
`[ableton-live-mcp] config:`) and listed in the Status dialog: a `port` or
`progress_notifications` of the wrong type falls back to its default, unknown keys are ignored
(misspelled security settings excepted, see below).
The security settings never fall back to something less safe: an invalid `read_only`,
`disabled_tools` or `auth_token`, a misspelled one (`readOnly`, `auth-token`, ...), a
`disabled_tools` entry that names no tool (probably a typo), or a file that exists but cannot be
read or parsed (smart quotes, unquoted keys, ...), makes `/mcp` refuse every request with `503`
and the reason until the file is fixed. The file is read as UTF-8, or as UTF-16 when it starts
with a byte order mark (as Windows PowerShell 5.1 writes it); an empty file means the defaults.
A switched-off tool is not listed at all; `batch` steps naming it fail with "switched off", the
server instructions tell the agent which tools are off, and a prompt is only offered when every
tool it uses is on.

For example `{ "port": 8722, "read_only": true }`,
`{ "port": 8722, "disabled_tools": ["execute_command", "track_delete", "scene_delete"] }` or
`{ "port": 8722, "auth_token": "<a long random string>" }`.

`sample_roots` lists the folders `sample_search` may search for audio files (absolute paths, or
`~/...`), in addition to Live's default User Library and Factory Packs folders
(`~/Music/Ableton/...` on macOS, `~/Documents/Ableton/...` on Windows) when they exist. Unlike
the port, it is read on every search, so no restart is needed:

```json
{ "port": 8722, "sample_roots": ["/Users/me/Samples", "~/Splice"] }
```

Long calls (`show_dialog`, `dialog_result`, `selection_wait`, `render_track_audio`,
`audio_track_consolidate`, `batch`, `batch_read`) send MCP progress notifications when the client
asks for them; such a call is then answered as an SSE stream instead of plain JSON (see
[How it works](#how-it-works)). `"progress_notifications": false` answers every request as JSON
again (read at startup):

```json
{ "port": 8722, "progress_notifications": false }
```

Device presets saved with `device_preset_save` are JSON files in `presets/` in the same
directory (one file per preset, named after it); they can be copied between machines, and
deleting a file deletes the preset.

## How it works

- Every Live object (track, clip, device, parameter, ...) is addressed by a stable **object id**
  discovered through listing tools (`song_get`, `track_get`, `device_get`, ...).
- Tracks and scenes can also be addressed **by name or index**: every tool that acts on one
  track takes `track_id`, `track_index` (regular tracks) or `track_name` (exact match first,
  then case-insensitive; regular, return and main tracks), and the scene tools take `scene_id`,
  `scene_index` or `scene_name`. When several are given they must name the same object. An
  ambiguous name is an error that lists only the matching candidates; deletes need the exact
  name.
- Ids stay valid until the object is deleted or moved, or another Live Set is loaded. Stale ids
  return an error telling the client to re-list. Errors in the arguments themselves (unknown
  name, index out of range, conflicting fields) come without that hint.
- All times/positions are in **beats**; colors are `#RRGGBB`; MIDI pitches are 0–127, or note
  names in Live's naming (`"C3"` = 60, `"F#1"`, `"Bb2"`) wherever a pitch is taken: notes,
  patterns, note selections, drum pads in device paths and `drum_chain_set`. Drum chains report
  `receiving_note_name` next to `receiving_note`.
- **Batched writes**: `track_set`, `scene_set`, `cue_point_set`, `clip_set`, `take_lane_set` and
  `mixer_set` take `items: [{<address>, ...values}]` to change many objects in one call.
  `clip_set` also takes `select: {track, scope, name_contains}` (e.g. every clip of the Drums
  track), and `mixer_set` takes `targets` (same values on several mixers) or `all_tracks` with
  `exclude`. Every entry is validated before the first write, and all of a call's changes form
  **one undo step** in Live — as do the multi-value writes of `parameter_set` and `mixer_set`.
  The exception: `cue_point_set` moves take up to three undo steps (creates, names, deletes);
  its renames are one.
- **Create with initial config**: `track_create` takes a `name` and `devices` (each a name or
  `{name, parameters}`) and returns the new track's `index` (Live inserts it after the selected
  track); `device_insert` takes initial `parameters`; `scene_create` and `cue_point_create` take
  a `name` or `items` for several at once.
- **Parameters by name**: `parameter_get` / `parameter_set` entries take
  `{track_name, device, parameter}` (or `device_id` + `parameter`) instead of a `parameter_id`.
  `device` is a name, an index, or a path into racks, e.g. `["Drum Rack", {"pad": 36}, "Simpler"]`
  (drum pads by receiving note) or `[0, {"chain": 1}, "Reverb"]` (chains by index); `parameter`
  matches exactly first, then case-insensitively, then by unique substring. Each write gives
  exactly one of `value` (internal units), `value_item` (a quantized parameter's choice by name,
  e.g. `"Saw"`), `reset: true` (default value) or `delta` (relative, clamped). `device_set`
  switches a device on or off and sets several of its parameters in one undo step;
  `parameter_find` searches parameter names across the set, a track or a device. Values stay in
  internal units — the API has no display values (dB, Hz, ms).
- **MIDI shortcuts**: MIDI writes (`clip_create`, `midi_clip_set_notes`) take step `patterns`
  (`{note: "C1", steps: "x...X...", step: 0.25}`, `X` = accent) and `repeat: {length, times?}`,
  which copies the notes every `length` beats up to the clip's end. `midi_clip_get_notes` takes a
  `select` filter and `format: "compact"` (`[pitch, start, duration, velocity]` tuples plus the
  fields that differ from the result's `defaults`). `midi_clip_edit_notes` adds `set`,
  `snap_to_scale` (the song's scale or `{root, intervals}`, ties go down), `swing`, seeded
  `humanize`, `duration_set` / `duration_scale` / `legato` (a chord ends together), quantizing
  to Live's grid (`grid: "song"`), selecting by `in_scale`, `every_nth` or the user's note
  selection (`only_selected`), and `clip_ids` to edit several clips in one undo step.
  Whether Live reports the note selection (`NoteDescription.selected`) to extensions is not
  verified yet; when no note reports one, results carry a `warning`.
- **Copy, move and presets** (lossy by design): Live's API cannot move, reorder or copy devices,
  so `device_copy` inserts a fresh built-in device and copies the parameter values by name (a
  Simpler also gets its sample); `move: true` then deletes the original. Automation, mappings, a
  custom device name and non-parameter state are lost, and ids change. `device_preset_save` /
  `device_preset_load` / `device_preset_list` keep the same kind of snapshot as named JSON files
  in the extension's storage directory (`presets/`) — not Live `.adv` presets. Racks are refused
  by both.
- **Samples, kits and copies in one call**: `drum_kit_build {track_name | rack_device_id, pads:
  [{note, sample_path, volume?, panning?}]}` builds or updates a Drum Rack kit — per pad it reuses
  or creates the chain receiving that note, inserts a Simpler, imports the sample into the project
  and loads it; every path is checked before anything changes. `device_insert {device_name:
  "Simpler", sample_path}` imports the sample into the project by default (`import_into_project`),
  so the set survives being moved; `simpler_replace_sample` loads the file as it is, as before,
  unless it is given `import_into_project: true` (recommended). `sample_search` finds audio files in
  the configured `sample_roots` and Live's library folders (read-only, confined to those folders).
  Live's API has no clip copy, so `clip_copy` creates a new clip: MIDI notes are re-based to where
  the source plays them (markers, loop) and repeated when the copy is longer, so it plays the same
  in the arrangement; a session copy loops its whole length, so a source that starts before its
  loop, or a length that is not whole loops, repeats differently (`lost` says so); audio copies
  get the file, warping and markers/loop but Live warps them itself (`fidelity: "approximate"`,
  `lost`, `warp_markers_match`). `move: true` deletes the source once
  the copy exists. `arrangement_copy_range` overwrites a target range with a copy of a source range
  across tracks ("repeat the chorus"): MIDI clips crossing the edges are trimmed, audio clips
  crossing them are skipped and listed (there is no way to insert time). `audio_track_consolidate`
  renders a range of an audio track, imports the render, clears the range and puts one unwarped
  clip there. `render_track_audio {analyze: true}` returns peak/RMS levels (dBFS), clipped samples,
  a silence flag and a 32-part envelope read from the WAV; `persist: true` imports the render;
  `tracks` renders several audio tracks.
- **Whole-set reads**: `song_get` lists every track with its `index`, `depth` in the group
  hierarchy, `is_group` and, for group tracks, `child_track_ids` (their `type` stays `other`);
  `include: ["devices", "mixer", "clips"]` adds each track's device tree (through racks, with each
  device's on-state), mixer values (sends labeled with return names) and clips (session and
  arrangement, in brief), capped at 500 devices / 500 clips (`truncated` says where it stopped).
  `scene_get` returns one session row across all tracks, `session_grid` a compact track × scene
  matrix, and `arrangement_get {start_time, end_time, tracks?, include_take_lanes?}` the cue
  points and every track's clips in a beat range, plus a derived `song_end` (the API has no song
  length).
  `song_audit` lists missing media files, Simplers without a sample, empty drum pads and track
  names that make `track_name` ambiguous. `clip_get`, `device_get` and `chain_get` report a
  `location` (track, scene index or take lane, path through racks).
- **The user's selection**: Live's API has no selection getter; it hands the selection to an
  extension only through context-menu commands. So the extension adds **"MCP: Use as selection"**
  to every context menu it can (clips, clip slots, tracks, scenes, Drum Racks, Simplers, samples,
  clip-slot selections and arrangement time selections). The user right-clicks and picks it;
  `selection_get` returns the last capture (ids, summaries, locations; for a time selection the
  start/end beats and the selected lanes with their overlapping clips), `selection_wait` waits up
  to 55 s for the next one. Captures are kept until the next one (or a restart of Live).
- **Dialogs in Live**: `show_dialog {form: {title?, message?, fields?, choices?}}` builds the
  page itself (every text escaped) and returns the answer as JSON — `choice` (the button's label),
  `choice_index` and `values` by field name (text, textarea, number, checkbox, select) — e.g. to
  confirm a bulk delete; `html` (your own page) and `url` (https:, file: or http://localhost)
  return the string the page sends. Live's dialogs are modal, have no timeout and can't be closed
  from code, so a waiting call can outlast the client's request timeout: `wait: false` returns a
  `dialog_id` at once and `dialog_result {dialog_id?, wait_s ≤ 50}` polls for the answer (also
  for a dialog whose waiting call was cut off). One dialog at a time (the next is refused while
  one is open; `force` if Live never reported it closed); answers are kept for 10 minutes.
- **Chains of calls**: `batch {steps: [{tool, args, as?}]}` runs up to 50 tool calls in order;
  an argument `{"$ref": "<step>.<path>"}` takes a value from an earlier step's result (step index
  or `as` name, then keys and array indexes, e.g. `{"$ref": "0.id"}`). Every tool name, `$ref` and
  the arguments of steps without a `$ref` are checked against the tools' own schemas before the
  first step runs; each step is its own undo step, and `on_error` stops (default) or continues
  after a failing step. `batch_read` does the same for read-only tools only and refuses any other.
  `show_dialog`, `execute_command` and the batch tools themselves can't be steps.
- **Long calls**: `show_dialog`, `dialog_result`, `selection_wait`, `render_track_audio`,
  `audio_track_consolidate`, `batch` and `batch_read` send `notifications/progress` when the
  request carries a `progressToken` — right away, then every 10 s (batches: one per step, with the
  total) — so a client that resets its timeout on progress keeps waiting. Only such a call is
  answered as an SSE stream (with the SDK's 15 s keep-alive); every other request keeps a plain
  JSON response. When the client goes away (the connection drops), waiting calls stop waiting,
  multi-track renders and batches start no further render or step (a dialog stays open in Live:
  `dialog_result` gets it). A `notifications/cancelled` cannot reach a running call: the server is
  stateless, so it arrives in a request of its own.
- **Resources** (read-only snapshots for clients that attach context): `live://song` is
  `song_get` without arguments, `live://tracks/{track}` is `track_get` for the track named
  `{track}` — percent-encoded with `encodeURIComponent`, so a `/` in a name cannot break the
  match (`live://tracks/Drums%2FBus`); `resources/list` has one entry per uniquely named track
  and completions for the names — and `live://guide` is the full [skill](#skills). There are no
  subscriptions: the server is stateless and Live reports no changes, so read again for fresh
  data. They follow their tools: with `song_get` or `track_get` switched off, theirs are gone.
- **Prompts** the user picks in the client, each expanding into step-by-step instructions with
  exact tool calls: `song_skeleton` (scenes and locators per section, positions computed from
  the bar counts, optional tempo and tracks), `chord_progression` (Roman numerals in a key —
  default Live's current scale — or chord names, voiced and timed by the server into one
  `clip_create` call) and `drum_beat` (a style's step patterns as one `clip_create`, with a kit
  from `sample_search` + `drum_kit_build` when the pads are empty). Arguments are optional;
  `style`, `voicing` and track names have completions.
- On `initialize` the server sends short **instructions** (a digest of the
  [skill](#skills), kept in `src/instructions.md`): ids, beats, pitch and volume conventions,
  and what the API cannot do. Clients that support server instructions (Claude Code) add them
  to the agent's prompt.
- Every tool has a **title and MCP annotations**, so clients can auto-approve reads and single
  out destructive calls:
  - read-only (`readOnlyHint`): the `*_get` tools, `midi_clip_get_notes`, `parameter_find`,
    `device_preset_list`, `session_grid`, `song_audit`, `selection_wait`, `sample_search`,
    `dialog_result`, `batch_read` (it refuses steps that are not read-only);
  - setters (`*_set`): non-destructive, idempotent — except `parameter_set` and `device_set`,
    which take `delta` (added to the current value on every call), so they are not idempotent;
  - creators (`*_create`, `*_duplicate`, `*_insert*`, `import_file`, `render_track_audio` —
    `persist` copies the render into the project): non-destructive;
  - destructive (`destructiveHint`): the deletes, `track_clear_clips_in_range`,
    `midi_clip_set_notes`, `midi_clip_edit_notes`, `simpler_replace_sample`, `device_copy` and
    `clip_copy` (`move` deletes the original), `device_preset_load` and `drum_kit_build` (replace
    Simpler samples), `device_preset_save` (`overwrite` replaces a preset),
    `arrangement_copy_range` (overwrites its target range), `audio_track_consolidate` (clears
    its range), `batch` (as destructive as its steps);
  - `show_dialog` (non-destructive) and `execute_command` (destructive) are open-world.

## Security

The endpoint binds to `127.0.0.1` only, so other computers cannot reach it; every program on
this computer can. Requests go through these checks, in order:

1. **Host and Origin** (DNS rebinding): the `Host` header must be `127.0.0.1`, `localhost` or
   `[::1]` (any port), and an `Origin` header, if sent, must be an `http(s)` origin on one of
   those hosts (`Origin: null` is refused). Anything else gets `403` with a JSON-RPC error, on
   every path. MCP clients such as Claude Code and `mcp-remote` send a loopback `Host` and no
   `Origin`, so they are unaffected.
2. `GET /health` answers without a token: `ok`, `name`, `version`, `host_api_version`,
   `tool_count`, `read_only`, `auth_required` and `uptime_s` — no paths, no settings beyond
   those, never the token (`503` and `ok: false` while config.json locks `/mcp`).
3. **Bearer token** (optional, `auth_token` in config.json): `/mcp` then answers `401` with
   `WWW-Authenticate: Bearer` unless the request carries `Authorization: Bearer <token>` — before
   anything else about the request is looked at, its method and body included. The server keeps
   only the token's SHA-256 digest and compares digests with `crypto.timingSafeEqual`. The token
   itself is stored **in plaintext** in `config.json`: anyone who can read that file (your user
   account) can use it, so treat the file like a password, and pick a long random token (at
   least 16 visible ASCII characters). It keeps out other users and programs that can reach the
   port but not your files.
4. A `config.json` with an invalid security setting answers `503` with the reason (see
   [Configuration](#configuration)).
5. `/mcp` only serves `POST` (`GET`/`DELETE` answer `405`, `Allow: POST`; the server is
   stateless); request bodies over 4 MiB are refused with `413`.

To limit what a connected agent can do at all, set `read_only` or `disabled_tools` (see
[Configuration](#configuration)): switched-off tools are not registered, so neither a direct
call nor `batch` can reach them.

## Tools

### Song
| Tool | Description |
|------|-------------|
| `song_get` | Live Set state: tempo, scale, grid, tracks (with `index`, group hierarchy: `depth`, `is_group`, `child_track_ids`), return/main tracks, scenes, cue points, environment info (incl. `server_version`). The entry point — returns the object ids used everywhere else. `include` fetches only selected sections; the opt-in `devices`, `mixer` and `clips` add every track's device tree (with on-states), mixer values and clips in one call (capped, see `truncated`). |
| `song_set` | Set song properties (tempo). |
| `song_audit` | Read-only check for missing media files (audio clips, Simpler samples), Simplers without a sample, empty drum pads and duplicate track names, each entry with ids and location. |

### Tracks
| Tool | Description |
|------|-------------|
| `track_get` | Track detail: clip slots + clips, take lanes, arrangement clips, devices, mixer with values. Address by `track_id`, `track_index`, or `track_name`; `include` selects sections. Group tracks have `is_group: true` (their `type` is `other`). |
| `track_set` | Name / mute / solo / arm, by id, index or name; `items` changes many tracks in one undo step. |
| `track_create` | New audio or MIDI track, optionally with a `name` and `devices` (names, or `{name, parameters}` with initial values). Returns the track's `index` (Live inserts it after the selected track); a failing device is reported in `errors` instead of failing the call. |
| `track_delete` | Delete track (by id, index, or exact name). |
| `track_duplicate` | Duplicate track. |
| `track_clear_clips_in_range` | Delete/truncate arrangement clips in a beat range. |
| `take_lane_create` | Add a take lane to a track. |
| `take_lane_set` | Rename take lanes (`items` for several, one undo step). |

Every tool above except `take_lane_set` takes the track as `track_id`, `track_index` or `track_name`.

### Scenes, session & arrangement
| Tool | Description |
|------|-------------|
| `scene_get` | One session row: a scene (by id, index or name) with every regular track's clip slot and clip in it (`only_clips` drops the empty ones). |
| `session_grid` | The Session View as a compact track × scene matrix (`null` or a brief clip per cell); narrow with `tracks` and `scene_index_min`/`scene_index_max`. |
| `arrangement_get` | A beat range of the arrangement (`start_time`/`end_time`, default the whole song): cue points in it and each track's overlapping clips (`tracks` to pick, `include_take_lanes` for take lanes), plus a derived `song_end`. |
| `arrangement_copy_range` | Copy a beat range of the arrangement to `to_time` on every audio/MIDI track (or `tracks`), overwriting the target range (cleared first; no insert-time). MIDI clips crossing the range edges are trimmed, audio clips crossing them skipped and listed; `include_cue_points` copies the locators too. |
| `scene_create` / `scene_set` / `scene_delete` / `scene_duplicate` | Manage scenes, addressed by `scene_id`, `scene_index` or `scene_name` (exact for delete). `scene_create` takes a `name`, or `items` to create several in order; `scene_set` renames many with `items` in one undo step. |
| `cue_point_create` / `cue_point_set` / `cue_point_delete` | Manage arrangement locators. Create with a `name`, or several with `items`. `cue_point_set` renames (`items` for many) and moves: with `time` it re-creates the locator at the new position with its name, deletes the old one and returns the new id plus `replaced_id`. |

### Clips
| Tool | Description |
|------|-------------|
| `clip_create` | Create MIDI or audio clips in a session slot (by id, or track + `scene_index`/`scene_id`/`scene_name`), arrangement track, or take lane. The track can be given as `target_id` or `track_id`/`track_index`/`track_name`. MIDI clips take inline `notes`, step `patterns` and `repeat` (and ignore the audio-only `file_path`/`is_warped`/`loop_settings`, with a `warning`); `name`/`color` apply at creation. Audio files are imported into the project automatically. |
| `clip_get` | Full clip detail (audio: warp settings + markers; MIDI: note count) and its `location`: session (track, scene, slot), arrangement (track) or take lane. |
| `clip_set` | Name, color, mute, looping, warping, warp mode — for one clip, several (`items`), or every clip of a track (`select: {track_name, scope, name_contains}`), in one undo step. |
| `clip_delete` | Delete a session or arrangement clip. |
| `clip_copy` | Copy a clip to an empty session slot, an arrangement position or a take lane (`move: true` deletes the source afterwards). MIDI notes are re-based from the source's markers/loop and repeated to fill a longer `duration` (a session copy loops its whole length: `lost` says when that repeats differently from the source); audio copies keep file, warping, warp mode and markers/loop but are re-warped by Live (`fidelity`, `lost`, `warp_markers_match`, `differs`). |
| `midi_clip_get_notes` | Read MIDI notes: all, or those matching `select` (pitch/time range, `in_scale`, `every_nth`, `only_selected`); `format: "compact"` returns tuples. Notes carry `selected` when Live reports it. |
| `midi_clip_set_notes` | Write notes: `replace` all or `merge` (layer on top); step `patterns` and `repeat` write repetitive parts in a few characters. |
| `midi_clip_edit_notes` | Server-side note transforms — transpose, snap to scale, set fields, velocity scale/offset, time-shift, quantize (beats or Live's grid), swing, duration set/scale, legato, seeded humanize, delete — on the notes matching `select`, for one clip or several (`clip_ids`, one undo step). No read-modify-write roundtrip. |

### Devices & racks
| Tool | Description |
|------|-------------|
| `device_get` | Device detail: parameters with ranges/value items (`parameter_filter` substring, `include_values`, `include_value_items`), rack chains (`include_chain_devices` inlines pad devices), Simpler sample, and its `location` (track, path through racks, position). |
| `device_insert` | Insert a built-in Live device into a track (by id, index or name) or rack chain, optionally with initial `parameters` (one more undo step); a Simpler can load a `sample_path` (imported into the project by default; removed again if the sample fails). |
| `device_set` | Switch a device on/off (`enabled`: its "Device On" parameter, or a two-state first parameter as a reported fallback) and set several of its parameters by name, `value_item`, `reset` or `delta` — one undo step. The device is `device_id` or track + `device` (name, index or rack path). |
| `device_delete` / `device_duplicate` | Remove or copy devices (the duplicate lands right after the original). |
| `device_copy` | Copy a device to another track or chain, or with `move: true` move/reorder it: inserts the built-in device by name and copies parameter values by name (Simpler: and its sample). Lossy — automation, mappings and non-parameter state are lost, ids change; racks are refused. |
| `device_preset_save` / `device_preset_load` / `device_preset_list` | Named parameter snapshots (plus a Simpler's sample path) stored as JSON under the extension's storage directory. Load onto an existing device or insert a new one. Not Live presets. |
| `chain_get` | Rack chain detail: devices + chain mixer and `location`; drum chains report `receiving_note` and `receiving_note_name`. |
| `rack_insert_chain` | Add a chain to a rack. |
| `drum_chain_set` | Set the MIDI note of a drum rack pad (a number or a name like `"D1"`). |
| `simpler_replace_sample` | Swap the sample in a Simpler; `import_into_project: true` (recommended; default `false`, as before the option existed) imports the file into the project first and loads the copy. |
| `drum_kit_build` | Build or update a Drum Rack kit from sample files: per pad `{note, sample_path, volume?, panning?}` the chain receiving the note is reused or created, a Simpler inserted, the sample imported and loaded. All paths are checked first; later per-pad failures are reported per pad. The rack is `rack_device_id`, or a MIDI track's Drum Rack (inserted when missing). |

### Parameters & mixing
| Tool | Description |
|------|-------------|
| `parameter_get` | Read device/mixer parameter values (batch) by id or by `{track, device, parameter}`; quantized parameters report their `value_item`. |
| `parameter_set` | Write parameter values (batch, single undo step, nothing written if any entry is invalid): each entry by id or `{track, device, parameter}` with one of `value`, `value_item`, `reset` or `delta`. |
| `parameter_find` | Search parameter names (and quantized choices) across the set, a track or a device, through racks; returns ids, devices and readable paths. |
| `mixer_get` | Volume / pan / sends of a track (by id, index or name) or chain, with parameter ids and unit hints. |
| `mixer_set` | Set volume / pan / sends (by index or `return_name`) in one undo step: one track or chain, the same values on several (`targets`) or on every track (`all_tracks` minus `exclude`), or per-target values (`items`). `all_tracks` sets volume on the top-most tracks only (a group covers its tracks, which keep their volume: `skipped`, or `volume_skipped` when they get panning or sends); panning and sends go to every track, grouped ones included. An excluded group keeps its tracks, and a group holding an excluded track is skipped while its other tracks are set; the result lists what was `skipped` and why. |

### Files & rendering
| Tool | Description |
|------|-------------|
| `import_file` | Copy a file into the Live project. |
| `render_track_audio` | Render the pre-FX audio of an audio track (by id, index or name; clip audio before the device chain) to a WAV in the extension's temp directory, which may be cleaned — `persist: true` imports it into the project. Not normalized since Live 12.4.15. `analyze: true` adds overall and per-channel peak/RMS in dBFS, clipped samples, a silence flag and a 32-part envelope; `tracks` renders several audio tracks. |
| `audio_track_consolidate` | Render a range of an audio track (pre-FX), import it, clear the range and create one unwarped clip of the render there, optionally named and colored — Live's Consolidate for comps. Destructive. |
| `sample_search` | Find audio files by words in their path, read-only, in the `sample_roots` of config.json and Live's User Library / Factory Packs folders; confined to those folders, with depth, time and result limits. |

### Selection
| Tool | Description |
|------|-------------|
| `selection_get` | The selection the user last handed over with the context-menu entry "MCP: Use as selection": ids, summaries and locations of the clicked object or selected clip slots, or an arrangement time selection (start/end beats, selected lanes with their overlapping clips). |
| `selection_wait` | Wait (up to `timeout_s` ≤ 55 s) for the user's next "MCP: Use as selection", then return it like `selection_get`. |

### UI & commands
| Tool | Description |
|------|-------------|
| `show_dialog` | Show a modal dialog inside Live: a `form` (title, message, text/number/checkbox/select fields, buttons) answered as JSON (`choice`, `values`), your own `html`, or an https:/file:/localhost `url`. `wait: false` returns a `dialog_id` at once. One dialog at a time; dialogs keep no state between calls. |
| `dialog_result` | The answer of a dialog (by `dialog_id`, default the last one): open, closed with the answer, or failed; waits up to `wait_s` ≤ 50 s for an open one. Kept 10 minutes after closing. |
| `execute_command` | Invoke Extension Host commands, e.g. `ableton-live-mcp.status`. |

### Batches
| Tool | Description |
|------|-------------|
| `batch` | Run up to 50 tool calls in order (`steps: [{tool, args, as?}]`); `{"$ref": "<step>.<path>"}` passes an earlier step's result on. Names, `$ref`s and ref-free arguments are checked first; each step is its own undo step; `on_error` stop (default) or continue. Not for `show_dialog`, `execute_command` or the batch tools. |
| `batch_read` | The same for read-only tools only (any other step is refused); continues after a failed step by default. |

### Resources
| URI | Content |
|-----|---------|
| `live://song` | JSON: `song_get` without arguments (tempo, scale, grid, tracks, return/main tracks, scenes, cue points, environment). |
| `live://tracks/{track}` | JSON: `track_get` for the track named `{track}` (percent-encoded; exact name first, then case-insensitive; regular, return and main tracks). Listed per uniquely named track, with name completions. |
| `live://guide` | Markdown: the full agent guide (`skills/ableton-live/SKILL.md`). |

### Prompts
| Prompt | Arguments (all optional) | Produces |
|--------|--------------------------|----------|
| `song_skeleton` | `sections` (`"Intro:8, Verse:16, Chorus"`), `tempo`, `beats_per_bar`, `tracks` (`"Drums, Vox:audio"`) | `song_get` check, `song_set`, one `scene_create` and one `cue_point_create` with computed positions, `track_create` per track, then `session_grid` / `arrangement_get` to verify. |
| `chord_progression` | `progression` (`"ii7 V7 Imaj7"`, `"Am F C/E"`), `key` (default Live's scale), `bars_per_chord`, `beats_per_bar`, `octave`, `voicing` (`close`/`root`), `track` | The chords spelled and voiced, a track with an instrument if needed, and one `clip_create` with every note. |
| `drum_beat` | `style` (house, techno, hip_hop, trap, dnb, breakbeat, rock, reggaeton), `bars`, `track`, `tempo`, `swing` | The pattern per pad, `sample_search` + `drum_kit_build` for empty pads, one `clip_create` with step `patterns` and `repeat`, swing for swung styles. |

## Skills

`skills/ableton-live/SKILL.md` is an installable [agent skill](https://docs.claude.com/en/docs/claude-code/skills)
that teaches an MCP client how to use these tools well (id discovery flow, beats vs. seconds,
note-editing patterns, device workflows). The server sends a short digest of it as MCP
instructions anyway; the full skill adds the detailed workflows. Install it for Claude Code with:

```bash
mkdir -p ~/.claude/skills && cp -r skills/ableton-live ~/.claude/skills/
```

Typical things you can ask a connected assistant to do:

- "Create a 4-bar house drum pattern on a new MIDI track with a Drum Rack"
- "Warp all clips on the Drums track in Complex Pro mode"
- "Turn down every track that isn't the vocal bus by 3 dB"
- "Build a song skeleton: intro, verse, chorus scenes with locators"
- "Replace the sample in Simpler with /path/to/kick.wav and map it to C1"
- "Build an 8-pad kit from the 808 samples in my sample folder" (`sample_search`, then `drum_kit_build`)
- "Repeat the chorus at bar 33" / "Put this clip in the arrangement at bar 17" (`arrangement_copy_range`, `clip_copy`)
- "Is the vocal take clipping anywhere?" (`render_track_audio {analyze: true}`)
- "Bypass the compressor on the vocals and switch the bass filter to high-pass"
- "Move the reverb before the EQ" (a lossy copy-and-delete: see `device_copy`)
- "What happens in bars 17 to 33?" / "Check the set for missing samples"
- "Quantize the clip I selected" (after right-clicking it → "MCP: Use as selection")
- "Delete the unused scenes, but ask me in Live first" (`show_dialog {form, wait: false}`, `dialog_result`)

## Limitations

- The extension (and thus the MCP endpoint) only runs while Live is open.
- Only built-in Live devices can be inserted; third-party plug-ins can't be loaded by the SDK.
  Devices cannot be moved, renamed or loaded from Live presets: `device_copy` and the JSON
  `device_preset_*` tools rebuild a device from its parameter values only.
- No transport control (play/stop/record) or clip launching — the Extensions API v1.0.0 does not
  expose them. Same for browser access, parameter automation curves, track color, routing and
  sidechain, reordering or grouping tracks, creating return tracks, metering, editing clip
  markers or loops after creation, and the song time signature.
- The user's selection can't be read directly: it is only available once the user hands it over
  with the "MCP: Use as selection" context-menu entry.
- Clips can't be copied, moved or trimmed by the API: `clip_copy` and `arrangement_copy_range`
  create new clips. Audio copies are re-warped by Live (warp markers can't be set), clip
  envelopes, groove and launch settings are lost, and time can't be inserted into the
  arrangement. Racks can't delete chains, so `drum_kit_build` keeps a chain it created even if
  its pad fails.
- `sample_search` only sees the folders it is given (`sample_roots`) and Live's default library
  folders — the API has no browser access.
- Dialogs are modal: they block Live's UI until the user closes them, and Live can't close them
  from code. A `show_dialog` call waits by default (`wait: false` + `dialog_result` don't).
- `batch` is not atomic: each step is its own undo step, and a failing step leaves the earlier
  ones applied. Live's `withinTransaction` only groups synchronous changes, so steps that wait for
  Live can't share one undo step.

## Tests

```bash
npm test                  # E2E against a mock Extension Host: MCP client ↔ HTTP ↔ all tools,
                          # resources and prompts, extra instances for the config.json switches,
                          # then the bundle loaded in a bare VM context (test/vm-context.mjs)
node test/live-smoke.mjs  # against a real running Live with the extension loaded
                          # (MCP_TOKEN=<token> when config.json sets an auth_token)
```

The prompts' tool calls are checked by running them: every `` `tool {json}` `` in a prompt's text
without a `"<...>"` placeholder is called against the mock, and every tool in `tools/list` must
appear in README.md's tool tables and in the skill.

`test/vm-context.mjs` evaluates `dist/extension.cjs` the way the Extension Host does (no
`global`, no web globals), so a broken `build.ts` banner fails CI instead of failing in Live. It
also runs an SSE (progress) response inside that context; the real Extension Host has not been
tested with SSE responses yet (`test/live-smoke.mjs` checks them against Live) — if long calls
fail there, set `"progress_notifications": false`.

The live smoke test creates its own tracks/clips/devices, verifies every tool family
(MIDI notes, warping, drum racks, rendering, ...), and deletes everything it created.

## Extension Host quirks (worth knowing)

Two behaviors of the beta Extension Host that this project works around:

1. **Bare VM context.** Extensions are evaluated in a V8 context without `global` or web
   globals (`Request`, `Response`, `ReadableStream`, `fetch`, `EventTarget`, ...), which the
   MCP SDK needs at load time. `build.ts` injects a banner that pulls them in from the main
   Node context (core-module functions are shared, so their `Function` constructor evaluates
   there). See `build.ts` for details.
2. **bigint numerics.** The host returns `bigint` for some values the SDK types as `number`
   (clip colors, note pitches, ...). `src/serialize.ts` normalizes with `num()` before
   arithmetic/JSON.
3. **Asynchronous writes.** SDK property setters (notes, names, values) return before Live
   has applied the change; a read within a few tens of ms can return the previous state.
   Agents rarely notice, but read-after-write tests must retry briefly
   (see `eventually()` in `test/live-smoke.mjs`).

Also: if the dev Extension Host crashes, Live may refuse the next control-channel handshake
("bring-up timed out") — restart Live and run `npm start` again.

## Troubleshooting

- **Endpoint not responding**: check `curl http://127.0.0.1:8722/health`. Right-click any
  track in Live — the "Ableton Live MCP: Status" context-menu action shows the endpoint the
  extension actually bound, or why it failed to start, and the path of its `config.json`.
- **`selection_get` returns an error per item**: the object was deleted or moved after the user
  chose "MCP: Use as selection", or Live passed something the extension could not resolve —
  ask the user to select again.
- **Port already in use**: if another process holds the configured port, the server logs the
  failure to `ExtensionHost.txt` and does not start; the Status dialog shows the error
  (`EADDRINUSE`) and the `config.json` path. Change `port` there — the file is read once at
  startup, so restart Live afterwards.
- **403 Forbidden**: the request's `Host` or `Origin` is not a loopback address (see
  [Security](#security)). Connect to `http://127.0.0.1:<port>/mcp` or `http://localhost:<port>/mcp`.
- **401 Unauthorized**: `config.json` has an `auth_token` and the client did not send it as
  `Authorization: Bearer <token>` (see [Connect a client](#connect-a-client)).
- **503 Service unavailable**: a security setting in `config.json` (`read_only`,
  `disabled_tools`, `auth_token`) is invalid or misspelled, or the file exists but cannot be read
  or parsed; the error and the Status dialog say which. Fix it and restart Live.
- **A tool is missing**: `read_only` or `disabled_tools` in `config.json` switched it off.
- **"A dialog is already open in Live"**: the server shows one dialog at a time. `dialog_result`
  returns the open one's answer once the user closes it; if the user did close it and Live
  never reported it, `show_dialog {force: true}` opens the next one anyway.
- **Failed tool calls** are logged to `ExtensionHost.txt` with the tool name, duration and
  error message (never the arguments).
- **Changed config.json but nothing happened**: config is only read when the extension
  starts (`sample_roots` excepted). Restart Live (or the dev Extension Host). Invalid values are
  logged with the prefix `[ableton-live-mcp] config:` and listed in the Status dialog.

## License

MIT for the code in this repository. The `vendor/` tarballs (Ableton Extensions SDK & CLI) are
Ableton's and covered by their own license (see `sdk/LICENSE.md` in the SDK distribution).
