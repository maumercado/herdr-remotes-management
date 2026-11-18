// The app's machines while they are disconnected. hc has no disconnect, only
// `hc machine rm`, so disconnecting remembers the name and session here by
// target, and connecting adds the machine back with them. Its spaces live in
// that machine's core, so they come back too.

import type { Paths } from "./env.ts";
import { readJson, writeJson } from "./fsx.ts";

export interface DisconnectedApp {
  name: string;
  session: string | null;
}

export type DisconnectedApps = Record<string, DisconnectedApp>;

export function readDisconnected(p: Paths): DisconnectedApps {
  return readJson<DisconnectedApps>(p.disconnectedFile, {});
}

export function rememberDisconnected(p: Paths, target: string, app: DisconnectedApp): void {
  writeJson(p.disconnectedFile, { ...readDisconnected(p), [target]: app });
}

export function forgetDisconnected(p: Paths, target: string): void {
  const { [target]: _gone, ...rest } = readDisconnected(p);
  writeJson(p.disconnectedFile, rest);
}
