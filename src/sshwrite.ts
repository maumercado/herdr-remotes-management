// The SSH side of every change: the Include line, the managed file, the
// `ssh -G` check, and the one time connection check.

import { readText, atomicWrite, backup, restore, withLock, ensureDir } from "./fsx.ts";
import type { Ctx } from "./io.ts";
import { run, runInteractive } from "./proc.ts";
import type { Fields } from "./sshconfig.ts";
import { addInclude, checkInclude, compareResolved, parseResolved } from "./sshconfig.ts";
import { gitRepoOf } from "./fsx.ts";
import type { Step, StepResult } from "./steps.ts";

export interface SshChange {
  title: string;
  /** Returns the new managed file content from the current one (null when there is no file yet). */
  mutate: (current: string | null) => string;
  /** When set, `ssh -G alias` must resolve to these values after the write. */
  expect?: { alias: string; fields: Fields };
}

export function allowRepoWrites(): boolean {
  return process.env.HERDR_MACHINES_ALLOW_REPO === "1";
}

/** Problems that stop any write before it starts. */
export function writeBlockers(ctx: Ctx): string[] {
  const problems: string[] = [];
  const repo = gitRepoOf(ctx.p.managedFile);
  if (repo && !allowRepoWrites()) {
    problems.push(
      `the managed file ${ctx.p.managedFile} would be written inside the git repo ${repo} (dotfiles?). ` +
        "Move ~/.ssh/config.d out of the repo, or set HERDR_MACHINES_ALLOW_REPO=1 if that is what you want.",
    );
  }
  const include = checkInclude(readText(ctx.p.sshConfig), ctx.p.managedFile, ctx.p.home, ctx.p.sshDir);
  if (include.state === "scoped") {
    problems.push(
      `${ctx.p.sshConfig}:${include.line} includes the managed file inside a Host or Match block, so it only applies there. ` +
        "Move that Include line above the first Host block.",
    );
  }
  return problems;
}

export function sshWriteStep(ctx: Ctx, change: SshChange): Step {
  let managedBackup: string | null | undefined;
  let configBackup: string | null | undefined;

  const doWrite = (): StepResult =>
    withLock(ctx.p, () => {
      const blockers = writeBlockers(ctx);
      if (blockers.length > 0) return { ok: false, reason: blockers.join(" "), code: 2 };

      const configText = readText(ctx.p.sshConfig);
      const include = checkInclude(configText, ctx.p.managedFile, ctx.p.home, ctx.p.sshDir);
      ensureDir(ctx.p.sshDir);
      ensureDir(ctx.p.managedDir);

      const current = readText(ctx.p.managedFile);
      let next: string;
      try {
        next = change.mutate(current);
      } catch (error) {
        return { ok: false, reason: (error as Error).message, code: 2 };
      }

      configBackup = undefined;
      if (include.state === "missing") {
        configBackup = backup(ctx.p.sshConfig, ctx.p);
        atomicWrite(ctx.p.sshConfig, addInclude(configText, ctx.p.includeSpelling), configText === null ? 0o600 : undefined);
      }
      managedBackup = backup(ctx.p.managedFile, ctx.p);
      atomicWrite(ctx.p.managedFile, next, 0o600);

      if (change.expect) {
        const r = run(ctx.bins.ssh, ["-G", change.expect.alias], 10_000);
        const problems =
          r.code !== 0 ? [`ssh -G failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`] : compareResolved(change.expect.fields, parseResolved(r.stdout));
        if (problems.length > 0) {
          rollback();
          return { ok: false, reason: `rolled back: ${problems.join("; ")}` };
        }
      }
      return { ok: true };
    });

  const rollback = (): void => {
    if (managedBackup !== undefined) restore(ctx.p.managedFile, managedBackup, 0o600);
    if (configBackup !== undefined) restore(ctx.p.sshConfig, configBackup);
    managedBackup = undefined;
    configBackup = undefined;
  };

  return {
    side: "ssh",
    title: change.title,
    run: doWrite,
    undo: () =>
      withLock(ctx.p, () => {
        rollback();
        return { ok: true };
      }),
  };
}

/**
 * Checks that ssh can log in without asking. When it can't and someone is at
 * the terminal, runs ssh once in the foreground so the host key and any
 * password are answered a single time, before herdr and hc connect.
 */
export function reachStep(ctx: Ctx, alias: string): Step {
  return {
    side: "ssh",
    title: `check ssh ${alias}`,
    run: () => {
      const batch = run(ctx.bins.ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, "true"], 20_000);
      if (batch.code === 0) return { ok: true };
      if (!ctx.interactive) {
        return { ok: false, reason: "ssh needs an answer (host key or password); run this in a terminal", code: 3 };
      }
      ctx.log(`ssh ${alias} needs an answer. Running it once here so you can reply:`);
      const code = runInteractive(ctx.bins.ssh, [alias, "true"]);
      if (code !== 0) return { ok: false, reason: `ssh ${alias} failed (exit ${code})` };
      ctx.log("Connected. If your key has a passphrase, load it with ssh-add so background connections can use it too.");
      return { ok: true, reason: "logged in" };
    },
  };
}
