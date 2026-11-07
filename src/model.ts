// One row per machine, built from the three places. Rows are matched by the
// target herdr and hc connect to, which is the SSH alias for every machine this
// tool creates or adopts. Labels and names never take part in matching.

import type { Paths } from "./env.ts";
import { readText, gitRepoOf, isSymlink, realTarget } from "./fsx.ts";
import type { Fields, HostEntry, IncludeCheck, ReadResult } from "./sshconfig.ts";
import { checkInclude, readConfig } from "./sshconfig.ts";
import type { HcMachine, HerdrProfile, HerdrStatus, Listing } from "./tools.ts";
import { Hc, Herdr } from "./tools.ts";
import type { Bins } from "./proc.ts";

export interface SshSide {
  managed: boolean;
  file: string;
  line: number;
  fields: Fields;
  /** True when the same alias is also defined elsewhere (the first definition wins). */
  shadows?: string[];
}

export interface Row {
  alias: string;
  ssh: SshSide | null;
  tui: HerdrProfile | null;
  tuiExtra: HerdrProfile[];
  tuiHealth?: HerdrStatus;
  app: HcMachine | null;
  appExtra: HcMachine[];
  /** The target is a raw user@host or ssh:// URL, or a command (hc --via), not an alias. */
  raw: boolean;
}

export interface SshInfo {
  config: string;
  configIsSymlink: boolean;
  configRealPath: string;
  managedFile: string;
  managedRealPath: string;
  managedRepo: string | null;
  include: IncludeCheck;
  read: ReadResult;
}

export interface State {
  rows: Row[];
  ssh: SshInfo;
  herdr: Listing<HerdrProfile>;
  hc: Listing<HcMachine>;
}

export function isRawTarget(target: string): boolean {
  return target.includes("@") || target.includes("://") || /\s/.test(target);
}

export function readSsh(p: Paths): SshInfo {
  const read = readConfig(p.sshConfig, { home: p.home, baseDir: p.sshDir });
  // The managed file is read on its own too, so its hosts are known even
  // before the Include line exists.
  const managed = readConfig(p.managedFile, { home: p.home, baseDir: p.sshDir });
  const managedReal = realTarget(p.managedFile);
  const seenManaged = new Set(read.files.map((f) => realTarget(f)));
  if (!seenManaged.has(managedReal)) {
    read.hosts.unshift(...managed.hosts);
    read.files.unshift(...managed.files);
  }
  return {
    config: p.sshConfig,
    configIsSymlink: isSymlink(p.sshConfig),
    configRealPath: realTarget(p.sshConfig),
    managedFile: p.managedFile,
    managedRealPath: managedReal,
    managedRepo: gitRepoOf(p.managedFile),
    include: checkInclude(readText(p.sshConfig), p.managedFile, p.home, p.sshDir),
    read,
  };
}

export function merge(
  hosts: HostEntry[],
  managedRealPath: string,
  herdr: HerdrProfile[],
  hc: HcMachine[],
): Row[] {
  const rows = new Map<string, Row>();
  const get = (alias: string, raw: boolean): Row => {
    let row = rows.get(alias);
    if (!row) {
      row = { alias, ssh: null, tui: null, tuiExtra: [], app: null, appExtra: [], raw };
      rows.set(alias, row);
    }
    return row;
  };

  // Managed entries first: the Include sits at the top, and OpenSSH uses the first match.
  const ordered = [...hosts].sort((a, b) => Number(realTarget(b.file) === managedRealPath) - Number(realTarget(a.file) === managedRealPath));
  for (const host of ordered) {
    const row = get(host.alias, false);
    if (row.ssh) {
      (row.ssh.shadows ??= []).push(`${host.file}:${host.line}`);
      continue;
    }
    row.ssh = { managed: realTarget(host.file) === managedRealPath, file: host.file, line: host.line, fields: host.fields };
  }
  for (const profile of herdr) {
    const row = get(profile.target, isRawTarget(profile.target));
    if (row.tui) row.tuiExtra.push(profile);
    else row.tui = profile;
  }
  for (const machine of hc) {
    const row = get(machine.target, Boolean(machine.via) || isRawTarget(machine.target));
    if (row.app) row.appExtra.push(machine);
    else row.app = machine;
  }
  return [...rows.values()];
}

/** A row is a machine when some tool knows it or this tool manages it. */
export function isMachine(row: Row): boolean {
  return Boolean(row.tui || row.app || row.ssh?.managed);
}

export function loadState(p: Paths, bins: Bins): State {
  const ssh = readSsh(p);
  const herdr = new Herdr(bins).list();
  const hc = new Hc(bins).list();
  const rows = merge(ssh.read.hosts, ssh.managedRealPath, herdr.available ? herdr.items : [], hc.available ? hc.items : []);
  rows.sort((a, b) => a.alias.localeCompare(b.alias));
  return { rows, ssh, herdr, hc };
}

export async function addHealth(state: State, bins: Bins, timeoutMs = 8_000): Promise<void> {
  if (!state.herdr.available) return;
  const ids = state.rows.flatMap((r) => (r.tui ? [r.tui.id] : []));
  const health = await new Herdr(bins).status(ids, timeoutMs);
  for (const row of state.rows) if (row.tui) row.tuiHealth = health.get(row.tui.id);
}
