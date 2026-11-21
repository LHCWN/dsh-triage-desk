import { randomUUID } from 'node:crypto'
import { AGENT_PRESETS } from './agents.js'
import { shellQuote } from './agent-command.js'
import { PASTE_WRAPPER_PY, sanitizePastePrompt } from './paste-wrapper.js'

// Remote presets run the installed program by name, independent of any local
// executable path, platform-specific command or agent discovery result.
export const SSH_AGENTS = AGENT_PRESETS.map(({ id, label }) => ({ id, label }))

function sshServerError(server, previous) {
  if (!server || typeof server.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(server.alias)) {
    return 'SSH destinations need a literal host alias'
  }
  if (previous.some((entry) => entry.alias.toLowerCase() === server.alias.toLowerCase())) return 'duplicate SSH alias'
  if (!SSH_AGENTS.some((agent) => agent.id === server.agent)) return 'unknown remote agent'
  if (typeof server.cwd !== 'string' || !server.cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(server.cwd)
    || server.cwd.length > 1024) return 'SSH destinations need an absolute remote working folder'
  return ''
}

export function normalizeSshServers(input, strict = false) {
  const servers = []
  if (!Array.isArray(input)) {
    if (strict) throw new Error('sshServers must be a list')
    return servers
  }
  for (const server of input) {
    const error = sshServerError(server, servers)
    if (error && strict) throw new Error(error)
    if (!error) servers.push({ alias: server.alias, cwd: server.cwd, agent: server.agent })
  }
  return servers
}

/**
 * ssh(1): -T disables the remote tty (byte-preserving upload); -tt forces
 * a tty for the interactive agent. ssh returns the remote status or 255 on
 * connection errors. Keep the interactive channel's stdin attached to the
 * terminal, and the (possibly 16k Unicode characters) draft off the local
 * command line, including PowerShell 5.1's native argument conversion.
 */
export function buildSshScripts(server, prompt, platform) {
  const file = '.triage-desk-' + randomUUID() + '.sh'
  const remote = [
    'set -eu',
    'rm -f "$0"',
    'cd ' + shellQuote(server.cwd),
    'printf "SSH %s · %s · %s\\n" ' + shellQuote(server.alias) + ' ' + shellQuote(server.agent) + ' "$(pwd -P)"',
  ]
  if (server.agent === 'claude') {
    remote.push('exec claude --prefill ' + shellQuote(prompt))
  } else {
    if (prompt !== sanitizePastePrompt(prompt)) throw new Error('remote paste cannot represent control characters in this prompt')
    remote.push('umask 077', 'prompt_file=$(mktemp)', 'trap \'rm -f "$prompt_file"\' EXIT',
      'printf %s ' + shellQuote(prompt) + ' > "$prompt_file"',
      'python3 -I -c ' + shellQuote(PASTE_WRAPPER_PY) + ' "$prompt_file" ' + shellQuote(server.agent))
  }
  // The staging shell reads the prompt as quoted data. An interrupted
  // transfer cannot execute the incomplete payload. The random name belongs
  // to this launch and the interactive shell unlinks it as soon as it starts.
  const stage = 'set -eu\numask 077\nprintf %s ' + shellQuote(remote.join('\n') + '\n') + ' > ' + file + '\nexit 0\n'
  const upload = 'ssh -T -- ' + server.alias + ' sh -s'
  const connect = 'ssh -tt -- ' + server.alias + ' sh ' + file
  const retry = 'SSH launch failed. Retry the same draft? [y/N]'
  const local = platform === 'win32'
    ? [
        "$ErrorActionPreference = 'Stop'",
        '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
        "$stage = Join-Path $PSScriptRoot 'stage.sh'",
        'try {', '  do {',
        '    Get-Content -LiteralPath $stage -Raw -Encoding UTF8 | ' + upload,
        '    if ($LASTEXITCODE -eq 0) { ' + connect + ' }',
        '    if ($LASTEXITCODE -eq 0) { break }',
        "  } while ((Read-Host '" + retry + "') -eq 'y')",
        '} finally { Remove-Item -LiteralPath $stage, $PSCommandPath -Force }',
      ].join('\r\n')
    : [
        '#!/bin/sh', 'stage="$(dirname "$0")/stage.sh"', 'trap \'rm -f "$stage" "$0"; rmdir "$(dirname "$0")" 2>/dev/null || :\' EXIT',
        'while ! ( ' + upload + ' < "$stage" && ' + connect + ' ); do',
        "  printf '%s ' '" + retry + "'", '  IFS= read -r answer || break',
        '  case "$answer" in y|Y) ;; *) break ;; esac', 'done',
      ].join('\n')
  return { stage, local }
}
