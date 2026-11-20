/**
 * Triage Desk launcher — GitHub repository identity: `owner/name` from a
 * GitHub link, from a git remote URL, and the OpenSSH host aliases that map a
 * remote host to GitHub.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** `owner/name` for a GitHub URL, or null when this is not a GitHub link. */
export function parseRepoUrl(value) {
  if (typeof value !== 'string') return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  let owner
  let name
  try {
    owner = decodeURIComponent(segments[0])
    name = decodeURIComponent(segments[1]).replace(/\.git$/i, '')
  } catch {
    // Malformed %-escapes: this is not a usable GitHub link.
    return null
  }
  if (!REPO_PATTERN.test(owner + '/' + name)) return null
  // The issue or pull request number, when the link points at one.
  const number = (segments[2] === 'pull' || segments[2] === 'issues') && /^\d+$/.test(segments[3] || '')
    ? segments[3]
    : ''
  return { owner, name, slug: owner + '/' + name, number }
}

const GITHUB_SSH_HOSTNAMES = new Set(['github.com', 'ssh.github.com'])

/**
 * Literal `Host` aliases from an OpenSSH client config whose `HostName` is
 * GitHub, as a Map of lowercased alias → hostname. Verified against
 * ssh_config(5) (OpenSSH 10.3 man page): keywords are case-insensitive,
 * `Keyword value` and `Keyword=value` are both valid, `#` lines are comments,
 * arguments may be double-quoted, `Host` lists whitespace-separated patterns
 * (`*`/`?` wildcards, `!` negation) up to the next `Host`/`Match`, `HostName`
 * accepts the `%h`/`%%` tokens, and for each parameter the first obtained
 * value wins. Deliberate simplifications: only literal patterns become
 * aliases (wildcard blocks are not evaluated, so an earlier `Host *` that sets
 * HostName is ignored here although ssh would apply it), `Match` blocks and
 * `Include` files are skipped, and aliases compare case-insensitively.
 */
export function parseSshConfigHosts(text) {
  const aliases = new Map()
  const decided = new Set()
  let current = null
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const argument = match[2].trim()
    if (keyword === 'host') {
      const patterns = argument.split(/\s+/).map((pattern) => pattern.replace(/^"(.*)"$/, '$1'))
      const negated = new Set(patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).toLowerCase()))
      current = patterns
        .filter((p) => p !== '' && !p.startsWith('!') && !/[*?]/.test(p))
        .map((p) => p.toLowerCase())
        .filter((p) => !negated.has(p))
      continue
    }
    if (keyword === 'match') {
      current = null
      continue
    }
    if (keyword !== 'hostname' || current === null) continue
    const value = argument.replace(/^"(.*)"$/, '$1')
    for (const alias of current) {
      if (decided.has(alias)) continue
      decided.add(alias)
      const expanded = value.replace(/%(%|h)/g, (token, key) => (key === 'h' ? alias : '%'))
      if (expanded.includes('%')) continue
      const hostname = expanded.toLowerCase()
      if (GITHUB_SSH_HOSTNAMES.has(hostname)) aliases.set(alias, hostname)
    }
  }
  return aliases
}

/** Reads `~/.ssh/config` GitHub aliases; a missing or unreadable file yields none. */
export async function readSshHostAliases(file = path.join(os.homedir(), '.ssh', 'config')) {
  try {
    return parseSshConfigHosts(await fs.readFile(file, 'utf8'))
  } catch {
    return new Map()
  }
}

/**
 * Normalize a git remote URL to a GitHub `owner/name`, or null. Accepts
 * http(s)/ssh/git URLs and scp-like `[user@]host:owner/repo`; `sshHosts` (from
 * readSshHostAliases) maps SSH host aliases such as `github-work` to GitHub.
 */
export function remoteToRepo(value, sshHosts) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const aliases = sshHosts instanceof Map ? sshHosts : new Map()
  let host = ''
  let repoPath = ''
  let viaSsh = false
  const scp = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? null : text.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/)
  if (scp !== null) {
    host = scp[1]
    repoPath = scp[2]
    viaSsh = true
  } else {
    try {
      const url = new URL(text)
      host = url.hostname
      repoPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      viaSsh = url.protocol === 'ssh:' || url.protocol === 'git+ssh:'
    } catch {
      return null
    }
  }
  host = host.toLowerCase()
  if (viaSsh && aliases.has(host)) host = aliases.get(host)
  if (host !== 'github.com' && host !== 'www.github.com' && !(viaSsh && host === 'ssh.github.com')) return null
  repoPath = repoPath.replace(/\.git$/i, '').replace(/\/+$/, '')
  const segments = repoPath.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 2) return null
  if (!REPO_PATTERN.test(segments[0] + '/' + segments[1])) return null
  return { owner: segments[0], name: segments[1], slug: segments[0] + '/' + segments[1] }
}
