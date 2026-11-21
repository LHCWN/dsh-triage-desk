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
  printf 'Open a remote shell? [y/N] '
  IFS= read -r answer || exit 0
  case "$answer" in y|Y) ;; *) exit 0 ;; esac
  printf 'Opening a remote shell on %s in %s. Your draft is still in the panel.\n' "$server" "$(pwd -P)"
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
  printf 'Could not find %s in the launch environment on %s.\n' "$agent" "$server"
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
    printf 'Enter an agent name, or press Enter for shell options: '
    IFS= read -r agent || exit 0
    [ -n "$agent" ] || open_shell
    # Only a complete, listed executable name is a choice.
    for candidate in $available; do
      [ "$agent" != "$candidate" ] || break 2
    done
  done
fi
# Re-select the shell mode if the user chose a shortcut from the alternatives.
agent_available "$agent" || exit 1
printf 'SSH %s · %s · %s\n' "$server" "$agent" "$(pwd -P)"
