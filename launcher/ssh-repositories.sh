# POSIX sh, shared by Settings discovery and the interactive launcher.
# Read literal Host aliases without executing SSH configuration.
# OpenSSH ssh_config(5) and ssh -G confirm first-value HostName precedence,
# case-sensitive Host patterns (with * and ?), and negations that veto a block.
# Match blocks and Include files are skipped.
list_github_ssh_aliases() {
  [ -r "$HOME/.ssh/config" ] || return 0
  LC_ALL=C awk '
    function unquote(value) {
      return value ~ /^"[^"]*"$/ ? substr(value, 2, length(value) - 2) : value
    }
    function add_pattern(patterns, pattern,    regexp, i, char) {
      for (i = 1; i <= length(pattern); ++i) {
        char = substr(pattern, i, 1)
        if (char == "*") regexp = regexp ".*"
        else if (char == "?") regexp = regexp "."
        else regexp = regexp (index(".^$+()[]{}|\\", char) ? "\\" : "") char
      }
      return patterns (patterns ? "|" : "") "^" regexp "$"
    }
    BEGIN { block = 0 }
    /^[[:space:]]*(#|$)/ { next }
    {
      sub(/^[[:space:]]+/, "")
      sub(/[[:space:]]+#.*/, "")
      sub(/[[:space:]]+$/, "")
      sub(/[=[:space:]]+/, " ")
      directive = tolower($1)
    }
    directive == "match" { insideMatch = 1 }
    directive == "host" {
      insideMatch = 0
      ++block
      for (i = 2; i <= NF; ++i) {
        pattern = unquote($i)
        if (pattern ~ /^!/) veto[block] = add_pattern(veto[block], substr(pattern, 2))
        else accepts[block] = add_pattern(accepts[block], pattern)
      }
      for (i = 2; i <= NF; ++i) {
        alias = unquote($i)
        if (alias ~ /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/ && (!veto[block] || alias !~ veto[block])) {
          candidates[alias] = 1
        }
      }
    }
    directive == "hostname" && !insideMatch && NF == 2 && !(block in hostnames) {
      hostnames[block] = unquote($2)
    }
    END {
      for (alias in candidates) {
        for (i = 0; i <= block; ++i) {
          if (!(i in hostnames)) continue
          if (i && (!accepts[i] || alias !~ accepts[i] || (veto[i] && alias ~ veto[i]))) continue
          hostname = hostnames[i]
          gsub(/%h/, alias, hostname)
          if (tolower(hostname) ~ /^(ssh\.)?github\.com$/) print alias
          break
        }
      }
    }
  ' "$HOME/.ssh/config"
}

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
    printf '%s\n' "$url" "$aliases" | LC_ALL=C awk '
      NR == 1 {
        url = $0
        scheme = tolower(url)
        hasScheme = scheme ~ /^[a-z][a-z0-9+.-]*:\/\//
        if (hasScheme) {
          if (scheme !~ /^(https?|git|ssh|git\+ssh):\/\//) exit
          viaSsh = scheme ~ /^(ssh|git\+ssh):/
          sub(/^[^:]+:\/\//, "", url)
          sub(/^[^\/@]+@/, "", url)
          separator = index(url, "/")
        } else {
          viaSsh = 1
          sub(/^[^\/@:]+@/, "", url)
          separator = index(url, ":")
        }
        if (!separator) exit
        host = substr(url, 1, separator - 1)
        if (hasScheme) sub(/:[0-9]+$/, "", host)
        slug = tolower(substr(url, separator + 1))
        sub(/\/$/, "", slug)
        sub(/\.git$/, "", slug)
        if (slug !~ /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/) exit
        hostname = tolower(host)
        if (hostname ~ /^(ssh\.)?github\.com$/ || (hasScheme && hostname == "www.github.com")) {
          print slug
          exit
        }
        if (!viaSsh || host == "") exit
        next
      }
      $0 == host { print slug; exit }
    '
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
  aliases=$(list_github_ssh_aliases 2>/dev/null) || aliases=
  for root do
    canonical=$(cd -P "$root" 2>/dev/null && pwd -P) || continue
    visited=0
    visit_directory "$canonical" 0
  done
)
