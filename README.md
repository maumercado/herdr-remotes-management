# herdr-machines

Manage SSH machines once for the [herdr](https://herdr.dev) TUI and the Herdr app.

The herdr TUI (`herdr machine ...`) and the Herdr app (`hc machine ...`) keep separate machine lists, and neither of them edits your SSH config. A machine you add in one is invisible to the other. `herdr-machines` adds, edits, renames and deletes a machine in all three places in one step:

1. `~/.ssh/config`, through a file this tool manages
2. the herdr TUI's saved machines
3. the Herdr app's machines

It comes with three front ends that all run the same CLI:

| Front end | Where | Opens with |
|---|---|---|
| CLI | any terminal | `herdr-machines <command>` |
| Popup | inside the herdr TUI (a herdr plugin) | a key you bind, e.g. `prefix+m` |
| Dialog | inside the Herdr app (an app mod) | `mod.open herdr-machines`, a key or the palette |

Progress and what is left: [TODO.md](TODO.md). Design and the reasons behind it: [docs/PLAN.md](docs/PLAN.md).

## Requirements

- macOS or Linux
- Node 22.18 or newer on your PATH (with fnm, Node 26 from this repo's `.node-version` is used when the node on PATH is older)
- OpenSSH's `ssh`
- `herdr` (the TUI) and `hc` (herdr-core, which comes with the Herdr app)

Install stops and lists what is missing when any of these isn't found.

## Install

```sh
herdr plugin install maumercado/herdr-remotes-management
```

That one command:

1. checks the requirements above (`herdr-machines check`), and fails if any is missing
2. registers the herdr TUI popup
3. copies the Herdr app dialog into `~/.config/herdr-app/mods/herdr-machines` (skipped when the app has no config folder yet, or with `HERDR_MACHINES_SKIP_APP_MOD=1`; a folder of that name you made yourself is left alone)

`herdr plugin install` shows the commands it will run before it runs them. `herdr plugin update` updates both front ends.

Then bind the popup to a key in herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "herdr-machines.open"
description = "manage machines"
```

`prefix+m` is free in herdr's defaults (0.9.5). In the Herdr app, open the dialog from the palette with `mod.open herdr-machines`, or bind a key in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "cmd-shift-m": "mod.open:herdr-machines" } }
```

### The CLI in your shell (optional)

The popup and the dialog run the CLI from herdr's plugin folder. To use it from a terminal too, add this to your `.zshrc` or `.bashrc`:

```sh
herdr-machines() {
  local root
  root=$(herdr plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=(JSON.parse(s).result?.plugins??[]).find(p=>p.plugin_id==="herdr-machines");if(p)console.log(p.plugin_root)})')
  [ -n "$root" ] || { echo "herdr-machines: plugin not installed" >&2; return 1; }
  sh "$root/bin/run" "$@"
}
```

It looks the folder up each time, so it keeps working after `herdr plugin update`.

### Uninstall

```sh
herdr plugin uninstall herdr-machines
rm -rf ~/.config/herdr-app/mods/herdr-machines
```

Machines you added stay in `~/.ssh/config.d/herdr-machines`, herdr and the app. To remove the SSH side too, delete that file and the two lines this tool added at the top of `~/.ssh/config`.

### Working on it

```sh
git clone https://github.com/maumercado/herdr-remotes-management.git ~/code/herdr-remotes-management
herdr plugin link ~/code/herdr-remotes-management
ln -s ~/code/herdr-remotes-management/app-mod ~/.config/herdr-app/mods/herdr-machines
```

`plugin link` doesn't run the build steps, so run `bin/herdr-machines check` yourself. The dialog finds the CLI through `herdr plugin list`, which points at the linked checkout.

## Using it

```sh
herdr-machines list                       # machines and their state in each place
herdr-machines list --all --health        # plus hosts you could adopt, with live herdr checks
herdr-machines add box1 --host 10.0.0.5   # user, port and key fall back to SSH's defaults
herdr-machines add box2 --host 10.0.0.6 --same-as-last
herdr-machines adopt work-vm              # a Host you already have in ~/.ssh/config
herdr-machines edit box1 --port 2222      # --user "" removes an option
herdr-machines rename box1 --label "Build box"
herdr-machines rename box1 --hc-name build
herdr-machines rename box1 --alias build-box
herdr-machines delete box1 --ssh=keep     # or --ssh=delete
herdr-machines login box1                 # herdr reconnect and hc login, in your terminal
herdr-machines doctor                     # find and fix drift between the three places
```

Every change prints a step report:

```
ssh ✓  tui ✓  app ✕ (needs_login)
```

When a step fails you can retry it, undo the steps already done, or leave it for `doctor` (`--on-fail=ask|undo|leave`).

Glyphs, in the CLI table, the popup and the dialog:

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

### Popup keys

`a` add, `A` adopt, `e` edit, `r` rename, `d` delete, `l` log in, `s` doctor, `/` filter, `R` refresh, `q` close. In the add form, `Ctrl-L` fills user, port, key and jump host as last time.

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
- A lock file stops the popup and the dialog from writing at the same time.
- Key files are never read, copied or created. Only the `IdentityFile` path is stored.

## Show machine state in your own app mod

Mods can't import each other, so copy `app-mod/glyphs.js` next to your mod's `main.js`:

```js
import { appMachineStates, machineGlyph, openMachines } from "./glyphs.js";

// init: refresh every 10 seconds
cx.timer.every(10000, (cx) => cx.spawn(async (cx) => { this.states = await appMachineStates(); cx.notify(); }));

// render: a glyph next to a machine name, and a button that opens the dialog
const g = machineGlyph(this.states?.[name]);
div().text_color(theme()[g.color]).child(g.glyph);
div().id("machines").on_click(() => openMachines()).child("Machines");
```

## Reference

Global options: `--json` (machine readable output, never asks), `--yes` / `-y` (answer yes), `--on-fail=ask|undo|leave`.

Exit codes: `0` done, `1` a step failed, `2` bad input, `3` a question came up with nobody to answer it.

| Environment variable | Effect |
|---|---|
| `HERDR_MACHINES_HERDR`, `HERDR_MACHINES_HC`, `HERDR_MACHINES_SSH` | use these binaries |
| `HERDR_MACHINES_NODE` | node for `bin/run` (default: `node` on PATH) |
| `HERDR_MACHINES_SKIP_APP_MOD=1` | `herdr plugin install` leaves the app mod out |
| `HERDR_MACHINES_ALLOW_REPO=1` | allow the managed file inside a git repo |
| `XDG_STATE_HOME` | where the state folder lives (default `~/.local/state`) |

## Troubleshooting

- **The TUI or APP column is empty.** `herdr` or `hc` wasn't found or failed; `list` prints why, and `herdr-machines check` shows what is on your PATH.
- **"needs a terminal" (exit 3).** Run the same command in a terminal, or answer with the flag it names.
- **The dialog says the plugin isn't installed.** It looks for `herdr-machines` in `herdr plugin list`; run `herdr plugin install maumercado/herdr-remotes-management`.
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
| `app-mod/` | the Herdr app mod (JavaScript, gpui-kit) |
| `herdr-plugin.toml` | the herdr plugin manifest (build steps, popup, action) |
| `bin/` | `run` (finds node), `herdr-machines` (the command), `install-app-mod` (build step) |
| `test/` | tests, with fake `herdr`, `hc` and `ssh` in `test/fakes/` |
| `docs/PLAN.md` | the design |
| `TODO.md` | the checklist |

## License

Not chosen yet.
