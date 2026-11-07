// Entry point: argument parsing, output and exit codes.

import { parseArgs } from "node:util";
import { paths, TOOL } from "./env.ts";
import type { Ctx } from "./io.ts";
import { EXIT, makeLog, NeedsTerminal, UsageError } from "./io.ts";
import { resolveBins } from "./proc.ts";
import * as cmd from "./commands.ts";
import type { CommandResult } from "./commands.ts";
import { formatReport } from "./steps.ts";

export const HELP = `${TOOL}: one place to manage SSH machines for ~/.ssh/config, the herdr TUI and the Herdr app.

Usage:
  ${TOOL} list [--all] [--health] [--json]
  ${TOOL} add <alias> --host H [--user U] [--port P] [--key PATH] [--jump J] [--session S] [--same-as-last]
  ${TOOL} adopt <alias> [--hc-name N] [--session S]
  ${TOOL} edit <alias> [--host H] [--user U] [--port P] [--key PATH] [--jump J] [--reconnect]
  ${TOOL} rename <alias> (--label L | --hc-name N | --alias A)
  ${TOOL} delete <alias> [--ssh=keep|delete]
  ${TOOL} login <alias>
  ${TOOL} doctor [--fix]
  ${TOOL} setup
  ${TOOL} ui
  ${TOOL} help

Options for every command:
  --json        machine readable output on stdout; never asks anything
  --yes, -y     answer yes to confirmations
  --on-fail=ask|undo|leave
                what to do when a step fails (default: ask in a terminal, leave otherwise)

Pass "" to edit to clear an option, e.g. --user "".

Exit codes: 0 done, 1 a step failed, 2 bad input, 3 a question came up with nobody to answer it.

Machines this tool creates live in ~/.ssh/config.d/${TOOL}, included from the
top of ~/.ssh/config. Hosts you wrote yourself are never edited.`;

const OPTIONS = {
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "on-fail": { type: "string" },
  all: { type: "boolean" },
  health: { type: "boolean" },
  host: { type: "string" },
  user: { type: "string" },
  port: { type: "string" },
  key: { type: "string" },
  jump: { type: "string" },
  session: { type: "string" },
  "same-as-last": { type: "boolean" },
  "hc-name": { type: "string" },
  label: { type: "string" },
  alias: { type: "string" },
  ssh: { type: "string" },
  fix: { type: "boolean" },
  reconnect: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function one(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected ${what}`);
  return positionals[0]!;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
    return EXIT.badInput;
  }
  const { values: v, positionals } = parsed;
  const [command = "help", ...rest] = positionals;
  const json = Boolean(v.json);
  const p = paths();
  const ctx: Ctx = {
    p,
    bins: resolveBins(p),
    json,
    yes: Boolean(v.yes),
    interactive: !json && Boolean(process.stdin.isTTY && process.stderr.isTTY),
    onFail: "ask",
    log: makeLog(json),
  };
  const onFail = v["on-fail"];
  if (onFail !== undefined) {
    if (onFail !== "ask" && onFail !== "undo" && onFail !== "leave") {
      process.stderr.write("--on-fail must be ask, undo or leave\n");
      return EXIT.badInput;
    }
    ctx.onFail = onFail;
  }

  let res: CommandResult;
  try {
    switch (command) {
      case "help":
        process.stdout.write(HELP + "\n");
        return EXIT.ok;
      case "list":
      case "ls":
        res = await cmd.list(ctx, { all: v.all, health: v.health });
        break;
      case "add":
        res = await cmd.add(ctx, one(rest, "an alias"), {
          host: v.host,
          user: v.user,
          port: v.port,
          key: v.key,
          jump: v.jump,
          session: v.session,
          sameAsLast: v["same-as-last"],
        });
        break;
      case "adopt":
        res = await cmd.adopt(ctx, one(rest, "an alias"), { hcName: v["hc-name"], session: v.session });
        break;
      case "edit":
        res = await cmd.edit(ctx, one(rest, "an alias"), { host: v.host, user: v.user, port: v.port, key: v.key, jump: v.jump }, { reconnect: v.reconnect });
        break;
      case "rename":
        res = await cmd.rename(ctx, one(rest, "an alias"), { label: v.label, hcName: v["hc-name"], alias: v.alias });
        break;
      case "delete":
      case "rm": {
        const ssh = v.ssh;
        if (ssh !== undefined && ssh !== "keep" && ssh !== "delete") throw new UsageError("--ssh must be keep or delete");
        res = await cmd.remove(ctx, one(rest, "an alias"), { ssh });
        break;
      }
      case "login":
        res = await cmd.login(ctx, one(rest, "an alias"));
        break;
      case "doctor":
        res = await cmd.doctor(ctx, { fix: v.fix });
        break;
      case "setup":
        res = await cmd.setup(ctx);
        break;
      case "ui": {
        const { runUi } = await import("./ui/app.ts");
        return await runUi(ctx);
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (json) process.stdout.write(JSON.stringify({ error: error.message, code: EXIT.badInput }) + "\n");
      else process.stderr.write(`${TOOL}: ${error.message}\n`);
      return EXIT.badInput;
    }
    if (error instanceof NeedsTerminal) {
      if (json) process.stdout.write(JSON.stringify({ error: error.message, code: EXIT.needsTerminal }) + "\n");
      else process.stderr.write(`${TOOL}: ${error.message} (run it in a terminal, or pass --yes / the matching flag)\n`);
      return EXIT.needsTerminal;
    }
    throw error;
  }

  if (json) {
    process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + "\n");
  } else {
    if (res.report) process.stdout.write(formatReport(res.report) + "\n");
    if (res.text) process.stdout.write(res.text + "\n");
  }
  return res.code;
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${TOOL}: ${(error as Error).stack ?? error}\n`);
      process.exit(EXIT.failed);
    },
  );
}
