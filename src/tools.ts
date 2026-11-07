// Thin wrappers around the documented `herdr machine` and `hc machine` commands.
// Nothing here reads either program's files.

import type { Bins, RunResult } from "./proc.ts";
import { run, runAsync, runInteractive } from "./proc.ts";

export interface HerdrProfile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
  selected: boolean;
}

export interface HerdrStatus {
  status: string; // reachable | auth required | error | disabled | timeout
  error?: string | null;
}

export interface HcMachine {
  name: string;
  target: string;
  via?: boolean;
  temporary?: boolean;
  session?: string | null;
  id?: string;
  host?: string;
  version?: string;
  state?: string; // connecting | connected | needs_login | needs_update | unreachable
  since_ms?: number;
  why?: string | null;
}

export type Listing<T> = { available: true; items: T[] } | { available: false; reason: string };

export interface Outcome {
  ok: boolean;
  /** Short reason for a step report. */
  reason?: string;
  code: number;
}

function brief(r: RunResult): string {
  const text = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

function outcome(r: RunResult | number): Outcome {
  if (typeof r === "number") return { ok: r === 0, code: r, reason: r === 0 ? undefined : `exit ${r}` };
  return { ok: r.code === 0, code: r.code, reason: r.code === 0 ? undefined : brief(r) };
}

function parseJson(r: RunResult): unknown {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** One of the two front ends' machine lists. */
export class Herdr {
  // Plain field (not a parameter property) to stay within erasable TypeScript.
  bin: string;
  constructor(bins: Bins) {
    this.bin = bins.herdr;
  }

  list(): Listing<HerdrProfile> {
    const r = run(this.bin, ["machine", "list", "--json"], 15_000);
    if (r.missing) return { available: false, reason: "herdr not found" };
    const data = parseJson(r);
    if (r.code !== 0 || !Array.isArray(data)) return { available: false, reason: brief(r) };
    return { available: true, items: data as HerdrProfile[] };
  }

  /** Live checks, one process per machine, side by side, each capped. */
  async status(ids: string[], timeoutMs = 8_000): Promise<Map<string, HerdrStatus>> {
    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await runAsync(this.bin, ["machine", "status", id, "--json"], timeoutMs);
        if (r.timedOut) return [id, { status: "timeout", error: `no answer in ${timeoutMs / 1000}s` }] as const;
        const data = parseJson(r);
        const row = Array.isArray(data) ? (data[0] as HerdrStatus | undefined) : undefined;
        return [id, row ?? { status: "error", error: brief(r) }] as const;
      }),
    );
    return new Map(results);
  }

  add(target: string, label: string, session: string | undefined, interactive: boolean): Outcome {
    const args = ["machine", "add", target, "--label", label];
    if (session) args.push("--remote-session", session);
    return interactive ? outcome(runInteractive(this.bin, args)) : outcome(run(this.bin, args, 120_000));
  }

  rename(id: string, label: string): Outcome {
    return outcome(run(this.bin, ["machine", "rename", id, "--label", label]));
  }

  remove(id: string): Outcome {
    return outcome(run(this.bin, ["machine", "remove", id]));
  }

  reconnect(labelOrId: string): Outcome {
    return outcome(runInteractive(this.bin, ["machine", "reconnect", labelOrId]));
  }
}

export class Hc {
  bin: string;
  constructor(bins: Bins) {
    this.bin = bins.hc;
  }

  list(): Listing<HcMachine> {
    const r = run(this.bin, ["machine", "ls", "--json"], 15_000);
    if (r.missing) return { available: false, reason: "hc not found" };
    const data = parseJson(r) as { machines?: HcMachine[] } | undefined;
    if (r.code !== 0 || !data || !Array.isArray(data.machines)) return { available: false, reason: brief(r) };
    return { available: true, items: data.machines };
  }

  add(target: string, name: string, session: string | null | undefined, interactive: boolean): Outcome {
    const args = ["machine", "add", target, "--name", name];
    if (session) args.push("--session", session);
    return interactive ? outcome(runInteractive(this.bin, args)) : outcome(run(this.bin, args, 120_000));
  }

  rename(name: string, next: string): Outcome {
    return outcome(run(this.bin, ["machine", "rename", name, next]));
  }

  rm(name: string): Outcome {
    return outcome(run(this.bin, ["machine", "rm", name]));
  }

  login(name: string): Outcome {
    return outcome(runInteractive(this.bin, ["machine", "login", name]));
  }
}

// ---------------------------------------------------------------------------
// Name rules, taken from the sources (see docs/PLAN.md, "Name rules")

const ID_SYMBOLS = "0123456789bcdfghjkmnpqrstvwxyz";

/** hc's check_name: 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like t7. */
export function hcNameProblem(name: string): string | null {
  if (name.length < 1 || name.length > 32) return "use 1 to 32 characters";
  if (!/^[a-z0-9]/.test(name)) return "start with a lowercase letter or a digit";
  if (!/^[a-z0-9._-]+$/.test(name)) return "use only a-z 0-9 - _ .";
  const rest = name.slice(1);
  if (name.startsWith("t") && /^[1-9]/.test(rest) && [...rest].every((c) => ID_SYMBOLS.includes(c))) {
    return "can't look like a terminal id (t7)";
  }
  return null;
}

/** hc's clean_name, used when adopting an alias that hc would not accept as a name. */
export function cleanHcName(raw: string): string {
  const lower = [...raw.toLowerCase()].map((c) => (/[a-z0-9._-]/.test(c) ? c : "-")).join("");
  const name = lower.replace(/^[^a-z0-9]+/, "").slice(0, 32);
  return hcNameProblem(name) === null ? name : "machine";
}

/** What OpenSSH accepts as a single literal Host alias we can write and target. */
export function sshAliasProblem(alias: string): string | null {
  if (alias === "") return "is empty";
  if (alias.startsWith("-")) return "can't start with -";
  if (/[\s"'#=]/.test(alias)) return "can't contain spaces, quotes, # or =";
  if (/[*?!,[\]]/.test(alias)) return "can't contain * ? ! , [ ]";
  if (alias.includes("@") || alias.includes("/") || alias.includes(":")) return "can't contain @ / or :";
  return null;
}

export function aliasProblem(alias: string): string | null {
  const ssh = sshAliasProblem(alias);
  if (ssh) return `alias ${ssh}`;
  const hc = hcNameProblem(alias);
  return hc ? `alias must also be a valid Herdr app name: ${hc}` : null;
}

export function portProblem(port: string): string | null {
  if (!/^\d+$/.test(port)) return "port must be a number";
  const n = Number(port);
  return n >= 1 && n <= 65535 ? null : "port must be between 1 and 65535";
}
