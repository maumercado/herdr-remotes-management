// The popup's terminal loop: raw mode on the alternate screen, keys go to the
// reducer, effects run here. Commands run as the normal CLI with the terminal
// handed over, so every prompt (host key, password, session picker, install)
// is answered by you, exactly as it would be in a shell.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../io.ts";
import { EXIT } from "../io.ts";
import { readJson } from "../fsx.ts";
import { addHealth, isMachine, loadState } from "../model.ts";
import type { State } from "../model.ts";
import { rowView } from "../view.ts";
import { TOOL } from "../env.ts";
import { parseKeys } from "./keys.ts";
import { render, WIDE_MIN } from "./render.ts";
import type { Effect, LastUsed, UiState } from "./state.ts";
import { initialState, reduce, withData } from "./state.ts";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

/** Machines, plus your own hosts that nothing knows about yet (adopt candidates). */
export function splitRows(state: State) {
  return {
    machines: state.rows.filter(isMachine).map(rowView),
    candidates: state.rows.filter((r) => r.ssh && !r.ssh.managed && !r.tui && !r.app && !r.raw).map(rowView),
  };
}

export async function runUi(ctx: Ctx): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write(`${TOOL} ui needs a terminal\n`);
    return EXIT.needsTerminal;
  }
  const style = { color: !process.env.NO_COLOR, home: ctx.p.home };
  let s: UiState = initialState();
  let generation = 0;
  let onScreen = false;

  const draw = (): void => {
    if (!onScreen) return;
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    s = { ...s, wide: cols >= WIDE_MIN };
    // One column spare so the last cell never wraps.
    const lines = render(s, cols - 1, rows, style);
    stdout.write("\x1b[H" + lines.join("\x1b[K\r\n") + "\x1b[K\x1b[J");
  };

  const enter = (): void => {
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    onScreen = true;
  };

  const leave = (): void => {
    if (!onScreen) return;
    onScreen = false;
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[?1049l");
  };

  const reload = (health: boolean): void => {
    const gen = ++generation;
    let state: State;
    try {
      state = loadState(ctx.p, ctx.bins);
    } catch (error) {
      s = { ...s, message: `could not read machines: ${(error as Error).message}` };
      draw();
      return;
    }
    const { machines, candidates } = splitRows(state);
    s = withData({ ...s, last: readJson<LastUsed>(ctx.p.lastFile, {}), healthLoading: health && state.herdr.available }, machines, candidates);
    draw();
    if (!health || !state.herdr.available) return;
    addHealth(state, ctx.bins).then(
      () => {
        if (gen !== generation) return;
        const fresh = splitRows(state);
        s = withData({ ...s, healthLoading: false }, fresh.machines, fresh.candidates);
        draw();
      },
      () => {
        if (gen !== generation) return;
        s = { ...s, healthLoading: false };
        draw();
      },
    );
  };

  const waitKey = (): Promise<void> =>
    new Promise((done) => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once("data", () => {
        stdin.setRawMode(false);
        stdin.pause();
        done();
      });
    });

  const runCli = async (args: string[]): Promise<void> => {
    stdin.off("data", onData);
    leave();
    stdout.write(`\n$ ${TOOL} ${args.map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ")}\n\n`);
    const r = spawnSync(process.execPath, [MAIN, ...args], { stdio: "inherit", env: process.env });
    const code = r.status ?? 1;
    stdout.write(`\n${code === 0 ? "Done." : `Finished with exit code ${code}.`} Press any key to go back.`);
    await waitKey();
    enter();
    stdin.on("data", onData);
    s = { ...s, message: `${args[0]} ${args[1] ?? ""}: ${code === 0 ? "done" : `exit ${code}`}`.replace(/ :/, ":") };
    reload(true);
  };

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));
  let busy = false;

  const apply = async (effect: Effect | undefined): Promise<void> => {
    if (!effect) return draw();
    if (effect.kind === "quit") {
      leave();
      finish(EXIT.ok);
      return;
    }
    if (effect.kind === "reload") return reload(effect.health);
    busy = true;
    try {
      await runCli(effect.args);
    } finally {
      busy = false;
    }
  };

  function onData(data: string): void {
    if (busy) return;
    for (const key of parseKeys(data)) {
      const out = reduce(s, key);
      s = out.s;
      if (out.effect) {
        void apply(out.effect);
        if (out.effect.kind !== "reload") return;
      }
    }
    draw();
  }

  const restore = () => leave();
  process.on("exit", restore);
  stdout.on("resize", draw);
  enter();
  stdin.on("data", onData);
  s = { ...s, message: "loading…" };
  draw();
  reload(true);
  s = { ...s, message: undefined };
  draw();

  const code = await finished;
  stdin.off("data", onData);
  stdout.off("resize", draw);
  process.off("exit", restore);
  return code;
}
