/**
 * Platform helpers shared by the dev smokes, so checks that need a POSIX shell,
 * a fake home directory or symlinks behave the same on macOS, Linux and
 * Windows.
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * True when `/bin/sh` can run commands. Windows has no POSIX shell, so checks
 * that execute generated shell code skip that part there; their Windows
 * counterparts assert the generated PowerShell instead.
 */
export const POSIX_SHELL = process.platform !== 'win32' && spawnSync('/bin/sh', ['-c', 'exit 0']).status === 0

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
    assertHome(home)
    return await callback()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function assertHome(home) {
  if (os.homedir() !== home) throw new Error('os.homedir() did not follow the fake home: ' + os.homedir())
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
