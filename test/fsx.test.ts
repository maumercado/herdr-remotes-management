import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, backup, gitRepoOf, KEEP_BACKUPS, realTarget, restore, withLock } from "../src/fsx.ts";
import { paths } from "../src/env.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "hm-fs-"));
}

test("atomicWrite writes through a symlink and keeps it a symlink", () => {
  const h = home();
  mkdirSync(join(h, "dotfiles/ssh"), { recursive: true });
  mkdirSync(join(h, ".ssh"));
  writeFileSync(join(h, "dotfiles/ssh/config"), "old\n", { mode: 0o644 });
  symlinkSync(join(h, "dotfiles/ssh/config"), join(h, ".ssh/config"));
  atomicWrite(join(h, ".ssh/config"), "new\n");
  assert.ok(lstatSync(join(h, ".ssh/config")).isSymbolicLink());
  assert.equal(readFileSync(join(h, "dotfiles/ssh/config"), "utf8"), "new\n");
  assert.equal(statSync(join(h, "dotfiles/ssh/config")).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(join(h, "dotfiles/ssh")), ["config"]);
});

test("realTarget follows a dangling symlink to where the file would be", () => {
  const h = home();
  symlinkSync(join(h, "nowhere/file"), join(h, "link"));
  assert.equal(realTarget(join(h, "link")), join(h, "nowhere/file"));
});

test("new files get mode 600 by default", () => {
  const h = home();
  atomicWrite(join(h, "a/b/file"), "x");
  assert.equal(statSync(join(h, "a/b/file")).mode & 0o777, 0o600);
});

test("backups keep the last 10 and restore puts content back or removes the file", () => {
  const h = home();
  const p = paths({ HOME: h });
  const file = join(h, "f");
  assert.equal(backup(file, p), null);
  for (let i = 0; i < 13; i++) {
    writeFileSync(file, `v${i}`);
    backup(file, p, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  }
  const kept = readdirSync(p.backupsDir);
  assert.equal(kept.length, KEEP_BACKUPS);
  assert.ok(kept.every((k) => k.startsWith("f-")));
  writeFileSync(file, "changed");
  restore(file, join(p.backupsDir, kept.sort().at(-1)!));
  assert.equal(readFileSync(file, "utf8"), "v12");
  restore(file, null);
  assert.throws(() => statSync(file));
});

test("gitRepoOf finds a repo above a file that does not exist yet", () => {
  const h = home();
  mkdirSync(join(h, "repo/.git"), { recursive: true });
  mkdirSync(join(h, "repo/ssh"), { recursive: true });
  symlinkSync(join(h, "repo/ssh"), join(h, "linked"));
  assert.equal(gitRepoOf(join(h, "linked/new-file")), join(h, "repo"));
  assert.equal(gitRepoOf(join(h, "elsewhere/x")), null);
});

test("withLock releases the lock and refuses a second holder", () => {
  const h = home();
  const p = paths({ HOME: h });
  const value = withLock(p, () => {
    assert.throws(() => withLock(p, () => 1, 200), /another herdr-machines is writing/);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(withLock(p, () => 7), 7);
});
