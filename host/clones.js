/**
 * Triage Desk — local clone resolution: clone roots, the cached clone scan, the
 * workspace fallback, and the native directory picker.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CLONE_DIRS,
  discoverCloneRoots,
  expandHome,
  isGitCloneDir,
  lookupRepoPath,
  matchClone,
  readSshHostAliases,
  scanCloneDirs,
} from '../launcher.js'
import { LaunchError } from './errors.js'

const CLONE_CACHE_MS = 60_000

export function createClones({ ctx, settings, launcherSettings }) {
  const pickDirectoryPath = async () => {
    const controller = typeof ctx.get === 'function' ? ctx.get('directoryPickerController') : null
    if (controller === null || controller === undefined || typeof controller.pick !== 'function') {
      throw new LaunchError('picker-unavailable', 'the native directory picker is not available')
    }
    try {
      return await controller.pick(AbortSignal.timeout(300_000))
    } catch (error) {
      throw new LaunchError('pick-failed', String((error && error.message) || error))
    }
  }

  const isDirectory = async (value) => {
    try {
      const stat = await fs.stat(value)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  // Where to open Terminal when no local clone of the repository exists: the
  // session workspace if DSH exposes it, otherwise the host cwd (home).
  const workspaceDirectory = async () => {
    const candidates = []
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
      if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
        for (const workspace of registry.list()) {
          if (workspace !== null && workspace !== undefined && typeof workspace.path === 'string') {
            candidates.push(workspace.path)
          }
        }
      }
    } catch {
      // optional service
    }
    candidates.push(settings.cwd)
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && path.isAbsolute(candidate) && (await isDirectory(candidate))) return candidate
    }
    return os.homedir()
  }

  // Clone roots: explicit settings win; otherwise the existing default
  // directories (e.g. ~/Documents/GitHub, which home discovery cannot see two
  // levels down) plus project directories detected in the user's home, so no
  // personal path or organization is baked into the plugin. Defaults come
  // first: a nested default then gets its own full scan budget and depth.
  const discoveryCache = { at: 0, value: null }
  const effectiveCloneDirs = async () => {
    if (launcherSettings.cloneDirs.length > 0) return launcherSettings.cloneDirs
    if (discoveryCache.value !== null && Date.now() - discoveryCache.at < 5 * 60_000) {
      return discoveryCache.value
    }
    const value = []
    for (const candidate of DEFAULT_CLONE_DIRS) {
      const dir = expandHome(candidate)
      if (!value.includes(dir) && (await isDirectory(dir))) value.push(dir)
    }
    for (const dir of await discoverCloneRoots()) {
      if (!value.includes(dir)) value.push(dir)
    }
    // Nothing exists: report the candidates so the settings screen shows them as missing.
    const result = value.length > 0 ? value : DEFAULT_CLONE_DIRS
    discoveryCache.at = Date.now()
    discoveryCache.value = result
    return result
  }

  /* --------------------------------------------------------- clone discovery */

  const cloneCache = { at: 0, value: null }
  const scanLocalClones = async (force = false) => {
    if (!force && cloneCache.value !== null && Date.now() - cloneCache.at < CLONE_CACHE_MS) {
      return cloneCache.value
    }
    const dirs = await effectiveCloneDirs()
    const result = await scanCloneDirs(dirs, { sshHosts: await readSshHostAliases() })
    result.roots = dirs
    cloneCache.at = Date.now()
    cloneCache.value = result
    return result
  }

  /** Resolves the local checkout of a repository, or the workspace fallback. */
  const resolveClone = async (repo) => {
    let clonePath = ''
    let cloneMissing = false
    const override = lookupRepoPath(launcherSettings.repoPaths, repo)
    if (override !== '') {
      if (await isDirectory(override)) clonePath = override
      else cloneMissing = true
    } else {
      const scan = await scanLocalClones()
      const match = matchClone(scan.clones, repo)
      if (match !== null) clonePath = match.path
      else cloneMissing = true
    }
    if (cloneMissing === false && !(await isGitCloneDir(clonePath))) {
      throw new LaunchError('not-a-repo', `the directory ${clonePath} is not a git clone`, {
        repo,
        path: clonePath,
      })
    }
    if (cloneMissing) {
      // No checkout of this repository is available locally: open the agent in
      // the workspace instead, with the item links as the prompt.
      clonePath = await workspaceDirectory()
    }
    return { cwd: clonePath, cloneMissing }
  }

  return {
    pickDirectoryPath,
    isDirectory,
    workspaceDirectory,
    effectiveCloneDirs,
    scanLocalClones,
    resolveClone,
  }
}
