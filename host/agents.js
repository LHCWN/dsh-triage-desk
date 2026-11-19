/**
 * Triage Desk — agent detection (configured agents) and discovery (known agent
 * CLIs) through one login-environment probe each.
 */

import path from 'node:path'
import { DISCOVERABLE_AGENTS, agentExecutable } from '../launcher.js'
import { LaunchError } from './errors.js'

const DETECTION_CACHE_MS = 120_000

export function createAgents({ launcherSettings, platform, locateExecutables, isExecutableFile }) {
  /**
   * Agent availability keyed by agent id: `{ available, path, executable }`
   * (`executable` is the word agentExecutable parsed from the command, '' when
   * none), plus
   * `reason` when unavailable — `missing`, `not-executable` (an absolute
   * command path without X_OK), `alias` (only an alias that is not one plain
   * absolute executable path), `function` (a shell function or builtin), or
   * `probe-failed` with `available: null` when the login shell itself failed.
   * On Windows a command path is reported resolved (`\x` gets the current
   * drive), which is the path fs.access checks (path.toNamespacedPath).
   */
  const detectionCache = { at: 0, value: null }
  const detectAgents = async (force = false) => {
    if (!force && detectionCache.value !== null && Date.now() - detectionCache.at < DETECTION_CACHE_MS) {
      return detectionCache.value
    }
    const results = new Map()
    const unresolved = []
    for (const agent of launcherSettings.agents) {
      const executable = agentExecutable(agent.command, platform)
      if (executable === '') {
        results.set(agent.id, { available: false, path: null, reason: 'missing', executable })
        continue
      }
      if ((platform === 'win32' ? path.win32 : path.posix).isAbsolute(executable)) {
        const checked = platform === 'win32' ? path.win32.resolve(executable) : executable
        results.set(agent.id, (await isExecutableFile(checked))
          ? { available: true, path: checked, executable }
          : { available: false, path: null, reason: 'not-executable', executable })
        continue
      }
      unresolved.push([agent.id, executable])
    }
    if (unresolved.length > 0) {
      // One login shell for every agent instead of one per agent: login-shell
      // startup dominates the cost of detection.
      const executables = Array.from(new Set(unresolved.map((entry) => entry[1])))
      const { found, seen, ok } = await locateExecutables(executables, 8000)
      if (!ok || seen.size === 0) {
        // The login shell itself failed (broken rc, timeout). Treat detection
        // as unknown rather than blocking every agent permanently.
        for (const [id, executable] of unresolved) {
          results.set(id, { available: null, path: null, reason: 'probe-failed', executable })
        }
      } else {
        for (const [id, executable] of unresolved) {
          const verdict = found.get(executable) || { path: null, reason: 'missing' }
          results.set(id, verdict.path !== null
            ? { available: true, path: verdict.path, executable }
            : { available: false, path: null, reason: verdict.reason, executable })
        }
      }
    }
    const value = Object.fromEntries(results)
    detectionCache.at = Date.now()
    detectionCache.value = value
    return value
  }

  /**
   * Scans the machine for the known agent CLIs through the login environment.
   * `commands` (already configured agent commands) excludes found agents whose
   * executable equals the executable of one of those commands.
   */
  const discoverAgents = async (commands = []) => {
    const configured = new Set(
      commands.map((command) => agentExecutable(command, platform)).filter((executable) => executable !== ''),
    )
    const catalog = DISCOVERABLE_AGENTS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      command: entry.command,
      executable: agentExecutable(entry.command, platform),
    })).filter((entry) => entry.executable !== '')
    const unique = Array.from(new Set(catalog.map((entry) => entry.executable)))
    let located = new Map()
    if (unique.length > 0) {
      const result = await locateExecutables(unique, 10_000)
      if (!result.ok) throw new LaunchError('scan-failed', 'agent discovery failed')
      located = result.found
    }
    const pathOf = (entry) => located.get(entry.executable)?.path || null
    return {
      found: catalog
        .filter((entry) => pathOf(entry) !== null && !configured.has(entry.executable))
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          command: entry.command,
          executable: entry.executable,
          path: pathOf(entry),
        })),
      checked: catalog.length,
    }
  }

  return { detectAgents, discoverAgents }
}
