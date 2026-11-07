// File writes that respect symlinked dotfiles, keep backups and never leave a
// half written file behind.

import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Paths } from "./env.ts";
import { TOOL } from "./env.ts";

export const KEEP_BACKUPS = 10;

/** Resolves symlinks in the folders of a path, even when the last parts do not exist yet. */
function canonical(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Follows symlinks to the final path, even when that final file does not exist yet. */
export function realTarget(path: string): string {
  let current = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return canonical(current);
    }
    if (!info.isSymbolicLink()) return canonical(current);
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`too many symlinks at ${path}`);
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(realTarget(path), { recursive: true, mode });
}

/**
 * Writes through symlinks: the file the link points at is replaced, the link
 * stays. The new content goes to a temporary file next to the real target and
 * is renamed over it, so readers never see a partial file.
 */
export function atomicWrite(path: string, content: string, mode?: number): void {
  const target = realTarget(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = statSync(target).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }
  const tmp = join(dir, `.${basename(target)}.${TOOL}.${process.pid}.${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, content, { mode: finalMode });
    chmodSync(tmp, finalMode);
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The git repository a path would be written into, or null. */
export function gitRepoOf(path: string): string | null {
  let dir = dirname(realTarget(path));
  // A folder that does not exist yet may still sit inside a repo.
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Copies the current file into the backups folder. Returns null when there was no file. */
export function backup(path: string, p: Paths, now = new Date()): string | null {
  const content = readText(path);
  if (content === null) return null;
  mkdirSync(p.backupsDir, { recursive: true, mode: 0o700 });
  const name = basename(path);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let dest = join(p.backupsDir, `${name}-${stamp}`);
  for (let n = 2; existsSync(dest); n++) dest = join(p.backupsDir, `${name}-${stamp}-${n}`);
  copyFileSync(realTarget(path), dest);
  chmodSync(dest, 0o600);
  prune(p.backupsDir, name);
  return dest;
}

function prune(dir: string, name: string): void {
  const prefix = `${name}-`;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /^\d{4}-/.test(f.slice(prefix.length)))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
    rmSync(join(dir, old), { force: true });
  }
}

/** Puts a file back the way it was: the backup's content, or no file at all. */
export function restore(path: string, backupPath: string | null, mode?: number): void {
  if (backupPath === null) {
    rmSync(realTarget(path), { force: true });
    return;
  }
  atomicWrite(path, readFileSync(backupPath, "utf8"), mode);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs fn while holding the state folder's lock file, so two front ends never write at once. */
export function withLock<T>(p: Paths, fn: () => T, waitMs = 5000): T {
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(p.lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(p.lockFile).mtimeMs > 120_000) unlinkSync(p.lockFile);
      } catch {
        // The other writer just finished.
      }
      if (Date.now() > deadline) throw new Error(`another ${TOOL} is writing (lock: ${p.lockFile})`);
      sleep(100);
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    rmSync(p.lockFile, { force: true });
  }
}

export function readJson<T>(path: string, fallback: T): T {
  const text = readText(path);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n", 0o600);
}
