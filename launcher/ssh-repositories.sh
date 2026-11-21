# POSIX sh, shared by Settings discovery and the interactive launcher.
# git remote get-url reads the fetch URL (including insteadOf expansion) from
# the checkout, including a linked worktree's common config. It does no fetch.
list_remotes() {
  # Git can walk upwards past an invalid .git directory. Only a worktree
  # root can supply an identity for this exact path.
  prefix=$(git -C "$1" rev-parse --show-prefix 2>/dev/null) || return 0
  [ -z "$prefix" ] || return 0
  git -C "$1" remote 2>/dev/null | while IFS= read -r name; do
    url=$(git -C "$1" remote get-url -- "$name" 2>/dev/null) || continue
    case "$url" in *[[:cntrl:]]*) continue ;; esac
    printf '%s\n' "$url" | LC_ALL=C awk '
      { url = tolower($0)
        if (!sub(/^(https?|git|ssh|git\+ssh):\/\/([^\/@]+@)?((www\.|ssh\.)?github\.com)(:[0-9]+)?\//, "", url) &&
            !sub(/^([^\/@:]+@)?(ssh\.)?github\.com:/, "", url)) next
        sub(/\/$/, "", url)
        sub(/\.git$/, "", url)
        if (url ~ /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/) print url
      }'
  done | sort -u | while IFS= read -r slug; do
    printf '%s\t%s\n' "$slug" "$1"
  done
}

visit_directory() {
  [ -d "$1" ] && [ -x "$1" ] || return 0
  case "$1" in *[[:cntrl:]]*) return 0 ;; esac
  visited=$((visited + 1))
  if [ -d "$1/.git" ] || [ -f "$1/.git" ]; then
    list_remotes "$1"
  fi
  if [ "$2" -lt 3 ]; then
    for child in "${1%/}"/*; do
      [ "$visited" -lt 1500 ] || break
      [ -d "$child" ] && [ ! -L "$child" ] || continue
      case "$child" in */node_modules|*/vendor) continue ;; esac
      visit_directory "$child" "$(($2 + 1))"
    done
  fi
}

scan_repositories() (
  # A login profile can export a Git directory. Read each checkout's own
  # metadata without changing the environment passed to the agent.
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR
  for root do
    canonical=$(cd -P "$root" 2>/dev/null && pwd -P) || continue
    visited=0
    visit_directory "$canonical" 0
  done
)
