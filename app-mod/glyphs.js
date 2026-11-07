// Copy this file into your own mod (a spaces sidebar, a status bar) to show
// a machine's state next to its name and open the Machines dialog.
// Mods can't import each other at run time, so it is meant to be copied.
//
//   import { appMachineStates, machineGlyph, openMachines } from "./glyphs.js";
//   // in init: cx.timer.every(10000, (cx) => cx.spawn(async (cx) => { this.states = await appMachineStates(); cx.notify(); }));
//   // in render: div().child(machineGlyph(this.states?.[name]).glyph)
//   //            div().id("machines").on_click(() => openMachines()).child("Machines")

import { hc, run } from "herdr";

/** `hc machine ls` states by machine name: connecting, connected, needs_login, needs_update, unreachable. */
export async function appMachineStates() {
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  if (!r || r.code !== 0) return {};
  try {
    const out = {};
    for (const m of JSON.parse(r.stdout).machines ?? []) out[m.name] = m.state;
    return out;
  } catch {
    return {};
  }
}

const GLYPHS = {
  connected: { glyph: "●", color: "done", label: "connected" },
  connecting: { glyph: "◐", color: "working", label: "connecting" },
  needs_login: { glyph: "!", color: "blocked", label: "needs login" },
  needs_update: { glyph: "↑", color: "blocked", label: "needs update" },
  unreachable: { glyph: "✕", color: "ansi1", label: "unreachable" },
};

/** { glyph, color, label }; color is a theme() key. */
export function machineGlyph(state) {
  return GLYPHS[state] ?? { glyph: "○", color: "dim", label: state ?? "not in the app" };
}

/** Opens the Machines dialog (the same as the `mod.open:herdr-machines` key action). */
export function openMachines() {
  run("mod.open", { name: "herdr-machines" });
}
