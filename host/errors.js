/**
 * Triage Desk — host error types shared by the config sanitizers, the launch
 * glue and the routes.
 */

/**
 * A rejected request body. `data` carries optional structured fields that the
 * config route merges into its 400 error (e.g. `{ code: 'invalid-agent', agent }`).
 */
export class BadRequest extends Error {
  constructor(message, data) {
    super(message)
    this.data = data && typeof data === 'object' ? data : null
  }
}

export class LaunchError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data && typeof data === 'object' ? data : {}
  }
}

/** The message of a thrown value, whether or not it is an Error. */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export const LAUNCH_ERROR_STATUS = {
  'bad-url': 400,
  'bad-path': 400,
  'bad-scenario': 400,
  'scan-failed': 500,
  'unknown-agent': 400,
  'bad-prompt': 400,
  'agent-missing': 400,
  'clone-missing': 409,
  'not-a-repo': 409,
  'clipboard-failed': 502,
  'open-failed': 502,
  'picker-unavailable': 501,
  'pick-failed': 500,
  'not-a-github-clone': 409,
}

/** HTTP status for a LaunchError code, `fallback` for codes without one. */
export function launchErrorStatus(code, fallback) {
  return LAUNCH_ERROR_STATUS[code] || fallback
}
