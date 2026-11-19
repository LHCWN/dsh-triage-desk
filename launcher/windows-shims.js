/**
 * Triage Desk launcher — Windows `.exe` shims. Some package managers install
 * an `.exe` that only starts another program, which can be a `.cmd`/`.bat` or
 * `cmd.exe` itself: a native-draft prompt argument would then reach `cmd.exe`
 * again, which the `.exe` rule in agent-command.js exists to prevent (issue
 * #5). isWindowsShim recognizes these layouts and never reads what the shim
 * points at, so any known shim loses the draft (issue #12). Verified sources:
 *   - Scoop: `<name>.shim` beside it; its `path` may be `cmd.exe` and the shim
 *     starts any path through CreateProcess (ScoopInstaller/Scoop lib/core.ps1
 *     `shim`, lib/install.ps1 `create_shims`; kiennq/scoop-better-shimexe shim.cpp).
 *   - bun: `<name>.bunx` beside it; a `.cmd`/`.bat` target runs as `cmd /c`
 *     (oven-sh/bun src/install/windows-shim/BinLinkingShim.rs, bun_shim_impl.rs).
 *   - Chocolatey: its `bin` folder, which holds the `choco.exe` redirect shim
 *     (chocolatey/choco nuspec/chocolatey/chocolatey/tools/chocolateysetup.psm1
 *     `Install-ChocolateyBinFiles`; legacy root `$env:SystemDrive\Chocolatey`);
 *     `Install-BinFile` shims any file, a `.bat` too (choco Install-BinFile.ps1).
 *   - Volta: `volta-shim.exe` beside it; every tool starts as `cmd.exe /C`
 *     (volta-cli/volta wix/main.wxs, crates/volta-core/src/command.rs).
 *   - mise: `.mode` beside it, written for every Windows shim mode; `mise x`
 *     starts `.cmd` tools too (jdx/mise src/shims.rs `write_shim_metadata`,
 *     src/cli/exec.rs).
 *   - proto: `registry.json` beside it, which proto itself treats as the shims
 *     folder marker (moonrepo/proto crates/cli/src/commands/run.rs
 *     `find_global_executable`, crates/shim/src/windows.rs).
 * A symlink or junction is resolved and the markers beside its target count
 * too; a winget `Links` entry is a symlink to the program itself
 * (microsoft/winget-cli src/AppInstallerCLICore/PortableInstaller.cpp), so it
 * keeps the draft. A hard link has no target to resolve: one placed outside
 * these folders is not recognized. Other managers (aqua's hard-linked
 * `aqua-proxy.exe`, for one) have no marker beside the `.exe`; the check is a
 * best effort over the layouts above. npm/pnpm/yarn global bins are not `.exe`
 * files, so the `.exe` rule already excludes them.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { windowsDraftExecutable } from './agent-command.js'

const defaultIo = { stat: (file) => fs.stat(file), realpath: (file) => fs.realpath(file), env: process.env }

const missing = (error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

function pathKey(dir) {
  return path.win32.normalize(dir).replace(/\\+$/, '').toLowerCase()
}

/** Chocolatey's `bin` folders this environment can name (see above). */
function chocolateyBins(env) {
  const roots = [
    env.ChocolateyInstall,
    env.ProgramData && path.win32.join(env.ProgramData, 'chocolatey'),
    env.ALLUSERSPROFILE && path.win32.join(env.ALLUSERSPROFILE, 'chocolatey'),
    path.win32.join((env.SystemDrive || 'C:') + '\\', 'Chocolatey'),
    'C:\\Chocolatey',
  ]
  return new Set(roots.filter((root) => typeof root === 'string' && root !== '').map((root) => pathKey(path.win32.join(root, 'bin'))))
}

/**
 * Whether the Windows `.exe` at `executablePath` is in a known shim layout
 * (see above), so it gets no native draft. The `.exe` and, when it is a link,
 * the target realpath resolves are both checked, each with its own name as
 * the stem. Fails closed: a link that resolves to something other than an
 * `.exe`, and a marker or link that cannot be checked for any reason other
 * than not existing, count as a shim. `io` replaces `fs.stat` (`stat`),
 * `fs.realpath` (`realpath`) and the environment (`env`) in tests.
 */
export async function isWindowsShim(executablePath, io = {}) {
  const { stat, realpath, env = {} } = { ...defaultIo, ...io }
  const executable = windowsDraftExecutable(executablePath)
  if (executable === null) return false
  const candidates = [executable]
  try {
    const resolved = path.win32.normalize(await realpath(executable))
    if (pathKey(resolved) !== pathKey(executable)) {
      if (windowsDraftExecutable(resolved) === null) return true
      candidates.push(resolved)
    }
  } catch (error) {
    if (!missing(error)) return true
  }
  const bins = chocolateyBins(env)
  if (candidates.some((file) => bins.has(pathKey(path.win32.dirname(file))))) return true
  const present = (file) => stat(file).then(() => true, (error) => !missing(error))
  const checks = candidates.flatMap((file) => {
    const dir = path.win32.dirname(file)
    const stem = path.win32.basename(file).slice(0, -'.exe'.length)
    return [stem + '.shim', stem + '.bunx', 'volta-shim.exe', '.mode', 'registry.json', 'choco.exe']
      .map((name) => present(path.win32.join(dir, name)))
  })
  return (await Promise.all(checks)).includes(true)
}
