import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addInclude,
  addManagedHost,
  checkInclude,
  compareResolved,
  editManagedHost,
  expandGlob,
  hasManagedHost,
  parseLine,
  parseResolved,
  readConfig,
  removeManagedHost,
  renameManagedHost,
} from "../src/sshconfig.ts";

function tree(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "hm-ssh-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(home, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return home;
}

test("parseLine handles spacing, = and quotes, and skips comments", () => {
  assert.deepEqual(parseLine("Host foo bar"), { key: "host", args: ["foo", "bar"] });
  assert.deepEqual(parseLine("  HostName=1.2.3.4"), { key: "hostname", args: ["1.2.3.4"] });
  assert.deepEqual(parseLine("Port = 2222"), { key: "port", args: ["2222"] });
  assert.deepEqual(parseLine('IdentityFile "~/My Keys/id"'), { key: "identityfile", args: ["~/My Keys/id"] });
  assert.equal(parseLine("# Host commented"), null);
  assert.equal(parseLine("   "), null);
});

test("readConfig collects literal aliases, patterns and Match blocks, first value wins", () => {
  const home = tree({
    ".ssh/config": [
      "Host web db !bastion *.prod",
      "  HostName 10.0.0.1",
      "  HostName ignored",
      "  user deploy",
      "Match host x",
      "  User nope",
      "Host=solo",
      "  Port 2200",
    ].join("\n"),
  });
  const r = readConfig(join(home, ".ssh/config"), { home, baseDir: join(home, ".ssh") });
  assert.deepEqual(r.hosts.map((h) => h.alias), ["web", "db", "solo"]);
  assert.deepEqual(r.hosts[0]!.fields, { host: "10.0.0.1", user: "deploy" });
  assert.deepEqual(r.hosts[0]!.siblings, ["db"]);
  assert.deepEqual(r.hosts[2]!.fields, { port: "2200" });
  assert.deepEqual(r.patterns.map((p) => p.pattern), ["!bastion", "*.prod"]);
  assert.equal(r.matchBlocks.length, 1);
});

test("readConfig follows relative, ~ and glob Includes, once each", () => {
  const home = tree({
    ".ssh/config": "Include config.d/*\nInclude ~/.ssh/extra\nInclude config\nHost top\n",
    ".ssh/config.d/a": "Host a1\n",
    ".ssh/config.d/b": "Host b1\nInclude ../config.d/a\n",
    ".ssh/extra": "Host extra1\n",
  });
  const r = readConfig(join(home, ".ssh/config"), { home, baseDir: join(home, ".ssh") });
  assert.deepEqual(r.hosts.map((h) => h.alias).sort(), ["a1", "b1", "extra1", "top"]);
  assert.equal(r.files.length, 4);
});

test("expandGlob matches files only and skips dot files", () => {
  const home = tree({ "d/one": "", "d/two": "", "d/.hidden": "", "d/sub/x": "" });
  assert.deepEqual(expandGlob(join(home, "d/*")).map((p) => p.slice(home.length)), ["/d/one", "/d/two"]);
});

test("managed file: add, edit, rename and remove keep everything else", () => {
  let text = addManagedHost(null, "box", { host: "1.2.3.4", user: "me" });
  assert.match(text, /^# Managed by herdr-machines/);
  text = text.replace("  User me\n", "  User me\n  # keep this comment\n  ForwardAgent yes\n");
  text = addManagedHost(text, "other", { host: "5.6.7.8", key: "~/My Keys/id" });
  assert.match(text, /IdentityFile "~\/My Keys\/id"/);

  text = editManagedHost(text, "box", { port: "2222", user: "" });
  assert.match(text, /Host box\n  HostName 1\.2\.3\.4\n  # keep this comment\n  ForwardAgent yes\n  Port 2222\n/);
  assert.doesNotMatch(text, /User me/);

  text = renameManagedHost(text, "box", "box2");
  assert.ok(hasManagedHost(text, "box2"));
  assert.ok(!hasManagedHost(text, "box"));
  assert.throws(() => renameManagedHost(text, "box2", "other"));

  text = removeManagedHost(text, "box2");
  assert.ok(!text.includes("ForwardAgent"));
  assert.ok(hasManagedHost(text, "other"));
  assert.throws(() => addManagedHost(text, "other", { host: "x" }));
});

test("Include check: present at the top, missing, or scoped inside a block", () => {
  const home = "/h";
  const managed = "/h/.ssh/config.d/herdr-machines";
  const base = "/h/.ssh";
  assert.equal(checkInclude(null, managed, home, base).state, "missing");
  assert.equal(checkInclude("Include ~/.ssh/config.d/herdr-machines\nHost a\n", managed, home, base).state, "present");
  assert.equal(checkInclude("Include config.d/herdr-machines\n", managed, home, base).state, "present");
  assert.deepEqual(checkInclude("Host a\n  Include ~/.ssh/config.d/herdr-machines\n", managed, home, base), { state: "scoped", line: 2 });
  assert.equal(checkInclude("Host a\n  User b\n", managed, home, base).state, "missing");
});

test("addInclude puts the line above everything", () => {
  const out = addInclude("Host a\n  User b\n", "~/.ssh/config.d/herdr-machines");
  const lines = out.split("\n");
  assert.equal(lines[1], "Include ~/.ssh/config.d/herdr-machines");
  assert.equal(lines[3], "Host a");
  assert.equal(addInclude(null, "x").split("\n")[1], "Include x");
});

test("ssh -G output is compared with what was written", () => {
  const got = parseResolved("host box\nhostname 1.2.3.4\nuser me\nport 2222\n");
  assert.deepEqual(compareResolved({ host: "1.2.3.4", user: "me", port: "2222" }, got), []);
  assert.equal(compareResolved({ host: "9.9.9.9" }, got).length, 1);
  assert.deepEqual(compareResolved({ host: "1.2.3.4" }, got), []);
});
