/**
 * Triage Desk — GitHub CLI discovery and auth status, plus the local git binary
 * used by the clone picker.
 */

export function createGh({ settings, platform, findExecutable, runProcess }) {
  let ghResolved = false

  const findGh = async () => {
    const fallbacks =
      platform === 'win32'
        ? ['C:\\Program Files\\GitHub CLI\\gh.exe']
        : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
    return findExecutable([settings.ghCommand, ...fallbacks])
  }

  /** The local git binary for the folder picker; never a hard-coded POSIX path. */
  const resolveGit = async () => (await findExecutable(['git', '/usr/bin/git', '/opt/homebrew/bin/git'])) || 'git'

  const resolveGh = async () => {
    if (ghResolved) return
    ghResolved = true
    const resolved = await findGh()
    if (resolved !== null) settings.ghCommand = resolved
  }

  const readGhAuth = async () => {
    const gh = await findGh()
    if (gh === null) {
      return {
        available: false,
        authenticated: false,
        path: null,
        login: null,
        scopes: [],
        install: { command: 'brew install gh', url: 'https://cli.github.com/' },
      }
    }
    const result = await runProcess([gh, 'auth', 'status', '--hostname', 'github.com'], {
      cwd: settings.cwd,
      timeoutMs: 15_000,
    })
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    const account = /(?:^|\s)account\s+([A-Za-z0-9-]+)/i.exec(text) || /(?:^|\s)as\s+([A-Za-z0-9-]+)/i.exec(text)
    const scopeMatch = /Token scopes:\s*(.+)/i.exec(text)
    const scopes = scopeMatch
      ? scopeMatch[1]
          .split(',')
          .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : []
    const authenticated = result.code === 0
    return {
      available: true,
      authenticated,
      path: gh,
      login: authenticated && account !== null ? account[1] : null,
      scopes,
      message: authenticated ? '' : text.split('\n').filter(Boolean).slice(0, 3).join(' '),
    }
  }

  return { resolveGit, resolveGh, readGhAuth }
}
