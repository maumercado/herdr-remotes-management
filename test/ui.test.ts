import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKeys } from "../src/ui/keys.ts";
import type { Key } from "../src/ui/keys.ts";
import { fit, render, WIDE_MIN } from "../src/ui/render.ts";
import type { Effect, UiState } from "../src/ui/state.ts";
import { initialState, reduce, visible, withData } from "../src/ui/state.ts";
import type { RowView } from "../src/view.ts";
import { ROOT } from "./helpers.ts";

function row(alias: string, extra: Partial<RowView> = {}): RowView {
  return {
    alias,
    raw: false,
    ssh: { kind: "managed", host: `${alias}.example`, file: "/home/u/.ssh/config.d/herdr-machines", line: 3 },
    tui: { id: `p-${alias}`, label: alias, session: "default", enabled: true, duplicates: 0 },
    app: { name: alias, session: null, state: "connected", version: "0.3.1", why: null, via: false, duplicates: 0 },
    glyphs: { ssh: "●", tui: "●", app: "●" },
    ...extra,
  };
}

const own = (alias: string) => row(alias, { ssh: { kind: "yours", host: "h", file: "/home/u/.ssh/config", line: 9 }, tui: null, app: null, glyphs: { ssh: "◇", tui: "○", app: "○" } });

function press(s: UiState, ...input: (string | Key)[]): { s: UiState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const item of input) {
    const keys = typeof item === "string" ? parseKeys(item) : [item];
    for (const key of keys) {
      const out = reduce(s, key);
      s = out.s;
      if (out.effect) effects.push(out.effect);
    }
  }
  return { s, effects };
}

const start = () => withData(initialState(), [row("alpha"), row("beta"), row("gamma")], [own("github.com")]);

test("parseKeys reads arrows, enter, escape, ctrl keys and text", () => {
  assert.deepEqual(parseKeys("\x1b[Aa\r\x1b\x03\x7f\t\x1b[Z"), [
    { name: "up" },
    { name: "char", char: "a" },
    { name: "enter" },
    { name: "escape" },
    { name: "ctrl", char: "c" },
    { name: "backspace" },
    { name: "tab" },
    { name: "backtab" },
  ]);
  assert.deepEqual(parseKeys("\x1b[200~x"), [{ name: "char", char: "x" }], "unknown CSI sequences are skipped");
});

test("moving, filtering and quitting", () => {
  let { s, effects } = press(start(), "j", "j", "j");
  assert.equal(s.selected, 2, "stops at the last row");
  ({ s } = press(s, "/", "be", { name: "enter" }));
  assert.deepEqual(visible(s).map((r) => r.alias), ["beta"]);
  assert.equal(s.selected, 0);
  ({ s, effects } = press(s, { name: "escape" }));
  assert.equal(s.filter, "", "escape clears the filter first");
  assert.equal(effects.length, 0);
  ({ effects } = press(s, "q"));
  assert.deepEqual(effects, [{ kind: "quit" }]);
});

test("add form: required fields, last time shortcut, and the command it runs", () => {
  let s: UiState = { ...start(), last: { user: "deploy", port: "2222" } };
  ({ s } = press(s, "a", { name: "ctrl", char: "s" }));
  assert.equal(s.mode, "form");
  assert.match(s.form!.error!, /Alias is required/);
  let effects: Effect[];
  ({ s } = press(s, { name: "ctrl", char: "u" }, "box1", { name: "tab" }, "10.0.0.5", { name: "ctrl", char: "l" }));
  assert.equal(s.form!.fields.find((f) => f.id === "user")!.value, "deploy");
  ({ s, effects } = press(s, { name: "ctrl", char: "s" }));
  assert.equal(s.mode, "list");
  assert.deepEqual(effects, [{ kind: "run", args: ["add", "box1", "--host", "10.0.0.5", "--user", "deploy", "--port", "2222"] }]);
});

test("add form rejects names hc would refuse", () => {
  const { s } = press(start(), "a", "Box", { name: "tab" }, "h", { name: "ctrl", char: "s" });
  assert.equal(s.mode, "form");
  assert.ok(s.form!.error);
});

test("edit sends only changed fields, and an emptied field clears it", () => {
  const base = withData(initialState(), [row("alpha", { ssh: { kind: "managed", host: "a.example", user: "root", file: "/f", line: 1 } })], []);
  let { s, effects } = press(base, "e");
  assert.equal(s.mode, "form");
  // focus host, move to user, clear it, then save
  ({ s, effects } = press(s, { name: "tab" }, { name: "ctrl", char: "u" }, { name: "ctrl", char: "s" }));
  assert.deepEqual(effects, [{ kind: "run", args: ["edit", "alpha", "--user", ""] }]);
  ({ s, effects } = press(base, "e", { name: "ctrl", char: "s" }));
  assert.equal(s.form!.error, "Nothing changed");
  assert.equal(effects.length, 0);
});

test("edit refuses your own entries", () => {
  const base = withData(initialState(), [row("mine", { ssh: { kind: "yours", host: "h", file: "/home/u/.ssh/config", line: 4 } })], []);
  const { s } = press(base, "e");
  assert.equal(s.mode, "list");
  assert.match(s.message!, /edit it by hand/);
});

test("edit opens for a machine without an SSH entry, and explains raw addresses", () => {
  const bare = withData(initialState(), [row("nas", { ssh: null, glyphs: { ssh: "○", tui: "●", app: "●" } })], []);
  let { s, effects } = press(bare, "e");
  assert.equal(s.mode, "form");
  assert.match(s.form!.title, /Create the SSH entry/);
  ({ s, effects } = press(s, "192.0.2.5", { name: "ctrl", char: "s" }));
  assert.deepEqual(effects, [{ kind: "run", args: ["edit", "nas", "--host", "192.0.2.5"] }]);

  const raw = withData(initialState(), [row("root@192.0.2.7", { raw: true, ssh: null })], []);
  ({ s } = press(raw, "e"));
  assert.equal(s.mode, "list");
  assert.match(s.message!, /raw address/);
});

test("delete asks twice for a managed machine and passes the answers as flags", () => {
  let { s, effects } = press(start(), "d");
  assert.equal(s.mode, "confirm");
  ({ s, effects } = press(s, "y"));
  assert.equal(s.mode, "confirm", "second question: the SSH entry");
  ({ s, effects } = press(s, "n"));
  assert.deepEqual(effects, [{ kind: "run", args: ["delete", "alpha", "--yes", "--ssh=keep"] }]);
  ({ effects } = press(start(), "d", "y", "y"));
  assert.deepEqual(effects, [{ kind: "run", args: ["delete", "alpha", "--yes", "--ssh=delete"] }]);
  ({ s, effects } = press(start(), "d", "n"));
  assert.equal(effects.length, 0);
  assert.equal(s.mode, "list");
});

test("rename picks what to rename, and alias rename asks first", () => {
  let { s, effects } = press(start(), "r");
  assert.equal(s.mode, "picker");
  assert.deepEqual(s.picker!.items.map((i) => i.id), ["label", "hc-name", "alias"]);
  ({ s, effects } = press(s, { name: "enter" }, { name: "ctrl", char: "u" }, "Build box", { name: "enter" }));
  assert.deepEqual(effects, [{ kind: "run", args: ["rename", "alpha", "--label", "Build box"] }]);
  ({ s, effects } = press(start(), "r", "j", "j", { name: "enter" }, { name: "ctrl", char: "u" }, "alpha2", { name: "enter" }));
  assert.equal(s.mode, "confirm");
  ({ effects } = press(s, "y"));
  assert.deepEqual(effects, [{ kind: "run", args: ["rename", "alpha", "--alias", "alpha2", "--yes"] }]);
});

test("adopt picks from your own hosts, login and doctor run the CLI", () => {
  let { s, effects } = press(start(), "A");
  assert.equal(s.mode, "picker");
  ({ effects } = press(s, { name: "enter" }));
  assert.deepEqual(effects, [{ kind: "run", args: ["adopt", "github.com"] }]);
  ({ effects } = press(start(), "l"));
  assert.deepEqual(effects, [{ kind: "run", args: ["login", "alpha"] }]);
  ({ effects } = press(start(), "s"));
  assert.deepEqual(effects, [{ kind: "run", args: ["doctor"] }]);
});

test("reload keeps the selection on the same machine", () => {
  let { s } = press(start(), "j");
  s = withData(s, [row("aaa"), row("alpha"), row("beta"), row("gamma")], []);
  assert.equal(visible(s)[s.selected]!.alias, "beta");
});

test("render fits every line to the width, wide and narrow", () => {
  const strip = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  for (const cols of [WIDE_MIN + 20, 50]) {
    const s = { ...start(), wide: cols >= WIDE_MIN };
    for (const style of [{ color: false }, { color: true }]) {
      const lines = render(s, cols, 20, style);
      assert.equal(lines.length, 20);
      for (const l of lines) assert.ok([...strip(l)].length <= cols, `too wide at ${cols}: ${strip(l)}`);
    }
  }
  const narrow = render({ ...start(), wide: false }, 50, 12, { color: false }).join("\n");
  assert.match(narrow, /ALIAS/);
  assert.doesNotMatch(narrow, /SSH  managed/, "narrow shows the list only");
  const details = render({ ...press({ ...start(), wide: false }, { name: "enter" }).s }, 50, 20, { color: false }).join("\n");
  assert.match(details, /SSH  managed/);
  assert.equal(fit("abcdef", 4), "abc…");
});

test("plugin manifest uses a valid id and opens the popup through the CLI", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  assert.match(manifest, /^id = "herdr-machines"$/m);
  assert.match(manifest, /placement = "popup"/);
  assert.match(manifest, /command = \["sh", "bin\/run", "ui"\]/);
  assert.match(manifest, /--entrypoint manager/);
  assert.match(manifest, /^platforms = \["linux", "macos"\]$/m);
});
