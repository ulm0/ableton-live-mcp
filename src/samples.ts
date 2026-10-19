import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// sample_search: a read-only walk of sample folders. Live's API has no browser
// access, so the folders are the `sample_roots` of config.json plus Live's
// default User Library and Factory Packs folders when they exist. Nothing
// outside those folders is ever listed: every directory and file is resolved
// with realpath and must stay inside one of the roots, so a symlink cannot
// lead the walk elsewhere.

export const AUDIO_EXTENSIONS = [".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a"];

export type SampleRoot = { name: string; path: string; source: "config" | "library" };

// Live's default library folders (Preferences > Library can move them; such
// folders go in sample_roots). macOS keeps them in ~/Music/Ableton, Windows in
// ~/Documents/Ableton; both are looked for everywhere.
export function libraryRoots(home = os.homedir()): SampleRoot[] {
  const roots: SampleRoot[] = [];
  for (const base of ["Music", "Documents"])
    for (const name of ["User Library", "Factory Packs"])
      roots.push({ name, path: path.join(home, base, "Ableton", name), source: "library" });
  return roots;
}

// sample_roots of config.json: absolute paths, or "~/..." for the home folder.
// Read on every call, so edits apply without restarting Live.
export function configRoots(configFile: string | undefined): { roots: SampleRoot[]; problems: string[] } {
  const problems: string[] = [];
  if (!configFile) return { roots: [], problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, "")); // a BOM, as config.ts
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      problems.push(`${configFile} could not be read: ${(e as Error).message}`);
    return { roots: [], problems };
  }
  const list = (parsed as { sample_roots?: unknown })?.sample_roots;
  if (list === undefined) return { roots: [], problems };
  if (!Array.isArray(list)) {
    problems.push(`sample_roots in ${configFile} is not a list of folder paths`);
    return { roots: [], problems };
  }
  const roots: SampleRoot[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) {
      problems.push(`sample_roots entry ${JSON.stringify(entry)} is not a folder path`);
      continue;
    }
    const expanded = /^~(?=$|[\\/])/.test(entry) ? path.join(os.homedir(), entry.slice(1)) : entry;
    if (!path.isAbsolute(expanded)) {
      problems.push(`sample_roots entry ${JSON.stringify(entry)} is not an absolute path`);
      continue;
    }
    roots.push({ name: path.basename(path.resolve(expanded)) || expanded, path: path.resolve(expanded), source: "config" });
  }
  return { roots, problems };
}

// Whether `p` is `root` or inside it (both real paths).
function inside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export type SearchOptions = {
  terms: string[]; // all must occur in the path below the root (lowercase)
  extensions: string[]; // lowercase, with the dot
  limit: number;
  maxDepth: number;
  timeLimitMs: number;
  maxDirectories: number;
};

export type SampleHit = { path: string; name: string; root: string; relative_path: string; size_bytes?: number };

// Breadth-first over every root (shallow files first), directories sorted by
// name. Stops at `limit` hits, after `timeLimitMs`, or after `maxDirectories`
// directories; `stopped` says which.
export async function searchSamples(roots: SampleRoot[], o: SearchOptions) {
  const started = Date.now();
  const reals: Array<{ root: SampleRoot; real: string }> = [];
  const report: Array<{ name: string; path: string; source: string; exists: boolean }> = [];
  for (const root of roots) {
    let real: string | undefined;
    try {
      real = await fsp.realpath(root.path);
      if (!(await fsp.stat(real)).isDirectory()) real = undefined;
    } catch {
      real = undefined;
    }
    report.push({ name: root.name, path: root.path, source: root.source, exists: real !== undefined });
    if (real !== undefined) reals.push({ root, real });
  }
  // the root a path is in (a link may lead into another root)
  const ownerOf = (p: string) => reals.find((r) => inside(p, r.real));
  const hits: SampleHit[] = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  let directories = 0;
  let stopped: "limit" | "time" | "directories" | undefined;
  let unreadable = 0;
  const queue: Array<{ dir: string; depth: number }> = [];
  // a root inside another one is walked as part of it
  for (const r of reals)
    if (!reals.some((o2) => o2.real !== r.real && inside(r.real, o2.real))) queue.push({ dir: r.real, depth: 0 });
  walk: while (queue.length) {
    const next = queue.shift()!;
    const depth = next.depth;
    // re-resolved when it is read: a folder swapped for a link meanwhile
    // must not lead outside the roots either
    let dir: string;
    try {
      dir = await fsp.realpath(next.dir);
    } catch {
      continue;
    }
    if (!ownerOf(dir) || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    if (Date.now() - started > o.timeLimitMs) {
      stopped = "time";
      break;
    }
    if (directories >= o.maxDirectories) {
      stopped = "directories";
      break;
    }
    directories++;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // hidden files, .git, ...
      let full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // follow a link only to somewhere inside the roots
        try {
          full = await fsp.realpath(full);
          if (!ownerOf(full)) continue;
          const st = await fsp.stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (depth < o.maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!isFile || !o.extensions.includes(path.extname(full).toLowerCase())) continue;
      const owner = ownerOf(full);
      if (!owner) continue; // never: walked paths stay inside the roots
      const rel = path.relative(owner.real, full).split(path.sep).join("/");
      if (!o.terms.every((t) => rel.toLowerCase().includes(t)) || seenFiles.has(full)) continue;
      seenFiles.add(full);
      if (hits.length >= o.limit) {
        stopped = "limit";
        break walk;
      }
      hits.push({ path: full, name: path.basename(full), root: owner.root.name, relative_path: rel });
    }
  }
  // sizes only for what is returned
  await Promise.all(
    hits.map(async (h) => {
      try {
        h.size_bytes = (await fsp.stat(h.path)).size;
      } catch {
        // gone meanwhile: no size
      }
    }),
  );
  return {
    roots: report,
    results: hits,
    complete: stopped === undefined,
    stopped,
    directories_searched: directories,
    unreadable_directories: unreadable || undefined,
    elapsed_ms: Date.now() - started,
  };
}
