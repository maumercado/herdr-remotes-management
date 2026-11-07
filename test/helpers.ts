// A throwaway HOME with fake herdr, hc and ssh, and a way to run the CLI in it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
const FAKES = join(here, "fakes");

export interface Sandbox {
  home: string;
  fake: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string): string;
  read(rel: string): string;
  calls(): string[];
  herdr(): { id: string; label: string; target: string; session: string }[];
  hc(): { name: string; target: string; session: string | null }[];
  seedHerdr(rows: object[]): void;
  seedHc(rows: object[]): void;
  run(args: string[], extraEnv?: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string; json: any };
}

export function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "hm-test-"));
  const home = join(base, "home");
  const fake = join(base, "fake");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  mkdirSync(fake, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, ".local", "state"),
    FAKE_STATE: fake,
    HERDR_MACHINES_HERDR: join(FAKES, "herdr"),
    HERDR_MACHINES_HC: join(FAKES, "hc"),
    HERDR_MACHINES_SSH: join(FAKES, "ssh"),
  };
  const sb: Sandbox = {
    home,
    fake,
    env,
    write(rel, content) {
      const path = join(home, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
      return path;
    },
    read(rel) {
      return readFileSync(join(home, rel), "utf8");
    },
    calls() {
      try {
        return readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    herdr() {
      try {
        return JSON.parse(readFileSync(join(fake, "herdr.json"), "utf8"));
      } catch {
        return [];
      }
    },
    hc() {
      try {
        return JSON.parse(readFileSync(join(fake, "hc.json"), "utf8"));
      } catch {
        return [];
      }
    },
    seedHerdr(rows) {
      writeFileSync(join(fake, "herdr.json"), JSON.stringify(rows));
    },
    seedHc(rows) {
      writeFileSync(join(fake, "hc.json"), JSON.stringify(rows));
    },
    run(args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [join(ROOT, "src", "main.ts"), ...args], {
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let json: any;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        json = undefined;
      }
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, json };
    },
  };
  return sb;
}
