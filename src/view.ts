// How a row looks: the JSON shape front ends read, and the glyphs both the
// CLI table and the TUI popup draw.

import type { Row, State } from "./model.ts";
import { isMachine } from "./model.ts";

export interface RowView {
  alias: string;
  raw: boolean;
  ssh: null | {
    kind: "managed" | "yours";
    host?: string;
    user?: string;
    port?: string;
    key?: string;
    jump?: string;
    file: string;
    line: number;
    shadows?: string[];
  };
  tui: null | {
    id: string;
    label: string;
    session: string;
    enabled: boolean;
    health?: string;
    error?: string | null;
    duplicates: number;
  };
  app: null | {
    name: string;
    session?: string | null;
    state?: string;
    version?: string;
    /** The remote's own name for itself (hc's `host`), e.g. its hostname. */
    host?: string;
    why?: string | null;
    via: boolean;
    duplicates: number;
  };
  glyphs: { ssh: string; tui: string; app: string };
}

export function sshGlyph(row: Row): string {
  if (!row.ssh) return "○";
  return row.ssh.managed ? "●" : "◇";
}

export function tuiGlyph(row: Row): string {
  if (!row.tui) return "○";
  if (!row.tui.enabled) return "◌";
  switch (row.tuiHealth?.status) {
    case undefined:
    case "reachable":
      return "●";
    case "auth required":
      return "!";
    case "disabled":
      return "◌";
    default:
      return "✕";
  }
}

export function appGlyph(row: Row): string {
  if (!row.app) return "○";
  switch (row.app.state) {
    case "connected":
    case undefined:
      return "●";
    case "connecting":
      return "◐";
    case "needs_login":
      return "!";
    case "needs_update":
      return "↑";
    default:
      return "✕";
  }
}

export const LEGEND = "● ok  ◇ your own SSH entry  ○ missing  ◐ connecting  ! needs login  ↑ needs update  ✕ unreachable  ◌ disabled";

export function rowView(row: Row): RowView {
  return {
    alias: row.alias,
    raw: row.raw,
    ssh: row.ssh && {
      kind: row.ssh.managed ? "managed" : "yours",
      ...row.ssh.fields,
      file: row.ssh.file,
      line: row.ssh.line,
      ...(row.ssh.shadows ? { shadows: row.ssh.shadows } : {}),
    },
    tui: row.tui && {
      id: row.tui.id,
      label: row.tui.label,
      session: row.tui.session,
      enabled: row.tui.enabled,
      ...(row.tuiHealth ? { health: row.tuiHealth.status, error: row.tuiHealth.error ?? null } : {}),
      duplicates: row.tuiExtra.length,
    },
    app: row.app && {
      name: row.app.name,
      session: row.app.session ?? null,
      state: row.app.state,
      version: row.app.version,
      host: row.app.host || undefined,
      why: row.app.why ?? null,
      via: Boolean(row.app.via),
      duplicates: row.appExtra.length,
    },
    glyphs: { ssh: sshGlyph(row), tui: tuiGlyph(row), app: appGlyph(row) },
  };
}

export function stateView(state: State, all: boolean) {
  return {
    machines: state.rows.filter((r) => all || isMachine(r)).map(rowView),
    tools: {
      herdr: state.herdr.available ? { available: true } : { available: false, reason: state.herdr.reason },
      hc: state.hc.available ? { available: true } : { available: false, reason: state.hc.reason },
    },
    ssh: {
      config: state.ssh.config,
      configIsSymlink: state.ssh.configIsSymlink,
      configRealPath: state.ssh.configRealPath,
      managedFile: state.ssh.managedFile,
      managedRealPath: state.ssh.managedRealPath,
      managedInsideRepo: state.ssh.managedRepo,
      include: state.ssh.include,
      patterns: state.ssh.read.patterns,
      warnings: state.ssh.read.warnings,
    },
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + "…" : text + " ".repeat(width - text.length);
}

export function formatTable(state: State, all: boolean): string {
  const rows = state.rows.filter((r) => all || isMachine(r));
  if (rows.length === 0) return all ? "No SSH hosts or machines found." : "No machines yet. `herdr-machines list --all` shows hosts from your SSH config you can adopt.";
  const width = Math.min(28, Math.max(5, ...rows.map((r) => r.alias.length + 1)));
  const lines = [`${pad("ALIAS", width)} SSH TUI APP  TARGET`];
  for (const row of rows) {
    const f = row.ssh?.fields;
    const target = f?.host ? `${f.user ? f.user + "@" : ""}${f.host}${f.port ? ":" + f.port : ""}` : row.raw ? "(raw target)" : "";
    lines.push(`${pad(row.alias, width)}  ${sshGlyph(row)}   ${tuiGlyph(row)}   ${appGlyph(row)}   ${target}`);
  }
  lines.push("", LEGEND);
  if (!state.herdr.available) lines.push(`TUI column empty: ${state.herdr.reason}`);
  if (!state.hc.available) lines.push(`APP column empty: ${state.hc.reason}`);
  return lines.join("\n");
}

/** user, host and port from a raw target such as `user@1.2.3.4:2222` or `ssh://host`. */
export function parseRawTarget(target: string): { user?: string; host?: string; port?: string } {
  const m = /^(?:ssh:\/\/)?(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return {};
  return { user: m[1], host: m[2]?.replace(/^\[|\]$/g, ""), port: m[3] };
}

/**
 * A name for a raw-address machine that isn't taken yet: the remote's own
 * name (hc's host), else its herdr label or app name, else "machine", with
 * -2, -3... added when that is already a Host or a machine.
 */
export function suggestAlias(row: RowView, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = (n: string | undefined) => (n ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[-.]+$/g, "").slice(0, 28);
  const looksLikeAddress = (n: string) => n.includes("@") || n.includes(":") || /^[\d.]+$/.test(n);
  const base = [row.app?.host, row.tui?.label, row.app?.name].filter((n): n is string => Boolean(n) && !looksLikeAddress(n!)).map(clean).find(Boolean) || "machine";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}
