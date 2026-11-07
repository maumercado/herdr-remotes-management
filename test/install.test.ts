import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

const script = join(ROOT, "bin", "install-app-mod");
const dest = (home: string) => join(home, ".config/herdr-app/mods/herdr-machines");

function install(home: string, env: Record<string, string> = {}) {
  return spawnSync("sh", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, ...env } });
}

test("the app mod build step copies the mod, and replaces only its own copy", () => {
  const home = mkdtempSync(join(tmpdir(), "hm-install-"));
  let r = install(home);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no .*herdr-app yet/);
  assert.equal(existsSync(dest(home)), false);

  mkdirSync(join(home, ".config/herdr-app"), { recursive: true });
  r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dest(home), "main.js")));
  assert.ok(existsSync(join(dest(home), ".installed-by-herdr-plugin")));

  writeFileSync(join(dest(home), "stale.js"), "old");
  r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dest(home), "stale.js")), false, "an update replaces the earlier copy");

  assert.equal(install(home, { HERDR_MACHINES_SKIP_APP_MOD: "1" }).status, 0);
});

test("the app mod build step leaves folders it didn't create alone", () => {
  const home = mkdtempSync(join(tmpdir(), "hm-install-"));
  mkdirSync(dest(home), { recursive: true });
  writeFileSync(join(dest(home), "main.js"), "mine");
  let r = install(home);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /leaving it alone/);
  assert.equal(readFileSync(join(dest(home), "main.js"), "utf8"), "mine");

  const linked = mkdtempSync(join(tmpdir(), "hm-install-"));
  mkdirSync(join(linked, ".config/herdr-app/mods"), { recursive: true });
  symlinkSync(join(ROOT, "app-mod"), dest(linked));
  r = install(linked);
  assert.match(r.stdout, /leaving it alone/);
  assert.equal(existsSync(join(ROOT, "app-mod", ".installed-by-herdr-plugin")), false);
});

test("the plugin build runs the requirement check first, then the app mod step", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  const builds = [...manifest.matchAll(/\[\[build\]\]\ncommand = (.*)/g)].map((m) => m[1]);
  assert.deepEqual(builds, ['["sh", "bin/run", "check"]', '["sh", "bin/install-app-mod"]']);
});

test("bin/run starts the CLI with node from PATH", () => {
  const r = spawnSync("sh", [join(ROOT, "bin", "run"), "help"], { encoding: "utf8", env: { PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`, HOME: tmpdir() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});
