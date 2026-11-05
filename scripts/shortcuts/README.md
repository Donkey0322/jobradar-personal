# Job Scan shortcut

`scripts/shortcuts/jobscan.zsh` is the macOS shortcut script. The shortcut keeps calling `~/.local/bin/jobscan`. That path should be a symlink to this file.

One full run dispatches public Jobs and personal Jobs. The batch stage only passes `GO` and does not start a workflow. The GitHub token comes from Keychain item `JobScan-GitHub` for the current user. `JOBSCAN_TOKEN` overrides it for tests.

## Shortcut stages

Use five Run Shell Script actions. Set the shell to `zsh` and pass input as arguments. Each action's stdout is the next action's input.

```bash
~/.local/bin/jobscan start
~/.local/bin/jobscan discovery "$@"
~/.local/bin/jobscan batch "$@"
~/.local/bin/jobscan personal "$@"
~/.local/bin/jobscan personal_wait "$@"
```

`start` prints the public run id. `discovery` prints `success` after that whole Jobs run, including its batch. `batch` prints `GO`. `personal` prints the personal run id. `personal_wait` prints `Job Scan completed successfully!`

## Self-test

From the repository root. This uses the fake GitHub API, fake notification, and fake Keychain under `scripts/shortcuts/test/`.

```bash
zsh scripts/shortcuts/test/selftest.zsh
```

The shortcut shell does not receive the terminal's nvm PATH. The script uses `JOBSCAN_NODE` when that path is executable, then `node` on its own PATH, then the version named by this repo's `.nvmrc` under `${NVM_DIR:-$HOME/.nvm}`. It exits with that reason when none of those is usable.

## Install and restore

Run from the repository root. Create the backup only when it is absent, so a later install does not replace the original entry. `cp -P` keeps a symlink as a symlink instead of copying the repo script through it.

```bash
chmod +x scripts/shortcuts/jobscan.zsh
backup="$HOME/.local/bin/jobscan.bak-20261105-pre-symlink"
if [[ -e "$backup" || -L "$backup" ]]; then
  printf 'Backup already exists, leaving it in place: %s\n' "$backup"
else
  cp -pP "$HOME/.local/bin/jobscan" "$backup"
fi
ln -sfn "$PWD/scripts/shortcuts/jobscan.zsh" "$HOME/.local/bin/jobscan"
```

Restore the previous entry by removing the symlink first. Copying onto `~/.local/bin/jobscan` while it still points at the repo overwrites `scripts/shortcuts/jobscan.zsh`.

```bash
rm "$HOME/.local/bin/jobscan"
cp -p "$HOME/.local/bin/jobscan.bak-20261105-pre-symlink" "$HOME/.local/bin/jobscan"
```

If this repository moves, point the same shortcut path at the new file:

```bash
ln -sfn /new/path/jobradar-personal/scripts/shortcuts/jobscan.zsh ~/.local/bin/jobscan
```
