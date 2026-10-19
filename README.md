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
Live at `http://127.0.0.1:8722/mcp` (`GET /health` for a quick check).

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

### Configuration

The port is stored in `config.json` inside the extension's storage directory (created on first
run; the path is reported by `song_get` under `environment.storage_directory`). Default:

```json
{ "port": 8722 }
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
- All times/positions are in **beats**; colors are `#RRGGBB`; MIDI pitches are 0–127.
- **Batched writes**: `track_set`, `scene_set`, `cue_point_set`, `clip_set`, `take_lane_set` and
  `mixer_set` take `items: [{<address>, ...values}]` to change many objects in one call.
  `clip_set` also takes `select: {track, scope, name_contains}` (e.g. every clip of the Drums
  track), and `mixer_set` takes `targets` (same values on several mixers) or `all_tracks` with
  `exclude`. Every entry is validated before the first write, and all of a call's changes form
  **one undo step** in Live — as do the multi-value writes of `parameter_set` and `mixer_set`.
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
- **Copy, move and presets** (lossy by design): Live's API cannot move, reorder or copy devices,
  so `device_copy` inserts a fresh built-in device and copies the parameter values by name (a
  Simpler also gets its sample); `move: true` then deletes the original. Automation, mappings, a
  custom device name and non-parameter state are lost, and ids change. `device_preset_save` /
  `device_preset_load` / `device_preset_list` keep the same kind of snapshot as named JSON files
  in the extension's storage directory (`presets/`) — not Live `.adv` presets. Racks are refused
  by both.
- On `initialize` the server sends short **instructions** (a digest of the
  [skill](#skills), kept in `src/instructions.md`): ids, beats, pitch and volume conventions,
  and what the API cannot do. Clients that support server instructions (Claude Code) add them
  to the agent's prompt.
- Every tool has a **title and MCP annotations**, so clients can auto-approve reads and single
  out destructive calls:
  - read-only (`readOnlyHint`): the `*_get` tools, `midi_clip_get_notes`, `parameter_find`,
    `device_preset_list`, `render_track_audio` (it only writes a temp file);
  - setters (`*_set`): non-destructive, idempotent;
  - creators (`*_create`, `*_duplicate`, `*_insert*`, `import_file`): non-destructive;
  - destructive (`destructiveHint`): the deletes, `track_clear_clips_in_range`,
    `midi_clip_set_notes`, `midi_clip_edit_notes`, `simpler_replace_sample`, `device_copy`
    (`move` deletes the original), `device_preset_load` (replaces a Simpler's sample),
    `device_preset_save` (`overwrite` replaces a preset);
  - `show_dialog` (non-destructive) and `execute_command` (destructive) are open-world.

## Security

The endpoint binds to `127.0.0.1` only and has no authentication. To stop web pages from
reaching it through DNS rebinding, every request is checked before routing: the `Host` header
must be `127.0.0.1`, `localhost` or `[::1]` (any port), and an `Origin` header, if sent, must
be an `http(s)` origin on one of those hosts (`Origin: null` is refused). Anything else gets
`403` with a JSON-RPC error. MCP clients such as Claude Code and `mcp-remote` send a loopback
`Host` and no `Origin`, so they are unaffected.

The server is stateless: only `POST /mcp` is served (`GET`/`DELETE` answer `405`,
`Allow: POST`), plus `GET /health`.

## Tools

### Song
| Tool | Description |
|------|-------------|
| `song_get` | Live Set state: tempo, scale, grid, tracks, return/main tracks, scenes, cue points, environment info. The entry point — returns the object ids used everywhere else. `include` fetches only selected sections. |
| `song_set` | Set song properties (tempo). |

### Tracks
| Tool | Description |
|------|-------------|
| `track_get` | Track detail: clip slots + clips, take lanes, arrangement clips, devices, mixer with values. Address by `track_id`, `track_index`, or `track_name`; `include` selects sections. |
| `track_set` | Name / mute / solo / arm, by id, index or name; `items` changes many tracks in one undo step. |
| `track_create` | New audio or MIDI track, optionally with a `name` and `devices` (names, or `{name, parameters}` with initial values). Returns the track's `index` (Live inserts it after the selected track); a failing device is reported in `errors` instead of failing the call. |
| `track_delete` | Delete track (by id, index, or exact name). |
| `track_duplicate` | Duplicate track. |
| `track_clear_clips_in_range` | Delete/truncate arrangement clips in a beat range. |
| `take_lane_create` | Add a take lane to a track. |
| `take_lane_set` | Rename take lanes (`items` for several, one undo step). |

Every tool above except `take_lane_set` takes the track as `track_id`, `track_index` or `track_name`.

### Scenes & cue points
| Tool | Description |
|------|-------------|
| `scene_create` / `scene_set` / `scene_delete` / `scene_duplicate` | Manage scenes, addressed by `scene_id`, `scene_index` or `scene_name` (exact for delete). `scene_create` takes a `name`, or `items` to create several in order; `scene_set` renames many with `items` in one undo step. |
| `cue_point_create` / `cue_point_set` / `cue_point_delete` | Manage arrangement locators. Create with a `name`, or several with `items`. `cue_point_set` renames (`items` for many) and moves: with `time` it re-creates the locator at the new position with its name, deletes the old one and returns the new id plus `replaced_id`. |

### Clips
| Tool | Description |
|------|-------------|
| `clip_create` | Create MIDI or audio clips in a session slot (by id, or track + `scene_index`/`scene_id`/`scene_name`), arrangement track, or take lane. The track can be given as `target_id` or `track_id`/`track_index`/`track_name`. MIDI clips take inline `notes` (and reject the audio-only `file_path`/`is_warped`/`loop_settings`); `name`/`color` apply at creation. Audio files are imported into the project automatically. |
| `clip_get` | Full clip detail (audio: warp settings + markers; MIDI: note count). |
| `clip_set` | Name, color, mute, looping, warping, warp mode — for one clip, several (`items`), or every clip of a track (`select: {track_name, scope, name_contains}`), in one undo step. |
| `clip_delete` | Delete a session or arrangement clip. |
| `midi_clip_get_notes` | Read all MIDI notes. |
| `midi_clip_set_notes` | Write notes: `replace` all or `merge` (layer on top). |
| `midi_clip_edit_notes` | Server-side note transforms — transpose, time-shift, velocity scale/offset, quantize, delete — with pitch/time selection. No read-modify-write roundtrip. |

### Devices & racks
| Tool | Description |
|------|-------------|
| `device_get` | Device detail: parameters with ranges/value items (`parameter_filter` substring, `include_values`, `include_value_items`), rack chains (`include_chain_devices` inlines pad devices), Simpler sample. |
| `device_insert` | Insert a built-in Live device into a track (by id, index or name) or rack chain, optionally with initial `parameters` (one more undo step). |
| `device_set` | Switch a device on/off (`enabled`: its "Device On" parameter, or a two-state first parameter as a reported fallback) and set several of its parameters by name, `value_item`, `reset` or `delta` — one undo step. The device is `device_id` or track + `device` (name, index or rack path). |
| `device_delete` / `device_duplicate` | Remove or copy devices (the duplicate lands right after the original). |
| `device_copy` | Copy a device to another track or chain, or with `move: true` move/reorder it: inserts the built-in device by name and copies parameter values by name (Simpler: and its sample). Lossy — automation, mappings and non-parameter state are lost, ids change; racks are refused. |
| `device_preset_save` / `device_preset_load` / `device_preset_list` | Named parameter snapshots (plus a Simpler's sample path) stored as JSON under the extension's storage directory. Load onto an existing device or insert a new one. Not Live presets. |
| `chain_get` | Rack chain detail: devices + chain mixer. |
| `rack_insert_chain` | Add a chain to a rack. |
| `drum_chain_set` | Set the MIDI note of a drum rack pad. |
| `simpler_replace_sample` | Swap the sample in a Simpler. |

### Parameters & mixing
| Tool | Description |
|------|-------------|
| `parameter_get` | Read device/mixer parameter values (batch) by id or by `{track, device, parameter}`; quantized parameters report their `value_item`. |
| `parameter_set` | Write parameter values (batch, single undo step, nothing written if any entry is invalid): each entry by id or `{track, device, parameter}` with one of `value`, `value_item`, `reset` or `delta`. |
| `parameter_find` | Search parameter names (and quantized choices) across the set, a track or a device, through racks; returns ids, devices and readable paths. |
| `mixer_get` | Volume / pan / sends of a track (by id, index or name) or chain, with parameter ids and unit hints. |
| `mixer_set` | Set volume / pan / sends (by index or `return_name`) in one undo step: one track or chain, the same values on several (`targets`) or on every track (`all_tracks` minus `exclude`), or per-target values (`items`). `all_tracks` sets the top-most tracks only: a group covers its tracks, an excluded group keeps its tracks, and a group holding an excluded track is skipped while its other tracks are set; the result lists what was `skipped` and why. |

### Files & rendering
| Tool | Description |
|------|-------------|
| `import_file` | Copy a file into the Live project. |
| `render_track_audio` | Render the pre-FX audio of an audio track (by id, index or name; clip audio before the device chain) to a WAV in the extension's temp directory, which may be cleaned — import it to keep it. Not normalized since Live 12.4.15. |

### UI & commands
| Tool | Description |
|------|-------------|
| `show_dialog` | Show a modal HTML dialog inside Live (ask the user, show reports). Dialogs keep no state between calls. |
| `execute_command` | Invoke Extension Host commands, e.g. `ableton-live-mcp.status`. |

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
- "Bypass the compressor on the vocals and switch the bass filter to high-pass"
- "Move the reverb before the EQ" (a lossy copy-and-delete: see `device_copy`)

## Limitations

- The extension (and thus the MCP endpoint) only runs while Live is open.
- Only built-in Live devices can be inserted; third-party plug-ins can't be loaded by the SDK.
  Devices cannot be moved, renamed or loaded from Live presets: `device_copy` and the JSON
  `device_preset_*` tools rebuild a device from its parameter values only.
- No transport control (play/stop/record) or clip launching — the Extensions API v1.0.0 does not
  expose them. Same for browser access, parameter automation curves, track color, routing and
  sidechain, reordering or grouping tracks, creating return tracks, metering, editing clip
  markers or loops after creation, and the song time signature.
- `show_dialog` blocks until the user closes the dialog in Live.

## Tests

```bash
npm test                  # E2E against a mock Extension Host: MCP client ↔ HTTP ↔ all tools,
                          # then the bundle loaded in a bare VM context (test/vm-context.mjs)
node test/live-smoke.mjs  # against a real running Live with the extension loaded
```

`test/vm-context.mjs` evaluates `dist/extension.cjs` the way the Extension Host does (no
`global`, no web globals), so a broken `build.ts` banner fails CI instead of failing in Live.

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
- **Port already in use**: if another process holds the configured port, the server logs the
  failure to `ExtensionHost.txt` and does not start; the Status dialog shows the error
  (`EADDRINUSE`) and the `config.json` path. Change `port` there — the file is read once at
  startup, so restart Live afterwards.
- **403 Forbidden**: the request's `Host` or `Origin` is not a loopback address (see
  [Security](#security)). Connect to `http://127.0.0.1:<port>/mcp` or `http://localhost:<port>/mcp`.
- **Failed tool calls** are logged to `ExtensionHost.txt` with the tool name, duration and
  error message (never the arguments).
- **Changed config.json but nothing happened**: config is only read when the extension
  starts. Restart Live (or the dev Extension Host).

## License

MIT for the code in this repository. The `vendor/` tarballs (Ableton Extensions SDK & CLI) are
Ableton's and covered by their own license (see `sdk/LICENSE.md` in the SDK distribution).
