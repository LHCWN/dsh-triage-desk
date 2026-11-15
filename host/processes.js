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
      stdio: { stdin: { data: text + '\n' }, stdout: 'ignore', stderr: 'ignore' },
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
   * Linux terminal emulator, detected once through the login shell. `$TERMINAL`
   * wins when it is an absolute path; otherwise the first installed candidate
   * is used.
   */
  let linuxTerminal = undefined
  const detectLinuxTerminal = async () => {
    if (linuxTerminal !== undefined) return linuxTerminal
    const fromEnv = typeof process.env.TERMINAL === 'string' ? process.env.TERMINAL.trim() : ''
    if (fromEnv !== '' && path.isAbsolute(fromEnv)) {
      linuxTerminal = fromEnv
      return linuxTerminal
    }
    const candidates = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'x-terminal-emulator', 'xterm']
    const { found } = await locateExecutables(candidates, 8000)
    linuxTerminal = null
    for (const candidate of candidates) {
      const located = found.get(candidate)?.path
      if (typeof located === 'string' && located !== '') {
        linuxTerminal = located
        break
      }
    }
    return linuxTerminal
  }

  /** Windows Terminal is optional; resolve it once and fall back when missing. */
  let windowsTerminal = undefined
  const resolveWindowsTerminal = async () => {
    if (windowsTerminal !== undefined) return windowsTerminal
    windowsTerminal = await findExecutable(['wt', 'wt.exe'])
    return windowsTerminal
  }

  /**
   * iTerm2 is the only macOS terminal with a safe tab API, so detect it once.
   * `mdfind`/bundle checks need Spotlight; a direct check of the two standard
   * install locations is enough and avoids spawning. Returns true when iTerm2
   * is installed; the launch plan then routes tabs to it instead of opening
   * Terminal.app windows.
   */
  let itermPresent = undefined
  const detectIterm = async () => {
    if (itermPresent !== undefined) return itermPresent
    if (platform !== 'darwin') {
      itermPresent = false
      return itermPresent
    }
    const candidates = ['/Applications/iTerm.app', path.join(os.homedir(), 'Applications', 'iTerm.app')]
    itermPresent = false
    for (const dir of candidates) {
      try {
        const stat = await fs.stat(dir)
        if (stat.isDirectory()) {
          itermPresent = true
          break
        }
      } catch {
        // not installed at this location
      }
    }
    return itermPresent
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
  const openTerminal = async (scriptPath, title, signal) => {
    const capabilities = { scriptPath, title }
    if (platform === 'darwin') capabilities.iterm = await detectIterm()
    if (platform === 'linux') {
      capabilities.terminal = await detectLinuxTerminal()
      const raiser = await detectLinuxRaiser()
      capabilities.wmctrl = raiser.wmctrl
      capabilities.xdotool = raiser.xdotool
    }
    if (platform === 'win32') capabilities.wt = await resolveWindowsTerminal()

    const focusPlan = focusTerminalPlan(platform, capabilities)
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
          return { argv: focusPlan.argv, variant: 'focus' }
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
      if (result.code === 0) return plan
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
    openTerminal,
  }
}
