# Positional arguments are the selected server's repository folders in order.
fallback=
chosen=
for root do
  fallback=$(enter_folder "$root" 2>/dev/null && pwd -P) && break
done

if [ -z "$repo" ]; then
  echo 'This review spans repositories.'
else
  matches=$(scan_repositories "$@" | awk -F '\t' -v wanted="$repo" '$1 == wanted && !seen[$2]++ {print $2}')
  # Split only at newlines. The scan omits control characters in paths.
  IFS='
'
  set -f
  set -- $matches
  set +f
  unset IFS
  if [ "$#" -eq 1 ]; then
    chosen=$1
  elif [ "$#" -gt 1 ]; then
    remembered=
    if [ -r "$choice_file" ]; then IFS= read -r remembered < "$choice_file" || :; fi
    for folder do
      if [ "$folder" = "$remembered" ]; then chosen=$folder; break; fi
    done
    if [ -z "$chosen" ]; then
      printf 'Working copies of %s:\n' "$repo"
      i=0
      for folder do
        i=$((i + 1))
        printf '  %d) %s\n' "$i" "$folder"
      done
      while [ -z "$chosen" ]; do
        printf 'Choose a working copy [1-%s]: ' "$#"
        IFS= read -r number || exit 0
        i=0
        for folder do
          i=$((i + 1))
          if [ "$i" = "$number" ]; then chosen=$folder; break; fi
        done
      done
      printf 'Remember this working copy for %s on %s? [y/N] ' "$repo" "$server"
      if IFS= read -r answer; then
        case "$answer" in y|Y)
          (umask 077
           mkdir -p "${choice_file%/*}" && tmp=$(mktemp "$choice_file.XXXXXX") &&
             printf '%s\n' "$chosen" > "$tmp" && mv -f "$tmp" "$choice_file") ||
             echo 'Could not save this choice.' >&2
        ;; esac
      fi
    fi
  fi
  if [ -n "$chosen" ] && cd -P "$chosen"; then
    printf 'Working copy of %s: %s\n' "$repo" "$(pwd -P)"
  else
    printf 'No matching working copy of %s is accessible.\n' "$repo"
    chosen=
  fi
fi
if [ -z "$chosen" ]; then
  fallback=${fallback:-$HOME}
  if [ -n "$repo" ]; then
    while :; do
      printf 'Enter a folder, or press Enter to continue in %s (Ctrl-D to cancel): ' "$fallback"
      IFS= read -r folder || exit 0
      if enter_folder "${folder:-$fallback}"; then break; fi
      printf 'Folder is inaccessible: %s\n' "${folder:-$fallback}"
    done
  else
    enter_folder "$fallback"
  fi
  printf 'Working folder: %s\n' "$(pwd -P)"
fi
