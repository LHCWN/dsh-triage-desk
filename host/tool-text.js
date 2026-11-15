/**
 * Triage Desk — plain-text rendering of a snapshot for the `triage_desk` tool.
 */

import { SECTION_IDS } from '../github.js'

export function formatToolText(snapshot, wanted) {
  if (snapshot === null || snapshot === undefined) return 'No snapshot is available yet.'
  if (snapshot.status === 'error' && snapshot.error) {
    return `GitHub attention snapshot failed: ${snapshot.error.code} — ${snapshot.error.message}`
  }
  const lines = []
  const counts = snapshot.counts || {}
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : []
  const sourceLabel = (source) => (source.kind === 'user' ? 'personal' : source.login)
  const header = sources.length > 0 ? sources.map(sourceLabel).join(' + ') : 'no sources'
  lines.push(`Triage Desk — ${header} — ${counts.total || 0} item(s) at ${snapshot.generatedAt}`)
  const parts = []
  for (const id of SECTION_IDS) parts.push(`${id}: ${counts[id] || 0}`)
  lines.push(parts.join(' · '))
  let printed = 0
  for (const section of snapshot.sections || []) {
    if (wanted !== null && !wanted.has(section.id)) continue
    if (section.items.length === 0) continue
    lines.push('')
    lines.push(`## ${section.id} (${section.items.length})`)
    for (const item of section.items) {
      printed += 1
      const number = item.kind === 'branch' ? item.ref : `#${item.number}`
      const label = item.kind === 'branch' ? 'branch checks' : item.title
      const tag = item.source ? `[${sourceLabel(item.source)}] ` : ''
      lines.push(`- ${tag}${item.repo} ${number} — ${label} [${item.reason}] ${item.url}`)
    }
  }
  if (printed === 0) lines.push('', 'Nothing needs your attention right now.')
  if (Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0) {
    lines.push('', `Warnings: ${snapshot.warnings.map((entry) => entry.message).join('; ')}`)
  }
  return lines.join('\n')
}
