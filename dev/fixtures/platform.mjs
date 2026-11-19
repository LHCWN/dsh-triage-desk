/**
 * Platform helpers shared by the dev smokes, so checks that need a POSIX shell,
 * a fake home directory or symlinks behave the same on macOS, Linux and
 * Windows.
 */
import { spawnSync } from 'node:child_process'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * True when `/bin/sh` can run commands. Windows has no POSIX shell, so checks
 * that execute generated shell code skip that part there; their Windows
 * counterparts assert the generated PowerShell instead.
 */
export const POSIX_SHELL = process.platform !== 'win32' && spawnSync('/bin/sh', ['-c', 'exit 0']).status === 0

/**
 * Runs the part of a check that executes generated shell code, or logs a skip
 * when there is no POSIX shell (Windows). Every such skip goes through here so
 * it is visible in the output.
 */
export function withPosixShell(label, callback) {
  if (!POSIX_SHELL) {
    console.log('skip ' + label + ': needs a POSIX shell')
    return
  }
  callback()
}

/**
 * Removes `dir` on every exit: success, a skip, a failed assertion, or an
 * abort. A signal's default action skips the `exit` event, so SIGINT, SIGTERM
 * and SIGHUP leave through process.exit with the usual 128 + signal status.
 */
export function removeOnExit(dir) {
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort: a file still held open on Windows stays for the OS to clean
    }
  })
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => process.exit(status))
  }
}

/**
 * Runs `callback` with `home` as the home directory. `os.homedir()` reads
 * `HOME` on macOS and Linux but `USERPROFILE` on Windows, so both are set and
 * restored; the host resolves `~`, `~/.ssh/config` and default clone roots
 * through `os.homedir()`.
 */
export async function withHome(home, callback) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    if (os.homedir() !== home) throw new Error('os.homedir() did not follow the fake home: ' + os.homedir())
    return await callback()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Whether this account may create directory symlinks. A standard Windows
 * account without Developer Mode or administrator rights gets EPERM, which is
 * an environment limit, not a defect in the code under test.
 */
export async function canSymlink(dir) {
  const target = path.join(dir, 'symlink-probe-target')
  const link = path.join(dir, 'symlink-probe-link')
  await fs.mkdir(target, { recursive: true })
  try {
    await fs.symlink(target, link, 'dir')
    return true
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return false
    throw error
  } finally {
    await fs.rm(link, { force: true }).catch(() => undefined)
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
  }
}
