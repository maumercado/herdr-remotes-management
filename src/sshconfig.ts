// Reading and editing OpenSSH client config files (ssh_config(5)).
//
// Reading follows Include lines and collects literal Host aliases. Writing only
// ever touches the managed file, line by line, so comments and options the tool
// does not know survive. The one exception is the Include line placed at the
// top of ~/.ssh/config.

import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readText } from "./fsx.ts";
import { TOOL } from "./env.ts";

export interface ParsedLine {
  /** Keyword in lower case. */
  key: string;
  args: string[];
}

/** Splits one config line into keyword and arguments. Null for blank lines and comments. */
export function parseLine(raw: string): ParsedLine | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("#")) return null;
  const match = /^([^\s=]+)(?:\s*=\s*|\s+)?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const rest = match[2] ?? "";
  const args = (rest.match(/"[^"]*"|\S+/g) ?? []).map((a) => (a.startsWith('"') && a.endsWith('"') && a.length >= 2 ? a.slice(1, -1) : a));
  return { key: match[1]!.toLowerCase(), args };
}

export function isLiteralPattern(pattern: string): boolean {
  return pattern !== "" && !/[*?!,[\]]/.test(pattern);
}

/** The options this tool reads and writes, with OpenSSH's spelling. */
export const FIELDS = {
  host: "HostName",
  user: "User",
  port: "Port",
  key: "IdentityFile",
  jump: "ProxyJump",
} as const;

export type Field = keyof typeof FIELDS;
export type Fields = Partial<Record<Field, string>>;

const FIELD_BY_KEY: Record<string, Field> = Object.fromEntries(
  Object.entries(FIELDS).map(([field, key]) => [key.toLowerCase(), field as Field]),
);

export interface HostEntry {
  alias: string;
  file: string;
  line: number;
  /** First value of each known option inside this Host block (first wins). */
  fields: Fields;
  /** Other aliases on the same Host line. */
  siblings: string[];
}

export interface ReadResult {
  hosts: HostEntry[];
  /** Non literal Host patterns, shown read only. */
  patterns: { pattern: string; file: string; line: number }[];
  matchBlocks: { file: string; line: number }[];
  files: string[];
  warnings: string[];
}

export interface ReadOptions {
  home: string;
  /** Folder relative Include paths are resolved against (~/.ssh for user config). */
  baseDir: string;
  maxDepth?: number;
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function globToRegex(segment: string): RegExp {
  let re = "";
  for (const ch of segment) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Expands * and ? in any path segment. Returns existing files, sorted like glob(3). */
export function expandGlob(pattern: string): string[] {
  const absolute = resolve(pattern);
  const parts = absolute.split("/").filter((p) => p !== "");
  let current = ["/"];
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const next: string[] = [];
    for (const base of current) {
      if (!/[*?]/.test(part)) {
        next.push(join(base, part));
        continue;
      }
      let names: string[] = [];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      const re = globToRegex(part);
      for (const name of names.sort()) {
        if (name.startsWith(".") && !part.startsWith(".")) continue;
        if (re.test(name)) next.push(join(base, name));
      }
    }
    current = next;
    if (!last) current = current.filter((p) => isDir(p));
  }
  return current.filter((p) => isFile(p));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Reads a config file and everything it includes. */
export function readConfig(file: string, opts: ReadOptions): ReadResult {
  const out: ReadResult = { hosts: [], patterns: [], matchBlocks: [], files: [], warnings: [] };
  const seen = new Set<string>();
  const maxDepth = opts.maxDepth ?? 16;

  const visit = (path: string, depth: number): void => {
    if (depth > maxDepth) {
      out.warnings.push(`Include nesting deeper than ${maxDepth} at ${path}`);
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);
    const text = readText(path);
    if (text === null) return;
    out.files.push(path);
    let block: HostEntry[] = [];
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const parsed = parseLine(raw);
      if (!parsed) continue;
      const line = index + 1;
      if (parsed.key === "host") {
        block = [];
        const literals = parsed.args.filter(isLiteralPattern);
        for (const pattern of parsed.args) {
          if (!isLiteralPattern(pattern)) out.patterns.push({ pattern, file: path, line });
        }
        for (const alias of literals) {
          const entry: HostEntry = { alias, file: path, line, fields: {}, siblings: literals.filter((a) => a !== alias) };
          block.push(entry);
          out.hosts.push(entry);
        }
      } else if (parsed.key === "match") {
        block = [];
        out.matchBlocks.push({ file: path, line });
      } else if (parsed.key === "include") {
        for (const arg of parsed.args) {
          let target = expandTilde(arg, opts.home);
          if (!isAbsolute(target)) target = join(opts.baseDir, target);
          for (const found of expandGlob(target)) visit(found, depth + 1);
        }
      } else {
        const field = FIELD_BY_KEY[parsed.key];
        if (field && parsed.args.length > 0) {
          for (const entry of block) {
            if (entry.fields[field] === undefined) entry.fields[field] = parsed.args.join(" ");
          }
        }
      }
    }
  };

  visit(resolve(file), 0);
  return out;
}

// ---------------------------------------------------------------------------
// The managed file

export const MANAGED_HEADER = [
  `# Managed by ${TOOL}. Change machines with \`${TOOL} edit\` or its UI.`,
  "# Hand edits to the options below are kept, but the tool owns this file.",
  "",
].join("\n");

function quote(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

interface Block {
  start: number;
  /** Exclusive end: the next Host/Match line or the end of the file. */
  end: number;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function findBlock(lines: string[], alias: string): Block | null {
  let start = -1;
  for (const [i, raw] of lines.entries()) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.key === "host" || parsed.key === "match") {
      if (start >= 0) return { start, end: i };
      if (parsed.key === "host" && parsed.args.length === 1 && parsed.args[0] === alias) start = i;
    }
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

export function hasManagedHost(text: string, alias: string): boolean {
  return findBlock(splitLines(text), alias) !== null;
}

/** Adds a Host block at the end of the managed file. */
export function addManagedHost(text: string | null, alias: string, fields: Fields): string {
  const lines = splitLines(text ?? MANAGED_HEADER);
  if (findBlock(lines, alias)) throw new Error(`${alias} is already in the managed file`);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push(`Host ${alias}`);
  for (const field of Object.keys(FIELDS) as Field[]) {
    const value = fields[field];
    if (value !== undefined && value !== "") lines.push(`  ${FIELDS[field]} ${quote(value)}`);
  }
  return joinLines(lines);
}

/**
 * Changes options of one Host block. A value of "" removes the option.
 * Fields that are not mentioned stay as they are.
 */
export function editManagedHost(text: string, alias: string, changes: Fields): string {
  const lines = splitLines(text);
  const block = findBlock(lines, alias);
  if (!block) throw new Error(`${alias} is not in the managed file`);
  let end = block.end;
  for (const field of Object.keys(changes) as Field[]) {
    const value = changes[field];
    if (value === undefined) continue;
    const key = FIELDS[field].toLowerCase();
    const at: number[] = [];
    for (let i = block.start + 1; i < end; i++) {
      if (parseLine(lines[i]!)?.key === key) at.push(i);
    }
    if (value === "") {
      for (const i of at.reverse()) lines.splice(i, 1);
      end -= at.length;
    } else if (at.length > 0) {
      const indent = /^\s*/.exec(lines[at[0]!]!)![0] || "  ";
      lines[at[0]!] = `${indent}${FIELDS[field]} ${quote(value)}`;
    } else {
      let insert = end;
      while (insert > block.start + 1 && lines[insert - 1]!.trim() === "") insert--;
      lines.splice(insert, 0, `  ${FIELDS[field]} ${quote(value)}`);
      end++;
    }
  }
  return joinLines(lines);
}

export function removeManagedHost(text: string, alias: string): string {
  const lines = splitLines(text);
  const block = findBlock(lines, alias);
  if (!block) return text;
  let start = block.start;
  // Take the blank line in front of the block along with it.
  if (start > 0 && lines[start - 1]!.trim() === "") start--;
  lines.splice(start, block.end - start);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return joinLines(lines);
}

export function renameManagedHost(text: string, alias: string, next: string): string {
  const lines = splitLines(text);
  if (findBlock(lines, next)) throw new Error(`${next} is already in the managed file`);
  const block = findBlock(lines, alias);
  if (!block) throw new Error(`${alias} is not in the managed file`);
  const indent = /^\s*/.exec(lines[block.start]!)![0];
  lines[block.start] = `${indent}Host ${next}`;
  return joinLines(lines);
}

// ---------------------------------------------------------------------------
// The Include line in ~/.ssh/config

export interface IncludeCheck {
  /** "present": already at the top; "missing": can be added; "scoped": exists only inside a Host/Match block. */
  state: "present" | "missing" | "scoped";
  line?: number;
}

function namesManagedFile(arg: string, managedFile: string, home: string, baseDir: string): boolean {
  let target = expandTilde(arg, home);
  if (!isAbsolute(target)) target = join(baseDir, target);
  return resolve(target) === resolve(managedFile);
}

export function checkInclude(configText: string | null, managedFile: string, home: string, baseDir: string): IncludeCheck {
  if (configText === null) return { state: "missing" };
  let inBlock = false;
  let scoped: number | undefined;
  for (const [i, raw] of splitLines(configText).entries()) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.key === "host" || parsed.key === "match") inBlock = true;
    if (parsed.key === "include" && parsed.args.some((a) => namesManagedFile(a, managedFile, home, baseDir))) {
      if (!inBlock) return { state: "present", line: i + 1 };
      scoped ??= i + 1;
    }
  }
  return scoped !== undefined ? { state: "scoped", line: scoped } : { state: "missing" };
}

/** Puts the Include line at the very top, above every Host and Match block. */
export function addInclude(configText: string | null, includeSpelling: string): string {
  const head = [`# Added by ${TOOL}: machines it manages live in the file below.`, `Include ${includeSpelling}`];
  if (configText === null || configText.trim() === "") return joinLines(head);
  return joinLines([...head, "", ...splitLines(configText)]);
}

// ---------------------------------------------------------------------------
// `ssh -G` output

export interface Resolved {
  hostname?: string;
  user?: string;
  port?: string;
  proxyjump?: string;
}

export function parseResolved(output: string): Resolved {
  const out: Resolved = {};
  for (const raw of output.split("\n")) {
    const [key, ...rest] = raw.trim().split(/\s+/);
    const value = rest.join(" ");
    if (key === "hostname" || key === "user" || key === "port" || key === "proxyjump") out[key] ??= value;
  }
  return out;
}

/** Problems between what was written and what ssh resolves. Empty when they agree. */
export function compareResolved(expected: Fields, got: Resolved): string[] {
  const problems: string[] = [];
  if (expected.host && got.hostname !== expected.host) problems.push(`HostName resolves to ${got.hostname ?? "nothing"}, expected ${expected.host}`);
  if (expected.user && got.user !== expected.user) problems.push(`User resolves to ${got.user ?? "nothing"}, expected ${expected.user}`);
  if (expected.port && got.port !== expected.port) problems.push(`Port resolves to ${got.port ?? "nothing"}, expected ${expected.port}`);
  return problems;
}
