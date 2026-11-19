/**
 * Triage Desk launcher — the terminal apps a launch can open, per platform.
 *
 * `auto` keeps the built-in choice (macOS: iTerm2 when installed, otherwise
 * Terminal; Linux: `$TERMINAL`, then the first installed emulator; Windows:
 * Windows Terminal when installed, otherwise a console window). Any other value
 * is one catalog id of the host platform; an id that is not installed falls
 * back to `auto` at launch.
 */

export const TERMINAL_AUTO = 'auto'

/**
 * `tabs`: whether a launch opens a tab in the app's current window (true) or a
 * new window (false). `apps` are macOS bundle locations, `bins` Linux/Windows
 * executable names resolved through the login-shell PATH.
 */
export const TERMINAL_CATALOG = {
  darwin: [
    {
      id: 'terminal',
      label: 'Terminal',
      tabs: false,
      apps: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
    },
    { id: 'iterm', label: 'iTerm2', tabs: true, apps: ['/Applications/iTerm.app', '~/Applications/iTerm.app'] },
    { id: 'ghostty', label: 'Ghostty', tabs: true, apps: ['/Applications/Ghostty.app', '~/Applications/Ghostty.app'] },
  ],
  linux: [
    { id: 'gnome-terminal', label: 'GNOME Terminal', tabs: true, bins: ['gnome-terminal'] },
    { id: 'konsole', label: 'Konsole', tabs: true, bins: ['konsole'] },
    { id: 'xfce4-terminal', label: 'Xfce Terminal', tabs: true, bins: ['xfce4-terminal'] },
    { id: 'ghostty', label: 'Ghostty', tabs: false, bins: ['ghostty'] },
    { id: 'kitty', label: 'kitty', tabs: false, bins: ['kitty'] },
    { id: 'alacritty', label: 'Alacritty', tabs: false, bins: ['alacritty'] },
    { id: 'xterm', label: 'xterm', tabs: false, bins: ['xterm'] },
  ],
  win32: [
    { id: 'windows-terminal', label: 'Windows Terminal', tabs: true, bins: ['wt', 'wt.exe'] },
    { id: 'console', label: 'PowerShell window', tabs: false, bins: [] },
  ],
}

/** Every catalog id on any platform; a saved choice is validated against these. */
export const TERMINAL_IDS = Array.from(
  new Set(Object.values(TERMINAL_CATALOG).flatMap((entries) => entries.map((entry) => entry.id))),
)

export function terminalCatalog(platform) {
  return TERMINAL_CATALOG[platform] || []
}

/** `auto`, or a known terminal id; anything else becomes `auto`. */
export function normalizeTerminalChoice(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TERMINAL_IDS.includes(id) ? id : TERMINAL_AUTO
}
