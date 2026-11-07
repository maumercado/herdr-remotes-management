import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

test("the plugin's only build step is the requirement check, and it has no hooks", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  const builds = [...manifest.matchAll(/\[\[build\]\]\ncommand = (.*)/g)].map((m) => m[1]);
  assert.deepEqual(builds, ['["sh", "bin/run", "check"]']);
  assert.doesNotMatch(manifest, /\[\[(startup|events)\]\]/);
});

test("bin/run starts the CLI with node from PATH", () => {
  const r = spawnSync("sh", [join(ROOT, "bin", "run"), "help"], { encoding: "utf8", env: { PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`, HOME: tmpdir() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});
