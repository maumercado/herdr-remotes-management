# Plan: herdr-machines (one place to manage machines for the herdr TUI and the Herdr app)

Status: plan agreed, revised after review, no code yet. Written 2026-11-07, revised twice on 2026-11-07 (see "Review changes" at the end).

## Goal

Add, edit, rename and delete SSH machines once, and have the change land in all three places at the same time:

1. `~/.ssh/config` (through a managed include file)
2. the herdr TUI's saved machines (`herdr machine ...`)
3. the Herdr app's machines (`hc machine ...`, herdr-core)

The TUI and the app keep separate machine lists (different programs, different stores), so today a machine added in one is invisible to the other.

## Decisions already made

- Language: TypeScript, run directly by Node (native type stripping: Node 22.18 or newer, 26 recommended; no build step, no runtime npm dependencies). Only erasable TS syntax: no enums, namespaces or parameter properties.
- Install is one command, `herdr plugin install maumercado/herdr-remotes-management`. Requirements are Node 22.18 or newer, OpenSSH's `ssh` and `herdr`, all found on PATH; `hc` is optional (with it, every change also reaches the Herdr app). The plugin's only build step runs `herdr-machines check`, which fails the install and lists what is missing. No paths are saved anywhere: herdr starts plugin commands with your environment.
- Node version: `bin/run` uses `HERDR_MACHINES_NODE`, else `node` on PATH when it is 22.18 or newer, else `fnm exec` with the repo's `.node-version` (26).
- Source lives in `~/code/herdr-remotes-management` (GitHub: `herdr-remotes-management`, public). The herdr plugin is linked from there with `herdr plugin link`.
- Generic by design: nothing personal in file names, ids, paths, config or defaults, so anyone can install it. The tool, CLI, plugin, app mod and state folder are all named `herdr-machines`. Personal wiring (a key binding, your own spaces mod) lives in your own config, not in this repo; the README shows examples.
- SSH: machines this tool creates live in their own file, `~/.ssh/config.d/herdr-machines`, pulled in by one `Include` line at the very top of `~/.ssh/config`. Backup before every write, file mode `600`. Writes go through symlinks (dotfiles managed with Stow, chezmoi in symlink mode, yadm and similar) and never replace a symlink with a plain file.
- State folder: `$XDG_STATE_HOME/herdr-machines/` (default `~/.local/state/herdr-machines/`) holds the "same as last time" values, backups and the lock file. Fixed path, so the TUI plugin and the app find the same files (`HERDR_PLUGIN_STATE_DIR` is only set when herdr runs the plugin).
- Hosts already in `~/.ssh/config` (or any file it includes) stay where they are. `adopt` only registers them with herdr and hc; the tool shows them but never edits or deletes their SSH entries (change those by hand).
- Delete: removing a machine always asks, every time, whether to delete its SSH entry too (managed machines only). Non-interactive callers answer with `--ssh=keep|delete`.
- New machine form: user, port and key start blank, so SSH uses its own defaults (your local username, your default keys). A "same as last time" shortcut fills them from the previous add (kept in the state folder).
- Machine health can also show in other app mods: the `herdr-machines` mod exports its state glyph and an "open dialog" action, so a spaces panel (your own `mau-spaces`, for example) can put a glyph and a button on its machine headers. That wiring is optional and lives in the other mod, not in this repo.
- The SSH alias is the target on both sides: herdr and hc always use the alias as their target (never a raw `user@host`). Rows are matched by `target`, never by herdr label or hc name. Label and name start equal to the alias and may be changed later without breaking anything.
- Every question the CLI asks has a flag that answers it, so the app can ask in its own dialog and run the CLI without prompts.
- Only documented CLI commands. No herdr internal files, no sidebar tricks (lesson from the sprites experiment).

## What the CLIs support (read from source: herdrdev/herdr and herdrdev/herdr-core)

| Action | `herdr machine` (TUI) | `hc machine` (app) |
|---|---|---|
| List | `list --json` gives `id, label, target, session, enabled, selected` (no health) | `ls --json` gives `{machines: [{name, target, via, temporary, session, id, host, version, state, since_ms, why}]}` |
| Add | `add <target> [--label L] [--remote-session S]`; may ask to install herdr on the remote and to pick a session, so it needs a terminal | `add <target> [--name N] [--session S] [--install] [--via CMD]`; may ask to copy hc there |
| Rename | `rename <profile-id> --label L` (display label only, no reconnect) | `rename <name> <new_name>`; this is an address change, not a display label: addresses with the old name (`old/t7`) stop working |
| Delete | `remove <profile-id>` (remote sessions keep running) | `rm <name>` (its terminals keep running there) |
| Change target or session | not supported: remove, then add | not supported: remove, then add |
| Reconnect / log in | `reconnect <label-or-id>` (terminal only, never installs or updates) | `login <name>` (terminal only) |
| Health | `status [<label-or-id>] [--json]`, live check, never prompts, each unreachable host costs a timeout | `state` in `ls --json`: connecting, connected, needs_login, needs_update, unreachable |
| Enable / disable | `enable` / `disable <profile-id>` | none |
| Update remote server | part of `add`, or `herdr --remote <target>` run outside herdr | `update <name>` |

## Why the alias design pays off

Neither CLI can change a machine's target. Both point at the SSH alias, so editing host, user, port, key or jump host only rewrites the SSH entry, and herdr and hc pick it up on their next connection: edits never need remove and add.

One condition: herdr's connection reuse (below) must not keep talking to the old endpoint. That is verified in build step 0 and tested.

## Connection reuse (checked in source, build step 0)

Both herdr and hc keep an OpenSSH master connection alive for 10 idle minutes (`ControlPersist 600`). They key it differently:

- herdr (`src/platform/unix_common.rs`, `shared_ssh_control_path`): the socket name is a hash of herdr's config path and the target, followed by OpenSSH's `%C` (resolved host, port, user and jump host). An edit to HostName, Port, User or ProxyJump therefore makes herdr open a new connection on its next attempt. Nothing to do. herdr also runs ssh with its own temporary `-F` config that `Include`s `~/.ssh/config` first, so the managed Include is honoured.
- hc (`crates/herdr-core/src/machines.rs`, `control_path`): the socket name is a hash of the target string only (the alias). After an endpoint edit, hc keeps reaching the old endpoint until that master closes. The only documented way to close it is `hc machine rm`, which runs `ssh -O exit`. So `edit` refreshes hc after an endpoint change: `hc machine rm <name>`, then `hc machine add <alias> --name <name> [--session S]` (same name and session, so addresses keep working; terminals keep running there). A key-only edit needs no refresh.

## Name rules (checked in source, build step 0)

- hc (`crates/herdr-core/src/addr.rs`, `check_name`): 1 to 32 characters of `a-z 0-9 - _ .`, starting with a letter or digit, and not shaped like a terminal id (`t` followed by a digit 1 to 9 and more id characters, e.g. `t7`). Session names follow the same rule. Targets may not start with `-` or contain whitespace.
- herdr (`src/client/endpoint/catalog.rs`): labels up to 128 bytes. Only default labels are checked for clashes; explicit labels can repeat. Two profiles can share a target, so `doctor` reports duplicates.
- `add` therefore requires the alias to pass the hc rule. `adopt` accepts any literal alias and, when the alias fails the hc rule, picks a cleaned hc name (matching is by target, so the name is free).
- `herdr machine status --json` returns `[{id, label, status, error}]` with status `reachable`, `auth required`, `error` or `disabled`, checks profiles one after another, and exits 1 when any row has an error. The CLI runs one `status <id>` per machine in parallel instead.

## Pieces

### 1. Core CLI: `herdr-machines` (TypeScript)

Location: `~/code/herdr-remotes-management`. Entry: `node src/main.ts <command>`, or the `bin/herdr-machines` shim.

Global flags: `--json` (machine readable output, never prompts), `--yes` (accept confirmations). Exit codes: `0` all steps ok, `1` a step failed (the report says which), `2` bad input, `3` a prompt was needed but no terminal or flag answered it.

| Command | Steps |
|---|---|
| `list [--json] [--health]` | Read managed SSH entries plus other literal `Host` aliases from `~/.ssh/config` and every file it includes (read only), `herdr machine list --json`, `hc machine ls --json`. Merge by `target` into one row per machine with presence per side, and whether its SSH entry is managed or yours. `--health` adds `herdr machine status --json` (live, capped at a few seconds overall); front ends show the list first and fill health in after. |
| `add <alias> --host H [--user U] [--port P] [--key PATH] [--jump J]` | 0. validate: the alias is a valid SSH alias and a valid hc name (no `/`, no spaces; check hc's name rules in source), and it is not already a `Host` in your own config or any included file (if it is, stop and point to `adopt`, otherwise the managed entry would win without telling you); 1. write SSH entry in the managed file; 2. check `ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> true`; if it fails, run `ssh <alias> true` once in the foreground so you accept the host key and type any password a single time (no stderr parsing). For a passphrase key, show an `ssh-add` hint, since herdr's background connections can't ask; 3. `herdr machine add <alias> --label <alias>`; 4. `hc machine add <alias> --name <alias>`. |
| `adopt <alias>` | For a host already in your own `~/.ssh/config` or an included file: the validation from step 0 (hc name rules only), then steps 3 and 4 of add. The SSH entry stays where it is and is never written. |
| `edit <alias> [--host --user --port --key --jump]` | Managed machines only (adopted hosts are edited by hand). Rewrite the managed entry, refresh hc's login when the endpoint changed (see "Connection reuse"), then offer reconnect: `herdr machine reconnect <alias>` and `hc machine login <alias>` if hc reports `needs_login`. |
| `rename <alias> --label <new>` | herdr display label only: `herdr machine rename <id> --label <new>`. No reconnect, nothing else changes. |
| `rename <alias> --hc-name <new>` | hc address rename: `hc machine rename <name> <new>`. Warns first that hc addresses with the old name stop working. Target stays the alias, so matching is unaffected. |
| `rename <alias> --alias <new>` | Managed machines only. Validate the new alias (add step 0). Rename the SSH entry, then remove and add on both sides, keeping the session: `--remote-session <old session>` for herdr and `--session <old session>` for hc (confirm first, it re-runs setup). The herdr profile id changes, so front ends re-read the list afterwards. |
| `delete <alias> [--yes] [--ssh=keep\|delete]` | Confirm (or `--yes`). `herdr machine remove <id>`, `hc machine rm <name>`. Then, for managed machines, ask: also delete the SSH entry? (always asked unless `--ssh` is given). Adopted hosts keep their entry. |
| `doctor` | Show drift and offer one fix per row. Drift is: missing on one side (in SSH only, in TUI only, in app only), or a target that isn't the alias. Different labels or names are not drift. Re-adds keep the session. When a fix needs `herdr --remote <target>` (non-auth Attention), print the command to run in a terminal outside herdr: inside a herdr pane it is blocked unless `experimental.allow_nested` is on. |

Every command prints a step report, e.g. `ssh ✓  tui ✓  app ✕ (needs_login)`, and `--json` for the app.

### 2. SSH file handling

- Start by resolving real paths of `~/.ssh/config`, `~/.ssh/config.d` and the managed file. If `~/.ssh/config` is a symlink (dotfiles managers), write through it and never replace it. If `~/.ssh/config.d` or the managed file resolves inside a git repo (Stow, for one, can fold a whole folder into a symlink), stop and ask before writing: the managed file would land in a dotfiles repo, which may be public.
- `~/.ssh/config.d/herdr-machines`, mode `600`, header comment saying the tool owns it.
- One line added at the top of `~/.ssh/config`: `Include ~/.ssh/config.d/herdr-machines`. It must be above any `Host` block, otherwise OpenSSH scopes it to that block. The tool checks this and refuses to continue if it can't place it safely. This line is the only change the tool ever makes to `~/.ssh/config`. If that file is in a dotfiles repo, the Include line gets committed with it; OpenSSH should skip a missing Include file on other computers (check with `ssh -G` on one).
- Backups go to `<state folder>/backups/<file>-<timestamp>` before any write, keep the last 10. Not inside `~/.ssh/config.d`, where an `Include ~/.ssh/config.d/*` (a common pattern) would match them.
- Writes are atomic: temp file next to the real (resolved) target, mode `600`, then rename. A lock file in the state folder wraps each read, change and write, so the TUI popup and the app dialog can't write at the same time.
- Parser: follows `Include` lines recursively (read only), so hosts from other included files (OrbStack, 1Password, Colima) show up for adopt. Handles several patterns on one `Host` line, negations (`!pattern`), `Host=foo`, keywords in any case, and quoted values. Only literal `Host` aliases count as machines. Wildcards (`Host *.prod`) and `Match` blocks are shown read only and never written.
- Keys: only the `IdentityFile` path is stored. The tool never reads, copies or creates key files.
- Validation: after writing, `ssh -G <alias>` must resolve to the expected host, user and port, or the write is rolled back from the backup.

### 3. Keeping the three places in step

- Steps run in a fixed order: validate, SSH, then TUI, then app. Validation happens before anything is written, so bad input never leaves a half done machine.
- If a step fails, stop and offer: retry the failed step, undo the steps already done, or leave it (shows up in `doctor`). Nothing is left half done without saying so. Undoing a herdr or hc add removes the saved machine but leaves whatever setup installed or started on the remote running; the report says so.
- Steps that can prompt (password, host key, install on remote, session picker, login) run in the foreground terminal so you answer them yourself. Nothing answers prompts automatically. With `--json` or no terminal, a needed prompt ends the command with exit code `3`.

### 4. TUI front end: herdr plugin `herdr-machines`

- `herdr-plugin.toml`: one `[[panes]]` entry with `placement = "popup"` running `sh bin/run ui`, one `[[actions]]` entry that opens it, two `[[build]]` steps (requirement check, app mod link) and one `[[startup]]` hook (the app mod link again, exits at once). No event hooks, nothing left running in the background.
- Key: the plugin ships no key binding and changes no config. The README shows an example `[[keys.command]]` entry with `type = "plugin_action"` (for instance `prefix+m`, which no default binding uses as of 0.9.5) for people to add to their own `config.toml`.
- Plugin id: check the id format the manifest requires; use `herdr-machines`, or the closest allowed form, with no personal namespace.
- Screen (two panes, like machine-manager): list on the left with one column per place (`SSH  TUI  APP`), each `●` ok, `○` missing, `◐` connecting, `!` needs login, `✕` unreachable, and a mark for managed vs your own SSH entry. Details on the right: host, user, port, key path, herdr profile id, hc state and version, last step report. Health fills in after the first render.
- Add form fields: alias, host, user, port, key path, jump host. Only alias and host are required; the rest start blank, with a key to fill them as last time.
- Keys: `a` add (form), `A` adopt an existing host, `e` edit, `r` rename, `d` delete, `s` sync (doctor), `l` log in / reconnect, `/` filter, `q` close. Confirm boxes for delete and alias rename.
- Interactive steps: leave the alternate screen and raw mode before starting a child process with `stdio: "inherit"`, restore both when it exits, then redraw.
- Drawn by hand with ANSI (no dependencies), sized for narrow popups (single pane under 76 columns).

### 5. App front end (moved out, 2026-11-07)

The plugin is for the herdr TUI only. The Herdr app keeps getting every change through `hc` when it is installed, but there is no app front end here: the app already ships its own machine dialog, and installing a mod from a herdr plugin needed link scripts and a startup hook. The dialog mod that was built for this (commit `55b752c`, `app-mod/`) lives on as a personal mod in your dotfiles: Stow package `herdr-app` (`~/.dotfiles/herdr-app/.config/herdr-app/mods/herdr-machines/`). It finds the CLI through `herdr plugin list --json` (`plugin_root`), so it keeps working with the installed plugin.

## Testing

- Unit tests with `node --test`: SSH parser and writer (round trip, comments kept, Include placement, Include following, multi pattern and negated `Host` lines, wildcard blocks untouched, your own entries never written), symlink write-through (a symlinked config stays a symlink), the git repo check, alias validation and collision refusal, merge by target, step runner with undo, exit codes and flags (`--json` never prompts).
- Fake `herdr` and `hc` scripts on PATH that record calls and return canned JSON, to test every command without touching real machines.
- On your own computer: not `localhost`. Its herdr session picker would find your own local sessions, and hc's install prompt could copy hc over the binary you are running. Use a throwaway Linux VM (OrbStack, Lima, UTM; OrbStack hosts also come from an included SSH file, which tests Include following and adopt) or an sshd container. Then one real machine: add, edit port (then reconnect and confirm it reaches the new port), rename label, rename hc name, rename alias (session kept), delete. Then adopt one existing host.

## Build order

0. Checks before code: herdr's ControlPath and hc's name rules (done, see "Connection reuse" and "Name rules"). `ls -la ~/.ssh ~/.ssh/config.d` on your computer (the tool also checks this at run time).
1. Core CLI with tests (list, add, adopt, edit, rename, delete, doctor).
2. TUI popup and plugin manifest; link with `herdr plugin link`.
3. App mod with its exported glyph helper and action. Then, separately and outside the repo, wire them into your own `mau-spaces`.
4. Real run on the throwaway VM, then one real machine, then write down any gotchas here.

## Risks and unknowns

- `herdr machine add` may open its own session picker when a remote has several sessions; it has to run in the popup's terminal, not captured.
- `hc machine rename` breaks addresses that use the old name (scripts, saved references). The tool warns before running it, and keeps it separate from the herdr label rename.
- hc's first add may ask to copy hc to the remote; same handling as herdr's install prompt.
- hc's reused connection would hold the old endpoint for up to 10 idle minutes after an edit; `edit` refreshes it (see "Connection reuse").
- `~/.ssh/config` is often a symlink into a dotfiles repo (likely on your computer, which uses Stow); the tool must write through it and keep the managed file out of the repo.
- The app's `exec` gets the login shell's PATH (checked in herdr-app's docs). A PATH set only in `.zshrc` (not `.zprofile`) may still be missing there; `herdr-machines check` from the dialog would show it.
- `herdr machine status --json` is a live check and slow with unreachable hosts.
- I can't read `~/.ssh` from the session bridge (protected folder) or run `herdr` / `hc` there, so the end to end tests are run by you.
- Sharing the glyph helper and "open dialog" action between mods depends on what the mod API allows (check `herdr.d.ts`). If mods can't call each other, the fallback is a registered command id that any mod or the palette can run, and the other mod reads `hc machine ls --json` itself.
- `--via` machines in hc (reached through a command instead of ssh) are out of scope for v1; they show as read only rows.

## Open questions

None. Type checking (answered 2026-11-07): `npm run typecheck` runs `tsc --noEmit` through `npx`, so TypeScript is fetched on demand and never becomes a dependency.

## Review changes (2026-11-07)

- Matching is by `target` only; label rename and hc name rename are separate commands; doctor ignores label differences.
- Symlinked dotfiles: resolve real paths, write through symlinks, stop if the managed file would land in a git repo.
- Backups, lock and last-used values moved to the state folder.
- App `exec`: absolute paths for `node`, `herdr`, `hc`.
- Flags for every prompt (`--yes`, `--ssh=keep|delete`), exit codes, `--json` never prompts.
- Testing on a throwaway VM instead of `localhost`.

Fourth revision: the plugin is for the herdr TUI only and `hc` is optional. The app dialog mod moved out of the repo into your dotfiles; the CLI still syncs the app through `hc`.

Third revision: install is just `herdr plugin install`. The app mod is a link to the plugin's folder, kept right by a build step and a startup hook that exits at once. The `setup` command and its saved paths are gone; requirements are checked by a build step that fails the install, and the app mod is copied by another build step and finds the CLI through `herdr plugin list`.

Second revision: generic naming. Everything is `herdr-machines` (CLI, plugin, app mod, state folder under `$XDG_STATE_HOME`); no key binding or other config is written; the spaces panel glyph became an exported helper that any mod can use, with the `mau-spaces` wiring kept outside the repo.
- Health from `herdr machine status --json`, loaded after the list.
- herdr connection reuse checked before `edit` is built.
- Interactive `ssh <alias> true` once when the BatchMode check fails; `ssh-add` hint for passphrase keys.
- Alias validated for SSH and hc before anything is written; `add` refuses aliases you already define.
- Parser follows Includes and handles more `Host` line forms.
- Alias rename and doctor re-adds keep the session; herdr profile id refresh.
- Lock file and atomic writes for two front ends.
- Popup leaves raw mode and the alternate screen for interactive steps.
- `herdr --remote` fixes are printed to run outside herdr.

## Sources

Where each fact above came from, to look up more when building.

### herdr TUI docs
- Connecting machines (machine add/list/status/reconnect/rename/remove, SSH config notes, connection reuse with `ControlPersist 600`, `herdr --remote` for setup fixes): https://herdr.dev/tui/docs/connecting-machines/
- Config reference (`remote.manage_ssh_config`, `experimental.allow_nested`, default key bindings): https://herdr.dev/tui/docs/config-reference/
- Plugins (manifest format, `[[panes]]` placements incl. `popup`, `[[actions]]`, `[[startup]]`, `[[events]]`, env vars like `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_BIN_PATH`): https://herdr.dev/tui/docs/plugins/
- CLI reference (`herdr plugin link/unlink/action invoke/log list`, `herdr api snapshot`, `herdr api schema --json`): https://herdr.dev/tui/docs/cli-reference/
- Configuration (`[[keys.command]]` with `type = "plugin_action"`, sidebar rows and tokens): https://herdr.dev/tui/docs/configuration/
- Socket API (events such as `pane.agent_status_changed`, `pane.report_metadata`): https://herdr.dev/tui/docs/socket-api/
- Plugin marketplace and install from GitHub: https://herdr.dev/tui/docs/marketplace/ and the plugin index https://herdr.dev/tui/plugins/ (built from the GitHub topic `herdr-plugin`)
- Agent guide and docs index for AI tools: https://herdr.dev/agent-guide.md and https://herdr.dev/llms.txt
- Built in help: `herdr machine --help`, `herdr <command> --help`, `herdr --skill`

### Herdr app and herdr-core (hc)
- `~/.config/herdr-app/AGENTS.md` (also in this project as `AGENTS.md`): layouts, mods, `exec`, `run`, `terminal.open`, `openOverlay`, `herdr-app check`
- `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts`: the mod API, rewritten on every app start
- Built in help: `hc machine --help`, `hc machine <sub> --help`, `hc --skill`, `herdr-app commands`, `herdr-app --skill`

### Source code read for this plan
- herdr TUI, commit `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` (2026-10-29): https://github.com/herdrdev/herdr
  - `src/cli/machine.rs`: every `herdr machine` subcommand, argument rules, `list --json` row shape (`MachineListRow`), add flow and session picker
  - `src/client/endpoint.rs`: the saved machine catalog behind those commands
  - `src/client/shell/agent_sidebar.rs`: sidebar row rendering (row indents, the reason the sprite experiment was fragile)
  - `src/remote/attach.rs` (`write_managed_ssh_config`, `apply_managed_ssh_options`) and `src/platform/unix_common.rs` (`shared_ssh_control_path`): connection reuse
  - `src/client/endpoint/catalog.rs`: label rules, duplicate targets
- herdr-core (hc), commit `9ce385d9c8abb041dd4437476d770365b3fb5282` (2026-11-07): https://github.com/herdrdev/herdr-core
  - `crates/herdr-core/src/cli/machine.rs`: `hc machine add/ls/login/update/rename/rm`, install prompt handling
  - `crates/herdr-core/src/api/types.rs`: `MachineAddParams`, `MachineParams`, `MachineRenameParams`
  - `crates/herdr-core/src/machines.rs`: `Machine` fields (`name, target, via, temporary, session, id, host, version`)
  - `crates/herdr-core/src/remote.rs`: `MachineView` (`state`, `since_ms`, `why`) and the state values
  - `crates/herdr-core/src/cli/output.rs`: `line_state`, how states read in human output
  - `crates/herdr-core/src/addr.rs` (`check_name`) and `crates/herdr-core/src/terminals.rs` (`id_shaped`): name rules
- Herdr app: https://github.com/herdrdev/herdr-app

### Existing machine plugins reviewed (2026-11-07, all judged safe)
- bearylabs/herdr-ssh-config-dash (same commit `26dadf1` as hrudek/herdr-ssh-config-dash): https://github.com/bearylabs/herdr-ssh-config-dash. Hand drawn ANSI popup in TypeScript with no dependencies; `src/ui/view.ts` is a good reference for the TUI screen, `src/core/runner.ts` for running interactive commands through the login shell safely, `src/core/ssh-config.ts` for parsing literal hosts, `REVIEW.md` for observed herdr CLI behavior.
- vika2603/herdr-machine-manager (v0.3.1, `772da8e`): https://github.com/vika2603/herdr-machine-manager. Two pane popup, state glyph set, prompt detection under a PTY, `internal/sshconfig/` for Include handling, `docs/design.md`; uses https://github.com/vika2603/herdr-client for the herdr socket API.
- fclebio/herdr-ssh-machines: https://github.com/fclebio/herdr-ssh-machines (fzf picker, `bin/parse_ssh_config.py`)
- DailybotHQ/herdr-machine-groups: https://github.com/DailybotHQ/herdr-machine-groups (writes herdr's catalog file directly; an approach this plan avoids)

### Node and OpenSSH
- Node.js TypeScript support (type stripping, erasable syntax only): https://nodejs.org/api/typescript.html
- Node test runner (`node --test`): https://nodejs.org/api/test.html
- Node `child_process` (spawn with `stdio: "inherit"` for interactive steps): https://nodejs.org/api/child_process.html
- `ssh_config(5)` (`Include`, `Host`, `Match`, first value wins, why the Include goes at the top): https://man.openbsd.org/ssh_config
- `ssh(1)` (`-G` to print the resolved config, `-o BatchMode=yes`, `-O exit`): https://man.openbsd.org/ssh

### Related project docs
- `claude/customizations.md`: what's already customized in the app and TUI, and the sprite experiment notes
