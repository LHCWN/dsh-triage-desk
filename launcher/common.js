/**
 * Triage Desk launcher — small shared helpers with no launcher-domain
 * dependencies: plain-object coercion, `~` expansion, and flattening of
 * untrusted GitHub text for prompts and terminal titles.
 */

import os from 'node:os'
import path from 'node:path'

export const MAX_CLONE_TITLE = 90

const MAX_WIDTH = 200

export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

/** Flattens untrusted GitHub text into one line of bounded length. */
export function sanitizePromptValue(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_WIDTH) text = text.slice(0, MAX_WIDTH - 1).trimEnd() + '…'
  return text
}

/** Terminal window title: flattened, capped at MAX_CLONE_TITLE, never empty. */
export function terminalTitle(title) {
  return sanitizePromptValue(title).slice(0, MAX_CLONE_TITLE) || 'Triage Desk'
}
