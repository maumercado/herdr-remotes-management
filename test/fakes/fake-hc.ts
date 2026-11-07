// Stand in for `hc machine ...`, following herdr-core's cli/machine.rs and api.rs.

import { fail, flag, load, logCall, save } from "./store.ts";

interface Machine {
  name: string;
  target: string;
  via: boolean;
  temporary: boolean;
  session: string | null;
  id: string;
  host: string;
  version: string;
  state: string;
  since_ms: number;
  why: string | null;
}

const args = process.argv.slice(2);
logCall("hc", args);
if (args[0] !== "machine") fail("fake hc only knows `machine`", 2);
const machines = load<Machine[]>("hc", []);
const [, sub, first, second] = args;

switch (sub) {
  case "ls":
    process.stdout.write(JSON.stringify({ machines }, null, 2) + "\n");
    break;
  case "add": {
    if (process.env.FAKE_HC_FAIL_ADD) fail("needs_login: logging in failed");
    const name = flag(args, "--name") ?? first!;
    if (machines.some((m) => m.name === name)) fail(`"${name}" is already a machine here`, 2);
    machines.push({
      name,
      target: first!,
      via: false,
      temporary: false,
      session: flag(args, "--session") ?? null,
      id: `c${machines.length + 1}`,
      host: first!,
      version: "1.0.0",
      state: process.env.FAKE_HC_STATE ?? "connected",
      since_ms: 0,
      why: null,
    });
    save("hc", machines);
    process.stdout.write(`added ${name}\n`);
    break;
  }
  case "rename": {
    const m = machines.find((x) => x.name === first);
    if (!m) fail(`unknown machine ${first}`, 2);
    m.name = second!;
    save("hc", machines);
    break;
  }
  case "rm": {
    const left = machines.filter((x) => x.name !== first);
    if (left.length === machines.length) fail(`unknown machine ${first}`, 2);
    save("hc", left);
    break;
  }
  case "login":
    break;
  default:
    fail(`fake hc: unknown machine ${sub}`, 2);
}
