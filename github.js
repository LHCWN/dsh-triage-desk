/**
 * Triage Desk — GitHub data layer.
 *
 * Pure host-side logic: GraphQL query texts, the `gh` runner over
 * `ctx.subprocess`, and the normalization that turns raw GitHub payloads into
 * the snapshot contract the Client half and the `triage_desk` tool consume.
 * No `@deepseek-ai/*` imports: a linked local bundle cannot resolve them.
 */

import { homedir } from 'node:os'

const GH_MAX_BYTES = 12 * 1024 * 1024
const GH_TIMEOUT_MS = 30_000
const LOOKBACK_DAYS = 7
export const MAX_ORGS = 10
/** Poll interval bounds and default, in seconds; Settings advertises the same. */
export const REFRESH_SECONDS = { min: 15, max: 3600, default: 1200 }
// Pull requests are discovered by search. GitHub ends a GraphQL request after
// about 10 s of server time and answers HTTP 502/504 or an empty body; on
// org:llvm (12,000+ open PRs, bot comments with full diffs) the combined
// search of level 0 passes that limit. Each level is lighter than the last: a
// source steps down one level on such a timeout and keeps the level for the
// life of its snapshot store (`profiles`). Level 0 is one combined query of
// the three searches; levels 1 and 2 run each search as its own query, with
// smaller pages and, at level 2, smaller comment windows. `maxPages` bounds
// the pages read per search alias and source.
const PULL_LEVELS = [
  { combined: true, pageSize: 25, maxPages: 4, comments: 30, threads: 10, threadComments: 5 },
  { combined: false, pageSize: 10, maxPages: 5, comments: 30, threads: 10, threadComments: 5 },
  { combined: false, pageSize: 5, maxPages: 5, comments: 15, threads: 5, threadComments: 3 },
]
const MAX_PULL_PAGES = Math.max(...PULL_LEVELS.map((level) => level.maxPages))
// Branch CI reads repositories without pull requests: 100 per page (about 2
// points each), newest pushed first, at most 3 pages (300) per source.
const REPO_PAGE_SIZE = 100
const MAX_REPO_PAGES = 3
// A large source's branch CI reads at most this many repositories the viewer
// contributed to in the last year, one query each (see BRANCH_SCAN_REPO_QUERY).
const MAX_CONTRIBUTED_REPOS = 10
// Stop starting new queries when GitHub reports this little quota left (or a
// rate limit). There is no per-refresh point budget: a normal refresh costs
// roughly 20 points per source (see the query comments), so every source and
// search gets its turn instead of the first large source using the budget.
const MIN_RATE_REMAINING = 100
/**
 * New unassigned issues in your repositories are listed for this many days;
 * there is no setting for it: older ones the user does not want are snoozed.
 */
const NEW_ISSUE_WINDOW_DAYS = 30
const SECTION_IDS = ['review', 'rereview', 'merge', 'respond', 'ci', 'issues']

/*
 * GraphQL cost (GitHub's documented formula): add up the requests needed to
 * fill every connection at its first/last limit, where a nested connection
 * needs one request per parent node; divide by 100 (minimum 1 point).
 *
 * AttentionPR at 25 parent nodes (level 0): reviewRequests, reviews,
 * commits, commits.contexts (25 x 1), comments, reviewThreads, labels and
 * assignees need 25 requests each (200); thread comments need 25 x 10 = 250.
 * One pull search is therefore 1 + 450 = 451 requests, about 5 points.
 */

const VIEWER_QUERY = `
query ViewerSources {
  viewer {
    login
    name
    avatarUrl
    organizations(first: 11) {
      pageInfo { hasNextPage }
      nodes { login name }
    }
  }
  rateLimit { cost remaining resetAt }
}
`

/*
 * The pull request fields every section classifier reads. Windows are kept
 * where classification needs them: the viewer's latest review is a separate
 * field, so a long review history cannot hide it. Review threads are the
 * dominant cost (threads x comments per PR), so only the 10 most recently
 * started threads and their 5 latest comments are read; replyTo/author/
 * createdAt/body stay because commentRepliesToViewer needs them. `body` is
 * the stored markdown; `bodyText` is rendered per request and was the largest
 * part of the server time on org:llvm (review threads with it timed out, with
 * `body` they took 4.6 s). The comment windows are variables so a lighter
 * pull level can shrink them. Older pages still raise the truncated-history
 * warning through pageInfo.
 */
const PULL_FRAGMENTS = `
fragment PullSearchResults on SearchResultItemConnection {
  issueCount
  pageInfo { hasNextPage endCursor }
  nodes { ...AttentionPR }
}

fragment AttentionPR on PullRequest {
  id
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  repository { nameWithOwner viewerPermission }
  author { __typename login ... on User { name avatarUrl } }
  reviewDecision
  mergeable
  mergeStateStatus
  viewerLatestReview { state submittedAt commit { oid } }
  baseRefName
  headRefName
  headRefOid
  reviewRequests(first: 20) {
    totalCount
    nodes {
      requestedReviewer {
        __typename
        ... on User { login name }
        # Team.name is String! and User.name is String: the same response key
        # with different nullability is a GraphQL field conflict, so alias it.
        ... on Team { slug teamName: name }
      }
    }
  }
  reviews(last: 50) {
    totalCount
    pageInfo { hasPreviousPage }
    nodes { author { __typename login } state submittedAt commit { oid } }
  }
  commits(last: 1) {
    nodes {
      commit {
        oid
        committedDate
        statusCheckRollup {
          state
          contexts(first: 20) {
            totalCount
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
  comments(last: $commentWindow) {
    totalCount
    pageInfo { hasPreviousPage }
    nodes { author { login } createdAt body }
  }
  reviewThreads(last: $threadWindow) {
    pageInfo { hasPreviousPage }
    nodes {
      comments(last: $threadCommentWindow) {
        pageInfo { hasPreviousPage }
        nodes {
          author { login }
          createdAt
          body
          replyTo { author { login } }
        }
      }
    }
  }
  labels(first: 10) { nodes { name color } }
  assignees(first: 5) { nodes { login } }
}
`

/*
 * Pull request discovery, one query per source: the viewer's teams in that
 * organization and three pull request searches (review requests incl. team
 * requests, PRs the viewer has reviewed, PRs the viewer authored). Cost:
 * teams 1 + 3 x 451, about 1354 requests = 14 points. `search` is non-null,
 * so a failing alias nulls the whole response; issue searches therefore run
 * as their own query and cannot take the pull requests down with them.
 */
const PULL_SEARCH_QUERY = `
query PullSearch($login: String!, $viewerLogin: String!, $pullPageSize: Int!, $reviewRequestedQ: String!, $reviewedByQ: String!, $authoredQ: String!, $commentWindow: Int!, $threadWindow: Int!, $threadCommentWindow: Int!) {
  rateLimit { cost remaining resetAt }
  owner: repositoryOwner(login: $login) {
    __typename
    login
    ... on Organization {
      teams(first: 50, userLogins: [$viewerLogin]) { nodes { slug name } }
    }
  }
  reviewRequested: search(query: $reviewRequestedQ, type: ISSUE, first: $pullPageSize) {
    ...PullSearchResults
  }
  reviewedBy: search(query: $reviewedByQ, type: ISSUE, first: $pullPageSize) {
    ...PullSearchResults
  }
  authored: search(query: $authoredQ, type: ISSUE, first: $pullPageSize) {
    ...PullSearchResults
  }
}
${PULL_FRAGMENTS}`

/*
 * Issue searches, one query per source. Cost: assigned/new issues 151
 * requests each, mentions 201 (both fragments' connections), about 503
 * requests = 5 points.
 */
const ISSUE_SEARCH_QUERY = `
query IssueSearch($assignedQ: String!, $newIssuesQ: String!, $mentionsQ: String!) {
  rateLimit { cost remaining resetAt }
  assignedIssues: search(query: $assignedQ, type: ISSUE, first: 50) {
    issueCount
    pageInfo { hasNextPage }
    nodes { ...IssueNode }
  }
  newIssues: search(query: $newIssuesQ, type: ISSUE, first: 50) {
    issueCount
    pageInfo { hasNextPage }
    nodes { ...IssueNode }
  }
  mentions: search(query: $mentionsQ, type: ISSUE, first: 50) {
    issueCount
    pageInfo { hasNextPage }
    nodes { ...IssueNode ...MentionPull }
  }
}

fragment IssueNode on Issue {
  id
  number
  title
  url
  createdAt
  updatedAt
  repository { nameWithOwner isPrivate viewerPermission }
  author { login ... on User { name } }
  labels(first: 10) { nodes { name color } }
  assignees(first: 5) { nodes { login } }
  comments(last: 5) { totalCount nodes { author { login } createdAt } }
}

fragment MentionPull on PullRequest {
  id
  number
  title
  url
  createdAt
  updatedAt
  isDraft
  state
  repository { nameWithOwner isPrivate viewerPermission }
  author { __typename login }
  reviewDecision
  mergeable
  comments(last: 5) { totalCount nodes { author { login } createdAt } }
}
`

/**
 * One page of one pull request search alias: follow-up pages, and every page
 * of a source on a split pull level (about 5 points at 25 per page).
 */
const PULL_SEARCH_PAGE_QUERY = `
query PullSearchPage($q: String!, $pageSize: Int!, $after: String, $commentWindow: Int!, $threadWindow: Int!, $threadCommentWindow: Int!) {
  rateLimit { cost remaining resetAt }
  results: search(query: $q, type: ISSUE, first: $pageSize, after: $after) {
    ...PullSearchResults
  }
}
${PULL_FRAGMENTS}`

// The default-branch fields both branch scans read.
const BRANCH_REPO_FRAGMENT = `
fragment BranchRepo on Repository {
  nameWithOwner
  viewerPermission
  defaultBranchRef {
    name
    target {
      ... on Commit {
        oid
        committedDate
        author { user { login } }
        statusCheckRollup {
          state
          contexts(first: 20) {
            totalCount
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`

/** The branch refs field of a branch scan; `filter` adds refs arguments. */
const branchRefsField = (filter = '') => `branchRefs: refs(refPrefix: "refs/heads/", ${filter}first: 100, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      totalCount
      nodes {
        name
        target {
          __typename
          ... on Commit {
            oid
            committedDate
            author { user { login } }
            statusCheckRollup { state }
          }
        }
      }
    }`

/*
 * Branch CI only: repositories without pull requests. Per 100-repository page
 * the default-branch contexts need 100 requests and the branch refs 100, so a
 * page costs about 201 requests = 2 points. Branch refs are ordered by their
 * commit date (RefOrderField.TAG_COMMIT_DATE; GitHub documents it for tag
 * prefixes, so for branches it may be ignored). The window stays at 100 refs,
 * the size used before ordering was added, so an ignored order falls back to
 * the previous alphabetical coverage rather than a narrower one. A larger
 * `first` does not change the cost: it counts connections, not nodes.
 */
const BRANCH_SCAN_QUERY = `
query BranchScan($login: String!, $pageSize: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repositoryOwner(login: $login) {
    __typename
    login
    ... on User {
      repositories(first: $pageSize, after: $after, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
        ...BranchRepoConnection
      }
    }
    ... on Organization {
      repositories(first: $pageSize, after: $after, orderBy: {field: PUSHED_AT, direction: DESC}) {
        ...BranchRepoConnection
      }
    }
  }
}

fragment BranchRepoConnection on RepositoryConnection {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    ...BranchRepo
    ${branchRefsField()}
  }
}
${BRANCH_REPO_FRAGMENT}`

/*
 * Branch CI of a large source. The organization-wide scan times out there
 * (org:llvm: 502 at 25 repositories; llvm/llvm-project has 1,367 branches,
 * and the per-branch statusCheckRollup is the cost), and the viewer's own
 * branches are only a few among them. So a large source reads only the
 * repositories the viewer committed to or opened pull requests in during the
 * last year (one query per build, about 1 point), and in each of them only the
 * branches whose name contains the viewer login, such as llvm's
 * `users/<login>/...` convention. Verified on llvm/llvm-project: `refs(query:)`
 * is a case-insensitive substring match on the branch name, and one
 * repository took about 1 s for 1 point.
 */
const CONTRIBUTED_REPOS_QUERY = `
query ContributedRepos {
  rateLimit { cost remaining resetAt }
  viewer {
    contributionsCollection {
      commitContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
    }
  }
}
`

const BRANCH_SCAN_REPO_QUERY = `
query BranchScanRepo($owner: String!, $name: String!, $branchQuery: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ...BranchRepo
    ${branchRefsField('query: $branchQuery, ')}
  }
}
${BRANCH_REPO_FRAGMENT}`

/* -------------------------------------------------------------------------- */
/* gh runner                                                                  */
/* -------------------------------------------------------------------------- */

class GhError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GhError'
    this.code = code
  }
}

const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR: '0',
}

const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i
const RATE_LIMIT = /\b(?:rate limit|secondary rate limit|abuse detection)\b/i
const HTTP_STATUS = /\(HTTP (\d{3})\)/
// GitHub's answer when a GraphQL request runs past its server time limit, as
// gh reports it (measured): `gh: HTTP 502` or `gh: HTTP 504` for the HTML
// error page, `unexpected end of JSON input` for an empty body.
const GATEWAY_TIMEOUT = /\bHTTP 50[24]\b|unexpected end of JSON input/i
const isGraphqlRateLimit = (error) => Boolean(error &&
  (error.type === 'RATE_LIMITED' || RATE_LIMIT.test(String(error.message || ''))))

function firstLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line === undefined ? '' : line
}

function classifyGhFailure(result) {
  const message = firstLine(result.stderr) || firstLine(result.stdout) || `gh exited with code ${String(result.exitCode)}`
  if (AUTHENTICATION.test(message)) return new GhError('unauthenticated', message)
  const status = message.match(HTTP_STATUS)
  // GitHub also uses 403 for permission/SAML denials. Only an explicit
  // rate-limit message (or 429) means later sources must stop for quota.
  if (RATE_LIMIT.test(message) || (status !== null && status[1] === '429')) {
    return new GhError('rate-limit', message)
  }
  // The same request would most likely time out again; pull searches retry
  // it lighter instead (PULL_LEVELS), other queries retry it once.
  if (GATEWAY_TIMEOUT.test(message)) return new GhError('gateway-timeout', message)
  // Other 5xx and everything else is transient/unknown; ghGraphql retries 'failed'.
  return new GhError('failed', message)
}

function runGh(ctx, settings, args, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : settings.timeoutMs
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [settings.ghCommand, ...args],
      cwd: settings.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GH_MAX_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2000,
      signal,
      env: GH_ENV,
    })
  } catch (error) {
    throw new GhError('unavailable', `gh could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  return handle.done.then(
    (outcome) => {
      const out = handle.collected.stdout.readFrom(0)
      const err = handle.collected.stderr.readFrom(0)
      if (timeout.aborted) throw new GhError('timeout', `gh ${args[0] || ''} timed out after ${timeoutMs}ms`)
      if (out.lossy) throw new GhError('too-large', `gh ${args[0] || ''} output was too large`)
      const result = { exitCode: outcome.exitCode, signal: outcome.signal, stdout: out.text, stderr: err.text }
      if (result.exitCode !== 0) {
        // `gh api graphql` exits 1 when the response contains GraphQL `errors`,
        // even if partial `data` is present. Let ghGraphql parse and report it.
        const trimmed = out.text.trim()
        if (trimmed.startsWith('{')) {
          try {
            const payload = JSON.parse(trimmed)
            if (payload && payload.data !== undefined && payload.data !== null) return result
          } catch {
            // fall through to the classified failure
          }
        }
        throw classifyGhFailure(result)
      }
      return result
    },
    (error) => {
      if (error && error.code === 'ENOENT') {
        throw new GhError('unavailable', 'gh was not found on this machine, or its working directory is missing')
      }
      throw new GhError('unavailable', `gh could not run: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

async function ghGraphql(ctx, settings, query, variables, options = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) {
    // gh's -F parses typed scalars (booleans, numbers); -f keeps raw strings.
    const typed = typeof value === 'boolean' || typeof value === 'number'
    args.push(typed ? '-F' : '-f', `${key}=${value}`)
  }
  // One quiet retry for transient transport failures (TLS/proxy hiccups are
  // common on VPNs); authentication and rate-limit failures are final. An
  // oversized response would be just as large again, and a cancelled caller
  // wants no second attempt, so neither is retried. A GitHub timeout is
  // retried unless the caller has a lighter query to try instead
  // (`gatewayRetry: false`).
  const retryable = ['failed', 'timeout', ...(options.gatewayRetry === false ? [] : ['gateway-timeout'])]
  let result
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await runGh(ctx, settings, args, options)
      break
    } catch (error) {
      const transient = error instanceof GhError && retryable.includes(error.code)
      const cancelled = options.signal !== undefined && options.signal !== null && options.signal.aborted === true
      if (attempt === 0 && transient && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        continue
      }
      throw error
    }
  }
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new GhError('failed', 'gh returned non-JSON output')
  }
  const errors = Array.isArray(payload.errors) ? payload.errors : []
  if (payload.data === undefined || payload.data === null) {
    const message = errors.length > 0 ? String(errors[0].message || 'GraphQL error') : 'GraphQL response had no data'
    if (errors.some(isGraphqlRateLimit)) throw new GhError('rate-limit', message)
    throw new GhError('failed', message)
  }
  return { data: payload.data, errors }
}

/* -------------------------------------------------------------------------- */
/* Snapshot builder                                                           */
/* -------------------------------------------------------------------------- */

function iso(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The review with the latest `submittedAt`, or null for an empty list. */
function latestReview(reviews) {
  return reviews.reduce(
    (latest, review) => (latest === null || time(review && review.submittedAt) > time(latest.submittedAt) ? review : latest),
    null,
  )
}

function time(value) {
  const parsed = Date.parse(value === null || value === undefined ? '' : String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function maxIso(values) {
  let best = null
  let bestTime = 0
  for (const value of values) {
    if (typeof value !== 'string') continue
    const parsed = time(value)
    if (parsed > bestTime) {
      best = value
      bestTime = parsed
    }
  }
  return best
}

function checksFromRollup(rollup) {
  if (rollup === null || rollup === undefined) {
    return { state: 'none', failing: [], pending: 0, total: 0, truncated: false }
  }
  const contexts = (rollup.contexts && rollup.contexts.nodes) || []
  const failing = []
  let pending = 0
  for (const context of contexts) {
    if (context === null || context === undefined) continue
    if (context.__typename === 'CheckRun') {
      const conclusion = context.conclusion
      if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(conclusion)) {
        failing.push({ name: context.name || 'check', url: context.detailsUrl || null })
      } else if (context.status !== 'COMPLETED') {
        pending += 1
      }
    } else if (context.__typename === 'StatusContext') {
      if (['FAILURE', 'ERROR'].includes(context.state)) {
        failing.push({ name: context.context || 'status', url: context.targetUrl || null })
      } else if (['PENDING', 'EXPECTED'].includes(context.state)) {
        pending += 1
      }
    }
  }
  let state = 'none'
  if (rollup.state === 'SUCCESS') state = 'success'
  else if (rollup.state === 'FAILURE' || rollup.state === 'ERROR') state = 'failure'
  else if (rollup.state === 'PENDING' || rollup.state === 'EXPECTED') state = 'pending'
  else if (failing.length > 0) state = 'failure'
  else if (pending > 0) state = 'pending'
  const contextsInfo = rollup.contexts || {}
  const truncated = Boolean(contextsInfo.pageInfo && contextsInfo.pageInfo.hasNextPage)
  return { state, failing, pending, total: (contextsInfo.totalCount || contexts.length), truncated }
}

function labelsOf(node) {
  const labels = node.labels && node.labels.nodes
  if (!Array.isArray(labels)) return []
  return labels.map((label) => ({ name: label.name, color: label.color })).filter((label) => Boolean(label.name))
}

function assigneesOf(node) {
  const assignees = node.assignees && node.assignees.nodes
  if (!Array.isArray(assignees)) return []
  return assignees.map((entry) => entry && entry.login).filter(Boolean)
}

function authorOf(actor) {
  if (actor === null || actor === undefined) return { login: 'ghost', name: null, isBot: false, avatarUrl: null }
  return {
    login: actor.login || 'ghost',
    name: actor.name || null,
    isBot: actor.__typename === 'Bot',
    avatarUrl: actor.avatarUrl || null,
  }
}

/** The `settings` block a snapshot reports: the saved settings it was built for. */
function snapshotSettings(settings) {
  return {
    orgs: settings.orgs,
    includePersonal: settings.includePersonal,
    sourcesAuto: settings.orgs.length === 0,
    refreshSeconds: settings.refreshSeconds,
    requireGreenChecks: settings.requireGreenChecks,
    includeBotReviews: settings.includeBotReviews,
  }
}

/**
 * Build the snapshot. Throws a GhError on environment failures; section-level
 * failures are collected as warnings so one bad query does not blank the page.
 * `profiles` maps a source key to what earlier builds learned about that
 * source (`level`: its pull level, `large`); the snapshot store keeps one Map
 * for its lifetime, so a settings save starts over.
 */
async function buildSnapshot(ctx, settings, signal, profiles = new Map()) {
  const startedAt = Date.now()
  const warnings = []
  const truncated = { reviews: 0, comments: 0, threads: 0, search: 0 }
  const meta = { calls: [], rateLimit: null, durationMs: 0 }

  const viewerResult = await ghGraphql(ctx, settings, VIEWER_QUERY, {}, { signal })
  recordRateLimit(meta, viewerResult.data, 'ViewerSources')
  for (const error of viewerResult.errors) {
    warnings.push({ code: 'graphql-viewer', message: String((error && error.message) || 'GraphQL partial error') })
  }
  const viewerNode = viewerResult.data.viewer || {}
  const viewerLogin = viewerNode.login || ''
  if (viewerLogin === '') throw new GhError('unauthenticated', 'gh did not return a signed-in viewer')

  const memberOrgs = []
  const organizations = (viewerNode.organizations && viewerNode.organizations.nodes) || []
  for (const organization of organizations) {
    if (organization === null || organization === undefined || typeof organization.login !== 'string') continue
    memberOrgs.push(organization.login)
  }

  // Configured organizations win; auto-detection shares their quota bound.
  // Ask for one extra membership so truncation is explicit even at the limit.
  const selectedOrgs = settings.orgs.length > 0 ? settings.orgs : memberOrgs
  const uniqueOrgs = selectedOrgs.filter((login, index) =>
    selectedOrgs.findIndex((other) => other.toLowerCase() === login.toLowerCase()) === index,
  )
  const orgLogins = uniqueOrgs.slice(0, MAX_ORGS)
  if (uniqueOrgs.length > MAX_ORGS ||
      (settings.orgs.length === 0 && viewerNode.organizations?.pageInfo?.hasNextPage)) {
    warnings.push({ code: 'orgs-truncated', message: `Only ${MAX_ORGS} organizations are scanned; configure orgs to select which ones.` })
  }
  const sources = []
  if (settings.includePersonal) {
    sources.push({ kind: 'user', login: viewerLogin, label: viewerLogin })
  }
  for (const login of orgLogins) {
    if (!sources.some((source) => source.kind === 'org' && source.login === login)) {
      sources.push({ kind: 'org', login, label: login })
    }
  }
  if (sources.length === 0) {
    throw new GhError('no-sources', 'no sources are enabled; add an organization or enable personal repositories')
  }

  const sections = {
    review: [],
    rereview: [],
    merge: [],
    respond: [],
    ci: [],
    issues: [],
  }
  const reviewIds = new Set()
  const respondIds = new Set()
  const issueIds = new Set()
  const meLogins = new Set([viewerLogin, ...settings.meLogins].filter(Boolean))
  const today = new Date()
  const issueCutoff = new Date(today.getTime() - NEW_ISSUE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const pushUnique = (section, item) => {
    if (item === null || item === undefined) return
    if (sections[section].some((existing) => existing.id === item.id && existing.source.login === item.source.login)) return
    sections[section].push(item)
  }
  const pushIssue = (item) => {
    if (item === null || item === undefined) return
    const key = `${item.source.kind}:${item.source.login}:${item.id}`
    if (issueIds.has(key)) return
    issueIds.add(key)
    sections.issues.push(item)
  }

  const sourceSummaries = []
  let firstScanError = null
  let quotaExhausted = viewerResult.errors.some(isGraphqlRateLimit)

  // Gate for every query after ViewerSources. Returns false once GitHub has
  // reported a rate limit or the remaining quota reached MIN_RATE_REMAINING,
  // and records the `scan-budget` warning the first time it says no.
  const canStartQuery = () => {
    let reason = null
    if (quotaExhausted) {
      reason = 'GitHub reported a rate limit; remaining pages, sources and searches were skipped.'
    } else if (meta.rateLimit !== null && meta.rateLimit.remaining <= MIN_RATE_REMAINING) {
      reason = `Scan stopped to protect API quota (${meta.rateLimit.remaining} points remaining); some sources, searches or repositories were not scanned.`
    }
    if (reason === null) return true
    if (!warnings.some((warning) => warning.code === 'scan-budget')) warnings.push({ code: 'scan-budget', message: reason })
    return false
  }

  const sourceName = (source) => `${source.kind}:${source.login}`
  const errorText = (error) => (error instanceof Error ? error.message : String(error))

  // One GraphQL request for a source. Partial errors become warnings; a
  // rate-limit error (partial or thrown) stops the remaining queries.
  const runQuery = async (state, text, variables, call, warningCode, options = {}) => {
    try {
      const result = await ghGraphql(ctx, settings, text, variables, { ...options, signal })
      recordRateLimit(meta, result.data, `${call}:${sourceName(state.source)}`)
      if (result.errors.some(isGraphqlRateLimit)) quotaExhausted = true
      for (const error of result.errors) {
        warnings.push({
          code: warningCode,
          message: `${sourceName(state.source)}: ${String((error && error.message) || 'GraphQL partial error')}`,
        })
      }
      return result.data
    } catch (error) {
      if (error instanceof GhError && error.code === 'rate-limit') quotaExhausted = true
      throw error
    }
  }
  const sourceUnavailable = (state, what, error) => {
    warnings.push({ code: 'source-unavailable', message: `${sourceName(state.source)}: ${what} failed: ${errorText(error)}` })
  }

  // Pull requests are discovered per source by search, not by reading every
  // repository: GitHub's `review-requested:` also matches requests to teams
  // the viewer belongs to, `reviewed-by:` finds re-review candidates, and
  // `author:` covers merge/respond/CI. The searches use the signed-in viewer
  // only. Extra `meLogins` still classify ownership, requests and activity on
  // the PRs found, but are not searched themselves: every login would add
  // three more nested searches per source, and that quota is the reason this
  // layer moved to search.
  const PULL_SEARCHES = [
    { alias: 'reviewRequested', label: 'review requests', qualifier: `review-requested:${viewerLogin}` },
    { alias: 'reviewedBy', label: 'reviewed by you', qualifier: `reviewed-by:${viewerLogin}` },
    { alias: 'authored', label: 'authored by you', qualifier: `author:${viewerLogin}` },
  ]
  const prefixOf = (source) => (source.kind === 'org' ? `org:${source.login}` : `user:${source.login}`)
  const pullQuery = (source, search) =>
    `${prefixOf(source)} is:pr is:open archived:false ${search.qualifier} sort:updated-desc`

  const levelOf = (state) => PULL_LEVELS[state.profile.level]
  // The most pull requests one search reads at a level, over all its pages.
  const pullBound = (level) => level.pageSize * level.maxPages
  const isGatewayTimeout = (error) => error instanceof GhError && error.code === 'gateway-timeout'
  // A large source hides its new unassigned issues and gets the narrow branch
  // scan; it stays large for the life of its profile.
  const markLarge = (state) => {
    state.profile.large = true
  }
  const profileOf = (source) => {
    const key = `${source.kind}:${source.login.toLowerCase()}`
    if (!profiles.has(key)) profiles.set(key, { level: 0, large: false })
    return profiles.get(key)
  }
  const states = sources.map((source) => ({
    source,
    profile: profileOf(source),
    // `scanned`: a pull request search succeeded (the inbox guard below);
    // `reached`: any query of the source succeeded, so its results are shown.
    scanned: false,
    reached: false,
    teams: settings.teams,
    issueData: null,
    pulls: new Map(),
    pullPages: [],
    repos: [],
    seenRepos: new Set(),
    repoCursors: new Set(),
    repoAfter: null,
    repoTotal: 0,
    repoNext: true,
    repoMore: false,
    repoPages: 0,
    branchNarrowed: false,
  }))

  const pullsTruncated = (state, search, connection, read) => {
    const total = connection && typeof connection.issueCount === 'number' ? connection.issueCount : null
    warnings.push({
      code: 'prs-truncated',
      message: `${state.source.login}: only the ${read} most recently updated of ${total === null ? 'more' : total} open pull requests ${search.label} were read`,
    })
  }

  // Adds one search page to the source and queues the next page while the
  // per-alias page bound allows; a repeated cursor ends the alias.
  const collectPulls = (state, search, connection, page) => {
    if (!connection) return
    const entry = state.pullPages.find((pending) => pending.search === search) || null
    const cursors = entry === null ? new Set() : entry.cursors
    let read = entry === null ? 0 : entry.read
    for (const pr of connection.nodes || []) {
      const repoName = pr && pr.repository && pr.repository.nameWithOwner
      if (typeof repoName !== 'string' || typeof pr.number !== 'number') continue
      read += 1
      const key = `${repoName}#${pr.number}`
      const known = state.pulls.get(key)
      if (known) known.found.add(search.alias)
      else state.pulls.set(key, { pr, repoName, found: new Set([search.alias]) })
    }
    const cursor = connection.pageInfo && connection.pageInfo.endCursor
    const more = Boolean(connection.pageInfo && connection.pageInfo.hasNextPage)
    const level = levelOf(state)
    const next = more && typeof cursor === 'string' && cursor !== '' && !cursors.has(cursor) &&
      page < level.maxPages && read < pullBound(level)
    if (more && !next) pullsTruncated(state, search, connection, read)
    if (next) cursors.add(cursor)
    const pending = { search, cursors, read, after: next ? cursor : null, page, connection }
    state.pullPages = state.pullPages.filter((other) => other.search !== search).concat([pending])
  }

  const windowsOf = (level) => ({
    commentWindow: level.comments,
    threadWindow: level.threads,
    threadCommentWindow: level.threadComments,
  })
  const lightest = (state) => state.profile.level === PULL_LEVELS.length - 1
  // A GitHub timeout moves the source one pull level down, and a source that
  // needed a lighter level is large; false when the error is something else
  // or the source is already at the lightest level.
  const stepDown = (state, error) => {
    if (!isGatewayTimeout(error) || lightest(state)) return false
    state.profile.level += 1
    markLarge(state)
    return true
  }
  // One page of one search alias at the source's current level, stepping down
  // on GitHub timeouts; `read` is what the alias already holds, so the page is
  // cut to the level's bound (null once it is reached). Only the lightest
  // level retries a timeout as is.
  const searchPage = async (state, search, after, read) => {
    for (;;) {
      const level = levelOf(state)
      const pageSize = Math.min(level.pageSize, pullBound(level) - read)
      if (pageSize <= 0) return null
      try {
        const data = await runQuery(
          state,
          PULL_SEARCH_PAGE_QUERY,
          { q: pullQuery(state.source, search), pageSize, ...windowsOf(level), ...(after ? { after } : {}) },
          `search-page:${search.alias}`,
          'graphql-search',
          { gatewayRetry: lightest(state) },
        )
        return data.results || null
      } catch (error) {
        if (!stepDown(state, error)) throw error
      }
    }
  }
  const pullSearchFailed = (state, what, error) => {
    if (firstScanError === null) firstScanError = error
    sourceUnavailable(state, what, error)
  }

  // 1. Pull request discovery and issue searches for every source before any
  //    follow-up page, so a large source cannot use up the quota floor before
  //    the others are seen. A failed search loses only its own results: the
  //    other searches, issues and branch CI of the source still run.
  for (const state of states) {
    if (!canStartQuery()) break
    const { source } = state
    if (levelOf(state).combined) {
      const level = levelOf(state)
      const pullVariables = { login: source.login, viewerLogin, pullPageSize: level.pageSize, ...windowsOf(level) }
      for (const search of PULL_SEARCHES) pullVariables[`${search.alias}Q`] = pullQuery(source, search)
      try {
        const data = await runQuery(state, PULL_SEARCH_QUERY, pullVariables, 'pulls', 'graphql-search', { gatewayRetry: false })
        state.scanned = true
        const orgTeams = data.owner && data.owner.teams && Array.isArray(data.owner.teams.nodes)
          ? data.owner.teams.nodes.map((team) => team && team.slug).filter(Boolean)
          : []
        if (orgTeams.length > 0) state.teams = orgTeams
        for (const search of PULL_SEARCHES) collectPulls(state, search, data[search.alias], 1)
      } catch (error) {
        if (!stepDown(state, error)) pullSearchFailed(state, 'pull request search', error)
      }
    }
    // Split levels read each search on its own. Team membership is not read
    // there: a team request found by `review-requested:` is still trusted.
    if (!levelOf(state).combined) {
      for (const search of PULL_SEARCHES) {
        if (!canStartQuery()) break
        try {
          const results = await searchPage(state, search, null, 0)
          state.scanned = true
          collectPulls(state, search, results, 1)
        } catch (error) {
          pullSearchFailed(state, `pull request search (${search.label})`, error)
        }
      }
    }
    if (state.scanned) state.reached = true

    if (!canStartQuery()) break
    const prefix = prefixOf(source)
    try {
      state.issueData = await runQuery(
        state,
        ISSUE_SEARCH_QUERY,
        {
          assignedQ: `${prefix} is:issue is:open assignee:${viewerLogin} sort:updated-desc`,
          newIssuesQ: `${prefix} is:issue is:open no:assignee created:>${issueCutoff} sort:created-desc`,
          mentionsQ: `${prefix} is:open mentions:${viewerLogin} sort:updated-desc`,
        },
        'issues',
        'graphql-search',
      )
      state.reached = true
      // More new unassigned issues in 30 days than one page (50) is a source
      // too busy for that list to be triage material: it is large.
      const newIssues = state.issueData && state.issueData.newIssues
      if (newIssues && newIssues.pageInfo && newIssues.pageInfo.hasNextPage) markLarge(state)
    } catch (error) {
      warnings.push({ code: 'search-unavailable', message: `${source.login}: issue search failed: ${errorText(error)}` })
    }
  }

  // 2. Follow-up pull search pages, one round across all sources at a time.
  for (let page = 2; page <= MAX_PULL_PAGES; page += 1) {
    for (const state of states) {
      for (const pending of state.pullPages) {
        if (pending.after === null || pending.page !== page - 1) continue
        const after = pending.after
        pending.after = null
        if (!canStartQuery()) {
          pullsTruncated(state, pending.search, pending.connection, pending.read)
          continue
        }
        try {
          const results = await searchPage(state, pending.search, after, pending.read)
          if (results) collectPulls(state, pending.search, results, page)
          else pullsTruncated(state, pending.search, pending.connection, pending.read)
        } catch (error) {
          sourceUnavailable(state, `pull request search page (${pending.search.label})`, error)
          pullsTruncated(state, pending.search, pending.connection, pending.read)
        }
      }
    }
  }

  for (const state of states) {
    if (state.profile.level === 0) continue
    const level = levelOf(state)
    warnings.push({
      code: 'source-degraded',
      message: `${state.source.login}: GitHub timed out on the full pull request search, so each search reads at most ${pullBound(level)} pull requests, ${level.pageSize} per request`,
    })
  }

  // The repositories the viewer contributed to in the last year, read once
  // per build and only when a large source needs them.
  let contributedRepos = null
  const contributedReposOf = async (state) => {
    if (contributedRepos === null) {
      const data = await runQuery(state, CONTRIBUTED_REPOS_QUERY, {}, 'contributions', 'graphql-source')
      const collection = (data.viewer && data.viewer.contributionsCollection) || {}
      const names = [
        ...(collection.commitContributionsByRepository || []),
        ...(collection.pullRequestContributionsByRepository || []),
      ].map((entry) => entry && entry.repository && entry.repository.nameWithOwner).filter((name) => typeof name === 'string')
      contributedRepos = names.filter((name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index)
    }
    const owner = state.source.login.toLowerCase()
    return contributedRepos.filter((name) => name.split('/')[0].toLowerCase() === owner)
  }
  const addRepo = (state, repo) => {
    if (!repo || typeof repo.nameWithOwner !== 'string' || state.seenRepos.has(repo.nameWithOwner)) return
    state.seenRepos.add(repo.nameWithOwner)
    state.repos.push(repo)
  }
  // Branch CI of a large source: see BRANCH_SCAN_REPO_QUERY.
  const narrowBranchScan = async (state) => {
    state.repoNext = false
    state.branchNarrowed = true
    let contributed
    try {
      contributed = await contributedReposOf(state)
    } catch (error) {
      sourceUnavailable(state, 'branch scan (your contributed repositories)', error)
      return
    }
    const names = contributed.slice(0, MAX_CONTRIBUTED_REPOS)
    for (const name of names) {
      if (!canStartQuery()) return
      const [owner, repoName] = name.split('/')
      try {
        const data = await runQuery(
          state,
          BRANCH_SCAN_REPO_QUERY,
          { owner, name: repoName, branchQuery: viewerLogin },
          'branches-repo',
          'graphql-source',
        )
        addRepo(state, data.repository)
      } catch (error) {
        sourceUnavailable(state, `branch scan (${name})`, error)
      }
    }
    warnings.push({
      code: 'branch-scan-narrowed',
      message: `${state.source.login}: large source; branch CI covers only ${names.length < contributed.length ? `${names.length} of the ${contributed.length}` : `the ${names.length}`} repositories you contributed to in the last year, and in them only branches with "${viewerLogin}" in their name`,
    })
  }

  // 3. Branch CI scan: repositories only, one page per source per round. A
  //    large source, or one whose scan GitHub times out, is scanned narrowly.
  for (let page = 0; page < MAX_REPO_PAGES; page += 1) {
    for (const state of states) {
      if (!state.reached || !state.repoNext) continue
      if (!canStartQuery()) break
      if (state.profile.large) {
        await narrowBranchScan(state)
        continue
      }
      try {
        const data = await runQuery(
          state,
          BRANCH_SCAN_QUERY,
          { login: state.source.login, pageSize: REPO_PAGE_SIZE, ...(state.repoAfter ? { after: state.repoAfter } : {}) },
          'branches',
          'graphql-source',
          { gatewayRetry: false },
        )
        const owner = data.repositoryOwner
        if (!owner || !owner.repositories) {
          warnings.push({ code: 'source-empty', message: `${sourceName(state.source)}: no repositories were returned` })
          state.repoNext = false
          continue
        }
        const connection = owner.repositories
        state.repoPages += 1
        state.repoTotal = Math.max(state.repoTotal, connection.totalCount || 0)
        // Pushes can reorder the connection between pages; skip duplicates.
        for (const repo of connection.nodes || []) addRepo(state, repo)
        state.repoMore = Boolean(connection.pageInfo && connection.pageInfo.hasNextPage)
        const cursor = connection.pageInfo && connection.pageInfo.endCursor
        // A missing or repeated cursor ends this source's scan.
        state.repoNext = state.repoMore && typeof cursor === 'string' && cursor !== '' && !state.repoCursors.has(cursor)
        if (state.repoNext) {
          state.repoCursors.add(cursor)
          state.repoAfter = cursor
        }
      } catch (error) {
        if (isGatewayTimeout(error)) {
          markLarge(state)
          await narrowBranchScan(state)
        } else {
          sourceUnavailable(state, 'branch scan', error)
          state.repoNext = false
        }
      }
    }
  }

  const scannedSources = states.filter((state) => state.scanned).length
  // A source counts as scanned once its pull request discovery succeeded;
  // branch CI alone is not an inbox. When no source could be scanned (quota
  // exhausted after the cheap viewer query, a network drop, a reload), an
  // empty "nothing needs you" snapshot would be a lie and would be cached over
  // the last good one. Throw instead, so the caller serves the previous
  // snapshot as stale, or reports the error.
  if (scannedSources === 0 && firstScanError !== null) {
    if (firstScanError instanceof GhError) throw firstScanError
    throw new GhError('failed', firstScanError instanceof Error ? firstScanError.message : String(firstScanError))
  }

  if (scannedSources === 0 && warnings.some((warning) => warning.code === 'scan-budget')) {
    throw new GhError('rate-limit', 'API quota is too low to scan any source; try again after the quota resets')
  }

  if (scannedSources === 0) {
    throw new GhError('source-unavailable', 'No source could be scanned; pull request search data was unavailable')
  }

  for (const state of states) {
    if (!state.reached) continue
    const { source } = state
    if (!state.branchNarrowed && state.repoPages > 0 && (state.repoTotal > state.repos.length || state.repoMore)) {
      warnings.push({
        code: 'repos-truncated',
        message: `${source.login}: only ${state.repos.length} of ${state.repoTotal} repositories were scanned for branch CI`,
      })
    }
    sourceSummaries.push({ kind: source.kind, login: source.login, label: source.label, repos: state.repos.length })
    for (const { pr, repoName, found } of state.pulls.values()) classifyPull(state, pr, repoName, found)
    for (const repo of state.repos) classifyBranches(state, repo)
    if (state.issueData) classifySearch(state, state.issueData)
  }

  function classifyPull(state, pr, repoName, found) {
    const { source, teams } = state
    const author = authorOf(pr.author)
    const reviews = (pr.reviews && pr.reviews.nodes) || []
    const comments = (pr.comments && pr.comments.nodes) || []
    const isBotAuthor = (reviewAuthor) =>
      Boolean(reviewAuthor && (reviewAuthor.__typename === 'Bot' || reviewAuthor.isBot))
    const isMineAuthor = (reviewAuthor) =>
      Boolean(
        reviewAuthor &&
          reviewAuthor.login &&
          (meLogins.has(reviewAuthor.login) || (settings.includeBotReviews && isBotAuthor(reviewAuthor))),
      )
    const myReviews = reviews.filter((review) => review && review.author && isMineAuthor(review.author))
    const myComments = comments.filter((comment) => comment && comment.author && meLogins.has(comment.author.login))
    const windowedReview = latestReview(myReviews)
    const viewerLatestReview =
      pr.viewerLatestReview && pr.viewerLatestReview.submittedAt ? pr.viewerLatestReview : null
    const myLastReview =
      viewerLatestReview === null
        ? windowedReview
        : windowedReview === null || time(viewerLatestReview.submittedAt) >= time(windowedReview.submittedAt)
          ? viewerLatestReview
          : windowedReview
    const myLastReviewAt = myLastReview === null ? null : iso(myLastReview.submittedAt)
    const otherReviews = reviews.filter(
      (review) => review && review.author && !isMineAuthor(review.author),
    )
    const otherComments = comments.filter(
      (comment) => comment && comment.author && !meLogins.has(comment.author.login),
    )
    if (pr.reviews && pr.reviews.pageInfo && pr.reviews.pageInfo.hasPreviousPage) truncated.reviews += 1
    if (pr.comments && pr.comments.pageInfo && pr.comments.pageInfo.hasPreviousPage) truncated.comments += 1
    // `last:` windows report older items through hasPreviousPage.
    if (pr.reviewThreads && pr.reviewThreads.pageInfo && pr.reviewThreads.pageInfo.hasPreviousPage) truncated.threads += 1
    const threads = (pr.reviewThreads && pr.reviewThreads.nodes) || []
    const threadComments = []
    for (const thread of threads) {
      if (thread && thread.comments && thread.comments.pageInfo && thread.comments.pageInfo.hasPreviousPage) {
        truncated.threads += 1
      }
      for (const comment of (thread && thread.comments && thread.comments.nodes) || []) {
        if (comment) threadComments.push(comment)
      }
    }
    const myLastActionAt = maxIso([
      myLastReviewAt,
      ...myComments.map((comment) => comment && comment.createdAt),
      ...threadComments
        .filter((comment) => comment && comment.author && meLogins.has(comment.author.login))
        .map((comment) => comment.createdAt),
    ])
    const authorLastReplyToMeAt = maxIso(
      [...comments, ...threadComments]
        .filter(
          (comment) =>
            comment !== null &&
            comment !== undefined &&
            comment.author &&
            comment.author.login === author.login &&
            commentRepliesToViewer(comment, meLogins),
        )
        .map((comment) => comment.createdAt),
    )
    const otherLastReview = latestReview(otherReviews)
    // Inline follow-ups can arrive after the review was submitted. Count
    // them like top-level comments, including when comparing an approval.
    const otherLastCommentAt = maxIso([
      ...otherComments.map((comment) => comment && comment.createdAt),
      ...threadComments
        .filter((comment) => comment.author && !meLogins.has(comment.author.login))
        .map((comment) => comment.createdAt),
    ])
    const otherLastAt = maxIso([
      ...otherReviews.map((review) => review.submittedAt),
      otherLastCommentAt,
    ])
    // A newer approval is not a request for changes; it moves the PR toward
    // the merge section instead of the "needs your action" one.
    const lastOtherIsApproval =
      otherLastReview !== null &&
      otherLastReview.state === 'APPROVED' &&
      time(otherLastReview.submittedAt) >= time(otherLastCommentAt)
    const lastReviewNode = latestReview(reviews)
    const lastActivityAt = maxIso([otherLastAt, myLastActionAt])
    const commitNode = pr.commits && pr.commits.nodes && pr.commits.nodes[0]
    const headCommit = commitNode && commitNode.commit
    const headAt = headCommit ? iso(headCommit.committedDate) : null
    const checks = checksFromRollup(headCommit ? headCommit.statusCheckRollup : null)
    const requestedReviewers = (pr.reviewRequests && pr.reviewRequests.nodes) || []
    let directRequest = false
    let teamRequest = null
    for (const entry of requestedReviewers) {
      const reviewer = entry && entry.requestedReviewer
      if (reviewer === null || reviewer === undefined) continue
      if (reviewer.__typename === 'User' && meLogins.has(reviewer.login)) directRequest = true
      if (reviewer.__typename === 'Team' && teams.includes(reviewer.slug)) teamRequest = reviewer.slug || reviewer.teamName
    }
    // GitHub's review-requested search already matched this PR through one of
    // the viewer's teams. When that team is missing from the fetched
    // membership (no read:org scope, more than 50 teams, nested teams), trust
    // the search and name the first team that is still requested. The live
    // reviewRequests list must still contain a team, so a stale search index
    // cannot resurrect a request that was already satisfied.
    if (!directRequest && teamRequest === null && found.has('reviewRequested')) {
      const team = requestedReviewers
        .map((entry) => entry && entry.requestedReviewer)
        .find((reviewer) => reviewer && reviewer.__typename === 'Team')
      if (team) teamRequest = team.slug || team.teamName || 'team'
    }
    const requestedFromMe = directRequest || teamRequest !== null
    const isMine = meLogins.has(author.login)
    const sourceRef = { kind: source.kind, login: source.login, label: source.label }
    const base = {
      id: `${repoName}#${pr.number}`,
      kind: 'pull',
      source: sourceRef,
      repo: repoName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author,
      createdAt: iso(pr.createdAt),
      updatedAt: iso(pr.updatedAt),
      draft: Boolean(pr.isDraft),
      reviewDecision: pr.reviewDecision || null,
      mergeable: pr.mergeable || null,
      mergeStateStatus: pr.mergeStateStatus || null,
      headRefName: pr.headRefName || null,
      checks,
      labels: labelsOf(pr),
      assignees: assigneesOf(pr),
      myReview: myLastReview === null ? null : { state: myLastReview.state, submittedAt: myLastReviewAt },
      lastActivity:
        lastActivityAt === null
          ? null
          : {
              kind: lastReviewNode !== null && lastReviewNode.submittedAt === lastActivityAt ? 'review' : 'comment',
              author:
                lastReviewNode !== null && lastReviewNode.submittedAt === lastActivityAt
                  ? lastReviewNode.author && lastReviewNode.author.login
                  : null,
              at: lastActivityAt,
              mine: myLastActionAt !== null && myLastActionAt === lastActivityAt,
            },
    }

    const botLastReview = lastReviewNode !== null && lastReviewNode.author && lastReviewNode.author.__typename === 'Bot'
    const firstPassDetail = botLastReview ? `first pass by ${lastReviewNode.author.login} (${lastReviewNode.state} review)` : null

    // Compare the commit my last review was attached to with the current
    // head: committer dates can predate my review (a commit made before
    // the review and pushed after it, rebases, clock skew). Fall back to
    // the dates only when GitHub did not return both object ids.
    const headOid = pr.headRefOid || (headCommit && headCommit.oid) || null
    const myReviewOid =
      myLastReview !== null && myLastReview.commit && typeof myLastReview.commit.oid === 'string'
        ? myLastReview.commit.oid
        : null
    const reviewedHead =
      myLastReview !== null &&
      (headOid !== null && myReviewOid !== null ? myReviewOid === headOid : time(myLastReview.submittedAt) >= time(headAt))
    const shortHead = headOid !== null ? headOid.slice(0, 7) : null

    if (!base.draft && !isMine && requestedFromMe) {
      if (!reviewedHead) {
        const reviewedByOthers = reviews.some(
          (review) => review && review.author && !isMineAuthor(review.author) && review.state === 'APPROVED',
        )
        const details = []
        details.push(directRequest ? 'direct review request' : `team ${teamRequest} request (you are a member)`)
        if (firstPassDetail !== null) details.push(firstPassDetail)
        // Optional only while someone else's approval stands and GitHub does
        // not report missing or blocking reviews: then this request no longer
        // gates the merge, and the panel leaves it out of the attention badge.
        const optional =
          reviewedByOthers && base.reviewDecision !== 'REVIEW_REQUIRED' && base.reviewDecision !== 'CHANGES_REQUESTED'
        if (optional) details.push('already approved by someone else; your review is optional')
        const item = {
          ...base,
          section: 'review',
          reason: directRequest ? 'review-requested' : 'team-review-requested',
          reasonDetail: details.join('; '),
          optional,
          waitingOn: [directRequest ? 'you' : `team:${teamRequest}`],
        }
        sections.review.push(item)
        reviewIds.add(item.id)
      }
    }

    if (!base.draft && !isMine && myLastReview !== null && !reviewIds.has(base.id)) {
      const newHead = !reviewedHead && ((headOid !== null && myReviewOid !== null) || headAt !== null)
      // GitHub drops a reviewer from the pending requests once they
      // review, so a direct request listed again after my review is the
      // author's explicit "Re-request review". Team requests are not used:
      // they can outlive one member's review.
      const reRequested = directRequest
      // A re-review is justified by new commits, an explicit re-request, or
      // the author replying to me: a threaded reply to my comment or an
      // @-mention in a comment. Other activity alone does not ask me for
      // another pass.
      const authorReplied =
        authorLastReplyToMeAt !== null &&
        (myLastActionAt === null || time(authorLastReplyToMeAt) > time(myLastActionAt))
      if (newHead || reRequested || authorReplied) {
        const details = []
        if (newHead) details.push(shortHead !== null ? `new head ${shortHead} committed ${headAt}` : `new head committed ${headAt}`)
        if (reRequested) details.push('the author re-requested your review')
        if (authorReplied) details.push(`author replied to you at ${authorLastReplyToMeAt}`)
        if (myLastActionAt !== null) details.push(`your last action was ${myLastActionAt}`)
        sections.rereview.push({
          ...base,
          section: 'rereview',
          // New commits and explicit re-requests are the main triggers; an
          // author reply alone is secondary and rendered quieter.
          rereviewCause: newHead ? 'new-head' : reRequested ? 're-requested' : 'author-reply',
          reason: newHead || !reRequested ? 'changes-after-my-review' : 're-review-requested',
          reasonDetail: details.join('; '),
        })
      }
    }

    // Conflict-free does not mean repository rules permit the merge.
    // A policy block still applies when the user allows non-green checks.
    if (isMine && !base.draft && base.mergeable === 'MERGEABLE' && base.mergeStateStatus !== 'BLOCKED') {
      const approved = base.reviewDecision === 'APPROVED' || base.reviewDecision === null
      const checksGreen = checks.state === 'success' || checks.state === 'none'
      if (approved && (!settings.requireGreenChecks || checksGreen)) {
        sections.merge.push({
          ...base,
          section: 'merge',
          reason: 'ready-to-merge',
          reasonDetail: `review decision ${base.reviewDecision === null ? 'none required' : 'approved'}; checks ${checks.state}`,
        })
      } else if (approved && checks.state === 'failure') {
        sections.merge.push({
          ...base,
          section: 'merge',
          reason: 'approved-checks-failing',
          reasonDetail: 'approved, but checks are red; this repository may not require green checks',
        })
      }
    }

    if (isMine && !base.draft) {
      const reasons = []
      if (base.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes-requested')
      if (base.mergeable === 'CONFLICTING') reasons.push('conflict')
      const newerActivity = otherLastAt !== null && (myLastActionAt === null || time(otherLastAt) > time(myLastActionAt))
      if (newerActivity && !lastOtherIsApproval) reasons.push('review-feedback')
      if (reasons.length > 0) {
        sections.respond.push({
          ...base,
          section: 'respond',
          reason: reasons[0],
          reasonDetail: reasons.join('; '),
        })
        respondIds.add(base.id)
      }
    }

    if (isMine && checks.state === 'failure') {
      pushUnique('ci', {
        ...base,
        section: 'ci',
        reason: 'checks-failing',
        reasonDetail: `${checks.failing.length} failing check(s) on the pull request head`,
      })
    }
  }

  function classifyBranches(state, repo) {
    const { source } = state
    const repoName = repo.nameWithOwner
    const canSeeBranchHealth = repo.viewerPermission === 'ADMIN' || repo.viewerPermission === 'MAINTAIN'
    const defaultBranch = repo.defaultBranchRef
    if (defaultBranch && defaultBranch.target) {
      const target = defaultBranch.target
      const branchChecks = checksFromRollup(target.statusCheckRollup)
      const commitAuthor = target.author && target.author.user ? target.author.user.login : null
      // Default refs follow the same recent-author rule as feature branches,
      // even without admin rights or an entry in the bounded branchRefs list.
      const recentlyAuthored = meLogins.has(commitAuthor)
        && time(target.committedDate) >= Date.now() - LOOKBACK_DAYS * 86_400_000
      if ((canSeeBranchHealth || recentlyAuthored) && branchChecks.state === 'failure') {
        sections.ci.push({
          id: `${source.login}@${repoName}@${defaultBranch.name}`,
          kind: 'branch',
          source: { kind: source.kind, login: source.login, label: source.label },
          section: 'ci',
          repo: repoName,
          ref: defaultBranch.name,
          defaultBranch: true,
          commit: target.oid || null,
          title: `${defaultBranch.name} — ${repoName}`,
          url: `https://github.com/${repoName}/tree/${defaultBranch.name}`,
          author: { login: commitAuthor || 'unknown', name: null, isBot: false, avatarUrl: null },
          createdAt: null,
          updatedAt: iso(target.committedDate),
          reason: 'branch-checks-failing',
          reasonDetail: canSeeBranchHealth
            ? 'default branch of a repository you administer'
            : 'branch you pushed in the last week',
          checks: branchChecks,
          labels: [],
          assignees: [],
        })
      }
    }
    for (const branch of (repo.branchRefs && repo.branchRefs.nodes) || []) {
      if (branch === null || branch === undefined || !branch.target) continue
      if (defaultBranch && branch.name === defaultBranch.name) continue
      const target = branch.target
      const author = target.author && target.author.user ? target.author.user.login : null
      if (!meLogins.has(author)) continue
      if (time(target.committedDate) < Date.now() - LOOKBACK_DAYS * 86_400_000) continue
      const rollup = target.statusCheckRollup
      if (!rollup || (rollup.state !== 'FAILURE' && rollup.state !== 'ERROR')) continue
      sections.ci.push({
        id: `${source.login}@${repoName}@${branch.name}`,
        kind: 'branch',
        source: { kind: source.kind, login: source.login, label: source.label },
        section: 'ci',
        repo: repoName,
        ref: branch.name,
        defaultBranch: false,
        commit: target.oid || null,
        title: `${branch.name} — ${repoName}`,
        url: `https://github.com/${repoName}/tree/${branch.name}`,
        author: { login: author, name: null, isBot: false, avatarUrl: null },
        createdAt: null,
        updatedAt: iso(target.committedDate),
        reason: 'branch-checks-failing',
        reasonDetail: 'branch you pushed in the last week',
        checks: { state: 'failure', failing: [], pending: 0, total: 0, truncated: false },
        labels: [],
        assignees: [],
      })
    }
  }

  // Search-backed sections are scoped to one source at a time so that every
  // item carries an unambiguous source.
  function classifySearch(state, data) {
    const { source } = state
    if (
      (data.assignedIssues && data.assignedIssues.pageInfo && data.assignedIssues.pageInfo.hasNextPage) ||
      // A large source does not list new issues, so their pages are not history.
      (!state.profile.large && data.newIssues && data.newIssues.pageInfo && data.newIssues.pageInfo.hasNextPage) ||
      (data.mentions && data.mentions.pageInfo && data.mentions.pageInfo.hasNextPage)
    ) {
      truncated.search += 1
    }
    const sourceRef = { kind: source.kind, login: source.login, label: source.label }

    const mentions = (data.mentions && data.mentions.nodes) || []
    for (const node of mentions) {
      if (node === null || node === undefined) continue
      const repoName = node.repository && node.repository.nameWithOwner
      if (!repoName) continue
      const author = authorOf(node.author)
      const comments = (node.comments && node.comments.nodes) || []
      const mine = comments.filter((comment) => comment && comment.author && meLogins.has(comment.author.login))
      const others = comments.filter((comment) => comment && comment.author && !meLogins.has(comment.author.login))
      // Owning the issue/PR does not answer somebody else's mention. Only
      // ignore self-authored search hits with no activity from anyone else.
      if (meLogins.has(author.login) && others.length === 0) continue
      const lastMine = maxIso(mine.map((comment) => comment && comment.createdAt))
      const lastOther = maxIso(others.map((comment) => comment && comment.createdAt))
      const needsReply = mine.length === 0 || (lastOther !== null && (lastMine === null || time(lastOther) > time(lastMine)))
      if (!needsReply) continue
      const id = `${repoName}#${node.number}`
      if (respondIds.has(id)) continue
      respondIds.add(id)
      const isPull = node.url && node.url.includes('/pull/')
      sections.respond.push({
        id,
        kind: isPull ? 'pull' : 'issue',
        source: sourceRef,
        section: 'respond',
        repo: repoName,
        number: node.number,
        title: node.title,
        url: node.url,
        author,
        createdAt: iso(node.createdAt),
        updatedAt: iso(node.updatedAt),
        reviewDecision: node.reviewDecision || null,
        mergeable: node.mergeable || null,
        checks: null,
        labels: labelsOf(node),
        assignees: assigneesOf(node),
        reason: 'mentioned',
        reasonDetail:
          mine.length === 0
            ? 'you were @-mentioned and have not replied yet'
            : `you were @-mentioned; the latest comment is newer than your reply (${lastOther})`,
        lastActivity: lastOther === null ? null : { kind: 'comment', author: null, at: lastOther, mine: false },
      })
    }

    const assignedIssues = (data.assignedIssues && data.assignedIssues.nodes) || []
    for (const node of assignedIssues) {
      if (node === null || node === undefined) continue
      const repoName = node.repository && node.repository.nameWithOwner
      if (!repoName) continue
      // An assigned issue needs the assignee's action, so it belongs with
      // "Needs your action"; the Issues section is only for unassigned work.
      const item = issueItem(node, repoName, 'assigned-to-you', 'assigned to you', sourceRef)
      item.section = 'respond'
      if (respondIds.has(item.id)) continue
      respondIds.add(item.id)
      sections.respond.push(item)
    }
    const newIssues = (data.newIssues && data.newIssues.nodes) || []
    if (state.profile.large) {
      const count = data.newIssues && typeof data.newIssues.issueCount === 'number' ? data.newIssues.issueCount : newIssues.length
      if (count > 0) {
        warnings.push({
          code: 'new-issues-skipped',
          message: `${source.login}: ${count} new unassigned issues in the last ${NEW_ISSUE_WINDOW_DAYS} days; the list is not shown for a source this large`,
        })
      }
      return
    }
    for (const node of newIssues) {
      if (node === null || node === undefined) continue
      const repoName = node.repository && node.repository.nameWithOwner
      if (!repoName) continue
      const permission = node.repository && node.repository.viewerPermission
      if (permission !== 'ADMIN' && permission !== 'MAINTAIN') continue
      // Only unassigned new issues are triage material; issues already given
      // to someone else are their work, not this inbox's.
      const assignees = assigneesOf(node)
      if (assignees.length > 0) continue
      pushIssue(
        issueItem(
          node,
          repoName,
          'new-unassigned',
          `opened in the last ${NEW_ISSUE_WINDOW_DAYS} days and unassigned`,
          sourceRef,
        ),
      )
    }
  }


  const truncatedTotal = truncated.reviews + truncated.comments + truncated.threads + truncated.search
  if (truncatedTotal > 0) {
    const parts = []
    if (truncated.reviews > 0) parts.push(`${truncated.reviews} PR(s) with older reviews`)
    if (truncated.comments > 0) parts.push(`${truncated.comments} PR(s) with older comments`)
    if (truncated.threads > 0) parts.push(`${truncated.threads} PR(s) with older review threads`)
    if (truncated.search > 0) parts.push(`${truncated.search} source(s) with truncated search results`)
    warnings.push({
      code: 'truncated-history',
      message:
        `Older history exists beyond the fetched windows: ${parts.join(', ')}. ` +
        'Your latest review is always fetched, but very old comments/threads may be invisible.',
    })
  }

  sortSections(sections)

  const counts = {}
  let total = 0
  for (const id of Object.keys(sections)) {
    counts[id] = sections[id].length
    total += sections[id].length
  }
  counts.total = total
  meta.durationMs = Date.now() - startedAt
  // Truncation is informational: do not paint the whole panel as "partial"
  // just because a long PR has older pages.
  const status = warnings.some((warning) => warning.code !== 'truncated-history') ? 'partial' : 'ok'
  const orgLoginsScanned = sources.filter((source) => source.kind === 'org').map((source) => source.login)

  return {
    ok: true,
    status,
    generatedAt: new Date().toISOString(),
    sources: sourceSummaries,
    orgs: orgLoginsScanned,
    org: orgLoginsScanned.length > 0 ? orgLoginsScanned[0] : '',
    user: { login: viewerLogin, name: viewerNode.name || null, avatarUrl: viewerNode.avatarUrl || null },
    settings: snapshotSettings(settings),
    counts,
    sections: Object.keys(sections).map((id) => ({ id, items: sections[id] })),
    warnings,
    meta,
  }
}

function issueItem(node, repoName, reason, reasonDetail, source) {
  return {
    id: `${repoName}#${node.number}`,
    kind: 'issue',
    source,
    section: 'issues',
    repo: repoName,
    number: node.number,
    title: node.title,
    url: node.url,
    author: authorOf(node.author),
    createdAt: iso(node.createdAt),
    updatedAt: iso(node.updatedAt),
    checks: null,
    labels: labelsOf(node),
    assignees: assigneesOf(node),
    reason,
    reasonDetail,
    lastActivity: null,
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@login` mention patterns, compiled once per login. */
const mentionPatterns = new Map()

function mentionPattern(login) {
  let pattern = mentionPatterns.get(login)
  if (pattern === undefined) {
    pattern = new RegExp('(^|[^\\w-])@' + escapeRegExp(login) + '(?![\\w-])', 'i')
    mentionPatterns.set(login, pattern)
  }
  return pattern
}

/**
 * The prose of a markdown comment body: HTML comments, fenced code blocks
 * (``` or ~~~, also one left open), inline code spans and quoted lines are
 * dropped, so a login in a template comment, pasted code, a bot's diff or a
 * quoted earlier comment is no mention (`bodyText` left HTML comments out,
 * and GitHub does not notify for @-mentions in code either).
 */
function commentProse(body) {
  const kept = []
  let fence = null
  for (const line of body.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }
    if (/^\s{0,3}>/.test(line)) continue
    kept.push(line.replace(/(`+)[^`]*?\1/g, ' '))
  }
  return kept.join('\n')
}

/** True when a comment's markdown body @-mentions one of the viewer logins outside code and quotes. */
function commentMentionsViewer(body, meLogins) {
  if (typeof body !== 'string' || body === '') return false
  const prose = commentProse(body)
  for (const login of meLogins) {
    if (mentionPattern(login).test(prose)) return true
  }
  return false
}

/** True when the comment replies to a viewer comment or explicitly mentions the viewer. */
function commentRepliesToViewer(comment, meLogins) {
  const target = comment && comment.replyTo && comment.replyTo.author && comment.replyTo.author.login
  if (target && meLogins.has(target)) return true
  return commentMentionsViewer(comment && comment.body, meLogins)
}

function recordRateLimit(meta, data, call) {
  const rateLimit = data && data.rateLimit
  if (rateLimit === null || rateLimit === undefined) return
  meta.calls.push({ call, cost: rateLimit.cost, remaining: rateLimit.remaining })
  meta.rateLimit = {
    cost: (meta.rateLimit ? meta.rateLimit.cost : 0) + (Number(rateLimit.cost) || 0),
    remaining: Number(rateLimit.remaining) || 0,
    resetAt: rateLimit.resetAt || null,
  }
}

function sortSections(sections) {
  sections.review.sort((left, right) => {
    const leftApproved = left.reviewDecision === 'APPROVED' ? 1 : 0
    const rightApproved = right.reviewDecision === 'APPROVED' ? 1 : 0
    if (leftApproved !== rightApproved) return leftApproved - rightApproved
    const leftDirect = left.reason === 'review-requested' ? 0 : 1
    const rightDirect = right.reason === 'review-requested' ? 0 : 1
    if (leftDirect !== rightDirect) return leftDirect - rightDirect
    return time(left.createdAt) - time(right.createdAt)
  })
  sections.rereview.sort((left, right) => {
    const leftSecondary = left.rereviewCause === 'author-reply' ? 1 : 0
    const rightSecondary = right.rereviewCause === 'author-reply' ? 1 : 0
    if (leftSecondary !== rightSecondary) return leftSecondary - rightSecondary
    return time(right.lastActivity && right.lastActivity.at) - time(left.lastActivity && left.lastActivity.at)
  })
  sections.merge.sort((left, right) => time(right.updatedAt) - time(left.updatedAt))
  sections.respond.sort((left, right) => {
    const leftPull = left.kind === 'pull' ? 0 : 1
    const rightPull = right.kind === 'pull' ? 0 : 1
    if (leftPull !== rightPull) return leftPull - rightPull
    return time(right.updatedAt) - time(left.updatedAt)
  })
  sections.ci.sort((left, right) => {
    const leftPull = left.kind === 'pull' ? 0 : 1
    const rightPull = right.kind === 'pull' ? 0 : 1
    if (leftPull !== rightPull) return leftPull - rightPull
    return String(left.repo).localeCompare(String(right.repo)) || String(left.id).localeCompare(String(right.id))
  })
  // The Issues section contains only unassigned new issues, newest first.
  sections.issues.sort((left, right) => time(right.createdAt) - time(left.createdAt))
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeSettings(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
  const strings = (value) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : []
  // Sources: an explicit organization list wins; otherwise up to MAX_ORGS
  // memberships are used.
  const configuredOrgs = Array.isArray(input.orgs)
    ? input.orgs.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : []
  const orgs = Array.from(new Set(configuredOrgs)).slice(0, MAX_ORGS)
  const refreshSeconds = clamp(positive(input.refreshSeconds, REFRESH_SECONDS.default), REFRESH_SECONDS.min, REFRESH_SECONDS.max)
  // A 20-minute default poll should really re-read GitHub; keep at least a
  // 5-minute cache floor so a short interval cannot burn the API quota.
  const ttlMs = clamp(positive(input.ttlMs, Math.max(refreshSeconds, 600) * 1000), 600_000, 3_600_000)
  return {
    orgs,
    includePersonal: input.includePersonal !== false,
    ghCommand: typeof input.ghCommand === 'string' && input.ghCommand.length > 0 ? input.ghCommand : 'gh',
    cwd: typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : homedir(),
    refreshSeconds,
    ttlMs,
    timeoutMs: positive(input.timeoutMs, GH_TIMEOUT_MS),
    requireGreenChecks: input.requireGreenChecks !== false,
    includeBotReviews: input.includeBotReviews === true,
    meLogins: strings(input.meLogins),
    teams: strings(input.teams),
  }
}

export { buildSnapshot, normalizeSettings, snapshotSettings, SECTION_IDS, GhError, NEW_ISSUE_WINDOW_DAYS }
