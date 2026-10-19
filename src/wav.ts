import * as fsp from "node:fs/promises";

// Level analysis of a WAV file (render_track_audio analyze). The file is read
// in chunks, never whole: PCM 8/16/24/32-bit, IEEE float 32/64-bit, plain or
// WAVE_FORMAT_EXTENSIBLE, in a RIFF or RF64 container. Typed arrays and
// DataView only: Buffer is a Node global, which the bare context the Extension
// Host evaluates the bundle in may lack (build.ts only fills in web globals).

// The envelope's resolution: the file split into this many equal parts.
export const ENVELOPE_BUCKETS = 32;
// A peak below this counts as silence.
export const SILENCE_DBFS = -80;
const READ_BYTES = 1 << 20;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

type Format = {
  code: number; // FORMAT_PCM or FORMAT_FLOAT
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bits: number; // container bits per sample
  validBits: number;
};

// dBFS of a linear level, to 0.01 dB; null for digital silence (log of 0).
const dbfs = (v: number) => (v > 0 ? Math.round(2000 * Math.log10(v)) / 100 : null);

// `length` bytes at `position` (fewer at the end of the file), as a DataView.
async function readAt(fh: fsp.FileHandle, position: number, length: number): Promise<DataView> {
  const bytes = new Uint8Array(length);
  const { bytesRead } = await fh.read(bytes, 0, length, position);
  return new DataView(bytes.buffer, 0, bytesRead);
}

// A four-character chunk id at `at`.
const fourCC = (dv: DataView, at: number) =>
  String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));

// The format and where the samples are: walks the chunks (word-aligned, as
// RIFF pads odd sizes) up to and past "data" until "fmt " is found too.
async function locate(fh: fsp.FileHandle, fileSize: number) {
  const head = await readAt(fh, 0, 12);
  const riff = head.byteLength >= 12 ? fourCC(head, 0) : "";
  if ((riff !== "RIFF" && riff !== "RF64") || fourCC(head, 8) !== "WAVE")
    throw new Error("not a WAV file (no RIFF/RF64 WAVE header)");
  let format: Format | undefined;
  let data: { offset: number; size: number } | undefined;
  let rf64DataSize: number | undefined;
  for (let pos = 12; pos + 8 <= fileSize && (!format || !data); ) {
    const chunk = await readAt(fh, pos, 8);
    if (chunk.byteLength < 8) break;
    const id = fourCC(chunk, 0);
    let size = chunk.getUint32(4, true);
    const body = pos + 8;
    if (id === "ds64") {
      const ds = await readAt(fh, body, 16);
      if (ds.byteLength >= 16) rf64DataSize = Number(ds.getBigUint64(8, true));
    } else if (id === "fmt ") {
      const f = await readAt(fh, body, Math.min(size, 40));
      if (f.byteLength < 16) throw new Error("the fmt chunk is truncated");
      let code = f.getUint16(0, true);
      const bits = f.getUint16(14, true);
      let validBits = bits;
      if (code === FORMAT_EXTENSIBLE) {
        if (f.byteLength < 26) throw new Error("the WAVE_FORMAT_EXTENSIBLE fmt chunk is truncated");
        validBits = f.getUint16(18, true) || bits;
        code = f.getUint16(24, true); // the sub-format GUID starts with the format code
      }
      format = {
        code,
        channels: f.getUint16(2, true),
        sampleRate: f.getUint32(4, true),
        blockAlign: f.getUint16(12, true),
        bits,
        validBits,
      };
    } else if (id === "data") {
      if (riff === "RF64" && size === 0xffffffff && rf64DataSize !== undefined) size = rf64DataSize;
      // a writer that never patched the size (or a cut-off file): what is there
      data = { offset: body, size: Math.min(size, fileSize - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!format) throw new Error("no fmt chunk");
  if (!data) throw new Error("no data chunk");
  const { code, bits, channels, blockAlign } = format;
  const supported =
    (code === FORMAT_PCM && [8, 16, 24, 32].includes(bits)) || (code === FORMAT_FLOAT && [32, 64].includes(bits));
  if (!supported)
    throw new Error(
      `unsupported sample format (format code ${code}, ${bits} bits): PCM 8/16/24/32-bit and float 32/64-bit are supported`,
    );
  if (!channels || blockAlign !== (channels * bits) / 8)
    throw new Error(`inconsistent fmt chunk (${channels} channels, ${bits} bits, block size ${blockAlign})`);
  return { format, data };
}

// A function reading sample k (byte offset) of a chunk as -1..1, and the
// codes that are full scale (integer formats: the extreme codes).
function decoder(f: Format): { read: (dv: DataView, at: number) => number; isFull: (v: number) => boolean } {
  if (f.code === FORMAT_FLOAT)
    return {
      read: f.bits === 32 ? (dv, at) => dv.getFloat32(at, true) : (dv, at) => dv.getFloat64(at, true),
      isFull: (v) => Math.abs(v) >= 1,
    };
  // Integer samples sit left-justified in their container, so the container
  // size sets full scale.
  const full = 2 ** (f.bits - 1);
  const top = (full - 1) / full;
  const isFull = (v: number) => v >= top || v <= -1;
  switch (f.bits) {
    case 8:
      return { read: (dv, at) => (dv.getUint8(at) - 128) / full, isFull };
    case 16:
      return { read: (dv, at) => dv.getInt16(at, true) / full, isFull };
    case 24:
      return {
        read: (dv, at) => ((dv.getUint8(at) | (dv.getUint8(at + 1) << 8) | (dv.getInt8(at + 2) << 16)) / full),
        isFull,
      };
    default:
      return { read: (dv, at) => dv.getInt32(at, true) / full, isFull };
  }
}

export type WavAnalysis = Awaited<ReturnType<typeof analyzeWav>>;

// Per channel: peak and RMS in dBFS, samples at or over full scale; overall
// the same plus a silence flag, and an envelope of ENVELOPE_BUCKETS equal
// parts (peak and RMS over all channels per part; null = digital silence).
export async function analyzeWav(file: string) {
  const fh = await fsp.open(file, "r");
  try {
    const fileSize = (await fh.stat()).size;
    const { format: f, data } = await locate(fh, fileSize);
    const { channels, blockAlign } = f;
    const bytesPerSample = f.bits / 8;
    const frames = Math.floor(data.size / blockAlign);
    const { read, isFull } = decoder(f);
    const peak = new Array<number>(channels).fill(0);
    const sumSq = new Array<number>(channels).fill(0);
    const clipped = new Array<number>(channels).fill(0);
    const bucketPeak = new Array<number>(ENVELOPE_BUCKETS).fill(0);
    const bucketSumSq = new Array<number>(ENVELOPE_BUCKETS).fill(0);
    const bucketFrames = new Array<number>(ENVELOPE_BUCKETS).fill(0);
    const step = Math.max(blockAlign, Math.floor(READ_BYTES / blockAlign) * blockAlign);
    let frame = 0;
    for (let pos = 0; frame < frames; ) {
      const dv = await readAt(fh, data.offset + pos, Math.min(step, (frames - frame) * blockAlign));
      const n = Math.floor(dv.byteLength / blockAlign);
      if (!n) break; // the file ended early
      for (let i = 0; i < n; i++, frame++) {
        const b = Math.min(ENVELOPE_BUCKETS - 1, Math.floor((frame * ENVELOPE_BUCKETS) / frames));
        bucketFrames[b]++;
        for (let ch = 0; ch < channels; ch++) {
          const v = read(dv, i * blockAlign + ch * bytesPerSample);
          if (isFull(v) || !Number.isFinite(v)) clipped[ch]++;
          if (!Number.isFinite(v)) continue;
          const a = Math.abs(v);
          if (a > peak[ch]) peak[ch] = a;
          if (a > bucketPeak[b]) bucketPeak[b] = a;
          sumSq[ch] += v * v;
          bucketSumSq[b] += v * v;
        }
      }
      pos += n * blockAlign;
    }
    const rms = (sum: number, count: number) => (count ? Math.sqrt(sum / count) : 0);
    const overallPeak = Math.max(0, ...peak);
    const peakDb = dbfs(overallPeak);
    const totalSq = sumSq.reduce((a, b) => a + b, 0);
    return {
      format: f.code === FORMAT_FLOAT ? "float" : "pcm",
      bits_per_sample: f.bits,
      valid_bits_per_sample: f.validBits !== f.bits ? f.validBits : undefined,
      sample_rate: f.sampleRate,
      channels,
      frames: frame,
      duration_s: f.sampleRate ? Math.round((frame / f.sampleRate) * 1000) / 1000 : 0,
      peak_dbfs: peakDb,
      rms_dbfs: dbfs(rms(totalSq, frame * channels)),
      clipped_samples: clipped.reduce((a, b) => a + b, 0),
      silent: peakDb === null || peakDb < SILENCE_DBFS,
      channel_levels: peak.map((p, ch) => ({
        channel: ch,
        peak_dbfs: dbfs(p),
        rms_dbfs: dbfs(rms(sumSq[ch], frame)),
        clipped_samples: clipped[ch],
      })),
      envelope: {
        buckets: ENVELOPE_BUCKETS,
        bucket_s: f.sampleRate ? Math.round((frames / ENVELOPE_BUCKETS / f.sampleRate) * 10000) / 10000 : 0,
        peak_dbfs: bucketPeak.map((p, b) => (bucketFrames[b] ? dbfs(p) : null)),
        rms_dbfs: bucketSumSq.map((s, b) => (bucketFrames[b] ? dbfs(rms(s, bucketFrames[b] * channels)) : null)),
      },
    };
  } finally {
    await fh.close();
  }
}
