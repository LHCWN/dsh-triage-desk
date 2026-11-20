/**
 * Triage Desk launcher — agent presets, the "Find agents" catalogue, and
 * normalization of the saved agent list.
 */

import { DRAFT_FLAG_PATTERN, hasSafePromptPlaceholder } from './agent-command.js'

export const MAX_AGENTS = 12
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MAX_AGENT_LABEL = 60
export const MAX_AGENT_COMMAND = 300

/**
 * Agents that are safe to launch interactively with an initial prompt. Like
 * Orca's "Full access" mode, each command carries the agent's own flag for
 * skipping permission prompts (opencode and pi have none); remove it in
 * Settings to get the agent's prompts back.
 */
export const AGENT_PRESETS = [
  { id: 'claude', label: 'Claude Code', command: 'claude --dangerously-skip-permissions {prompt}', draftFlag: '--prefill' },
  { id: 'codex', label: 'Codex', command: 'codex --dangerously-bypass-approvals-and-sandbox {prompt}' },
  { id: 'opencode', label: 'opencode', command: 'opencode --prompt {prompt}' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini --yolo {prompt}' },
  { id: 'cursor-agent', label: 'Cursor Agent', command: 'cursor-agent --yolo {prompt}' },
  { id: 'agy', label: 'Antigravity', command: 'agy --dangerously-skip-permissions {prompt}' },
  { id: 'pi', label: 'pi', command: 'pi {prompt}' },
]

/**
 * Agents the "Find agents" scan looks for on the machine. Built-in presets are
 * included, plus a few common CLIs with their full-access flag (Goose takes it
 * from an environment variable, which a Windows launch cannot set, so it has
 * none); discovered entries can be edited in Settings afterwards.
 */
export const DISCOVERABLE_AGENTS = [
  ...AGENT_PRESETS,
  { id: 'aider', label: 'Aider', command: 'aider --yes-always {prompt}' },
  { id: 'amp', label: 'Amp', command: 'amp --dangerously-allow-all {prompt}' },
  { id: 'droid', label: 'Droid', command: 'droid --auto high {prompt}' },
  { id: 'goose', label: 'Goose', command: 'goose {prompt}' },
  { id: 'crush', label: 'Crush', command: 'crush --yolo {prompt}' },
]

/**
 * Earlier default commands (0.1.0 – 0.1.3), by agent id. A saved agent whose
 * command still equals its old default was never edited, so normalization
 * upgrades it to the current one; edited commands are kept.
 */
export const LEGACY_AGENT_COMMANDS = {
  claude: 'claude {prompt}',
  codex: 'codex {prompt}',
  gemini: 'gemini {prompt}',
  'cursor-agent': 'cursor-agent {prompt}',
  agy: 'agy {prompt}',
  aider: 'aider {prompt}',
  amp: 'amp {prompt}',
  droid: 'droid {prompt}',
  crush: 'crush {prompt}',
}

const DISCOVERABLE_COMMANDS = new Map(DISCOVERABLE_AGENTS.map((agent) => [agent.id, agent.command]))

/** The current default command of a known agent id, or undefined. */
export function defaultAgentCommand(id) {
  return DISCOVERABLE_COMMANDS.get(id)
}

function normalizeAgentId(value, fallbackIndex) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (AGENT_ID_PATTERN.test(text)) return text
  return 'agent-' + String(fallbackIndex + 1)
}

/**
 * The default launch target meaning "a new DSH chat" (the panel opens it with
 * the prompt); a new profile starts with it. Not an agent id: AGENT_ID_PATTERN
 * allows "dsh", so normalizeAgentConfig keeps it out of the agent list.
 */
export const DSH_TARGET = 'dsh'

/** The agents detection found on this machine, in list order. */
export function installedAgents(agents, detected = {}) {
  return agents.filter((agent) => detected[agent.id] && detected[agent.id].available === true)
}

/**
 * The agent a launch the host runs uses for "default". The host cannot open a
 * DSH chat, and a saved agent detection reports missing cannot start, so both
 * use the first agent detection found. With nothing found, a saved agent
 * stays, so the launch can say it is missing; DSH tries the first agent not
 * known to be missing (a failed probe reports every agent unknown), and only
 * when every agent is known missing does it stay DSH, which the launch
 * explains.
 */
export function effectiveDefaultAgent(defaultAgent, agents, detected = {}) {
  const status = detected[defaultAgent]
  if (defaultAgent !== DSH_TARGET && (!status || status.available !== false)) return defaultAgent
  const [found] = installedAgents(agents, detected)
  if (found) return found.id
  if (defaultAgent !== DSH_TARGET) return defaultAgent
  const untried = agents.find((agent) => !(detected[agent.id] && detected[agent.id].available === false))
  return untried ? untried.id : DSH_TARGET
}

/**
 * What the panel opens for "default": the saved agent while detection does
 * not report it missing, else a new DSH chat. The panel uses
 * effectiveDefaultAgent instead when it cannot open DSH.
 */
export function panelDefaultTarget(defaultAgent, detected = {}) {
  const status = detected[defaultAgent]
  return defaultAgent !== DSH_TARGET && (!status || status.available !== false) ? defaultAgent : DSH_TARGET
}

/**
 * Effective agent list plus the saved agents that were set aside. A saved
 * agent whose command breaks the current prompt rule is never launched, but
 * it is reported (`invalidAgents`, reason `placeholder`) instead of vanishing,
 * so Settings can show it for repair. When no saved agent is usable the presets
 * are used; `invalidAgents` still lists every rejected entry.
 */
export function normalizeAgentConfig(value) {
  const source = Array.isArray(value) ? value : AGENT_PRESETS
  const agents = []
  const invalidAgents = []
  // DSH_TARGET is reserved for the DSH launch target: an agent named "dsh"
  // (valid before 0.1.3) is renamed like a duplicate, and `renamed` maps it
  // so its saved references can follow.
  const seen = new Set([DSH_TARGET])
  const renamed = {}
  for (let index = 0; index < source.length && agents.length < MAX_AGENTS; index += 1) {
    const entry = source[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rawId = normalizeAgentId(entry.id, index)
    let command = typeof entry.command === 'string' ? entry.command.trim().slice(0, MAX_AGENT_COMMAND) : ''
    // An empty command on a known agent is its current default (Settings saves
    // an unedited one that way); a pre-0.1.4 default is upgraded the same way.
    if (DISCOVERABLE_COMMANDS.has(rawId) && (command === '' || command === LEGACY_AGENT_COMMANDS[rawId])) {
      command = DISCOVERABLE_COMMANDS.get(rawId)
    }
    const labelFor = (id) =>
      (typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : id).slice(0, MAX_AGENT_LABEL)
    if (!hasSafePromptPlaceholder(command)) {
      if (invalidAgents.length < MAX_AGENTS) {
        invalidAgents.push({ id: rawId, label: labelFor(rawId), command, reason: 'placeholder' })
      }
      continue
    }
    let id = rawId
    while (seen.has(id)) id = id + '-' + String(index + 1)
    if (rawId === DSH_TARGET) renamed[DSH_TARGET] = id
    seen.add(id)
    const preset = AGENT_PRESETS.find((candidate) => candidate.id === id)
    const draftFlag =
      typeof entry.draftFlag === 'string' && DRAFT_FLAG_PATTERN.test(entry.draftFlag)
        ? entry.draftFlag
        : preset?.draftFlag
    agents.push({ id, label: labelFor(id), command, ...(draftFlag ? { draftFlag } : {}) })
  }
  return {
    agents: agents.length > 0 ? agents : AGENT_PRESETS.map((preset) => ({ ...preset })),
    invalidAgents,
    renamed,
  }
}
