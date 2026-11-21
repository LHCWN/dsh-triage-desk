/**
 * Triage Desk launcher — prompt rendering: item tokens, the section `{links}`
 * block, and size-bounded rendering of a scenario prompt.
 */

import { asObject, sanitizePromptValue } from './common.js'
import { parseRepoUrl } from './repo-urls.js'
import { SCENARIO_REASON_LABELS, SCENARIO_SECTION_IDS, SCENARIO_SECTION_LABELS } from './scenarios.js'

export const MAX_RENDERED_PROMPT = 16_000

/** Login of an item author, which is either a login string or a user object. */
function itemAuthorLogin(item) {
  const author = asObject(item).author
  if (typeof author === 'string') return author
  if (author !== null && typeof author === 'object' && typeof author.login === 'string') return author.login
  return ''
}

export function promptVars(item) {
  const input = asObject(item)
  const parsed = parseRepoUrl(input.url)
  if (parsed === null) return null
  let canonical = input.url.trim()
  try {
    canonical = new URL(canonical).href
  } catch {
    return null
  }
  return {
    url: sanitizePromptValue(canonical),
    repo: parsed.slug,
    owner: parsed.owner,
    name: parsed.name,
    number: sanitizePromptValue(input.number) || parsed.number,
    title: sanitizePromptValue(input.title),
    branch: sanitizePromptValue(input.headRefName),
    kind: sanitizePromptValue(input.kind),
    ref: sanitizePromptValue(input.ref),
    author: sanitizePromptValue(itemAuthorLogin(input)),
    reason: sanitizePromptValue(input.reason),
  }
}

function canonicalUrl(value) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value.trim()).href
  } catch {
    return null
  }
}

function isPromptItem(item) {
  return parseRepoUrl(asObject(item).url) !== null
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10)
}

function reasonLabel(value) {
  const code = sanitizePromptValue(value)
  if (code === '') return ''
  return SCENARIO_REASON_LABELS[code] || code
}

function sectionLabels(items) {
  const labels = []
  for (const id of SCENARIO_SECTION_IDS) {
    if (items.some((item) => asObject(item).section === id)) labels.push(SCENARIO_SECTION_LABELS[id])
  }
  return labels
}

/** One markdown bullet for an item, or null when it has no usable GitHub URL. */
function itemBullet(item) {
  const input = asObject(item)
  const url = canonicalUrl(input.url)
  if (url === null) return null
  const parsed = parseRepoUrl(url)
  if (parsed === null) return null
  const repo = parsed.slug
  const title = sanitizePromptValue(input.title) || repo
  const number = sanitizePromptValue(input.number === undefined || input.number === null ? '' : input.number)
  const kind = sanitizePromptValue(input.kind)
  let target = repo
  if (kind === 'branch') {
    const ref = sanitizePromptValue(input.ref)
    if (ref !== '') target += ' branch ' + ref
  } else if (number !== '') {
    target += '#' + number
  }
  let line = `- [${title}](${url}) — ${target}`
  const author = sanitizePromptValue(itemAuthorLogin(input))
  if (author !== '') line += ', author ' + author
  const reason = reasonLabel(input.reason)
  if (reason !== '') line += ', reason: ' + reason
  return line
}

function itemsHeader(items, shown, total) {
  const labels = sectionLabels(items)
  const sections = labels.length > 0 ? labels.join(' + ') : 'unknown'
  const count = shown < total ? `first ${shown} of ${total}` : String(total)
  return `Items: ${count} · sections: ${sections} · date: ${todayStamp()}`
}

function itemsBlock(items, limit) {
  const total = items.length
  const shown = Math.max(0, Math.min(Number.isInteger(limit) ? limit : total, total))
  const lines = [itemsHeader(items, shown, total)]
  if (shown > 0) {
    lines.push('')
    for (let index = 0; index < shown; index += 1) {
      const bullet = itemBullet(items[index])
      if (bullet !== null) lines.push(bullet)
    }
  }
  return { text: lines.join('\n'), shown, total }
}

/**
 * English item list for section prompts: a header line with the section labels
 * and the date, then one markdown bullet per item. Items without a usable
 * GitHub URL are skipped.
 */
export function buildItemsBlock(items) {
  const source = Array.isArray(items) ? items : []
  const usable = source.filter((item) => isPromptItem(item))
  const block = itemsBlock(usable, usable.length)
  return { text: block.text, shown: block.shown, total: block.total }
}

const SCENARIO_TOKEN_PATTERN = /\{([A-Za-z0-9_-]+)\}/g

/**
 * Replaces only tokens that have a value; any other `{...}` text is kept as-is.
 * The substitution is done in one pass, so rendered values (item titles, links
 * blocks) are never scanned for more tokens.
 */
function renderScenarioTemplate(template, vars) {
  return String(template).replace(SCENARIO_TOKEN_PATTERN, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  )
}

function codePointLength(text) {
  return Array.from(text).length
}

/** Truncates by Unicode code points without splitting surrogate pairs. */
function truncatePrompt(text) {
  const points = Array.from(text)
  if (points.length <= MAX_RENDERED_PROMPT) return text
  return points.slice(0, MAX_RENDERED_PROMPT).join('') + '…'
}

function scenarioSectionLabel(context, items) {
  const wanted = context !== null && typeof context === 'object' && typeof context.section === 'string'
    ? context.section.trim()
    : ''
  if (SCENARIO_SECTION_LABELS[wanted] !== undefined) return SCENARIO_SECTION_LABELS[wanted]
  const labels = sectionLabels(items)
  if (labels.length > 0) return labels.join(' + ')
  return 'unknown'
}

/**
 * Renders a scenario prompt for one item or for a section item list.
 * Returns `{prompt, trimmed}` where `trimmed` is `{shown, total}` only when
 * section bullets had to be dropped to stay under `MAX_RENDERED_PROMPT`.
 */
export function buildScenarioPrompt(scenario, context) {
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error('a scenario is required')
  }
  if (scenario.scope !== 'item' && scenario.scope !== 'section') throw new Error('the scenario scope is invalid')
  const template = typeof scenario.prompt === 'string' ? scenario.prompt : ''
  const input = context !== null && typeof context === 'object' ? context : {}

  if (scenario.scope === 'item') {
    const item = input.item
    if (item === null || item === undefined) throw new Error('an item scenario needs an item')
    const vars = promptVars(item)
    if (vars === null) throw new Error('the item has no GitHub URL')
    const block = buildItemsBlock([item]).text
    const rendered = renderScenarioTemplate(template, { ...vars, links: block, count: '1', date: todayStamp() })
    let text = rendered.trim()
    if (text === '') text = block
    else if (!template.includes('{url}') && !template.includes('{links}')) text = text + '\n\n' + block
    return { prompt: truncatePrompt(text), trimmed: null }
  }

  if (!Array.isArray(input.items)) throw new Error('a section scenario needs an item list')
  const items = input.items.filter((item) => isPromptItem(item))
  const total = items.length
  const hasLinks = template.includes('{links}')
  const vars = {
    section: scenarioSectionLabel(input, items),
    date: todayStamp(),
  }
  const render = (shown) => {
    const block = itemsBlock(items, shown)
    let text = renderScenarioTemplate(template, { ...vars, count: String(shown), links: block.text }).trim()
    if (!hasLinks) text = text === '' ? block.text : text + '\n\n' + block.text
    if (shown < total) {
      const omitted = total - shown
      text =
        (text === '' ? '' : text + '\n\n') +
        `${omitted} more item(s) were omitted to fit the prompt limit; narrow the filter to include them.`
    }
    return text
  }
  if (total === 0) return { prompt: truncatePrompt(render(0)), trimmed: null }
  for (let shown = total; shown >= 0; shown -= 1) {
    const text = render(shown)
    if (codePointLength(text) <= MAX_RENDERED_PROMPT) {
      return { prompt: text, trimmed: shown < total ? { shown, total } : null }
    }
  }
  // Even the template without bullets exceeds the limit. Keep the batch
  // header intact so the draft still reports exactly what it contains.
  return { prompt: itemsHeader(items, 0, total), trimmed: { shown: 0, total } }
}
