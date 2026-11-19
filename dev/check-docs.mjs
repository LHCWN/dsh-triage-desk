/**
 * Checks the relative links in every shipped Markdown file: inline links and
 * images (`<…>` targets and titles included) and `[ref]: target` definitions
 * must resolve from the linking file's directory with exact case, and a
 * `#fragment` into a Markdown file must name a heading (ATX or setext, slugged
 * like GitHub) or an `<a id|name>` anchor there. Fenced and indented code
 * blocks and code spans are skipped. Every Markdown file that package.json
 * `files` ships (plain entries, directories and globs expanded) must be listed
 * in DOCS.
 * Run by `npm run check:docs` and as part of `npm run check`.
 * `node dev/check-docs.mjs <file.md>…` checks the given files instead
 * (paths and reports relative to the current directory).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS = ['README.md', 'README.zh.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'docs/DEV_LOCAL.md', 'docs/REFERENCE.md']
const args = process.argv.slice(2)
const root = args.length > 0 ? process.cwd() : path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = args.length > 0 ? args : DOCS
// Files under a directory, as root-relative POSIX paths (node_modules skipped).
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  if (!entry.isDirectory()) return [path.relative(root, full).split(path.sep).join('/')]
  return entry.name === 'node_modules' ? [] : walk(full)
})
// A package.json `files` entry expanded to the files it ships: a plain file, a
// directory's contents, or a glob (`*`/`?` within a segment, `**` across them).
const shippedBy = (entry) => {
  const pattern = entry.replace(/^\.\//, '').replace(/\/$/, '')
  if (!/[*?]/.test(pattern)) {
    const full = path.join(root, pattern)
    if (!fs.existsSync(full)) return []
    return fs.statSync(full).isDirectory() ? walk(full) : [pattern]
  }
  const base = path.join(root, pattern.slice(0, pattern.search(/[*?]/)).replace(/[^/]*$/, ''))
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*|\?/g, (glob) =>
    glob === '?' ? '[^/]' : glob === '*' ? '[^/]*' : '(?:.*/)?')
  const re = new RegExp(`^${source}(?:/.*)?$`)
  return fs.existsSync(base) ? walk(base).filter((file) => re.test(file)) : []
}
if (args.length === 0) {
  // npm ships README and CHANGELOG regardless; every other shipped .md file must be checked here.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const unchecked = [...new Set(pkg.files.flatMap(shippedBy))].filter((file) => /\.md$/i.test(file) && !DOCS.includes(file))
  assert.deepEqual(unchecked, [], `package.json ships Markdown not in DOCS: ${unchecked.join(', ')}`)
}
const failures = []

// Lines of a file with code blocks blanked out.
// - A fence opens with 3+ backticks or tildes indented at most 3 spaces (a
//   backtick fence's info string has no backtick) and closes on a run of the
//   same character at least as long.
// - An indented code block is a line indented 4+ spaces or a tab that follows a
//   blank line (it cannot interrupt a paragraph) outside a list, where such a
//   line is the item's continuation; it runs while lines stay indented or blank.
//   A list ends at an unindented non-item line after a blank line.
const INDENTED = /^(?: {4}|\t)/
const BLANK = /^[ \t]*$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])(?:[ \t]|$)/
const proseCache = new Map()
const proseOf = (file) => {
  if (proseCache.has(file)) return proseCache.get(file)
  const lines = []
  let fence = null
  let indented = false
  let list = false
  let blank = true
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (fence !== null) {
      if (fence.test(line)) {
        fence = null
        blank = true
      }
      lines.push('')
      continue
    }
    if (indented && (INDENTED.test(line) || BLANK.test(line))) {
      lines.push('')
      continue
    }
    indented = false
    if (blank && !list && INDENTED.test(line) && !BLANK.test(line)) {
      indented = true
      lines.push('')
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open !== null && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`)
      lines.push('')
      continue
    }
    if (LIST_ITEM.test(line)) list = true
    else if (blank && /^\S/.test(line)) list = false
    blank = BLANK.test(line)
    lines.push(line)
  }
  proseCache.set(file, lines)
  return lines
}

// Code spans do not cross a blank line; they are replaced by a space.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[^])+?(?<!`)\1(?!`)/g
const LINK_TEXT = String.raw`\[(?:[^\[\]]|\[[^\]]*\])*\]`
const TARGET = String.raw`(<[^<>\n]*>|[^\s()<>]+)`
const INLINE_LINK = new RegExp(String.raw`!?${LINK_TEXT}\(\s*${TARGET}(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)`, 'g')
const REF_DEFINITION = new RegExp(String.raw`^ {0,3}\[[^\]]+\]:[ \t]*${TARGET}`, 'gm')
const HTML_ANCHOR = /<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi

// GitHub heading anchors: the rendered text (link/image text kept, code span
// backticks, `_` emphasis and HTML tags dropped) lower-cased, punctuation
// other than `-` and `_` dropped (this also drops `*` emphasis), spaces to
// hyphens; a repeated slug gets -1, -2, … like github-slugger.
const rendered = (source) => source
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(`+)(.*?[^`])\1(?!`)|<[^>]*>|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, (_, ticks, code) => (ticks ? code : ''))
const slug = (heading) => rendered(heading).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')

const anchorCache = new Map()
const anchorsOf = (file) => {
  if (anchorCache.has(file)) return anchorCache.get(file)
  const anchors = new Set()
  const counts = new Map()
  const addHeading = (text) => {
    const base = slug(text)
    let id = base
    while (anchors.has(id)) {
      counts.set(base, (counts.get(base) ?? 0) + 1)
      id = `${base}-${counts.get(base)}`
    }
    anchors.add(id)
  }
  let paragraph = []
  for (const line of proseOf(file)) {
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (atx !== null) {
      addHeading(atx[1] ?? '')
      paragraph = []
    } else if (paragraph.length > 0 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      addHeading(paragraph.join(' '))
      paragraph = []
    } else if (/^\s*$|^ {0,3}(?:[-*+]|\d+[.)])(?:[ \t]|$)|^ {0,3}[>|<]/.test(line)) {
      paragraph = []
    } else {
      paragraph.push(line.trim())
    }
  }
  const prose = proseOf(file).join('\n').replace(CODE_SPAN, ' ')
  for (const match of prose.matchAll(HTML_ANCHOR)) anchors.add(match[1])
  anchorCache.set(file, anchors)
  return anchors
}

// existsSync ignores case on macOS and Windows; GitHub does not, so every path
// segment below the root must match a directory entry exactly.
const existsExact = (target) => {
  if (!fs.existsSync(target)) return false
  for (let p = target; !path.relative(root, p).startsWith('..') && p !== root; p = path.dirname(p)) {
    if (!fs.readdirSync(path.dirname(p)).includes(path.basename(p))) return false
  }
  return true
}

const decode = (part) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

const checkTarget = (file, source, raw) => {
  const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
  if (target === '' || /^(?:[a-z][a-z\d+.-]+:|\/\/)/i.test(target)) return
  const hash = target.indexOf('#')
  const pathPart = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, '')
  const clean = decode(pathPart)
  const fragment = hash === -1 ? '' : decode(target.slice(hash + 1))
  if (clean === undefined || fragment === undefined) {
    failures.push(`${file}: malformed link ${raw}`)
    return
  }
  const resolved = clean === '' ? source : path.resolve(path.dirname(source), clean)
  if (!existsExact(resolved)) {
    failures.push(`${file}: missing ${raw}`)
  } else if (fragment !== '' && /\.md$/i.test(resolved) && !anchorsOf(resolved).has(fragment)) {
    failures.push(`${file}: no anchor #${fragment} in ${path.relative(root, resolved)}`)
  }
}

for (const file of files) {
  const source = path.resolve(root, file)
  const prose = proseOf(source).join('\n').replace(CODE_SPAN, ' ')
  for (const match of prose.matchAll(INLINE_LINK)) checkTarget(file, source, match[1])
  for (const match of prose.matchAll(REF_DEFINITION)) checkTarget(file, source, match[1])
}

assert.deepEqual(failures, [], failures.join('\n'))
console.log(`docs smoke OK (${files.length} Markdown files)`)
