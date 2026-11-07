import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

const dest = (home: string) => join(home, ".config/herdr-app/mods/herdr-machines");

/** A copy of the plugin in a temp folder, like herdr's managed install folders. */
function pluginCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-plugin-"));
  for (const f of ["herdr-plugin.toml", "app-mod", "bin"]) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  return dir;
}

function install(home: string, root = ROOT, env: Record<string, string> = {}) {
  return spawnSync("sh", [join(root, "bin", "install-app-mod")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, ...env } });
}

function appHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hm-install-"));
  mkdirSync(join(home, ".config/herdr-app"), { recursive: true });
  return home;
}

test("links the app mod to the plugin, and follows the plugin to a new folder", () => {
  const empty = mkdtempSync(join(tmpdir(), "hm-install-"));
  let r = install(empty);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no .*herdr-app yet/);
  assert.equal(existsSync(dest(empty)), false);

  const home = appHome();
  r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(dest(home)).isSymbolicLink());
  assert.equal(readlinkSync(dest(home)), join(ROOT, "app-mod"));
  assert.ok(existsSync(join(dest(home), "main.js")));

  r = install(home);
  assert.equal(r.stdout, "", "nothing to do when the link is already right");

  const updated = pluginCopy();
  r = install(home, updated);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(dest(home)), join(updated, "app-mod"), "an update points the link at the new folder");

  assert.equal(install(appHome(), ROOT, { HERDR_MACHINES_SKIP_APP_MOD: "1" }).status, 0);
});

test("replaces an older copy it made, and leaves anything else alone", () => {
  const home = appHome();
  mkdirSync(dest(home), { recursive: true });
  writeFileSync(join(dest(home), "main.js"), "old copy");
  writeFileSync(join(dest(home), ".installed-by-herdr-plugin"), "");
  let r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(dest(home)).isSymbolicLink());

  const mine = appHome();
  mkdirSync(dest(mine), { recursive: true });
  writeFileSync(join(dest(mine), "main.js"), "mine");
  r = install(mine);
  assert.match(r.stdout, /leaving it alone/);
  assert.equal(readFileSync(join(dest(mine), "main.js"), "utf8"), "mine");

  const elsewhere = appHome();
  const other = mkdtempSync(join(tmpdir(), "hm-other-"));
  mkdirSync(join(other, "app-mod"));
  mkdirSync(join(elsewhere, ".config/herdr-app/mods"), { recursive: true });
  symlinkSync(join(other, "app-mod"), dest(elsewhere));
  r = install(elsewhere);
  assert.match(r.stdout, /leaving it alone/);
  assert.equal(readlinkSync(dest(elsewhere)), join(other, "app-mod"));
});

test("the manifest checks requirements, links the app mod on install and at each start", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  const builds = [...manifest.matchAll(/\[\[build\]\]\ncommand = (.*)/g)].map((m) => m[1]);
  assert.deepEqual(builds, ['["sh", "bin/run", "check"]', '["sh", "bin/install-app-mod"]']);
  assert.match(manifest, /\[\[startup\]\]\ncommand = \["sh", "bin\/install-app-mod"\]/);
});

test("bin/run starts the CLI with node from PATH", () => {
  const r = spawnSync("sh", [join(ROOT, "bin", "run"), "help"], { encoding: "utf8", env: { PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`, HOME: tmpdir() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});
