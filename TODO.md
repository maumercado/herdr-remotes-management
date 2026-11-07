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
- [x] Node through fnm: `.node-version` pins 26; `bin/run` finds a stable node (saved real path, then `fnm exec`, then PATH)
- [x] Repo scaffold: `package.json`, `.gitignore`, `.node-version`, `bin/herdr-machines`, `bin/run`, this file, docs/PLAN.md, README draft
- [ ] GitHub repo `herdr-remotes-management` (public) created and every commit pushed

## 1. Core CLI

- [ ] Paths and environment: state folder (`$XDG_STATE_HOME/herdr-machines`), binary resolution (`setup` command saves absolute paths)
- [ ] Safe file writes: real path resolution, write through symlinks, atomic temp file and rename, mode `600`, lock file, backups (keep 10)
- [ ] Git repo check: refuse to put the managed file inside a git repo unless `--allow-repo`
- [ ] SSH config parser: literal aliases, multi pattern `Host` lines, negations, `Host=`, any keyword case, quoted values, `Match` and wildcards read only
- [ ] Include following: recursive, `~` and relative paths, globs, depth limit
- [ ] Managed file editor: add, change, remove and rename host blocks line by line, keeping comments and unknown options
- [ ] Include line placement at the top of `~/.ssh/config`, refuse when it would land inside a `Host` or `Match` block
- [ ] `ssh -G` check after every write, rolled back from the backup on mismatch
- [ ] herdr adapter: `machine list/status/add/rename/remove/reconnect`, status checks in parallel with a time cap
- [ ] hc adapter: `machine ls/add/rename/rm/login`
- [ ] Merge by target into one row per machine, with duplicates and raw targets flagged
- [ ] Step runner: fixed order, step report (`ssh ✓  tui ✓  app ✕ (needs_login)`), retry, undo or leave on failure
- [ ] Global flags and exit codes: `--json`, `--yes`, exit `0/1/2/3`
- [ ] Alias validation: SSH alias rules plus hc name rules, refuse aliases already defined in your own config
- [ ] `list [--json] [--health]`
- [ ] `add` with blank defaults and `--same-as-last`
- [ ] `adopt` with a cleaned hc name when the alias fails hc's rules
- [ ] `edit` with hc login refresh after endpoint changes
- [ ] `rename --label`, `rename --hc-name`, `rename --alias` (session kept)
- [ ] `delete [--yes] [--ssh=keep|delete]`
- [ ] `doctor [--json]` with one fix per row
- [ ] `setup` (resolve and save `herdr`, `hc`, `ssh`, `node` paths) and `help`
- [ ] Fake `herdr`, `hc` and `ssh` for tests
- [ ] Unit tests: parser, writer, Include placement, symlinks, repo check, validation, merge, step runner, flags
- [ ] Command tests against the fakes

## 2. TUI popup (herdr plugin)

- [ ] `herdr-plugin.toml`: id `herdr-machines`, one popup pane, one action, linux and macos, no hooks
- [ ] ANSI screen: list with `SSH  TUI  APP` columns and glyphs, details pane, single pane under 76 columns
- [ ] Health fills in after the first render
- [ ] Add and edit form (alias, host, user, port, key path, jump host; last time shortcut)
- [ ] Keys: `a` `A` `e` `r` `d` `s` `l` `/` `q`, confirm boxes for delete and alias rename
- [ ] Interactive steps leave raw mode and the alternate screen, then restore and redraw
- [ ] Tests for the pure parts (layout, key handling, form state)
- [ ] README: link the plugin, example key binding

## 3. App mod (Herdr app)

- [ ] Read the mod API (`AGENTS.md`, `herdr.d.ts`) and record what it allows
- [ ] Dialog: list with columns and details in theme colors, opened from the palette
- [ ] Prompting actions open a terminal running the CLI; others run through `exec` with flags and refresh
- [ ] Start the CLI through `bin/run` (stable node, works with fnm)
- [ ] Export the state glyph helper and an "open dialog" action for other mods (or the fallback command id)
- [ ] README: install the mod, wire it into your own spaces panel (example)
- [ ] `herdr-app check` passes (run by you if it can't run here)

## 4. Docs and release

- [ ] README: what it does, install, commands, safety notes, how matching works, troubleshooting
- [ ] GitHub topic `herdr-plugin` so it shows in the plugin index
- [ ] Pick a license (yours to choose)

## 5. Real runs (on your computer)

- [ ] `ls -la ~/.ssh ~/.ssh/config.d` and run `herdr-machines list`
- [ ] Throwaway VM (OrbStack, Lima or UTM): add, edit port then reconnect, rename label, rename hc name, rename alias, delete
- [ ] Adopt one existing host
- [ ] One real machine end to end
- [ ] Write any gotchas into docs/PLAN.md
