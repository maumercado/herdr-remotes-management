// Stand in for ssh. `-G alias` resolves through the real config files under
// $HOME with the project's own reader (so a missing Include shows up as a
// mismatch). Anything else is a connection: exit $FAKE_SSH_REACH (default 0).

import { join } from "node:path";
import { readConfig } from "../../src/sshconfig.ts";
import { logCall } from "./store.ts";

const args = process.argv.slice(2);
logCall("ssh", args);

if (args[0] === "-G") {
  const alias = args[1]!;
  const home = process.env.HOME!;
  const read = readConfig(join(home, ".ssh", "config"), { home, baseDir: join(home, ".ssh") });
  const host = read.hosts.find((h) => h.alias === alias);
  const f = host?.fields ?? {};
  process.stdout.write(`host ${alias}\nhostname ${f.host ?? alias}\nuser ${f.user ?? "me"}\nport ${f.port ?? "22"}\n`);
  process.exit(0);
}
process.exit(Number(process.env.FAKE_SSH_REACH ?? "0"));
