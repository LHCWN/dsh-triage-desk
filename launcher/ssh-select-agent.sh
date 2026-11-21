# Called in the working directory and PATH in which the agent will run.
agent_available() {
  # dash and bash can report a non-executable PATH entry from command -v.
  # Require a file that the SSH user can launch; functions and aliases do not
  # carry over to the paste wrapper's execvp.
  program=$(command -v "$1" 2>/dev/null) || return 1
  case "$program" in
    */*) [ -f "$program" ] && [ -x "$program" ] ;;
    *) return 1 ;;
  esac
}

python_ready=
draft_available() {
  case " $native_agents " in *" $1 "*) return 0 ;; esac
  [ "$paste_allowed" = yes ] || return 1
  if [ -z "$python_ready" ]; then
    if python3 -I -c 'import pty, fcntl, termios, tty' 2>/dev/null; then python_ready=yes; else python_ready=no; fi
  fi
  [ "$python_ready" = yes ]
}

open_shell() {
  printf 'Opening a remote shell on %s in %s. The scenario is still selected in the panel.\n' "$server" "$(pwd -P)"
  "${SHELL:-/bin/sh}" -i || :
  exit 0
}

if agent_available "$agent"; then
  if ! draft_available "$agent"; then
    if [ "$paste_allowed" = no ]; then
      echo 'Remote paste cannot represent control characters in this prompt.'
    else
      printf '%s needs Python 3 with pty support to open a draft on %s.\n' "$agent" "$server"
    fi
    open_shell
  fi
else
  printf 'Preferred agent %s is missing on %s.\n' "$agent" "$server"
  available=
  for candidate do
    if agent_available "$candidate" && draft_available "$candidate"; then available="$available $candidate"; fi
  done
  if [ -z "$available" ]; then
    echo 'No configured alternative is available.'
    open_shell
  fi
  printf 'Available agents:%s\n' "$available"
  while :; do
    printf 'Enter an agent name, or press Enter for a shell: '
    IFS= read -r agent || open_shell
    [ -n "$agent" ] || open_shell
    # Only a complete, listed executable name is a choice.
    for candidate in $available; do
      [ "$agent" != "$candidate" ] || break 2
    done
  done
fi
printf 'SSH %s · %s · %s\n' "$server" "$agent" "$(pwd -P)"
