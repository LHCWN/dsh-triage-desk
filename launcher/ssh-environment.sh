# Run the same lookup in the settings probe and in the launch directory. A tty
# alone does not load interactive rc files. Bash can configure different paths
# in .bashrc and .bash_profile, so also consult the login environment.
user_shell=${SHELL:-/bin/sh}
# Print the exported PATH in a POSIX child, even when the parent shell is fish.
probe_script="sh -c 'printf \"__td_path__%s\\n\" \"\$PATH\"'"
case "${user_shell##*/}" in
  bash|zsh)
    probe_script="$probe_script
for name in $agent_names; do
  if alias \"\$name\" >/dev/null 2>&1 || typeset -f \"\$name\" >/dev/null 2>&1; then printf '__td_shortcut__%s\\n' \"\$name\"; fi
done" ;;
  fish)
    probe_script="$probe_script
for name in $agent_names
  if functions -q \$name; printf '__td_shortcut__%s\\n' \$name; end
end" ;;
esac
interactive_env=$("$user_shell" -ic "$probe_script" </dev/null 2>/dev/null) || :
login_env=$("$user_shell" -lic "$probe_script" </dev/null 2>/dev/null) || :
for profile in "$login_env" "$interactive_env"; do
  extra=$(printf '%s\n' "$profile" | awk '/^__td_path__/ {sub(/^__td_path__/, ""); value=$0} END {print value}')
  if [ -n "$extra" ]; then PATH="$extra:$PATH"; fi
done
export PATH

agent_executable() {
  program=$(command -v "$1" 2>/dev/null) || return 1
  case "$program" in
    */*) [ -f "$program" ] && [ -x "$program" ] ;;
    *) return 1 ;;
  esac
}

# Names originate in the preset catalog. Shortcuts must run in the same shell
# mode that defined them. Never interpolate the draft into its command string.
agent_available() {
  agent_executable "$1" && return 0
  marker="__td_shortcut__$1"
  case "
$interactive_env
" in *"
$marker
"*) shortcut_mode=-ic; return 0 ;; esac
  case "
$login_env
" in *"
$marker
"*) shortcut_mode=-lic; return 0 ;; esac
  return 1
}
