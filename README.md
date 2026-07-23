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

- Ableton Live 12 with Extensions support (Live 12.4+ / the Extensions-enabled beta)
- Node.js >= 24.14 (build only)

## Install

```bash
npm install
npm run package        # builds and produces Ableton-Live-MCP-1.0.0.ablx
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

## How it works

- Every Live object (track, clip, device, parameter, ...) is addressed by a stable **object id**
  discovered through listing tools (`song_get`, `track_get`, `device_get`, ...).
- Ids stay valid until the object is deleted or moved, or another Live Set is loaded. Stale ids
  return an error telling the client to re-list.
- All times/positions are in **beats**; colors are `#RRGGBB`; MIDI pitches are 0–127.
- Multi-value writes (`parameter_set`) are grouped into a single undo step in Live.

## Tools

### Song
| Tool | Description |
|------|-------------|
| `song_get` | Full Live Set state: tempo, scale, grid, tracks, return/main tracks, scenes, cue points, environment info. The entry point — returns the object ids used everywhere else. |
| `song_set` | Set song properties (tempo). |

### Tracks
| Tool | Description |
|------|-------------|
| `track_get` | Full track detail: clip slots + clips, take lanes, arrangement clips, devices, mixer with values. |
| `track_set` | Name / mute / solo / arm. |
| `track_create` | New audio or MIDI track. |
| `track_delete` | Delete track. |
| `track_duplicate` | Duplicate track. |
| `track_clear_clips_in_range` | Delete/truncate arrangement clips in a beat range. |
| `take_lane_create` | Add a take lane to a track. |
| `take_lane_set` | Rename a take lane. |

### Scenes & cue points
| Tool | Description |
|------|-------------|
| `scene_create` / `scene_set` / `scene_delete` / `scene_duplicate` | Manage scenes. |
| `cue_point_create` / `cue_point_set` / `cue_point_delete` | Manage arrangement locators. |

### Clips
| Tool | Description |
|------|-------------|
| `clip_create` | Create MIDI or audio clips in a session slot, arrangement track, or take lane. Audio files are imported into the project automatically. |
| `clip_get` | Full clip detail (audio: warp settings + markers; MIDI: note count). |
| `clip_set` | Name, color, mute, looping, warping, warp mode. |
| `clip_delete` | Delete a session or arrangement clip. |
| `midi_clip_get_notes` | Read all MIDI notes. |
| `midi_clip_set_notes` | Replace all MIDI notes (read–modify–write for edits). |

### Devices & racks
| Tool | Description |
|------|-------------|
| `device_get` | Device detail: all parameters with ranges/value items, rack chains, Simpler sample. |
| `device_insert` | Insert a built-in Live device into a track or rack chain. |
| `device_delete` / `device_duplicate` | Remove or copy devices. |
| `chain_get` | Rack chain detail: devices + chain mixer. |
| `rack_insert_chain` | Add a chain to a rack. |
| `drum_chain_set` | Set the MIDI note of a drum rack pad. |
| `simpler_replace_sample` | Swap the sample in a Simpler. |

### Parameters & mixing
| Tool | Description |
|------|-------------|
| `parameter_get` | Read device/mixer parameter values (batch). |
| `parameter_set` | Write parameter values (batch, single undo step). |
| `mixer_get` | Volume / pan / sends of a track or chain, with parameter ids. |

### Files & rendering
| Tool | Description |
|------|-------------|
| `import_file` | Copy a file into the Live project. |
| `render_track_audio` | Render pre-FX audio of an audio track to a WAV. |

### UI & commands
| Tool | Description |
|------|-------------|
| `show_dialog` | Show a modal HTML dialog inside Live (ask the user, show reports). |
| `execute_command` | Invoke Extension Host commands, e.g. `ableton-live-mcp.status`. |

## Skills

`skills/ableton-live/SKILL.md` is an installable [agent skill](https://docs.claude.com/en/docs/claude-code/skills)
that teaches an MCP client how to use these tools well (id discovery flow, beats vs. seconds,
note-editing patterns, device workflows). Install it for Claude Code with:

```bash
mkdir -p ~/.claude/skills && cp -r skills/ableton-live ~/.claude/skills/
```

Typical things you can ask a connected assistant to do:

- "Create a 4-bar house drum pattern on a new MIDI track with a Drum Rack"
- "Warp all clips on the Drums track in Complex Pro mode"
- "Turn down every track that isn't the vocal bus by 3 dB"
- "Build a song skeleton: intro, verse, chorus scenes with locators"
- "Replace the sample in Simpler with /path/to/kick.wav and map it to C1"

## Limitations

- The extension (and thus the MCP endpoint) only runs while Live is open.
- Only built-in Live devices can be inserted; third-party plug-ins can't be loaded by the SDK.
- No transport control (play/stop/record) or clip launching — the Extensions API v1.0.0 does not
  expose them. Same for browser access and parameter automation curves.
- `show_dialog` blocks until the user closes the dialog in Live.

## Tests

```bash
npm test                  # E2E against a mock Extension Host: MCP client ↔ HTTP ↔ all tools
node test/live-smoke.mjs  # against a real running Live with the extension loaded
```

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

Also: if the dev Extension Host crashes, Live may refuse the next control-channel handshake
("bring-up timed out") — restart Live and run `npm start` again.

## License

MIT for the code in this repository. The `vendor/` tarballs (Ableton Extensions SDK & CLI) are
Ableton's and covered by their own license (see `sdk/LICENSE.md` in the SDK distribution).
