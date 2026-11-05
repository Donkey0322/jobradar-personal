# Locate a Node binary for a non-interactive shortcut shell.
# JOBSCAN_NODE wins. Otherwise use node on PATH. The shortcut PATH does not
# include the terminal's nvm directory, so the repo .nvmrc selects the
# installed nvm version when PATH has no node.

jobscan_resolve_node() {
  local start="$1"
  local candidate="" version="" dir="" nvmrc="" nvm_dir=""

  if [[ -n "${JOBSCAN_NODE:-}" ]]; then
    if [[ -x "$JOBSCAN_NODE" && ! -d "$JOBSCAN_NODE" ]]; then
      printf '%s\n' "$JOBSCAN_NODE"
      return 0
    fi
    printf 'JOBSCAN_NODE is not executable: %s\n' "$JOBSCAN_NODE" >&2
    return 1
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  dir="$start"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.nvmrc" ]]; then
      nvmrc="$dir/.nvmrc"
      break
    fi
    dir="${dir:h}"
  done

  if [[ -z "$nvmrc" ]]; then
    printf 'Node was not found on PATH, and no .nvmrc was found from %s\n' "$start" >&2
    return 1
  fi

  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  version="$(tr -d '[:space:]' <"$nvmrc")"
  version="${version#v}"
  if [[ -z "$version" ]]; then
    printf 'Node version in %s is empty\n' "$nvmrc" >&2
    return 1
  fi

  candidate="$nvm_dir/versions/node/v${version}/bin/node"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  printf 'Node was not found on PATH. .nvmrc asks for %s, which is not executable at %s\n' \
    "$version" "$candidate" >&2
  return 1
}
