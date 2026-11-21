import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AGENT_PRESETS } from './agents.js'
import { agentExecutable, shellQuote } from './agent-command.js'
import { PASTE_WRAPPER_PY, sanitizePastePrompt } from './paste-wrapper.js'

// Remote presets run the installed program by name, independent of any local
// executable path, platform-specific command or agent discovery result.
export const SSH_AGENTS = AGENT_PRESETS.map(({ id, label }) => ({ id, label }))

const scanScript = readFileSync(new URL('./ssh-repositories.sh', import.meta.url), 'utf8')
const selectFolder = readFileSync(new URL('./ssh-select-folder.sh', import.meta.url), 'utf8')
const selectAgent = readFileSync(new URL('./ssh-select-agent.sh', import.meta.url), 'utf8')

const environment = 'agent_names=' + shellQuote(SSH_AGENTS.map(({ id }) => id).join(' ')) + '\n' +
  readFileSync(new URL('./ssh-environment.sh', import.meta.url), 'utf8')
export const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

// OpenSSH resolves the connection settings when the user selects a named host.
export async function configuredSshHosts(home = os.homedir()) {
  const directory = path.join(home, '.ssh')
  const aliases = new Set()
  const visited = new Set()
  async function read(file) {
    if (visited.has(file) || visited.size >= 64) return
    visited.add(file)
    let contents
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > 1024 * 1024) return
      contents = await fs.readFile(file, 'utf8')
    } catch { return }
    for (const line of contents.split(/\r?\n/)) {
      const directive = /^\s*(Host|Include)(?:\s*=\s*|\s+)([^#]+)/i.exec(line)
      if (!directive) continue
      const words = directive[2].match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
      for (const word of words) {
        const value = word.replace(/^["']|["']$/g, '')
        if (directive[1].toLowerCase() === 'host') {
          if (SSH_ALIAS.test(value)) aliases.add(value)
        } else {
          const pattern = value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(directory, value)
          if (!pattern.includes('*') && !pattern.includes('?')) await read(pattern)
          else if (fs.glob) {
            try {
              for await (const match of fs.glob(pattern)) {
                if (visited.size >= 64) break
                await read(match)
              }
            } catch { /* an unavailable Include contributes no hosts */ }
          }
        }
      }
    }
  }
  await read(path.join(directory, 'config'))
  return [...aliases].sort()
}

export function sshAgentProbe(alias) {
  if (!SSH_ALIAS.test(alias)) throw new Error('Invalid SSH host alias')
  const probe = environment + '\nfor agent in ' + SSH_AGENTS.map(({ id }) => id).join(' ') +
    '; do if agent_available "$agent"; then printf "__td_agent__%s\\n" "$agent"; fi; done'
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', alias, 'sh -c ' + shellQuote(probe)]
}

function repositoryFolders(server) {
  return server.folders ?? (server.cwd === undefined ? [] : [server.cwd])
}

export function sshRepositoryScan(server) {
  const folders = repositoryFolders(server).map(shellQuote).join(' ')
  return ['ssh', '-T', '-o', 'BatchMode=yes', '--', server.alias,
    'sh -c ' + shellQuote(scanScript + '\nscan_repositories ' + folders)]
}

function sshServerError(server, previous) {
  if (!server || typeof server.alias !== 'string' || !SSH_ALIAS.test(server.alias)) {
    return 'SSH destinations need a literal host alias'
  }
  if (previous.some((entry) => entry.alias.toLowerCase() === server.alias.toLowerCase())) return 'duplicate SSH alias'
  if (!SSH_AGENTS.some((agent) => agent.id === server.agent)) return 'unknown remote agent'
  const folders = repositoryFolders(server)
  if (!Array.isArray(folders) || folders.length > 8 || folders.some((folder) =>
    typeof folder !== 'string' || !(folder.startsWith('/') || folder === '~' || folder.startsWith('~/')) || /[\x00-\x1f\x7f]/.test(folder) || folder.length > 1024)) {
    return 'SSH repository folders must be a list of up to eight absolute paths or paths starting with ~/'
  }
  if (server.alternatives !== undefined && (!Array.isArray(server.alternatives) ||
    server.alternatives.some((id) => !SSH_AGENTS.some((agent) => agent.id === id)))) return 'unknown remote alternative'
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
    if (!error) {
      const folders = [...new Set(repositoryFolders(server))]
      servers.push({ alias: server.alias, agent: server.agent, cwd: folders[0] || '', folders,
        alternatives: [...new Set(server.alternatives || [])].filter((id) => id !== server.agent) })
    }
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
export function buildSshScripts(server, prompt, platform, repo = '') {
  const preset = AGENT_PRESETS.find((entry) => entry.id === server.agent)
  if (!preset) throw new Error('unknown remote agent')
  const alternatives = AGENT_PRESETS.filter((entry) => entry.id !== preset.id && server.alternatives?.includes(entry.id))
  const executable = (entry) => shellQuote(agentExecutable(entry.command, 'linux'))
  const candidates = [preset, ...alternatives]
  const native = candidates.filter((entry) => entry.draftFlag)
  const pasteAllowed = prompt === sanitizePastePrompt(prompt)
  const choiceKey = createHash('sha256').update(JSON.stringify([server.alias.toLowerCase(), repo.toLowerCase()])).digest('hex')
  const file = '.triage-desk-' + randomUUID() + '.sh'
  const remote = [
    'set -eu',
    'rm -f "$0"',
    'repo=' + shellQuote(repo.toLowerCase()),
    'server=' + shellQuote(server.alias),
    'choice_file="$HOME/.triage-desk/working-copies/' + choiceKey + '"',
    'set -- ' + repositoryFolders(server).map(shellQuote).join(' '),
    scanScript, selectFolder,
    'agent=' + executable(preset),
    'native_agents=' + shellQuote(native.map((entry) => agentExecutable(entry.command, 'linux')).join(' ')),
    'paste_allowed=' + (pasteAllowed ? 'yes' : 'no'),
    'set -- ' + alternatives.map(executable).join(' '),
    environment, selectAgent,
    "trap ':' INT",
    'case "$agent" in',
  ]
  for (const entry of native) {
    remote.push(executable(entry) + ')',
      'export TD_DRAFT=' + shellQuote(prompt),
      'if agent_executable "$agent"; then',
      '  "$agent" ' + shellQuote(entry.draftFlag) + ' "$TD_DRAFT"',
      'else',
      '  "$user_shell" "$shortcut_mode" ' + shellQuote(agentExecutable(entry.command, 'linux') + ' ' + entry.draftFlag + ' "$TD_DRAFT"'),
      'fi || printf "Agent exited with status %s\\n" "$?" >&2 ;;')
  }
  if (pasteAllowed && candidates.some((entry) => !entry.draftFlag)) {
    remote.push('*)', 'umask 077', 'prompt_file=$(mktemp)', 'trap \'rm -f "$prompt_file"\' EXIT',
      'printf %s ' + shellQuote(prompt) + ' > "$prompt_file"',
      'if agent_executable "$agent"; then set -- "$agent"; else set -- "$user_shell" "$shortcut_mode" "$agent"; fi',
      'python3 -I -c ' + shellQuote(PASTE_WRAPPER_PY) + ' --remote "$prompt_file" "$@" ;;')
  }
  remote.push('esac')
  const mode = preset.draftFlag ? 'draft' : 'paste'
  // The staging shell reads the prompt as quoted data. An interrupted
  // transfer cannot execute the incomplete payload. The random name belongs
  // to this launch and the interactive shell unlinks it as soon as it starts.
  const stage = 'set -eu\numask 077\nprintf %s ' + shellQuote(remote.join('\n') + '\n') + ' > ' + file + '\nexit 0\n'
  const upload = 'ssh -T -- ' + server.alias + ' sh -s'
  const connect = 'ssh -tt -- ' + server.alias + ' sh ' + file
  // Cleanup runs without stdin or authentication prompts, including on exit
  // from the retry dialog. Restrict deletion to this launch's random name.
  const cleanup = 'ssh -nT -o BatchMode=yes -o ConnectTimeout=5 -- ' + server.alias + ' rm -f ' + file
  const retained = 'Cleanup could not be confirmed. Check ' + server.alias + ':~/' + file
  const retry = 'SSH launch failed. Retry the same draft? [y/N]'
  const local = platform === 'win32'
    ? [
        "$ErrorActionPreference = 'Stop'",
        "$stage = Join-Path $PSScriptRoot 'stage.sh'",
        'Push-Location -LiteralPath $PSScriptRoot',
        '$remotePending = $true',
        'try {', '  do {',
        // cmd's file redirection passes the UTF-8 file directly to ssh.
        // Both the alias and the relative filename are plain command words.
        "    cmd.exe /d /c '" + upload + " < stage.sh'",
        '    if ($LASTEXITCODE -eq 0) { ' + connect + ' }',
        '    if ($LASTEXITCODE -eq 0) { $remotePending = $false; break }',
        "  } while ((Read-Host '" + retry + "') -eq 'y')",
        '} finally {',
        '  try {',
        '    if ($remotePending) {',
        '      ' + cleanup,
        "      if ($LASTEXITCODE -ne 0) { Write-Warning '" + retained + "' }",
        '    }',
        '  } finally {',
        '    Pop-Location',
        '    Remove-Item -LiteralPath $stage, $PSCommandPath -Force',
        '    [System.IO.Directory]::Delete($PSScriptRoot)',
        '  }',
        '}',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'stage="$(dirname "$0")/stage.sh"',
        'remote_pending=yes',
        'cleanup() {',
        '  if [ "$remote_pending" = yes ]; then',
        '    ' + cleanup + ' || printf "%s\\n" ' + shellQuote(retained) + ' >&2',
        '  fi',
        '  rm -f "$stage" "$0"',
        '  rmdir "$(dirname "$0")" 2>/dev/null || :',
        '}',
        'trap cleanup EXIT',
        "trap 'exit 1' HUP INT TERM",
        'while :; do',
        '  if ' + upload + ' < "$stage" && ' + connect + '; then remote_pending=no; break; fi',
        "  printf '%s ' '" + retry + "'", '  IFS= read -r answer || break',
        '  case "$answer" in y|Y) ;; *) break ;; esac', 'done',
      ].join('\n')
  return { stage, local, mode }
}
