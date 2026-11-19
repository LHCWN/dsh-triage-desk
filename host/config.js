/**
 * Triage Desk — config route helpers: the client-facing `publicConfig` view and
 * the sanitizers that turn a POST /triage-desk/config body into a profile patch.
 * Every sanitizer throws BadRequest; nothing here touches Cordis services.
 */

import path from 'node:path'
import {
  AGENT_COMMAND_RULE,
  AGENT_ID_PATTERN,
  DEFAULT_CLONE_DIRS,
  DEFAULT_SCENARIO_ID,
  MAX_AGENTS,
  MAX_AGENT_COMMAND,
  MAX_AGENT_LABEL,
  MAX_CLONE_DIRS,
  MAX_REPO_PATHS,
  MAX_SCENARIOS,
  PROMPT_DELIVERY_MODES,
  REPO_PATTERN,
  SCENARIO_REASON_LABELS,
  SCENARIO_SECTION_LABELS,
  TERMINAL_AUTO,
  TERMINAL_IDS,
  defaultScenarios,
  draftCommandFor,
  expandHome,
  hasSafePromptPlaceholder,
  validateDefaultScenario,
  validateScenario,
} from '../launcher.js'
import { MAX_ORGS, REFRESH_SECONDS } from '../github.js'
import { BadRequest } from './errors.js'

export const EDITABLE_FIELDS = [
  'orgs',
  'includePersonal',
  'refreshSeconds',
  'requireGreenChecks',
  'includeBotReviews',
  'agents',
  'defaultAgent',
  'cloneDirs',
  'repoPaths',
  'scenarios',
  'defaultScenario',
  'terminal',
  'promptDelivery',
]

/**
 * The agent detection map as the client sees it: each detected agent also
 * carries `draft`, whether a launch uses its native draft (draftCommandFor,
 * with the path the launch would run).
 */
function detectedAgentsView(detected, agents, platform) {
  const view = { ...detected }
  for (const agent of agents) {
    const status = view[agent.id]
    if (status === undefined || status === null) continue
    const detectedPath = status.available === true && typeof status.path === 'string' ? status.path : ''
    view[agent.id] = { ...status, draft: draftCommandFor(agent, detectedPath, platform) !== null }
  }
  return view
}

/**
 * `detected` is the agent detection map; `environment` carries what the host
 * found on this machine: `terminals` (detectTerminals) and `promptPaste`
 * (whether the paste wrapper can run, and why not).
 */
export function publicConfig(settings, runtime, launcher, detected, environment = {}) {
  const platform = environment.platform || process.platform
  return {
    orgs: settings.orgs,
    includePersonal: settings.includePersonal,
    sourcesAuto: settings.orgs.length === 0,
    sources: runtime.sources,
    refreshSeconds: settings.refreshSeconds,
    requireGreenChecks: settings.requireGreenChecks,
    includeBotReviews: settings.includeBotReviews,
    agents: launcher.agents,
    // Saved agents set aside because their command breaks the prompt rule:
    // [{ id, label, command, reason: 'placeholder' }], [] when none.
    invalidAgents: launcher.invalidAgents,
    defaultAgent: launcher.defaultAgent,
    cloneDirs: launcher.cloneDirs,
    cloneDirsDefault: DEFAULT_CLONE_DIRS,
    repoPaths: launcher.repoPaths,
    scenarios: launcher.scenarios,
    defaultScenario: launcher.defaultScenario,
    scenarioDefaults: defaultScenarios(),
    terminal: launcher.terminal,
    promptDelivery: launcher.promptDelivery,
    terminals: environment.terminals || null,
    promptPaste: environment.promptPaste || null,
    platform,
    supportsPrompt: true,
    supportsAgentDiscovery: true,
    detectedAgents: detectedAgentsView(detected || {}, launcher.agents, platform),
    editable: runtime.editable,
    // Display labels the client preview uses instead of its own copies.
    labels: { sections: SCENARIO_SECTION_LABELS, reasons: SCENARIO_REASON_LABELS },
  }
}

function sanitizeAgents(input) {
  if (!Array.isArray(input)) throw new BadRequest('agents must be an array')
  const agents = []
  const seen = new Set()
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BadRequest('each agent must be an object with id, label, and command')
    }
    const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!AGENT_ID_PATTERN.test(id)) throw new BadRequest(`invalid agent id "${id}"`)
    if (label === '' || label.length > MAX_AGENT_LABEL) {
      throw new BadRequest(`agent "${id}" needs a label of up to ${MAX_AGENT_LABEL} characters`)
    }
    if (command === '' || command.length > MAX_AGENT_COMMAND) {
      throw new BadRequest(`agent "${id}" needs a command of up to ${MAX_AGENT_COMMAND} characters`)
    }
    if (/[\r\n\u0000]/.test(command)) throw new BadRequest(`agent "${id}" command must be a single line`)
    if (!hasSafePromptPlaceholder(command)) {
      throw new BadRequest(`agent "${id}" ${AGENT_COMMAND_RULE}`, { code: 'invalid-agent', agent: id })
    }
    if (seen.has(id)) throw new BadRequest(`duplicate agent id "${id}"`)
    seen.add(id)
    agents.push({ id, label, command })
  }
  if (agents.length === 0) throw new BadRequest('at least one agent is required')
  if (agents.length > MAX_AGENTS) throw new BadRequest(`at most ${MAX_AGENTS} agents are supported`)
  return agents
}

function sanitizeScenarios(input, agents) {
  if (!Array.isArray(input)) throw new BadRequest('scenarios must be an array')
  if (input.length === 0) throw new BadRequest('at least one scenario is required')
  if (input.length > MAX_SCENARIOS) throw new BadRequest(`at most ${MAX_SCENARIOS} scenarios are supported`)
  const scenarios = []
  const seen = new Set()
  for (const entry of input) {
    const validation = validateScenario(entry, agents)
    if (!validation.ok) throw new BadRequest(validation.error)
    const id = entry.id.trim()
    if (seen.has(id)) throw new BadRequest(`duplicate scenario id "${id}"`)
    seen.add(id)
    scenarios.push({
      id,
      label: entry.label.trim(),
      scope: entry.scope,
      sections: entry.sections.slice(),
      prompt: entry.prompt.replace(/\r\n/g, '\n').trim(),
      agent: entry.agent.trim(),
      enabled: entry.enabled,
    })
  }
  if (!seen.has(DEFAULT_SCENARIO_ID)) {
    throw new BadRequest(`the "${DEFAULT_SCENARIO_ID}" scenario is required`)
  }
  return scenarios
}

function sanitizeCloneDirs(input) {
  if (!Array.isArray(input)) throw new BadRequest('cloneDirs must be an array of paths')
  const dirs = []
  for (const entry of input) {
    if (typeof entry !== 'string') throw new BadRequest('cloneDirs must be an array of paths')
    const expanded = expandHome(entry)
    if (expanded === '') continue
    if (!path.isAbsolute(expanded)) throw new BadRequest(`clone directory must be absolute: "${entry}"`)
    if (/[\r\n\u0000]/.test(expanded) || expanded.length > 300) throw new BadRequest(`invalid clone directory: "${entry}"`)
    const clean = path.normalize(expanded)
    if (!dirs.includes(clean)) dirs.push(clean)
  }
  if (dirs.length > MAX_CLONE_DIRS) throw new BadRequest(`at most ${MAX_CLONE_DIRS} clone directories are supported`)
  return dirs
}

function sanitizeRepoPaths(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequest('repoPaths must be an object of "owner/repo" to absolute path')
  }
  const paths = {}
  let count = 0
  for (const key of Object.keys(input)) {
    if (count >= MAX_REPO_PATHS) throw new BadRequest(`at most ${MAX_REPO_PATHS} manual clone paths are supported`)
    if (!REPO_PATTERN.test(key)) throw new BadRequest(`invalid repository key "${key}"`)
    const expanded = expandHome(typeof input[key] === 'string' ? input[key] : '')
    if (expanded === '') throw new BadRequest(`missing path for "${key}"`)
    if (!path.isAbsolute(expanded)) throw new BadRequest(`clone path must be absolute: "${input[key]}"`)
    if (/[\r\n\u0000]/.test(expanded) || expanded.length > 300) throw new BadRequest(`invalid clone path for "${key}"`)
    paths[key] = path.normalize(expanded)
    count += 1
  }
  return paths
}

export function sanitizePatch(input, currentLauncher) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequest('config patch must be a JSON object')
  }
  const patch = {}
  for (const key of Object.keys(input)) {
    if (!EDITABLE_FIELDS.includes(key)) throw new BadRequest(`unknown setting "${key}"`)
  }
  if (input.orgs !== undefined) {
    if (!Array.isArray(input.orgs)) throw new BadRequest('orgs must be an array of organization logins')
    const logins = []
    for (const entry of input.orgs) {
      if (typeof entry !== 'string') throw new BadRequest('orgs must be an array of organization logins')
      const login = entry.trim()
      if (login === '') continue
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
        throw new BadRequest(`invalid organization login "${login}"`)
      }
      if (!logins.includes(login)) logins.push(login)
    }
    if (logins.length > MAX_ORGS) throw new BadRequest(`at most ${MAX_ORGS} organizations are supported`)
    patch.orgs = logins
  }
  for (const key of ['includePersonal', 'requireGreenChecks', 'includeBotReviews']) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw new BadRequest(`${key} must be a boolean`)
    patch[key] = input[key]
  }
  if (input.refreshSeconds !== undefined) {
    const value = Number(input.refreshSeconds)
    const { min, max } = REFRESH_SECONDS
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BadRequest(`refreshSeconds must be an integer between ${min} and ${max}`)
    }
    patch.refreshSeconds = value
  }
  if (input.terminal !== undefined) {
    const id = typeof input.terminal === 'string' ? input.terminal.trim().toLowerCase() : ''
    if (id !== TERMINAL_AUTO && !TERMINAL_IDS.includes(id)) throw new BadRequest(`unknown terminal "${id}"`)
    patch.terminal = id
  }
  if (input.promptDelivery !== undefined) {
    if (!PROMPT_DELIVERY_MODES.includes(input.promptDelivery)) {
      throw new BadRequest(`promptDelivery must be one of ${PROMPT_DELIVERY_MODES.join(', ')}`)
    }
    patch.promptDelivery = input.promptDelivery
  }
  if (input.agents !== undefined) patch.agents = sanitizeAgents(input.agents)
  if (input.defaultAgent !== undefined) {
    if (typeof input.defaultAgent !== 'string' || input.defaultAgent.trim() === '') {
      throw new BadRequest('defaultAgent must be an agent id')
    }
    const id = input.defaultAgent.trim().toLowerCase()
    const agents = patch.agents !== undefined ? patch.agents : currentLauncher.agents
    if (!agents.some((agent) => agent.id === id)) throw new BadRequest(`unknown agent "${id}"`)
    patch.defaultAgent = id
  }
  if (input.cloneDirs !== undefined) patch.cloneDirs = sanitizeCloneDirs(input.cloneDirs)
  if (input.repoPaths !== undefined) patch.repoPaths = sanitizeRepoPaths(input.repoPaths)
  if (input.scenarios !== undefined) {
    const agents = patch.agents !== undefined ? patch.agents : currentLauncher.agents
    patch.scenarios = sanitizeScenarios(input.scenarios, agents)
  }
  if (input.defaultScenario !== undefined) {
    const scenarios = patch.scenarios !== undefined ? patch.scenarios : currentLauncher.scenarios
    const validation = validateDefaultScenario(input.defaultScenario, scenarios)
    if (!validation.ok) throw new BadRequest(validation.error)
    patch.defaultScenario = input.defaultScenario.trim()
  }
  if (input.agents !== undefined && input.scenarios === undefined) {
    // An agents-only patch must not orphan the agents referenced by the saved
    // scenarios; otherwise the panel would be unable to save the scenarios later.
    for (const scenario of currentLauncher.scenarios) {
      const validation = validateScenario(scenario, patch.agents)
      if (!validation.ok) {
        throw new BadRequest(`agents: ${validation.error}; the saved scenarios still use it`)
      }
    }
  }
  return patch
}
