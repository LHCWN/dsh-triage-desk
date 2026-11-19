/**
 * Paste assertions shared by dev/smoke-paste.mjs and dev/smoke-windows.mjs,
 * over the result dev/fixtures/fake-agent.mjs records.
 */
import assert from 'node:assert/strict'

/**
 * Asserts the agent got `text` as one bracketed paste, with nothing typed
 * before it and no Enter after it. `context` is appended to the missing-paste
 * message. Returns the paste event.
 */
export function assertUnsentPaste(recorded, text, context = '') {
  const paste = recorded.events.find((event) => event.type === 'paste')
  assert.ok(paste, 'the agent received a paste: ' + JSON.stringify(recorded) + context)
  assert.equal(paste.text, text, 'the paste is the prompt, byte for byte')
  assert.equal(paste.before, '', 'nothing is typed before the paste')
  // The first end marker closes the paste: `text` has none of its own.
  assert.ok(!/[\r\n]$/.test(recorded.input.slice(recorded.input.indexOf('\x1b[201~') + 6)), 'no Enter after the paste')
  return paste
}
