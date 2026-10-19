import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// config.json in the extension's storage directory, read once at startup
// (sample_roots excepted: sample_search reads it on every call, samples.ts).
// A setting with a value of the wrong type is logged and replaced by its
// default. The security switches (read_only, disabled_tools, auth_token) are
// the exception: their defaults are the least safe values, so an invalid one
// locks the endpoint instead of silently serving everything. So does a file
// that exists but cannot be read or parsed (it may hold one of them), and an
// unknown key that is a misspelling of one ("readOnly", "auth-token").

export const DEFAULT_PORT = 8722;

// A bearer token as clients send it in a header: visible ASCII, no spaces.
// 16 characters at least: the port is open to every process on the computer.
const TOKEN = /^[\x21-\x7e]{16,4096}$/;

type Setting = { schema: z.ZodTypeAny; expected: string; security?: true };
const SETTINGS = {
  port: { schema: z.number().int().min(1).max(65535), expected: "an integer from 1 to 65535" },
  progress_notifications: { schema: z.boolean(), expected: "true or false" },
  read_only: { schema: z.boolean(), expected: "true or false", security: true },
  disabled_tools: {
    schema: z.array(z.string().min(1)).max(1000),
    expected: "a list of tool names",
    security: true,
  },
  auth_token: {
    schema: z.string().regex(TOKEN).nullable(),
    expected: "null, or a string of at least 16 visible ASCII characters without spaces",
    security: true,
  },
  // checked by sample_search on every call
  sample_roots: { schema: z.unknown(), expected: "a list of folder paths" },
} satisfies Record<string, Setting>;
type Key = keyof typeof SETTINGS;
// An unknown key that only differs from a security setting in case and
// punctuation is taken as that setting, misspelled.
const looseKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const SECURITY_KEYS = new Map(
  (Object.keys(SETTINGS) as Key[]).filter((k) => "security" in SETTINGS[k]).map((k) => [looseKey(k), k]),
);

// config.json's text: UTF-8 (with or without a BOM) or, with a BOM, UTF-16 as
// Windows PowerShell 5.1 writes it. Only methods of the read buffer: the
// Extension Host's VM context has no Buffer global.
export const readConfigText = (file: string) => decode(fs.readFileSync(file));
function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  // big-endian: swapped in place (the buffer is ours) to little-endian
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)).swap16().toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/, ""); // a BOM, as some editors write
}

export type Config = {
  file?: string;
  port: number;
  progress: boolean;
  readOnly: boolean;
  disabledTools: string[];
  // SHA-256 of auth_token; the token itself is not kept
  tokenDigest?: Uint8Array;
  // Why every /mcp request is refused: an invalid security setting. Never
  // contains the token.
  locked?: string;
  // What was wrong with the file, for the log and the Status dialog.
  problems: string[];
};

export function configFilePath(storageDirectory: string | undefined): string | undefined {
  return storageDirectory ? path.join(storageDirectory, "config.json") : undefined;
}

export const tokenDigest = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest();

// Whether an Authorization header carries the token with this digest. Both
// sides are hashed first, so timingSafeEqual compares two equally long
// digests and the time taken says nothing about the configured token.
export function bearerMatches(header: string | undefined, digest: Uint8Array): boolean {
  const m = /^bearer +(\S+) *$/i.exec(header ?? "");
  return m !== null && crypto.timingSafeEqual(tokenDigest(m[1]), digest);
}

// Adds a reason to a config's lock (several are joined).
export function lock(config: Config, reason: string) {
  config.locked = config.locked ? `${config.locked}; ${reason}` : reason;
}

const shown = (v: unknown) => {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

export function readConfig(storageDirectory: string | undefined): Config {
  const config: Config = { port: DEFAULT_PORT, progress: true, readOnly: false, disabledTools: [], problems: [] };
  const file = configFilePath(storageDirectory);
  if (!storageDirectory || !file) return config;
  config.file = file;
  let text: string;
  try {
    text = readConfigText(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      // exists but unreadable: leave the user's file alone, and don't run
      // without the security settings it may hold
      config.problems.push(`${file} could not be read (${(e as Error).message})`);
      lock(config, "config.json exists but could not be read");
      return config;
    }
    try {
      fs.mkdirSync(storageDirectory, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ port: DEFAULT_PORT }, null, 2));
    } catch {
      // storage dir not writable: run with defaults
    }
    return config;
  }
  if (!text.trim()) {
    // an empty file holds no setting at all
    config.problems.push(`${file} is empty, using the defaults`);
    return config;
  }
  let raw: unknown;
  let parseError: string | undefined;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }
  if (parseError !== undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    config.problems.push(`${file} could not be parsed (${parseError ?? "not a JSON object"})`);
    // It may hold a security setting the user meant (smart quotes, unquoted
    // keys, ...): don't run without it.
    lock(config, "config.json could not be parsed (it may hold a security setting)");
    return config;
  }
  const values = raw as Record<string, unknown>;
  const unknown = Object.keys(values).filter((k) => !Object.hasOwn(SETTINGS, k));
  if (unknown.length)
    config.problems.push(
      `unknown setting(s) in ${file} ignored: ${unknown.map(shown).join(", ")} ` +
        `(known: ${Object.keys(SETTINGS).join(", ")})`,
    );
  for (const k of unknown) {
    const meant = SECURITY_KEYS.get(looseKey(k));
    if (meant) lock(config, `config.json has ${shown(k)}: write it as "${meant}"`);
  }
  const valid: Partial<Record<Key, unknown>> = {};
  for (const key of Object.keys(SETTINGS) as Key[]) {
    if (values[key] === undefined) continue;
    const setting: Setting = SETTINGS[key];
    if (setting.schema.safeParse(values[key]).success) {
      valid[key] = values[key];
      continue;
    }
    // auth_token's value is never echoed
    const got = key === "auth_token" ? "" : ` (got ${shown(values[key])})`;
    if (setting.security) {
      config.problems.push(`invalid "${key}" in ${file}${got}: expected ${setting.expected}`);
      lock(config, `"${key}" in config.json must be ${setting.expected}`);
    } else {
      config.problems.push(`invalid "${key}" in ${file}${got}: expected ${setting.expected}, using the default`);
    }
  }
  if (valid.port !== undefined) config.port = valid.port as number;
  if (valid.progress_notifications !== undefined) config.progress = valid.progress_notifications as boolean;
  if (valid.read_only !== undefined) config.readOnly = valid.read_only as boolean;
  if (valid.disabled_tools !== undefined) config.disabledTools = [...new Set(valid.disabled_tools as string[])];
  if (typeof valid.auth_token === "string") config.tokenDigest = tokenDigest(valid.auth_token);
  return config;
}
