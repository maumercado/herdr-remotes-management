# herdr-machines

Manage SSH machines once for the [herdr](https://herdr.dev) TUI and the Herdr app.

The herdr TUI (`herdr machine ...`) and the Herdr app (`hc machine ...`) keep separate machine lists, and neither of them edits your SSH config. A machine you add in one is invisible to the other. `herdr-machines` adds, edits, renames and deletes a machine in all three places in one step:

1. `~/.ssh/config`, through a file this tool manages
2. the herdr TUI's saved machines
3. the Herdr app's machines

It is a herdr plugin: a popup inside the herdr TUI (opened with a key you bind, e.g. `prefix+m`) and the same commands as a CLI. The Herdr app is kept in sync through `hc` when it is installed; there is no app front end, and the app's own machine dialog keeps working as before (`doctor` picks up machines added there).

Progress and what is left: [TODO.md](TODO.md). Design and the reasons behind it: [docs/PLAN.md](docs/PLAN.md).

## Requirements

- macOS or Linux
- Node 22.18 or newer on your PATH (with fnm, Node 26 from this repo's `.node-version` is used when the node on PATH is older)
- OpenSSH's `ssh`
- `herdr` (the TUI)
- optional: `hc` (herdr-core, which comes with the Herdr app). With it, every change also reaches the app; without it the APP column and its steps are skipped.

Install stops and lists what is missing when any of these isn't found.

## Install

```sh
herdr plugin install maumercado/herdr-remotes-management
```

That one command:

1. checks the requirements above (`herdr-machines check`), and fails if any is missing
2. registers the herdr TUI popup

`herdr plugin install` shows the commands it will run before it runs them. `herdr plugin update` updates it.

Then bind the popup to a key in herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "herdr-machines.open"
description = "manage machines"
```

`prefix+m` is free in herdr's defaults (0.9.5).

### Uninstall

```sh
herdr plugin uninstall herdr-machines
```

Machines you added stay in `~/.ssh/config.d/herdr-machines`, herdr and the app. To remove the SSH side too, delete that file and the two lines this tool added at the top of `~/.ssh/config`.

### Working on it

```sh
git clone https://github.com/maumercado/herdr-remotes-management.git ~/code/herdr-remotes-management
herdr plugin link ~/code/herdr-remotes-management
```

`plugin link` runs no build steps, so check the requirements yourself:

```sh
~/code/herdr-remotes-management/bin/herdr-machines check
```

Edits in the checkout apply to the popup on its next open.

## Using it

Press `prefix+m` in herdr. The popup lists your machines with their state in each place (SSH, TUI, APP) and the details of the selected one.

| Key | Does |
|---|---|
| `a` | add a machine (alias and host are enough; user, port and key fall back to SSH's defaults, `Ctrl-L` fills them as last time) |
| `A` | adopt a host you already have in `~/.ssh/config` (its entry is never edited) |
| `e` | edit host, user, port, key or jump host. Works while the machine is offline; for a machine whose alias has no SSH entry yet, it creates one |
| `r` | rename: the herdr label, the app name, or the SSH alias |
| `d` | delete from herdr and the app, then choose whether to delete the SSH entry |
| `l` | log in again (herdr reconnect, hc login) |
| `s` | doctor: find and fix drift between the three places |
| `/` | filter |
| `R` | refresh, with live health checks |
| `q` | close |

Changes run in the popup's terminal, so host key, password, session and install prompts reach you. Each one ends with a step report:

```
ssh ✓  tui ✓  app ✕ (needs_login)
```

When a step fails you can retry it, undo the steps already done, or leave it for doctor.

| Glyph | Meaning |
|---|---|
| `●` | there and fine (SSH: managed by this tool) |
| `◇` | your own SSH entry (adopted, never edited) |
| `○` | missing |
| `◐` | connecting |
| `!` | needs login |
| `↑` | needs an update on the remote |
| `✕` | unreachable |
| `◌` | disabled in herdr |

### Scripting

The popup runs a CLI that you can call too, for scripts or `--json` output. It lives in the plugin's folder, which herdr moves on each update, so look the folder up when you call it:

```sh
root=$(herdr plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).result.plugins.find(p=>p.plugin_id==="herdr-machines");console.log(p.plugin_root)})')
sh "$root/bin/run" list --json
sh "$root/bin/run" doctor --fix --yes
```

From a checkout, `bin/herdr-machines <command>` does the same. Commands: `list [--all] [--health]`, `add`, `adopt`, `edit`, `rename`, `delete`, `login`, `doctor [--fix]`, `check`; `help` prints the details.

## How it works

**One name for everything.** The SSH alias is the target herdr and hc connect to (never a raw `user@host`). Rows are matched by that target, so herdr labels and app names can be anything. Changing a host, user, port, key or jump host only rewrites the SSH entry; herdr and the app pick it up on their next connection.

**The managed file.** Machines this tool creates live in `~/.ssh/config.d/herdr-machines` (mode `600`), pulled in by one `Include` line at the very top of `~/.ssh/config`. That line is the only change the tool ever makes to `~/.ssh/config`. Hosts you wrote yourself are listed and can be adopted, but their entries are never edited or deleted.

**Order.** Every change runs SSH first, then herdr, then the app. Input is checked before anything is written.

**Connection reuse.** herdr names its shared SSH connection after the resolved host, port and user, so endpoint edits apply on the next connection. hc keeps its connection under the alias for up to 10 idle minutes, so `edit` offers to refresh the app's login (remove and add again with the same name and session).

**Questions.** Anything that can ask you something (a host key, a password, herdr's session picker, installing on the remote) runs in your terminal. Nothing answers prompts for you. With `--json`, or without a terminal, a command that would need an answer stops with exit code 3 and changes nothing.

## Safety

- Every write is atomic and goes through symlinks, so a `~/.ssh/config` managed by Stow, chezmoi or yadm stays a symlink.
- The tool refuses to put the managed file inside a git repository (a dotfiles repo may be public). Set `HERDR_MACHINES_ALLOW_REPO=1` if that is what you want.
- Before each write, the old file is copied to `~/.local/state/herdr-machines/backups/` (the last 10 per file are kept).
- After each write, `ssh -G <alias>` must resolve to what was written, or the write is rolled back.
- A lock file stops two runs (the popup and a terminal, say) from writing at the same time.
- Key files are never read, copied or created. Only the `IdentityFile` path is stored.

## The Herdr app

There is no app front end. With `hc` installed, every change made here reaches the app too, and `list --json` gives another tool everything it needs (machines, their state in each place, adopt candidates). A personal app mod can call `herdr-machines list --json` through `exec` and open a terminal for changes; the plugin's folder comes from `herdr plugin list --json` (`plugin_root`).

## Reference

Global options: `--json` (machine readable output, never asks), `--yes` / `-y` (answer yes), `--on-fail=ask|undo|leave`.

Exit codes: `0` done, `1` a step failed, `2` bad input, `3` a question came up with nobody to answer it.

| Environment variable | Effect |
|---|---|
| `HERDR_MACHINES_HERDR`, `HERDR_MACHINES_HC`, `HERDR_MACHINES_SSH` | use these binaries |
| `HERDR_MACHINES_NODE` | node for `bin/run` (default: `node` on PATH) |
| `HERDR_MACHINES_ALLOW_REPO=1` | allow the managed file inside a git repo |
| `XDG_STATE_HOME` | where the state folder lives (default `~/.local/state`) |

## Troubleshooting

- **The TUI or APP column is empty.** `herdr` or `hc` wasn't found or failed; the `check` command (see Scripting) shows what is on your PATH.
- **"needs a terminal" (exit 3).** Run the same command in a terminal, or answer with the flag it names.
- **"rolled back: HostName resolves to ..."**. Another `Host` block matched first. Run `doctor`, which reports aliases defined twice.
- **A machine needs attention in herdr that isn't a login** (an outdated server, say). Run `herdr --remote <alias>` in a terminal outside herdr.

## Development

```sh
npm test            # node --test, no dependencies
npm run typecheck   # fetches TypeScript on demand; nothing is added to package.json
```

| Path | What |
|---|---|
| `src/` | the CLI (TypeScript, run directly by node) |
| `src/ui/` | the herdr popup (state, keys, drawing, terminal loop) |
| `herdr-plugin.toml` | the herdr plugin manifest (requirement check, popup, action) |
| `bin/` | `run` (finds node), `herdr-machines` (the command) |
| `test/` | tests, with fake `herdr`, `hc` and `ssh` in `test/fakes/` |
| `docs/PLAN.md` | the design |
| `TODO.md` | the checklist |

## License

Not chosen yet.
