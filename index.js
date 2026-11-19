/**
 * Triage Desk — Host half.
 *
 * Collects a GitHub triage snapshot for a configured organization through the
 * signed-in `gh` CLI, serves it to the plugin's Client half over the exact
 * routes `/triage-desk/snapshot` and `/triage-desk/config`, exposes the
 * snapshot to the agent as the `triage_desk` tool, and opens a visible Terminal
 * window with a coding agent for a chosen row through `/triage-desk/launch`.
 *
 * Nothing user-specific is baked in: the organization is auto-detected from the
 * signed-in account until the user sets one in the panel's settings form, the
 * agent list and clone directories live in the row config, and local clones are
 * discovered from the configured base directories.
 *
 * No `@deepseek-ai/*` imports: a linked local bundle cannot resolve them, so
 * everything goes through Cordis context services and Node builtins.
 */

import { normalizeSettings, REFRESH_SECONDS, SECTION_IDS } from './github.js'
import {
  DEFAULT_CLONE_DIRS,
  MAX_AGENTS,
  MAX_CLONE_DIRS,
  MAX_RENDERED_PROMPT,
  MAX_REPO_PATHS,
  MAX_SCENARIO_TEMPLATE,
  MAX_SCENARIOS,
  chooseCloneRepo,
  expandHome,
  normalizeLauncherConfig,
  readSshHostAliases,
  scenarioTitle,
} from './launcher.js'
import { createAgents } from './host/agents.js'
import { createClones } from './host/clones.js'
import { publicConfig, sanitizePatch } from './host/config.js'
import { BadRequest, LaunchError, errorMessage, launchErrorStatus } from './host/errors.js'
import { createGh } from './host/gh.js'
import { CONFIG_BODY_LIMIT, readJsonBody, readFindCommands, sendJson, jsonResponse } from './host/http.js'
import { createLaunch } from './host/launch.js'
import { createProcesses } from './host/processes.js'
import { createSnapshotStore } from './host/snapshot.js'
import { formatToolText } from './host/tool-text.js'

export { createSnapshotCache, hasTransientWarnings, shouldCacheSnapshot } from './host/snapshot-cache.js'

const SNAPSHOT_PATH = '/triage-desk/snapshot'
const CONFIG_PATH = '/triage-desk/config'
const LAUNCH_PATH = '/triage-desk/launch'
const PROMPT_PATH = '/triage-desk/prompt'
const AGENTS_FIND_PATH = '/triage-desk/agents/find'
const CLONES_PATH = '/triage-desk/clones'

export const name = 'triage-desk'
export const inject = ['webServer', 'connection', 'subprocess', 'tools', 'systemPrompt']

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  const platform = process.platform
  const log = ctx.logger('triage-desk')
  /**
   * Logging that never throws. A request that awaited a host service (e.g.
   * configEditor.edit, which settles only after the loader applied the saved
   * config, or restarted this plugin when it could not) may finish in a
   * disposed context, where ctx-bound services throw; a log line must never
   * turn a completed operation into a reported failure.
   */
  const safeLog = (level, ...args) => {
    try {
      log[level](...args)
    } catch {
      // the context that owned this logger is gone
    }
  }
  let lastSaveError = null

  /* ------------------------------------------------------------------ wiring */

  /**
   * Everything that depends on the saved config: normalized settings and the
   * `host/` factories over them, with their caches (snapshot, detection,
   * clone scans). Built at start and rebuilt for every saved config; routes
   * and the tool read the current wiring when a request starts, so a request
   * in flight finishes on the wiring it started with.
   */
  const wire = (raw) => {
    const settings = normalizeSettings(raw)
    const launcherSettings = normalizeLauncherConfig(raw)
    if (launcherSettings.invalidAgents.length > 0) {
      safeLog(
        'warn',
        'ignoring %d saved agent(s) whose command breaks the prompt rule: %s',
        launcherSettings.invalidAgents.length,
        launcherSettings.invalidAgents.map((agent) => agent.id).join(', '),
      )
    }
    const {
      runProcess,
      findExecutable,
      copyToClipboard,
      isExecutableFile,
      locateExecutables,
      openTerminal,
      detectTerminals,
      detectPasteSupport,
    } = createProcesses({ ctx, settings, platform })
    const { detectAgents, discoverAgents } = createAgents({
      launcherSettings,
      platform,
      locateExecutables,
      isExecutableFile,
    })
    const { pickDirectoryPath, isDirectory, workspaceDirectory, scanLocalClones, resolveClone } = createClones({
      ctx,
      settings,
      launcherSettings,
    })
    const { resolveGit, resolveGh, readGhAuth } = createGh({ settings, platform, findExecutable, runProcess })
    const snapshots = createSnapshotStore({ ctx, settings, resolveGh, log: safeLog })
    const { cleanupStaleTempDirs, renderScenarioPrompt, launchForItem, openLoginTerminal } = createLaunch({
      launcherSettings,
      platform,
      log: safeLog,
      findSnapshotEntry: snapshots.findSnapshotEntry,
      runProcess,
      copyToClipboard,
      openTerminal,
      detectPasteSupport,
      detectAgents,
      resolveClone,
      workspaceDirectory,
    })
    return {
      settings,
      launcherSettings,
      snapshots,
      cache: snapshots.cache,
      runProcess,
      detectTerminals,
      detectPasteSupport,
      detectAgents,
      discoverAgents,
      pickDirectoryPath,
      isDirectory,
      scanLocalClones,
      resolveGit,
      readGhAuth,
      cleanupStaleTempDirs,
      renderScenarioPrompt,
      launchForItem,
      openLoginTerminal,
    }
  }
  let host = wire(config)
  let restarting = false

  /**
   * Saved settings are applied to this running instance. Restarting it would
   * unregister the `triage_desk` tool and the routes until the plugin is back,
   * and an agent calling the tool meanwhile gets `unknown tool "triage_desk"`.
   * configEditor.edit ends in the loader's `fiber.update(config)`, which runs
   * this fiber's `internal/update` listeners around the restart; a listener
   * that returns without calling `next()` keeps the instance (cordis
   * `src/fiber.ts` update() and `src/events.ts`; the loader's Group plugin
   * applies its config the same way). A config that cannot be wired falls
   * back to the restart, which reports the failure through the fiber.
   */
  ctx.on('internal/update', (nextConfig, next) => {
    let rewired
    try {
      rewired = wire(nextConfig !== null && typeof nextConfig === 'object' ? nextConfig : {})
    } catch (error) {
      safeLog('warn', 'saved settings could not be applied live, restarting: %s', errorMessage(error))
      restarting = true
      return next()
    }
    host = rewired
    safeLog('info', 'settings applied without a restart')
    return undefined
  })

  /* ------------------------------------------------------------------ routes */

  const configEntry = () => {
    try {
      return ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry : null
    } catch {
      return null
    }
  }

  const configEditor = () => {
    try {
      const editor = ctx.get('configEditor')
      return editor !== undefined && editor !== null ? editor : null
    } catch {
      return null
    }
  }

  const editable = () => {
    const editor = configEditor()
    const entry = configEntry()
    if (editor === null || entry === null) return false
    try {
      return typeof editor.entries === 'function' && editor.entries().includes(entry)
    } catch {
      return false
    }
  }

  const runtime = {
    get sources() {
      const lastSnapshot = host.snapshots.lastSnapshot()
      return lastSnapshot !== null && Array.isArray(lastSnapshot.sources) ? lastSnapshot.sources : []
    },
    get editable() {
      return editable()
    },
  }

  /**
   * Registers an exact host route. Every route gets the same connection fence
   * and a 405 with an `allow` header for other methods before `handler` runs.
   */
  const route = (routePath, methods, label, handler) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            const rejection = ctx.connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            if (!methods.includes(req.method)) {
              res.statusCode = 405
              res.setHeader('allow', methods.join(', '))
              res.end()
              return
            }
            await handler(req, res)
          },
        }),
      label,
    )

  /** A LaunchError as a JSON error response; `data` adds its structured fields. */
  const sendLaunchError = (res, error, fallbackStatus, { data = true } = {}) => {
    sendJson(res, launchErrorStatus(error.code, fallbackStatus), {
      ok: false,
      error: { code: error.code, message: error.message, ...(data ? error.data : {}) },
    })
  }

  /** Picker failures: a LaunchError keeps its code, anything else is `pick-failed`. */
  const sendPickError = (res, error) => {
    const code = error instanceof LaunchError ? error.code : 'pick-failed'
    sendJson(res, launchErrorStatus(code, 500), { ok: false, error: { code, message: errorMessage(error) } })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SNAPSHOT_PATH,
        resource: async (request) => {
          const rejection = ctx.connection.requestRejection({ headers: request.headers })
          if (rejection !== undefined) return new Response(null, { status: rejection })
          let force = false
          try {
            force = new URL(request.url).searchParams.get('refresh') === '1'
          } catch {
            force = false
          }
          try {
            return jsonResponse(200, await host.cache.read(force))
          } catch (error) {
            safeLog('warn', 'snapshot route failed: %s', errorMessage(error))
            return jsonResponse(200, {
              ok: false,
              status: 'error',
              generatedAt: new Date().toISOString(),
              sources: [],
              orgs: host.settings.orgs,
              org: '',
              user: null,
              counts: { total: 0 },
              sections: [],
              warnings: [],
              error: { code: 'internal', message: 'snapshot build failed' },
            })
          }
        },
      }),
    'triage-desk: GET /triage-desk/snapshot',
  )

  const saveConfig = async (patch) => {
    const editor = configEditor()
    const entry = configEntry()
    if (editor === null || entry === null) {
      throw new Error('configuration cannot be saved in this profile')
    }
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
    lastSaveError = null
  }

  route(CONFIG_PATH, ['GET', 'POST'], 'triage-desk: GET/POST /triage-desk/config', async (req, res) => {
    const { settings, launcherSettings, detectAgents, detectTerminals, detectPasteSupport } = host
    if (req.method === 'GET') {
      // Agents, terminals and paste support are independent probes of this
      // machine; each failure only leaves its part of the response empty.
      const [detected, terminals, promptPaste] = await Promise.all([
        detectAgents().catch((error) => {
          safeLog('warn', 'agent detection failed: %s', errorMessage(error))
          return {}
        }),
        detectTerminals().catch((error) => {
          safeLog('warn', 'terminal detection failed: %s', errorMessage(error))
          return null
        }),
        detectPasteSupport().catch((error) => {
          safeLog('warn', 'paste support check failed: %s', errorMessage(error))
          return null
        }),
      ])
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(settings, runtime, launcherSettings, detected, { terminals, promptPaste, platform }),
        saveError: lastSaveError,
        limits: {
          refreshSeconds: REFRESH_SECONDS,
          agents: MAX_AGENTS,
          cloneDirs: MAX_CLONE_DIRS,
          repoPaths: MAX_REPO_PATHS,
          scenarios: MAX_SCENARIOS,
          scenarioTemplate: MAX_SCENARIO_TEMPLATE,
          prompt: MAX_RENDERED_PROMPT,
        },
      })
      return
    }
    let patch
    try {
      patch = sanitizePatch(await readJsonBody(req, CONFIG_BODY_LIMIT), launcherSettings)
    } catch (error) {
      // An agent that fails validation names itself so the client can flag
      // its row: { code: 'invalid-agent', agent, message }.
      const detail = error instanceof BadRequest && error.data !== null ? error.data : { code: 'invalid-config' }
      sendJson(res, 400, { ok: false, error: { ...detail, message: error.message } })
      return
    }
    if (!editable()) {
      sendJson(res, 409, {
        ok: false,
        error: { code: 'not-editable', message: 'configuration cannot be saved in this profile' },
      })
      return
    }
    // The editor owns the write. An accepted request is not a saved
    // configuration: keep this response pending until it commits. edit()
    // fulfils only after the loader reconciled, i.e. after the
    // `internal/update` listener above rewired this instance (or, when that
    // failed, after the restart); past the await only plain values and the
    // raw `res` are touched (safeLog never throws), so a committed write is
    // never reported as a failure.
    let failure = null
    try {
      await saveConfig(patch)
    } catch (error) {
      failure = errorMessage(error)
    }
    if (failure === null) {
      sendJson(res, 200, { ok: true, saved: patch, restarting })
      return
    }
    lastSaveError = { message: failure, at: new Date().toISOString() }
    safeLog('warn', 'settings save failed: %s', failure)
    sendJson(res, 500, { ok: false, error: { code: 'save-failed', message: failure } })
  })

  route(LAUNCH_PATH, ['POST'], 'triage-desk: POST /triage-desk/launch', async (req, res) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: error.message } })
      return
    }
    try {
      const result = await host.launchForItem(body)
      sendJson(res, 200, result)
    } catch (error) {
      if (error instanceof LaunchError) {
        sendLaunchError(res, error, 400)
        return
      }
      safeLog('warn', 'launch failed: %s', errorMessage(error))
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'the terminal could not be opened' } })
    }
  })

  route(PROMPT_PATH, ['POST'], 'triage-desk: POST /triage-desk/prompt', async (req, res) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: error.message } })
      return
    }
    try {
      const rendered = host.renderScenarioPrompt(body)
      sendJson(res, 200, {
        ok: true,
        prompt: rendered.prompt,
        scenario: { id: rendered.scenario.id, label: scenarioTitle(rendered.scenario) },
        count: rendered.count,
        trimmed: rendered.trimmed,
      })
    } catch (error) {
      if (error instanceof LaunchError) {
        sendLaunchError(res, error, 400)
        return
      }
      safeLog('warn', 'prompt failed: %s', errorMessage(error))
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'the prompt could not be rendered' } })
    }
  })

  route(AGENTS_FIND_PATH, ['POST'], 'triage-desk: POST /triage-desk/agents/find', async (req, res) => {
    // Optional body { commands }: found agents sharing an executable with
    // one of these (already configured) commands are left out.
    let commands
    try {
      commands = await readFindCommands(req)
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: error.message } })
      return
    }
    try {
      const result = await host.discoverAgents(commands)
      sendJson(res, 200, { ok: true, found: result.found, checked: result.checked })
    } catch (error) {
      if (error instanceof LaunchError) {
        sendLaunchError(res, error, 500, { data: false })
        return
      }
      safeLog('warn', 'agent discovery failed: %s', errorMessage(error))
      sendJson(res, 500, { ok: false, error: { code: 'scan-failed', message: 'agent discovery failed' } })
    }
  })

  route(CLONES_PATH, ['GET'], 'triage-desk: GET /triage-desk/clones', async (req, res) => {
    let force = false
    try {
      force = new URL(req.url, 'http://127.0.0.1').searchParams.get('refresh') === '1'
    } catch {
      force = false
    }
    try {
      const { launcherSettings, scanLocalClones } = host
      const scan = await scanLocalClones(force)
      const roots = Array.isArray(scan.roots) ? scan.roots : []
      const dirs = roots.map((dir) => {
        const expanded = expandHome(dir)
        const missing = scan.skipped.some((entry) => entry.path === expanded)
        return { path: expanded, exists: !missing }
      })
      sendJson(res, 200, {
        ok: true,
        dirs,
        defaultDirs: DEFAULT_CLONE_DIRS,
        clones: scan.clones,
        skipped: scan.skipped,
        scanned: scan.visited,
        overrides: launcherSettings.repoPaths,
      })
    } catch (error) {
      safeLog('warn', 'clone scan failed: %s', errorMessage(error))
      sendJson(res, 500, { ok: false, error: { code: 'scan-failed', message: 'clone scan failed' } })
    }
  })

  route('/triage-desk/pick-directory', ['POST'], 'triage-desk: POST /triage-desk/pick-directory', async (req, res) => {
    try {
      const selected = await host.pickDirectoryPath()
      sendJson(res, 200, { ok: true, path: selected })
    } catch (error) {
      sendPickError(res, error)
    }
  })

  route('/triage-desk/pick-clone', ['POST'], 'triage-desk: POST /triage-desk/pick-clone', async (req, res) => {
    const { pickDirectoryPath, isDirectory, resolveGit, runProcess } = host
    try {
      const selected = await pickDirectoryPath()
      if (selected === null) {
        sendJson(res, 200, { ok: true, path: null, repo: null })
        return
      }
      if (!(await isDirectory(selected))) {
        throw new LaunchError('bad-path', 'the selected path is not a directory')
      }
      const git = await resolveGit()
      // Every remote, not only origin: `git config --get-regexp` prints
      // `remote.<name>.url <url>` per line in config order (verified with
      // git 2.56; `--local` reads the repository config, including a
      // linked worktree's common config). chooseCloneRepo prefers
      // upstream, then origin, then the first GitHub remote.
      const listed = await runProcess(
        [git, '-C', selected, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'],
        { cwd: selected, timeoutMs: 8000 },
      )
      const remotes = []
      if (listed.code === 0) {
        for (const line of listed.stdout.split('\n')) {
          const match = line.trim().match(/^remote\.(.+)\.url\s+(.+)$/)
          if (match) remotes.push({ name: match[1], url: match[2].trim() })
        }
      }
      const repo = chooseCloneRepo(remotes, await readSshHostAliases())
      if (repo === null) {
        throw new LaunchError('not-a-github-clone', 'the selected folder is not a GitHub clone')
      }
      sendJson(res, 200, { ok: true, path: selected, repo })
    } catch (error) {
      sendPickError(res, error)
    }
  })

  route('/triage-desk/auth', ['GET'], 'triage-desk: GET /triage-desk/auth', async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, auth: await host.readGhAuth() })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'auth-check-failed', message: errorMessage(error) },
      })
    }
  })

  route('/triage-desk/auth/login', ['POST'], 'triage-desk: POST /triage-desk/auth/login', async (req, res) => {
    try {
      const { readGhAuth, openLoginTerminal } = host
      const auth = await readGhAuth()
      if (auth.available === false) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: 'gh-missing',
            message: 'GitHub CLI (gh) is not installed. Install it with "brew install gh" or from https://cli.github.com/.',
            install: auth.install,
          },
        })
        return
      }
      if (auth.authenticated === true) {
        sendJson(res, 200, { ok: true, already: true, auth })
        return
      }
      await openLoginTerminal(auth.path)
      sendJson(res, 200, { ok: true, already: false, auth })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'login-failed', message: errorMessage(error) },
      })
    }
  })

  ctx.tools.register({
    name: 'triage_desk',
    description:
      "Read the user's GitHub attention inbox across personal repositories and organizations: pull requests "
      + 'waiting for their review or re-review, their own pull requests that are ready to merge, pull requests '
      + 'and mentions needing an answer, failing CI, and issues assigned to them or freshly opened unassigned '
      + 'issues in their repositories. Call this before answering '
      + 'questions like "what needs my attention", "what should I review", "can I merge", or '
      + '"what is waiting on me". '
      + 'Use action "launch" only when the user explicitly asks to open a coding agent in a terminal for a '
      + 'specific GitHub pull request or issue: it opens a terminal at the local clone of the repository, '
      + 'starts the configured agent with the prompt pre-filled in its input (Claude Code) or copies the prompt '
      + 'to the clipboard for other agents; nothing is sent automatically, the user reviews and presses Enter. '
      + 'If no local clone is found, it opens the agent in the current workspace instead.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['report', 'launch'],
          description: 'What to do: build the triage report (default) or open a terminal for one URL.',
        },
        url: { type: 'string', description: 'Required with action "launch": the GitHub pull request or issue URL.' },
        agent: {
          type: 'string',
          description: 'Optional with action "launch": the configured agent id; the default agent is used otherwise.',
        },
        refresh: { type: 'boolean', description: 'Bypass the cache and rebuild the snapshot now.' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: SECTION_IDS },
          description: 'Limit the report to these sections.',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          generatedAt: { type: 'string' },
          counts: { type: 'object' },
          launched: { type: 'object' },
        },
        required: ['text'],
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: value && typeof value.text === 'string' ? value.text : JSON.stringify(value) },
      ],
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const signal = exec !== null && exec !== undefined && exec.signal !== undefined ? exec.signal : undefined
      if (input.action !== undefined && input.action !== 'report' && input.action !== 'launch') {
        throw new Error('action must be "report" or "launch"')
      }
      if (input.action === 'launch') {
        if (typeof input.url !== 'string' || input.url.trim() === '') {
          throw new Error('url is required when action is "launch"')
        }
        if (input.agent !== undefined && typeof input.agent !== 'string') {
          throw new Error('agent must be a string')
        }
        try {
          // launchForItem reads the row context from the cached snapshot itself.
          const result = await host.launchForItem({ url: input.url, agent: input.agent }, signal)
          const where = `Opened ${result.agent.label}${result.terminal ? ' in ' + result.terminal.label : ''} at ${result.cwd} for ${result.repo}`
          const prefix =
            result.mode === 'draft'
              ? `${where}; the prompt is pre-filled in the agent and has not been sent.`
              : result.mode === 'paste'
                ? `${where}; the prompt is typed into the agent's input box and has not been sent.`
                : `${where}; the prompt is on the clipboard and has not been sent.`
          return {
            text:
              prefix +
              (result.cloneMissing
                ? ` No local clone of ${result.repo} was found, so the workspace was used instead.`
                : ''),
            launched: result,
          }
        } catch (error) {
          if (error instanceof LaunchError) throw new Error(`${error.code}: ${error.message}`)
          throw error
        }
      }
      if (input.refresh !== undefined && typeof input.refresh !== 'boolean') {
        throw new Error('refresh must be a boolean')
      }
      if (input.sections !== undefined && !Array.isArray(input.sections)) {
        throw new Error('sections must be an array of section ids')
      }
      const snapshot = await host.cache.read(input.refresh === true, exec && exec.signal)
      const wanted = Array.isArray(input.sections) ? new Set(input.sections) : null
      return {
        text: formatToolText(snapshot, wanted),
        generatedAt: snapshot.generatedAt || null,
        counts: snapshot.counts || {},
        status: snapshot.status,
      }
    },
  })

  ctx.systemPrompt.section({
    name: 'triage-desk',
    order: 4000,
    text:
      'The user has the Triage Desk plugin: a GitHub attention inbox across personal and organization sources. When they ask '
      + 'what needs their attention on GitHub, what to review or re-review, or what they can merge, call '
      + 'triage_desk before answering and summarize the result in their language. '
      + 'When they explicitly ask to open a terminal or an agent on a pull request or issue, call triage_desk with '
      + 'action "launch" and that URL; never launch an agent on your own initiative.',
  })

  // Clean launcher scratch directories left by previous launches.
  void host.cleanupStaleTempDirs()

  const { settings } = host
  safeLog(
    'info',
    'ready (organizations: %s; personal: %s)',
    settings.orgs.length > 0 ? settings.orgs.join(', ') : 'auto-detect all',
    settings.includePersonal ? 'on' : 'off',
  )
}
