// Every command. Each one checks its input first, then runs its steps in the
// fixed order (SSH, TUI, app) and returns a report.

import type { Ctx } from "./io.ts";
import { confirm, EXIT, NeedsTerminal, UsageError } from "./io.ts";
import type { Row, State } from "./model.ts";
import { addHealth, isMachine, loadState } from "./model.ts";
import type { Fields } from "./sshconfig.ts";
import { addManagedHost, editManagedHost, removeManagedHost, renameManagedHost } from "./sshconfig.ts";
import { reachStep, sshWriteStep, writeBlockers } from "./sshwrite.ts";
import type { Report, Step } from "./steps.ts";
import { emptyReport, runSteps, skip } from "./steps.ts";
import { aliasProblem, cleanHcName, Hc, hcNameProblem, Herdr, portProblem } from "./tools.ts";
import { readJson, writeJson } from "./fsx.ts";
import { findExecutable, run, runInteractive } from "./proc.ts";
import { formatTable, stateView } from "./view.ts";

export interface CommandResult {
  code: number;
  report?: Report;
  data?: unknown;
  text?: string;
}

function findRow(state: State, alias: string): Row {
  const row = state.rows.find((r) => r.alias === alias);
  if (!row) throw new UsageError(`no machine or SSH host called ${alias}`);
  return row;
}

function result(report: Report, extra: Record<string, unknown> = {}): CommandResult {
  return { code: report.ok ? 0 : report.code, report, data: { ...extra, report } };
}

function herdrStep(ctx: Ctx, alias: string, label: string, session?: string): Step {
  const herdr = new Herdr(ctx.bins);
  return {
    side: "tui",
    title: `herdr machine add ${alias}`,
    run: () => herdr.add(alias, label, session, ctx.interactive),
    undo: () => {
      const list = herdr.list();
      if (!list.available) return { ok: false, reason: list.reason };
      const added = list.items.filter((p) => p.target === alias && p.label === label);
      for (const p of added) {
        const r = herdr.remove(p.id);
        if (!r.ok) return r;
      }
      return { ok: true };
    },
  };
}

function hcStep(ctx: Ctx, alias: string, name: string, session?: string | null): Step {
  const hc = new Hc(ctx.bins);
  return {
    side: "app",
    title: `hc machine add ${alias}`,
    run: () => hc.add(alias, name, session, ctx.interactive),
    undo: () => hc.rm(name),
  };
}

// ---------------------------------------------------------------------------
// list

export async function list(ctx: Ctx, opts: { health?: boolean; all?: boolean }): Promise<CommandResult> {
  const state = loadState(ctx.p, ctx.bins);
  if (opts.health) await addHealth(state, ctx.bins);
  return { code: 0, data: stateView(state, Boolean(opts.all)), text: formatTable(state, Boolean(opts.all)) };
}

// ---------------------------------------------------------------------------
// add

export interface AddOptions extends Fields {
  session?: string;
  sameAsLast?: boolean;
}

interface LastUsed {
  user?: string;
  port?: string;
  key?: string;
  jump?: string;
}

export async function add(ctx: Ctx, alias: string, opts: AddOptions): Promise<CommandResult> {
  const problem = aliasProblem(alias);
  if (problem) throw new UsageError(problem);
  if (!opts.host) throw new UsageError("add needs --host");
  const fields: Fields = { host: opts.host, user: opts.user, port: opts.port, key: opts.key, jump: opts.jump };
  if (opts.sameAsLast) {
    const last = readJson<LastUsed>(ctx.p.lastFile, {});
    fields.user ??= last.user;
    fields.port ??= last.port;
    fields.key ??= last.key;
    fields.jump ??= last.jump;
  }
  if (fields.port) {
    const bad = portProblem(fields.port);
    if (bad) throw new UsageError(bad);
  }
  if (opts.session) {
    const bad = hcNameProblem(opts.session);
    if (bad) throw new UsageError(`session name: ${bad}`);
  }

  const state = loadState(ctx.p, ctx.bins);
  const existing = state.rows.find((r) => r.alias === alias);
  if (existing?.ssh?.managed) throw new UsageError(`${alias} is already managed; use edit`);
  if (existing?.ssh) throw new UsageError(`${alias} is already a Host in ${existing.ssh.file}:${existing.ssh.line}; use adopt to register it`);
  if (existing?.tui || existing?.app) throw new UsageError(`herdr or the app already has a machine reaching ${alias}; run doctor`);
  const blockers = writeBlockers(ctx);
  if (blockers.length > 0) throw new UsageError(blockers.join("\n"));

  const report = emptyReport();
  const steps: Step[] = [
    sshWriteStep(ctx, {
      title: `write Host ${alias}`,
      mutate: (current) => addManagedHost(current, alias, fields),
      expect: { alias, fields },
    }),
    reachStep(ctx, alias),
  ];
  if (state.herdr.available) steps.push(herdrStep(ctx, alias, alias, opts.session));
  else skip(report, "tui", state.herdr.reason);
  if (state.hc.available) steps.push(hcStep(ctx, alias, alias, opts.session));
  else skip(report, "app", state.hc.reason);

  await runSteps(ctx, steps, report);
  if (report.sides.ssh.state === "ok") {
    writeJson(ctx.p.lastFile, { user: fields.user, port: fields.port, key: fields.key, jump: fields.jump } satisfies LastUsed);
  }
  return result(report, { alias });
}

// ---------------------------------------------------------------------------
// adopt

export async function adopt(ctx: Ctx, alias: string, opts: { hcName?: string; session?: string }): Promise<CommandResult> {
  const state = loadState(ctx.p, ctx.bins);
  const row = findRow(state, alias);
  if (!row.ssh) throw new UsageError(`${alias} is not a Host in your SSH config`);
  if (row.ssh.managed) throw new UsageError(`${alias} is managed by this tool already`);
  const name = opts.hcName ?? (hcNameProblem(alias) ? cleanHcName(alias) : alias);
  const bad = hcNameProblem(name);
  if (bad) throw new UsageError(`app name ${name}: ${bad}`);

  const report = emptyReport();
  const steps: Step[] = [reachStep(ctx, alias)];
  if (!state.herdr.available) skip(report, "tui", state.herdr.reason);
  else if (row.tui) skip(report, "tui", "already there");
  else steps.push(herdrStep(ctx, alias, alias, opts.session));
  if (!state.hc.available) skip(report, "app", state.hc.reason);
  else if (row.app) skip(report, "app", "already there");
  else steps.push(hcStep(ctx, alias, name, opts.session));
  await runSteps(ctx, steps, report);
  return result(report, { alias, appName: name });
}

// ---------------------------------------------------------------------------
// edit

const ENDPOINT: (keyof Fields)[] = ["host", "user", "port", "jump"];

export async function edit(ctx: Ctx, alias: string, changes: Fields, opts: { reconnect?: boolean; alias?: string }): Promise<CommandResult> {
  const given = (Object.keys(changes) as (keyof Fields)[]).filter((k) => changes[k] !== undefined);
  if (given.length === 0) throw new UsageError("nothing to change: pass --host, --user, --port, --key or --jump");
  if (changes.host === "") throw new UsageError("--host can't be empty");
  if (changes.port) {
    const bad = portProblem(changes.port);
    if (bad) throw new UsageError(bad);
  }
  const state = loadState(ctx.p, ctx.bins);
  const row = findRow(state, alias);
  if (row.raw) return repoint(ctx, state, row, changes, opts.alias);
  if (row.ssh && !row.ssh.managed) throw new UsageError(`${alias} is your own entry in ${row.ssh.file}:${row.ssh.line}; edit that file by hand`);
  // herdr or the app use the alias, but no Host block defines it: editing
  // creates the managed entry, which they pick up on their next connection.
  const creating = !row.ssh;
  if (creating && !changes.host) throw new UsageError(`${alias} has no SSH entry yet; give at least --host to create one`);
  const blockers = writeBlockers(ctx);
  if (blockers.length > 0) throw new UsageError(blockers.join("\n"));

  const before: Fields = row.ssh?.fields ?? {};
  const after: Fields = { ...before };
  for (const k of given) after[k] = changes[k] === "" ? undefined : changes[k];
  const endpointChanged = creating || ENDPOINT.some((k) => (before[k] ?? "") !== (after[k] ?? ""));

  // hc keeps a live ssh connection to the old address only while the machine
  // is connected. Offline, it reconnects with the new address by itself.
  const appConnected = row.app?.state === "connected";
  let refreshApp = false;
  if (endpointChanged && row.app && appConnected && state.hc.available) {
    refreshApp = await confirm(
      ctx,
      `The app is connected to ${alias} and keeps that connection for up to 10 idle minutes. Refresh it now (remove and add again, same name and session)?`,
      true,
    );
  }
  let reconnect = false;
  if (endpointChanged && row.tui && state.herdr.available) {
    reconnect = opts.reconnect ?? (ctx.interactive ? await confirm(ctx, `Reconnect ${alias} in herdr now?`, true) : false);
  }

  const report = emptyReport();
  const steps: Step[] = [
    sshWriteStep(ctx, {
      title: creating ? `write Host ${alias}` : `update Host ${alias}`,
      mutate: (current) => (creating ? addManagedHost(current, alias, after) : editManagedHost(current ?? "", alias, changes)),
      expect: { alias, fields: after },
    }),
  ];
  if (reconnect && row.tui) {
    const herdr = new Herdr(ctx.bins);
    const id = row.tui.id;
    steps.push({
      side: "tui",
      title: `herdr machine reconnect ${alias}`,
      soft: true,
      run: () => (ctx.interactive ? herdr.reconnect(id) : { ok: true, reason: "reconnects on its own" }),
    });
  } else skip(report, "tui", row.tui ? "picks it up on next connect" : "not there");
  if (refreshApp && row.app) {
    const hc = new Hc(ctx.bins);
    const app = row.app;
    steps.push({
      side: "app",
      title: `refresh app login for ${alias}`,
      soft: true,
      run: () => {
        // Only drop the app's machine when the new address answers, so a
        // wrong address never leaves the app without it.
        const probe = run(ctx.bins.ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, "true"], 20_000);
        if (probe.code !== 0) {
          return { ok: false, reason: "new address doesn't answer yet; the app keeps its old connection until it drops (up to 10 idle minutes)" };
        }
        const rm = hc.rm(app.name);
        if (!rm.ok) return rm;
        const add = hc.add(alias, app.name, app.session, ctx.interactive);
        if (!add.ok) return { ok: false, reason: `removed from the app but adding it back failed (${add.reason ?? "error"}); run doctor` };
        return add;
      },
    });
  } else {
    skip(
      report,
      "app",
      !row.app ? "not there" : !endpointChanged ? "no change needed" : appConnected ? "old connection may linger up to 10 idle minutes" : "reconnects with the new address on its own",
    );
  }

  await runSteps(ctx, steps, report);
  return result(report, { alias, endpointChanged, created: creating });
}

/**
 * A machine added with a raw address (`user@1.2.3.4`, for example from the
 * Herdr app's own add dialog) has no SSH entry to edit. This gives it one: a
 * managed Host block with the new address, then herdr and the app are moved
 * onto that alias with the same name, label and session. Nothing is removed
 * from herdr or the app until the new address answers, so an offline machine
 * with a wrong old address is safe to fix.
 */
async function repoint(ctx: Ctx, state: State, row: Row, changes: Fields, aliasOpt: string | undefined): Promise<CommandResult> {
  if (row.app?.via) throw new UsageError(`${row.alias} is reached through a command (hc --via), not ssh; change it with hc`);
  if (!changes.host) throw new UsageError(`${row.alias} uses a raw address; give the new address with --host (and a name for it with --alias)`);
  const parsed = /^(?:ssh:\/\/)?(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(row.alias);
  const fields: Fields = { user: parsed?.[1], port: parsed?.[3] };
  for (const k of Object.keys(changes) as (keyof Fields)[]) {
    if (changes[k] !== undefined) fields[k] = changes[k] === "" ? undefined : changes[k];
  }
  const sshHost = (n: string) => state.rows.find((r) => r.alias === n && r.ssh)?.ssh;
  const suggestion = [row.app?.host, row.app?.name, row.tui?.label].find((n) => n && !/^[\d.]+$/.test(n) && !aliasProblem(n) && !sshHost(n));
  const alias = aliasOpt ?? suggestion;
  if (!alias) throw new UsageError(`pick a name for ${row.alias} with --alias (a short name you'd type after ssh)`);
  const bad = aliasProblem(alias);
  if (bad) throw new UsageError(bad);
  const taken = sshHost(alias);
  if (taken && !taken.managed) throw new UsageError(`${alias} is already a Host in ${taken.file}:${taken.line}; pick another --alias`);
  const reuse = state.rows.find((r) => r.alias === alias);
  if (reuse && (reuse.tui || reuse.app)) throw new UsageError(`${alias} is already a machine here; pick another --alias`);
  const update = Boolean(reuse?.ssh?.managed);
  const blockers = writeBlockers(ctx);
  if (blockers.length > 0) throw new UsageError(blockers.join("\n"));
  if (row.tui && !ctx.interactive) throw new NeedsTerminal(`moving ${row.alias} in herdr runs herdr machine add, which may ask questions`);
  if (!(await confirm(ctx, `Move ${row.alias} to the alias ${alias} (${[fields.user, fields.host].filter(Boolean).join("@")}${fields.port ? `:${fields.port}` : ""})? It is only removed from herdr and the app once the new address answers.`, true))) {
    return { code: 1, text: "Nothing changed." };
  }

  const report = emptyReport();
  const app = row.app;
  const tui = row.tui;
  const steps: Step[] = [
    sshWriteStep(ctx, {
      title: `${update ? "update" : "write"} Host ${alias}`,
      mutate: (current) => (update ? editManagedHost(current ?? "", alias, { host: "", user: "", port: "", key: "", jump: "", ...fields }) : addManagedHost(current, alias, fields)),
      expect: { alias, fields },
    }),
    {
      side: "ssh",
      title: `check ${alias} answers`,
      run: () => {
        const probe = run(ctx.bins.ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, "true"], 20_000);
        if (probe.code === 0) return { ok: true };
        if (!ctx.interactive) return { ok: false, reason: `${alias} doesn't answer yet; the entry is saved, run this edit again once it does`, code: 1 };
        ctx.log(`${alias} needs an answer or doesn't answer. Trying once here so you can reply:`);
        const code = runInteractive(ctx.bins.ssh, [alias, "true"]);
        return code === 0 ? { ok: true, reason: "logged in" } : { ok: false, reason: `${alias} doesn't answer (exit ${code}); the entry is saved, run this edit again once it does` };
      },
    },
  ];
  if (tui && state.herdr.available) {
    const herdr = new Herdr(ctx.bins);
    steps.push({
      side: "tui",
      title: `move herdr's ${tui.label} to ${alias}`,
      run: () => {
        const rm = herdr.remove(tui.id);
        if (!rm.ok) return rm;
        return herdr.add(alias, tui.label, tui.session ?? undefined, ctx.interactive);
      },
    });
  } else skip(report, "tui", "not there");
  if (app && state.hc.available) {
    const hc = new Hc(ctx.bins);
    steps.push({
      side: "app",
      title: `move the app's ${app.name} to ${alias}`,
      run: () => {
        const rm = hc.rm(app.name);
        if (!rm.ok) return rm;
        const add = hc.add(alias, app.name, app.session, ctx.interactive);
        if (!add.ok) return { ok: false, reason: `removed ${app.name} but adding it back failed (${add.reason ?? "error"}); run: hc machine add ${alias} --name ${app.name}` };
        return add;
      },
    });
  } else skip(report, "app", "not there");

  // Unattended runs never undo here: the SSH entry is the fix, and a failed
  // check must not take it away. In a terminal you still get the choice.
  await runSteps(ctx, steps, report, ctx.onFail === "undo" ? "leave" : ctx.onFail);
  return result(report, { alias, from: row.alias, created: !update });
}

// ---------------------------------------------------------------------------
// rename

export async function rename(ctx: Ctx, alias: string, opts: { label?: string; hcName?: string; alias?: string }): Promise<CommandResult> {
  const chosen = [opts.label, opts.hcName, opts.alias].filter((v) => v !== undefined);
  if (chosen.length !== 1) throw new UsageError("rename takes exactly one of --label, --hc-name or --alias");
  const state = loadState(ctx.p, ctx.bins);
  const row = findRow(state, alias);
  const report = emptyReport();

  if (opts.label !== undefined) {
    if (!row.tui) throw new UsageError(`${alias} is not in herdr`);
    if (opts.label.trim() === "" || Buffer.byteLength(opts.label) > 128) throw new UsageError("label must be 1 to 128 bytes");
    const id = row.tui.id;
    const label = opts.label;
    await runSteps(ctx, [{ side: "tui", title: `herdr label ${label}`, run: () => new Herdr(ctx.bins).rename(id, label) }], report);
    return result(report, { alias });
  }

  if (opts.hcName !== undefined) {
    if (!row.app) throw new UsageError(`${alias} is not in the app`);
    const bad = hcNameProblem(opts.hcName);
    if (bad) throw new UsageError(`app name: ${bad}`);
    const ok = await confirm(ctx, `App addresses that use ${row.app.name} (like ${row.app.name}/t7) stop working. Rename to ${opts.hcName}?`);
    if (!ok) return { code: 1, text: "Nothing changed." };
    const name = row.app.name;
    const next = opts.hcName;
    await runSteps(ctx, [{ side: "app", title: `hc rename ${name} ${next}`, run: () => new Hc(ctx.bins).rename(name, next) }], report);
    return result(report, { alias });
  }

  const next = opts.alias!;
  if (!row.ssh?.managed) throw new UsageError(`only machines managed by this tool can change alias (${alias} is ${row.ssh ? "your own entry" : "not in SSH"})`);
  const problem = aliasProblem(next);
  if (problem) throw new UsageError(problem);
  if (state.rows.some((r) => r.alias === next)) throw new UsageError(`${next} is already used`);
  const blockers = writeBlockers(ctx);
  if (blockers.length > 0) throw new UsageError(blockers.join("\n"));
  const ok = await confirm(ctx, `Renaming the alias removes and adds ${alias} again in herdr and the app (setup runs again). Continue?`);
  if (!ok) return { code: 1, text: "Nothing changed." };

  const fields = row.ssh.fields;
  const steps: Step[] = [
    sshWriteStep(ctx, {
      title: `rename Host ${alias} to ${next}`,
      mutate: (current) => renameManagedHost(current ?? "", alias, next),
      expect: { alias: next, fields },
    }),
  ];
  if (row.tui && state.herdr.available) {
    const herdr = new Herdr(ctx.bins);
    const old = row.tui;
    const label = old.label === alias ? next : old.label;
    steps.push({
      side: "tui",
      title: `herdr: move ${alias} to ${next}`,
      run: () => {
        const rm = herdr.remove(old.id);
        if (!rm.ok) return rm;
        return herdr.add(next, label, old.session, ctx.interactive);
      },
    });
  } else skip(report, "tui", "not there");
  if (row.app && state.hc.available) {
    const hc = new Hc(ctx.bins);
    const old = row.app;
    const name = old.name === alias ? next : old.name;
    steps.push({
      side: "app",
      title: `app: move ${alias} to ${next}`,
      run: () => {
        const rm = hc.rm(old.name);
        if (!rm.ok) return rm;
        return hc.add(next, name, old.session, ctx.interactive);
      },
    });
  } else skip(report, "app", "not there");
  await runSteps(ctx, steps, report);
  return result(report, { alias: next });
}

// ---------------------------------------------------------------------------
// delete

export async function remove(ctx: Ctx, alias: string, opts: { ssh?: "keep" | "delete" }): Promise<CommandResult> {
  const state = loadState(ctx.p, ctx.bins);
  const row = findRow(state, alias);
  if (!row.tui && !row.app && !row.ssh?.managed) throw new UsageError(`${alias} is not in herdr, the app or the managed file`);
  if (!(await confirm(ctx, `Remove ${alias} from herdr and the app? Remote sessions keep running.`))) return { code: 1, text: "Nothing changed." };

  let deleteSsh = false;
  if (row.ssh?.managed) {
    if (opts.ssh) deleteSsh = opts.ssh === "delete";
    else if (!ctx.interactive) throw new UsageError("pass --ssh=keep or --ssh=delete");
    else deleteSsh = await confirm({ ...ctx, yes: false }, `Also delete the SSH entry for ${alias}?`);
  }
  if (deleteSsh) {
    const blockers = writeBlockers(ctx);
    if (blockers.length > 0) throw new UsageError(blockers.join("\n"));
  }

  const report = emptyReport();
  const steps: Step[] = [];
  const profiles = [row.tui, ...row.tuiExtra].filter((p) => p !== null);
  if (profiles.length > 0 && state.herdr.available) {
    const herdr = new Herdr(ctx.bins);
    steps.push({
      side: "tui",
      title: `herdr machine remove ${alias}`,
      run: () => {
        for (const p of profiles) {
          const r = herdr.remove(p.id);
          if (!r.ok) return r;
        }
        return { ok: true };
      },
    });
  } else skip(report, "tui", "not there");
  const machines = [row.app, ...row.appExtra].filter((m) => m !== null);
  if (machines.length > 0 && state.hc.available) {
    const hc = new Hc(ctx.bins);
    steps.push({
      side: "app",
      title: `hc machine rm ${alias}`,
      run: () => {
        for (const m of machines) {
          const r = hc.rm(m.name);
          if (!r.ok) return r;
        }
        return { ok: true };
      },
    });
  } else skip(report, "app", "not there");
  if (deleteSsh) {
    steps.push(sshWriteStep(ctx, { title: `delete Host ${alias}`, mutate: (current) => removeManagedHost(current ?? "", alias) }));
  } else skip(report, "ssh", row.ssh ? "kept" : "none");

  // Removal order: the tools first, the SSH entry last.
  const ordered = [...steps.filter((s) => s.side !== "ssh"), ...steps.filter((s) => s.side === "ssh")];
  await runSteps(ctx, ordered, report);
  return result(report, { alias, sshDeleted: deleteSsh && report.sides.ssh.state === "ok" });
}

// ---------------------------------------------------------------------------
// doctor

export interface Issue {
  alias: string;
  kind: "missing-tui" | "missing-app" | "missing-ssh" | "duplicate-tui" | "duplicate-app" | "shadowed" | "include-scoped" | "managed-in-repo";
  message: string;
  fixable: boolean;
}

export function findIssues(state: State): Issue[] {
  const issues: Issue[] = [];
  if (state.ssh.include.state === "scoped") {
    issues.push({ alias: "", kind: "include-scoped", message: `the Include line at ${state.ssh.config}:${state.ssh.include.line} sits inside a Host or Match block`, fixable: false });
  }
  if (state.ssh.managedRepo) {
    issues.push({ alias: "", kind: "managed-in-repo", message: `the managed file resolves inside the git repo ${state.ssh.managedRepo}`, fixable: false });
  }
  for (const row of state.rows) {
    if (row.raw) continue;
    if (row.ssh && isMachine(row)) {
      if (state.herdr.available && !row.tui) issues.push({ alias: row.alias, kind: "missing-tui", message: "not in herdr", fixable: true });
      if (state.hc.available && !row.app) issues.push({ alias: row.alias, kind: "missing-app", message: "not in the app", fixable: true });
    }
    if (!row.ssh && (row.tui || row.app)) {
      issues.push({ alias: row.alias, kind: "missing-ssh", message: "no SSH Host entry for this alias; add it with `add --host`, or delete the machine", fixable: false });
    }
    if (row.tuiExtra.length > 0) issues.push({ alias: row.alias, kind: "duplicate-tui", message: `${row.tuiExtra.length} extra herdr profile(s) with this target`, fixable: true });
    if (row.appExtra.length > 0) issues.push({ alias: row.alias, kind: "duplicate-app", message: `${row.appExtra.length} extra app machine(s) with this target`, fixable: true });
    if (row.ssh?.shadows) issues.push({ alias: row.alias, kind: "shadowed", message: `also defined at ${row.ssh.shadows.join(", ")}; the first definition wins`, fixable: false });
  }
  return issues;
}

function fixStep(ctx: Ctx, row: Row, issue: Issue): Step | null {
  const herdr = new Herdr(ctx.bins);
  const hc = new Hc(ctx.bins);
  switch (issue.kind) {
    case "missing-tui":
      return herdrStep(ctx, row.alias, row.alias);
    case "missing-app":
      return hcStep(ctx, row.alias, hcNameProblem(row.alias) ? cleanHcName(row.alias) : row.alias);
    case "duplicate-tui":
      return {
        side: "tui",
        title: `remove extra herdr profiles for ${row.alias}`,
        run: () => {
          for (const p of row.tuiExtra) {
            const r = herdr.remove(p.id);
            if (!r.ok) return r;
          }
          return { ok: true };
        },
      };
    case "duplicate-app":
      return {
        side: "app",
        title: `remove extra app machines for ${row.alias}`,
        run: () => {
          for (const m of row.appExtra) {
            const r = hc.rm(m.name);
            if (!r.ok) return r;
          }
          return { ok: true };
        },
      };
    default:
      return null;
  }
}

export async function doctor(ctx: Ctx, opts: { fix?: boolean }): Promise<CommandResult> {
  const state = loadState(ctx.p, ctx.bins);
  const issues = findIssues(state);
  if (issues.length === 0) return { code: 0, data: { issues, fixed: [] }, text: "No drift: SSH, herdr and the app agree." };
  for (const i of issues) ctx.log(`${i.alias ? i.alias + ": " : ""}${i.message}${i.fixable ? "" : " (fix by hand)"}`);
  const fixed: { alias: string; kind: string; report: Report }[] = [];
  const wantsFixes = opts.fix || ctx.interactive;
  if (wantsFixes) {
    for (const issue of issues.filter((i) => i.fixable)) {
      const row = state.rows.find((r) => r.alias === issue.alias)!;
      const step = fixStep(ctx, row, issue);
      if (!step) continue;
      let go = false;
      try {
        go = await confirm(ctx, `Fix ${issue.alias}: ${issue.message}?`, true);
      } catch (error) {
        if (!(error instanceof NeedsTerminal)) throw error;
      }
      if (!go) continue;
      const report = await runSteps(ctx, [step], emptyReport(), "leave");
      fixed.push({ alias: issue.alias, kind: issue.kind, report });
    }
  }
  const failed = fixed.some((f) => !f.report.ok);
  const left = issues.length - fixed.filter((f) => f.report.ok).length;
  return {
    code: failed ? 1 : 0,
    data: { issues, fixed },
    text: left === 0 ? "All fixed." : `${left} issue(s) left.`,
  };
}

// ---------------------------------------------------------------------------
// login

/**
 * Logs in again where a login is needed: `herdr machine reconnect` and
 * `hc machine login`. Both ask their questions in the terminal, so this needs one.
 */
export async function login(ctx: Ctx, alias: string): Promise<CommandResult> {
  const state = loadState(ctx.p, ctx.bins);
  const row = findRow(state, alias);
  if (!row.tui && !row.app) throw new UsageError(`${alias} is not in herdr or the app`);
  if (!ctx.interactive) throw new NeedsTerminal(`logging in to ${alias} asks for a password or code`);
  const report = emptyReport();
  const steps: Step[] = [];
  if (row.tui && state.herdr.available) {
    const id = row.tui.id;
    steps.push({ side: "tui", title: `herdr machine reconnect ${alias}`, run: () => new Herdr(ctx.bins).reconnect(id) });
  } else skip(report, "tui", "not there");
  if (row.app && state.hc.available) {
    const name = row.app.name;
    steps.push({ side: "app", title: `hc machine login ${name}`, run: () => new Hc(ctx.bins).login(name) });
  } else skip(report, "app", "not there");
  skip(report, "ssh", "unchanged");
  await runSteps(ctx, steps, report);
  return result(report, { alias });
}

// ---------------------------------------------------------------------------
// check

export const MIN_NODE: [number, number] = [22, 18];

/**
 * Checks the requirements: Node 22.18 or newer (the one running this),
 * OpenSSH's ssh and herdr. hc is optional: with it, every change also reaches
 * the Herdr app. The herdr plugin runs this as its build step, so a missing
 * requirement stops `herdr plugin install`.
 */
export async function check(ctx: Ctx): Promise<CommandResult> {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  const items = [
    { name: "node", found: process.execPath as string | undefined, ok: nodeOk, required: true, need: `Node ${MIN_NODE.join(".")} or newer (running ${process.versions.node})` },
    ...([
      ["ssh", ctx.bins.ssh, true, "the OpenSSH client"],
      ["herdr", ctx.bins.herdr, true, "the herdr TUI (https://herdr.dev)"],
      ["hc", ctx.bins.hc, false, "herdr-core's hc (comes with the Herdr app); without it the APP column is skipped"],
    ] as const).map(([name, bin, required, need]) => {
      const found = findExecutable(bin);
      return { name, found, ok: Boolean(found), required, need };
    }),
  ];
  const missing = items.filter((i) => !i.ok && i.required);
  const lines = items.map((i) => `  ${i.ok ? "✓" : i.required ? "✕" : "○"} ${i.name.padEnd(5)} ${i.ok ? i.found : `${i.required ? "missing" : "optional, not found"}: ${i.need}`}`);
  lines.push(missing.length === 0 ? "All requirements found." : `Missing ${missing.map((i) => i.name).join(", ")}. Install them and try again.`);
  return {
    code: missing.length === 0 ? EXIT.ok : EXIT.failed,
    data: { ok: missing.length === 0, requirements: items },
    text: lines.join("\n"),
  };
}
