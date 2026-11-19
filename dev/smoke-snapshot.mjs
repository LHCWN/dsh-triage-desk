/**
 * Dev smoke test for the snapshot builder: runs the real `buildSnapshot` and
 * the host's snapshot cache against a fake `gh` that answers GraphQL queries
 * by operation name (ViewerSources, PullSearch, IssueSearch, PullSearchPage,
 * BranchScan) with canned payloads, so section classification, pagination,
 * quota handling and failure handling are checked without touching GitHub.
 *
 * Run with `npm run smoke:snapshot`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { buildSnapshot, NEW_ISSUE_WINDOW_DAYS, normalizeSettings } from '../github.js'
import { formatToolText, snapshotAge } from '../host/tool-text.js'

const checks = []
async function check(name, callback) {
  try {
    await callback()
    checks.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

/* ------------------------------------------------------------ fake gh */

const ME = 'me'
const rateLimit = { cost: 1, remaining: 4000, resetAt: '2026-01-01T11:00:00Z' }

function handle(exitCode, stdout, stderr = '') {
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
    terminate() {},
  }
}

const ok = (data) => handle(0, JSON.stringify({ data }))
const rateLimited = () =>
  handle(1, JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }))

function viewer(orgs = []) {
  return { viewer: { login: ME, name: 'Me', avatarUrl: null, organizations: { nodes: orgs.map((login) => ({ login })) } }, rateLimit }
}

function pull({ number, headOid, headAt, review = null, requested = false, repo = 'acme/app', author = 'author' }) {
  const reviewNode =
    review === null
      ? null
      : {
          author: { __typename: 'User', login: ME },
          state: 'COMMENTED',
          submittedAt: review.at,
          commit: review.oid === null ? null : { oid: review.oid },
        }
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: false,
    createdAt: '2026-01-01T08:00:00Z',
    updatedAt: '2026-01-01T12:00:00Z',
    repository: { nameWithOwner: repo, viewerPermission: 'WRITE' },
    author: { __typename: 'User', login: author },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    viewerLatestReview: reviewNode === null ? null : { state: reviewNode.state, submittedAt: reviewNode.submittedAt, commit: reviewNode.commit },
    headRefName: `feature-${number}`,
    headRefOid: headOid,
    reviewRequests: { nodes: requested ? [{ requestedReviewer: { __typename: 'User', login: ME } }] : [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: reviewNode === null ? [] : [reviewNode] },
    commits: { nodes: [{ commit: { oid: headOid, committedDate: headAt, statusCheckRollup: null } }] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    reviewThreads: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    labels: { nodes: [] },
    assignees: { nodes: [] },
  }
}

const connection = (nodes, pageInfo = { hasNextPage: false, endCursor: null }) => ({ issueCount: nodes.length, pageInfo, nodes })

/**
 * One PullSearch payload. Without explicit aliases, PRs are routed the
 * way GitHub search would find them for the viewer: requested PRs in
 * `reviewRequested`, PRs with a viewer review in `reviewedBy`, own PRs in
 * `authored`. A PR can appear in more than one alias, as on GitHub.
 */
function searchData({ prs = [], teams = [], owner = 'User', ...aliases } = {}) {
  const routed = { reviewRequested: [], reviewedBy: [], authored: [] }
  for (const pr of prs) {
    if (pr.reviewRequests.nodes.length > 0) routed.reviewRequested.push(pr)
    if (pr.viewerLatestReview) routed.reviewedBy.push(pr)
    if (pr.author && pr.author.login === ME) routed.authored.push(pr)
  }
  return {
    owner: owner === 'Organization' ? { __typename: owner, login: 'acme', teams: { nodes: teams.map((slug) => ({ slug })) } } : { __typename: owner, login: ME },
    reviewRequested: connection(routed.reviewRequested),
    reviewedBy: connection(routed.reviewedBy),
    authored: connection(routed.authored),
    rateLimit,
    ...aliases,
  }
}

/** One IssueSearch payload. */
const issueData = (aliases = {}) => ({
  assignedIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
  newIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
  mentions: { pageInfo: { hasNextPage: false }, nodes: [] },
  rateLimit,
  ...aliases,
})

function repoPage(login, repos = [{ nameWithOwner: `${login}/app` }], pageInfo = { hasNextPage: false, endCursor: null }) {
  return {
    repositoryOwner: {
      __typename: login === ME ? 'User' : 'Organization',
      login,
      repositories: {
        totalCount: repos.length,
        pageInfo,
        nodes: repos.map((repo) => ({ viewerPermission: 'WRITE', defaultBranchRef: null, branchRefs: { nodes: [] }, ...repo })),
      },
    },
    rateLimit,
  }
}

/**
 * Static GraphQL checks GitHub would otherwise reject at validation time:
 * every declared variable is used, every passed variable is declared, every
 * required variable is passed, and fragments are defined and used.
 */
function validateQuery(query, vars) {
  const header = /^\s*query\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{/.exec(query)
  assert.ok(header, 'query has an operation header')
  const body = query.slice(header[0].length)
  const declared = new Map()
  for (const match of (header[2] || '').matchAll(/\$(\w+)\s*:\s*([\w[\]!]+)/g)) declared.set(match[1], match[2])
  for (const [name, type] of declared) {
    assert.ok(new RegExp('\\$' + name + '\\b').test(body), `${header[1]}: $${name} is declared but unused`)
    if (type.endsWith('!')) assert.ok(name in vars, `${header[1]}: required $${name} was not passed`)
  }
  for (const name of Object.keys(vars)) assert.ok(declared.has(name), `${header[1]}: ${name} is passed but not declared`)
  const defined = [...query.matchAll(/\bfragment\s+(\w+)\s+on\s+\w+/g)].map((match) => match[1])
  const spread = new Set([...query.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]).filter((name) => name !== 'on'))
  for (const name of defined) assert.ok(spread.has(name), `${header[1]}: fragment ${name} is unused`)
  for (const name of spread) assert.ok(defined.includes(name), `${header[1]}: fragment ${name} is not defined`)
  assert.equal(new Set(defined).size, defined.length, `${header[1]}: duplicate fragment definitions`)
  return header[1]
}

/**
 * `answers.search` (PullSearch), `answers.issues` (IssueSearch),
 * `answers.page` (PullSearchPage) and `answers.branches` (BranchScan) are
 * called with (login, vars, spec) and return handles; defaults answer with
 * empty results. `answers.prs(login)` is a shortcut for routed search PRs.
 */
function fakeCtx(answers = {}) {
  const calls = []
  const spawn = (spec) => {
    const vars = {}
    let query = ''
    for (let index = 0; index < spec.argv.length - 1; index += 1) {
      if (spec.argv[index] !== '-f' && spec.argv[index] !== '-F') continue
      const entry = spec.argv[index + 1]
      const split = entry.indexOf('=')
      const key = entry.slice(0, split)
      if (key === 'query') query = entry.slice(split + 1)
      else vars[key] = entry.slice(split + 1)
    }
    const operation = validateQuery(query, vars)
    const scoped = Object.values(vars).map((value) => /(?:org|user):(\S+)/.exec(value)).find(Boolean)
    const login = vars.login || (scoped ? scoped[1] : '')
    if (operation === 'ViewerSources') {
      calls.push('viewer')
      return ok(answers.viewer || viewer(answers.orgs || []))
    }
    if (operation === 'PullSearch') {
      calls.push('search:' + login)
      if (answers.search) return answers.search(login, vars, spec)
      const prs = answers.prs ? answers.prs(login) : []
      return ok(searchData({ prs, owner: login === ME ? 'User' : 'Organization' }))
    }
    if (operation === 'IssueSearch') {
      calls.push('issues:' + login)
      return answers.issues ? answers.issues(login, vars, spec) : ok(issueData())
    }
    if (operation === 'PullSearchPage') {
      calls.push('page:' + login)
      return answers.page ? answers.page(login, vars, spec) : ok({ results: connection([]), rateLimit })
    }
    if (operation === 'BranchScan') {
      calls.push('branches:' + login)
      return answers.branches ? answers.branches(login, vars, spec) : ok(repoPage(login))
    }
    return handle(1, '', 'unexpected command: ' + spec.argv.join(' '))
  }
  return {
    calls,
    ctx: { subprocess: { spawn, resolveExecutable: async (command) => command } },
  }
}

const settings = (config = {}) => normalizeSettings({ cwd: process.cwd(), ...config })
const ids = (snapshot, section) =>
  snapshot.sections.find((entry) => entry.id === section).items.map((item) => item.number)
const find = (snapshot, section, number) =>
  snapshot.sections.find((entry) => entry.id === section).items.find((item) => item.number === number)
const hasWarning = (snapshot, code) => snapshot.warnings.some((warning) => warning.code === code)

/* ---------------------------------------------------- new-issue window */

await check('new unassigned issues use the fixed 30-day window', async () => {
  const seen = []
  const { ctx } = fakeCtx({ issues: (_login, vars) => { seen.push(vars); return ok(issueData()) } })
  await buildSnapshot(ctx, settings())
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const queries = seen.flatMap((vars) => Object.values(vars)).filter((value) => /no:assignee/.test(value))
  assert.ok(queries.length > 0, 'the new-issue search ran')
  for (const query of queries) assert.match(query, new RegExp('created:>' + cutoff + ' '), query)
  assert.equal(NEW_ISSUE_WINDOW_DAYS, 30)
})

/* ------------------------------------------------- re-review detection */

await check('re-review compares the reviewed commit with the head, not dates', async () => {
  const prs = [
    // Committed before my review, pushed after it: a different head commit.
    pull({ number: 1, headOid: 'b1', headAt: '2026-01-01T10:00:00Z', review: { at: '2026-01-01T10:30:00Z', oid: 'a1' } }),
    // Committer date after my review, but I reviewed exactly this commit.
    pull({ number: 2, headOid: 'c2', headAt: '2026-01-01T11:00:00Z', review: { at: '2026-01-01T10:30:00Z', oid: 'c2' } }),
    // No commit id on the review: fall back to the dates.
    pull({ number: 3, headOid: 'd3', headAt: '2026-01-01T11:00:00Z', review: { at: '2026-01-01T10:30:00Z', oid: null } }),
  ]
  const { ctx } = fakeCtx({ prs: () => prs })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(ids(snapshot, 'rereview').sort(), [1, 3])
  assert.equal(find(snapshot, 'rereview', 1).rereviewCause, 'new-head')
  assert.match(find(snapshot, 'rereview', 1).reasonDetail, /new head b1/)
  assert.deepEqual(ids(snapshot, 'review'), [], 'reviewed PRs are not first-pass reviews')
})

await check('an explicit re-request after my review lands in re-review', async () => {
  const prs = [
    pull({ number: 4, headOid: 'e4', headAt: '2026-01-01T09:00:00Z', review: { at: '2026-01-01T10:30:00Z', oid: 'e4' }, requested: true }),
    // Requested and never reviewed: an ordinary review request.
    pull({ number: 5, headOid: 'f5', headAt: '2026-01-01T09:00:00Z', requested: true }),
    // Requested again and new commits: the review section, as a fresh pass.
    pull({ number: 6, headOid: 'g6', headAt: '2026-01-01T09:00:00Z', review: { at: '2026-01-01T10:30:00Z', oid: 'old' }, requested: true }),
  ]
  const { ctx } = fakeCtx({ prs: () => prs })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(ids(snapshot, 'rereview'), [4])
  const item = find(snapshot, 'rereview', 4)
  assert.equal(item.rereviewCause, 're-requested')
  assert.equal(item.reason, 're-review-requested')
  assert.deepEqual(ids(snapshot, 'review').sort(), [5, 6])
  // PRs 4 and 6 are in both the review-requested and reviewed-by results.
  assert.equal(snapshot.sections.find((entry) => entry.id === 'review').items.length, 2, 'search duplicates are merged')
})

/* -------------------------------------------- merge readiness and replies */

await check('blocked PRs are not merge-ready even when green checks are optional', async () => {
  const ownPull = (number, mergeStateStatus, state = 'SUCCESS') => {
    const pr = pull({ number, headOid: 'head-' + number, headAt: '2026-01-01T09:00:00Z', author: ME })
    pr.reviewDecision = 'APPROVED'
    pr.mergeStateStatus = mergeStateStatus
    pr.commits.nodes[0].commit.statusCheckRollup = { state }
    return pr
  }
  const prs = [ownPull(91, 'BLOCKED'), ownPull(92, 'CLEAN'), ownPull(93, 'UNSTABLE', 'FAILURE')]
  for (const requireGreenChecks of [true, false]) {
    const { ctx } = fakeCtx({ prs: () => prs })
    const snapshot = await buildSnapshot(ctx, settings({ requireGreenChecks }))
    assert.deepEqual(ids(snapshot, 'merge').sort(), [92, 93], 'repository policy blocks merging independently of the green-check setting')
    assert.equal(find(snapshot, 'merge', 92).reason, 'ready-to-merge')
    assert.equal(find(snapshot, 'merge', 93).reason, requireGreenChecks ? 'approved-checks-failing' : 'ready-to-merge')
  }
})

await check('new inline reviewer replies need action until the author answers', async () => {
  const ownPull = (number, answered) => {
    const pr = pull({ number, headOid: 'head-' + number, headAt: '2026-01-01T09:00:00Z', author: ME })
    pr.reviewDecision = 'APPROVED'
    // An older approval must not suppress a newer inline follow-up.
    pr.reviews.nodes = [{ author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: '2026-01-01T09:30:00Z' }]
    const comment = (login, at) => ({ author: { login }, createdAt: `2026-01-01T${at}:00Z`, bodyText: 'Please check this' })
    const comments = [comment(ME, '10:00'), comment('reviewer', '11:00')]
    if (answered) comments.push(comment(ME, '12:00'))
    pr.reviewThreads.nodes = [{ comments: { nodes: comments } }]
    return pr
  }
  const prs = [ownPull(94, false), ownPull(95, true)]
  const { ctx } = fakeCtx({ prs: () => prs })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(ids(snapshot, 'respond'), [94])
  assert.equal(find(snapshot, 'respond', 94).reason, 'review-feedback')
  assert.equal(find(snapshot, 'respond', 94).lastActivity.at, '2026-01-01T11:00:00Z')
})

await check('older review threads beyond the last window raise truncated-history', async () => {
  const pr = pull({ number: 96, headOid: 'h96', headAt: '2026-01-01T09:00:00Z', author: ME })
  pr.reviewThreads.pageInfo = { hasPreviousPage: true }
  const { ctx } = fakeCtx({ prs: () => [pr] })
  const snapshot = await buildSnapshot(ctx, settings())
  const warning = snapshot.warnings.find((entry) => entry.code === 'truncated-history')
  assert.ok(warning, 'a last: window reports older threads through hasPreviousPage')
  assert.match(warning.message, /older review threads/)
  assert.equal(snapshot.status, 'ok', 'history truncation alone is informational')
})

await check('mentions on my own issues and PRs need a reply when another person follows up', async () => {
  const comment = (login, at) => ({ author: { login }, createdAt: `2026-01-01T${at}:00Z` })
  const mention = (number, author, comments, isPull = false) => ({
    number,
    title: `Mention ${number}`,
    url: `https://github.com/me/app/${isPull ? 'pull' : 'issues'}/${number}`,
    repository: { nameWithOwner: 'me/app' },
    author: { login: author },
    comments: { nodes: comments },
  })
  const data = issueData()
  data.mentions.nodes = [
    mention(101, ME, [comment('teammate', '11:00')]),
    mention(102, ME, [comment('teammate', '11:00')], true),
    mention(103, ME, [comment('teammate', '11:00'), comment(ME, '12:00')]),
    mention(104, ME, [comment(ME, '11:00')]),
    mention(105, ME, []),
    // Someone else can mention me in the issue body, before any comments exist.
    mention(106, 'teammate', []),
  ]
  const { ctx } = fakeCtx({ issues: () => ok(data) })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(ids(snapshot, 'respond'), [102, 101, 106])
  assert.equal(find(snapshot, 'respond', 101).reason, 'mentioned')
  assert.equal(find(snapshot, 'respond', 102).kind, 'pull')
})

/* ---------------------------------------------------- branch health */

await check('personal repositories include failing default and recently authored branches', async () => {
  const now = new Date().toISOString()
  const branch = (name, login, committedDate = now) => ({
    name,
    target: { oid: 'commit-' + name, author: { user: { login } }, committedDate, statusCheckRollup: { state: 'FAILURE' } },
  })
  const { ctx } = fakeCtx({ branches: (login, _vars, spec) => {
    const query = spec.argv.find((arg) => arg.startsWith('query='))
    assert.ok(!query.includes('pullRequests'), 'the branch scan must not carry pull request payloads')
    return ok(repoPage(login, [{
      nameWithOwner: 'me/app',
      viewerPermission: 'ADMIN',
      defaultBranchRef: branch('main', 'teammate'),
      branchRefs: { nodes: [
        branch('main', 'teammate'), branch('my-feature', ME), branch('their-feature', 'teammate'),
        branch('old-feature', ME, '2020-01-01T00:00:00Z'),
      ] },
    }]))
  } })
  const snapshot = await buildSnapshot(ctx, settings())
  const items = snapshot.sections.find((section) => section.id === 'ci').items
  assert.deepEqual(items.map((item) => item.ref).sort(), ['main', 'my-feature'])
  assert.equal(items.find((item) => item.ref === 'main').defaultBranch, true)
  assert.equal(items.find((item) => item.ref === 'my-feature').defaultBranch, false)
  assert.ok(items.every((item) => item.source.kind === 'user' && item.source.login === ME))
})

await check('recent self-authored default branch failures are visible without admin permissions', async () => {
  const now = new Date().toISOString()
  const alias = 'alternate'
  for (const [permission, login, committedDate, expected, state = 'FAILURE'] of [
    ['WRITE', ME, now, true],
    ['WRITE', alias, now, true],
    ['WRITE', 'teammate', now, false],
    ['WRITE', ME, '2020-01-01T00:00:00Z', false],
    ['ADMIN', 'teammate', '2020-01-01T00:00:00Z', true],
    ['MAINTAIN', 'teammate', now, true],
    ['WRITE', ME, now, true, 'ERROR'],
    ['WRITE', ME, now, false, 'SUCCESS'],
    ['WRITE', ME, now, false, 'PENDING'],
    ['ADMIN', ME, now, false, 'SUCCESS'],
  ]) {
    // The default ref is fetched separately and may be absent from branchRefs.
    for (const includeInRefs of [false, true]) {
      const { ctx } = fakeCtx({ branches: () => {
        const branch = {
          name: 'main',
          target: { oid: 'default-head', author: { user: { login } }, committedDate, statusCheckRollup: { state } },
        }
        return ok(repoPage('acme', [{
          nameWithOwner: 'acme/app',
          viewerPermission: permission,
          defaultBranchRef: branch,
          branchRefs: { nodes: includeInRefs ? [branch] : [] },
        }]))
      } })
      const snapshot = await buildSnapshot(ctx, settings({ includePersonal: false, orgs: ['acme'], meLogins: [alias] }))
      const items = snapshot.sections.find((section) => section.id === 'ci').items
      const context = `${permission}, ${login}, ${committedDate}, ${state}, in refs: ${includeInRefs}`
      assert.equal(items.length, expected ? 1 : 0, context)
      if (expected) {
        assert.equal(items[0].defaultBranch, true, context)
        assert.equal(items[0].ref, 'main', context)
        assert.equal(items[0].reasonDetail, permission === 'ADMIN' || permission === 'MAINTAIN'
          ? 'default branch of a repository you administer'
          : 'branch you pushed in the last week', context)
      }
    }
  }
})

await check('extra self logins own discovered PRs, review requests and recently authored branches', async () => {
  const alias = 'alternate'
  const own = (number) => pull({ number, headOid: 'head-' + number, headAt: '2026-01-01T11:00:00Z', author: alias })
  const merge = own(141)
  // A primary-account review of an alias-owned PR must not request self-review.
  merge.viewerLatestReview = { state: 'APPROVED', submittedAt: '2026-01-01T10:00:00Z', commit: { oid: 'previous' } }
  const respond = own(142)
  respond.mergeable = 'CONFLICTING'
  respond.reviewDecision = 'CHANGES_REQUESTED'
  const ci = own(143)
  ci.mergeable = 'UNKNOWN'
  ci.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE' }
  const requested = pull({ number: 144, headOid: 'head-144' })
  requested.reviewRequests.nodes = [{ requestedReviewer: { __typename: 'User', login: alias } }]
  const searched = []
  const { ctx } = fakeCtx({
    // Searches are viewer-scoped: these PRs reach the snapshot because the
    // viewer's own searches (here: reviewed-by) returned them.
    search: (_login, vars) => {
      searched.push(vars.reviewRequestedQ, vars.reviewedByQ, vars.authoredQ)
      return ok(searchData({ owner: 'Organization', reviewedBy: connection([merge, respond, ci, requested]) }))
    },
    branches: () => ok(repoPage('acme', [{
      nameWithOwner: 'acme/app',
      branchRefs: { nodes: [{
        name: 'alias-feature',
        target: { oid: 'alias-feature', committedDate: new Date().toISOString(), author: { user: { login: alias } }, statusCheckRollup: { state: 'FAILURE' } },
      }] },
    }])),
  })
  const snapshot = await buildSnapshot(ctx, settings({ includePersonal: false, orgs: ['acme'], meLogins: [alias] }))
  assert.deepEqual(ids(snapshot, 'merge'), [141], 'alias-owned PRs are mine')
  assert.deepEqual(ids(snapshot, 'respond'), [142], 'alias-owned PRs can require my fixes')
  assert.deepEqual(ids(snapshot, 'review'), [144], 'direct requests to extra self logins need review')
  assert.deepEqual(ids(snapshot, 'rereview'), [], 'do not ask me to re-review my own alias-owned PR')
  const failing = snapshot.sections.find((section) => section.id === 'ci').items
  assert.equal(failing.some((item) => item.number === 143), true, 'include alias-owned PR CI')
  assert.equal(failing.some((item) => item.ref === 'alias-feature'), true, 'include alias-authored branch CI')
  assert.ok(searched.every((q) => q.includes(`:${ME} `) && !q.includes(alias)), 'pull searches use the viewer only')
})

/* ------------------------------------------- search-based discovery */

await check('pull searches are source-scoped, open, unarchived and newest-updated first', async () => {
  const seen = []
  const { ctx } = fakeCtx({ orgs: ['acme'], search: (login, vars) => {
    seen.push(vars)
    return ok(searchData({ owner: login === ME ? 'User' : 'Organization' }))
  } })
  await buildSnapshot(ctx, settings())
  assert.equal(seen.length, 2)
  const [personal, org] = seen
  assert.equal(personal.reviewRequestedQ, `user:${ME} is:pr is:open archived:false review-requested:${ME} sort:updated-desc`)
  assert.equal(personal.reviewedByQ, `user:${ME} is:pr is:open archived:false reviewed-by:${ME} sort:updated-desc`)
  assert.equal(org.authoredQ, `org:acme is:pr is:open archived:false author:${ME} sort:updated-desc`)
  assert.equal(org.pullPageSize, '25')
})

await check('a PR found only by search, in a repository outside every repository page, is a review request', async () => {
  const hidden = pull({ number: 151, headOid: 'h151', repo: 'acme/rarely-pushed', requested: true })
  const { ctx } = fakeCtx({
    orgs: ['acme'],
    prs: (login) => (login === 'acme' ? [hidden] : []),
    // The branch scan never returns acme/rarely-pushed.
    branches: (login) => ok(repoPage(login, [{ nameWithOwner: `${login}/app` }])),
  })
  const snapshot = await buildSnapshot(ctx, settings())
  const item = find(snapshot, 'review', 151)
  assert.ok(item, 'search discovery does not depend on the repository scan')
  assert.equal(item.id, 'acme/rarely-pushed#151')
  assert.deepEqual(item.source, { kind: 'org', login: 'acme', label: 'acme' })
})

await check('a review request is optional only while another approval satisfies GitHub', async () => {
  const approval = { author: { __typename: 'User', login: 'colleague' }, state: 'APPROVED', submittedAt: '2026-01-01T11:00:00Z', commit: null }
  const make = (number, decision, approved) => {
    const pr = pull({ number, headOid: 'o' + number, headAt: '2026-01-01T09:00:00Z', requested: true })
    pr.reviewDecision = decision
    if (approved) pr.reviews.nodes = [approval]
    return pr
  }
  const prs = [make(171, 'APPROVED', true), make(172, null, true), make(173, 'REVIEW_REQUIRED', true), make(174, 'APPROVED', false)]
  const { ctx } = fakeCtx({ prs: () => prs })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(find(snapshot, 'review', 171).optional, true, 'approved by someone else and satisfied')
  assert.equal(find(snapshot, 'review', 172).optional, true, 'no required reviews and another approval')
  assert.equal(find(snapshot, 'review', 173).optional, false, 'GitHub still requires a review')
  assert.equal(find(snapshot, 'review', 174).optional, false, 'no other approval in the window')
  assert.match(find(snapshot, 'review', 171).reasonDetail, /optional/)
  assert.doesNotMatch(find(snapshot, 'review', 173).reasonDetail, /optional/)
})

await check('team review requests use membership, or the search hit when membership is unknown', async () => {
  const teamPull = (number, slug) => {
    const pr = pull({ number, headOid: 'h' + number })
    pr.reviewRequests.nodes = [{ requestedReviewer: { __typename: 'Team', slug, teamName: slug } }]
    return pr
  }
  // 161: a known team. 162: review-requested matched, team not in the fetched
  // membership (e.g. no read:org). 163: some other team, only reviewed-by.
  const known = teamPull(161, 'platform')
  const unknown = teamPull(162, 'nested-team')
  const other = teamPull(163, 'other-team')
  other.viewerLatestReview = { state: 'COMMENTED', submittedAt: '2026-01-01T10:00:00Z', commit: { oid: 'h163' } }
  const { ctx } = fakeCtx({ search: () => ok(searchData({
    owner: 'Organization',
    teams: ['platform'],
    reviewRequested: connection([known, unknown]),
    reviewedBy: connection([other]),
  })) })
  const snapshot = await buildSnapshot(ctx, settings({ includePersonal: false, orgs: ['acme'] }))
  assert.deepEqual(ids(snapshot, 'review').sort(), [161, 162])
  assert.equal(find(snapshot, 'review', 161).reason, 'team-review-requested')
  assert.deepEqual(find(snapshot, 'review', 162).waitingOn, ['team:nested-team'])
})

await check('pull search pages are followed to a bounded depth and report truncation', async () => {
  const pages = []
  const { ctx, calls } = fakeCtx({
    search: () => ok(searchData({
      reviewRequested: { issueCount: 140, pageInfo: { hasNextPage: true, endCursor: 'rr-1' }, nodes: [pull({ number: 171, headOid: 'x', requested: true })] },
      authored: { issueCount: 2, pageInfo: { hasNextPage: true, endCursor: 'au-1' }, nodes: [] },
    })),
    page: (_login, vars) => {
      pages.push(`${vars.q.includes('author:') ? 'au' : 'rr'}:${vars.after}`)
      if (vars.q.includes('author:')) {
        const own = pull({ number: 181, headOid: 'y', author: ME })
        own.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE' }
        return ok({ results: connection([own]), rateLimit })
      }
      const next = Number(vars.after.split('-')[1]) + 1
      return ok({
        results: { issueCount: 140, pageInfo: { hasNextPage: true, endCursor: 'rr-' + next }, nodes: [pull({ number: 170 + next, headOid: 'x', requested: true })] },
        rateLimit,
      })
    },
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(pages, ['rr:rr-1', 'au:au-1', 'rr:rr-2', 'rr:rr-3'], 'at most four pages per search alias, round by round')
  assert.equal(calls.filter((call) => call.startsWith('page:')).length, 4)
  assert.deepEqual(ids(snapshot, 'review').sort(), [171, 172, 173, 174])
  assert.ok(find(snapshot, 'ci', 181), 'PRs from later pages are classified')
  const warning = snapshot.warnings.find((entry) => entry.code === 'prs-truncated')
  assert.ok(warning, 'a search with more matches than the bound is reported')
  assert.match(warning.message, /4 most recently updated of 140 open pull requests review requests/)
  assert.equal(snapshot.warnings.filter((entry) => entry.code === 'prs-truncated').length, 1, 'the exhausted alias is not reported')
  assert.equal(snapshot.status, 'partial')
})

await check('a repeated pull search cursor ends that search', async () => {
  let pages = 0
  const { ctx } = fakeCtx({
    search: () => ok(searchData({ reviewedBy: { issueCount: 60, pageInfo: { hasNextPage: true, endCursor: 'same' }, nodes: [] } })),
    page: () => {
      pages += 1
      return ok({ results: { issueCount: 60, pageInfo: { hasNextPage: true, endCursor: 'same' }, nodes: [] }, rateLimit })
    },
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(pages, 1)
  assert.ok(hasWarning(snapshot, 'prs-truncated'))
})

/* ------------------------------------------ pagination and quota bounds */

await check('branch scans follow repository cursors, newest pushed first, without pull requests', async () => {
  let page = 0
  const { ctx } = fakeCtx({
    orgs: ['acme'],
    branches: (_login, vars, spec) => {
      const query = spec.argv.find((arg) => arg.startsWith('query='))
      assert.ok(!query.includes('field: NAME'), 'organization scans must not prefer alphabetically early repositories')
      assert.ok(query.includes('field: PUSHED_AT, direction: DESC'))
      assert.ok(query.includes('after: $after'), 'repository connection must accept a cursor')
      assert.ok(!query.includes('pullRequests'), 'pull requests are discovered by search')
      assert.equal(vars.pageSize, '100')
      if (page > 0) assert.equal(vars.after, 'page-' + page)
      else assert.equal(vars.after, undefined)
      const now = new Date().toISOString()
      const repos = Array.from({ length: page < 1 ? 100 : 21 }, (_, index) => ({ nameWithOwner: `acme/repo-${page * 100 + index}` }))
      if (page === 1) {
        repos[20].branchRefs = { nodes: [{ name: 'mine', target: { oid: 'm', committedDate: now, author: { user: { login: ME } }, statusCheckRollup: { state: 'FAILURE' } } }] }
      }
      const data = repoPage('acme', repos, { hasNextPage: page < 1, endCursor: 'page-' + (page + 1) })
      data.repositoryOwner.repositories.totalCount = 121
      page += 1
      return ok(data)
    },
  })
  const snapshot = await buildSnapshot(ctx, settings({ includePersonal: false }))
  assert.equal(page, 2)
  assert.equal(snapshot.sources[0].repos, 121)
  assert.ok(snapshot.sections.find((entry) => entry.id === 'ci').items.some((item) => item.ref === 'mine' && item.repo === 'acme/repo-120'),
    'branch CI from the second page is classified')
  assert.ok(!hasWarning(snapshot, 'repos-truncated'))
})

await check('auto-detected organizations use the same ten-organization bound as configuration', async () => {
  const { ctx, calls } = fakeCtx({ orgs: Array.from({ length: 12 }, (_, index) => 'org-' + index) })
  const snapshot = await buildSnapshot(ctx, settings({ includePersonal: false }))
  assert.equal(calls.filter((call) => call.startsWith('search:')).length, 10)
  assert.equal(calls.filter((call) => call.startsWith('branches:')).length, 10)
  assert.ok(hasWarning(snapshot, 'orgs-truncated'))
})

await check('repository pagination has a finite per-source cap and reports incomplete coverage', async () => {
  let pages = 0
  const { ctx } = fakeCtx({ branches: (login) => {
    pages += 1
    const data = repoPage(login, Array.from({ length: 100 }, (_, index) => ({ nameWithOwner: `me/repo-${pages}-${index}` })),
      { hasNextPage: true, endCursor: 'page-' + pages })
    data.repositoryOwner.repositories.totalCount = 1000
    return ok(data)
  } })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(pages, 3)
  assert.equal(snapshot.sources[0].repos, 300)
  assert.ok(hasWarning(snapshot, 'repos-truncated'))
})

await check('realistic GraphQL costs still scan every source and organization', async () => {
  // Real-world costs: the old 500-point refresh budget stopped after the
  // personal source here, so no organization was scanned at all.
  let remaining = 4800
  const costs = { PullSearch: 110, IssueSearch: 40, PullSearchPage: 30, BranchScan: 40 }
  const charge = (operation) => {
    remaining -= costs[operation]
    return { cost: costs[operation], remaining, resetAt: rateLimit.resetAt }
  }
  const orgs = ['acme', 'globex', 'initech']
  const operationOf = (spec) => /query (\w+)/.exec(spec.argv.find((arg) => arg.startsWith('query=')))[1]
  const { ctx, calls } = fakeCtx({
    orgs,
    search: (login, _vars, spec) => {
      const repo = `${login}/service`
      const data = searchData({
        prs: [pull({ number: 200 + orgs.indexOf(login), headOid: 'r', repo, requested: true })],
        owner: login === ME ? 'User' : 'Organization',
      })
      // The personal source also has a long reviewed-by list.
      if (login === ME) data.reviewedBy = { issueCount: 80, pageInfo: { hasNextPage: true, endCursor: 'me-1' }, nodes: [] }
      data.rateLimit = charge(operationOf(spec))
      return ok(data)
    },
    page: (login, vars, spec) => {
      const next = Number(vars.after.split('-')[1]) + 1
      return ok({ results: { issueCount: 80, pageInfo: { hasNextPage: true, endCursor: 'me-' + next }, nodes: [] }, rateLimit: charge(operationOf(spec)) })
    },
    issues: (_login, _vars, spec) => ok({ ...issueData(), rateLimit: charge(operationOf(spec)) }),
    branches: (login, vars, spec) => {
      const data = repoPage(login, Array.from({ length: 100 }, (_, index) => ({ nameWithOwner: `${login}/r-${vars.after || 0}-${index}` })),
        { hasNextPage: true, endCursor: (vars.after || 'c') + '+' })
      data.repositoryOwner.repositories.totalCount = 400
      data.rateLimit = charge(operationOf(spec))
      return ok(data)
    },
  })
  const snapshot = await buildSnapshot(ctx, settings())
  for (const org of orgs) {
    assert.ok(calls.includes('search:' + org), `${org} is searched`)
    assert.ok(calls.includes('issues:' + org), `${org} issues are searched`)
    assert.ok(calls.includes('branches:' + org), `${org} branch CI is scanned`)
    assert.ok(find(snapshot, 'review', 200 + orgs.indexOf(org)), `${org} review request is visible`)
  }
  assert.deepEqual(snapshot.sources.map((source) => source.login), [ME, ...orgs])
  assert.ok(!hasWarning(snapshot, 'scan-budget'), 'normal quota does not stop the refresh')
  assert.ok(snapshot.meta.rateLimit.cost > 500, 'cost above the old soft budget is fine')
  // Fairness: every source's discovery query runs before any follow-up work.
  const lastSearch = calls.map((call) => call.startsWith('search:') || call.startsWith('issues:')).lastIndexOf(true)
  const firstOther = calls.findIndex((call) => call.startsWith('page:') || call.startsWith('branches:'))
  assert.ok(lastSearch < firstOther, calls.join(','))
})

await check('the remaining-quota floor stops further queries with scan-budget', async () => {
  const { ctx, calls } = fakeCtx({
    orgs: ['acme', 'globex'],
    search: (login) => {
      const data = searchData({ prs: [pull({ number: 211, headOid: 'q', requested: true })] })
      if (login === ME) data.rateLimit = { cost: 20, remaining: 90, resetAt: rateLimit.resetAt }
      return ok(data)
    },
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(calls, ['viewer', 'search:me'], 'no organization, page or branch query starts below the floor')
  assert.deepEqual(ids(snapshot, 'review'), [211], 'fetched results are kept')
  const warning = snapshot.warnings.find((entry) => entry.code === 'scan-budget')
  assert.ok(warning)
  assert.match(warning.message, /90 points remaining/)
  assert.equal(snapshot.warnings.filter((entry) => entry.code === 'scan-budget').length, 1, 'the warning is recorded once')
  assert.equal(snapshot.status, 'partial')
})

await check('low remaining quota skips further work without replacing the inbox with an empty success', async () => {
  const data = viewer()
  data.rateLimit = { ...rateLimit, remaining: 100 }
  const { ctx, calls } = fakeCtx({ viewer: data, search: () => { throw new Error('must not search') } })
  await assert.rejects(buildSnapshot(ctx, settings()), (error) => error.code === 'rate-limit')
  assert.deepEqual(calls, ['viewer'])
})

await check('a failed later repository page preserves earlier results and reports partial coverage', async () => {
  let page = 0
  const { ctx } = fakeCtx({
    prs: () => [pull({ number: 71, headOid: 'p71', requested: true })],
    branches: (login) => {
      page += 1
      if (page === 2) return rateLimited()
      const data = repoPage(login, [{ nameWithOwner: 'me/app' }], { hasNextPage: true, endCursor: 'next' })
      data.repositoryOwner.repositories.totalCount = 101
      return ok(data)
    },
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(page, 2)
  assert.deepEqual(ids(snapshot, 'review'), [71])
  assert.equal(snapshot.sources[0].repos, 1)
  assert.equal(snapshot.status, 'partial')
  assert.ok(hasWarning(snapshot, 'repos-truncated'))
  assert.ok(hasWarning(snapshot, 'source-unavailable'))
})

await check('a repeated repository cursor stops pagination and deduplicates repositories', async () => {
  let page = 0
  const { ctx } = fakeCtx({ branches: (login) => {
    page += 1
    const data = repoPage(login, [{ nameWithOwner: 'me/app' }], { hasNextPage: true, endCursor: 'same' })
    data.repositoryOwner.repositories.totalCount = 100
    return ok(data)
  } })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(page, 2)
  assert.equal(snapshot.sources[0].repos, 1)
  assert.ok(hasWarning(snapshot, 'repos-truncated'))
})

await check('partial GraphQL rate-limit errors retain data but stop remaining requests', async () => {
  const { ctx, calls } = fakeCtx({ orgs: ['acme'], search: () => {
    const data = searchData({ prs: [pull({ number: 81, headOid: 'p81', requested: true })] })
    delete data.rateLimit
    return handle(1, JSON.stringify({ data, errors: [{ type: 'RATE_LIMITED', message: 'quota exhausted' }] }))
  } })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(calls, ['viewer', 'search:me'])
  assert.deepEqual(ids(snapshot, 'review'), [81])
  assert.equal(snapshot.status, 'partial')
  assert.ok(hasWarning(snapshot, 'scan-budget'))
})

await check('a failed search alias (null data) is not an empty successful snapshot', async () => {
  // `search` is non-null in GitHub's schema: one failing alias nulls `data`.
  const { ctx } = fakeCtx({ search: () => handle(1, JSON.stringify({
    data: null,
    errors: [{ type: 'INVALID_SEARCH', message: 'The listed users cannot be searched' }],
  })) })
  await assert.rejects(buildSnapshot(ctx, settings()), (error) => error.code === 'failed' && /cannot be searched/.test(error.message))
})

await check('a failed issue search keeps the source pull requests and reports partial coverage', async () => {
  const { ctx, calls } = fakeCtx({
    orgs: ['acme'],
    prs: (login) => [pull({ number: login === ME ? 221 : 222, headOid: 'z', requested: true })],
    issues: (login) => login === ME
      ? handle(1, JSON.stringify({ data: null, errors: [{ message: 'Something went wrong while executing your query.' }] }))
      : ok(issueData()),
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.deepEqual(ids(snapshot, 'review').sort(), [221, 222])
  assert.deepEqual(snapshot.sources.map((source) => source.login), [ME, 'acme'])
  assert.ok(hasWarning(snapshot, 'search-unavailable'))
  assert.ok(!hasWarning(snapshot, 'source-unavailable'))
  assert.ok(calls.includes('branches:me'), 'branch CI still runs for the source')
  assert.equal(snapshot.status, 'partial')
})

/* --------------------------------------------------- failure handling */

await check('a build where every source scan fails throws instead of returning an empty inbox', async () => {
  const { ctx, calls } = fakeCtx({ orgs: ['acme'], search: () => rateLimited() })
  await assert.rejects(buildSnapshot(ctx, settings()), (error) => {
    assert.equal(error.name, 'GhError')
    assert.equal(error.code, 'rate-limit')
    return true
  })
  assert.deepEqual(calls, ['viewer', 'search:me'], 'rate limits are final: no retry, no branch scan or later source')
})

await check('one failed source still yields a partial snapshot with the others', async () => {
  const prs = [pull({ number: 7, headOid: 'h7', headAt: '2026-01-01T09:00:00Z', requested: true })]
  const assigned = (login) => ({
    number: 230,
    title: 'Assigned',
    url: `https://github.com/${login}/app/issues/230`,
    repository: { nameWithOwner: `${login}/app`, viewerPermission: 'WRITE' },
    author: { login: 'teammate' },
    assignees: { nodes: [{ login: ME }] },
  })
  const { ctx, calls } = fakeCtx({
    orgs: ['acme'],
    search: (login) => (login === 'acme' ? handle(1, '', 'gh: Could not resolve to an Organization') : ok(searchData({ prs }))),
    issues: (login) => ok(issueData({ assignedIssues: { pageInfo: { hasNextPage: false }, nodes: [assigned(login)] } })),
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(snapshot.status, 'partial')
  assert.deepEqual(ids(snapshot, 'review'), [7])
  assert.ok(hasWarning(snapshot, 'source-unavailable'))
  const respond = snapshot.sections.find((entry) => entry.id === 'respond').items
  assert.deepEqual(respond.map((item) => item.id), ['me/app#230'], 'issues of other sources are unaffected')
  assert.ok(!calls.includes('issues:acme') && !calls.includes('branches:acme'), 'a source without pull request discovery is skipped')
  assert.deepEqual(snapshot.sources.map((source) => source.login), [ME])
})

await check('a permission-denied HTTP 403 does not stop healthy later sources as quota exhaustion', async () => {
  const { ctx, calls } = fakeCtx({
    orgs: ['acme'],
    search: (login) => login === ME
      ? handle(1, '', 'gh: Resource not accessible by integration (HTTP 403)')
      : ok(searchData({ owner: 'Organization', prs: [pull({ number: 107, headOid: 'p107', requested: true })] })),
  })
  const snapshot = await buildSnapshot(ctx, settings())
  assert.equal(snapshot.status, 'partial')
  assert.deepEqual(ids(snapshot, 'review'), [107])
  assert.ok(calls.includes('search:acme'), 'a denied source must not prevent scanning another source')
  assert.ok(hasWarning(snapshot, 'source-unavailable'))
  assert.ok(!hasWarning(snapshot, 'scan-budget'))
})

await check('HTTP 429 and explicit HTTP 403 rate limits still stop later sources', async () => {
  for (const message of ['gh: Too Many Requests (HTTP 429)', 'gh: API rate limit exceeded (HTTP 403)']) {
    const { ctx, calls } = fakeCtx({ orgs: ['acme'], search: () => handle(1, '', message) })
    await assert.rejects(buildSnapshot(ctx, settings()), (error) => error.code === 'rate-limit')
    assert.deepEqual(calls, ['viewer', 'search:me'], 'real rate limits are final and protect remaining quota')
  }
})

await check('an oversized response is not fetched twice', async () => {
  let searches = 0
  const lossy = () => {
    searches += 1
    const value = handle(0, '{')
    value.collected.stdout.readFrom = () => ({ text: '{', lossy: true })
    return value
  }
  const { ctx } = fakeCtx({ search: lossy })
  await assert.rejects(buildSnapshot(ctx, settings()), (error) => error.code === 'too-large')
  assert.equal(searches, 1)
})

/* ------------------------------------------- host: stale fallback, abort */

function hostCtx(fake) {
  const captured = { tool: null }
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const entry = { id: 'triage-desk', options: { id: 'triage-desk', name: 'dsh-triage-desk' } }
  const ctx = {
    ...fake.ctx,
    logger: () => logger,
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
    tools: {
      register: (definition) => {
        captured.tool = definition
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
    fiber: { entry },
    get: (name) => (name === 'configEditor' ? { entries: () => [entry], edit: async () => {} } : undefined),
  }
  return { ctx, captured }
}

await check('a refresh that loses every source keeps the previous snapshot as stale', async () => {
  let failing = false
  const prs = [pull({ number: 8, headOid: 'i8', headAt: '2026-01-01T09:00:00Z', requested: true })]
  const fake = fakeCtx({ search: () => (failing ? rateLimited() : ok(searchData({ prs }))) })
  const { ctx, captured } = hostCtx(fake)
  apply(ctx, { cwd: process.cwd() })
  const first = await captured.tool.execute({})
  assert.equal(first.status, 'ok')
  assert.equal(first.counts.review, 1)
  failing = true
  const second = await captured.tool.execute({ refresh: true })
  assert.equal(second.status, 'stale', 'the failed refresh must not replace the good snapshot')
  assert.equal(second.counts.review, 1)
  assert.match(second.text, /PR 8/)
  assert.match(second.text, /refresh failed, showing the previous snapshot/)
  failing = false
  const third = await captured.tool.execute({})
  assert.equal(third.status, 'ok', 'the good snapshot is still cached')
})

await check('a cancelled tool call does not cancel the shared build', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const prs = [pull({ number: 9, headOid: 'j9', headAt: '2026-01-01T09:00:00Z', requested: true })]
  const signals = []
  const fake = fakeCtx({
    search: (_login, _vars, spec) => {
      signals.push(spec.signal)
      const value = ok(searchData({ prs }))
      value.done = gate.then(() => ({ exitCode: 0, signal: null }))
      return value
    },
  })
  const { ctx, captured } = hostCtx(fake)
  apply(ctx, { cwd: process.cwd() })
  const controller = new AbortController()
  const cancelled = captured.tool.execute({}, { signal: controller.signal })
  const other = captured.tool.execute({})
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort(new Error('tool call cancelled'))
  await assert.rejects(cancelled, /tool call cancelled/)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, false, 'the gh call of the shared build keeps running')
  release()
  const result = await other
  assert.equal(result.status, 'ok')
  assert.equal(result.counts.review, 1)
})

/* ------------------------------------------------------ triage_desk tool text */

const toolSnapshot = (extra = {}) => ({
  status: 'ok',
  generatedAt: '2026-11-19T12:00:00.000Z',
  sources: [{ kind: 'user', login: 'me', label: 'me' }],
  counts: { total: 1, review: 0, rereview: 0, merge: 1, respond: 0, ci: 0, issues: 0 },
  sections: [
    { id: 'review', items: [] },
    { id: 'merge', items: [{ kind: 'pull', repo: 'acme/app', number: 5, title: 'Ready', reason: 'approved', url: 'https://github.com/acme/app/pull/5' }] },
  ],
  warnings: [],
  ...extra,
})
const toolNow = Date.parse('2026-11-19T12:12:00.000Z')

await check('the tool text separates an empty filter from an empty inbox', async () => {
  const filtered = formatToolText(toolSnapshot(), new Set(['review']), toolNow)
  assert.ok(filtered.includes('Nothing in the requested sections; 1 item(s) are in other sections.'), filtered)
  assert.ok(!filtered.includes('Nothing needs your attention'), filtered)
  const empty = formatToolText(toolSnapshot({ counts: { total: 0 }, sections: [{ id: 'merge', items: [] }] }), null, toolNow)
  assert.ok(empty.includes('Nothing needs your attention right now.'), empty)
  const all = formatToolText(toolSnapshot(), null, toolNow)
  assert.ok(all.includes('## merge (1)') && !all.includes('Nothing'), all)
})

await check('the tool text reports stale and partial snapshots with their reason', async () => {
  const stale = formatToolText(toolSnapshot({ status: 'stale', meta: { lastError: { code: 'rate-limited', message: 'GitHub rate limit exceeded' } } }), null, toolNow)
  assert.ok(stale.includes('Status: stale — GitHub rate limit exceeded (snapshot from 2026-11-19T12:00:00.000Z)'), stale)
  const partial = formatToolText(toolSnapshot({ status: 'partial' }), null, toolNow)
  assert.ok(partial.includes('Status: partial — some sources could not be read'), partial)
  assert.ok(!formatToolText(toolSnapshot(), null, toolNow).includes('Status:'), 'a fresh snapshot has no status line')
})

await check('the tool header says how old the snapshot is', async () => {
  const text = formatToolText(toolSnapshot(), null, toolNow)
  assert.ok(text.startsWith('Triage Desk — personal — 1 item(s) at 2026-11-19T12:00:00.000Z (12 min ago)'), text)
  assert.equal(snapshotAge('2026-11-19T12:00:00.000Z', Date.parse('2026-11-19T12:00:20.000Z')), 'just now')
  assert.equal(snapshotAge('2026-11-19T12:00:00.000Z', Date.parse('2026-11-19T15:30:00.000Z')), '3 h ago')
  assert.equal(snapshotAge('2026-11-17T12:00:00.000Z', Date.parse('2026-11-19T12:00:00.000Z')), '2 d ago')
  assert.equal(snapshotAge('not a date', toolNow), '')
})

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} snapshot checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('snapshot smoke OK')
}
