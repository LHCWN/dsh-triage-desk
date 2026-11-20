/**
 * Triage Desk launcher — agent presets, the "Find agents" catalogue, and
 * normalization of the saved agent list.
 */

import { DRAFT_FLAG_PATTERN, hasSafePromptPlaceholder } from './agent-command.js'

export const MAX_AGENTS = 12
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MAX_AGENT_LABEL = 60
export const MAX_AGENT_COMMAND = 300

/** Agents that are safe to launch interactively with an initial prompt. */
export const AGENT_PRESETS = [
  { id: 'claude', label: 'Claude Code', command: 'claude {prompt}', draftFlag: '--prefill' },
  { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
  { id: 'opencode', label: 'opencode', command: 'opencode --prompt {prompt}' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini {prompt}' },
  { id: 'cursor-agent', label: 'Cursor Agent', command: 'cursor-agent {prompt}' },
  { id: 'agy', label: 'Antigravity', command: 'agy {prompt}' },
  { id: 'pi', label: 'pi', command: 'pi {prompt}' },
]

/**
 * Agents the "Find agents" scan looks for on the machine. Built-in presets are
 * included, plus a few common CLIs added with their plain interactive command;
 * discovered entries can be edited in Settings afterwards.
 */
export const DISCOVERABLE_AGENTS = [
  ...AGENT_PRESETS,
  { id: 'aider', label: 'Aider', command: 'aider {prompt}' },
  { id: 'amp', label: 'Amp', command: 'amp {prompt}' },
  { id: 'droid', label: 'Droid', command: 'droid {prompt}' },
  { id: 'goose', label: 'Goose', command: 'goose {prompt}' },
  { id: 'crush', label: 'Crush', command: 'crush {prompt}' },
]

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
  // is renamed like a duplicate.
  const seen = new Set([DSH_TARGET])
  for (let index = 0; index < source.length && agents.length < MAX_AGENTS; index += 1) {
    const entry = source[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const command = typeof entry.command === 'string' ? entry.command.trim().slice(0, MAX_AGENT_COMMAND) : ''
    const rawId = normalizeAgentId(entry.id, index)
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
  }
}
