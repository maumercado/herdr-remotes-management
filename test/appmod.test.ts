// The app mod runs inside the Herdr app, which isn't available here. These
// tests load it against small stand ins for "gpui-kit", "gpui-base" and
// "herdr" to catch mistakes in its logic and drawing code. `herdr-app check`
// on a real install is still the final word (see TODO.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.ts";

const STUBS = {
  "gpui-kit": `
    const el = () => new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "when") return (cond, fn) => (cond ? fn(el()) : el());
        if (prop === "children") return (items) => { for (const i of items) void i; return el(); };
        if (prop === "then") return undefined;
        return () => el();
      },
      apply() { return el(); },
    });
    export const div = () => el();
    export const svg = () => el();
    export class View {}
    export { el };
  `,
  "gpui-base": `
    import { el } from "gpui-kit";
    export const v_flex = () => el();
    export const h_flex = () => el();
    export const Input = { new: () => el() };
    export const InputState = { new: (o = {}) => {
      let value = o.value ?? "";
      const handlers = {};
      return { on(name, fn) { handlers[name] = fn; }, value: () => value, set: (v) => { value = v; handlers.change?.({}, globalThis.__hm.cx); }, focus() {} };
    } };
  `,
  herdr: `
    const hm = () => globalThis.__hm;
    export const exec = async (cmd, args) => { hm().execCalls.push([cmd, ...args]); return cmd === "herdr" ? hm().herdr(args) : hm().exec(args); };
    export const hc = async () => ({ code: 0, stdout: '{"machines":[]}', stderr: "" });
    export const run = (name, args) => { hm().runs.push([name, args]); return null; };
    export const home = () => "/home/u";
    export const theme = () => new Proxy({}, { get: () => "#000000" });
    export const props = () => ({ overlay: "ov1" });
    export const closeOverlay = (id) => { hm().closed.push(id); return null; };
    export const spaces = () => hm().spaces;
  `,
};

async function loadMod() {
  const dir = mkdtempSync(join(tmpdir(), "hm-mod-"));
  const urls: Record<string, string> = {};
  for (const [name, code] of Object.entries(STUBS)) {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, code.replace(/from "gpui-kit"/g, `from "${pathToFileURL(join(dir, "gpui-kit.mjs")).href}"`));
    urls[name] = pathToFileURL(file).href;
  }
  let main = readFileSync(join(ROOT, "app-mod", "main.js"), "utf8");
  for (const [name, url] of Object.entries(urls)) main = main.replaceAll(`from "${name}"`, `from "${url}"`);
  const file = join(dir, "main.mjs");
  writeFileSync(file, main);
  return import(pathToFileURL(file).href);
}

const LIST = {
  machines: [
    { alias: "box1", raw: false, ssh: { kind: "managed", host: "10.0.0.5", file: "/home/u/.ssh/config.d/herdr-machines", line: 4 }, tui: { id: "p1", label: "box1", session: "default", enabled: true, duplicates: 0 }, app: { name: "box1", state: "connected", via: false, duplicates: 0 }, glyphs: { ssh: "●", tui: "●", app: "●" } },
    { alias: "old", raw: false, ssh: { kind: "yours", host: "o.example", file: "/home/u/.ssh/config", line: 9 }, tui: { id: "p2", label: "old", session: "default", enabled: true, duplicates: 0 }, app: null, glyphs: { ssh: "◇", tui: "●", app: "○" } },
    { alias: "github.com", raw: false, ssh: { kind: "yours", user: "git", file: "/home/u/.ssh/config", line: 1 }, tui: null, app: null, glyphs: { ssh: "◇", tui: "○", app: "○" } },
  ],
  tools: { herdr: { available: true }, hc: { available: true } },
};

function setup(overrides: Record<string, unknown> = {}) {
  const pending: Promise<unknown>[] = [];
  const cx = {
    notify() {},
    spawn(fn: (cx: unknown) => Promise<unknown>) {
      const p = fn(cx);
      pending.push(p);
      return p;
    },
    timer: { after() {}, every() {} },
    focus_handle: () => ({ focus() {} }),
    stop_propagation() {},
  };
  const hm = {
    cx,
    execCalls: [] as string[][],
    runs: [] as [string, unknown][],
    closed: [] as string[],
    spaces: [{ active: true, machine: null }] as { active: boolean; machine: string | null }[],
    plugins: [{ plugin_id: "herdr-machines", plugin_root: "/repo" }] as { plugin_id: string; plugin_root: string }[],
    herdr(args: string[]) {
      if (args.join(" ") !== "plugin list --json") return { code: 1, stdout: "", stderr: "unexpected" };
      return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins: this.plugins } }), stderr: "" };
    },
    exec: (args: string[]) => (args[0] === "list" ? { code: 0, stdout: JSON.stringify(LIST), stderr: "" } : { code: 0, stdout: "ssh ✓  tui ✓  app ✓\n", stderr: "" }),
    ...overrides,
  };
  (globalThis as any).__hm = hm;
  return { hm, cx, settle: async () => { while (pending.length) await pending.shift(); } };
}

test("loads machines and adopt candidates, and draws every mode", async () => {
  const mod = await loadMod();
  const { hm, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  assert.deepEqual(view.machines.map((m: any) => m.alias), ["box1", "old"]);
  assert.deepEqual(view.candidates.map((m: any) => m.alias), ["github.com"]);
  assert.ok(hm.execCalls.some((c) => c.includes("--health")), "health loads after the first list");
  view.render();
  view.openForm("add", null, cx);
  view.render();
  view.mode = "list";
  view.openForm("edit", view.machines[0], cx);
  view.render();
  view.mode = "rename";
  view.render();
  view.mode = "adopt";
  view.render();
  view.remove(view.machines[0], cx);
  view.render();
});

test("finds the CLI through herdr's plugin list, and says how to install when it's missing", async () => {
  const mod = await loadMod();
  assert.equal(mod.cliFromPluginList(JSON.stringify({ result: { plugins: [{ plugin_id: "other", plugin_root: "/x" }, { plugin_id: "herdr-machines", plugin_root: "/p/1" }] } })), "/p/1/bin/herdr-machines");
  assert.equal(mod.cliFromPluginList("not json"), null);
  const { cx, settle } = setup({ plugins: [] });
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  assert.match(view.error, /herdr plugin install maumercado\/herdr-remotes-management/);
  view.render();
});

test("add and edit forms turn into CLI arguments that run in a local terminal", async () => {
  const mod = await loadMod();
  assert.equal(mod.formArgs({ kind: "add", fields: [{ id: "alias", value: "" }, { id: "host", value: "h" }] }), "Alias is required");
  assert.deepEqual(mod.formArgs({ kind: "add", fields: [{ id: "alias", value: "box2" }, { id: "host", value: "10.0.0.6" }, { id: "port", value: " 2222 " }] }), ["add", "box2", "--host", "10.0.0.6", "--port", "2222"]);
  assert.deepEqual(mod.formArgs({ kind: "edit", alias: "box1", original: { host: "a", user: "root" }, fields: [{ id: "host", value: "a" }, { id: "user", value: "" }] }), ["edit", "box1", "--user", ""]);
  assert.equal(mod.formArgs({ kind: "edit", alias: "box1", original: { host: "a" }, fields: [{ id: "host", value: "a" }] }), "Nothing changed");

  const { hm, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  view.openForm("add", null, cx);
  view.form.fields[0].state.set("box2");
  view.form.fields[1].state.set("10.0.0.6");
  view.submitForm(cx);
  const [name, args] = hm.runs.at(-1) as [string, any];
  assert.equal(name, "terminal.open");
  assert.deepEqual(args.argv.slice(3), ["/repo/bin/herdr-machines", "add", "box2", "--host", "10.0.0.6"]);
  assert.deepEqual(hm.closed, ["ov1"]);

  hm.spaces = [{ active: true, machine: "vps" }];
  view.inTerminal(["doctor"]);
  const [remoteName, remoteArgs] = hm.runs.at(-1) as [string, any];
  assert.equal(remoteName, "space.new", "a remote space would run the tab there");
  assert.equal(remoteArgs.machine, "");
});

test("edit is open for app-added raw machines and for machines without an entry, closed for your own entries", async () => {
  const mod = await loadMod();
  assert.equal(mod.editBlocker({ raw: true, ssh: null, app: { name: "100.73.191.22" } }), null);
  assert.equal(mod.editBlocker({ raw: false, ssh: null, app: { name: "nas" } }), null);
  assert.match(mod.editBlocker({ ssh: { kind: "yours", file: "/home/u/.ssh/config" } }), /your own entry/);
  assert.match(mod.editBlocker({ raw: true, ssh: null, app: { via: true } }), /command/);
  const fields = (vals: Record<string, string>) => Object.entries(vals).map(([id, value]) => ({ id, value }));
  assert.equal(mod.formArgs({ kind: "edit", alias: "maumercado@100.73.191.22", original: {}, fields: fields({ alias: "", host: "100.80.0.5" }) }), "Give it a name");
  assert.deepEqual(
    mod.formArgs({ kind: "edit", alias: "maumercado@100.73.191.22", original: {}, fields: fields({ alias: "servicio-new", host: "100.80.0.5", user: "maumercado" }) }),
    ["edit", "maumercado@100.73.191.22", "--alias", "servicio-new", "--host", "100.80.0.5", "--user", "maumercado"],
  );

  const { hm, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  view.openForm("edit", { alias: "maumercado@100.73.191.22", raw: true, ssh: null, app: { name: "100.73.191.22", host: "box1" } }, cx);
  assert.equal(view.form.fields[0].id, "alias");
  assert.equal(view.form.fields[0].value, "box1-2", "the remote's own name, made free: box1 is already a machine");
  assert.equal(view.form.fields.find((f: any) => f.id === "host").value, "100.73.191.22");
  assert.equal(view.form.fields.find((f: any) => f.id === "user").value, "maumercado");
  view.render();
  view.form.fields[0].state.set("servicio-new");
  view.form.fields[1].state.set("100.80.0.5");
  view.submitForm(cx);
  const [, args] = hm.runs.at(-1) as [string, any];
  assert.deepEqual(args.argv.slice(4), ["edit", "maumercado@100.73.191.22", "--alias", "servicio-new", "--host", "100.80.0.5", "--user", "maumercado"]);
});

test("delete asks about the SSH entry and runs quietly with flags; exit 3 falls back to a terminal", async () => {
  const mod = await loadMod();
  const { hm, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  view.remove(view.machines[0], cx);
  view.confirm.yes();
  assert.match(view.confirm.title, /SSH entry/);
  view.confirm.no();
  await settle();
  assert.deepEqual(hm.execCalls.find((c) => c[1] === "delete"), ["/repo/bin/herdr-machines", "delete", "box1", "--yes", "--ssh=keep"]);
  assert.match(view.message, /ssh ✓/);

  hm.exec = (args: string[]) => (args[0] === "list" ? { code: 0, stdout: JSON.stringify(LIST), stderr: "" } : { code: 3, stdout: "", stderr: "needs an answer" });
  view.quick(["rename", "box1", "--hc-name", "b1", "--yes"], cx);
  await settle();
  const [name, args] = hm.runs.at(-1) as [string, any];
  assert.equal(name, "terminal.open");
  assert.deepEqual(args.argv.slice(4), ["rename", "box1", "--hc-name", "b1", "--yes"]);
});

test("glyph helper maps hc states and opens the dialog by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-glyph-"));
  writeFileSync(join(dir, "herdr.mjs"), STUBS.herdr);
  const code = readFileSync(join(ROOT, "app-mod", "glyphs.js"), "utf8").replace('from "herdr"', `from "${pathToFileURL(join(dir, "herdr.mjs")).href}"`);
  writeFileSync(join(dir, "glyphs.mjs"), code);
  const g = await import(pathToFileURL(join(dir, "glyphs.mjs")).href);
  const { hm } = setup();
  assert.equal(g.machineGlyph("needs_login").glyph, "!");
  assert.equal(g.machineGlyph(undefined).glyph, "○");
  g.openMachines();
  assert.deepEqual(hm.runs.at(-1), ["mod.open", { name: "herdr-machines" }]);
});

test("mod.json opens as a dialog and stays out of layouts", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "app-mod", "mod.json"), "utf8"));
  assert.equal(manifest.place, "none");
  assert.equal(manifest.overlay.kind, "dialog");
});
