// Draws the popup as plain lines. Colours are added last, so widths are
// always computed on the visible text.

import type { RowView } from "../view.ts";
import { LEGEND } from "../view.ts";
import type { Confirm, Form, Picker, UiState } from "./state.ts";
import { current, visible } from "./state.ts";

/** Below this width the popup shows one pane at a time. */
export const WIDE_MIN = 76;

export interface Style {
  color: boolean;
  home?: string;
}

const ESC = "\x1b[";
const paint = (code: string, text: string, style: Style) => (style.color ? `${ESC}${code}m${text}${ESC}0m` : text);

/** Cuts or pads text to exactly width visible characters. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length > width) return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
  return text + " ".repeat(width - chars.length);
}

const GLYPH_COLOR: Record<string, string> = { "●": "32", "◇": "36", "○": "2", "◐": "33", "!": "33", "↑": "33", "✕": "31", "◌": "2" };

function colorGlyphs(line: string, style: Style): string {
  if (!style.color) return line;
  return line.replace(/[●◇○◐!↑✕◌]/g, (g) => paint(GLYPH_COLOR[g] ?? "0", g, style));
}

function tilde(path: string, style: Style): string {
  return style.home && path.startsWith(style.home + "/") ? "~" + path.slice(style.home.length) : path;
}

export function listLines(s: UiState, width: number, height: number, style: Style): string[] {
  const rows = visible(s);
  const out: string[] = [];
  const glyphCols = " SSH TUI APP";
  const aliasWidth = Math.max(4, width - glyphCols.length - 2);
  out.push(paint("2", fit(`  ${fit("ALIAS", aliasWidth)}${glyphCols}`, width), style));
  const room = height - 1;
  if (rows.length === 0) {
    out.push(fit(s.filter ? "  nothing matches the filter" : "  no machines yet: a to add, A to adopt", width));
    return out;
  }
  // Keep the selection in view.
  const start = Math.max(0, Math.min(s.selected - Math.floor(room / 2), rows.length - room));
  for (let i = start; i < Math.min(rows.length, start + room); i++) {
    const r = rows[i]!;
    const mark = i === s.selected ? "▸ " : "  ";
    const text = fit(`${mark}${fit(r.alias, aliasWidth)}  ${r.glyphs.ssh}   ${r.glyphs.tui}   ${r.glyphs.app}`, width);
    out.push(i === s.selected && style.color ? paint("7", text, style) : colorGlyphs(text, style));
  }
  return out;
}

export function detailLines(row: RowView | undefined, width: number, style: Style, healthLoading: boolean): string[] {
  if (!row) return [];
  const out: string[] = [];
  const kv = (k: string, v: string | undefined | null) => {
    if (v !== undefined && v !== null && v !== "") out.push(fit(`  ${k.padEnd(8)}${v}`, width));
  };
  out.push(fit(row.alias, width));
  out.push("");
  if (row.ssh) {
    out.push(fit(`SSH  ${row.ssh.kind === "managed" ? "managed" : "your own entry"}  ${tilde(row.ssh.file, style)}:${row.ssh.line}`, width));
    kv("host", row.ssh.host);
    kv("user", row.ssh.user);
    kv("port", row.ssh.port);
    kv("key", row.ssh.key);
    kv("jump", row.ssh.jump);
    if (row.ssh.shadows) kv("also in", row.ssh.shadows.map((f) => tilde(f, style)).join(", "));
  } else out.push(fit(row.raw ? "SSH  raw target, not an alias" : "SSH  no Host entry", width));
  out.push("");
  if (row.tui) {
    out.push(fit(`TUI  ${row.tui.label}${row.tui.enabled ? "" : "  (disabled)"}`, width));
    kv("id", row.tui.id);
    kv("session", row.tui.session);
    kv("health", row.tui.health ?? (healthLoading ? "checking…" : undefined));
    kv("error", row.tui.error);
    if (row.tui.duplicates) kv("extra", `${row.tui.duplicates} more profile(s) with this target`);
  } else out.push(fit("TUI  not in herdr", width));
  out.push("");
  if (row.app) {
    out.push(fit(`APP  ${row.app.name}${row.app.via ? "  (via command, read only)" : ""}`, width));
    kv("session", row.app.session);
    kv("state", row.app.state);
    kv("hc", row.app.version);
    kv("why", row.app.why);
    if (row.app.duplicates) kv("extra", `${row.app.duplicates} more machine(s) with this target`);
  } else out.push(fit("APP  not in the app", width));
  return out;
}

function boxLines(title: string, body: string[], width: number, footer: string): string[] {
  const inner = Math.max(10, width - 4);
  return [`┌ ${fit(title, inner - 1)}┐`, ...body.map((l) => `│ ${fit(l, inner - 1)}│`), `│ ${fit("", inner - 1)}│`, `│ ${fit(footer, inner - 1)}│`, `└${"─".repeat(inner)}┘`].map((l) => fit(l, width));
}

export function formLines(form: Form, width: number, last: boolean): string[] {
  const labelWidth = Math.max(...form.fields.map((f) => f.label.length)) + 2;
  const body = form.fields.map((f, i) => `${i === form.focus ? "▸" : " "} ${(f.label + (f.required ? "*" : "")).padEnd(labelWidth)} ${f.value}${i === form.focus ? "▏" : ""}`);
  if (form.error) body.push("", `! ${form.error}`);
  const keys = ["enter next/save", "tab move", "esc cancel"];
  if (form.kind === "add" && last) keys.splice(2, 0, "^L as last time");
  return boxLines(form.title, body, width, keys.join("  "));
}

export function confirmLines(c: Confirm, width: number): string[] {
  return boxLines(c.title, c.lines, width, "y yes  n no  esc cancel");
}

export function pickerLines(p: Picker, width: number): string[] {
  return boxLines(p.title, p.items.map((it, i) => `${i === p.selected ? "▸" : " "} ${it.label}`), width, "enter pick  esc cancel");
}

const HINTS_WIDE = "a add  A adopt  e edit  r rename  d delete  l login  s doctor  / filter  R refresh  q close";
const HINTS_NARROW = "a A e r d l s / R q  enter details";

/** The whole screen, one string per terminal row. */
export function render(s: UiState, cols: number, rows: number, style: Style): string[] {
  const width = Math.max(20, cols);
  const height = Math.max(6, rows);
  const bodyHeight = height - 3;
  const total = s.machines.length;
  const shown = visible(s).length;
  const title = ` herdr-machines  ${shown === total ? `${total}` : `${shown}/${total}`} machine${total === 1 ? "" : "s"}${s.healthLoading ? "  checking health…" : ""}`;
  const out: string[] = [paint("1", fit(title, width), style)];

  let body: string[];
  if (s.mode === "form" && s.form) body = formLines(s.form, width, Object.keys(s.last).length > 0);
  else if (s.mode === "confirm" && s.confirm) body = confirmLines(s.confirm, width);
  else if (s.mode === "picker" && s.picker) body = pickerLines(s.picker, width);
  else if (s.wide) {
    const left = Math.max(30, Math.min(40, Math.floor(width * 0.42)));
    const right = width - left - 3;
    const l = listLines(s, left, bodyHeight, style);
    const r = detailLines(current(s), right, style, s.healthLoading);
    body = [];
    for (let i = 0; i < bodyHeight; i++) {
      const lv = l[i] ?? " ".repeat(left);
      const rv = r[i] ?? "";
      body.push(`${lv.includes("\x1b") ? lv : fit(lv, left)} ${paint("2", "│", style)} ${colorGlyphs(fit(rv, right), style)}`);
    }
  } else if (s.mode === "details") body = detailLines(current(s), width, style, s.healthLoading);
  else body = listLines(s, width, bodyHeight, style);

  for (let i = 0; i < bodyHeight; i++) {
    const line = body[i];
    out.push(line === undefined ? " ".repeat(width) : line.includes("\x1b") ? line : fit(line, width));
  }
  const filter = s.mode === "filter" ? `/${s.filter}▏` : s.filter ? `filter: ${s.filter}  (esc clears)` : "";
  const message = s.message ?? filter;
  out.push(message ? paint("33", fit(` ${message}`, width), style) : paint("2", fit(` ${LEGEND}`, width), style));
  out.push(paint("2", fit(` ${s.wide ? HINTS_WIDE : HINTS_NARROW}`, width), style));
  return out;
}
