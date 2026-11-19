/**
 * Triage Desk — terminal launch helpers.
 *
 * Turns a GitHub row into "start this agent in the local clone of this repo,
 * in a visible Terminal window, with an initial prompt". Everything here is
 * either a pure function (easy to unit test, no Cordis context) or a small
 * filesystem helper; the Cordis-facing glue lives in index.js.
 *
 * Safety model:
 *   - the prompt never appears in a shell command line: it is written to a
 *     file and read by the generated launcher through command substitution;
 *   - only the directory, the agent command, and the window title are quoted
 *     into the launcher, with single-quote shell quoting;
 *   - clone directories come from user settings, never from a remote payload.
 *
 * This file is the public entry of the launcher layer: it only re-exports the
 * modules under `launcher/`. Names exported by those modules but not listed
 * here are internal to the layer.
 */

export { expandHome } from './launcher/common.js'

export { REPO_PATTERN, parseRepoUrl, parseSshConfigHosts, readSshHostAliases, remoteToRepo } from './launcher/repo-urls.js'

export {
  AGENT_COMMAND_RULE,
  agentExecutable,
  bareAgentCommand,
  buildDraftCommand,
  draftCommandFor,
  hasSafePromptPlaceholder,
  shellQuote,
  withAgentExecutable,
  windowsPinBlocked,
} from './launcher/agent-command.js'

export { buildExecutableProbe, classifyProbeAnswer, parseExecutableProbe } from './launcher/executable-probe.js'

export {
  AGENT_ID_PATTERN,
  AGENT_PRESETS,
  DISCOVERABLE_AGENTS,
  MAX_AGENTS,
  MAX_AGENT_COMMAND,
  MAX_AGENT_LABEL,
} from './launcher/agents.js'

export {
  BUILTIN_SCENARIOS,
  BUILTIN_SCENARIO_TITLES,
  DEFAULT_SCENARIO_ID,
  MAX_SCENARIOS,
  MAX_SCENARIO_TEMPLATE,
  SCENARIO_REASON_LABELS,
  SCENARIO_SECTION_IDS,
  SCENARIO_SECTION_LABELS,
  defaultScenarios,
  normalizeScenarios,
  scenarioTitle,
  validateDefaultScenario,
  validateScenario,
} from './launcher/scenarios.js'

export { MAX_RENDERED_PROMPT, buildItemsBlock, buildScenarioPrompt, promptVars } from './launcher/prompt.js'

export {
  DEFAULT_PROMPT_DELIVERY,
  MAX_CLONE_DIRS,
  MAX_REPO_PATHS,
  PROMPT_DELIVERY_MODES,
  normalizeLauncherConfig,
} from './launcher/settings.js'

export {
  DEFAULT_CLONE_DIRS,
  chooseCloneRepo,
  discoverCloneRoots,
  isGitCloneDir,
  lookupRepoPath,
  matchClone,
  scanCloneDirs,
} from './launcher/clones.js'

export {
  buildClipboardLauncherScript,
  buildDraftLauncherScript,
  buildLoginLauncherScript,
  buildPasteLauncherScript,
} from './launcher/posix-scripts.js'

export {
  PASTE_DEADLINE_MS,
  PASTE_QUIET_MS,
  PASTE_SETTLE_MS,
  PASTE_TRUST_PATTERN,
  PASTE_WRAPPER_CS,
  PASTE_WRAPPER_PY,
  sanitizePastePrompt,
} from './launcher/paste-wrapper.js'

export {
  buildWindowsClipboardLauncherScript,
  buildWindowsDraftLauncherScript,
  buildWindowsLoginLauncherScript,
  buildWindowsPasteLauncherScript,
  windowsQuote,
} from './launcher/windows-scripts.js'

export {
  buildGhosttyTabAppleScript,
  buildItermTabAppleScript,
  focusTerminalPlan,
  openTerminalPlan,
} from './launcher/terminal-plan.js'

export {
  TERMINAL_AUTO,
  TERMINAL_CATALOG,
  TERMINAL_IDS,
  normalizeTerminalChoice,
  terminalCatalog,
} from './launcher/terminals.js'
