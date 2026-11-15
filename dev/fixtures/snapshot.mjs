/**
 * Deterministic snapshot used by the client render smoke. It is deliberately
 * small but exercises every section and the row variants the panel renders.
 */
const now = '2026-01-01T10:00:00.000Z'

function item(section, kind, number, title, extra = {}) {
  return {
    id: `${kind}:${number}`,
    kind,
    section,
    source: { kind: 'user', login: 'tester' },
    repo: 'tester/example',
    number: kind === 'branch' ? undefined : number,
    ref: kind === 'branch' ? 'main' : undefined,
    title,
    url:
      kind === 'issue'
        ? `https://github.com/tester/example/issues/${number}`
        : kind === 'branch'
          ? 'https://github.com/tester/example/commits/main'
          : `https://github.com/tester/example/pull/${number}`,
    author: { login: 'reviewer', name: 'Reviewer', isBot: false },
    createdAt: now,
    updatedAt: now,
    lastActivity: { kind: 'comment', author: 'reviewer', at: now },
    reason: section === 'review' ? 'review-requested' : 'new-head',
    checks: { state: 'success', total: 2, failing: [] },
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    waitingOn: section === 'review' ? ['@reviewer'] : [],
    labels: [{ name: 'ready-for-review', color: '0e8a16' }],
    assignees: [],
    ...extra,
  }
}

export const snapshot = {
  ok: true,
  status: 'ok',
  generatedAt: now,
  counts: { review: 1, rereview: 1, merge: 1, respond: 1, ci: 2, issues: 1, total: 7 },
  sources: [{ kind: 'user', login: 'tester', label: 'tester' }],
  settings: {
    refreshSeconds: 1200,
    requireGreenChecks: true,
    includeBotReviews: false,
    sourcesAuto: true,
  },
  warnings: [],
  meta: { rateLimit: { remaining: 4000, resetAt: '2026-01-01T11:00:00.000Z' } },
  sections: [
    {
      id: 'review',
      items: [item('review', 'pull', 1, 'Review requested PR')],
    },
    {
      id: 'rereview',
      items: [item('rereview', 'pull', 2, 'Re-review needed PR', { rereviewCause: 'new-head' })],
    },
    {
      id: 'merge',
      items: [item('merge', 'pull', 3, 'Merge-ready PR')],
    },
    {
      id: 'respond',
      items: [item('respond', 'pull', 4, 'Needs an answer PR', { reviewDecision: 'CHANGES_REQUESTED' })],
    },
    {
      id: 'ci',
      items: [
        // The same pull request as in `respond`: one PR can sit in several
        // sections, and its row state must stay per section.
        item('ci', 'pull', 4, 'Needs an answer PR', {
          reviewDecision: 'CHANGES_REQUESTED',
          checks: { state: 'failure', total: 2, failing: [{ name: 'test', url: 'https://example.com/run/2' }] },
        }),
        item('ci', 'branch', 0, 'main', { checks: { state: 'failure', total: 2, failing: [{ name: 'test', url: 'https://example.com/run/1' }] } }),
      ],
    },
    {
      id: 'issues',
      items: [item('issues', 'issue', 5, 'New unassigned issue', { reason: 'new-unassigned' })],
    },
  ],
}
