// End to end runs of the CLI against fake herdr, hc and ssh in a throwaway HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers.ts";

const MANAGED = ".ssh/config.d/herdr-machines";

test("add writes the SSH entry, puts the Include at the top and registers both tools", () => {
  const sb = sandbox();
  sb.write(".ssh/config", "Host github.com\n  User git\n");
  const r = sb.run(["add", "vps", "--host", "203.0.113.5", "--user", "root", "--port", "2222", "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.report.sides.ssh, { state: "ok" });
  assert.equal(r.json.report.sides.tui.state, "ok");
  assert.equal(r.json.report.sides.app.state, "ok");

  const config = sb.read(".ssh/config");
  assert.match(config, /^# Added by herdr-machines.*\nInclude ~\/\.ssh\/config\.d\/herdr-machines\n\nHost github\.com/);
  assert.match(sb.read(MANAGED), /Host vps\n  HostName 203\.0\.113\.5\n  User root\n  Port 2222\n/);
  assert.equal(statSync(join(sb.home, MANAGED)).mode & 0o777, 0o600);
  assert.deepEqual(sb.herdr().map((p) => [p.label, p.target]), [["vps", "vps"]]);
  assert.deepEqual(sb.hc().map((m) => [m.name, m.target]), [["vps", "vps"]]);
  assert.ok(sb.calls().includes("ssh -G vps"));
  assert.ok(sb.calls().some((c) => c.startsWith("ssh -o BatchMode=yes")));

  // A second add uses a backup and leaves the Include alone.
  const r2 = sb.run(["add", "vps2", "--host", "203.0.113.6", "--same-as-last", "--json"]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(sb.read(MANAGED), /Host vps2\n  HostName 203\.0\.113\.6\n  User root\n  Port 2222\n/);
  assert.equal(sb.read(".ssh/config").match(/Include/g)!.length, 1);
  assert.ok(readdirSync(join(sb.home, ".local/state/herdr-machines/backups")).length >= 2);
});

test("add refuses bad input before writing anything", () => {
  const sb = sandbox();
  sb.write(".ssh/config", "Host mine\n  HostName 1.1.1.1\n");
  assert.equal(sb.run(["add", "Prod", "--host", "x"]).code, 2);
  assert.equal(sb.run(["add", "box"]).code, 2);
  assert.equal(sb.run(["add", "box", "--host", "x", "--port", "99999"]).code, 2);
  const taken = sb.run(["add", "mine", "--host", "2.2.2.2"]);
  assert.equal(taken.code, 2);
  assert.match(taken.stderr, /use adopt/);
  assert.ok(!existsSync(join(sb.home, MANAGED)));
  assert.deepEqual(sb.calls(), sb.calls().filter((c) => c.includes(" list") || c.includes(" ls")));
});

test("add keeps a symlinked ~/.ssh/config a symlink", () => {
  const sb = sandbox();
  sb.write("dotfiles/ssh/config", "Host a\n");
  symlinkSync(join(sb.home, "dotfiles/ssh/config"), join(sb.home, ".ssh/config"), "file");
  // Not a repo: config is in a plain folder.
  assert.equal(sb.run(["add", "box", "--host", "1.2.3.4"]).code, 0);
  assert.ok(lstatSync(join(sb.home, ".ssh/config")).isSymbolicLink());
  assert.match(readFileSync(join(sb.home, "dotfiles/ssh/config"), "utf8"), /^# Added by/);
});

test("add refuses to put the managed file inside a git repo", () => {
  const sb = sandbox();
  mkdirSync(join(sb.home, "dotfiles/.git"), { recursive: true });
  mkdirSync(join(sb.home, "dotfiles/ssh-config.d"), { recursive: true });
  symlinkSync(join(sb.home, "dotfiles/ssh-config.d"), join(sb.home, ".ssh/config.d"));
  const r = sb.run(["add", "box", "--host", "1.2.3.4"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside the git repo/);
  assert.equal(sb.run(["add", "box", "--host", "1.2.3.4"], { HERDR_MACHINES_ALLOW_REPO: "1" }).code, 0);
});

test("add rolls the SSH write back when ssh -G disagrees", () => {
  const sb = sandbox();
  // An Include inside a Host block: ssh would not see the managed file.
  sb.write(".ssh/config", "Host a\n  Include ~/.ssh/config.d/herdr-machines\n");
  const r = sb.run(["add", "box", "--host", "1.2.3.4"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside a Host or Match block/);
});

test("a failing tool step is reported and can be undone", () => {
  const sb = sandbox();
  const r = sb.run(["add", "box", "--host", "1.2.3.4", "--json", "--on-fail=undo"], { FAKE_HC_FAIL_ADD: "1" });
  assert.equal(r.code, 1);
  assert.equal(r.json.report.sides.app.state, "failed");
  assert.equal(r.json.report.sides.tui.state, "undone");
  assert.equal(r.json.report.sides.ssh.state, "undone");
  assert.deepEqual(sb.herdr(), []);
  assert.ok(!existsSync(join(sb.home, MANAGED)));
});

test("without a terminal, an ssh connection that needs answers stops with exit 3", () => {
  const sb = sandbox();
  const r = sb.run(["add", "box", "--host", "1.2.3.4", "--json"], { FAKE_SSH_REACH: "255" });
  assert.equal(r.code, 3);
  assert.equal(r.json.report.sides.tui.state, "untouched");
});

test("list merges by target and shows health", () => {
  const sb = sandbox();
  sb.write(".ssh/config", "Host mine\n  HostName 9.9.9.9\n");
  sb.run(["add", "box", "--host", "1.2.3.4"]);
  sb.run(["rename", "box", "--label", "Build box"]);
  const r = sb.run(["list", "--json", "--health"], { FAKE_HERDR_STATUS: "auth required" });
  assert.equal(r.code, 0);
  assert.equal(r.json.machines.length, 1);
  const box = r.json.machines[0];
  assert.equal(box.tui.label, "Build box");
  assert.equal(box.tui.health, "auth required");
  assert.deepEqual(box.glyphs, { ssh: "●", tui: "!", app: "●" });
  assert.equal(sb.run(["list", "--json", "--all"]).json.machines.length, 2);
  assert.match(sb.run(["list"]).stdout, /box\s+●\s+●\s+●\s+1\.2\.3\.4/);
});

test("adopt registers your own host without touching its SSH entry", () => {
  const sb = sandbox();
  const own = "Host Work_Box\n  HostName 10.0.0.2\n";
  sb.write(".ssh/config", own);
  const r = sb.run(["adopt", "Work_Box", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.appName, "work_box");
  assert.equal(sb.read(".ssh/config"), own);
  assert.ok(!existsSync(join(sb.home, MANAGED)));
  assert.deepEqual(sb.hc().map((m) => [m.name, m.target]), [["work_box", "Work_Box"]]);
  assert.equal(sb.run(["edit", "Work_Box", "--port", "2"]).code, 2);
});

test("edit changes the entry and refreshes the app's login after an endpoint change", () => {
  const sb = sandbox();
  sb.run(["add", "box", "--host", "1.2.3.4", "--session", "work"]);
  const before = sb.calls().length;
  const r = sb.run(["edit", "box", "--port", "2200", "--user", "admin", "--yes", "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(sb.read(MANAGED), /HostName 1\.2\.3\.4\n  User admin\n  Port 2200\n/);
  const calls = sb.calls().slice(before);
  assert.ok(calls.includes("hc machine rm box"));
  assert.ok(calls.includes("hc machine add box --name box --session work"));
  assert.ok(!calls.some((c) => c.startsWith("herdr machine add")));

  // A key-only change needs no refresh.
  const mid = sb.calls().length;
  assert.equal(sb.run(["edit", "box", "--key", "~/.ssh/id_box", "--json"]).code, 0);
  assert.ok(!sb.calls().slice(mid).some((c) => c.startsWith("hc machine rm")));

  // Clearing an option.
  assert.equal(sb.run(["edit", "box", "--user", "", "--yes"]).code, 0);
  assert.doesNotMatch(sb.read(MANAGED), /User admin/);
});

test("edit without a terminal and without --yes stops at the question", () => {
  const sb = sandbox();
  sb.run(["add", "box", "--host", "1.2.3.4"]);
  assert.equal(sb.run(["edit", "box", "--host", "5.6.7.8", "--json"]).code, 3);
  assert.match(sb.read(MANAGED), /1\.2\.3\.4/);
});

test("rename: label, app name and alias", () => {
  const sb = sandbox();
  sb.run(["add", "box", "--host", "1.2.3.4", "--session", "s1"]);
  assert.equal(sb.run(["rename", "box", "--hc-name", "boxy"]).code, 3);
  assert.equal(sb.run(["rename", "box", "--hc-name", "boxy", "--yes"]).code, 0);
  assert.equal(sb.hc()[0]!.name, "boxy");

  const r = sb.run(["rename", "box", "--alias", "newbox", "--yes", "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(sb.read(MANAGED), /Host newbox\n/);
  assert.deepEqual(sb.herdr().map((p) => [p.label, p.target, p.session]), [["newbox", "newbox", "s1"]]);
  assert.deepEqual(sb.hc().map((m) => [m.name, m.target, m.session]), [["boxy", "newbox", "s1"]]);
  assert.equal(sb.run(["rename", "newbox", "--label", "x", "--alias", "y"]).code, 2);
});

test("delete asks about the SSH entry and removes duplicates", () => {
  const sb = sandbox();
  sb.run(["add", "box", "--host", "1.2.3.4"]);
  sb.run(["add", "keep", "--host", "1.2.3.5"]);
  sb.seedHerdr([...sb.herdr(), { id: "dup", label: "again", target: "box", session: "default", enabled: true, selected: false }]);
  assert.equal(sb.run(["delete", "box", "--yes"]).code, 2);
  const r = sb.run(["delete", "box", "--yes", "--ssh=delete", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.sshDeleted, true);
  assert.deepEqual(sb.herdr().map((p) => p.target), ["keep"]);
  assert.deepEqual(sb.hc().map((m) => m.target), ["keep"]);
  assert.doesNotMatch(sb.read(MANAGED), /Host box/);
  assert.match(sb.read(MANAGED), /Host keep/);

  assert.equal(sb.run(["delete", "keep", "--yes", "--ssh=keep"]).code, 0);
  assert.match(sb.read(MANAGED), /Host keep/);
});

test("doctor finds drift and fixes it with --fix --yes", () => {
  const sb = sandbox();
  sb.write(".ssh/config", "Host mine\n  HostName 9.9.9.9\n");
  sb.run(["add", "box", "--host", "1.2.3.4"]);
  sb.seedHc([]);
  sb.seedHerdr([...sb.herdr(), { id: "x1", label: "ghost", target: "ghost", session: "default", enabled: true, selected: false }]);
  const report = sb.run(["doctor", "--json"]);
  const kinds = report.json.issues.map((i: { alias: string; kind: string }) => `${i.alias}:${i.kind}`).sort();
  assert.deepEqual(kinds, ["box:missing-app", "ghost:missing-ssh"]);
  const fixed = sb.run(["doctor", "--fix", "--yes", "--json"]);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.deepEqual(sb.hc().map((m) => m.target), ["box"]);
});

test("setup saves binary paths and the running node", () => {
  const sb = sandbox();
  const r = sb.run(["setup", "--json"], { SHELL: "/bin/sh" });
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(sb.home, ".local/state/herdr-machines/bins.json"), "utf8"));
  assert.equal(saved.node, process.execPath);
});

test("unknown commands and flags are bad input", () => {
  const sb = sandbox();
  assert.equal(sb.run(["frobnicate"]).code, 2);
  assert.equal(sb.run(["list", "--nope"]).code, 2);
  writeFileSync(join(sb.home, ".ssh/config"), "");
  assert.equal(sb.run(["help"]).code, 0);
});
