# TODO

The plan as a checklist. Full reasoning lives in [docs/PLAN.md](docs/PLAN.md).

Rules:

- Every change updates this file in the same commit.
- Each functional step is its own commit, pushed right after.
- The project is done when every box below is checked.

## 0. Groundwork

- [x] Review the plan and fold the review into it (17 points, see the end of docs/PLAN.md)
- [x] Generic naming: `herdr-machines` everywhere, nothing personal in names, ids, paths or config
- [x] Read herdr's connection reuse in source (`%C` in the socket name, so endpoint edits apply)
- [x] Read hc's connection reuse in source (keyed on the alias only, so `edit` refreshes hc's login)
- [x] Read hc's name rules and herdr's label rules in source
- [x] Read the herdr plugin manifest docs (id rules, popup panes, key bindings)
- [x] Decide type checking: `npm run typecheck` through `npx`, no dependency
- [x] Node through fnm: `.node-version` pins 26; `bin/run` uses `node` on PATH when it is 22.18+, else `fnm exec`
- [x] Repo scaffold: `package.json`, `.gitignore`, `.node-version`, `bin/herdr-machines`, `bin/run`, this file, docs/PLAN.md, README draft
- [x] GitHub repo `herdr-remotes-management` (public) created and every commit pushed

## 1. Core CLI

- [x] Paths and environment: state folder (`$XDG_STATE_HOME/herdr-machines`), binaries from PATH (`HERDR_MACHINES_*` overrides)
- [x] Safe file writes: real path resolution, write through symlinks, atomic temp file and rename, mode `600`, lock file, backups (keep 10)
- [x] Git repo check: refuse to put the managed file inside a git repo unless `HERDR_MACHINES_ALLOW_REPO=1`
- [x] SSH config parser: literal aliases, multi pattern `Host` lines, negations, `Host=`, any keyword case, quoted values, `Match` and wildcards read only
- [x] Include following: recursive, `~` and relative paths, globs, depth limit
- [x] Managed file editor: add, change, remove and rename host blocks line by line, keeping comments and unknown options
- [x] Include line placement at the top of `~/.ssh/config`, refuse when it would land inside a `Host` or `Match` block
- [x] `ssh -G` check after every write, rolled back from the backup on mismatch
- [x] herdr adapter: `machine list/status/add/rename/remove/reconnect`, status checks in parallel with a time cap
- [x] hc adapter: `machine ls/add/rename/rm/login`
- [x] Merge by target into one row per machine, with duplicates and raw targets flagged
- [x] Step runner: fixed order, step report (`ssh ✓  tui ✓  app ✕ (needs_login)`), retry, undo or leave on failure
- [x] Global flags and exit codes: `--json`, `--yes`, exit `0/1/2/3`
- [x] Alias validation: SSH alias rules plus hc name rules, refuse aliases already defined in your own config
- [x] `list [--json] [--health]`
- [x] `add` with blank defaults and `--same-as-last`
- [x] `adopt` with a cleaned hc name when the alias fails hc's rules
- [x] `edit` with hc login refresh after endpoint changes
- [x] `rename --label`, `rename --hc-name`, `rename --alias` (session kept)
- [x] `delete [--yes] [--ssh=keep|delete]`
- [x] `doctor [--json]` with one fix per row
- [x] `check` (requirements: Node 22.18+, `ssh`, `herdr`; `hc` optional) and `help`
- [x] Fake `herdr`, `hc` and `ssh` for tests
- [x] Unit tests: parser, writer, Include placement, symlinks, repo check, validation, merge, step runner, flags
- [x] Command tests against the fakes
- [x] `npm run typecheck` passes

## 2. TUI popup (herdr plugin)

- [x] `herdr-plugin.toml`: id `herdr-machines`, one popup pane, one action, linux and macos, no hooks
- [x] ANSI screen: list with `SSH  TUI  APP` columns and glyphs, details pane, single pane under 76 columns
- [x] Health fills in after the first render
- [x] Add and edit form (alias, host, user, port, key path, jump host; last time shortcut)
- [x] Keys: `a` `A` `e` `r` `d` `s` `l` `/` `q`, confirm boxes for delete and alias rename
- [x] Interactive steps leave raw mode and the alternate screen, then restore and redraw
- [x] Tests for the pure parts (layout, key handling, form state)
- [x] Smoke run in a pseudo terminal against the fakes (add from the popup, back to the list, quit)
- [x] `login <alias>` command in the CLI for the `l` key (herdr reconnect, hc login)
- [x] README: link the plugin, example key binding

## 3. App mod (moved out of this repo)

- [x] Built and tested here (commit `55b752c`), then moved out: the plugin is TUI only, the app keeps syncing through `hc`
- [x] Put the dialog mod in your dotfiles as Stow package `herdr-app` (`~/.dotfiles/herdr-app/.config/herdr-app/mods/herdr-machines/`)
- [ ] Commit it in the dotfiles, `stow herdr-app`, and check it with `herdr-app check` (run by you)
- [x] `mau-spaces` (personal mod, outside this repo): each machine header's server icon is larger and coloured by state (green connected, yellow connecting, red needs login or update or unreachable, grey asleep) and a `⋯` button on This computer that opens the dialog
- [x] TUI sidebar: checked herdr's source; its machine headers already show connection state (`●` online, `◐` connecting, `!` attention, `·` disabled), so nothing is added there

## 4. Docs and release

- [x] One command install: `herdr plugin install maumercado/herdr-remotes-management` (build step `check` fails the install when a requirement is missing)
- [x] Remove `setup` and saved binary paths
- [x] TUI only: app front end removed, `hc` optional in `check`
- [x] Popup first: no shell command to install; the CLI is documented for scripting (plugin folder from `herdr plugin list`)

- [x] README: what it does, install, commands, safety notes, how matching works, troubleshooting
- [ ] GitHub topic `herdr-plugin` so it shows in the plugin index (run by you: `gh repo edit maumercado/herdr-remotes-management --add-topic herdr-plugin`; this session can't change repo settings)
- [ ] Pick a license (yours to choose)

## 5. Real runs (on your computer)

- [ ] `herdr plugin install maumercado/herdr-remotes-management` on your computer
- [x] `ls -la ~/.ssh`: real folder, `config` is a Stow link (handled: writes go through the link, managed file stays outside the repo)
- [ ] Bind the action, open the popup inside herdr
- [ ] Throwaway VM (OrbStack, Lima or UTM): add, edit port then reconnect, rename label, rename hc name, rename alias, delete
- [ ] Adopt one existing host
- [ ] One real machine end to end
- [ ] Write any gotchas into docs/PLAN.md
