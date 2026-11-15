/**
 * Checks that relative Markdown links/images in the shipped READMEs resolve.
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

for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|#|<)/i.test(target)) continue
    const clean = decodeURIComponent(target.split('#')[0])
    if (clean === '') continue
    const resolved = path.resolve(root, clean)
    if (!fs.existsSync(resolved)) failures.push(`${file}: missing ${target}`)
  }
}

assert.deepEqual(failures, [], failures.join('\n'))
console.log(`docs smoke OK (${files.length} READMEs)`)
