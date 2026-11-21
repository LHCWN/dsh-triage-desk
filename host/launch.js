/**
 * Triage Desk — launch glue: scenario and agent resolution, prompt rendering,
 * launcher scripts in per-launch temp directories, and the GitHub login
 * terminal.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_COMMAND_RULE,
  SCENARIO_SECTION_IDS,
  MAX_RENDERED_PROMPT,
  bareAgentCommand,
  buildSshScripts,
  SSH_AGENTS,
  SSH_ALIAS,
  configuredSshHosts,
  buildClipboardLauncherScript,
  buildDraftCommand,
  buildDraftLauncherScript,
  buildLoginLauncherScript,
  buildPasteLauncherScript,
  buildScenarioPrompt,
  buildWindowsClipboardLauncherScript,
  buildWindowsDraftLauncherScript,
  buildWindowsLoginLauncherScript,
  buildWindowsPasteLauncherScript,
  draftCommandForStatus,
  DSH_TARGET,
  effectiveDefaultAgent,
  PASTE_WRAPPER_CS,
  PASTE_WRAPPER_PY,
  parseRepoUrl,
  sanitizePastePrompt,
  scenarioTitle,
  withAgentExecutable,
} from '../launcher.js'
import { LaunchError } from './errors.js'

export function createLaunch({
  launcherSettings,
  platform,
  log: safeLog,
  findSnapshotEntry,
  runProcess,
  copyToClipboard,
  openTerminal,
  detectPasteSupport,
  detectAgents,
  isExecutableFile,
  resolveClone,
  workspaceDirectory,
}) {
  /**
   * Writes a generated launcher script. PowerShell 5.1 reads BOM-less scripts
   * as ANSI, corrupting Unicode paths/titles, so every .ps1 gets a UTF-8 BOM.
   * Verified: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1
   * POSIX scripts are written executable for the owner only.
   */
  const writeLauncherScript = async (file, script) => {
    if (platform === 'win32') {
      await fs.writeFile(file, '\uFEFF' + script, 'utf8')
      return
    }
    await fs.writeFile(file, script, { mode: 0o700 })
    await fs.chmod(file, 0o700).catch(() => undefined)
  }

  /** Removes old triage-desk temp directories left by previous launches. */
  const cleanupStaleTempDirs = async () => {
    try {
      const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true })
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('triage-desk-')) continue
        const full = path.join(os.tmpdir(), entry.name)
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true })
        } catch {
          // a concurrent launch may already have removed it
        }
      }
    } catch {
      // /tmp is best-effort
    }
  }

  const resolveScenario = (body, item) => {
    const requested = typeof body.scenario === 'string' ? body.scenario.trim() : ''
    if (requested !== '') {
      const scenario = launcherSettings.scenarios.find((entry) => entry.id === requested)
      if (scenario === undefined) throw new LaunchError('bad-scenario', `the scenario "${requested}" is not configured`)
      return scenario
    }
    const scope = Array.isArray(body.urls) ? 'section' : 'item'
    const route = item && new URL(item.url).pathname.split('/').filter(Boolean)[2]
    const kind = item?.kind || (route === 'issues' ? 'issue' : route === 'pull' ? 'pull' : '')
    const section = body.section || item?.section || (kind === 'issue' ? 'issues' : kind === 'pull' ? 'review' : '')
    const available = launcherSettings.scenarios.filter((entry) => entry.enabled && entry.scope === scope &&
      entry.sections.includes(section) && (entry.id !== 'triage-issue' || kind === 'issue' || section === 'issues'))
    // Templates are ordered in Settings. Reply and triage share the respond
    // section; an issue gets triage unless an applicable default overrides it.
    const triage = kind === 'issue' && available.find(({ id }) => id === 'triage-issue')
    return available.find(({ id }) => id === launcherSettings.defaultScenario) ||
      available.find(({ id }) => !triage || id !== 'reply-thread') ||
      { id: '', label: 'Draft', scope, prompt: scope === 'item' ? 'Work on {url}' : 'Work on these items:\n{links}', agent: 'default' }

  }

  // `detected` decides what "default" means: see effectiveDefaultAgent. An
  // agent named by the request or pinned by the scenario is used as is.
  const resolveLauncherAgent = (body, scenario, detected) => {
    let wantedAgent =
      typeof body.agent === 'string' && body.agent.trim() !== '' ? body.agent.trim().toLowerCase() : ''
    if (wantedAgent === '') {
      wantedAgent = scenario.agent === 'default'
        ? effectiveDefaultAgent(launcherSettings.defaultAgent, launcherSettings.agents, detected)
        : scenario.agent
    }
    if (wantedAgent === DSH_TARGET) {
      throw new LaunchError(
        'agent-missing',
        'the default opens a new DSH chat, which only the Triage panel can do, and no coding agent is installed; choose an agent in Settings',
        { agent: DSH_TARGET },
      )
    }
    const agent = launcherSettings.agents.find((entry) => entry.id === wantedAgent)
    if (agent === undefined) {
      const invalid = launcherSettings.invalidAgents.find((entry) => entry.id === wantedAgent)
      if (invalid !== undefined) {
        throw new LaunchError(
          'unknown-agent',
          `the agent "${invalid.label}" is disabled because its ${AGENT_COMMAND_RULE}; fix it in Settings`,
          { agent: invalid.id, reason: invalid.reason },
        )
      }
      throw new LaunchError('unknown-agent', `the agent "${wantedAgent}" is not configured`)
    }
    return agent
  }

  const ITEM_FIELDS = ['number', 'title', 'headRefName', 'kind', 'ref', 'author', 'reason']

  /** Item context for a row launch: snapshot fields when cached, body fields win. */
  const itemLaunchContext = (body, url) => {
    const item = { url }
    const snapshotEntry = findSnapshotEntry(url)
    if (snapshotEntry !== null) {
      item.section = snapshotEntry.section
      for (const key of ITEM_FIELDS) {
        if (snapshotEntry.item[key] !== undefined) item[key] = snapshotEntry.item[key]
      }
    }
    for (const key of ITEM_FIELDS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') item[key] = body[key]
    }
    const wantedSection = typeof body.section === 'string' ? body.section.trim() : ''
    if (SCENARIO_SECTION_IDS.includes(wantedSection)) item.section = wantedSection
    return item
  }

  /** Item context for a section launch; invalid and duplicate URLs are dropped. */
  const sectionLaunchItems = (section, urls) => {
    const items = []
    const seen = new Set()
    for (const raw of urls) {
      if (typeof raw !== 'string') continue
      const url = raw.trim()
      if (url === '' || seen.has(url)) continue
      const parsed = parseRepoUrl(url)
      if (parsed === null) continue
      seen.add(url)
      const entry = findSnapshotEntry(url, section) ?? findSnapshotEntry(url)
      const item = { url, section, repo: parsed.slug }
      if (entry !== null) {
        // A moved PR keeps its descriptive fields. Its reason belongs to its new group.
        for (const key of ITEM_FIELDS) {
          if (key !== 'reason' || entry.section === section) item[key] = entry.item[key]
        }
      }
      items.push(item)
    }
    return items
  }

  const renderPrompt = (scenario, context) => {
    try {
      return buildScenarioPrompt(scenario, context)
    } catch (error) {
      throw new LaunchError('bad-prompt', String((error && error.message) || error))
    }
  }

  /** Resolves the scenario and renders its prompt without launching anything. */
  const renderScenarioPrompt = (body) => {
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    const parsed = parseRepoUrl(url)
    const item = parsed ? itemLaunchContext(body, url) : null
    const scenario = resolveScenario(body, item)
    if (scenario.scope === 'section') {
      const section = typeof body.section === 'string' ? body.section.trim() : ''
      if (!SCENARIO_SECTION_IDS.includes(section)) {
        throw new LaunchError('bad-scenario', 'a section scenario needs a valid section')
      }
      if (!Array.isArray(body.urls)) throw new LaunchError('bad-scenario', 'a section scenario needs a list of URLs')
      const items = sectionLaunchItems(section, body.urls)
      if (items.length === 0) throw new LaunchError('bad-url', 'no GitHub URLs were provided')
      const built = renderPrompt(scenario, { items, section })
      const included = items.slice(0, built.trimmed?.shown ?? items.length)
      const slug = items[0].repo.toLowerCase()
      const repo = included.every((item) => item.repo.toLowerCase() === slug) ? items[0].repo : ''
      return { scenario, scope: 'section', items, repo, prompt: built.prompt, trimmed: built.trimmed, count: items.length }
    }
    if (!parsed) throw new LaunchError('bad-url', 'the row has no GitHub URL')
    const built = renderPrompt(scenario, { item })
    return { scenario, scope: 'item', repo: parsed.slug, item, prompt: built.prompt, trimmed: null, count: 1 }
  }

  const launchSsh = async (alias, rendered, signal, requestedAgent) => {
    if (typeof alias !== 'string' || !SSH_ALIAS.test(alias)) throw new LaunchError('bad-destination', 'choose a named SSH host')
    let server = launcherSettings.sshServers.find((entry) => entry.alias.toLowerCase() === alias.toLowerCase())
    if (!server) {
      const known = (await configuredSshHosts()).find((host) => host.toLowerCase() === alias.toLowerCase())
      if (!known) throw new LaunchError('bad-destination', 'choose a saved destination or a named OpenSSH host')
      server = { alias: known, folders: [] }
    }
    const agent = SSH_AGENTS.find((entry) => entry.id === (requestedAgent || server.agent))
    if (!agent) throw new LaunchError('unknown-agent', 'choose a supported SSH agent')
    const title = `SSH ${server.alias} · ${agent.label} · ${scenarioTitle(rendered.scenario)}`
    void cleanupStaleTempDirs()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-ssh-'))
    try {
      const { stage, local, mode } = buildSshScripts({ ...server, agent: agent.id }, rendered.prompt, platform, rendered.repo)
      const file = path.join(dir, platform === 'win32' ? 'launch.ps1' : 'launch.command')
      await fs.writeFile(path.join(dir, 'stage.sh'), stage, { mode: 0o600 })
      await writeLauncherScript(file, local)
      if (signal?.aborted) throw new LaunchError('aborted', 'the launch was cancelled')
      const opened = await openTerminal(file, title, signal, launcherSettings.terminal, false)
      return {
        ok: true, sshAlias: alias, cwd: null, cwdMode: 'ssh', agent,
        scenario: { id: rendered.scenario.id, label: scenarioTitle(rendered.scenario) },
        count: rendered.count, trimmed: rendered.trimmed, terminal: opened?.terminal || null,
        mode,
      }
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error instanceof LaunchError ? error : new LaunchError('open-failed', error.message)
    }
  }

  const launchForItem = async (input, signal) => {
    const body = input !== null && typeof input === 'object' ? input : {}
    const rendered = renderScenarioPrompt(body)
    if (body.draft !== undefined) {
      if (typeof body.draft !== 'string' || !body.draft.trim() || body.draft.includes('\0') ||
        Array.from(body.draft).length > MAX_RENDERED_PROMPT) throw new LaunchError('bad-prompt', 'Invalid draft length or content')
      rendered.prompt = body.draft
    }
    if (body.sshAlias !== undefined) return launchSsh(body.sshAlias, rendered, signal, body.agent)
    const scenario = rendered.scenario
    const cached = await detectAgents()
    let agent = resolveLauncherAgent(body, scenario, cached)
    let status = cached[agent.id]
    // Detection is cached and the launch runs the path it found: when that
    // path is gone (the agent was moved or reinstalled), detect once more,
    // and resolve again so a "default" launch can fall back to another agent.
    if (status !== undefined && status.available === true && typeof status.path === 'string'
      && !(await isExecutableFile(status.path))) {
      const fresh = await detectAgents(true)
      agent = resolveLauncherAgent(body, scenario, fresh)
      status = fresh[agent.id]
    }
    if (status !== undefined && status.available === false) {
      const why = {
        alias: 'is only a shell alias, which the launch shell does not have; point the command at the executable',
        function: 'is only a shell function or builtin, which the launch shell does not have; point the command at the executable',
        'not-executable': 'is not an executable file',
      }[status.reason] || 'is not installed or not on PATH'
      throw new LaunchError('agent-missing', `the agent "${agent.label}" ${why}`, {
        agent: agent.id,
        label: agent.label,
        ...(status.reason ? { reason: status.reason } : {}),
      })
    }
    // Run exactly the program detection found (withAgentExecutable); on
    // macOS/Linux also put its directory on PATH for `#!/usr/bin/env node` shims.
    const detectedPath = status !== undefined && status.available === true && typeof status.path === 'string'
      ? status.path
      : ''
    const launchCommand = withAgentExecutable(agent.command, detectedPath, platform)
    // Only paste and clipboard launches run the agent bare; called inside the
    // try below, so a command without a bare form fails as open-failed.
    const bareCommand = () => bareAgentCommand(launchCommand, platform)
    const binDir = platform !== 'win32' && detectedPath !== '' ? path.dirname(detectedPath) : undefined
    const { count, trimmed, prompt } = rendered
    const repo = rendered.repo
    let clonePath = ''
    let cloneMissing = false
    let windowTitle = ''
    if (rendered.scope === 'item') {
      ;({ cwd: clonePath, cloneMissing } = await resolveClone(repo))
      const number = rendered.item.number
      const suffix = number === undefined || number === null || String(number).trim() === '' ? '' : ` #${number}`
      // The agent label makes each item+agent tab distinct, so focus-or-reuse
      // keys on it: codex and claude on the same PR are separate tabs, and
      // re-launching the same agent focuses its own tab instead of duplicating.
      windowTitle = `Triage Desk: ${scenarioTitle(scenario)} — ${repo}${suffix} [${agent.label}]`
    } else {
      if (repo) {
        ;({ cwd: clonePath, cloneMissing } = await resolveClone(repo))
      } else {
        clonePath = await workspaceDirectory()
      }
      windowTitle = `Triage Desk: ${scenarioTitle(scenario)} (${count}) [${agent.label}]`
    }
    // A multi-repo section launch runs in the workspace, as does a missing clone.
    const cwdMode = repo !== '' && !cloneMissing ? 'clone' : 'workspace'
    if (signal !== undefined && signal.aborted === true) {
      throw new LaunchError('aborted', 'the launch was cancelled')
    }
    // Native draft support (Claude Code --prefill) opens the agent with the
    // prompt already in its composer. Other agents get it typed into their
    // input box by the paste wrapper when it can run here, else via the
    // clipboard; `delivery.pasteBlocked` says why paste was not used.
    // draftCommandForStatus decides when the draft may be used (Windows: an
    // .exe that is not a known shim).
    const windows = platform === 'win32'
    const draftCommand = draftCommandForStatus(agent, status, platform)
    let mode = 'clipboard'
    let pasteBlocked = null
    let python = null
    if (draftCommand !== null) {
      mode = 'draft'
    } else if (launcherSettings.promptDelivery === 'paste') {
      const support = await detectPasteSupport().catch(() => ({ available: false, reason: 'python-missing', python: null }))
      if (support.available) {
        mode = 'paste'
        python = support.python
      } else {
        pasteBlocked = support.reason
      }
    }
    // Best effort and never throws; this launch's own directory is too new to qualify.
    void cleanupStaleTempDirs()
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-'))
    let opened
    try {
      if (mode === 'clipboard') {
        await copyToClipboard(prompt)
      } else {
        // Keep the prompt on the clipboard too: it is the fallback when an
        // older agent build lacks the draft flag or the paste cannot be typed.
        await copyToClipboard(prompt).catch(() => undefined)
      }
      const launcherFile = path.join(tempDir, windows ? 'launch.ps1' : 'launch.command')
      let script
      if (mode === 'paste') {
        const promptFile = path.join(tempDir, 'prompt.txt')
        const wrapperFile = path.join(tempDir, windows ? 'paste-host.cs' : 'paste-wrapper.py')
        await fs.writeFile(promptFile, sanitizePastePrompt(prompt), 'utf8')
        await fs.writeFile(wrapperFile, windows ? PASTE_WRAPPER_CS : PASTE_WRAPPER_PY, 'utf8')
        script = windows
          ? buildWindowsPasteLauncherScript({ cwd: clonePath, title: windowTitle, bareCommand: bareCommand(), wrapperFile, promptFile })
          : buildPasteLauncherScript({
              cwd: clonePath,
              title: windowTitle,
              bareCommand: bareCommand(),
              python,
              wrapperFile,
              promptFile,
              binDir,
              platform,
            })
      } else if (windows && mode === 'draft') {
        const promptFile = path.join(tempDir, 'prompt.txt')
        await fs.writeFile(promptFile, prompt, 'utf8')
        script = buildWindowsDraftLauncherScript({
          cwd: clonePath,
          title: windowTitle,
          agentCommand: draftCommand,
          promptFile,
          draftFlag: agent.draftFlag,
        })
      } else if (windows) {
        script = buildWindowsClipboardLauncherScript({ cwd: clonePath, title: windowTitle, bareCommand: bareCommand() })
      } else if (mode === 'draft') {
        const command = buildDraftCommand(draftCommand, prompt, agent.draftFlag)
        script = buildDraftLauncherScript({ cwd: clonePath, title: windowTitle, command, binDir, platform })
      } else {
        script = buildClipboardLauncherScript({
          cwd: clonePath,
          title: windowTitle,
          bareCommand: bareCommand(),
          binDir,
          platform,
        })
      }
      await writeLauncherScript(launcherFile, script)
      if (signal !== undefined && signal.aborted === true) throw new LaunchError('aborted', 'the launch was cancelled')
      // Focusing a previous tab does not deliver the text from the editor.
      const reuse = body.draft === undefined && rendered.scope === 'item'
      opened = await openTerminal(launcherFile, windowTitle, signal, launcherSettings.terminal, reuse)
      // iTerm2 and Ghostty plans run `activate` in their own AppleScript, so
      // only nudge Terminal.app forward when the launcher actually used it;
      // `open -a Terminal` with no file would otherwise pop an empty window.
      if (platform === 'darwin' && opened?.terminal?.id === 'terminal') {
        // Terminal can start without being brought to the current Space;
        // activate the already-running app (no new window is created). It
        // runs in the host cwd: the launcher may already have removed tempDir.
        await runProcess(['/usr/bin/open', '-a', 'Terminal'], { timeoutMs: 5000, signal }).catch(
          () => undefined,
        )
      }
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof LaunchError) throw error
      throw new LaunchError('open-failed', String((error && error.message) || error))
    }
    safeLog('info', 'launched %s (%s) for %s in %s (%s)', agent.id, scenario.id, repo || 'multiple repos', clonePath, mode)
    return {
      ok: true,
      mode,
      agent: { id: agent.id, label: agent.label },
      scenario: { id: scenario.id, label: scenarioTitle(scenario) },
      repo,
      cwd: clonePath,
      cloneMissing,
      cwdMode,
      count,
      trimmed,
      // Which terminal opened (`fallback` when the chosen one is not installed)
      // and, for clipboard mode, why the prompt was not typed in.
      terminal: opened?.terminal || null,
      delivery: { mode, pasteBlocked, platform },
      launchedAt: new Date().toISOString(),
    }
  }

  const openLoginTerminal = async (gh) => {
    const cwd = await workspaceDirectory()
    const windows = platform === 'win32'
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-login-'))
    const launcherFile = path.join(tempDir, windows ? 'login.ps1' : 'login.command')
    try {
      const script = windows
        ? buildWindowsLoginLauncherScript({ cwd, ghCommand: gh })
        : buildLoginLauncherScript({ cwd, ghCommand: gh, platform })
      await writeLauncherScript(launcherFile, script)
      const opened = await openTerminal(launcherFile, 'Triage Desk: GitHub login', undefined, launcherSettings.terminal)
      if (platform === 'darwin' && opened?.terminal?.id === 'terminal') {
        await runProcess(['/usr/bin/open', '-a', 'Terminal'], { timeoutMs: 5000 }).catch(
          () => undefined,
        )
      }
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return tempDir
  }

  return { cleanupStaleTempDirs, renderScenarioPrompt, launchForItem, openLoginTerminal }
}
