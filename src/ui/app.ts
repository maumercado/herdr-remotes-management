// Placeholder until the TUI popup lands.
import type { Ctx } from "../io.ts";

export async function runUi(_ctx: Ctx): Promise<number> {
  process.stderr.write("herdr-machines ui: not built yet\n");
  return 1;
}
