// Machines: add, edit, rename and delete SSH machines once, for ~/.ssh/config,
// the herdr TUI and this app. A front end for the herdr-machines CLI.
//
// Opened as a dialog: `mod.open herdr-machines` (a key, the palette, or a
// button in another mod, see glyphs.js). Reads `herdr-machines list --json`.
// Changes that can ask you something (a host key, a password, a session
// picker, installing on the remote) run in a terminal on this computer;
// the others run quietly and the list refreshes.
//
// The CLI comes from the herdr plugin: `herdr plugin list --json` says where
// it is installed (or linked).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, home, theme, props, closeOverlay, spaces } from "herdr";

const PLUGIN_ID = "herdr-machines";
const INSTALL = "herdr plugin install maumercado/herdr-remotes-management";

const FIELDS = [
  ["host", "Host"],
  ["user", "User"],
  ["port", "Port"],
  ["key", "Key file"],
  ["jump", "Jump host"],
];

// Shows the command's own output and waits, so the report stays readable.
const WRAP = '"$0" "$@"; code=$?; printf "\\nPress Enter to close. "; read _; exit $code';

const GLYPH_COLOR = { "●": "done", "◇": "accent", "○": "dim", "◐": "working", "!": "blocked", "↑": "blocked", "✕": "ansi1", "◌": "dim" };

/** bin/herdr-machines inside the installed (or linked) plugin, from `herdr plugin list --json`. */
export function cliFromPluginList(stdout) {
  try {
    const data = JSON.parse(stdout);
    const plugins = data?.result?.plugins ?? data?.plugins ?? [];
    const plugin = plugins.find((p) => p.plugin_id === PLUGIN_ID);
    return plugin?.plugin_root ? `${plugin.plugin_root}/bin/herdr-machines` : null;
  } catch {
    return null;
  }
}

export function isMachine(m) {
  return Boolean(m.tui || m.app || m.ssh?.kind === "managed");
}

export function isCandidate(m) {
  return m.ssh?.kind === "yours" && !m.tui && !m.app && !m.raw;
}

/** The CLI arguments for a submitted add or edit form, or an error string. */
export function formArgs(form) {
  const v = (id) => (form.fields.find((f) => f.id === id)?.value ?? "").trim();
  if (form.kind === "add") {
    if (!v("alias")) return "Alias is required";
    if (!v("host")) return "Host is required";
    const args = ["add", v("alias")];
    for (const [id] of FIELDS) if (v(id)) args.push(`--${id}`, v(id));
    return args;
  }
  if (!v("host")) return "Host can't be empty";
  const args = ["edit", form.alias];
  if (form.fields.some((f) => f.id === "alias")) {
    if (!v("alias")) return "Give it a name";
    args.push("--alias", v("alias"));
  }
  const fixed = args.length;
  for (const [id] of FIELDS) if (v(id) !== (form.original[id] ?? "")) args.push(`--${id}`, v(id));
  return args.length === fixed ? "Nothing changed" : args;
}

/** Why a machine can't be edited here, or null when it can. */
export function editBlocker(m) {
  if (m.app?.via) return "reached through a command, change it with hc";
  if (m.ssh?.kind === "yours") return `your own entry in ${m.ssh.file}: edit that file`;
  return null;
}

export default class Machines extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.cli = null;
    this.error = null;
    this.machines = null;
    this.candidates = [];
    this.tools = null;
    this.selected = 0;
    this.mode = "list"; // list | form | confirm | adopt | rename
    this.form = null;
    this.confirm = null;
    this.busy = false;
    this.healthLoaded = false;
    this.message = "";
    cx.spawn(async (cx) => {
      await this.load(false);
      cx.notify();
      await this.load(true);
      cx.notify();
    });
  }

  // -------------------------------------------------------------------------
  // Data

  async findCli() {
    const r = await exec("herdr", ["plugin", "list", "--json"], { timeout: 15000 }).catch(() => null);
    if (!r || r.code !== 0) return null;
    return cliFromPluginList(r.stdout);
  }

  async load(health) {
    this.cli ??= await this.findCli();
    if (!this.cli) {
      this.error = `The herdr plugin isn't installed. Run this in a terminal, then reopen: ${INSTALL}`;
      return;
    }
    const r = await exec(this.cli, ["list", "--all", "--json", ...(health ? ["--health"] : [])], { timeout: 60000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    let data = null;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      data = null;
    }
    if (!data?.machines) {
      this.error = data?.error ?? (r.stderr.trim() || "herdr-machines list failed");
      return;
    }
    const keep = this.current()?.alias;
    this.machines = data.machines.filter(isMachine);
    this.candidates = data.machines.filter(isCandidate);
    this.tools = data.tools;
    this.error = null;
    this.healthLoaded = health;
    const index = keep ? this.machines.findIndex((m) => m.alias === keep) : -1;
    if (index >= 0) this.selected = index;
    this.selected = Math.max(0, Math.min(this.selected, this.machines.length - 1));
  }

  current() {
    return this.machines?.[this.selected];
  }

  // -------------------------------------------------------------------------
  // Running the CLI

  /** Runs a command that may ask questions in a terminal on this computer, and closes the dialog. */
  inTerminal(args) {
    const argv = ["sh", "-c", WRAP, this.cli, ...args];
    const space = spaces().find((s) => s.active);
    // A tab in a space on another machine would run there; the CLI belongs here.
    if (!space || space.machine == null) run("terminal.open", { argv, name: "Machines" });
    else run("space.new", { name: "Machines", argv, machine: "" });
    closeOverlay(props().overlay);
  }

  /** Runs a command that asks nothing. Exit 3 means it needs a terminal after all. */
  quick(args, cx) {
    this.busy = true;
    this.mode = "list";
    this.message = `herdr-machines ${args.join(" ")}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(this.cli, args, { timeout: 120000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.busy = false;
      if (r.code === 3) {
        this.inTerminal(args);
        return;
      }
      const lines = (r.stdout + "\n" + r.stderr).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("…"));
      this.message = (r.code === 0 ? "" : `exit ${r.code}: `) + (lines.pop() ?? "done");
      await this.load(this.healthLoaded);
      cx.notify();
    });
  }

  // -------------------------------------------------------------------------
  // Modes

  openForm(kind, row, cx) {
    const fields = [];
    const original = {};
    const add = (id, label, value) => {
      const state = InputState.new({ value, placeholder: id === "port" ? "22" : "" });
      const field = { id, label, value, state };
      state.on("change", (_e, cx) => {
        field.value = state.value();
        this.form.error = "";
        cx.notify();
      });
      state.on("submit", (_e, cx) => this.submitForm(cx));
      fields.push(field);
    };
    // A machine added with a raw address (user@ip, like the app's own Add
    // machine makes) gets a name and an SSH entry; it moves onto that name.
    const raw = kind === "edit" && row.raw;
    const parsed = raw ? /^(?:ssh:\/\/)?(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(row.alias) : null;
    if (kind === "add" || raw) add("alias", raw ? "Name" : "Alias", "");
    for (const [id, label] of FIELDS) {
      const value = raw ? ({ user: parsed?.[1], port: parsed?.[3] }[id] ?? "") : kind === "edit" ? (row.ssh?.[id] ?? "") : "";
      original[id] = raw ? "" : value;
      add(id, label, value);
    }
    this.form = { kind, raw, alias: row?.alias, fields, original, error: "" };
    this.mode = "form";
    fields[0].state.focus();
    cx.timer.after(300, () => fields[0]?.state.focus());
    cx.notify();
  }

  submitForm(cx) {
    const out = formArgs(this.form);
    if (typeof out === "string") {
      this.form.error = out;
      cx.notify();
      return;
    }
    this.inTerminal(out);
  }

  openRename(row, kind, cx) {
    const value = kind === "label" ? row.tui.label : kind === "hc-name" ? row.app.name : row.alias;
    const state = InputState.new({ value });
    const form = { kind: "rename", renameKind: kind, alias: row.alias, fields: [{ id: "value", label: kind === "label" ? "herdr label" : kind === "hc-name" ? "App name" : "SSH alias", value, state }], error: "" };
    state.on("change", (_e, cx) => {
      form.fields[0].value = state.value();
      form.error = "";
      cx.notify();
    });
    state.on("submit", (_e, cx) => this.submitRename(cx));
    this.form = form;
    this.mode = "form";
    state.focus();
    cx.timer.after(300, () => state.focus());
    cx.notify();
  }

  submitRename(cx) {
    const { alias, renameKind } = this.form;
    const next = this.form.fields[0].value.trim();
    if (!next) {
      this.form.error = "A name is required";
      cx.notify();
      return;
    }
    if (renameKind === "label") return this.quick(["rename", alias, "--label", next], cx);
    if (renameKind === "hc-name") {
      return this.ask(`Rename the app machine to ${next}?`, "App addresses that use the old name (like old/t7) stop working.", () => this.quick(["rename", alias, "--hc-name", next, "--yes"], cx), null, cx);
    }
    this.ask(`Change the alias ${alias} to ${next}?`, "herdr and the app remove and add the machine again with the same session. Setup prompts may appear in a terminal.", () => this.inTerminal(["rename", alias, "--alias", next, "--yes"]), null, cx);
  }

  ask(title, detail, yes, no, cx) {
    this.confirm = { title, detail, yes, no };
    this.mode = "confirm";
    this.handle.focus();
    cx.notify();
  }

  remove(row, cx) {
    const managed = row.ssh?.kind === "managed";
    this.ask(
      `Remove ${row.alias} from herdr and the app?`,
      "Sessions and terminals on the remote keep running.",
      () => {
        if (!managed) return this.quick(["delete", row.alias, "--yes"], cx);
        this.ask(
          `Also delete the SSH entry for ${row.alias}?`,
          "Yes deletes it from the managed file. No keeps it in ~/.ssh.",
          () => this.quick(["delete", row.alias, "--yes", "--ssh=delete"], cx),
          () => this.quick(["delete", row.alias, "--yes", "--ssh=keep"], cx),
          cx,
        );
      },
      null,
      cx,
    );
  }

  back(cx) {
    this.mode = "list";
    this.form = null;
    this.confirm = null;
    this.handle.focus();
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.mode === "list") closeOverlay(props().overlay);
      else this.back(cx);
      cx.stop_propagation();
      return;
    }
    if (this.mode === "confirm" && (e.key === "enter" || e.key === "y")) {
      this.confirm.yes();
      cx.stop_propagation();
      return;
    }
    if (this.mode === "confirm" && e.key === "n") {
      if (this.confirm.no) this.confirm.no();
      else this.back(cx);
      cx.stop_propagation();
      return;
    }
    if (this.mode !== "list" || !this.machines?.length) return;
    if (e.key === "up") this.selected = Math.max(0, this.selected - 1);
    else if (e.key === "down") this.selected = Math.min(this.machines.length - 1, this.selected + 1);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Drawing

  button(t, id, label, onClick, primary = false, disabled = false) {
    return div()
      .id(id)
      .h(28)
      .px(12)
      .flex()
      .flex_none()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12)
      .font_medium()
      .when(disabled || this.busy, (el) => el.opacity(0.4))
      .when(!disabled && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  glyph(t, g) {
    return div().w(28).flex_none().text_center().text_color(t[GLYPH_COLOR[g] ?? "foreground"] ?? t.foreground).child(g);
  }

  listPane(t) {
    const rows = this.machines ?? [];
    return v_flex()
      .w(300)
      .flex_none()
      .min_h(0)
      .child(
        h_flex()
          .px(10)
          .pb(4)
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().child("ALIAS"))
          .child(div().w(28).text_center().child("SSH"))
          .child(div().w(28).text_center().child("TUI"))
          .child(div().w(28).text_center().child("APP")),
      )
      .child(
        v_flex()
          .id("hm-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .children(
            this.machines === null
              ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("Reading machines…")]
              : rows.length === 0
                ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("No machines yet. Add one, or adopt a host from your SSH config.")]
                : rows.map((m, i) =>
                    h_flex()
                      .id(`hm-row-${m.alias}`)
                      .h(32)
                      .px(10)
                      .items_center()
                      .rounded(7)
                      .cursor_pointer()
                      .when(i === this.selected, (el) => el.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        this.selected = i;
                        cx.notify();
                      })
                      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(m.alias))
                      .child(this.glyph(t, m.glyphs.ssh))
                      .child(this.glyph(t, m.glyphs.tui))
                      .child(this.glyph(t, m.glyphs.app)),
                  ),
          ),
      );
  }

  detailPane(t) {
    const m = this.current();
    if (!m) return div().flex_1();
    const line = (k, v) =>
      v === undefined || v === null || v === ""
        ? null
        : h_flex().gap(8).text_size(12.5).child(div().w(64).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(String(v)));
    const section = (title, rows) => v_flex().gap(3).child(div().text_size(11.5).font_medium().text_color(t.muted).child(title)).children(rows.filter(Boolean));
    const shortPath = (f) => (f.startsWith(home() + "/") ? "~" + f.slice(home().length) : f);
    const ssh = m.ssh
      ? section(m.ssh.kind === "managed" ? "SSH · managed" : "SSH · your own entry", [line("host", m.ssh.host), line("user", m.ssh.user), line("port", m.ssh.port), line("key", m.ssh.key), line("jump", m.ssh.jump), line("file", `${shortPath(m.ssh.file)}:${m.ssh.line}`)])
      : section("SSH", [div().text_size(12.5).text_color(t.dim).child(m.raw ? "raw target, not an alias" : "no Host entry")]);
    const tui = m.tui
      ? section(`herdr TUI${m.tui.enabled ? "" : " · disabled"}`, [line("label", m.tui.label), line("session", m.tui.session), line("health", m.tui.health ?? (this.healthLoaded ? null : "checking…")), line("error", m.tui.error)])
      : section("herdr TUI", [div().text_size(12.5).text_color(t.dim).child(this.tools?.herdr?.available === false ? this.tools.herdr.reason : "not in herdr")]);
    const app = m.app
      ? section("App", [line("name", m.app.name), line("session", m.app.session), line("state", m.app.state), line("hc", m.app.version), line("why", m.app.why)])
      : section("App", [div().text_size(12.5).text_color(t.dim).child(this.tools?.hc?.available === false ? this.tools.hc.reason : "not in the app")]);
    const managed = m.ssh?.kind === "managed";
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .pl(16)
      .gap(12)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(m.alias))
      .child(v_flex().id("hm-detail").flex_1().min_h(0).overflow_y_scroll().gap(12).child(ssh).child(tui).child(app))
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .child(this.button(t, "hm-edit", "Edit", (cx) => this.openForm("edit", m, cx), false, Boolean(editBlocker(m))))
          .child(this.button(t, "hm-rename", "Rename", (cx) => {
            this.mode = "rename";
            cx.notify();
          }))
          .child(this.button(t, "hm-login", "Log in", () => this.inTerminal(["login", m.alias]), false, !m.tui && !m.app))
          .child(this.button(t, "hm-delete", "Delete", (cx) => this.remove(m, cx), false, !m.tui && !m.app && !managed)),
      );
  }

  formPane(t) {
    const f = this.form;
    const title = f.kind === "add" ? "Add a machine" : f.raw ? `Give ${f.alias} a name and a new address` : f.kind === "edit" ? `Edit ${f.alias}` : `Rename ${f.alias}`;
    const hint = f.kind === "add"
      ? "Only alias and host are needed. Blank fields use SSH's own defaults."
      : f.raw
        ? "It was added with a raw address. It gets an SSH entry under this name, and moves there in the app (same name, same spaces) once the new address answers. After that you can edit it while it's offline."
        : f.kind === "edit"
          ? "Works while the machine is offline. Empty a field to remove that option."
          : "";
    return v_flex()
      .flex_1()
      .gap(8)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(hint), (el) => el.child(div().text_size(12).text_color(t.muted).child(hint)))
      .children(
        f.fields.map((field) =>
          h_flex()
            .gap(10)
            .items_center()
            .child(div().w(90).flex_none().text_size(12.5).text_color(t.muted).child(field.label))
            .child(Input.new(field.state).flex_1().h(30).px(8).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground)),
        ),
      )
      .when(Boolean(f.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(f.error)))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(this.button(t, "hm-form-cancel", "Cancel", (cx) => this.back(cx)))
          .child(this.button(t, "hm-form-ok", f.kind === "rename" ? "Rename" : f.kind === "add" ? "Add in a terminal" : "Save in a terminal", (cx) => (f.kind === "rename" ? this.submitRename(cx) : this.submitForm(cx)), true)),
      );
  }

  confirmPane(t) {
    const c = this.confirm;
    return v_flex()
      .flex_1()
      .gap(10)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(c.title))
      .child(div().text_size(12.5).text_color(t.muted).child(c.detail))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(this.button(t, "hm-cancel", "Cancel", (cx) => this.back(cx)))
          .when(Boolean(c.no), (el) => el.child(this.button(t, "hm-no", "No", () => c.no())))
          .child(this.button(t, "hm-yes", "Yes", () => c.yes(), true)),
      );
  }

  renamePane(t) {
    const m = this.current();
    const options = [];
    if (m.tui) options.push(["label", `herdr label (now ${m.tui.label})`]);
    if (m.app) options.push(["hc-name", `App name (now ${m.app.name})`]);
    if (m.ssh?.kind === "managed") options.push(["alias", `SSH alias (now ${m.alias})`]);
    return v_flex()
      .flex_1()
      .gap(8)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`Rename what on ${m.alias}?`))
      .children(options.map(([kind, label]) => this.button(t, `hm-rename-${kind}`, label, (cx) => this.openRename(m, kind, cx))))
      .when(options.length === 0, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("Nothing to rename here.")))
      .child(h_flex().justify_end().child(this.button(t, "hm-rename-cancel", "Cancel", (cx) => this.back(cx))));
  }

  adoptPane(t) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Adopt a host from your SSH config"))
      .child(div().text_size(12).text_color(t.muted).child("Registers it with herdr and the app. Its SSH entry stays where it is."))
      .child(
        v_flex()
          .id("hm-candidates")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .children(
            this.candidates.length === 0
              ? [div().py(8).text_size(12.5).text_color(t.dim).child("Every host in your SSH config is already a machine.")]
              : this.candidates.map((c) =>
                  h_flex()
                    .id(`hm-cand-${c.alias}`)
                    .h(34)
                    .px(8)
                    .gap(10)
                    .items_center()
                    .rounded(7)
                    .hover((s) => s.bg(t.hover))
                    .child(div().flex_none().text_size(13).text_color(t.foreground).child(c.alias))
                    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child([c.ssh.user, c.ssh.host].filter(Boolean).join("@")))
                    .child(this.button(t, `hm-adopt-${c.alias}`, "Adopt", () => this.inTerminal(["adopt", c.alias]))),
                ),
          ),
      )
      .child(h_flex().justify_end().child(this.button(t, "hm-adopt-cancel", "Cancel", (cx) => this.back(cx))));
  }

  render() {
    const t = theme();
    const count = this.machines?.length ?? 0;
    let body;
    if (this.error) body = div().flex_1().p(12).rounded(8).bg(t.blocked + "14").text_size(12.8).text_color(t.foreground).child(this.error);
    else if (this.mode === "form" && this.form) body = this.formPane(t);
    else if (this.mode === "confirm" && this.confirm) body = this.confirmPane(t);
    else if (this.mode === "rename" && this.current()) body = this.renamePane(t);
    else if (this.mode === "adopt") body = this.adoptPane(t);
    else body = h_flex().flex_1().min_h(0).items_start().child(this.listPane(t)).child(this.detailPane(t));
    return v_flex()
      .id("herdr-machines")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(15).font_semibold().child("Machines"))
          .child(div().flex_1().text_size(12).text_color(t.dim).child(this.machines ? `${count} machine${count === 1 ? "" : "s"}${this.healthLoaded ? "" : " · checking health…"}` : ""))
          .when(!this.error, (el) =>
            el
              .child(this.button(t, "hm-add", "Add", (cx) => this.openForm("add", null, cx), true))
              .child(this.button(t, "hm-adopt", "Adopt", (cx) => {
                this.mode = "adopt";
                cx.notify();
              }))
              .child(this.button(t, "hm-doctor", "Doctor", () => this.inTerminal(["doctor"])))
              .child(this.button(t, "hm-refresh", "Refresh", (cx) => cx.spawn(async (cx) => {
                await this.load(true);
                cx.notify();
              }))),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(body)
      .child(div().text_size(11.5).text_color(this.message ? t.muted : t.dim).truncate().child(this.message || "● ok  ◇ your own SSH entry  ○ missing  ◐ connecting  ! needs login  ↑ needs update  ✕ unreachable"));
  }
}
