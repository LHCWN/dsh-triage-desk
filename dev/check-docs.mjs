/**
 * Checks that relative Markdown links/images in the shipped READMEs resolve,
 * including `#section` anchors into Markdown files.
 * Run by `npm run check:docs` and as part of `npm run check`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const files = ['README.md', 'README.zh.md']
const failures = []

// GitHub heading anchors: lower case, punctuation dropped, spaces to hyphens,
// repeated headings suffixed -1, -2, ….
const anchorsOf = (resolved) => {
  const seen = new Map()
  const anchors = new Set()
  let fenced = false
  for (const line of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading === null) continue
    const base = heading[1].toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|#|<)/i.test(target)) continue
    const [pathPart, fragment] = target.split('#')
    const clean = decodeURIComponent(pathPart)
    if (clean === '') continue
    const resolved = path.resolve(root, clean)
    if (!fs.existsSync(resolved)) {
      failures.push(`${file}: missing ${target}`)
      continue
    }
    if (fragment !== undefined && /\.md$/i.test(clean) && !anchorsOf(resolved).has(decodeURIComponent(fragment))) {
      failures.push(`${file}: no heading for #${fragment} in ${clean}`)
    }
  }
}

assert.deepEqual(failures, [], failures.join('\n'))
console.log(`docs smoke OK (${files.length} READMEs)`)
