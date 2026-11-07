import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, runSteps } from "../src/steps.ts";
import type { Ctx } from "../src/io.ts";
import { paths } from "../src/env.ts";

function ctx(onFail: Ctx["onFail"]): Ctx {
  return { p: paths({ HOME: "/nowhere" }), bins: { herdr: "herdr", hc: "hc", ssh: "ssh" }, json: true, yes: false, interactive: false, onFail, log: () => {} };
}

test("a failed step stops the run and leaves earlier steps in place", async () => {
  const undone: string[] = [];
  const report = await runSteps(ctx("leave"), [
    { side: "ssh", title: "a", run: () => ({ ok: true }), undo: () => (undone.push("a"), { ok: true }) },
    { side: "tui", title: "b", run: () => ({ ok: false, reason: "boom" }) },
    { side: "app", title: "c", run: () => assert.fail("must not run") },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.code, 1);
  assert.deepEqual(undone, []);
  assert.equal(formatReport(report), "ssh ✓  tui ✕ (boom)  app ·");
});

test("undo runs the finished steps backwards", async () => {
  const undone: string[] = [];
  const report = await runSteps(ctx("undo"), [
    { side: "ssh", title: "a", run: () => ({ ok: true }), undo: () => (undone.push("a"), { ok: true }) },
    { side: "tui", title: "b", run: () => ({ ok: true }), undo: () => (undone.push("b"), { ok: true }) },
    { side: "app", title: "c", run: () => ({ ok: false, reason: "needs_login", code: 3 }) },
  ]);
  assert.deepEqual(undone, ["b", "a"]);
  assert.equal(report.code, 3);
  assert.equal(formatReport(report), "ssh ↺  tui ↺  app ✕ (needs_login)");
});

test("thrown errors become failed steps", async () => {
  const report = await runSteps(ctx("leave"), [{ side: "app", title: "x", run: () => { throw new Error("nope"); } }]);
  assert.equal(report.sides.app.note, "nope");
});
