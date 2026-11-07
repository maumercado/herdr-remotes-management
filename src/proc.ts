// Running other programs: captured (no terminal, so they never prompt) or
// interactive (they share our terminal and can ask you things).

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Paths } from "./env.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (missing binary). */
  missing?: boolean;
  timedOut?: boolean;
}

export function run(bin: string, args: string[], timeoutMs = 30_000): RunResult {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const error = r.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") return { code: 127, stdout: "", stderr: `${bin}: not found`, missing: true };
  const timedOut = error?.code === "ETIMEDOUT";
  return {
    code: r.status ?? (timedOut ? 124 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (error ? String(error.message) : ""),
    timedOut,
  };
}

/** Same as run, but without blocking, for checks that run side by side. */
export function runAsync(bin: string, args: string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveResult({ code: 127, stdout, stderr: `${bin}: ${error.message}`, missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
    });
  });
}

/** Runs with our terminal attached so the program can prompt. Returns the exit code. */
export function runInteractive(bin: string, args: string[]): number {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  const error = r.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") {
    process.stderr.write(`${bin}: not found\n`);
    return 127;
  }
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// Which binaries to call

export interface Bins {
  herdr: string;
  hc: string;
  ssh: string;
}

/**
 * Environment overrides win, then plain names on PATH. herdr also honours
 * HERDR_BIN_PATH, which herdr sets for plugin commands.
 */
export function resolveBins(_p: Paths, env: NodeJS.ProcessEnv = process.env): Bins {
  return {
    herdr: env.HERDR_MACHINES_HERDR || env.HERDR_BIN_PATH || "herdr",
    hc: env.HERDR_MACHINES_HC || "hc",
    ssh: env.HERDR_MACHINES_SSH || "ssh",
  };
}

/** Where a command would run from: an absolute path, or the first match on PATH. */
export function findExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runnable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) return runnable(bin) ? bin : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && runnable(join(dir, bin))) return join(dir, bin);
  }
  return undefined;
}
