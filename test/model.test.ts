import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, isMachine } from "../src/model.ts";
import { aliasProblem, cleanHcName, hcNameProblem, portProblem, sshAliasProblem } from "../src/tools.ts";
import type { HostEntry } from "../src/sshconfig.ts";

const host = (alias: string, file: string, fields = {}): HostEntry => ({ alias, file, line: 1, fields, siblings: [] });
const profile = (id: string, target: string, label = target) => ({ id, label, target, session: "default", enabled: true, selected: false });

test("rows are matched by target, never by label or name", () => {
  const rows = merge(
    [host("box", "/m", { host: "1.1.1.1" }), host("mine", "/c")],
    "/m",
    [profile("p1", "box", "Build machine"), profile("p2", "box"), profile("p3", "me@raw.host")],
    [{ name: "renamed", target: "box" }, { name: "cmd", target: "ssh -J x y", via: true }],
  );
  const box = rows.find((r) => r.alias === "box")!;
  assert.equal(box.ssh?.managed, true);
  assert.equal(box.tui?.label, "Build machine");
  assert.equal(box.tuiExtra.length, 1);
  assert.equal(box.app?.name, "renamed");
  assert.equal(rows.find((r) => r.alias === "mine")!.ssh?.managed, false);
  assert.equal(rows.find((r) => r.alias === "me@raw.host")!.raw, true);
  assert.equal(rows.find((r) => r.alias === "ssh -J x y")!.raw, true);
  assert.ok(!isMachine(rows.find((r) => r.alias === "mine")!));
  assert.ok(isMachine(box));
});

test("a managed entry wins over the same alias in your own config, which is flagged", () => {
  const rows = merge([host("dup", "/c"), host("dup", "/m", { host: "2.2.2.2" })], "/m", [], []);
  assert.equal(rows[0]!.ssh?.managed, true);
  assert.deepEqual(rows[0]!.ssh?.shadows, ["/c:1"]);
});

test("hc name rules match herdr-core's check_name", () => {
  assert.equal(hcNameProblem("box-1.lan"), null);
  assert.ok(hcNameProblem("Box"));
  assert.ok(hcNameProblem("-x"));
  assert.ok(hcNameProblem("t7"));
  assert.ok(hcNameProblem("t1b"));
  assert.equal(hcNameProblem("t0"), null);
  assert.equal(hcNameProblem("ta"), null);
  assert.ok(hcNameProblem("a".repeat(33)));
  assert.equal(cleanHcName("My Server!"), "my-server-");
  assert.equal(cleanHcName("__"), "machine");
});

test("alias and port checks", () => {
  assert.equal(aliasProblem("vps"), null);
  assert.ok(sshAliasProblem("a b"));
  assert.ok(sshAliasProblem("*.x"));
  assert.ok(sshAliasProblem("me@x"));
  assert.match(aliasProblem("Prod")!, /Herdr app name/);
  assert.equal(portProblem("22"), null);
  assert.ok(portProblem("0"));
  assert.ok(portProblem("22a"));
});
