import type { NoteDescription } from "@ableton-extensions/sdk";
import { UsageError } from "./errors.js";

// How a clip plays its own time (clip_copy, arrangement_copy_range). A clip
// starts at its start marker. Without looping it plays up to the end marker;
// with looping it plays up to the loop end, then the loop over and over. A
// copy longer than that (non-looping) region repeats the region.
//
// Live's API cannot set a MIDI clip's markers or loop, so a copy is a new clip
// whose own time starts at 0: the notes are re-based to where they play.

export type Region = {
  looping: boolean;
  startMarker: number;
  endMarker: number;
  loopStart: number;
  loopEnd: number;
};

// A stretch of the source's clip time [clipFrom, clipTo) that plays from
// `at` beats into the copy.
export type Segment = { clipFrom: number; clipTo: number; at: number };

const EPS = 1e-9;
// A copy may repeat a region at most this many times (a tiny loop and a long
// copy must not hang the host).
const MAX_SEGMENTS = 100_000;

// The stretches of clip time played from playback position `from` (beats
// after the clip's start) for `length` beats.
export function playedSegments(r: Region, from: number, length: number): Segment[] {
  // [first stretch, repeated stretch]: non-looping both are the marker region
  const loopLength = r.loopEnd - r.loopStart;
  const regionLength = r.endMarker - r.startMarker;
  if (r.looping ? !(loopLength > EPS) : !(regionLength > EPS)) return [];
  const pre = r.looping ? Math.max(0, r.loopEnd - r.startMarker) : 0;
  const cycle = r.looping ? loopLength : regionLength;
  const cycleStart = r.looping ? r.loopStart : r.startMarker;
  const segments: Segment[] = [];
  const end = from + length;
  for (let p = from; p < end - EPS; ) {
    let segStart: number; // playback position where the containing stretch starts
    let clipFrom: number;
    if (p < pre - EPS) {
      segStart = 0;
      clipFrom = r.startMarker;
    } else {
      const k = Math.floor((p - pre) / cycle + EPS);
      segStart = pre + k * cycle;
      clipFrom = cycleStart;
    }
    const segEnd = p < pre - EPS ? pre : segStart + cycle;
    const to = Math.min(end, segEnd);
    if (segments.length >= MAX_SEGMENTS)
      throw new UsageError(
        `The copy would repeat the clip's ${r.looping ? "loop" : "region"} more than ${MAX_SEGMENTS} times: ` +
          "give a shorter length.",
      );
    segments.push({ clipFrom: clipFrom + (p - segStart), clipTo: clipFrom + (to - segStart), at: p - from });
    p = to;
  }
  return segments;
}

// A session copy of a MIDI clip loops its whole length when the source loops
// (the API cannot set a new MIDI clip's loop, index.d.mts ClipSlot.createMidiClip
// takes only a length). It repeats like the source only when the source plays
// the same from its start on every pass — its start marker is inside its loop —
// and the copy holds whole loops. Otherwise: what differs, for `lost`.
export function sessionLoopMismatch(r: Region, length: number): string | undefined {
  const loopLength = r.loopEnd - r.loopStart;
  if (!r.looping || !(loopLength > EPS)) return undefined;
  const beats = (n: number) => `${n} beat${n === 1 ? "" : "s"}`;
  const intro = r.loopStart - r.startMarker;
  if (intro > EPS)
    return (
      `the source's start before its loop: the copy loops its whole ${beats(length)}, so the part ` +
      `before the source's loop start (its first ${beats(intro)}) comes back on every pass, while the ` +
      "source plays it once"
    );
  const loops = length / loopLength;
  if (Math.round(loops) < 1 || Math.abs(loops - Math.round(loops)) > 1e-6)
    return (
      `the loop length: the copy loops its whole ${beats(length)}, not a whole number of the source's ` +
      `${loopLength}-beat loops, so its repeats differ from the source's`
    );
  return undefined;
}

// The default length of a copy of a session MIDI clip, from its markers: a
// looping clip's first pass (any part before the loop, then the loop once),
// or the region between the markers. (Clip.duration is endTime - startTime,
// which index.d.mts does not define for a session clip.)
export function sessionClipLength(r: Region): number {
  if (!r.looping) return r.endMarker - r.startMarker;
  return Math.max(0, r.loopStart - r.startMarker) + (r.loopEnd - r.loopStart);
}

// The notes a copy of `length` beats plays, from playback position `from`,
// in the copy's own time (0 = its start). A note that starts before a played
// stretch is not played (as in Live, which only plays notes from their start);
// one that outlasts its stretch is cut at the stretch's end. `limit` caps the
// note count before anything is written.
export function renderNotes(
  notes: NoteDescription[],
  r: Region,
  from: number,
  length: number,
  limit: number,
): NoteDescription[] {
  const out: NoteDescription[] = [];
  const plain = notes.map((n) => ({
    pitch: Number(n.pitch),
    startTime: Number(n.startTime),
    duration: Number(n.duration),
    velocity: n.velocity === undefined ? undefined : Number(n.velocity),
    muted: n.muted,
    probability: n.probability === undefined ? undefined : Number(n.probability),
    velocityDeviation: n.velocityDeviation === undefined ? undefined : Number(n.velocityDeviation),
    releaseVelocity: n.releaseVelocity === undefined ? undefined : Number(n.releaseVelocity),
  })).filter((n) => Number.isFinite(n.startTime));
  // Sorted by start, so each stretch only visits the notes starting in it (a
  // long copy of a dense clip with a short loop must not scan every note once
  // per repeat).
  plain.sort((a, b) => a.startTime - b.startTime);
  for (const s of playedSegments(r, from, length)) {
    let lo = 0;
    let hi = plain.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (plain[mid].startTime < s.clipFrom - EPS) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < plain.length && plain[i].startTime < s.clipTo - EPS; i++) {
      const n = plain[i];
      const duration = Math.min(n.duration, s.clipTo - n.startTime);
      if (!(duration > EPS)) continue;
      if (out.length >= limit)
        throw new UsageError(`The copy would hold more than ${limit} notes: give a shorter length.`);
      // a note's optional fields are kept as they are; `selected` is the
      // user's editor selection, which belongs to the source
      const copy: NoteDescription = { ...n, startTime: s.at + (n.startTime - s.clipFrom), duration };
      for (const k of Object.keys(copy) as Array<keyof NoteDescription>) if (copy[k] === undefined) delete copy[k];
      out.push(copy);
    }
  }
  return out.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}
