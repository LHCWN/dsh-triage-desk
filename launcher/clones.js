/**
 * Triage Desk launcher — local clone discovery and matching: default clone
 * directories, likely clone roots in the home directory, the bounded clone
 * scan with git remote parsing, repository matching, and the clone command.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asObject, expandHome } from './common.js'
import { remoteToRepo } from './repo-urls.js'

/**
 * Directories used when the user has not configured any clone directory yet.
 * Every candidate is only used if it exists on disk.
 */
export const DEFAULT_CLONE_DIRS = [
  '~/Projects',
  '~/Developer',
  '~/code',
  '~/src',
  '~/repos',
  '~/work',
  '~/github',
  '~/Documents/GitHub',
  '~/Documents/Projects',
]

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'Library',
  '.git',
  '.cache',
  '.Trash',
  'Applications',
  '.npm',
  '.pnpm-store',
  '.dsh',
  '.claude',
  '.codex',
  '.cursor',
  '.local',
  '.rustup',
  '.cargo',
  '.nvm',
  '.gradle',
  '.m2',
  '.orbstack',
  '.docker',
  '.bun',
  '.opencode',
  '.gemini',
  'vendor',
  'Pods',
])

const MAX_CLONE_SCAN_DIRS = 400
const MAX_DISCOVERED_ROOTS = 12

export async function isGitCloneDir(dir) {
  try {
    const stat = await fs.stat(path.join(dir, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/**
 * True for a directory entry or a symlink that resolves to a directory.
 * `withFileTypes` dirents report the link itself (lstat semantics), so a
 * symlinked `~/Projects -> /Volumes/work` would otherwise be skipped.
 */
async function isDirectoryEntry(parent, dirent) {
  if (dirent.isDirectory()) return true
  if (typeof dirent.isSymbolicLink !== 'function' || !dirent.isSymbolicLink()) return false
  try {
    return (await fs.stat(path.join(parent, dirent.name))).isDirectory()
  } catch {
    return false
  }
}

/**
 * Finds likely clone roots in the user's home without any hard-coded project
 * names: a directory directly containing `.git` is a clone root, and a
 * directory whose immediate children include a clone is a project root (e.g.
 * a project folder when clones live one level deeper). Hidden and heavy
 * directories are skipped; symlinked directories are followed.
 */
export async function discoverCloneRoots(home = os.homedir()) {
  const roots = []
  let entries
  try {
    entries = await fs.readdir(home, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    if (!(await isDirectoryEntry(home, entry))) continue
    const dir = path.join(home, entry.name)
    if (await isGitCloneDir(dir)) {
      roots.push(dir)
      if (roots.length >= MAX_DISCOVERED_ROOTS) break
      continue
    }
    let children = []
    try {
      children = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    let projectRoot = false
    for (const child of children) {
      if (child.name.startsWith('.') || SKIP_DIR_NAMES.has(child.name)) continue
      if (!(await isDirectoryEntry(dir, child))) continue
      if (await isGitCloneDir(path.join(dir, child.name))) {
        projectRoot = true
        break
      }
    }
    if (projectRoot) {
      roots.push(dir)
      if (roots.length >= MAX_DISCOVERED_ROOTS) break
    }
  }
  return roots
}

/** `[{ name, url }]` for every `[remote "name"]` url in a git config file, in file order. */
export function parseGitConfigRemotes(text) {
  const remotes = []
  let remote = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.slice(1, -1).trim().match(/^remote\s+"([^"]+)"$/i)
      remote = section === null ? null : section[1]
      continue
    }
    if (remote === null) continue
    const match = line.match(/^url\s*=\s*(.+)$/i)
    if (match) remotes.push({ name: remote, url: match[1].trim() })
  }
  return remotes
}

/**
 * The repository a clone maps to for a saved manual path: `upstream` first
 * (a fork's inbox items point at the parent), then `origin`, then the first
 * other remote that is a GitHub repository.
 */
export function chooseCloneRepo(remotes, sshHosts) {
  const parsed = []
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    if (remote === null || typeof remote !== 'object') continue
    const repo = remoteToRepo(remote.url, sshHosts)
    if (repo !== null) parsed.push({ name: String(remote.name || ''), slug: repo.slug })
  }
  for (const name of ['upstream', 'origin']) {
    const hit = parsed.find((entry) => entry.name === name)
    if (hit !== undefined) return hit.slug
  }
  return parsed.length > 0 ? parsed[0].slug : null
}

function parseGitConfigRemote(text, sshHosts) {
  const repos = []
  for (const remote of parseGitConfigRemotes(text)) {
    const repo = remoteToRepo(remote.url, sshHosts)
    if (repo !== null && !repos.some((slug) => slug.toLowerCase() === repo.slug.toLowerCase())) repos.push(repo.slug)
  }
  return repos
}

async function readCloneRemote(gitPath, sshHosts) {
  try {
    const stat = await fs.stat(gitPath)
    if (stat.isDirectory()) {
      const config = await fs.readFile(path.join(gitPath, 'config'), 'utf8')
      return parseGitConfigRemote(config, sshHosts)
    }
    const pointer = await fs.readFile(gitPath, 'utf8')
    const match = pointer.match(/^gitdir:\s*(.+)$/m)
    if (!match) return null
    const gitDir = path.resolve(path.dirname(gitPath), match[1].trim())
    let configPath = path.join(gitDir, 'config')
    try {
      const config = await fs.readFile(configPath, 'utf8')
      const repos = parseGitConfigRemote(config, sshHosts)
      if (repos.length > 0) return repos
    } catch {
      // worktrees keep the config in the common dir
    }
    try {
      const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()
      configPath = path.resolve(gitDir, common, 'config')
      const config = await fs.readFile(configPath, 'utf8')
      return parseGitConfigRemote(config, sshHosts)
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/**
 * Scans the configured base directories (breadth-first, bounded) and returns
 * every GitHub clone it can recognise. Never throws for missing directories.
 * Symlinked directories are followed; every directory is visited once by its
 * realpath, so link cycles and two links to one tree cost a single visit.
 * `options.sshHosts` maps SSH host aliases (readSshHostAliases).
 */
export async function scanCloneDirs(dirs, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3
  const limit = Number.isInteger(options.limit) ? options.limit : MAX_CLONE_SCAN_DIRS
  const sshHosts = options.sshHosts instanceof Map ? options.sshHosts : new Map()
  const wanted = Array.isArray(dirs) ? dirs : []
  const clones = []
  const directories = []
  const skipped = []
  let visited = 0
  const seen = new Set()

  for (const entry of wanted) {
    const root = expandHome(entry)
    if (root === '') continue
    try {
      const stat = await fs.stat(root)
      if (!stat.isDirectory()) {
        skipped.push({ path: root, reason: 'not-a-directory' })
        continue
      }
    } catch {
      skipped.push({ path: root, reason: 'missing' })
      continue
    }
    const queue = [{ dir: root, depth: 0 }]
    let rootVisited = 0
    // Each configured root gets a full budget; a large first root must not
    // starve later roots. `visited` remains the total reported to callers.
    while (queue.length > 0 && rootVisited < limit) {
      const current = queue.shift()
      let real
      try {
        real = await fs.realpath(current.dir)
      } catch {
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      rootVisited += 1
      visited += 1
      if (SKIP_DIR_NAMES.has(path.basename(current.dir))) continue
      if (await isGitCloneDir(current.dir)) {
        const repos = await readCloneRemote(path.join(current.dir, '.git'), sshHosts)
        for (const repo of repos || []) clones.push({ repo, path: current.dir })
        continue
      }
      directories.push(current.dir)
      if (current.depth >= maxDepth) continue
      let entries = []
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of entries) {
        if (dirent.name.startsWith('.')) continue
        if (SKIP_DIR_NAMES.has(dirent.name)) continue
        if (!(await isDirectoryEntry(current.dir, dirent))) continue
        queue.push({ dir: path.join(current.dir, dirent.name), depth: current.depth + 1 })
      }
    }
  }
  return { clones, directories, skipped, visited }
}

/** First clone matching `owner/repo`, preferring the order of the scan. */
export function matchClone(clones, slug) {
  if (!Array.isArray(clones) || typeof slug !== 'string') return null
  const wanted = slug.toLowerCase()
  for (const clone of clones) {
    if (typeof clone.repo === 'string' && clone.repo.toLowerCase() === wanted) return clone
  }
  return null
}

/**
 * Manual clone path for `owner/repo`. GitHub owner and repository names are
 * case-insensitive, so `acme/App` in settings matches an item from `ACME/app`;
 * an exact-case key wins over another key that differs only by case.
 */
export function lookupRepoPath(repoPaths, slug) {
  const input = asObject(repoPaths)
  if (typeof slug !== 'string' || slug === '') return ''
  if (typeof input[slug] === 'string' && input[slug] !== '') return input[slug]
  const wanted = slug.toLowerCase()
  for (const key of Object.keys(input)) {
    if (key.toLowerCase() === wanted && typeof input[key] === 'string' && input[key] !== '') return input[key]
  }
  return ''
}
