// The popup's state and how each key changes it. No terminal I/O here: the
// reducer returns an effect (run a CLI command, reload, quit) and app.ts does it.

import type { Key } from "./keys.ts";
import type { RowView } from "../view.ts";
import { aliasProblem, hcNameProblem, portProblem } from "../tools.ts";

export type Effect = { kind: "quit" } | { kind: "reload"; health: boolean } | { kind: "run"; args: string[] };

export interface FormField {
  id: string;
  label: string;
  value: string;
  required?: boolean;
}

export interface Form {
  kind: "add" | "edit" | "rename";
  title: string;
  fields: FormField[];
  focus: number;
  /** The machine being edited or renamed. */
  alias?: string;
  original?: Record<string, string>;
  renameKind?: "label" | "hc-name" | "alias";
  error?: string;
}

export type Next = { effect: Effect } | { confirm: Confirm } | { cancel: true };

export interface Confirm {
  title: string;
  lines: string[];
  yes: () => Next;
  /** What "n" does. Escape always cancels. */
  no: () => Next;
}

export interface Picker {
  title: string;
  items: { id: string; label: string }[];
  selected: number;
  pick: (id: string) => Next | { form: Form };
}

export type Mode = "list" | "details" | "filter" | "form" | "confirm" | "picker";

export interface LastUsed {
  user?: string;
  port?: string;
  key?: string;
  jump?: string;
}

export interface UiState {
  machines: RowView[];
  /** Your own SSH hosts not registered anywhere yet: what `A` can adopt. */
  candidates: RowView[];
  selected: number;
  filter: string;
  mode: Mode;
  form?: Form;
  confirm?: Confirm;
  picker?: Picker;
  message?: string;
  healthLoading: boolean;
  last: LastUsed;
  /** Two panes (list and details) side by side. Set by app.ts from the popup width. */
  wide: boolean;
}

export function initialState(): UiState {
  return { machines: [], candidates: [], selected: 0, filter: "", mode: "list", healthLoading: false, last: {}, wide: true };
}

export function visible(s: UiState): RowView[] {
  const f = s.filter.toLowerCase();
  return f ? s.machines.filter((m) => m.alias.toLowerCase().includes(f)) : s.machines;
}

export function current(s: UiState): RowView | undefined {
  return visible(s)[s.selected];
}

function clampSelection(s: UiState): UiState {
  const n = visible(s).length;
  return { ...s, selected: Math.max(0, Math.min(s.selected, n - 1)) };
}

/** New data from a reload, keeping the selection on the same alias when it still exists. */
export function withData(s: UiState, machines: RowView[], candidates: RowView[]): UiState {
  const keep = current(s)?.alias;
  const next = { ...s, machines, candidates };
  const index = keep ? visible(next).findIndex((m) => m.alias === keep) : -1;
  return clampSelection({ ...next, selected: index >= 0 ? index : s.selected });
}

const FIELD_LABELS: [string, string][] = [
  ["host", "Host"],
  ["user", "User"],
  ["port", "Port"],
  ["key", "Key file"],
  ["jump", "Jump host"],
];

export function addForm(): Form {
  return {
    kind: "add",
    title: "Add a machine",
    focus: 0,
    fields: [{ id: "alias", label: "Alias", value: "", required: true }, ...FIELD_LABELS.map(([id, label]) => ({ id, label, value: "", required: id === "host" }))],
  };
}

export function editForm(row: RowView): Form {
  const ssh = row.ssh!;
  const original: Record<string, string> = {};
  const fields = FIELD_LABELS.map(([id, label]) => {
    const value = (ssh[id as keyof typeof ssh] as string | undefined) ?? "";
    original[id] = value;
    return { id, label, value, required: id === "host" };
  });
  return { kind: "edit", title: `Edit ${row.alias}`, focus: 0, alias: row.alias, original, fields };
}

function renameForm(row: RowView, kind: "label" | "hc-name" | "alias"): Form {
  const value = kind === "label" ? row.tui!.label : kind === "hc-name" ? row.app!.name : row.alias;
  const label = kind === "label" ? "herdr label" : kind === "hc-name" ? "App name" : "SSH alias";
  return { kind: "rename", title: `Rename ${row.alias}`, focus: 0, alias: row.alias, renameKind: kind, fields: [{ id: "value", label, value, required: true }] };
}

function value(form: Form, id: string): string {
  return form.fields.find((f) => f.id === id)?.value.trim() ?? "";
}

/** Checks a form and turns it into what to do next, or an error message. */
export function submitForm(form: Form): Next | { error: string } {
  for (const f of form.fields) if (f.required && value(form, f.id) === "") return { error: `${f.label} is required` };
  const port = value(form, "port");
  if (form.kind !== "rename" && port) {
    const bad = portProblem(port);
    if (bad) return { error: bad };
  }
  if (form.kind === "add") {
    const alias = value(form, "alias");
    const bad = aliasProblem(alias);
    if (bad) return { error: bad };
    const args = ["add", alias];
    for (const [id] of FIELD_LABELS) {
      const v = value(form, id);
      if (v) args.push(`--${id}`, v);
    }
    return { effect: { kind: "run", args } };
  }
  if (form.kind === "edit") {
    const args = ["edit", form.alias!];
    for (const [id] of FIELD_LABELS) {
      const v = value(form, id);
      if (v !== (form.original?.[id] ?? "")) args.push(`--${id}`, v);
    }
    if (args.length === 2) return { error: "Nothing changed" };
    return { effect: { kind: "run", args } };
  }
  const next = value(form, "value");
  const alias = form.alias!;
  if (form.renameKind === "label") return { effect: { kind: "run", args: ["rename", alias, "--label", next] } };
  if (form.renameKind === "hc-name") {
    const bad = hcNameProblem(next);
    if (bad) return { error: bad };
    return {
      confirm: {
        title: `Rename the app machine to ${next}?`,
        lines: ["App addresses that use the old name (like old/t7) stop working."],
        yes: () => ({ effect: { kind: "run", args: ["rename", alias, "--hc-name", next, "--yes"] } }),
        no: () => ({ cancel: true }),
      },
    };
  }
  const bad = aliasProblem(next);
  if (bad) return { error: bad };
  if (next === alias) return { error: "Nothing changed" };
  return {
    confirm: {
      title: `Change the alias ${alias} to ${next}?`,
      lines: ["herdr and the app remove and add the machine again (same session).", "Setup prompts may appear."],
      yes: () => ({ effect: { kind: "run", args: ["rename", alias, "--alias", next, "--yes"] } }),
      no: () => ({ cancel: true }),
    },
  };
}

export function deleteConfirm(row: RowView): Confirm {
  const run = (ssh?: "keep" | "delete"): Next => ({
    effect: { kind: "run", args: ["delete", row.alias, "--yes", ...(ssh ? [`--ssh=${ssh}`] : [])] },
  });
  const managed = row.ssh?.kind === "managed";
  return {
    title: `Remove ${row.alias} from herdr and the app?`,
    lines: ["Sessions and terminals on the remote keep running."],
    yes: () =>
      managed
        ? {
            confirm: {
              title: `Also delete the SSH entry for ${row.alias}?`,
              lines: ["y deletes it from the managed file, n keeps it."],
              yes: () => run("delete"),
              no: () => run("keep"),
            },
          }
        : run(),
    no: () => ({ cancel: true }),
  };
}

function applyNext(s: UiState, next: Next): { s: UiState; effect?: Effect } {
  const base = { ...s, form: undefined, confirm: undefined, picker: undefined };
  if ("effect" in next) return { s: { ...base, mode: "list" }, effect: next.effect };
  if ("confirm" in next) return { s: { ...base, mode: "confirm", confirm: next.confirm } };
  return { s: { ...base, mode: "list", message: "Cancelled" } };
}

function editText(text: string, key: Key): string | null {
  if (key.name === "backspace") return text.slice(0, -1);
  if (key.name === "ctrl" && key.char === "u") return "";
  if (key.name === "char") return text + key.char;
  return null;
}

function reduceForm(s: UiState, key: Key): { s: UiState; effect?: Effect } {
  const form = s.form!;
  const move = (by: number) => ({ s: { ...s, form: { ...form, focus: (form.focus + by + form.fields.length) % form.fields.length, error: undefined } } });
  if (key.name === "escape") return { s: { ...s, mode: "list", form: undefined, message: "Cancelled" } };
  if (key.name === "tab" || key.name === "down") return move(1);
  if (key.name === "backtab" || key.name === "up") return move(-1);
  if (key.name === "enter" || (key.name === "ctrl" && key.char === "s")) {
    if (key.name === "enter" && form.focus < form.fields.length - 1) return move(1);
    const out = submitForm(form);
    if ("error" in out) return { s: { ...s, form: { ...form, error: out.error } } };
    return applyNext(s, out);
  }
  if (key.name === "ctrl" && key.char === "l" && form.kind === "add") {
    const fields = form.fields.map((f) => {
      const last = s.last[f.id as keyof LastUsed];
      return f.value === "" && last ? { ...f, value: last } : f;
    });
    return { s: { ...s, form: { ...form, fields, error: undefined } } };
  }
  const field = form.fields[form.focus]!;
  const text = editText(field.value, key);
  if (text === null) return { s };
  const fields = form.fields.map((f, i) => (i === form.focus ? { ...f, value: text } : f));
  return { s: { ...s, form: { ...form, fields, error: undefined } } };
}

function reduceConfirm(s: UiState, key: Key): { s: UiState; effect?: Effect } {
  const c = s.confirm!;
  if (key.name === "char" && (key.char === "y" || key.char === "Y")) return applyNext(s, c.yes());
  if (key.name === "char" && (key.char === "n" || key.char === "N")) return applyNext(s, c.no());
  if (key.name === "escape") return applyNext(s, { cancel: true });
  return { s };
}

function reducePicker(s: UiState, key: Key): { s: UiState; effect?: Effect } {
  const p = s.picker!;
  const n = p.items.length;
  if (key.name === "escape" || (key.name === "char" && key.char === "q")) return applyNext(s, { cancel: true });
  if (key.name === "up" || (key.name === "char" && key.char === "k")) return { s: { ...s, picker: { ...p, selected: (p.selected - 1 + n) % n } } };
  if (key.name === "down" || (key.name === "char" && key.char === "j")) return { s: { ...s, picker: { ...p, selected: (p.selected + 1) % n } } };
  if (key.name === "enter") {
    const out = p.pick(p.items[p.selected]!.id);
    if ("form" in out) return { s: { ...s, mode: "form", picker: undefined, form: out.form } };
    return applyNext(s, out);
  }
  return { s };
}

function renamePicker(s: UiState, row: RowView): { s: UiState } {
  const items: { id: string; label: string }[] = [];
  if (row.tui) items.push({ id: "label", label: `herdr label (now ${row.tui.label})` });
  if (row.app) items.push({ id: "hc-name", label: `App name (now ${row.app.name})` });
  if (row.ssh?.kind === "managed") items.push({ id: "alias", label: `SSH alias (now ${row.alias})` });
  if (items.length === 0) return { s: { ...s, message: `Nothing to rename on ${row.alias}` } };
  const picker: Picker = {
    title: `Rename what on ${row.alias}?`,
    items,
    selected: 0,
    // Picking opens the matching one field form.
    pick: (id) => ({ form: renameForm(row, id as "label" | "hc-name" | "alias") }),
  };
  return { s: { ...s, mode: "picker", picker } };
}

export function reduce(s0: UiState, key: Key): { s: UiState; effect?: Effect } {
  const s = { ...s0, message: undefined };
  if (key.name === "ctrl" && key.char === "c") return { s, effect: { kind: "quit" } };
  switch (s.mode) {
    case "form":
      return reduceForm(s, key);
    case "confirm":
      return reduceConfirm(s, key);
    case "picker":
      return reducePicker(s, key);
    case "filter": {
      if (key.name === "enter") return { s: { ...s, mode: "list" } };
      if (key.name === "escape") return { s: clampSelection({ ...s, mode: "list", filter: "" }) };
      const text = editText(s.filter, key);
      return text === null ? { s } : { s: clampSelection({ ...s, filter: text, selected: 0 }) };
    }
    case "details":
      if (key.name === "escape" || key.name === "enter" || (key.name === "char" && key.char === "q")) return { s: { ...s, mode: "list" } };
      break;
  }

  const n = visible(s).length;
  const row = current(s);
  if (key.name === "up" || (key.name === "char" && key.char === "k")) return { s: { ...s, selected: Math.max(0, s.selected - 1) } };
  if (key.name === "down" || (key.name === "char" && key.char === "j")) return { s: { ...s, selected: Math.min(Math.max(0, n - 1), s.selected + 1) } };
  if (key.name === "home") return { s: { ...s, selected: 0 } };
  if (key.name === "end") return { s: { ...s, selected: Math.max(0, n - 1) } };
  if (key.name === "escape" && s.mode === "list") {
    if (s.filter) return { s: clampSelection({ ...s, filter: "" }) };
    return { s, effect: { kind: "quit" } };
  }
  if (key.name === "enter" && row && !s.wide) return { s: { ...s, mode: "details" } };
  if (key.name !== "char") return { s };

  switch (key.char) {
    case "q":
      return { s, effect: { kind: "quit" } };
    case "a":
      return { s: { ...s, mode: "form", form: addForm() } };
    case "A": {
      if (s.candidates.length === 0) return { s: { ...s, message: "No hosts from your SSH config left to adopt" } };
      const picker: Picker = {
        title: "Adopt a host from your SSH config",
        items: s.candidates.map((c) => ({ id: c.alias, label: c.ssh?.host ? `${c.alias}  (${c.ssh.host})` : c.alias })),
        selected: 0,
        pick: (alias) => ({ effect: { kind: "run", args: ["adopt", alias] } }),
      };
      return { s: { ...s, mode: "picker", picker } };
    }
    case "/":
      return { s: { ...s, mode: "filter" } };
    case "R":
      return { s: { ...s, healthLoading: true }, effect: { kind: "reload", health: true } };
    case "s":
      return { s, effect: { kind: "run", args: ["doctor"] } };
  }
  if (!row) return { s: { ...s, message: "No machine selected" } };
  switch (key.char) {
    case "e":
      if (row.ssh?.kind !== "managed") {
        return { s: { ...s, message: row.ssh ? `${row.alias} is your own entry in ${row.ssh.file}; edit it by hand` : `${row.alias} has no SSH entry` } };
      }
      return { s: { ...s, mode: "form", form: editForm(row) } };
    case "r":
      return renamePicker(s, row);
    case "d":
      if (!row.tui && !row.app && row.ssh?.kind !== "managed") return { s: { ...s, message: `${row.alias} is not in herdr, the app or the managed file` } };
      return { s: { ...s, mode: "confirm", confirm: deleteConfirm(row) } };
    case "l":
      if (!row.tui && !row.app) return { s: { ...s, message: `${row.alias} is not in herdr or the app` } };
      return { s, effect: { kind: "run", args: ["login", row.alias] } };
  }
  return { s };
}
