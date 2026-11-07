// Stand in for `herdr machine ...`, following the shapes in herdr's src/cli/machine.rs.

import { fail, flag, load, logCall, save } from "./store.ts";

interface Profile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
  selected: boolean;
}

const args = process.argv.slice(2);
logCall("herdr", args);
if (args[0] !== "machine") fail("fake herdr only knows `machine`", 2);
const profiles = load<Profile[]>("herdr", []);
const [, sub, first] = args;

switch (sub) {
  case "list":
    process.stdout.write(JSON.stringify(profiles, null, 2) + "\n");
    break;
  case "status": {
    const rows = profiles
      .filter((p) => !first || first.startsWith("-") || p.id === first || p.label === first)
      .map((p) => ({ id: p.id, label: p.label, status: process.env.FAKE_HERDR_STATUS ?? "reachable", error: null }));
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    break;
  }
  case "add": {
    if (process.env.FAKE_HERDR_FAIL_ADD) fail("remote setup failed");
    const label = flag(args, "--label") ?? first!;
    profiles.push({ id: `p${profiles.length + 1}${Math.random().toString(36).slice(2, 6)}`, label, target: first!, session: flag(args, "--remote-session") ?? "default", enabled: true, selected: false });
    save("herdr", profiles);
    process.stdout.write(`added ${label}\n`);
    break;
  }
  case "rename": {
    const p = profiles.find((x) => x.id === first);
    if (!p) fail(`unknown profile ${first}`, 2);
    p.label = flag(args, "--label")!;
    save("herdr", profiles);
    break;
  }
  case "remove": {
    const left = profiles.filter((x) => x.id !== first);
    if (left.length === profiles.length) fail(`unknown profile ${first}`, 2);
    save("herdr", left);
    break;
  }
  case "reconnect":
    break;
  default:
    fail(`fake herdr: unknown machine ${sub}`, 2);
}
