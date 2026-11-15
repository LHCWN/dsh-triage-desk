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
  const seen = new Set()
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
