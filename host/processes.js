/**
 * Triage Desk — subprocess and terminal layer: bounded process runs, executable
 * lookup through the login environment, the clipboard, and opening a generated
 * launcher script in a terminal (tab first, window fallback).
 *
 * Everything goes through `ctx.subprocess`; `platform` is the host platform
 * captured once by `apply`.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildExecutableProbe,
  classifyProbeAnswer,
  focusTerminalPlan,
  openTerminalPlan,
  parseExecutableProbe,
  TERMINAL_AUTO,
  terminalCatalog,
  windowsQuote,
} from '../launcher.js'
import { LaunchError } from './errors.js'

export function createProcesses({ ctx, settings, platform }) {
  const runProcess = (argv, options = {}) =>
    new Promise((resolve) => {
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: options.cwd || settings.cwd,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 5000,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (error) {
        resolve({ code: 1, stdout: '', stderr: String((error && error.message) || error), timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      const attach = (stream, append) => {
        if (stream === null || stream === undefined) return
        try {
          if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
          if (typeof stream.on === 'function') stream.on('data', (chunk) => append(String(chunk)))
        } catch {
          // collection below is best-effort; the handle still resolves
        }
      }
      attach(handle.stdout, (chunk) => {
        stdout += chunk
      })
      attach(handle.stderr, (chunk) => {
        stderr += chunk
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          handle.terminate()
        } catch {
          // ignore
        }
      }, options.timeoutMs || 15_000)
      Promise.resolve(handle.done).then(
        (outcome) => {
          clearTimeout(timer)
          if (stdout === '' && handle.collected && handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') {
            stdout = handle.collected.stdout.readFrom(0).text || ''
          }
          if (stderr === '' && handle.collected && handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') {
            stderr = handle.collected.stderr.readFrom(0).text || ''
          }
          const exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : timedOut ? 124 : 1
          resolve({ code: exitCode, stdout, stderr, timedOut })
        },
        (error) => {
          clearTimeout(timer)
          resolve({ code: 1, stdout, stderr: stderr + ' ' + String((error && error.message) || error), timedOut })
        },
      )
    })

  /**
   * Resolves the first available executable from a candidate list through the
   * host subprocess service; `null` when none of them exists.
   */
  const findExecutable = async (candidates) => {
    for (const candidate of candidates) {
      try {
        const resolved = await ctx.subprocess.resolveExecutable(candidate)
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      } catch {
        // try the next candidate
      }
    }
    return null
  }

  const clipboardCache = { argv: null }

  /** Platform clipboard command: pbcopy, clip.exe, wl-copy, xclip, or xsel. */
  const clipboardCommand = async () => {
    if (platform === 'darwin') return ['/usr/bin/pbcopy']
    if (platform === 'win32') return ['clip.exe']
    if (clipboardCache.argv !== null) return clipboardCache.argv
    const candidates = [
      { name: 'wl-copy', argv: ['wl-copy'] },
      { name: 'xclip', argv: ['xclip', '-selection', 'clipboard'] },
      { name: 'xsel', argv: ['xsel', '--clipboard', '--input'] },
    ]
    for (const candidate of candidates) {
      const resolved = await findExecutable([candidate.name])
      if (resolved !== null) {
        clipboardCache.argv = [resolved, ...candidate.argv.slice(1)]
        break
      }
    }
    return clipboardCache.argv
  }

  const copyToClipboard = async (text) => {
    const argv = await clipboardCommand()
    if (argv === null) {
      throw new LaunchError('clipboard-failed', 'no clipboard tool was found: install wl-clipboard, xclip, or xsel')
    }
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: settings.cwd,
      stdio: { stdin: { data: text }, stdout: 'ignore', stderr: 'ignore' },
      graceMs: 5000,
    })
    const outcome = await handle.done
    const code = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : 1
    if (code !== 0) throw new LaunchError('clipboard-failed', 'could not copy the prompt to the clipboard')
  }

  /** POSIX login shell used to inspect the user's PATH. */
  const loginShell = () => {
    if (platform === 'darwin') return '/bin/zsh'
    // The probe below uses POSIX `for` syntax, so a fish/nushell login shell
    // falls back to /bin/sh instead of failing the whole detection.
    const shell = typeof process.env.SHELL === 'string' ? process.env.SHELL : ''
    if (path.isAbsolute(shell) && /(?:^|\/)(?:ba|z|k|da|a)?sh$/.test(path.basename(shell))) return shell
    return '/bin/sh'
  }

  const isExecutableFile = async (file) => {
    try {
      await fs.access(file, 1) // X_OK
      return true
    } catch {
      return false
    }
  }

  /**
   * Locates executables through the platform's login environment in one
   * subprocess call: a login shell on macOS/Linux (buildExecutableProbe) and
   * PowerShell 5.1 `Get-Command -CommandType Application,ExternalScript` on
   * Windows, which per the Get-Command docs restricts the lookup to PATH
   * executables and .ps1 scripts, never aliases or functions
   * (https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-5.1).
   * `found` maps a name to `{ path }` or `{ path: null, reason }`
   * (classifyProbeAnswer); an alias target must still be executable here.
   * `seen` counts every answered name; `ok` is false when the probe failed.
   */
  const locateExecutables = async (names, timeoutMs) => {
    const unique = Array.from(new Set(names.filter((name) => typeof name === 'string' && name !== '')))
    const found = new Map()
    const seen = new Set()
    if (unique.length === 0) return { found, seen, ok: true }
    let argv
    if (platform === 'win32') {
      const quoted = unique.map((name) => windowsQuote(name)).join(',')
      const script =
        '$names=@(' + quoted + '); foreach($name in $names){$cmd=Get-Command $name -CommandType Application,ExternalScript'
        + " -ErrorAction SilentlyContinue | Select-Object -First 1; $p=''; if($cmd){$p=$cmd.Path};"
        + " '__td__\t{0}\t{1}\t' -f $name,$p}"
      argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
    } else {
      // Verified against zsh Files/Startup: .zshrc is read only by interactive
      // shells; -l alone reads .zprofile but misses typical CLI PATH additions.
      // https://zsh.sourceforge.io/Doc/Release/Files.html#Startup_002fShutdown-Files
      argv = buildExecutableProbe(loginShell(), unique)
    }
    const result = await runProcess(argv, { timeoutMs })
    for (const [name, answer] of parseExecutableProbe(result.stdout)) {
      seen.add(name)
      const verdict = classifyProbeAnswer(answer, platform)
      if (verdict.via === 'alias' && !(await isExecutableFile(verdict.path))) {
        found.set(name, { path: null, reason: 'alias' })
      } else {
        found.set(name, verdict)
      }
    }
    return { found, seen, ok: result.code === 0 }
  }

  /**
   * One login-shell lookup for the machine tools the launcher needs besides
   * the agents: the Linux terminal emulators and `python3` for the paste
   * wrapper. Shared by concurrent callers and cached for a minute, so opening
   * Settings costs one probe here (the agents have their own).
   */
  const LINUX_TERMINAL_ORDER = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'x-terminal-emulator', 'xterm']
  let toolScan = null
  const locateTools = () => {
    if (toolScan !== null && (toolScan.pending || Date.now() - toolScan.at < 60_000)) return toolScan.promise
    const names = ['python3']
    if (platform === 'linux') {
      for (const entry of terminalCatalog('linux')) names.push(...entry.bins)
      names.push(...LINUX_TERMINAL_ORDER)
    }
    const scan = { pending: true, at: 0, promise: null }
    scan.promise = locateExecutables(Array.from(new Set(names)), 8000)
      .then(({ found }) => {
        const paths = new Map()
        for (const [name, verdict] of found) if (typeof verdict?.path === 'string' && verdict.path !== '') paths.set(name, verdict.path)
        return paths
      })
      .catch(() => new Map())
      .finally(() => {
        scan.pending = false
        scan.at = Date.now()
      })
    toolScan = scan
    return scan.promise
  }

  /**
   * Linux terminal emulator for `auto`: `$TERMINAL` when it is an absolute
   * path, otherwise the first installed candidate, or null.
   */
  const detectLinuxTerminal = async () => {
    const fromEnv = typeof process.env.TERMINAL === 'string' ? process.env.TERMINAL.trim() : ''
    if (fromEnv !== '' && path.isAbsolute(fromEnv)) return fromEnv
    const paths = await locateTools()
    for (const candidate of LINUX_TERMINAL_ORDER) if (paths.has(candidate)) return paths.get(candidate)
    return null
  }

  /** Windows Terminal is optional; resolve it once and fall back when missing. */
  let windowsTerminal = undefined
  const resolveWindowsTerminal = async () => {
    if (windowsTerminal !== undefined) return windowsTerminal
    windowsTerminal = await findExecutable(['wt', 'wt.exe'])
    return windowsTerminal
  }

  const appInstalled = async (apps) => {
    for (const app of apps) {
      const dir = app.startsWith('~/') ? path.join(os.homedir(), app.slice(2)) : app
      try {
        if ((await fs.stat(dir)).isDirectory()) return dir
      } catch {
        // not installed at this location
      }
    }
    return ''
  }

  /**
   * The terminal apps of this platform's catalog with what is installed, plus
   * what `auto` resolves to. Cached for a minute: Settings reads it on open and
   * every launch resolves the saved choice through it.
   */
  let terminalScan = null
  const detectTerminals = async ({ force = false } = {}) => {
    if (!force && terminalScan !== null && Date.now() - terminalScan.at < 60_000) return terminalScan.value
    const catalog = terminalCatalog(platform)
    const options = []
    if (platform === 'darwin') {
      for (const entry of catalog) {
        // Terminal.app ships with macOS and cannot be removed, so it is always
        // offered; the others are checked at their standard locations.
        const location = entry.id === 'terminal' ? entry.apps[0] : await appInstalled(entry.apps)
        options.push({ id: entry.id, label: entry.label, tabs: entry.tabs, available: location !== '', path: location })
      }
    } else if (platform === 'linux') {
      const paths = await locateTools()
      for (const entry of catalog) {
        const located = entry.bins.map((bin) => paths.get(bin)).find((value) => typeof value === 'string')
        options.push({ id: entry.id, label: entry.label, tabs: entry.tabs, available: Boolean(located), path: located || '' })
      }
    } else if (platform === 'win32') {
      const wt = await resolveWindowsTerminal()
      for (const entry of catalog) {
        const located = entry.id === 'windows-terminal' ? wt || '' : 'powershell.exe'
        options.push({ id: entry.id, label: entry.label, tabs: entry.tabs, available: located !== '', path: located })
      }
    }
    let auto = null
    if (platform === 'darwin') auto = options.find((entry) => entry.id === 'iterm' && entry.available) ? 'iterm' : 'terminal'
    if (platform === 'win32') auto = options.find((entry) => entry.id === 'windows-terminal' && entry.available) ? 'windows-terminal' : 'console'
    let autoLabel = auto === null ? '' : catalog.find((entry) => entry.id === auto).label
    if (platform === 'linux') {
      const detected = await detectLinuxTerminal()
      const match = typeof detected === 'string' ? options.find((entry) => entry.path === detected) : undefined
      auto = match ? match.id : null
      autoLabel = match ? match.label : typeof detected === 'string' ? path.basename(detected) : ''
    }
    const value = { platform, options, auto, autoLabel }
    terminalScan = { at: Date.now(), value }
    return value
  }

  /**
   * The terminal a launch uses: the saved choice when it is installed on this
   * platform, otherwise what `auto` resolves to. Returns the plan capabilities
   * plus `{ id, label }` for the launch result.
   */
  const resolveTerminal = async (choice) => {
    const scan = await detectTerminals()
    const chosen = choice !== TERMINAL_AUTO ? scan.options.find((entry) => entry.id === choice && entry.available) : undefined
    const capabilities = {}
    let id = chosen ? chosen.id : scan.auto
    if (platform === 'darwin') {
      capabilities.app = id
    } else if (platform === 'linux') {
      capabilities.terminal = chosen ? chosen.path : await detectLinuxTerminal()
    } else if (platform === 'win32') {
      if (id === 'windows-terminal') capabilities.wt = chosen ? chosen.path : await resolveWindowsTerminal()
      else capabilities.wt = ''
    }
    const entry = scan.options.find((option) => option.id === id)
    const label = entry ? entry.label : scan.autoLabel
    return { capabilities, terminal: { id: id || TERMINAL_AUTO, label, fallback: choice !== TERMINAL_AUTO && !chosen } }
  }

  /**
   * Whether the paste wrapper can run here: `{ available, reason, python }`.
   * A working setup is cached for ten minutes; a missing one only for 30 s, so
   * installing Python after the Settings hint is noticed within a minute (the
   * shared tool lookup is cached for 60 s). macOS and Linux need a working Python 3
   * with `pty` (found through the login-shell PATH); on macOS `/usr/bin/python3`
   * is only a stub until the Command Line Tools are installed, and running it
   * then opens an install dialog, so `xcode-select -p` is checked first.
   * Windows needs ConPTY, available from Windows 10 1809 (build 17763).
   * `reason` is `python-missing`, `python-clt` or `windows-old`.
   */
  let pasteSupport = null
  const detectPasteSupport = async () => {
    const maxAge = pasteSupport?.value.available ? 600_000 : 30_000
    if (pasteSupport !== null && Date.now() - pasteSupport.at < maxAge) return pasteSupport.value
    let value
    if (platform === 'win32') {
      const build = Number(String(os.release()).split('.')[2])
      value = Number.isFinite(build) && build >= 17763
        ? { available: true, reason: null, python: null }
        : { available: false, reason: 'windows-old', python: null }
    } else {
      let python = (await locateTools()).get('python3') || (await findExecutable(['python3'])) || ''
      value = { available: false, reason: 'python-missing', python: null }
      if (python !== '' && platform === 'darwin' && python === '/usr/bin/python3') {
        const tools = await runProcess(['/usr/bin/xcode-select', '-p'], { timeoutMs: 5000 }).catch(() => ({ code: 1 }))
        if (tools.code !== 0) {
          value = { available: false, reason: 'python-clt', python: null }
          python = ''
        }
      }
      if (python !== '') {
        const probe = await runProcess([python, '-I', '-c', 'import pty, termios, select, sys; print(sys.version_info[0])'], {
          timeoutMs: 8000,
        }).catch(() => ({ code: 1, stdout: '' }))
        if (probe.code === 0 && String(probe.stdout).trim() === '3') value = { available: true, reason: null, python }
      }
    }
    pasteSupport = { at: Date.now(), value }
    return value
  }

  /**
   * Linux window raiser for focus-or-reuse: wmctrl or xdotool, whichever is
   * installed. Both are optional; when neither exists, re-launching opens a new
   * tab rather than focusing the old one.
   */
  let linuxRaiser = undefined
  const detectLinuxRaiser = async () => {
    if (linuxRaiser !== undefined) return linuxRaiser
    linuxRaiser = { wmctrl: '', xdotool: '' }
    if (platform === 'linux') {
      linuxRaiser.wmctrl = (await findExecutable(['wmctrl'])) || ''
      if (linuxRaiser.wmctrl === '') linuxRaiser.xdotool = (await findExecutable(['xdotool'])) || ''
    }
    return linuxRaiser
  }

  /**
   * A terminal emulator may not be a short-lived command, so observe immediate
   * failures for 500 ms, then acknowledge startup without a kill timer. This is
   * not proof the GUI rendered; late failures cannot reach this request.
   *
   * What was verified: xterm's window lives with its `-e` child session
   * (https://invisible-island.net/xterm/manpage/xterm.html). Whether the
   * spawned process is the window itself was NOT verified for gnome-terminal,
   * konsole, xfce4-terminal, kitty, alacritty or x-terminal-emulator (some
   * hand the request to an already running server and exit at once); for those
   * the exit code within 500 ms is the only signal used.
   *
   * Lifetime: per the DSH subprocess README, "Disposal of the service
   * terminates every still-running managed process ... so process lifetime
   * survives consumer reloads": a still-running emulator outlives a plugin
   * reload but is closed when DSH quits (the subprocess service is disposed).
   *
   * stderr is a bounded collector, not a pipe: an unread pipe could fill and
   * block a chatty emulator after the acknowledgement; the collector keeps a
   * 16 KiB tail that is read only for an early failure message.
   */
  const startLinuxTerminal = (argv, signal) => new Promise((resolve) => {
    let handle
    let timer
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => {
      try { handle?.terminate() } catch { /* best-effort cancellation during startup */ }
      finish({ code: 130, stderr: 'the launch was cancelled' })
    }
    if (signal?.aborted) { abort(); return }
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd: settings.cwd,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 16 * 1024 } },
        graceMs: 5000,
      })
    } catch (error) {
      finish({ code: 1, stderr: String(error?.message || error) })
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish({ code: 0 }), 500)
    Promise.resolve(handle.done).then(
      (outcome) => finish({
        code: typeof outcome?.exitCode === 'number' ? outcome.exitCode : 1,
        stderr: handle.collected?.stderr?.readFrom?.(0)?.text || '',
      }),
      (error) => finish({ code: 1, stderr: String(error?.message || error) }),
    )
  })

  /**
   * Opens the generated launcher for this item+agent. First tries to focus an
   * already-open tab with the same title (focus-or-reuse), so re-launching the
   * same agent on the same item raises its window instead of duplicating it.
   * Otherwise opens a new tab in the shared terminal window, falling back to a
   * new window when the tab plan fails. Focus is best-effort: any failure just
   * proceeds to open a fresh tab/window.
   */
  const openTerminal = async (scriptPath, title, signal, choice = TERMINAL_AUTO, reuse = true) => {
    const resolved = await resolveTerminal(choice)
    const capabilities = { scriptPath, title, ...resolved.capabilities }
    if (reuse && platform === 'linux') {
      const raiser = await detectLinuxRaiser()
      capabilities.wmctrl = raiser.wmctrl
      capabilities.xdotool = raiser.xdotool
    }

    const focusPlan = reuse ? focusTerminalPlan(platform, capabilities) : null
    if (focusPlan !== null && !(signal !== undefined && signal.aborted === true)) {
      try {
        const focused = await runProcess(focusPlan.argv, {
          cwd: settings.cwd,
          timeoutMs: 8000,
          ...(signal !== undefined ? { signal } : {}),
        })
        // iTerm2's AppleScript returns `true`/`false`; wmctrl/xdotool exit
        // non-zero when no window matched. A confirmed match means the existing
        // tab is now focused and no new one is needed.
        if (focused.code === 0 && focused.stdout.trim().toLowerCase() !== 'false') {
          return { argv: focusPlan.argv, variant: 'focus', terminal: resolved.terminal }
        }
      } catch {
        // focus is best-effort; fall through to opening a fresh tab/window
      }
    }

    const plans = [openTerminalPlan(platform, capabilities)]
    if (plans[0].variant === 'tab') {
      plans.push(openTerminalPlan(platform, { ...capabilities, tab: false }))
    }
    let detail = ''
    for (const plan of plans) {
      let result
      try {
        result = platform === 'linux'
          ? await startLinuxTerminal(plan.argv, signal)
          : await runProcess(plan.argv, {
            cwd: settings.cwd,
            timeoutMs: 20_000,
            ...(signal !== undefined ? { signal } : {}),
          })
      } catch (error) {
        detail = String((error && error.message) || error)
        continue
      }
      if (result.code === 0) {
        // A macOS plan names the app it opened; a fallback to another app is
        // reported as that app, so the toast and the activation nudge match.
        if (typeof plan.app === 'string' && plan.app !== resolved.terminal.id) {
          const entry = terminalCatalog(platform).find((option) => option.id === plan.app)
          return { ...plan, terminal: { id: plan.app, label: entry ? entry.label : plan.app, fallback: true } }
        }
        return { ...plan, terminal: resolved.terminal }
      }
      detail = (result.stderr || result.stdout || plan.argv[0] + ' exited with code ' + result.code)
        .trim()
        .split('\n')[0]
    }
    throw new Error('could not open Terminal: ' + (detail || 'the opener failed'))
  }

  return {
    runProcess,
    findExecutable,
    copyToClipboard,
    isExecutableFile,
    locateExecutables,
    startLinuxTerminal,
    detectTerminals,
    detectPasteSupport,
    openTerminal,
  }
}
