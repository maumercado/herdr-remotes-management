# herdr-machines

Manage SSH machines once for the [herdr](https://herdr.dev) TUI and the Herdr app.

The herdr TUI (`herdr machine ...`) and the Herdr app (`hc machine ...`) keep separate machine lists, and neither edits `~/.ssh/config`. A machine added in one is invisible to the other. `herdr-machines` adds, edits, renames and deletes a machine in all three places in one step:

1. `~/.ssh/config`, through a managed include file
2. the herdr TUI's saved machines
3. the Herdr app's machines

> Status: in progress. See [TODO.md](TODO.md) for what is done and what is left, and [docs/PLAN.md](docs/PLAN.md) for the design.

## Requirements

- macOS or Linux with OpenSSH
- Node 22.18 or newer (the repo pins 26 in `.node-version` for fnm, nvm and similar)
- `herdr` and/or `hc` on your machine

## Install

```sh
git clone https://github.com/maumercado/herdr-remotes-management.git ~/code/herdr-remotes-management
cd ~/code/herdr-remotes-management
bin/herdr-machines setup
```

More install steps (CLI on PATH, the TUI popup, the app mod) are added as those parts land.
