/**
 * Triage Desk — JSON helpers for the exact web routes.
 */

import { BadRequest } from './errors.js'

export const REQUEST_BODY_LIMIT = 64 * 1024
export const CONFIG_BODY_LIMIT = 256 * 1024

export const jsonResponse = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

export const readJsonBody = (req, limit = REQUEST_BODY_LIMIT) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BadRequest('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch {
        reject(new BadRequest('request body is not valid JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })

/** An editor launch carries the original request plus JSON-escaped draft text. */
export async function readLaunchBody(req, maxDraftLength) {
  const body = await readJsonBody(req, REQUEST_BODY_LIMIT + 6 * maxDraftLength + 32)
  if (body && typeof body === 'object') {
    const { draft, ...context } = body
    if (Buffer.byteLength(JSON.stringify(context)) > REQUEST_BODY_LIMIT) {
      throw new BadRequest('request body is too large')
    }
    if (draft !== undefined && typeof draft !== 'string') throw new BadRequest('draft must be text')
  }
  return body
}

export const sendJson = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

const MAX_FIND_COMMANDS = 50
const MAX_FIND_COMMAND_LENGTH = 300

/**
 * The optional `{ commands: string[] }` body of POST /triage-desk/agents/find.
 * An oversized or non-JSON body is a BadRequest, like on every other route
 * (an older client sends no body, which reads as {}). Otherwise invalid input
 * is ignored: a non-array or more than 50 entries yield [], and non-string or
 * over-long (> 300 characters) entries are dropped.
 */
export const readFindCommands = async (req) => {
  const body = await readJsonBody(req)
  const commands = body !== null && typeof body === 'object' ? body.commands : undefined
  if (!Array.isArray(commands) || commands.length > MAX_FIND_COMMANDS) return []
  return commands.filter((command) => typeof command === 'string' && command.length <= MAX_FIND_COMMAND_LENGTH)
}
