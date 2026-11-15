/**
 * Triage Desk launcher — launch scenarios: section and reason vocabulary,
 * built-in scenarios and their titles, lenient normalization of saved
 * scenarios, and strict validation for the config-save path.
 */

import { AGENT_ID_PATTERN } from './agents.js'

export const DEFAULT_SCENARIO_ID = 'link'
export const MAX_SCENARIOS = 30
export const MAX_SCENARIO_LABEL = 60
export const MAX_SCENARIO_TEMPLATE = 4000

export const SCENARIO_SECTION_IDS = ['review', 'rereview', 'merge', 'respond', 'ci', 'issues']

/** English labels used in generated prompt blocks and for `{section}`. */
export const SCENARIO_SECTION_LABELS = {
  review: 'awaiting my review',
  rereview: 're-review after changes',
  merge: 'ready to merge',
  respond: 'needs my action',
  ci: 'failing CI',
  issues: 'issues',
}

/** English labels for snapshot reason codes; unknown codes fall back to the code. */
export const SCENARIO_REASON_LABELS = {
  'review-requested': 'my review requested',
  'team-review-requested': 'team review requested',
  'changes-after-my-review': 'new commits since my review',
  'author-replied': 'author replied to me',
  're-review-requested': 'author re-requested my review',
  'ready-to-merge': 'approved and ready to merge',
  'approved-checks-failing': 'approved but CI is failing',
  'changes-requested': 'changes requested',
  conflict: 'merge conflict',
  'review-feedback': 'review feedback needs changes',
  mentioned: 'I was mentioned',
  'checks-failing': 'checks are failing',
  'branch-checks-failing': 'branch checks are failing',
  'assigned-to-you': 'assigned to me',
  'new-unassigned': 'new unassigned issue',
}

export const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Built-in named launch recipes. `scope: 'item'` runs once per row in a single
 * local clone; `scope: 'section'` runs once for a whole section and hands the
 * agent a prompt listing every item. Every built-in prompt may be edited by the
 * user; `defaultScenarios` is the source of the editable defaults.
 */
export const BUILTIN_SCENARIOS = [
  {
    id: 'link',
    scope: 'item',
    sections: SCENARIO_SECTION_IDS.slice(),
    prompt: '{url}',
    agent: 'default',
  },
  {
    id: 'review-pr',
    scope: 'item',
    sections: ['review'],
    prompt: `Review the pull request {url}.

Act as a strict senior reviewer: read the diff and the surrounding code, then report blocking issues first, then nitpicks. Check tests, error handling, edge cases, security, and consistency with the repository conventions. Do not change code, post comments, or approve anything; show me your findings so I can decide.`,
    agent: 'default',
  },
  {
    id: 'rereview-pr',
    scope: 'item',
    sections: ['rereview'],
    prompt: `Re-review the pull request {url}.

Look only at what changed since my previous review: new commits and replies addressed to me. Report only new concerns and whether my earlier blockers are resolved. Do not repeat old findings, change code, or post anything.`,
    agent: 'default',
  },
  {
    id: 'fix-pr',
    scope: 'item',
    sections: ['merge', 'ci'],
    prompt: `Fix the pull request {url}.

Find why it cannot be merged: failing checks or conflicts. Make the minimal changes needed, run the relevant tests and checks, and explain what you changed. Do not push, merge, or publish comments without my explicit confirmation.`,
    agent: 'default',
  },
  {
    id: 'reply-thread',
    scope: 'item',
    sections: ['respond'],
    prompt: `Draft a reply in the review thread {url}.

Read the conversation, answer the reviewer's or author's question precisely, and suggest a concrete code change if needed. Reply in the language of the thread. Show me the draft before posting anything.`,
    agent: 'default',
  },
  {
    id: 'triage-issue',
    scope: 'item',
    sections: ['issues'],
    prompt: `Triage the issue {url}.

Understand the problem, find the affected code, estimate the scope, and propose a plan with open questions. Do not change code yet; summarize what you found and what you would do next.`,
    agent: 'default',
  },
  {
    id: 'review-all',
    scope: 'section',
    sections: ['review', 'rereview'],
    prompt: `Review every pull request listed below that is waiting for my attention.

Delegate each pull request to a separate sub-agent with its own isolated context, collect their reviews, and give me one prioritized report: blocking issues first, then questions and nitpicks. Do not change code, post comments, or approve anything without my confirmation.
{links}`,
    agent: 'default',
  },
  {
    id: 'fix-mine',
    scope: 'section',
    sections: ['merge', 'ci'],
    prompt: `Fix my pull requests listed below.

Work through them one by one, isolating each pull request in its own sub-agent or worktree. Fix failing checks and merge conflicts with minimal changes, run the relevant tests, and report per pull request what you changed. Do not push, merge, or comment without my explicit confirmation.
{links}`,
    agent: 'default',
  },
  {
    id: 'triage-new',
    scope: 'section',
    sections: ['issues'],
    prompt: `Triage the new issues listed below.

Group them by area and priority, flag duplicates or unclear reports, and for each propose the next step and the questions to ask. Delegate per-issue analysis to separate sub-agents. Do not change code or post replies.
{links}`,
    agent: 'default',
  },
  {
    id: 'reply-mentions',
    scope: 'section',
    sections: ['respond'],
    prompt: `Draft replies for the threads and mentions listed below.

For each item, read the conversation, produce a short draft reply in the thread's language, and show all drafts to me before posting anything. Delegate each thread to a separate sub-agent with its own isolated context, then give me the drafts together.
{links}`,
    agent: 'default',
  },
]

/** Short English titles used for terminal window titles. */
export const BUILTIN_SCENARIO_TITLES = {
  link: 'Just the link',
  'review-pr': 'Review this PR',
  'rereview-pr': 'Re-review this PR',
  'fix-pr': 'Fix this PR',
  'reply-thread': 'Reply in the thread',
  'triage-issue': 'Triage this issue',
  'review-all': 'Review everything awaiting me',
  'fix-mine': 'Fix my PRs',
  'triage-new': 'Triage new issues',
  'reply-mentions': 'Answer mentions',
}

const BUILTIN_SCENARIO_MAP = new Map(BUILTIN_SCENARIOS.map((entry) => [entry.id, entry]))

/** LF-only prompt text without NUL bytes, trimmed. */
function normalizePromptText(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
}

/** Fresh editable copies of the built-in scenarios. */
export function defaultScenarios() {
  return BUILTIN_SCENARIOS.map((entry) => ({
    id: entry.id,
    label: '',
    scope: entry.scope,
    sections: entry.sections.slice(),
    prompt: entry.prompt,
    agent: entry.agent,
    enabled: true,
  }))
}

const AGENT_ID_PLACEHOLDER = 'default'

/**
 * Lenient normalization for hand-edited config: never throws, drops entries it
 * cannot repair, and always keeps the protected `link` scenario first.
 */
export function normalizeScenarios(input) {
  try {
    if (!Array.isArray(input) || input.length === 0) return defaultScenarios()
    const scenarios = []
    const seen = new Set()
    for (const raw of input) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
      if (!SCENARIO_ID_PATTERN.test(id) || seen.has(id)) continue
      seen.add(id)
      const builtin = BUILTIN_SCENARIO_MAP.get(id)
      const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, MAX_SCENARIO_LABEL) : ''
      if (builtin === undefined && label === '') continue
      const scope = raw.scope === 'section' ? 'section' : 'item'
      const sections = []
      if (Array.isArray(raw.sections)) {
        for (const section of raw.sections) {
          if (typeof section !== 'string') continue
          if (!SCENARIO_SECTION_IDS.includes(section) || sections.includes(section)) continue
          sections.push(section)
        }
      }
      if (sections.length === 0) {
        sections.push(...(builtin !== undefined ? builtin.sections : SCENARIO_SECTION_IDS))
      }
      let prompt = typeof raw.prompt === 'string' ? normalizePromptText(raw.prompt) : ''
      if (prompt === '' || prompt.length > MAX_SCENARIO_TEMPLATE) {
        if (builtin === undefined) continue
        prompt = builtin.prompt
      }
      let agent = typeof raw.agent === 'string' ? raw.agent.trim().toLowerCase() : AGENT_ID_PLACEHOLDER
      if (agent === '') agent = AGENT_ID_PLACEHOLDER
      if (agent !== AGENT_ID_PLACEHOLDER && !AGENT_ID_PATTERN.test(agent)) {
        agent = AGENT_ID_PLACEHOLDER
      }
      const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
      scenarios.push({ id, label, scope, sections, prompt, agent, enabled })
      if (scenarios.length >= MAX_SCENARIOS) break
    }
    for (const entry of scenarios) {
      if (entry.id === DEFAULT_SCENARIO_ID) entry.scope = 'item'
    }
    let link = scenarios.find((entry) => entry.id === DEFAULT_SCENARIO_ID)
    if (link === undefined) {
      link = defaultScenarios().find((entry) => entry.id === DEFAULT_SCENARIO_ID)
      scenarios.unshift(link)
      if (scenarios.length > MAX_SCENARIOS) scenarios.length = MAX_SCENARIOS
    } else {
      scenarios.splice(scenarios.indexOf(link), 1)
      scenarios.unshift(link)
    }
    link.enabled = true
    if (!link.prompt.includes('{url}')) link.prompt = BUILTIN_SCENARIO_MAP.get(DEFAULT_SCENARIO_ID).prompt
    return scenarios
  } catch {
    return defaultScenarios()
  }
}

/** Agent ids accepted by a scenario: the placeholders plus every configured id. */
function scenarioAgentIds(agents) {
  const ids = new Set([AGENT_ID_PLACEHOLDER])
  for (const entry of Array.isArray(agents) ? agents : []) {
    if (typeof entry === 'string') ids.add(entry)
    else if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') ids.add(entry.id)
  }
  return ids
}

/**
 * Strict validation for the config-save path (the client shows the error).
 * Returns `{ok:true}` or `{ok:false, error}`.
 */
export function validateScenario(scenario, agents) {
  const input = scenario !== null && typeof scenario === 'object' && !Array.isArray(scenario) ? scenario : null
  if (input === null) return { ok: false, error: 'each scenario must be an object' }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!SCENARIO_ID_PATTERN.test(id)) return { ok: false, error: `invalid scenario id "${id}"` }
  const builtin = BUILTIN_SCENARIO_MAP.has(id)
  if (typeof input.label !== 'string') return { ok: false, error: `scenario "${id}": label must be a string` }
  const label = input.label.trim()
  if (label.length > MAX_SCENARIO_LABEL) {
    return { ok: false, error: `scenario "${id}": label must be up to ${MAX_SCENARIO_LABEL} characters` }
  }
  if (!builtin && label === '') return { ok: false, error: `scenario "${id}": a custom scenario needs a label` }
  if (input.scope !== 'item' && input.scope !== 'section') {
    return { ok: false, error: `scenario "${id}": scope must be "item" or "section"` }
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    return { ok: false, error: `scenario "${id}": choose at least one section` }
  }
  if (input.sections.length > SCENARIO_SECTION_IDS.length) {
    return { ok: false, error: `scenario "${id}": at most ${SCENARIO_SECTION_IDS.length} sections are allowed` }
  }
  const seenSections = new Set()
  for (const section of input.sections) {
    if (typeof section !== 'string' || !SCENARIO_SECTION_IDS.includes(section)) {
      return { ok: false, error: `scenario "${id}": invalid section "${String(section)}"` }
    }
    if (seenSections.has(section)) return { ok: false, error: `scenario "${id}": duplicate section "${section}"` }
    seenSections.add(section)
  }
  if (typeof input.prompt !== 'string') return { ok: false, error: `scenario "${id}": prompt must be a string` }
  if (input.prompt.includes('\u0000')) return { ok: false, error: `scenario "${id}": prompt must not contain NUL bytes` }
  const prompt = normalizePromptText(input.prompt)
  if (prompt === '') return { ok: false, error: `scenario "${id}": prompt must not be empty` }
  if (prompt.length > MAX_SCENARIO_TEMPLATE) {
    return { ok: false, error: `scenario "${id}": prompt must be up to ${MAX_SCENARIO_TEMPLATE} characters` }
  }
  const agent = typeof input.agent === 'string' ? input.agent.trim() : ''
  if (!scenarioAgentIds(agents).has(agent)) {
    return { ok: false, error: `scenario "${id}": agent must be "default" or a configured agent id` }
  }
  if (typeof input.enabled !== 'boolean') return { ok: false, error: `scenario "${id}": enabled must be a boolean` }
  if (id === DEFAULT_SCENARIO_ID) {
    if (input.scope !== 'item') return { ok: false, error: `scenario "${DEFAULT_SCENARIO_ID}" must stay a row scenario` }
    if (input.enabled !== true) return { ok: false, error: `scenario "${DEFAULT_SCENARIO_ID}" must stay enabled` }
    if (!prompt.includes('{url}')) return { ok: false, error: `scenario "${DEFAULT_SCENARIO_ID}" must contain {url}` }
  }
  return { ok: true }
}

/** Validates that a default scenario id exists and is an item scenario. */
export function validateDefaultScenario(id, scenarios) {
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'defaultScenario must be a scenario id' }
  }
  const wanted = id.trim()
  const list = Array.isArray(scenarios) ? scenarios : []
  const scenario = list.find((entry) => entry !== null && entry !== undefined && entry.id === wanted)
  if (scenario === undefined) return { ok: false, error: `defaultScenario: unknown scenario "${wanted}"` }
  if (scenario.scope !== 'item') {
    return { ok: false, error: `defaultScenario: scenario "${wanted}" is not an item scenario` }
  }
  if (scenario.enabled === false) {
    return { ok: false, error: `defaultScenario: scenario "${wanted}" is disabled` }
  }
  return { ok: true }
}

/** Terminal title for a scenario: its label, then the builtin English title, then its id. */
export function scenarioTitle(scenario) {
  const label = scenario !== null && typeof scenario === 'object' && typeof scenario.label === 'string'
    ? scenario.label.trim()
    : ''
  if (label !== '') return label
  const id = scenario !== null && typeof scenario === 'object' && typeof scenario.id === 'string' ? scenario.id : ''
  return BUILTIN_SCENARIO_TITLES[id] || id
}
