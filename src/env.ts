// Where things live. Every path comes from the environment at call time so
// tests can point HOME and XDG_STATE_HOME at a temporary folder.

import { join } from "node:path";
import { homedir } from "node:os";

export const TOOL = "herdr-machines";

export interface Paths {
  home: string;
  sshDir: string;
  sshConfig: string;
  managedDir: string;
  managedFile: string;
  /** How the Include line spells the managed file. */
  includeSpelling: string;
  stateDir: string;
  backupsDir: string;
  lockFile: string;
  lastFile: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir();
  const sshDir = join(home, ".ssh");
  const managedDir = join(sshDir, "config.d");
  const stateRoot = env.XDG_STATE_HOME || join(home, ".local", "state");
  const stateDir = join(stateRoot, TOOL);
  return {
    home,
    sshDir,
    sshConfig: join(sshDir, "config"),
    managedDir,
    managedFile: join(managedDir, TOOL),
    includeSpelling: `~/.ssh/config.d/${TOOL}`,
    stateDir,
    backupsDir: join(stateDir, "backups"),
    lockFile: join(stateDir, "lock"),
    lastFile: join(stateDir, "last.json"),
  };
}
