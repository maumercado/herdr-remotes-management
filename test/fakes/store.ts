// Shared state for the fake herdr, hc and ssh: a JSON file and a call log in $FAKE_STATE.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_STATE ?? "/tmp/herdr-machines-fake";
mkdirSync(dir, { recursive: true });

export function logCall(tool: string, args: string[]): void {
  appendFileSync(join(dir, "calls.log"), `${tool} ${args.join(" ")}\n`);
}

export function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function save(name: string, value: unknown): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function fail(message: string, code = 1): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}
