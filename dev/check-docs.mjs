/**
 * Checks that relative Markdown links/images in every shipped Markdown file
 * (the `.md` entries of package.json "files") resolve against the linking
 * file's directory, and that `#section` anchors, bare or into another Markdown
 * file, name a heading there.
 * Run by `npm run check:docs` and as part of `npm run check`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const files = pkg.files.filter((entry) => /\.md$/i.test(entry))
const failures = []

// GitHub heading anchors: lower case, punctuation dropped, spaces to hyphens,
// repeated headings suffixed -1, -2, …. Lines inside fences are not headings.
const anchorCache = new Map()
const anchorsOf = (resolved) => {
  const cached = anchorCache.get(resolved)
  if (cached !== undefined) return cached
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
  anchorCache.set(resolved, anchors)
  return anchors
}

for (const file of files) {
  const source = path.join(root, file)
  const text = fs.readFileSync(source, 'utf8')
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|<)/i.test(target)) continue
    const hash = target.indexOf('#')
    const clean = decodeURIComponent(hash === -1 ? target : target.slice(0, hash))
    const fragment = hash === -1 ? undefined : target.slice(hash + 1)
    const resolved = clean === '' ? source : path.resolve(path.dirname(source), clean)
    if (!fs.existsSync(resolved)) {
      failures.push(`${file}: missing ${target}`)
      continue
    }
    if (fragment !== undefined && /\.md$/i.test(resolved) && !anchorsOf(resolved).has(decodeURIComponent(fragment))) {
      failures.push(`${file}: no heading for #${fragment} in ${path.relative(root, resolved)}`)
    }
  }
}

assert.deepEqual(failures, [], failures.join('\n'))
console.log(`docs smoke OK (${files.length} Markdown files)`)
