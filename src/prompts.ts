import { z, type ZodRawShape } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { UsageError } from "./errors.js";
import { parsePitchClass } from "./serialize.js";

// MCP prompts: templates a user picks in the client (e.g. "/drum_beat") that
// expand into step-by-step instructions for the agent, written with this
// server's real tools. Prompt arguments are strings (the protocol has no
// other kind) and all optional. Every tool call in a prompt's text is written
// as `tool_name {json args}`, with the values the agent fills in as "<...>"
// strings: test/e2e.mjs runs every call without such a placeholder.

// What a prompt may look at while it is rendered.
export type PromptEnv = {
  // Live's current scale (Song.rootNote / scaleIntervals), or undefined when
  // it cannot be read
  scale(): { root: number; intervals: number[]; name: string } | undefined;
  // track names, for argument completion
  trackNames(): string[];
};

export type PromptDef = {
  name: string;
  title: string;
  description: string;
  // Offered only when the server exposes every one of these tools.
  tools: readonly string[];
  // Fresh schemas per server: completable() marks a schema in place.
  args(env: PromptEnv): ZodRawShape;
  render(args: Record<string, string | undefined>, env: PromptEnv): string;
};

const call = (tool: string, args: object) => `\`${tool} ${JSON.stringify(args)}\``;
const quote = (s: string) => JSON.stringify(s);
const numbered = (steps: string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

// An optional string argument. With `complete`, the client can ask for
// completions: the SDK announces them when the optional's inner schema is
// completable and answers from the field itself, so both carry it.
function arg(description: string, complete?: (value: string) => string[]) {
  if (!complete) return z.string().optional().describe(description);
  const cb = (value: string | undefined) => complete(value ?? "");
  return completable(completable(z.string(), cb).optional().describe(description), cb);
}

// The longest prompt argument: far more than any real one (64 sections of
// 100-character names), and short enough that parsing it stays instant.
// Checked here rather than with a zod max, whose error the SDK reports with
// its "MCP error" prefix twice.
const MAX_ARG_LENGTH = 8000;

// Renders a prompt after checking the arguments' length.
export function renderPrompt(p: PromptDef, args: Record<string, string | undefined>, env: PromptEnv): string {
  for (const [name, value] of Object.entries(args))
    if (typeof value === "string" && value.length > MAX_ARG_LENGTH)
      throw new UsageError(`${name}: at most ${MAX_ARG_LENGTH} characters, got ${value.length}.`);
  return p.render(args, env);
}

const startingWith = (options: string[]) => (value: string) =>
  options.filter((o) => o.toLowerCase().startsWith(value.trim().toLowerCase()));

function intArg(value: string | undefined, what: string, min: number, max: number, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < min || n > max)
    throw new UsageError(`${what}: expected a whole number from ${min} to ${max}, got ${quote(value)}.`);
  return n;
}
function numArg(value: string | undefined, what: string, min: number, max: number): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < min || n > max)
    throw new UsageError(`${what}: expected a number from ${min} to ${max}, got ${quote(value)}.`);
  return n;
}
// A table entry by a user's key: own entries only ("constructor" is none).
const lookup = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
const nameArg = (value: string | undefined, fallback: string) => (value?.trim() ? value.trim() : fallback);
const list = (text: string) =>
  text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
// "name:value" → [name, value], split at the last colon; an entry without a
// colon, or whose value would contain a space, is all name. A plain scan, not
// a regex: a backtracking pattern takes quadratic time on long entries.
function nameValue(entry: string): [string, string | undefined] {
  const i = entry.lastIndexOf(":");
  const value = i < 0 ? "" : entry.slice(i + 1).trim();
  if (i < 0 || /\s/.test(value)) return [entry.trim(), undefined];
  return [entry.slice(0, i).trim(), value];
}

const TRACK_STEP =
  "Live inserts a new track after the selected one, so go by the returned `index`/`id`, not by position";
const SLOT_HINT =
  '`scene_index` 0 is the first scene: use an empty slot (`session_grid` shows them), or for the arrangement ' +
  'replace scene_index with "start_time": <beat>';

// -- song_skeleton -------------------------------------------------------------

const DEFAULT_SECTIONS = "Intro:8, Verse:16, Chorus:16, Verse:16, Chorus:16, Outro:8";
const DEFAULT_SECTION_BARS = 8;

function parseSections(text: string) {
  const sections = list(text).map((entry) => {
    const [name, count] = nameValue(entry);
    if (!name || name.length > 100)
      throw new UsageError(`sections: ${quote(entry)} needs a name of 1-100 characters, e.g. "Verse:16".`);
    const bars = intArg(count, `sections: the bars of ${quote(name)}`, 1, 512, DEFAULT_SECTION_BARS);
    return { name, bars };
  });
  if (!sections.length) throw new UsageError('sections: give at least one, e.g. "Intro:8, Verse:16".');
  if (sections.length > 64) throw new UsageError(`sections: at most 64, got ${sections.length}.`);
  return sections;
}

function parseTracks(text: string) {
  return list(text).map((entry) => {
    const [name, given] = nameValue(entry);
    const type = (given ?? "midi").toLowerCase();
    if (!name || name.length > 100) throw new UsageError(`tracks: ${quote(entry)} needs a name of 1-100 characters.`);
    if (type !== "midi" && type !== "audio")
      throw new UsageError(`tracks: the type of ${quote(name)} is "midi" or "audio", got ${quote(type)}.`);
    return { name, type };
  });
}

const songSkeleton: PromptDef = {
  name: "song_skeleton",
  title: "Song skeleton",
  description:
    "Lay out a song's sections: one scene and one arrangement locator per section (positions computed " +
    "from the bar counts), optionally the tempo and empty tracks.",
  tools: ["song_get", "song_set", "scene_create", "cue_point_create", "track_create", "session_grid", "arrangement_get"],
  args: () => ({
    sections: arg(
      `Sections in order, comma-separated, each "name" or "name:bars" (${DEFAULT_SECTION_BARS} bars without a ` +
        `count); default "${DEFAULT_SECTIONS}"`,
    ),
    tempo: arg("Tempo in BPM (20-999); default: keep the current tempo"),
    beats_per_bar: arg("Beats per bar for the positions (1-32); default 4"),
    tracks: arg('Tracks to create, comma-separated, each "name" (MIDI) or "name:midi" / "name:audio"; default none'),
  }),
  render(a) {
    const sections = parseSections(a.sections?.trim() ? a.sections : DEFAULT_SECTIONS);
    const tempo = numArg(a.tempo, "tempo", 20, 999);
    const perBar = intArg(a.beats_per_bar, "beats_per_bar", 1, 32, 4);
    const tracks = a.tracks?.trim() ? parseTracks(a.tracks) : [];
    let bar = 0;
    const placed = sections.map((s) => {
      const p = { ...s, time: bar * perBar, end: (bar + s.bars) * perBar, bar: bar + 1 };
      bar += s.bars;
      return p;
    });
    const end = bar * perBar;
    const steps = [
      `Read the set: ${call("song_get", { include: ["tracks", "scenes", "cue_points"] })}. If it already has ` +
        "scenes or locators with these names, or locators at these positions, tell the user and ask whether " +
        "to add the new ones anyway, rename or skip them. Never delete anything without asking.",
      tempo !== undefined
        ? `Set the tempo: ${call("song_set", { tempo })}.`
        : "Keep the current tempo; if the user names one, set it with `song_set`.",
      "Create the scenes in one call (they are appended after the existing ones, in this order): " +
        call("scene_create", { items: placed.map((s) => ({ name: s.name })) }),
      "Mark the sections in the arrangement in one call: " +
        call("cue_point_create", { items: placed.map((s) => ({ time: s.time, name: s.name })) }),
    ];
    if (tracks.length)
      steps.push(
        `Create the tracks, one call each (${TRACK_STEP}):\n` +
          tracks.map((t) => `   - ${call("track_create", { type: t.type, name: t.name })}`).join("\n"),
      );
    steps.push(
      `Check the result: ${call("session_grid", {})} and ${call("arrangement_get", { start_time: 0, end_time: end })}, ` +
        "then tell the user what was created, with the positions in bars.",
    );
    return [
      "Build a song skeleton in the open Ableton Live Set with the ableton-live tools: one scene and one " +
        `arrangement locator per section${tracks.length ? ", and the tracks listed below" : ""}.`,
      "",
      `Sections (positions in beats at ${perBar} beats per bar; Live's API cannot read or set the song's time ` +
        "signature, so check that it matches):",
      ...placed.map((s, i) => `${i + 1}. ${s.name}: ${s.bars} bars from bar ${s.bar}, beats ${s.time}-${s.end}`),
      `Total: ${bar} bars = ${end} beats.`,
      ...(tracks.length ? ["", `Tracks: ${tracks.map((t) => `${t.name} (${t.type})`).join(", ")}.`] : []),
      "",
      "Steps:",
      numbered(steps),
      "",
      "Then offer to fill the sections: clips with notes or drum patterns (clip_create), copies (clip_copy, " +
        "arrangement_copy_range).",
    ].join("\n");
  },
};

// -- chord_progression -----------------------------------------------------------

// Chord qualities as semitones above the root.
const QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  "°": [0, 3, 6],
  o: [0, 3, 6],
  aug: [0, 4, 8],
  "+": [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus: [0, 5, 7],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  mMaj7: [0, 3, 7, 11],
  mM7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  "°7": [0, 3, 6, 9],
  o7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  "ø": [0, 3, 6, 10],
  "ø7": [0, 3, 6, 10],
  aug7: [0, 4, 8, 10],
  "+7": [0, 4, 8, 10],
  "7sus4": [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  "9": [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
};

const MODES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic minor": [0, 2, 3, 5, 7, 9, 11],
};
const MODE_ALIASES: Record<string, string> = { "": "major", maj: "major", ionian: "major", m: "minor", min: "minor", aeolian: "minor" };

// Note names spelled with sharps or flats, as the key or chord is usually
// written (Bb major: Bb D F, not A# D F). Octaves in Live's naming, C3 = 60;
// the tools take either spelling.
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const pcName = (pc: number, flats: boolean) => (flats ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
const spell = (pitch: number, flats: boolean) => `${pcName(pitch, flats)}${Math.floor(pitch / 12) - 2}`;
// Roots whose keys have flats in their signature: F Bb Eb Ab Db major, D G C
// F Bb Eb minor. A written accidental decides by itself.
const MAJOR_FLATS = new Set([5, 10, 3, 8, 1]);
const MINOR_FLATS = new Set([2, 7, 0, 5, 10, 3]);
function usesFlats(root: number, intervals: number[], written = "") {
  if (written === "b" || written === "♭") return true;
  if (written === "#" || written === "♯") return false;
  const minor = intervals.includes(3) && !intervals.includes(4);
  return (minor ? MINOR_FLATS : MAJOR_FLATS).has(root);
}

type Key = { root: number; intervals: number[]; name: string; flats: boolean };

function parseKey(text: string): Key {
  const m = /^([A-Ga-g])([#b♯♭]?)([^]*)$/.exec(text.trim());
  const rest = m ? m[3].trim() : "";
  const mode = rest === "M" ? "major" : (lookup(MODE_ALIASES, rest.toLowerCase()) ?? rest.toLowerCase().replace(/\s+/g, " "));
  const intervals = lookup(MODES, mode);
  if (!m || !intervals)
    throw new UsageError(
      `key: ${quote(text)} is not a key: give a root and a mode, e.g. "C major", "A minor", "F#m" or ` +
        `"D dorian" (modes: ${Object.keys(MODES).join(", ")}).`,
    );
  const root = parsePitchClass(m[1].toUpperCase() + m[2], "key");
  const flats = usesFlats(root, intervals, m[2]);
  return { root, intervals, name: `${pcName(root, flats)} ${mode}`, flats };
}

// Live's scale as a key for Roman numerals: a 7-note scale as it is, any
// other (pentatonic, chromatic, ...) as the major or natural minor scale of
// its root, by its third.
function songKey(env: PromptEnv): { key: Key; note: string } {
  const s = env.scale();
  if (!s) return { key: parseKey("C major"), note: "Live's scale could not be read, so C major is assumed" };
  const intervals = [...new Set(s.intervals.map((i) => ((i % 12) + 12) % 12))].sort((x, y) => x - y);
  const flats = usesFlats(s.root, intervals);
  const name = `${pcName(s.root, flats)} ${s.name}`;
  if (intervals.length === 7) return { key: { root: s.root, intervals, name, flats }, note: "Live's current scale" };
  const mode = intervals.includes(3) && !intervals.includes(4) ? "minor" : "major";
  const key = { root: s.root, intervals: MODES[mode], name: `${pcName(s.root, flats)} ${mode}`, flats };
  return { key, note: `Live's current scale is ${name}, not a 7-note scale: its ${mode} scale is used` };
}

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii"];

// The chord quality a Roman numeral's case and suffix stand for.
function romanQuality(minor: boolean, suffix: string): string | undefined {
  if (/^(°|o|dim)$/.test(suffix)) return "dim";
  if (/^(°|o|dim)7$/.test(suffix)) return "dim7";
  if (/^(ø7?|m7b5)$/.test(suffix)) return "m7b5";
  if (/^(\+|aug)$/.test(suffix)) return "aug";
  if (/^(\+|aug)7$/.test(suffix)) return "aug7";
  if (!minor) return suffix;
  if (suffix.startsWith("sus")) return suffix;
  return lookup({ "": "m", "7": "m7", maj7: "mMaj7", M7: "mMaj7", "6": "m6", "9": "m9", add9: "madd9" }, suffix);
}

type Chord = { label: string; name: string; root: number; intervals: number[]; bass?: number; flats: boolean };

const accidental = (a: string) => (a === "#" || a === "♯" ? 1 : a === "b" || a === "♭" ? -1 : 0);

function parseChord(token: string, key: () => Key): Chord {
  const roman = /^([b#♭♯]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)([^/]*)$/.exec(token);
  if (roman) {
    const minor = roman[2] === roman[2].toLowerCase();
    const quality = romanQuality(minor, roman[3]);
    const intervals = quality === undefined ? undefined : lookup(QUALITIES, quality);
    if (intervals) {
      const k = key();
      const degree = ROMAN.indexOf(roman[2].toLowerCase());
      const root = (k.root + k.intervals[degree] + accidental(roman[1]) + 12) % 12;
      // the key's spelling; a borrowed bVII is written with flats
      const flats = roman[1] ? usesFlats(root, [], roman[1]) : k.flats;
      return { label: token, name: pcName(root, flats) + quality, root, intervals, flats };
    }
  }
  const named = /^([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G])([#b♯♭]?))?$/.exec(token);
  const intervals = named ? lookup(QUALITIES, named[3]) : undefined;
  if (named && intervals) {
    const root = (parsePitchClass(named[1]) + accidental(named[2]) + 12) % 12;
    const bass = named[4] ? (parsePitchClass(named[4]) + accidental(named[5]) + 12) % 12 : undefined;
    return { label: token, name: token, root, intervals, bass, flats: usesFlats(root, intervals, named[2]) };
  }
  throw new UsageError(
    `progression: ${quote(token)} is not a chord this prompt knows: use Roman numerals (I, ii7, V7, bVII, ` +
      `vii°, IVmaj7) or chord names (Am, F, C7, Gmaj7, F#m7b5, Bdim, Esus4, C/E). Qualities: ` +
      `${Object.keys(QUALITIES).filter(Boolean).join(", ")}.`,
  );
}

// Pitches per chord. "root": root position from the octave's C. "close": the
// inversion and octave whose mean pitch is nearest the first chord's, so the
// voices move little from chord to chord. A slash chord's bass goes below.
function voice(chords: Chord[], octave: number, mode: "close" | "root"): number[][] {
  const base = (c: Chord) => c.intervals.map((i) => 12 * (octave + 2) + c.root + i);
  const mean = (p: number[]) => p.reduce((s, x) => s + x, 0) / p.length;
  const inRange = (p: number[]) => p.every((x) => x >= 0 && x <= 127);
  const target = mean(base(chords[0]));
  return chords.map((c) => {
    let pitches = base(c);
    if (mode === "close") {
      let best: number[] | undefined;
      for (let inv = 0; inv < pitches.length; inv++)
        for (const shift of [0, -12, 12, -24, 24]) {
          const cand = pitches.map((p, i) => p + shift + (i < inv ? 12 : 0)).sort((x, y) => x - y);
          if (inRange(cand) && (!best || Math.abs(mean(cand) - target) < Math.abs(mean(best) - target) - 1e-9))
            best = cand;
        }
      pitches = best ?? pitches;
    }
    if (c.bass !== undefined) {
      const low = Math.min(...pitches);
      pitches = [low - ((((low - c.bass) % 12) + 12) % 12 || 12), ...pitches];
    }
    if (!inRange(pitches))
      throw new UsageError(`octave ${octave} puts ${c.label} outside the MIDI range 0-127: choose another octave.`);
    return pitches;
  });
}

const DEFAULT_PROGRESSION = "I-V-vi-IV";
const DEFAULT_INSTRUMENT = "Drift"; // in every Live 12 edition
const CHORD_VELOCITY = 90;

const chordProgression: PromptDef = {
  name: "chord_progression",
  title: "Chord progression",
  description:
    "Write a chord progression as one MIDI clip: Roman numerals in a key (default Live's current scale) or " +
    "chord names, voiced and timed by the server, with the exact clip_create call.",
  tools: ["song_get", "track_create", "device_insert", "session_grid", "clip_create", "midi_clip_get_notes", "midi_clip_edit_notes"],
  args: (env) => ({
    progression: arg(
      "Chords in order, separated by spaces, commas or dashes: Roman numerals in the key (I V vi IV, ii7 V7 " +
        `Imaj7, bVII, vii°) or chord names (Am F C G, Cmaj7, F#m7b5, C/E); default "${DEFAULT_PROGRESSION}"`,
    ),
    key: arg('Key of the Roman numerals, e.g. "C major", "A minor", "F#m", "D dorian"; default Live\'s current scale'),
    bars_per_chord: arg("Bars each chord lasts (1-16); default 1"),
    beats_per_bar: arg("Beats per bar (1-32); default 4"),
    octave: arg("Octave of the voicing in Live's naming, C3 = 60 (-1 to 7); default 3"),
    voicing: arg(
      'close (default): each chord in the inversion nearest the first one, so voices move little; root: root position',
      startingWith(["close", "root"]),
    ),
    track: arg('MIDI track for the clip; default a new track "Chords"', (v) => startingWith(env.trackNames())(v)),
  }),
  render(a, env) {
    const text = a.progression?.trim() ? a.progression : DEFAULT_PROGRESSION;
    const tokens = text.split(/[\s,|–—-]+/).filter(Boolean);
    if (!tokens.length || tokens.length > 64)
      throw new UsageError(`progression: give 1-64 chords, got ${tokens.length}.`);
    const perBar = intArg(a.beats_per_bar, "beats_per_bar", 1, 32, 4);
    const beats = intArg(a.bars_per_chord, "bars_per_chord", 1, 16, 1) * perBar;
    const octave = intArg(a.octave, "octave", -1, 7, 3);
    const mode = (a.voicing?.trim() || "close").toLowerCase();
    if (mode !== "close" && mode !== "root")
      throw new UsageError(`voicing: "close" or "root", got ${quote(a.voicing ?? "")}.`);
    // the key is only looked up for Roman numerals
    let keyInfo: { key: Key; note: string } | undefined;
    const key = () =>
      (keyInfo ??= a.key?.trim() ? { key: parseKey(a.key), note: "as given" } : songKey(env)).key;
    const chords = tokens.map((t) => parseChord(t, key));
    if (a.key?.trim()) key(); // a given key is checked and shown even for chord names
    const voiced = voice(chords, octave, mode);
    const track = nameArg(a.track, "Chords");
    const label = tokens.join("-");
    const notes = voiced.flatMap((pitches, i) =>
      pitches.map((p) => ({ pitch: spell(p, chords[i].flats), start_time: i * beats, duration: beats, velocity: CHORD_VELOCITY })),
    );
    const clip = {
      type: "midi",
      track_name: track,
      scene_index: 0,
      duration: chords.length * beats,
      name: label.length > 60 ? `${label.slice(0, 57)}...` : label,
      notes,
    };
    const trackStep = a.track?.trim()
      ? `Use the MIDI track ${quote(track)}. If there is none, create it: ` +
        `${call("track_create", { type: "midi", name: track, devices: [DEFAULT_INSTRUMENT] })}. If it has no ` +
        `instrument, add one: ${call("device_insert", { track_name: track, device_name: DEFAULT_INSTRUMENT })}.`
      : `Create a track for the chords: ${call("track_create", { type: "midi", name: track, devices: [DEFAULT_INSTRUMENT] })} ` +
        `(${TRACK_STEP}). If a track named ${quote(track)} exists already, use another name here and below.`;
    return [
      "Write a chord progression into the open Ableton Live Set with the ableton-live tools.",
      "",
      keyInfo ? `Key: ${keyInfo.key.name} (${keyInfo.note}).` : "Key: none needed (chord names).",
      `Chords (${beats} beats each; MIDI note names with C3 = 60, ${mode} voicing):`,
      ...chords.map(
        (c, i) =>
          `${i + 1}. ${c.label === c.name ? c.name : `${c.label} = ${c.name}`}: ` +
          `${voiced[i].map((p) => spell(p, c.flats)).join(" ")} (beat ${i * beats})`,
      ),
      "",
      "Steps:",
      numbered([
        `Read the tracks: ${call("song_get", { include: ["tracks", "devices"] })}. ${trackStep} ` +
          `${DEFAULT_INSTRUMENT} is in every Live 12 edition; if it is reported in \`errors\`, ask the user ` +
          "which instrument to use.",
        `Find an empty clip slot: ${call("session_grid", { tracks: [{ track_name: track }] })}.`,
        `Create the clip with all its notes in one call (${SLOT_HINT}):\n   ${call("clip_create", clip)}`,
        `Check it: ${call("midi_clip_get_notes", { clip_id: "<id of the new clip>", format: "compact" })}, then ` +
          "tell the user the chords and where the clip is.",
      ]),
      "",
      "On request: a looser feel with " +
        call("midi_clip_edit_notes", { clip_id: "<id of the new clip>", humanize: { timing: 0.01, velocity: 8 } }) +
        "; another rhythm or voicing means a new notes list.",
    ].join("\n");
  },
};

// -- drum_beat -------------------------------------------------------------------

// Drum Rack pads by receiving note (Live's default layout, General MIDI drum
// notes): C1 = 36.
const PADS = {
  kick: { note: "C1", label: "Kick", query: "kick" },
  snare: { note: "D1", label: "Snare", query: "snare" },
  clap: { note: "D#1", label: "Clap", query: "clap" },
  closed_hat: { note: "F#1", label: "Closed hat", query: "hat closed" },
  open_hat: { note: "A#1", label: "Open hat", query: "hat open" },
};
type Pad = keyof typeof PADS;
type Line = { pad: Pad; steps: string; velocity?: number };
// One bar of 16 sixteenth steps per pad: x = hit, X = accent, . = rest.
const STYLES: Record<string, { tempo: number; swing?: number; lines: Line[] }> = {
  house: {
    tempo: 124,
    lines: [
      { pad: "kick", steps: "x...|x...|x...|x..." },
      { pad: "clap", steps: "....|x...|....|x..." },
      { pad: "closed_hat", steps: "xx.x|xx.x|xx.x|xx.x", velocity: 60 },
      { pad: "open_hat", steps: "..x.|..x.|..x.|..x.", velocity: 90 },
    ],
  },
  techno: {
    tempo: 130,
    lines: [
      { pad: "kick", steps: "x...|x...|x...|x..." },
      { pad: "clap", steps: "....|x...|....|x..." },
      { pad: "closed_hat", steps: "xxxx|xxxx|xxxx|xxxx", velocity: 55 },
      { pad: "open_hat", steps: "..x.|..x.|..x.|..x.", velocity: 85 },
    ],
  },
  hip_hop: {
    tempo: 90,
    swing: 0.55,
    lines: [
      { pad: "kick", steps: "x...|...x|..x.|...." },
      { pad: "snare", steps: "....|x...|....|x..." },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|x.x.", velocity: 80 },
    ],
  },
  trap: {
    tempo: 140,
    lines: [
      { pad: "kick", steps: "x...|...x|.x..|...." },
      { pad: "clap", steps: "....|....|x...|...." },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|xxxx", velocity: 75 },
    ],
  },
  dnb: {
    tempo: 174,
    lines: [
      { pad: "kick", steps: "x...|....|..x.|...." },
      { pad: "snare", steps: "....|x...|....|x..." },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|x.x.", velocity: 75 },
    ],
  },
  breakbeat: {
    tempo: 136,
    lines: [
      { pad: "kick", steps: "x.x.|....|..xx|...." },
      { pad: "snare", steps: "....|X..x|.x..|X..x", velocity: 90 },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|x.x.", velocity: 70 },
    ],
  },
  rock: {
    tempo: 120,
    lines: [
      { pad: "kick", steps: "x...|....|x.x.|...." },
      { pad: "snare", steps: "....|x...|....|x..." },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|x.x.", velocity: 80 },
    ],
  },
  reggaeton: {
    tempo: 95,
    lines: [
      { pad: "kick", steps: "x...|x...|x...|x..." },
      { pad: "snare", steps: "...x|..x.|...x|..x." },
      { pad: "closed_hat", steps: "x.x.|x.x.|x.x.|x.x.", velocity: 70 },
    ],
  },
};
const STYLE_NAMES = Object.keys(STYLES);

const drumBeat: PromptDef = {
  name: "drum_beat",
  title: "Drum beat",
  description:
    "Program a drum beat in a style (house, techno, hip_hop, trap, dnb, breakbeat, rock, reggaeton): the " +
    "kit from sample_search + drum_kit_build when the pads are empty, then one clip_create with step patterns.",
  tools: [
    "song_get",
    "track_create",
    "sample_search",
    "drum_kit_build",
    "song_set",
    "clip_create",
    "midi_clip_edit_notes",
    "midi_clip_set_notes",
  ],
  args: (env) => ({
    style: arg(`One of ${STYLE_NAMES.join(", ")}; default house`, startingWith(STYLE_NAMES)),
    bars: arg("Clip length in bars (1-64), the one-bar pattern repeated; default 2"),
    track: arg('MIDI track for the beat; default "Drums"', (v) => startingWith(env.trackNames())(v)),
    tempo: arg("Tempo to set in BPM (20-999); default: suggest the style's usual tempo"),
    swing: arg("Swing amount 0-1 (0 = straight, about 0.67 = triplet feel); default the style's (hip_hop 0.55)"),
  }),
  render(a) {
    const styleName = (a.style?.trim() || "house").toLowerCase().replace(/[\s-]+/g, "_");
    const shown = styleName.replace("_", " ");
    const style = lookup(STYLES, styleName);
    if (!style) throw new UsageError(`style: one of ${STYLE_NAMES.join(", ")}, got ${quote(a.style ?? "")}.`);
    const bars = intArg(a.bars, "bars", 1, 64, 2);
    const tempo = numArg(a.tempo, "tempo", 20, 999);
    const swing = numArg(a.swing, "swing", 0, 1) ?? style.swing;
    const track = nameArg(a.track, "Drums");
    const pads = [...new Set(style.lines.map((l) => l.pad))];
    const clip = {
      type: "midi",
      track_name: track,
      scene_index: 0,
      duration: bars * 4,
      name: `${shown} beat`,
      repeat: { length: 4 },
      patterns: style.lines.map((l) => ({ note: PADS[l.pad].note, steps: l.steps, ...(l.velocity ? { velocity: l.velocity } : {}) })),
    };
    const steps = [
      `Find the drum track: ${call("song_get", { include: ["tracks", "devices"] })}. If there is no MIDI track ` +
        `named ${quote(track)}, create it: ${call("track_create", { type: "midi", name: track })} (if a track ` +
        "that is not a MIDI track has that name, pick another name and use it below).",
      "Make sure the pads have sounds. If the track has no Drum Rack, or the pads " +
        `${pads.map((p) => PADS[p].note).join(", ")} hold no samples, find one sample per pad:\n` +
        pads.map((p) => `   - ${PADS[p].label}: ${call("sample_search", { query: PADS[p].query })}`).join("\n") +
        "\n   Pick one file each (try a shorter query, or ask the user, when nothing fits), then build the kit " +
        "in one call (it inserts the Drum Rack when there is none and imports the files into the project): " +
        call("drum_kit_build", {
          track_name: track,
          pads: pads.map((p) => ({ note: PADS[p].note, sample_path: `<${PADS[p].label.toLowerCase()} file>` })),
        }),
      tempo !== undefined
        ? `Set the tempo: ${call("song_set", { tempo })}.`
        : `${shown[0].toUpperCase()}${shown.slice(1)} usually runs at about ${style.tempo} BPM: suggest it, and set it with ` +
          `${call("song_set", { tempo: style.tempo })} only if the user agrees.`,
      `Create the clip with the whole beat in one call (${SLOT_HINT}):\n   ${call("clip_create", clip)}`,
    ];
    if (swing)
      steps.push(
        `Swing it: ${call("midi_clip_edit_notes", { clip_id: "<id of the new clip>", swing: { amount: swing, grid: 0.25 } })}.`,
      );
    steps.push(
      "Tell the user what was created. On request: fills or extra hits with `midi_clip_set_notes` " +
        '{"mode": "merge", patterns}, a looser feel with `midi_clip_edit_notes` {humanize}.',
    );
    return [
      `Program a ${shown} drum beat in the open Ableton Live Set with the ableton-live tools: ${bars} bars, a ` +
        "one-bar pattern repeated (4/4: Live's API cannot read the song's time signature).",
      "",
      "Pattern, one bar of sixteenth steps (x = hit, X = accent, . = rest; pads by receiving note, C1 = 36):",
      ...style.lines.map((l) => `- ${PADS[l.pad].label} (${PADS[l.pad].note}): ${l.steps}`),
      "",
      "Steps:",
      numbered(steps),
    ].join("\n");
  },
};

export const PROMPTS: readonly PromptDef[] = [songSkeleton, chordProgression, drumBeat];
