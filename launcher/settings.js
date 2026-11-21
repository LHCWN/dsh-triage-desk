/**
 * Triage Desk launcher — normalization of the launcher part of the plugin
 * config: agents, default agent, clone directories, manual repo paths,
 * scenarios, the default scenario, the terminal app, and prompt delivery.
 */

import { normalizeSshServers } from './ssh.js'
import path from 'node:path'
import { asObject, expandHome } from './common.js'
import { REPO_PATTERN } from './repo-urls.js'
import { AGENTS_VERSION, DISCOVERABLE_AGENTS, DSH_TARGET, normalizeAgentConfig } from './agents.js'
import { normalizeScenarios } from './scenarios.js'
import { normalizeTerminalChoice } from './terminals.js'

export const MAX_CLONE_DIRS = 8
export const MAX_REPO_PATHS = 50

/**
 * How an agent without a native draft flag gets its prompt: `paste` types it
 * into the agent's input box (unsent) through the paste wrapper, `clipboard`
 * opens the agent empty with the prompt on the clipboard.
 */
export const PROMPT_DELIVERY_MODES = ['paste', 'clipboard']
export const DEFAULT_PROMPT_DELIVERY = 'paste'

/** A `~`-expanded absolute single-line path, normalized and capped, or ''. */
function normalizeAbsolutePath(value) {
  const expanded = expandHome(value)
  if (expanded === '' || !path.isAbsolute(expanded)) return ''
  if (/[\r\n\u0000]/.test(expanded)) return ''
  return path.normalize(expanded).slice(0, 300)
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const clean = normalizeAbsolutePath(entry)
    if (clean === '') continue
    if (!out.includes(clean)) out.push(clean)
    if (out.length >= MAX_CLONE_DIRS) break
  }
  return out
}

function normalizeRepoPaths(value) {
  const input = asObject(value)
  const out = {}
  let count = 0
  for (const key of Object.keys(input)) {
    if (count >= MAX_REPO_PATHS) break
    if (!REPO_PATTERN.test(key)) continue
    const clean = normalizeAbsolutePath(input[key])
    if (clean === '') continue
    out[key.slice(0, 140)] = clean
    count += 1
  }
  return out
}

export function normalizeLauncherConfig(config) {
  const input = asObject(config)
  // No saved agent list: the candidates are the whole discovery catalog, and
  // the panel shows the ones detection finds (`agentsAuto`). Saving agents in
  // Settings fixes the list.
  // An empty saved list (every agent removed in Settings) means the same.
  const agentsAuto = !Array.isArray(input.agents) || input.agents.length === 0
  const { agents, invalidAgents, renamed } = normalizeAgentConfig(agentsAuto ? DISCOVERABLE_AGENTS : input.agents, {
    upgradeLegacy: !(input.agentsVersion >= AGENTS_VERSION),
  })
  const ids = new Set(agents.map((agent) => agent.id))
  // A saved agent named "dsh" was renamed: its references follow it, since
  // before the DSH target existed "dsh" could only mean that agent.
  const legacy = renamed[DSH_TARGET]
  const follow = (id) => (legacy !== undefined && id === DSH_TARGET ? legacy : id)
  // A new profile, an unknown id or "dsh": launches open a DSH chat.
  const savedDefault = follow(input.defaultAgent)
  const defaultAgent = typeof savedDefault === 'string' && ids.has(savedDefault) ? savedDefault : DSH_TARGET
  const scenarios = normalizeScenarios(input.scenarios).map((scenario) =>
    scenario.agent === DSH_TARGET && legacy !== undefined ? { ...scenario, agent: legacy } : scenario)
  const requestedDefault = typeof input.defaultScenario === 'string' ? input.defaultScenario.trim() : ''
  const defaultScenario = scenarios.some((entry) => entry.id === requestedDefault && entry.scope === 'item' && entry.enabled)
    ? requestedDefault
    : ''
  return {
    agents,
    agentsAuto,
    sshServers: normalizeSshServers(input.sshServers),
    invalidAgents,
    defaultAgent,
    cloneDirs: normalizePathList(input.cloneDirs),
    repoPaths: normalizeRepoPaths(input.repoPaths),
    scenarios,
    defaultScenario,
    terminal: normalizeTerminalChoice(input.terminal),
    promptDelivery: PROMPT_DELIVERY_MODES.includes(input.promptDelivery) ? input.promptDelivery : DEFAULT_PROMPT_DELIVERY,
  }
}
