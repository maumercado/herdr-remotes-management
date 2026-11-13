// Runs a change across the three places in a fixed order and reports what
// happened in each. A failed step stops the run; you choose to retry it, undo
// the steps already done, or leave things as they are (doctor shows it later).

import type { Ctx } from "./io.ts";
import { choose, NeedsTerminal } from "./io.ts";

export type Side = "ssh" | "tui" | "app";

export interface StepResult {
  ok: boolean;
  reason?: string;
  /** Exit code the whole command should use when this step fails. Defaults to 1. */
  code?: number;
}

export interface Step {
  side: Side;
  title: string;
  run: () => StepResult | Promise<StepResult>;
  undo?: () => StepResult | Promise<StepResult>;
  /**
   * A follow-up that the change doesn't depend on (a reconnect, say). When it
   * fails, the report shows it and the run goes on: no retry or undo question,
   * and the command still succeeds.
   */
  soft?: boolean;
}

export type SideState = "ok" | "failed" | "skipped" | "undone" | "untouched";

export interface Report {
  ok: boolean;
  code: number;
  sides: Record<Side, { state: SideState; note?: string }>;
  undone: boolean;
}

export const SIDES: Side[] = ["ssh", "tui", "app"];

export function emptyReport(): Report {
  return {
    ok: true,
    code: 0,
    undone: false,
    sides: { ssh: { state: "untouched" }, tui: { state: "untouched" }, app: { state: "untouched" } },
  };
}

const GLYPH: Record<SideState, string> = { ok: "✓", failed: "✕", skipped: "–", undone: "↺", untouched: "·" };

/** `ssh ✓  tui ✓  app ✕ (needs_login)` */
export function formatReport(report: Report): string {
  return SIDES.map((side) => {
    const { state, note } = report.sides[side];
    return `${side} ${GLYPH[state]}${note ? ` (${note})` : ""}`;
  }).join("  ");
}

export function skip(report: Report, side: Side, note: string): void {
  if (report.sides[side].state === "untouched") report.sides[side] = { state: "skipped", note };
}

export type FailPolicy = Ctx["onFail"];

export async function runSteps(ctx: Ctx, steps: Step[], report = emptyReport(), policy: FailPolicy = ctx.onFail): Promise<Report> {
  const done: Step[] = [];
  for (const step of steps) {
    for (;;) {
      ctx.log(`… ${step.title}`);
      let result: StepResult;
      try {
        result = await step.run();
      } catch (error) {
        if (error instanceof NeedsTerminal) result = { ok: false, reason: "needs a terminal", code: 3 };
        else result = { ok: false, reason: (error as Error).message };
      }
      if (result.ok) {
        report.sides[step.side] = { state: "ok", note: result.reason };
        done.push(step);
        break;
      }
      if (step.soft) {
        report.sides[step.side] = { state: "failed", note: result.reason };
        ctx.log(`✕ ${step.title}: ${result.reason ?? "failed"} (the change itself is kept)`);
        break;
      }
      report.sides[step.side] = { state: "failed", note: result.reason };
      report.ok = false;
      report.code = result.code ?? 1;
      ctx.log(`✕ ${step.title}: ${result.reason ?? "failed"}`);

      let decision: "r" | "u" | "l" = policy === "undo" ? "u" : "l";
      if (policy === "ask" && ctx.interactive && !ctx.yes) {
        try {
          decision = await choose<"r" | "u" | "l">(ctx, "What now?", { r: "retry", u: "undo the steps done", l: "leave it" }, "l");
        } catch {
          decision = "l";
        }
      }
      if (decision === "r") {
        report.ok = true;
        report.code = 0;
        continue;
      }
      if (decision === "u") await undoAll(ctx, done, report);
      return report;
    }
  }
  return report;
}

async function undoAll(ctx: Ctx, done: Step[], report: Report): Promise<void> {
  for (const step of [...done].reverse()) {
    if (!step.undo) continue;
    ctx.log(`↺ undo ${step.title}`);
    try {
      const r = await step.undo();
      report.sides[step.side] = r.ok ? { state: "undone" } : { state: "failed", note: `undo failed: ${r.reason ?? ""}` };
    } catch (error) {
      report.sides[step.side] = { state: "failed", note: `undo failed: ${(error as Error).message}` };
    }
  }
  report.undone = true;
}
