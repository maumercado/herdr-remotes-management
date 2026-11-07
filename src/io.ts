// Context shared by every command: where files live, which binaries to call,
// and whether a person is at the terminal to answer questions.

import { createInterface } from "node:readline/promises";
import type { Paths } from "./env.ts";
import type { Bins } from "./proc.ts";

export const EXIT = { ok: 0, failed: 1, badInput: 2, needsTerminal: 3 } as const;

export class UsageError extends Error {}

/** A question came up but nobody can answer it (no terminal, or --json). */
export class NeedsTerminal extends Error {}

export interface Ctx {
  p: Paths;
  bins: Bins;
  json: boolean;
  yes: boolean;
  /** stdin and stderr are terminals and --json is off. */
  interactive: boolean;
  /** What to do when a step fails: ask (terminal only), undo the steps done, or leave it. */
  onFail: "ask" | "undo" | "leave";
  log: (line: string) => void;
}

export function makeLog(json: boolean): (line: string) => void {
  // Human progress goes to stderr when --json owns stdout.
  return (line) => (json ? process.stderr : process.stdout).write(line + "\n");
}

export async function ask(ctx: Ctx, question: string): Promise<string> {
  if (!ctx.interactive) throw new NeedsTerminal(`needs an answer: ${question}`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Yes or no. --yes answers yes. Without a terminal and without --yes, the
 * command stops with exit code 3 rather than guessing.
 */
export async function confirm(ctx: Ctx, question: string, defaultYes = false): Promise<boolean> {
  if (ctx.yes) return true;
  const answer = (await ask(ctx, `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer.startsWith("y");
}

export async function choose<T extends string>(ctx: Ctx, question: string, options: Record<T, string>, fallback: T): Promise<T> {
  const keys = Object.keys(options) as T[];
  const shown = keys.map((k) => `[${k}] ${options[k]}`).join("  ");
  for (;;) {
    const answer = (await ask(ctx, `${question} ${shown} `)).toLowerCase();
    if (answer === "") return fallback;
    const hit = keys.find((k) => k === answer || options[k].toLowerCase().startsWith(answer));
    if (hit) return hit;
  }
}
