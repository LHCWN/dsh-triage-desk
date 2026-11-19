/*
 * Triage Desk — Client half.
 *
 * A global sidebar panel ("Triage") plus its page in the keyed `main` slot.
 * The page renders a GitHub triage inbox for the configured organization; data
 * comes from this bundle's Host half over the same-origin exact route
 * `/triage-desk/snapshot` (the same snapshot backs the `triage_desk` tool).
 *
 * Plain JavaScript, no build step: loaded as a classic same-origin script by the
 * DSH client module system. Only `react` is required from the platform seed table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-triage-desk',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useLayoutEffect, useRef, useMemo } = React

    const PACKAGE_ID = 'dsh-triage-desk'
    const NS = 'triage-desk'
    const PANEL_ID = 'triage-desk'
    const SNAPSHOT_URL = '/triage-desk/snapshot'
    const CONFIG_URL = '/triage-desk/config'
    const AUTH_URL = '/triage-desk/auth'
    const AUTH_LOGIN_URL = '/triage-desk/auth/login'
    const LAUNCH_URL = '/triage-desk/launch'
    const PROMPT_URL = '/triage-desk/prompt'
    const CLONES_URL = '/triage-desk/clones'
    const AGENTS_FIND_URL = '/triage-desk/agents/find'
    const SECTION_ORDER = ['review', 'rereview', 'merge', 'respond', 'ci', 'issues']
    const REFRESH_PRESETS = [60, 300, 600, 1200, 1800, 3600]
    const MAX_SCENARIO_LABEL = 60
    const MAX_SCENARIO_TEMPLATE = 4000
    const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
    // Snapshot failure backoff; each step is capped by the poll interval.
    const ERROR_RETRY_SECONDS = [15, 60, 300]
    // Restart window before a 202 (older host) save is read back.
    const APPLY_CONFIRM_MS = 5000
    const APPLY_CONFIRM_ATTEMPTS = 2
    // A save that fell back to a restart leaves the routes briefly missing:
    // the first snapshot read after it gets one quiet retry this much later.
    const SAVE_RELOAD_RETRY_MS = 1500
    const MINUTE_MS = 60_000
    const SAVE_STATUSES = ['saving', 'applying', 'saved']

    // Set in apply(): lets both slot components reach the one store even if a
    // registration option is not propagated to a factory-rendered child.
    const runtime = { store: null }
    let agentRowSeq = 0
    function newAgentRowKey() {
      agentRowSeq += 1
      return 'agent-row-' + agentRowSeq
    }

    /* ------------------------------------------------------------------ i18n */

    const EN = {
      'panel.label': 'Triage',
      'page.title': 'Triage',
      'page.subtitle': 'GitHub triage',
      'page.sources': 'Sources: {list}',
      'page.updated': 'updated {time}',
      'page.updatedAgo': '{age} ago',
      'page.never': 'not loaded yet',
      'page.refresh': 'Refresh data',
      'page.search': 'Find a PR, repository, or author',
      'page.searchClear': 'Clear search',
      'page.filterAll': 'All',
      'page.footer': 'Source: GitHub through the gh CLI · refreshes every {sec}s',
      'page.footerRate': ' · API calls left: {n}',
      'page.loading': 'Reading the GitHub state…',
      'page.error': 'Could not read data from GitHub',
      'page.retry': 'Retry',
      'page.empty': 'Nothing needs your attention',
      'page.emptyHint': 'Close the panel and get back to work.',
      'page.filtered': 'Nothing in this section',
      'page.filteredHint': 'Try another section or clear the search.',
      'page.reset': 'Clear filter',
      'page.copy': 'Copy link',
      'page.copied': 'Link copied',
      'snooze.locale': 'en',
      'snooze.button': 'Snooze',
      'snooze.menu': 'Snooze',
      'snooze.activity': 'Until new activity',
      'snooze.activityHint': 'Returns when something changes',
      'snooze.tomorrowOption': 'Until tomorrow',
      'snooze.nextWeekOption': 'Until next week',
      'snooze.note': 'Any new activity brings it back sooner.',
      'snooze.today': 'Today, {time}',
      'snooze.tomorrow': 'Tomorrow, {time}',
      'snooze.on': '{day}, {time}',
      'snooze.toastActivity': 'Snoozed until new activity',
      'snooze.toastUntil': 'Snoozed until {when}',
      'snooze.undo': 'Undo',
      'snooze.unsnooze': 'Unsnooze',
      'snooze.chip': 'Snoozed',
      'snooze.returnsActivity': 'returns on new activity',
      'snooze.returnsAt': 'returns {when}',
      'snooze.menuMany': 'Snooze {n} items',
      'snooze.section': 'Snooze all ({n})',
      'snooze.unsnoozeAll': 'Unsnooze all ({n})',
      'snooze.toastManyActivity': 'Snoozed {n} items until new activity',
      'snooze.toastManyUntil': 'Snoozed {n} items until {when}',
      'snooze.toastUnsnoozed': 'Unsnoozed',
      'snooze.toastUnsnoozedMany': 'Unsnoozed {n} items',
      'select.row': 'Select “{title}”',
      'select.count': '{n} selected',
      'select.enter': 'Select',
      'select.done': 'Done',
      'select.hint': 'Select items to snooze',
      'select.hintUnsnooze': 'Select items to unsnooze',
      'select.all': 'Select all',
      'select.none': 'Deselect all',
      'select.section': 'Select all in “{section}”',
      'select.bar': 'Selected items',
      'page.copyFailed': 'Copy failed — check clipboard access',
      'page.collapse': 'Collapse section',
      'page.expand': 'Expand section',
      'page.stale': 'Showing the snapshot from {time}: the last refresh failed.',
      'page.partial': 'Some data is unavailable',
      'page.unauthHint': 'gh does not look signed in. Run `gh auth login` in a terminal and refresh.',
      'page.unavailableHint': 'gh was not found. Install the GitHub CLI and sign in with `gh auth login`.',
      'section.review': 'Waiting for your review',
      'section.rereview': 'Re-review needed',
      'section.merge': 'Ready to merge',
      'section.respond': 'Needs your action',
      'section.ci': 'CI is failing',
      'section.issues': 'Issues',
      'issues.newHeading': 'New in your repositories',
      'reason.review-requested': 'you were requested as a reviewer',
      'reason.team-review-requested': 'team {team} is waiting for a review',
      'reason.changes-after-my-review': 'new commits since your review',
      'reason.author-replied': 'the author replied to you after your review',
      'reason.re-review-requested': 'the author re-requested your review',
      'reason.ready-to-merge': 'approved and ready to merge',
      'reason.approved-checks-failing': 'approved, but CI is red',
      'reason.changes-requested': 'changes requested',
      'reason.conflict': 'merge conflict with the base branch',
      'reason.review-feedback': 'reviewer comments — fixes expected',
      'reason.mentioned': 'you were mentioned',
      'reason.checks-failing': 'checks are failing',
      'reason.branch-checks-failing': 'red branch',
      'reason.assigned-to-you': 'assigned to you',
      'reason.new-unassigned': 'new unassigned issue',
      'checks.success': 'CI green',
      'checks.failure': 'CI failed',
      'checks.pending': 'CI running',
      'review.approved': 'Approved',
      'review.changes-requested': 'Changes',
      'review.required': 'Review',
      'meta.draft': 'Draft',
      'meta.conflict': 'Conflict',
      'meta.branch': 'branch',
      'branch.title': 'Checks on branch {ref}',
      'meta.approvedByOthers': 'already approved by others',
      'time.now': 'just now',
      'time.minutes': '{n}m',
      'time.hours': '{n}h',
      'time.days': '{n}d',
      'page.settings': 'Settings',
      'page.back': 'Back',
      'page.refreshHint': 'Ask GitHub for a fresh state, bypassing the cache',
      'page.orgAuto': 'Sources detected automatically: {list}',
      'page.orgAutoAction': 'Configure',
      'settings.title': 'Settings',
      'settings.subtitle': 'Organization, refresh cadence, section rules, and terminal agents.',
      'settings.githubTitle': 'GitHub',
      'settings.githubChecking': 'Checking the connection…',
      'settings.githubConnected': 'Connected as @{login}',
      'settings.githubNotLoggedIn': 'Not signed in to GitHub',
      'settings.githubGhMissing': 'GitHub CLI (gh) is not installed',
      'settings.githubInstall': 'Install: {command} — or download from {url}',
      'settings.githubLogin': 'Sign in to GitHub',
      'settings.githubOpening': 'Opening GitHub sign-in…',
      'settings.githubWaiting': 'Finish signing in in the browser or terminal, then press "Check connection".',
      'settings.githubLoginFailed': 'Could not start sign-in: {message}',
      'settings.githubAuthError': 'Could not check authorization: {message}',
      'settings.githubCheck': 'Check connection',
      'settings.orgs': 'Organizations',
      'settings.orgsPlaceholder': 'my-org, another-org',
      'settings.orgsHint': 'Comma-separated, up to 10; empty auto-detects up to 10 organizations for the account.',
      'settings.sourcesEffective': 'Connected: {list}',
      'settings.refresh': 'Auto-refresh',
      'settings.refreshHint': 'How often the page polls the snapshot. The Refresh button in the header always asks GitHub for fresh data.',
      'settings.green': 'Only green CI in "Ready to merge"',
      'settings.greenHint': 'Turn off when a repository allows merging with red checks.',
      'settings.bots': 'Count bot reviews as mine',
      'settings.botsHint': 'For example when your review agent runs under a separate bot account.',
      'settings.save': 'Save',
      'settings.cancel': 'Cancel',
      'settings.saving': 'Saving…',
      'settings.saved': 'Settings saved — applying and refreshing data…',
      'settings.error': 'Could not save settings',
      'settings.saveErrorTitle': 'The last settings save was not applied',
      'settings.saveErrorDetail': '{message}. Open Settings and save again.',
      'settings.invalidAgents': 'Check the agents: id uses latin letters/digits, label is set, and the command has exactly one {prompt} — as its own unquoted word or after --flag=, following the program name, with no ; | & > < ( ), # comments, or $( ), ${ }, backtick substitutions.',
      'settings.applying': 'The host accepted the settings and is restarting — checking that they were saved…',
      'settings.discardTitle': 'Discard unsaved changes?',
      'settings.discard': 'Discard',
      'settings.keepEditing': 'Keep editing',
      'settings.agentsUnusable': 'Saved agents that cannot be launched: {n}',
      'settings.agentsUnusableHint': 'The command needs exactly one {prompt}, as its own unquoted word or after --flag=. They are marked below: fix the command or remove the agent, then save.',
      'settings.agentUnusableRow': 'This command cannot be launched: fix it or remove the agent.',
      'settings.agentInvalidRow': 'Check this agent\'s name and command.',
      'settings.invalidAgent': 'Check the agent “{agent}”: it needs a name and a command.',
      'settings.invalidAgentCommand': 'The command of agent “{agent}” is not accepted: it needs exactly one {prompt}, as its own unquoted word or after --flag=, following the program name, with no ; | & > < ( ), # comments, or substitutions.',
      'settings.invalidScenarioAgent': 'Scenario “{scenario}” is pinned to an unknown agent “{agent}” — choose another agent.',
      'settings.scenarioAgentUnknown': 'Unknown agent ({agent})',
      'settings.unavailable': 'This profile cannot save settings from the panel — edit the plugin row config in cordis.patch.yml.',
      'settings.applyHint': 'Changes usually apply without restarting the plugin; the panel refreshes itself.',
      'settings.minutes': '{n} min',
      'settings.hours': '{n} h',
      'settings.minuteUnit': 'min',
      'settings.custom': 'Custom…',
      'settings.invalidRefresh': 'Auto-refresh must be between 15 and 3600 seconds.',
      'settings.done': 'Done',
      'settings.auto': 'auto',
      'settings.personal': 'Personal repositories',
      'settings.personalHint': 'Show your personal repositories as a separate source.',
      'source.personal': 'personal',
      'filter.allSources': 'All sources',
      'settings.loading': 'Reading settings…',
      'launch.title': 'Open in terminal',
      'launch.openWith': 'Open with agent',
      'launch.default': 'default',
      'launch.notInstalled': 'not installed',
      'launch.agentShellAlias': 'shell alias or function — use a path',
      'launch.agentNotExecutable': 'not executable',
      'launch.opening': 'Opening…',
      'launch.failed': 'Could not open the terminal',
      'launch.cloneMissing': 'No local clone of {repo} found',
      'launch.cloneHint': 'Run the clone command, then try again.',
      'launch.copyClone': 'Copy clone command',
      'launch.copied': 'Copied',
      'launch.configure': 'Configure',
      'launch.agentMissing': 'Agent "{agent}" was not found on PATH',
      'launch.noAgents': 'No agents are configured',
      'launch.settingsHint': 'Agents, launch scenarios, and clone directories live in Settings.',
      'launch.retry': 'Retry',
      'settings.terminal': 'Terminal and agents',
      'settings.terminalHint': 'The terminal button on each row starts an agent in the local clone of the repository with a prepared initial prompt.',
      'settings.defaultAgent': 'Default agent',
      'settings.agentsHint': 'The name is shown in menus; each agent keeps an internal id automatically. Launch command; {prompt} is replaced with the initial prompt. The binary is resolved through the interactive login-shell PATH. Use {prompt} exactly once: as its own unquoted word (claude {prompt}) or after --flag= (aider --message={prompt}).',
      'settings.agentName': 'Label',
      'settings.agentCommand': 'Command',
      'settings.agentAdd': 'Add agent',
      'settings.agentFind': 'Find agents',
      'settings.agentFinding': 'Scanning…',
      'settings.agentFound': 'Agents added: {n}. Remember to save.',
      'settings.agentFindNone': 'No new agents found',
      'settings.agentFindFailed': 'Could not scan the machine: {message}',
      'settings.agentRemove': 'Remove agent',
      'settings.advanced': 'Advanced: clone search',
      'settings.advancedHint': 'Only needed when the terminal cannot find a clone automatically. The plugin searches for clones by itself by default.',
      'settings.cloneDirs': 'Folders to search for clones',
      'settings.cloneDirsHint': 'The plugin checks immediate subfolders for .git. One path per line; empty auto-detects project roots in your home, then falls back to: {list}.',
      'settings.cloneDirsPlaceholder': '~/Projects',
      'settings.repoPaths': 'Exact paths for individual repositories',
      'settings.repoPathsHint': 'Exceptions only: use when a clone lives elsewhere or has a different name. One "owner/repo = /absolute/path" per line; wins over folder search.',
      'settings.repoPathsPlaceholder': 'owner/repo = ~/Projects/repo',
      'settings.invalidRepoPaths': 'Line {line}: enter a repository and path separated by "=" (owner/repo = /path).',
      'settings.scan': 'Check clones',
      'settings.pickFolder': 'Choose folder…',
      'settings.pickClone': 'Choose clone…',
      'settings.picking': 'Choosing…',
      'settings.pickFailed': 'Could not open the system folder picker.',
      'settings.scanning': 'Scanning…',
      'settings.scanResult': 'Clones found: {n}',
      'settings.scanEmpty': 'No clones found',
      'settings.scanFailed': 'Could not scan the directories',
      'settings.terminalNote': 'Launches share one Triage Desk window and open as tabs. macOS: an iTerm2 tab when installed, otherwise a new Terminal.app window; Windows: Windows Terminal (new tab) or PowerShell; Linux: the terminal from $TERMINAL (a tab where supported). Re-launching the same agent on the same item focuses its tab where the terminal supports it. After the agent exits, the window stays open with a shell.',
      'launch.draft': '{agent} opened in {terminal} ({cwd}): the prompt is in its input box, not sent — review it and press Enter',
      'launch.paste': '{agent} opened in {terminal} ({cwd}): the prompt will appear in its input box, not sent — review it and press Enter',
      'launch.clipboard': '{agent} opened in {terminal} ({cwd}): the prompt is on your clipboard — paste it with {keys}, then send',
      'launch.pasteBlocked.python-missing': ' · install Python 3 to have prompts typed in',
      'launch.pasteBlocked.python-clt': ' · run xcode-select --install to have prompts typed in',
      'launch.pasteBlocked.windows-old': ' · typing prompts in needs Windows 10 1809 or later',
      'launch.pinBlocked.not-rooted': ' · the detected path has no drive letter, so the command ran as written',
      'launch.pinBlocked.unsafe-path': ' · the detected path has a character agent commands cannot carry, so the command ran as written',
      'launch.pinBlocked.command-form': ' · the command starts with VAR=value, so it ran as written instead of the detected path',
      'launch.terminalFallback': ' · the chosen terminal is not installed',
      'launch.via.draft': 'Opens in {terminal} · prompt in the input box, unsent',
      'launch.via.paste': 'Opens in {terminal} · prompt typed into the input box, unsent',
      'launch.via.clipboard': 'Opens in {terminal} · prompt copied to the clipboard ({keys})',
      'settings.terminalApp': 'Open agents in',
      'settings.terminalAuto': 'Automatic — {app}',
      'settings.terminalAutoNone': 'Automatic',
      'settings.terminalMissing': '{app} (not installed)',
      'settings.terminalTabs': 'Each launch opens a tab in the current {app} window; launching the same agent on the same item again switches to its tab.',
      'settings.terminalWindows': 'Each launch opens a new {app} window.',
      'settings.promptDelivery': 'Prompt delivery',
      'settings.promptDeliveryHint': 'For agents without a native draft. Claude Code opens with the prompt as its own draft (on Windows only as an .exe; an npm .cmd install gets the prompt this way).',
      'settings.deliveryPaste': 'Type into the agent',
      'settings.deliveryPasteHint': 'The prompt appears in the agent\'s input box, unsent. Review it, then press Enter.',
      'settings.deliveryRecommended': 'Recommended',
      'settings.deliveryClipboard': 'Copy to clipboard',
      'settings.deliveryClipboardHint': 'The agent opens empty; paste the prompt yourself with {keys}.',
      'settings.pasteUnavailable.python-missing': 'Needs Python 3 on this computer; until then prompts go to the clipboard.',
      'settings.pasteUnavailable.python-clt': 'Needs Python 3 from the Command Line Tools: run xcode-select --install. Until then prompts go to the clipboard.',
      'settings.pasteUnavailable.windows-old': 'Needs Windows 10 version 1809 or later; prompts go to the clipboard.',
      'launch.workspaceFallback': ' · no clone found, opened the workspace',
      'launch.scenarios': 'Scenarios',
      'launch.agent': 'Agent',
      'launch.dshTarget': 'DSH — this app',
      'launch.dshDraft': 'New DSH session opened: the prompt is in the input box and has not been sent — review it and press Enter',
      'launch.dshFailed': 'Could not open a DSH session',
      'launch.dshHostOutdated': 'The plugin host is still an older version: turn the plugin off and on, then refresh the page',
      'launch.sectionScenarios': 'Section scenarios',
      'launch.sectionTitle': 'Open a scenario for this section',
      'launch.trimmed': ' · prompt trimmed: {shown} of {total}',
      'launch.countSuffix': ' · {n} items',
      'scenario.link.name': 'Just the link',
      'scenario.review-pr.name': 'Review this PR',
      'scenario.rereview-pr.name': 'Re-review after changes',
      'scenario.fix-pr.name': 'Fix this PR',
      'scenario.reply-thread.name': 'Reply in the thread',
      'scenario.triage-issue.name': 'Triage this issue',
      'scenario.review-all.name': 'Review everything awaiting me',
      'scenario.fix-mine.name': 'Fix my PRs',
      'scenario.triage-new.name': 'Triage new issues',
      'scenario.reply-mentions.name': 'Answer mentions',
      'settings.scenarios': 'Launch scenarios',
      'settings.scenariosHint': 'Named prompt templates for launching an agent from a row or a whole section. Tokens are filled from the row data. Click a scenario to edit it.',
      'settings.scenarioAdd': 'Add scenario',
      'settings.scenarioRemove': 'Remove scenario',
      'settings.scenarioUp': 'Move up',
      'settings.scenarioDown': 'Move down',
      'settings.scenarioReset': 'Reset scenario',
      'settings.scenarioResetAll': 'Reset all scenarios',
      'settings.scenarioScope': 'Scope',
      'settings.scenarioScopeItem': 'Row',
      'settings.scenarioScopeSection': 'Section',
      'settings.scenarioSections': 'Sections',
      'settings.scenarioPrompt': 'Prompt',
      'settings.scenarioPromptHint': 'Placeholders: {url}, {repo}, {author}, {reason}, {links}, {count}, {section}, {date}. Unknown tokens stay as text.',
      'settings.scenarioAgent': 'Agent',
      'settings.scenarioAgentDefault': 'Default',
      'settings.scenarioEnabled': 'Enabled',
      'settings.scenarioProtected': '"Just the link" cannot be removed or disabled and must contain {url}.',
      'settings.scenarioPreview': 'Prompt preview',
      'settings.scenarioDefault': 'Default scenario',
      'settings.invalidScenarios': 'Check the scenarios: ids, labels, sections, prompts, and agents.',
    }

    const ZH = {
      'panel.label': '分诊',
      'page.title': '分诊',
      'page.subtitle': 'GitHub 分诊',
      'page.sources': '来源：{list}',
      'page.updated': '更新于 {time}',
      'page.updatedAgo': '{age}前',
      'page.never': '尚未加载',
      'page.refresh': '刷新数据',
      'page.search': '搜索 PR、仓库或作者',
      'page.searchClear': '清除搜索',
      'page.filterAll': '全部',
      'page.footer': '数据来自通过 gh CLI 访问的 GitHub · 每 {sec} 秒自动刷新',
      'page.footerRate': ' · 剩余 API 调用：{n}',
      'page.loading': '正在读取 GitHub 状态…',
      'page.error': '无法从 GitHub 读取数据',
      'page.retry': '重试',
      'page.empty': '没有需要你关注的事项',
      'page.emptyHint': '可以关闭面板，继续工作。',
      'page.filtered': '此筛选下没有内容',
      'page.filteredHint': '试试其他分类，或清除搜索。',
      'page.reset': '清除筛选',
      'page.copy': '复制链接',
      'page.copied': '链接已复制',
      'snooze.locale': 'zh-CN',
      'snooze.button': '延后',
      'snooze.menu': '延后',
      'snooze.activity': '直到有新动态',
      'snooze.activityHint': '有变化时重新出现',
      'snooze.tomorrowOption': '延后到明天',
      'snooze.nextWeekOption': '延后到下周',
      'snooze.note': '有新动态时会提前重新出现。',
      'snooze.today': '今天 {time}',
      'snooze.tomorrow': '明天 {time}',
      'snooze.on': '{day} {time}',
      'snooze.toastActivity': '已延后，直到有新动态',
      'snooze.toastUntil': '已延后至 {when}',
      'snooze.undo': '撤销',
      'snooze.unsnooze': '取消延后',
      'snooze.chip': '已延后',
      'snooze.returnsActivity': '有新动态时重新出现',
      'snooze.returnsAt': '将于 {when} 重新出现',
      'snooze.menuMany': '延后 {n} 项',
      'snooze.section': '全部延后（{n}）',
      'snooze.unsnoozeAll': '全部取消延后（{n}）',
      'snooze.toastManyActivity': '已延后 {n} 项，直到有新动态',
      'snooze.toastManyUntil': '已延后 {n} 项至 {when}',
      'snooze.toastUnsnoozed': '已取消延后',
      'snooze.toastUnsnoozedMany': '已取消延后 {n} 项',
      'select.row': '选择“{title}”',
      'select.count': '已选 {n} 项',
      'select.enter': '选择',
      'select.done': '完成',
      'select.hint': '选择要延后的项',
      'select.hintUnsnooze': '选择要取消延后的项',
      'select.all': '全选',
      'select.none': '取消全选',
      'select.section': '选择“{section}”中的全部',
      'select.bar': '所选项操作',
      'page.copyFailed': '复制失败——请检查剪贴板权限',
      'page.collapse': '收起分类',
      'page.expand': '展开分类',
      'page.stale': '显示的是 {time} 的快照：上次刷新失败。',
      'page.partial': '部分数据不可用',
      'page.unauthHint': 'gh 似乎未登录。请在终端运行 `gh auth login` 后刷新。',
      'page.unavailableHint': '未找到 gh。请安装 GitHub CLI 并运行 `gh auth login` 登录。',
      'section.review': '等待你审核',
      'section.rereview': '需要重新审核',
      'section.merge': '可以合并',
      'section.respond': '需要你处理',
      'section.ci': 'CI 失败',
      'section.issues': '议题',
      'issues.newHeading': '你仓库中的新议题',
      'reason.review-requested': '有人请求你审核',
      'reason.team-review-requested': '团队 {team} 正在等待审核',
      'reason.changes-after-my-review': '你审核后有新提交',
      'reason.author-replied': '作者回复了你',
      'reason.re-review-requested': '作者再次请求你审核',
      'reason.ready-to-merge': '已批准，可以合并',
      'reason.approved-checks-failing': '已批准，但 CI 失败',
      'reason.changes-requested': '有人要求修改',
      'reason.conflict': '与目标分支存在合并冲突',
      'reason.review-feedback': '审核意见 — 需要修改',
      'reason.mentioned': '有人提到了你',
      'reason.checks-failing': '检查失败',
      'reason.branch-checks-failing': '分支检查失败',
      'reason.assigned-to-you': '分配给你',
      'reason.new-unassigned': '新的未分配议题',
      'checks.success': 'CI 通过',
      'checks.failure': 'CI 失败',
      'checks.pending': 'CI 进行中',
      'review.approved': '已批准',
      'review.changes-requested': '待修改',
      'review.required': '待审核',
      'meta.draft': '草稿',
      'meta.conflict': '冲突',
      'meta.branch': '分支',
      'branch.title': '分支 {ref} 的检查',
      'meta.approvedByOthers': '已被他人批准',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟',
      'time.hours': '{n} 小时',
      'time.days': '{n} 天',
      'page.settings': '设置',
      'page.back': '返回',
      'page.refreshHint': '向 GitHub 请求最新状态（绕过缓存）',
      'page.orgAuto': '已自动检测到来源：{list}',
      'page.orgAutoAction': '配置',
      'settings.title': '设置',
      'settings.subtitle': '组织、刷新频率、分类规则与终端智能体。',
      'settings.githubTitle': 'GitHub',
      'settings.githubChecking': '正在检查连接…',
      'settings.githubConnected': '已连接为 @{login}',
      'settings.githubNotLoggedIn': '尚未登录 GitHub',
      'settings.githubGhMissing': '未安装 GitHub CLI（gh）',
      'settings.githubInstall': '安装：{command} — 或从 {url} 下载',
      'settings.githubLogin': '登录 GitHub',
      'settings.githubOpening': '正在打开 GitHub 登录…',
      'settings.githubWaiting': '请在浏览器或终端中完成登录，然后点击“检查连接”。',
      'settings.githubLoginFailed': '无法开始登录：{message}',
      'settings.githubAuthError': '无法检查授权：{message}',
      'settings.githubCheck': '检查连接',
      'settings.orgs': '组织',
      'settings.orgsPlaceholder': 'my-org, another-org',
      'settings.orgsHint': '以逗号分隔，最多 10 个；留空会自动检测账号所属的最多 10 个组织。',
      'settings.sourcesEffective': '已连接：{list}',
      'settings.refresh': '自动刷新',
      'settings.refreshHint': '页面轮询快照的频率。标题栏的“刷新数据”按钮始终请求 GitHub 的最新数据。',
      'settings.green': '“可以合并”中只显示 CI 通过的',
      'settings.greenHint': '如果仓库允许在检查失败时合并，请关闭此项。',
      'settings.bots': '将机器人的审核算作我的审核',
      'settings.botsHint': '例如你的审核机器人使用单独的机器人账号时。',
      'settings.save': '保存',
      'settings.cancel': '取消',
      'settings.saving': '正在保存…',
      'settings.saved': '设置已保存——正在应用并刷新数据…',
      'settings.error': '无法保存设置',
      'settings.saveErrorTitle': '上次设置未能应用',
      'settings.saveErrorDetail': '{message}。请打开设置并重新保存。',
      'settings.invalidAgents': '请检查智能体：ID 使用字母/数字，名称为必填，命令中必须恰好有一个 {prompt}——作为不带引号的独立单词或位于 --flag= 之后，且在程序名之后；不得包含 ; | & > < ( )、# 注释或 $( )、${ }、反引号替换。',
      'settings.applying': '主机已接受设置并正在重启——正在确认设置是否已保存…',
      'settings.discardTitle': '放弃未保存的更改？',
      'settings.discard': '放弃',
      'settings.keepEditing': '继续编辑',
      'settings.agentsUnusable': '无法启动的已保存智能体：{n}',
      'settings.agentsUnusableHint': '命令中必须恰好有一个 {prompt}，作为不带引号的独立单词或位于 --flag= 之后。这些智能体已在下方标出：请修正命令或删除该智能体，然后保存。',
      'settings.agentUnusableRow': '此命令无法启动：请修正或删除该智能体。',
      'settings.agentInvalidRow': '请检查此智能体的名称和命令。',
      'settings.invalidAgent': '请检查智能体“{agent}”：名称和命令均为必填。',
      'settings.invalidAgentCommand': '智能体“{agent}”的命令不被接受：必须恰好有一个 {prompt}，作为不带引号的独立单词或位于 --flag= 之后，且在程序名之后；不得包含 ; | & > < ( )、# 注释或替换。',
      'settings.invalidScenarioAgent': '场景“{scenario}”绑定了未知智能体“{agent}”——请选择其他智能体。',
      'settings.scenarioAgentUnknown': '未知智能体（{agent}）',
      'settings.unavailable': '此配置无法从面板保存设置——请编辑 cordis.patch.yml 中该插件的配置。',
      'settings.applyHint': '修改通常无需重启插件即可生效；面板会自动刷新。',
      'settings.minutes': '{n} 分钟',
      'settings.hours': '{n} 小时',
      'settings.minuteUnit': '分钟',
      'settings.custom': '自定义…',
      'settings.invalidRefresh': '自动刷新间隔必须在 15 到 3600 秒之间。',
      'settings.done': '完成',
      'settings.auto': '自动',
      'settings.personal': '个人仓库',
      'settings.personalHint': '将个人仓库作为单独来源显示。',
      'source.personal': '个人',
      'filter.allSources': '所有来源',
      'settings.loading': '正在读取设置…',
      'launch.title': '在终端中打开',
      'launch.openWith': '用智能体打开',
      'launch.default': '默认',
      'launch.notInstalled': '未安装',
      'launch.agentShellAlias': 'shell 别名或函数——请使用路径',
      'launch.agentNotExecutable': '不可执行',
      'launch.opening': '正在打开…',
      'launch.failed': '无法打开终端',
      'launch.cloneMissing': '未找到 {repo} 的本地克隆',
      'launch.cloneHint': '运行克隆命令后重试。',
      'launch.copyClone': '复制克隆命令',
      'launch.copied': '已复制',
      'launch.configure': '配置',
      'launch.agentMissing': 'PATH 中未找到智能体“{agent}”',
      'launch.noAgents': '尚未配置智能体',
      'launch.settingsHint': '智能体、启动场景与克隆目录在「设置」中配置。',
      'launch.retry': '重试',
      'settings.terminal': '终端与智能体',
      'settings.terminalHint': '每行的终端按钮会在仓库的本地克隆中启动智能体，并带好初始提示。',
      'settings.defaultAgent': '默认智能体',
      'settings.agentsHint': '名称会显示在菜单中；内部 ID 自动保留。启动命令；{prompt} 会替换为初始提示。程序通过交互式登录 shell 的 PATH 查找。请仅使用一次 {prompt}：作为不带引号的独立单词（claude {prompt}）或位于 --flag= 之后（aider --message={prompt}）。',
      'settings.agentName': '名称',
      'settings.agentCommand': '命令',
      'settings.agentAdd': '添加智能体',
      'settings.agentFind': '查找智能体',
      'settings.agentFinding': '正在扫描…',
      'settings.agentFound': '已添加智能体：{n}。请记得保存。',
      'settings.agentFindNone': '未找到新的智能体',
      'settings.agentFindFailed': '无法扫描本机：{message}',
      'settings.agentRemove': '删除智能体',
      'settings.advanced': '高级：克隆搜索',
      'settings.advancedHint': '仅当终端无法自动找到克隆时需要。默认情况下插件会自行搜索克隆。',
      'settings.cloneDirs': '搜索克隆的文件夹',
      'settings.cloneDirsHint': '插件会检查直接子文件夹中的 .git。每行一个路径；留空会自动发现主目录中的项目根目录，然后使用默认目录：{list}。',
      'settings.cloneDirsPlaceholder': '~/Projects',
      'settings.repoPaths': '单个仓库的精确路径',
      'settings.repoPathsHint': '仅用于例外：当克隆在其他位置或目录名不同。每行 owner/repo = /绝对/路径；优先于文件夹搜索。',
      'settings.repoPathsPlaceholder': 'owner/repo = ~/Projects/repo',
      'settings.invalidRepoPaths': '第 {line} 行：请输入用“=”分隔的仓库和路径（owner/repo = /路径）。',
      'settings.scan': '检查克隆',
      'settings.pickFolder': '选择文件夹…',
      'settings.pickClone': '选择克隆…',
      'settings.picking': '选择中…',
      'settings.pickFailed': '无法打开系统文件夹选择器。',
      'settings.scanning': '正在扫描…',
      'settings.scanResult': '找到克隆：{n}',
      'settings.scanEmpty': '未找到克隆',
      'settings.scanFailed': '无法扫描目录',
      'settings.terminalNote': '启动会共用一个 Triage Desk 窗口并以标签页打开。macOS：已安装 iTerm2 时使用其标签页，否则打开新的 Terminal.app 窗口；Windows：Windows Terminal（新标签页）或 PowerShell；Linux：$TERMINAL 指定的终端（支持时使用新标签页）。对同一条目重新启动同一智能体会在终端支持时聚焦其标签页。智能体退出后窗口保留，并停在 shell。',
      'launch.draft': '已在 {terminal} 中打开 {agent}（{cwd}）：提示已填入输入框，尚未发送——检查后按 Enter',
      'launch.paste': '已在 {terminal} 中打开 {agent}（{cwd}）：提示将出现在输入框中，尚未发送——检查后按 Enter',
      'launch.clipboard': '已在 {terminal} 中打开 {agent}（{cwd}）：提示已复制到剪贴板——按 {keys} 粘贴后发送',
      'launch.pasteBlocked.python-missing': ' · 安装 Python 3 后即可自动填入提示',
      'launch.pasteBlocked.python-clt': ' · 运行 xcode-select --install 后即可自动填入提示',
      'launch.pasteBlocked.windows-old': ' · 自动填入提示需要 Windows 10 1809 或更高版本',
      'launch.pinBlocked.not-rooted': ' · 检测到的路径没有盘符，已按原命令运行',
      'launch.pinBlocked.unsafe-path': ' · 检测到的路径含有代理命令不允许的字符，已按原命令运行',
      'launch.pinBlocked.command-form': ' · 命令以 VAR=value 开头，已按原命令运行，未使用检测到的路径',
      'launch.terminalFallback': ' · 所选终端未安装',
      'launch.via.draft': '在 {terminal} 中打开 · 提示在输入框中，尚未发送',
      'launch.via.paste': '在 {terminal} 中打开 · 提示自动填入输入框，尚未发送',
      'launch.via.clipboard': '在 {terminal} 中打开 · 提示复制到剪贴板（{keys}）',
      'settings.terminalApp': '智能体打开位置',
      'settings.terminalAuto': '自动——{app}',
      'settings.terminalAutoNone': '自动',
      'settings.terminalMissing': '{app}（未安装）',
      'settings.terminalTabs': '每次启动都会在当前 {app} 窗口中打开一个标签页；在同一条目上再次启动同一智能体会切换到它的标签页。',
      'settings.terminalWindows': '每次启动都会打开一个新的 {app} 窗口。',
      'settings.promptDelivery': '提示传递方式',
      'settings.promptDeliveryHint': '适用于没有原生草稿功能的智能体。Claude Code 以自己的草稿方式打开提示（在 Windows 上仅限 .exe；通过 npm 安装的 .cmd 也按此方式接收提示）。',
      'settings.deliveryPaste': '填入智能体',
      'settings.deliveryPasteHint': '提示会出现在智能体的输入框中，尚未发送。检查后按 Enter。',
      'settings.deliveryRecommended': '推荐',
      'settings.deliveryClipboard': '复制到剪贴板',
      'settings.deliveryClipboardHint': '智能体以空白状态打开；请自行按 {keys} 粘贴提示。',
      'settings.pasteUnavailable.python-missing': '需要本机安装 Python 3；在此之前提示会复制到剪贴板。',
      'settings.pasteUnavailable.python-clt': '需要命令行工具中的 Python 3：请运行 xcode-select --install。在此之前提示会复制到剪贴板。',
      'settings.pasteUnavailable.windows-old': '需要 Windows 10 1809 或更高版本；提示会复制到剪贴板。',
      'launch.workspaceFallback': ' · 未找到克隆，已在工作区打开',
      'launch.scenarios': '场景',
      'launch.agent': '智能体',
      'launch.dshTarget': 'DSH — 本应用',
      'launch.dshDraft': '已打开新的 DSH 会话：提示已填入输入框，尚未发送——检查后按 Enter',
      'launch.dshFailed': '无法打开 DSH 会话',
      'launch.dshHostOutdated': '插件主机仍是旧版本：请关闭再启用插件，然后刷新页面',
      'launch.sectionScenarios': '分类场景',
      'launch.sectionTitle': '为此分类打开场景',
      'launch.trimmed': ' · 提示已截断：{shown}/{total}',
      'launch.countSuffix': ' · {n} 项',
      'scenario.link.name': '仅链接',
      'scenario.review-pr.name': '审查此 PR',
      'scenario.rereview-pr.name': '复查更改',
      'scenario.fix-pr.name': '修复此 PR',
      'scenario.reply-thread.name': '回复讨论串',
      'scenario.triage-issue.name': '梳理 Issue',
      'scenario.review-all.name': '审查所有待我处理的 PR',
      'scenario.fix-mine.name': '修复我的 PR',
      'scenario.triage-new.name': '梳理新任务',
      'scenario.reply-mentions.name': '回复提及',
      'settings.scenarios': '启动场景',
      'settings.scenariosHint': '用于从单行或整个分类启动智能体的命名提示模板。占位符会由行数据填充。点击场景即可编辑。',
      'settings.scenarioAdd': '添加场景',
      'settings.scenarioRemove': '删除场景',
      'settings.scenarioUp': '上移',
      'settings.scenarioDown': '下移',
      'settings.scenarioReset': '重置场景',
      'settings.scenarioResetAll': '重置所有场景',
      'settings.scenarioScope': '范围',
      'settings.scenarioScopeItem': '单行',
      'settings.scenarioScopeSection': '分类',
      'settings.scenarioSections': '分类',
      'settings.scenarioPrompt': '提示',
      'settings.scenarioPromptHint': '占位符：{url}、{repo}、{author}、{reason}、{links}、{count}、{section}、{date}。未知标记保持原样。',
      'settings.scenarioAgent': '智能体',
      'settings.scenarioAgentDefault': '默认',
      'settings.scenarioEnabled': '启用',
      'settings.scenarioProtected': '“仅链接”不可删除或禁用，且必须包含 {url}。',
      'settings.scenarioPreview': '提示预览',
      'settings.scenarioDefault': '默认场景',
      'settings.invalidScenarios': '请检查场景：ID、名称、分类、提示和智能体。',
    }

    /* ---------------------------------------------------------------- styles */

    const CSS = `
      .adx-root {
        --adx-bg: var(--dsw-alias-bg-base);
        --adx-ink: var(--dsw-alias-label-primary);
        --adx-ink-2: var(--dsw-alias-label-secondary);
        --adx-ink-3: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        --adx-ink-4: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));
        --adx-hairline: var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));
        --adx-hairline-soft: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
        --adx-module: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2));
        --adx-hover: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
        --adx-active: var(--dsw-alias-interactive-bg-active, var(--adx-hover));
        --adx-skeleton: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2));
        --adx-info: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        --adx-ok: var(--dsw-alias-state-success-primary);
        --adx-warn: var(--dsw-alias-state-warn-primary);
        --adx-err: var(--dsw-alias-state-error-primary);
        --adx-idle: var(--dsw-alias-state-idle-primary);
        --adx-ring: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        --adx-ring-w: var(--dsw-focus-ring-width, 2px);

        box-sizing: border-box;
        position: relative;
        display: flex; flex-direction: column;
        height: 100%; min-height: 0; overflow: hidden;
        background: var(--adx-bg); color: var(--adx-ink);
        font-size: 14px; line-height: 1.6;
      }
      .adx-root *, .adx-root *::before, .adx-root *::after { box-sizing: border-box; }
      .adx-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
      .adx-col { max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }

      .adx-head {
        position: sticky; top: 0; z-index: 2;
        display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
        gap: 16px; padding: 28px 0 12px;
        background: var(--adx-bg);
        border-bottom: 0.5px solid transparent;
        transition: border-color 140ms ease;
      }
      .adx-head[data-stuck='true'] { border-bottom-color: var(--adx-hairline-soft); }
      html[data-platform='darwin'] .adx-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
      .adx-heading { min-width: 0; max-width: 100%; }
      .adx-title-row { display: flex; align-items: center; gap: 10px; }
      .adx-title-row h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
      .adx-total {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 20px; height: 20px; padding: 0 6px;
        border-radius: 999px; corner-shape: round;
        background: var(--adx-module); color: var(--adx-ink-2);
        font-size: 12px; line-height: 18px; font-weight: 500; font-variant-numeric: tabular-nums;
      }
      .adx-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
                 margin: 4px 0 0; color: var(--adx-ink-2); font-size: 13px; line-height: 20px;
                 font-variant-numeric: tabular-nums; }
      .adx-sub-sep { opacity: 0.55; }
      .adx-toolbar { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center;
                     justify-content: flex-end; gap: 8px; }

      .adx-btn {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; height: 32px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-md, 12px);
        background: transparent; color: var(--adx-ink); font: inherit; font-size: 13px; line-height: 20px;
        cursor: pointer; transition: background 110ms ease;
      }
      .adx-btn--outline { box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--adx-hairline); }
      .adx-btn--primary {
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
        color: var(--dsw-alias-label-primary-foreground);
      }
      @media (hover: hover) { .adx-btn--primary:hover:not(:disabled) {
        background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); } }
      @media (hover: hover) { .adx-btn:hover:not(:disabled) { background: var(--adx-hover); } }
      .adx-btn:active:not(:disabled) { background: var(--adx-active); }
      .adx-btn:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .adx-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: var(--adx-ink-4); cursor: pointer;
        transition: background 110ms ease, color 110ms ease;
      }
      @media (hover: hover) { .adx-icon-btn:hover:not(:disabled) { background: var(--adx-hover); color: var(--adx-ink-2); } }
      .adx-icon-btn:active:not(:disabled) { background: var(--adx-active); }
      .adx-icon-btn:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-icon-btn:disabled { opacity: 0.5; cursor: default; }
      .adx-icon-btn[data-spinning] svg { animation: adx-spin 900ms linear infinite; }
      @keyframes adx-spin { to { transform: rotate(360deg); } }

      .adx-filters { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px 12px; margin: 4px 0 14px; overflow-x: auto; scrollbar-width: none; }
      .adx-filters::-webkit-scrollbar { display: none; }
      .adx-filters--sources { margin-top: -8px; }
      .adx-filters--sources .adx-chip { height: 24px; font-size: 12px; line-height: 18px; color: var(--adx-ink-4); }
      .adx-meta-source {
        color: var(--adx-ink-2); font-size: 11px; font-weight: 500;
        padding: 0 6px; border-radius: 999px; background: var(--adx-module);
      }
      .adx-chip {
        display: inline-flex; flex: none; align-items: center; gap: 6px;
        height: 28px; padding: 0 10px; border: 0; border-radius: 14px;
        background: transparent; color: var(--adx-ink-3);
        font: inherit; font-size: 14px; line-height: 22px; white-space: nowrap; cursor: pointer;
      }
      .adx-chip[aria-pressed='true'] { background: var(--adx-hover); color: var(--adx-ink); }
      @media (hover: hover) { .adx-chip:hover { background: var(--adx-hover); } }
      .adx-chip:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-chip-count { font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; color: var(--adx-ink-4); }
      .adx-chip[aria-pressed='true'] .adx-chip-count { color: var(--adx-ink-2); }
      .adx-chip[data-zero='true'] { color: var(--adx-ink-4); }
      .adx-chip--snoozed { gap: 5px; color: var(--adx-ink-4); }
      .adx-chip--snoozed svg { flex: none; }

      .adx-search {
        display: flex; align-items: center; gap: 8px; height: 36px; margin: 0 0 20px; padding: 0 10px;
        border: 1px solid var(--adx-hairline-soft); border-radius: 12px; color: var(--adx-ink-3);
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      @media (hover: hover) { .adx-search:hover { border-color: var(--adx-hairline-soft); } }
      .adx-search:focus-within {
        border-color: var(--adx-info);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--adx-info) 25%, transparent);
      }
      .adx-search > svg { flex: none; width: 14px; height: 14px; }
      .adx-search input {
        flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent;
        outline: none; font: inherit; font-size: 14px; line-height: 22px; color: var(--adx-ink);
      }
      .adx-search input::placeholder { color: var(--adx-ink-4); }
      .adx-search input:focus-visible { outline: none; }
      .adx-search input::-webkit-search-cancel-button { display: none; }
      .adx-search-clear { flex: none; margin-right: -6px; }
      @media (pointer: coarse) { .adx-search input { font-size: 16px; } }

      .adx-section { display: flex; flex-direction: column; gap: 6px; margin-top: 24px; }
      .adx-section-head {
        position: relative; display: flex; align-items: center; gap: 10px;
        padding-inline-end: 8px;
      }
      .adx-section-title { flex: 0 1 auto; margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
      .adx-section-count { font-size: 12px; line-height: 18px; color: var(--adx-ink-2); font-variant-numeric: tabular-nums; }
      .adx-section-spacer { flex: 1 1 auto; }
      .adx-section-controls { display: inline-flex; flex: none; align-items: center; gap: 6px; }
      .adx-section-toggle {
        display: inline-flex; align-items: center; justify-content: center; gap: 2px;
        width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px);
        background: none; color: var(--adx-ink-4); font: inherit; cursor: pointer;
      }
      @media (hover: hover) { .adx-section-toggle:hover { color: var(--adx-ink-2); background: var(--adx-hover); } }
      .adx-section-toggle:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-section-launch { position: relative; flex: none; display: inline-flex; align-items: center; }
      .adx-section-launch .adx-launch-btn { width: 26px; height: 26px; }
      /* Mirrors .adx-row-actions (2px gap, 26px buttons): the header's snooze and
         chevron sit in the columns of a row's snooze and copy buttons. */
      .adx-section-actions { display: inline-flex; align-items: center; gap: 2px; flex: none; }
      .adx-section-actions .adx-icon-btn { width: 26px; height: 26px; }
      .adx-chevron { transition: transform 160ms ease; }
      .adx-chevron[data-collapsed='true'] { transform: rotate(-90deg); }
      @media (prefers-reduced-motion: reduce) { .adx-chevron { transition: none; } }

      .adx-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
      .adx-row { position: relative; display: flex; align-items: flex-start; gap: 12px; width: 100%;
                 padding: 8px; border-radius: 12px; }
      @media (hover: hover) { .adx-row:hover { background: var(--adx-hover); } }
      .adx-row:active { background: var(--adx-active); }
      .adx-row-glyph { flex: none; display: inline-flex; align-items: center; justify-content: center;
                       width: 16px; height: 20px; margin-top: 2px; color: var(--adx-ink-4); }
      .adx-row[data-tone='info'] .adx-row-glyph { color: var(--adx-info); }
      .adx-row[data-tone='warn'] .adx-row-glyph { color: var(--adx-warn); }
      .adx-row[data-tone='ok'] .adx-row-glyph { color: var(--adx-ok); }
      .adx-row[data-tone='err'] .adx-row-glyph { color: var(--adx-err); }
      .adx-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .adx-row-title {
        display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 14px; line-height: 22px; font-weight: 500; color: var(--adx-ink); text-decoration: none;
      }
      .adx-row-title::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }
      .adx-row-title:focus-visible { outline: none; }
      .adx-row-title:focus-visible::after {
        outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: -1px;
      }
      @media (hover: hover) { .adx-row:hover .adx-row-title { text-decoration: underline; text-underline-offset: 3px; } }
      .adx-row-meta { display: block; font-size: 13px; line-height: 21px; color: var(--adx-ink-3);
                      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .adx-row-meta > span + span::before { content: ' · '; padding: 0 2px; }
      .adx-meta-author { color: var(--adx-ink-2); }
      .adx-meta-repo { font-weight: 500; }
      .adx-meta-num { font-variant-numeric: tabular-nums; }
      .adx-row-end { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: 6px; }
      /*
       * Every row end is its own stacking context (z-index 1, above the
       * title's full-row link overlay), so later rows would paint over an open
       * menu and take its hover. The row or section header that owns the open
       * menu is lifted above its siblings instead.
       */
      .adx-row[data-menu-open='true'], .adx-section-head[data-menu-open='true'] { z-index: 20; }
      .adx-row-pills { display: inline-flex; align-items: center; gap: 6px; flex: none; }
      .adx-row-actions { display: inline-flex; align-items: center; gap: 2px; flex: none; opacity: 0; transition: opacity 110ms ease; }
      @media (hover: none) { .adx-row-actions { opacity: 1; } }
      @media (hover: hover) {
        .adx-row:hover .adx-row-actions, .adx-row:focus-within .adx-row-actions { opacity: 1; }
      }
      .adx-row-actions .adx-icon-btn { width: 26px; height: 26px; }

      .adx-pill {
        display: inline-flex; align-items: center; gap: 5px; flex: none;
        padding: 1px 8px; border-radius: 999px; corner-shape: round;
        font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
        max-width: 220px; overflow: hidden; text-overflow: ellipsis;
      }
      .adx-pill[data-tone='neutral'] { background: var(--adx-module); color: var(--adx-ink-2); }
      .adx-pill[data-tone='outline'] { box-shadow: inset 0 0 0 0.5px var(--adx-hairline); color: var(--adx-ink-3); }
      .adx-pill[data-tone='info'] { background: color-mix(in srgb, var(--adx-info) 10%, transparent); color: var(--adx-info); }
      .adx-pill[data-tone='success'] { background: color-mix(in srgb, var(--adx-ok) 10%, transparent); color: var(--adx-ok); }
      .adx-pill[data-tone='warning'] { background: color-mix(in srgb, var(--adx-warn) 12%, transparent); color: var(--adx-warn); }
      .adx-pill[data-tone='danger'] { background: color-mix(in srgb, var(--adx-err) 10%, transparent); color: var(--adx-err); }
      .adx-pill-dot { width: 5px; height: 5px; border-radius: 50%; corner-shape: round; background: currentColor; flex: none; }

      .adx-notice {
        display: flex; align-items: flex-start; flex-wrap: wrap; gap: 9px;
        margin: 0 0 18px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-specific-sidebar-fill, var(--adx-module));
        color: var(--adx-ink-2); font-size: 12px; line-height: 20px;
      }
      .adx-notice p { flex: 1 1 240px; margin: 0; }
      .adx-notice .adx-btn { margin-left: auto; }
      .adx-notice[data-tone='warning'] {
        background: color-mix(in srgb, var(--adx-warn) 8%, transparent);
        box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--adx-warn) 35%, transparent);
      }
      .adx-notice[data-tone='error'] {
        background: color-mix(in srgb, var(--adx-err) 8%, transparent);
        box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--adx-err) 32%, transparent);
      }
      .adx-notice strong { display: block; font-weight: 500; color: var(--adx-ink); }
      .adx-notice-detail { display: block; color: var(--adx-ink-3); font-size: 11.5px; overflow-wrap: anywhere; }
      .adx-agents-unusable { margin: 0; }
      .adx-agent-row[data-invalid='true'] .adx-agent-command {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--adx-warn) 60%, transparent);
      }
      .adx-agent-invalid-note { margin: -4px 0 0; color: var(--adx-warn); font-size: 11.5px; line-height: 16px; }

      .adx-leave-confirm {
        flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
        padding: 10px 14px; border-radius: 10px;
        background: color-mix(in srgb, var(--adx-warn) 8%, transparent);
        box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--adx-warn) 35%, transparent);
        color: var(--adx-ink); font-size: 13px; line-height: 20px;
      }
      .adx-leave-confirm-text { flex: 1 1 200px; }

      .adx-empty { display: flex; align-items: center; flex-direction: column; padding: 48px 20px; text-align: center;
                   color: var(--adx-ink-3); font-size: 14px; }
      .adx-empty-glyph { display: inline-flex; margin-bottom: 12px; color: var(--adx-ink-4); }
      .adx-empty-title { margin: 0 0 8px; font-size: 14px; line-height: 1.6; font-weight: 400; color: var(--adx-ink-3); }
      .adx-empty p { margin: 0; }
      .adx-empty-action { margin-top: 16px; }

      .adx-skeleton { display: flex; flex-direction: column; gap: 10px; padding-top: 8px; }
      .adx-skeleton-row { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
      .adx-skeleton-bar { height: 12px; border-radius: var(--dsw-radius-xs, 4px); background: var(--adx-skeleton);
                          animation: adx-skeleton 2s cubic-bezier(0.36, 0, 0.64, 1) infinite; }
      .adx-skeleton-bar[data-width='short'] { width: min(240px, 50%); }
      .adx-skeleton-bar[data-width='meta'] { width: min(360px, 70%); height: 10px; animation-delay: 120ms; }
      @keyframes adx-skeleton { 0% { opacity: 1 } 40% { opacity: 0.6 } 80%, 100% { opacity: 1 } }
      @media (prefers-reduced-motion: reduce) { .adx-skeleton-bar { animation: none; } }

      .adx-subhead {
        margin: 10px 0 2px; padding: 0 8px; list-style: none;
        color: var(--adx-ink-4); font-size: 11.5px; line-height: 18px;
        text-transform: none; letter-spacing: 0.01em;
      }
      .adx-row[data-muted='true'] .adx-row-title { color: var(--adx-ink-2); font-weight: 400; }
      .adx-row[data-muted='true'] .adx-row-glyph { color: var(--adx-ink-4); }
      .adx-row[data-muted='true'] .adx-meta-author { color: var(--adx-ink-3); opacity: 1; }
      @media (hover: hover) { .adx-row[data-muted='true']:hover { background: color-mix(in srgb, var(--adx-hover) 60%, transparent); } }
      /* Dim the content, not the row: a launch menu opened from a snoozed row
         must stay opaque. */
      .adx-row[data-snoozed='true'] > .adx-row-glyph,
      .adx-row[data-snoozed='true'] > .adx-row-main,
      .adx-row[data-snoozed='true'] .adx-row-pills { opacity: 0.6; }
      .adx-row[data-snoozed='true'] .adx-row-actions,
      .adx-row[data-menu-open='true'] .adx-row-actions { opacity: 1; }
      .adx-meta-snooze { color: var(--adx-ink-2); }
      .adx-row-snooze { position: relative; flex: none; display: inline-flex; align-items: center; }
      .adx-row-snooze .adx-icon-btn[data-active='true'] { background: var(--adx-hover); color: var(--adx-ink); }
      .adx-unsnooze { height: 24px; padding: 0 8px; font-size: 11.5px; line-height: 16px; }
      /* Select mode: a checkbox column before the glyph; the row selects, the
         title does not navigate. */
      .adx-row-select { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; height: 20px; margin-top: 2px; }
      .adx-check {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; padding: 0; border: 1px solid var(--adx-ink-4); border-radius: 4px;
        background: transparent; color: var(--dsw-alias-bg-base, #fff); cursor: pointer;
      }
      .adx-check svg { opacity: 0; }
      .adx-check[aria-checked='true'], .adx-check[aria-checked='mixed'] { background: var(--adx-info); border-color: var(--adx-info); }
      .adx-check[aria-checked='true'] svg, .adx-check[aria-checked='mixed'] svg { opacity: 1; }
      .adx-check:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-section-head > .adx-check { margin-right: 8px; }
      .adx-row[data-select-mode='true'], .adx-row[data-select-mode='true'] .adx-row-title { cursor: default; }
      @media (hover: hover) { .adx-row[data-select-mode='true']:hover .adx-row-title { text-decoration: none; } }
      .adx-search-row { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; }
      .adx-search-row > .adx-search { flex: 1; min-width: 0; margin: 0; }
      .adx-select-toggle { flex: none; height: 32px; }
      .adx-select-toggle[aria-pressed='true'] { background: var(--adx-hover); }
      .adx-row[data-selected='true'] { background: color-mix(in srgb, var(--adx-info) 9%, transparent); }
      .adx-selection-bar {
        position: sticky; bottom: 12px; z-index: 25; display: flex; align-items: center; gap: 8px;
        margin-top: 12px; padding: 6px 8px 6px 14px; border-radius: 12px;
        background: var(--dsw-alias-bg-elevated, var(--adx-module));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16), inset 0 0 0 0.5px var(--adx-hairline);
      }
      .adx-selection-count[data-empty='true'] { color: var(--adx-ink-3); font-weight: 400; }
      .adx-selection-count { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--adx-ink); font-variant-numeric: tabular-nums; }
      .adx-selection-bar .adx-btn { height: 28px; padding: 0 10px; font-size: 12.5px; gap: 4px; }
      .adx-selection-snooze[data-active='true'] { background: var(--adx-hover); }
      .adx-foot { margin-top: 28px; padding-top: 12px; border-top: 0.5px solid var(--adx-hairline-soft);
                  color: var(--adx-ink-4); font-size: 12px; line-height: 18px; }

      .adx-icon-wrap { display: inline-flex; align-items: center; justify-content: center; position: relative; }
      .adx-badge {
        position: absolute; top: -5px; right: -7px;
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
        border-radius: 999px; corner-shape: round;
        background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base);
        font-size: 9px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums;
      }

      .adx-auto { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -4px 0 12px;
                  color: var(--adx-ink-3); font-size: 12px; line-height: 18px; }
      .adx-link { padding: 0; border: 0; background: none; color: var(--adx-info); font: inherit;
                  font-size: 12px; line-height: 18px; cursor: pointer;
                  text-decoration: underline; text-underline-offset: 2px; }
      .adx-link:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 2px; border-radius: 2px; }
      .adx-field-toggle { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 0;
                          border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
      .adx-field-toggle:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 2px; border-radius: 4px; }

      @media (max-width: 767px) {
        .adx-col { padding-inline: 20px; padding-bottom: 32px; }
        .adx-head { flex-direction: column; gap: 10px; }
        .adx-toolbar { width: 100%; justify-content: flex-start; }
        .adx-row-pills { display: none; }
        .adx-scenario-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      }
      .adx-form { display: flex; flex-direction: column; gap: 18px; max-width: 620px; padding-top: 6px; }
      .adx-form-head { display: flex; align-items: center; gap: 8px; }
      .adx-form-head h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
      .adx-form-back { font-size: 13px; line-height: 20px; color: var(--adx-ink-2); }
      .adx-form-head--button { align-self: flex-start; padding: 2px 6px 2px 2px; margin-left: -6px;
                               border: 0; border-radius: var(--dsw-radius-sm, 8px); background: none;
                               font: inherit; cursor: pointer; }
      .adx-form-head--button:hover { background: var(--adx-hover); }
      .adx-form-head--button:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-form-head-icon { display: inline-flex; color: var(--adx-ink-3); }
      .adx-field { display: flex; flex-direction: column; gap: 6px; }
      .adx-field-label { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--adx-ink); }
      .adx-field-hint { font-size: 12px; line-height: 18px; color: var(--adx-ink-3); }
      .adx-field-row { flex-direction: row; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .adx-field-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .adx-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
      .adx-choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; text-align: left;
                    border: 1px solid var(--adx-hairline); border-radius: 10px; background: transparent;
                    color: inherit; font: inherit; cursor: pointer; transition: border-color 110ms ease, background 110ms ease; }
      .adx-choice:hover { background: var(--adx-hover); }
      .adx-choice[aria-checked='true'] { border-color: var(--adx-info); background: var(--adx-hover); }
      .adx-choice:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 2px; }
      .adx-choice-dot { flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
                        border: 1.5px solid var(--adx-ink-4); box-sizing: border-box; }
      .adx-choice[aria-checked='true'] .adx-choice-dot { border: 5px solid var(--adx-info); }
      .adx-choice-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .adx-choice-title { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; font-weight: 500; }
      .adx-choice-badge { font-size: 11px; line-height: 16px; font-weight: 500; padding: 0 6px; border-radius: 999px;
                          color: var(--adx-info); background: var(--adx-module); }
      .adx-choice-hint { font-size: 12px; line-height: 18px; color: var(--adx-ink-3); }
      .adx-choice-warning { font-size: 12px; line-height: 18px; color: var(--adx-warn); }
      .adx-launch-via { margin: 0; padding: 0 12px 6px; font-size: 11.5px; line-height: 16px; color: var(--adx-ink-3); }
      .adx-input, .adx-select {
        box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px;
        border: 1px solid var(--adx-hairline-soft); border-radius: 10px;
        background: transparent; color: var(--adx-ink); font: inherit; font-size: 14px; line-height: 22px;
        outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      }
      .adx-input::placeholder { color: var(--adx-ink-4); }
      .adx-input:focus-visible, .adx-select:focus-visible {
        border-color: var(--adx-info);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--adx-info) 25%, transparent);
      }
      .adx-select { appearance: none; -webkit-appearance: none; padding-right: 30px;
        background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
        background-position: calc(100% - 15px) 15px, calc(100% - 10px) 15px;
        background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
      .adx-select-custom { display: flex; align-items: center; gap: 8px; }
      .adx-select-custom .adx-select { flex: 1 1 auto; min-width: 0; }
      .adx-custom-wrap { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
      .adx-custom-number { flex: 0 0 96px; width: 96px; }
      .adx-custom-unit { color: var(--adx-ink-3); font-size: 12px; line-height: 16px; }
      .adx-path-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
      .adx-switch {
        position: relative; flex: none; width: 36px; height: 20px; margin-top: 2px; padding: 0;
        border: 0; border-radius: 999px; background: var(--adx-module); cursor: pointer;
        transition: background 140ms ease;
      }
      .adx-switch[data-on='true'] { background: var(--adx-info); }
      .adx-switch:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 2px; }
      .adx-switch-knob {
        position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
        background: var(--adx-bg); transition: transform 140ms ease;
      }
      .adx-switch[data-on='true'] .adx-switch-knob { transform: translateX(16px); }
      .adx-form-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
      .adx-form-actions .adx-spacer { flex: 1; }
      .adx-form-status { font-size: 12px; line-height: 18px; color: var(--adx-ink-3); }
      .adx-form-status[data-tone='error'] { color: var(--adx-err); }
      .adx-form-status[data-tone='ok'] { color: var(--adx-ok); }
      .adx-form-status[data-tone='warning'] { color: var(--adx-warn); }
      .adx-form-note { margin: 0; color: var(--adx-ink-4); font-size: 12px; line-height: 18px; }
      @media (prefers-reduced-motion: reduce) { .adx-switch, .adx-switch-knob { transition: none; } }

      .adx-form-section-title {
        margin: 8px 0 -6px; padding-top: 18px; border-top: 0.5px solid var(--adx-hairline-soft);
        font-size: 14px; line-height: 22px; font-weight: 500; color: var(--adx-ink);
      }
      .adx-textarea {
        box-sizing: border-box; width: 100%; min-height: 68px; padding: 8px 10px;
        border: 1px solid var(--adx-hairline-soft); border-radius: 10px;
        background: transparent; color: var(--adx-ink); font: inherit; font-size: 13px; line-height: 20px;
        resize: vertical; outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      }
      .adx-textarea::placeholder { color: var(--adx-ink-4); }
      .adx-textarea:focus-visible {
        border-color: var(--adx-info);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--adx-info) 25%, transparent);
      }
      .adx-agents { display: flex; flex-direction: column; gap: 8px; }
      .adx-agent-row { display: grid; grid-template-columns: minmax(110px, 0.7fr) minmax(180px, 1.6fr) 28px; gap: 8px; align-items: center; }
      .adx-agent-row .adx-input { height: 32px; font-size: 13px; }
      .adx-agent-add { align-self: flex-start; }
      .adx-scenarios { display: flex; flex-direction: column; gap: 8px; }
      .adx-scenario {
        border-radius: 12px; box-shadow: inset 0 0 0 0.5px var(--adx-hairline-soft);
        overflow: hidden;
      }
      .adx-scenario[data-open='true'] { box-shadow: inset 0 0 0 0.5px var(--adx-hairline); }
      .adx-scenario[data-disabled='true'] .adx-scenario-summary { opacity: 0.6; }
      .adx-scenario-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 6px; }
      .adx-scenario-toggle {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
        padding: 4px 2px; border: 0; border-radius: 8px; background: none; color: inherit;
        font: inherit; text-align: left; cursor: pointer;
      }
      @media (hover: hover) { .adx-scenario-toggle:hover { background: var(--adx-hover); } }
      .adx-scenario-toggle:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-scenario-open {
        display: inline-flex; flex: none; color: var(--adx-ink-4);
        transform: rotate(-90deg); transition: transform 140ms ease;
      }
      .adx-scenario-open[data-open='true'] { transform: none; }
      @media (prefers-reduced-motion: reduce) { .adx-scenario-open { transition: none; } }
      .adx-scenario-summary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .adx-scenario-name {
        font-size: 13px; line-height: 19px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .adx-scenario-meta {
        font-size: 11px; line-height: 16px; color: var(--adx-ink-4);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .adx-scenario-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 10px 10px; }
      .adx-scenario-fields {
        display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(88px, 0.7fr) minmax(110px, 0.9fr);
        gap: 8px;
      }
      .adx-scenario-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .adx-scenario-field-label { font-size: 11px; line-height: 16px; color: var(--adx-ink-4); }
      .adx-scenario-body .adx-input, .adx-scenario-body .adx-select { height: 32px; font-size: 13px; }
      .adx-input--static { display: flex; align-items: center; background: var(--adx-module); color: var(--adx-ink-3); }
      .adx-scenario-order { display: inline-flex; gap: 2px; }
      .adx-scenario-order .adx-icon-btn { width: 24px; height: 24px; }
      .adx-scenario-sections { display: flex; flex-wrap: wrap; gap: 4px; }
      .adx-scenario-sections .adx-chip { height: 24px; padding: 0 8px; font-size: 12px; line-height: 18px; }
      .adx-scenario-prompt {
        min-height: 84px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; line-height: 18px;
      }
      .adx-scenario-note { margin: 0; font-size: 11px; line-height: 16px; color: var(--adx-ink-4); }
      .adx-scenario-preview { margin: 0; }
      .adx-scenario-preview summary {
        cursor: pointer; font-size: 11.5px; line-height: 18px; color: var(--adx-ink-3);
        list-style: none;
      }
      .adx-scenario-preview summary::-webkit-details-marker { display: none; }
      .adx-scenario-preview summary::before { content: '▸ '; color: var(--adx-ink-4); }
      .adx-scenario-preview[open] summary::before { content: '▾ '; }
      .adx-scenario-preview pre {
        margin: 6px 0 0; padding: 8px 10px; max-height: 180px; overflow: auto;
        border-radius: 8px; background: var(--adx-module); color: var(--adx-ink-2);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; line-height: 17px; white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .adx-scenario-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .adx-scenario-footer .adx-btn { height: 26px; padding: 0 8px; font-size: 11.5px; }
      .adx-scan { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: -8px; }
      .adx-scan-result { font-size: 12px; line-height: 18px; color: var(--adx-ink-3); }
      .adx-scan-result[data-tone='error'] { color: var(--adx-err); }
      .adx-scan-clones {
        display: flex; flex-direction: column; gap: 2px; margin-top: -8px; padding: 8px 10px;
        border-radius: 8px; background: var(--adx-module); font-size: 11.5px; line-height: 18px;
      }
      .adx-scan-clone { display: flex; gap: 8px; min-width: 0; }
      .adx-scan-clone-repo { flex: none; color: var(--adx-ink-2); font-weight: 500; }
      .adx-scan-clone-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--adx-ink-4); }

      .adx-row-launch { position: relative; flex: none; display: inline-flex; align-items: center; }
      .adx-launch-btn { width: 26px; height: 26px; color: var(--adx-ink-3); opacity: 0.78; }
      @media (hover: hover) {
        .adx-launch-btn:hover:not(:disabled), .adx-launch-btn[data-active='true'] {
          opacity: 1; color: var(--adx-ink); background: var(--adx-hover);
        }
      }
      .adx-launch-btn:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-launch-menu {
        position: absolute; z-index: 30; right: 0; top: 30px; width: 300px; padding: 6px;
        max-height: min(360px, 60vh); overflow-y: auto;
        border-radius: 12px; background: var(--dsw-alias-bg-elevated, var(--adx-module));
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18), inset 0 0 0 0.5px var(--adx-hairline);
        display: flex; flex-direction: column; gap: 2px;
      }
      .adx-launch-menu[data-flip='true'] { top: auto; bottom: 30px; }
      .adx-launch-menu-head { padding: 4px 8px 6px; color: var(--adx-ink-4); font-size: 11px; line-height: 16px; }
      .adx-launch-agent { display: flex; align-items: center; gap: 8px; padding: 2px 8px 4px; }
      .adx-launch-agent-label {
        flex: none; color: var(--adx-ink-4); font-size: 10px; line-height: 14px;
        letter-spacing: 0.04em; text-transform: uppercase;
      }
      .adx-launch-agent-select { flex: 1; min-width: 0; height: 30px; font-size: 12px; }
      .adx-launch-group {
        padding: 6px 8px 2px; color: var(--adx-ink-4); font-size: 10px; line-height: 14px;
        letter-spacing: 0.04em; text-transform: uppercase;
      }
      .adx-launch-item {
        display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px;
        border: 0; border-radius: 8px; background: transparent; color: var(--adx-ink);
        font: inherit; text-align: left; cursor: pointer;
      }
      @media (hover: hover) { .adx-launch-item:hover:not(:disabled) { background: var(--adx-hover); } }
      .adx-launch-item:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: -1px; }
      .adx-launch-item:disabled { opacity: 0.55; cursor: default; }
      .adx-launch-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .adx-launch-item-label { font-size: 13px; line-height: 19px; }
      .adx-launch-item-hint { font-size: 11.5px; line-height: 16px; color: var(--adx-ink-4); }
      .adx-snooze-menu { width: 240px; }
      .adx-snooze-note { padding: 4px 8px 2px; }
      .adx-launch-badge {
        flex: none; padding: 0 6px; border-radius: 999px; background: var(--adx-module);
        color: var(--adx-ink-3); font-size: 10px; line-height: 16px;
      }
      .adx-launch-empty { padding: 8px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
      .adx-launch-empty p { margin: 0; font-size: 12px; line-height: 18px; color: var(--adx-ink-2); }
      .adx-launch-hint { margin: 0; font-size: 11.5px; line-height: 17px; color: var(--adx-ink-4); overflow-wrap: anywhere; }
      .adx-launch-error {
        display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
        background: color-mix(in srgb, var(--adx-err) 8%, transparent);
      }
      .adx-launch-error-title { margin: 0; font-size: 12px; line-height: 18px; color: var(--adx-err); font-weight: 500; }
      .adx-launch-error-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .adx-launch-error-actions .adx-btn { height: 26px; padding: 0 8px; font-size: 11.5px; }

      .adx-toast {
        position: absolute; right: 24px; bottom: 20px; z-index: 40; max-width: min(460px, calc(100% - 48px));
        padding: 9px 12px; border-radius: 10px; background: var(--dsw-alias-bg-elevated, var(--adx-module));
        color: var(--adx-ink-2); font-size: 12px; line-height: 18px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16), inset 0 0 0 0.5px var(--adx-hairline);
        display: flex; align-items: center; gap: 12px;
        animation: adx-toast-in 160ms ease-out;
      }
      .adx-toast-text { min-width: 0; }
      .adx-toast-action {
        flex: none; margin: -3px -4px -3px 0; padding: 3px 8px; border: 0; border-radius: 6px;
        background: transparent; color: var(--adx-info); font: inherit; font-weight: 500; cursor: pointer;
      }
      @media (hover: hover) { .adx-toast-action:hover { background: var(--adx-hover); } }
      .adx-toast-action:focus-visible { outline: var(--adx-ring-w) solid var(--adx-ring); outline-offset: 1px; }
      .adx-toast[data-tone='warning'] { color: var(--adx-warn); }
      .adx-toast[data-tone='ok'] { color: var(--adx-ok); }
      @keyframes adx-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .adx-toast { animation: none; } }

    `

    const CSS_TAG_ID = PACKAGE_ID + '/client.css'
    if (typeof document !== 'undefined') {
      const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']')
      if (existing === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE_ID
        tag.dataset.pluginCss = CSS_TAG_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    /* ---------------------------------------------------------------- helpers */

    function clock(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /** Relative age of `iso` at `now` (the Page minute tick; defaults to the current time). */
    function timeAgo(t, iso, now) {
      if (!iso) return ''
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const reference = Number.isFinite(now) ? now : Date.now()
      const minutes = Math.max(0, Math.round((reference - then) / MINUTE_MS))
      if (minutes < 1) return t('time.now')
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      return t('time.days', { n: Math.round(hours / 24) })
    }

    function shortRepo(repo) {
      if (typeof repo !== 'string') return ''
      const slash = repo.indexOf('/')
      return slash === -1 ? repo : repo.slice(slash + 1)
    }

    function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text)
      }
      return new Promise((resolve, reject) => {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          if (ok) resolve()
          else reject(new Error('copy failed'))
        } catch (error) {
          reject(error)
        }
      })
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }).then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload === null || payload.ok !== true) {
          const detail = payload && payload.error ? payload.error : { code: 'http-' + response.status, message: 'HTTP ' + response.status }
          const error = new Error(detail.message || 'request failed')
          error.payload = detail
          throw error
        }
        return payload
      })
    }

    function getJson(url) {
      return fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      }).then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload === null) {
          const detail = payload && payload.error ? payload.error : { code: 'http-' + response.status, message: 'HTTP ' + response.status }
          const error = new Error(detail.message || 'request failed')
          error.payload = detail
          throw error
        }
        return payload
      })
    }

    function isGithubUrl(value) {
      return typeof value === 'string' && /^https?:\/\/github\.com\//i.test(value)
    }

    /**
     * A partial snapshot built while the plugin was being reloaded contains
     * "inactive context" warnings; when every source failed that way the host
     * serves the previous snapshot as stale, or an error. It is transient:
     * retry once instead of waiting for the next auto-refresh.
     */
    function hasTransientSnapshotWarning(payload) {
      if (payload === null || payload === undefined) return false
      if (payload.status !== 'partial' && payload.status !== 'stale' && payload.status !== 'error') return false
      const pattern = /inactive context|cannot get required service/i
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : []
      if (payload.error && pattern.test(String(payload.error.message || ''))) return true
      if (payload.meta && payload.meta.lastError && pattern.test(String(payload.meta.lastError.message || ''))) return true
      return warnings.some((entry) => entry !== null && entry !== undefined && pattern.test(String(entry.message || '')))
    }

    /**
     * The current failure behind a `stale` snapshot: the host keeps the old
     * snapshot's warnings, appends "refresh failed…", and sets meta.lastError.
     */
    function staleDetail(payload) {
      const lastError = payload && payload.meta ? payload.meta.lastError : null
      if (lastError !== null && lastError !== undefined) {
        const message = String(lastError.message || lastError.code || '')
        if (message !== '') return message
      }
      const warnings = payload && Array.isArray(payload.warnings) ? payload.warnings : []
      const last = warnings.length > 0 ? warnings[warnings.length - 1] : null
      return last !== null && last !== undefined ? String(last.message || '') : ''
    }

    /** `config[key]`, or undefined while the config is not loaded yet. */
    function configValue(config, key) {
      return config !== null && config !== undefined ? config[key] : undefined
    }

    function configList(config, key) {
      const value = configValue(config, key)
      return Array.isArray(value) ? value : []
    }

    /* ------------------------------------------------ snooze and attention */

    /** Sections whose items need the user's action; `issues` is triage only. */
    const ACTIONABLE_SECTIONS = ['review', 'rereview', 'merge', 'respond', 'ci']
    const SNOOZE_STORAGE_KEY = 'triage-desk:snoozed:v2'
    /** Time-based snoozes end at this local hour. */
    const SNOOZE_HOUR = 9
    const DAY_MS = 86_400_000
    /** setTimeout fires at once for delays above 2^31-1 ms (~24.8 days). */
    const MAX_TIMER_MS = 2_147_483_647

    /**
     * What "until new activity" compares: GitHub bumps `updatedAt` on comments,
     * pushes, reviews and labels; a branch item changes with its head commit.
     * '' means the item cannot be snoozed.
     */
    function snoozeFingerprint(item) {
      const value = item.kind === 'branch' ? item.commit || item.updatedAt : item.updatedAt
      return typeof value === 'string' ? value : ''
    }

    function snoozeExpired(entry, now) {
      return entry.until !== null && !(now < Date.parse(entry.until))
    }

    /**
     * The snooze entry `{ fingerprint, until, at }` hiding `item` at `now`, or
     * null. One rule for every snooze: it holds while the fingerprint still
     * matches (new activity ends it) and, for a timed snooze, until `until`.
     */
    function activeSnooze(snoozed, item, now) {
      const entry = snoozed !== null && snoozed !== undefined ? snoozed[item.id] : undefined
      if (entry === null || typeof entry !== 'object' || typeof entry.fingerprint !== 'string') return null
      if (entry.fingerprint === '' || entry.fingerprint !== snoozeFingerprint(item)) return null
      return snoozeExpired(entry, Number.isFinite(now) ? now : Date.now()) ? null : entry
    }

    function isSnoozed(snoozed, item, now) {
      return activeSnooze(snoozed, item, now) !== null
    }

    function snoozeEntry(value) {
      if (value === null || typeof value !== 'object' || typeof value.fingerprint !== 'string' || value.fingerprint === '') return null
      const until = typeof value.until === 'string' && Number.isFinite(Date.parse(value.until)) ? value.until : null
      return { fingerprint: value.fingerprint, until, at: typeof value.at === 'string' ? value.at : '' }
    }

    /**
     * `{ [item.id]: { fingerprint, until, at } }` from localStorage.
     * Unavailable or broken storage yields {}.
     */
    function readSnoozed() {
      const result = {}
      try {
        const parsed = JSON.parse(window.localStorage.getItem(SNOOZE_STORAGE_KEY) || '{}')
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const id of Object.keys(parsed)) {
            const entry = snoozeEntry(parsed[id])
            if (entry !== null) result[id] = entry
          }
        }
      } catch {
        // Storage missing, blocked or unreadable: start empty.
      }
      return result
    }

    /** Best effort: without storage the snoozes live in memory for this session. */
    function writeSnoozed(snoozed) {
      try {
        window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(snoozed))
      } catch {
        // Storage missing, full or blocked: keep the in-memory state only.
      }
    }

    /**
     * Drops snoozes that ended: expired ones at any time, changed items in any
     * snapshot, and items missing from a complete (`ok`) snapshot only, since a
     * partial or stale one can miss items that still exist. `payload` may be
     * null (expiry only). Returns `snoozed` itself when nothing changed.
     */
    function pruneSnoozed(snoozed, payload, now) {
      const current = new Map()
      const sections = payload !== null && payload !== undefined && Array.isArray(payload.sections) ? payload.sections : []
      for (const section of sections) {
        for (const item of (section && Array.isArray(section.items) ? section.items : [])) {
          if (item !== null && item !== undefined) current.set(String(item.id), snoozeFingerprint(item))
        }
      }
      const complete = payload !== null && payload !== undefined && payload.status === 'ok'
      const next = {}
      let changed = false
      for (const id of Object.keys(snoozed)) {
        const entry = snoozed[id]
        const fingerprint = current.get(id)
        const ended =
          snoozeExpired(entry, now) || (fingerprint !== undefined && fingerprint !== entry.fingerprint) || (complete && fingerprint === undefined)
        if (ended) changed = true
        else next[id] = entry
      }
      return changed ? next : snoozed
    }

    /** The next `SNOOZE_HOUR` local time `days` calendar days after `now`. */
    function snoozeTimeInDays(now, days) {
      const date = new Date(now)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, SNOOZE_HOUR, 0, 0, 0).getTime()
    }

    /** The snooze menu's choices: `until` is null (new activity) or epoch ms. */
    function snoozeChoices(now) {
      const weekday = new Date(now).getDay()
      // Next Monday; on a Monday, the Monday a week later.
      const toMonday = ((8 - weekday) % 7) || 7
      return [
        { id: 'activity', until: null },
        { id: 'tomorrow', until: snoozeTimeInDays(now, 1) },
        { id: 'next-week', until: snoozeTimeInDays(now, toMonday) },
      ]
    }

    /** The UI language tag from the active dictionary (`snooze.locale`), if Intl knows it. */
    function uiLocale(t) {
      const tag = t('snooze.locale')
      try {
        return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 ? tag : undefined
      } catch {
        return undefined
      }
    }

    /** Date formatters per UI language and style; building one is costly, so each is made once. */
    const snoozeFormatters = new Map()
    const SNOOZE_FORMATS = {
      time: { hour: '2-digit', minute: '2-digit' },
      weekday: { weekday: 'short' },
      date: { day: 'numeric', month: 'short' },
    }

    function snoozeFormat(t, style, date) {
      const tag = t('snooze.locale')
      const key = tag + '|' + style
      let formatter = snoozeFormatters.get(key)
      if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat(uiLocale(t), SNOOZE_FORMATS[style])
        snoozeFormatters.set(key, formatter)
      }
      return formatter.format(date)
    }

    /** "Today, 09:00", "Tomorrow, 09:00", "Mon, 09:00" or "14 Nov, 09:00" relative to `now`. */
    function formatSnoozeTime(t, until, now) {
      const target = typeof until === 'number' ? until : Date.parse(until)
      if (!Number.isFinite(target)) return ''
      const date = new Date(target)
      const time = snoozeFormat(t, 'time', date)
      const startOf = (ms) => {
        const day = new Date(ms)
        return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
      }
      const days = Math.round((startOf(target) - startOf(now)) / DAY_MS)
      if (days === 0) return t('snooze.today', { time })
      if (days === 1) return t('snooze.tomorrow', { time })
      const day = snoozeFormat(t, days > 1 && days < 7 ? 'weekday' : 'date', date)
      return t('snooze.on', { day, time })
    }

    function itemMatchesSource(item, sourceKey) {
      if (sourceKey === 'all') return true
      return Boolean(item.source) && item.source.kind + ':' + item.source.login === sourceKey
    }

    function itemMatchesQuery(item, query) {
      if (query === '') return true
      const haystack = [item.title, item.repo, item.number, item.ref, item.author && item.author.login]
        .filter((value) => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase()
      return haystack.indexOf(query) !== -1
    }

    /**
     * The attention badge: actionable items, each counted once (a PR in
     * `respond` and `ci` is one item), without snoozed items and without review
     * requests the host marks `optional` (an older host omits the field: counted).
     * `matches` narrows the items further, e.g. to the selected source; `now`
     * (default: the current time) decides whether timed snoozes still hold.
     */
    function attentionCount(sections, snoozed, matches, now) {
      const ids = new Set()
      for (const section of Array.isArray(sections) ? sections : []) {
        if (!section || ACTIONABLE_SECTIONS.indexOf(section.id) === -1 || !Array.isArray(section.items)) continue
        for (const item of section.items) {
          if (item === null || item === undefined) continue
          if (section.id === 'review' && item.optional === true) continue
          if (isSnoozed(snoozed, item, now) || (typeof matches === 'function' && !matches(item))) continue
          ids.add(item.id)
        }
      }
      return ids.size
    }

    function parseRepoPathsText(text) {
      const result = {}
      const lines = String(text || '').split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim()
        if (trimmed === '') continue
        const equals = trimmed.indexOf('=')
        const key = equals === -1 ? '' : trimmed.slice(0, equals).trim()
        const value = equals === -1 ? '' : trimmed.slice(equals + 1).trim()
        if (key === '' || value === '') return { paths: null, invalidLine: index + 1 }
        result[key] = value
      }
      return { paths: result, invalidLine: null }
    }

    /* ------------------------------------------------- scenario helpers */

    const PREVIEW_SAMPLE_ITEMS = {
      review: {
        section: 'review',
        url: 'https://github.com/acme/app/pull/42',
        repo: 'acme/app',
        number: 42,
        kind: 'pull',
        title: 'Fix flaky checkout test',
        headRefName: 'fix/checkout',
        ref: '',
        author: { login: 'octocat' },
        reason: 'review-requested',
      },
      rereview: {
        section: 'rereview',
        url: 'https://github.com/acme/app/pull/17',
        repo: 'acme/app',
        number: 17,
        kind: 'pull',
        title: 'Add retry to the API client',
        headRefName: 'feat/retry',
        ref: '',
        author: { login: 'hubot' },
        reason: 'changes-after-my-review',
      },
      merge: {
        section: 'merge',
        url: 'https://github.com/acme/app/pull/8',
        repo: 'acme/app',
        number: 8,
        kind: 'pull',
        title: 'Speed up token refresh',
        headRefName: 'perf/token',
        ref: '',
        author: { login: 'monalisa' },
        reason: 'ready-to-merge',
      },
      respond: {
        section: 'respond',
        url: 'https://github.com/acme/app/pull/31',
        repo: 'acme/app',
        number: 31,
        kind: 'pull',
        title: 'Answer the review comments',
        headRefName: 'fix/review',
        ref: '',
        author: { login: 'hubot' },
        reason: 'review-feedback',
      },
      ci: {
        section: 'ci',
        url: 'https://github.com/acme/app/pull/24',
        repo: 'acme/app',
        number: 24,
        kind: 'pull',
        title: 'Green the release pipeline',
        headRefName: 'fix/release-ci',
        ref: '',
        author: { login: 'octocat' },
        reason: 'checks-failing',
      },
      issues: {
        section: 'issues',
        url: 'https://github.com/acme/app/issues/90',
        repo: 'acme/app',
        number: 90,
        kind: 'issue',
        title: 'Crash on an empty config',
        headRefName: '',
        ref: '',
        author: { login: 'monalisa' },
        reason: 'new-unassigned',
      },
    }

    /** Bounded label: user label, then the localized builtin name, then the id. */
    function scenarioTextLabel(scenario, t) {
      if (scenario === null || scenario === undefined) return ''
      if (typeof scenario.label === 'string' && scenario.label.trim() !== '') return scenario.label.trim()
      const key = 'scenario.' + String(scenario.id || '') + '.name'
      const value = t(key)
      return value === key ? String(scenario.id || '') : value
    }

    function scenarioAgentValue(scenario) {
      return scenario !== null && scenario !== undefined && typeof scenario.agent === 'string' ? scenario.agent : 'default'
    }

    /** The agent pinned to a scenario, or null when the launch menu picks it. */
    function scenarioPinnedAgent(scenario, agents) {
      const value = scenarioAgentValue(scenario)
      if (value === 'default') return null
      const list = Array.isArray(agents) ? agents : []
      const agent = list.find((entry) => entry !== null && entry !== undefined && entry.id === value)
      return { id: value, label: agent !== undefined ? agent.label : value }
    }

    function defaultAgentId(config, agents) {
      const value = configValue(config, 'defaultAgent')
      if (typeof value === 'string' && value !== '') return value
      return agents.length > 0 ? agents[0].id : ''
    }

    function scenarioAgentHint(scenario, config) {
      const agents = configList(config, 'agents')
      const pinned = scenarioPinnedAgent(scenario, agents)
      if (pinned !== null) return pinned.label
      const wanted = defaultAgentId(config, agents)
      const agent = agents.find((entry) => entry !== null && entry !== undefined && entry.id === wanted)
      return agent !== undefined ? agent.label : wanted
    }

    /** Enabled scenarios of one scope bound to a section, in configured order. */
    function sectionScenarios(config, scope, sectionId) {
      return configList(config, 'scenarios').filter(
        (scenario) =>
          scenario !== null &&
          scenario !== undefined &&
          scenario.scope === scope &&
          scenario.enabled !== false &&
          Array.isArray(scenario.sections) &&
          scenario.sections.indexOf(sectionId) !== -1,
      )
    }

    /** Row menu scenarios: the default scenario first. */
    function scenarioItemScenarios(config, sectionId) {
      const defaultId = configValue(config, 'defaultScenario')
      return sectionScenarios(config, 'item', sectionId).sort(
        (left, right) => (left.id === defaultId ? 0 : 1) - (right.id === defaultId ? 0 : 1),
      )
    }

    function scenarioPreviewItems(scenario) {
      const sections = Array.isArray(scenario.sections) ? scenario.sections : []
      const wanted = scenario.scope === 'section' ? sections : sections.slice(0, 1)
      const items = []
      for (const id of wanted) {
        const sample = PREVIEW_SAMPLE_ITEMS[id]
        if (sample !== undefined) items.push(sample)
      }
      return items.length > 0 ? items : [PREVIEW_SAMPLE_ITEMS.review]
    }

    /**
     * English prompt label for a section or reason code from the host
     * (`config.labels.sections` / `.reasons`, the tables the host renders
     * prompts with). An older running host does not publish them; the preview
     * then shows the code itself.
     */
    function promptLabel(labels, group, code) {
      const table = labels !== null && labels !== undefined && labels[group] ? labels[group] : {}
      return typeof table[code] === 'string' ? table[code] : code
    }

    /** Token values and the generated `{links}` block for the preview sample items. */
    function previewVars(scenario, labels) {
      const items = scenarioPreviewItems(scenario)
      const date = new Date().toISOString().slice(0, 10)
      const sections = []
      for (const item of items) {
        const label = promptLabel(labels, 'sections', item.section)
        if (!sections.includes(label)) sections.push(label)
      }
      const lines = ['Items: ' + items.length + ' · sections: ' + sections.join(' + ') + ' · date: ' + date, '']
      for (const item of items) {
        const author = item.author && item.author.login ? ', author ' + item.author.login : ''
        const reason = item.reason ? ', reason: ' + promptLabel(labels, 'reasons', item.reason) : ''
        lines.push('- [' + item.title + '](' + item.url + ') — ' + item.repo + '#' + item.number + author + reason)
      }
      const block = lines.join('\n')
      if (scenario.scope === 'section') {
        return { block, vars: { links: block, count: String(items.length), section: sections.join(' + '), date } }
      }
      const item = items[0]
      return {
        block,
        vars: {
          url: item.url,
          repo: item.repo,
          owner: 'acme',
          name: 'app',
          number: String(item.number),
          title: item.title,
          branch: item.headRefName || '',
          kind: item.kind || '',
          ref: item.ref || '',
          author: item.author && item.author.login ? item.author.login : '',
          reason: item.reason || '',
          links: block,
          count: '1',
          date,
        },
      }
    }

    function replaceScenarioTokens(template, vars) {
      let text = String(template || '')
      for (const key of Object.keys(vars)) text = text.split('{' + key + '}').join(String(vars[key]))
      return text
    }

    function scenarioPreviewText(scenario, labels) {
      if (scenario === null || scenario === undefined) return ''
      const built = previewVars(scenario, labels)
      const template = String(scenario.prompt || '')
      let text = replaceScenarioTokens(template, built.vars)
      const needsBlock =
        scenario.scope === 'section'
          ? template.indexOf('{links}') === -1
          : template.indexOf('{url}') === -1 && template.indexOf('{links}') === -1
      if (needsBlock) text = text.replace(/\s+$/, '') + '\n\n' + built.block
      return text
    }

    function teamFromWaiting(waitingOn) {
      if (!Array.isArray(waitingOn)) return ''
      for (const entry of waitingOn) {
        if (typeof entry === 'string' && entry.startsWith('team:')) return entry.slice(5)
        if (typeof entry === 'string' && entry.startsWith('team ')) return entry.slice(5)
      }
      return ''
    }

    /* ------------------------------------------------------------------ icons */

    const PATHS = {
      inbox:
        'M2.2 4.4 3.3 2h9.4l1.1 2.4v7.1a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2.2 11.5V4.4Z M2.2 8h3.1l.9 1.6h3.6l.9-1.6h3.1',
      refresh:
        'M13.2 6.2A5.6 5.6 0 0 0 3.4 4.3L2.4 6.2m0 0V2.6m0 3.6h3.6 M2.8 9.8a5.6 5.6 0 0 0 9.8 1.9l1-1.9m0 0v3.6m0-3.6H10',
      search: 'M7.2 12.2a4.9 4.9 0 1 0 0-9.8 4.9 4.9 0 0 0 0 9.8Zm3.5-1.4 3.1 3.1',
      copy: 'M5.8 5.8V3.9A1.1 1.1 0 0 1 6.9 2.8h5.2A1.1 1.1 0 0 1 13.2 3.9v5.2a1.1 1.1 0 0 1-1.1 1.1h-1.9M2.8 6.9A1.1 1.1 0 0 1 3.9 5.8h5.2A1.1 1.1 0 0 1 10.2 6.9v5.2a1.1 1.1 0 0 1-1.1 1.1H3.9a1.1 1.1 0 0 1-1.1-1.1V6.9Z',
      chevron: 'm4 6.2 4 4 4-4',
      pull: 'M4.3 4.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm0 0v7.6m0 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM11.7 6.6a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm0 0v1.1a3.3 3.3 0 0 1-3.3 3.3H7.6m-3.3-1.6H3.2',
      merge: 'M4.3 4.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm0 0v7.6m0 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm6.2-6.6a2.8 2.8 0 0 1-2.8 2.8H4.3M10.5 8.2V5.2',
      comment: 'M2.8 4A1.2 1.2 0 0 1 4 2.8h8A1.2 1.2 0 0 1 13.2 4v5.6a1.2 1.2 0 0 1-1.2 1.2H6.4l-3.6 2.4V4Z',
      issue: 'M8 13.7A5.7 5.7 0 1 0 8 2.3a5.7 5.7 0 0 0 0 11.4Zm0-3.4v.01M8 5.6v3.2',
      branch: 'M4.3 4.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm0 0v7.6m0 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm6.2-6.6a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm0 0v1.2a3.2 3.2 0 0 1-3.2 3.2H6.2',
      alert: 'M8 2.6 13.4 12.2H2.6L8 2.6ZM8 6.4v2.6m0 1.5v.01',
      check: 'm3.2 8.4 3 3 6.6-7',
      close: 'm4 4 8 8M12 4l-8 8',
      dot: 'M8 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
      settings:
        'M5.6 3.2v2.1M5.6 7.6v5.2M10.4 3.2v5.2M10.4 10.7v2.1 M5.6 7.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z M10.4 10.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z',
      back: 'M10 4 6 8l4 4',
      dash: 'M4 8h8',
      snooze: 'M8 13.7A5.7 5.7 0 1 0 8 2.3a5.7 5.7 0 0 0 0 11.4ZM8 5v3.3l2.1 1.3',
      terminal: 'M2.8 3.6h10.4A1.2 1.2 0 0 1 14.4 4.8v6.4a1.2 1.2 0 0 1-1.2 1.2H2.8a1.2 1.2 0 0 1-1.2-1.2V4.8a1.2 1.2 0 0 1 1.2-1.2Z M4.2 6.4l2 1.6-2 1.6 M8.1 10.2h3.4',
    }

    function icon(name, size, strokeWidth) {
      const edge = typeof size === 'number' ? size : 16
      const paths = (PATHS[name] || PATHS.inbox).split(' M').map((segment, index) => (index === 0 ? segment : 'M' + segment))
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: strokeWidth === undefined ? 1.25 : strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    /* ------------------------------------------------------------------ store */

    function createStore() {
      let state = {
        status: 'loading',
        refreshing: false,
        data: null,
        error: null,
        filter: 'all',
        sourceFilter: 'all',
        collapsed: {},
        copied: null,
        loadedAt: 0,
        view: 'list',
        openMenu: null,
        config: null,
        configStatus: 'idle',
        configError: null,
        saveError: null,
        auth: null,
        authStatus: 'idle',
        authError: null,
        loginStatus: 'idle',
        loginError: null,
        pollSeconds: 1200,
        toast: null,
        dshAvailable: false,
        snoozed: readSnoozed(),
        // The filter to return to when the Snoozed view closes.
        filterBeforeSnoozed: 'all',
        // Multi-select: `{ [item.id]: true }`, and the last toggled row
        // (`{ section, id }`) that Shift+click extends a range from.
        selected: {},
        selectionAnchor: null,
        // Select mode (toolbar "Select" until Done/Escape/a bulk action).
        selectMode: false,
      }
      const listeners = new Set()
      let inflight = null
      let pendingForce = false
      let configRevision = 0
      // The configRevision whose post-save snapshot read may still retry once.
      let saveReloadRevision = -1
      let transientRetried = false
      // One recovery slot shared by the transient retry and the failure backoff.
      let retryTimer = null
      let errorAttempts = 0
      let disposed = false
      let timer = null
      let nextPollAt = 0
      let subscribers = 0
      let toastTimer = null
      let applyTimer = null
      let snoozeTimer = null

      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('[triage-desk] listener failed', error)
          }
        }
      }

      const get = () => state
      const set = (patch) => {
        const previousPollSeconds = state.pollSeconds
        state = Object.assign({}, state, patch)
        if (state.pollSeconds !== previousPollSeconds) schedule()
        emit()
      }

      const schedule = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        nextPollAt = 0
        if (subscribers === 0) return
        const seconds = Math.max(15, Number(state.pollSeconds) || 1200)
        nextPollAt = Date.now() + seconds * 1000
        timer = setTimeout(() => {
          timer = null
          if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') void load(false)
          schedule()
        }, seconds * 1000)
      }

      const cancelRetry = () => {
        if (retryTimer !== null) clearTimeout(retryTimer)
        retryTimer = null
      }

      const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

      /**
       * Bounded recovery after a failed snapshot (network/HTTP failure or a host
       * `error`/`stale` payload): 15 s, 60 s, 5 min, each capped by the poll
       * interval, then only the regular poll until a successful load resets it.
       * Skipped while hidden (the visibility handler reloads on return) and when
       * the regular poll would fire first; it uses the single recovery slot, so
       * it never stacks with the transient retry.
       */
      const scheduleErrorRetry = () => {
        if (disposed || subscribers === 0 || retryTimer !== null || pageHidden()) return
        if (errorAttempts >= ERROR_RETRY_SECONDS.length) return
        const pollMs = Math.max(15, Number(state.pollSeconds) || 1200) * 1000
        const delay = Math.min(ERROR_RETRY_SECONDS[errorAttempts] * 1000, pollMs)
        if (timer !== null && Date.now() + delay >= nextPollAt) return
        errorAttempts += 1
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (subscribers > 0 && !disposed && !pageHidden()) void load(false)
        }, delay)
      }

      const load = (force) => {
        if (disposed) return Promise.resolve(null)
        if (inflight !== null) {
          // A forced refresh must not be silently downgraded to the cached one.
          if (force === true) pendingForce = true
          return inflight
        }
        // Any new request supersedes a scheduled recovery attempt.
        cancelRetry()
        if (state.data === null) set({ status: 'loading', refreshing: true })
        else set({ refreshing: true })
        const loadRevision = configRevision
        inflight = fetch(force ? SNAPSHOT_URL + '?refresh=1&t=' + Date.now() : SNAPSHOT_URL, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        })
          .then(async (response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.sections)) {
              throw new Error('malformed snapshot')
            }
            const patch = { status: 'ready', data: payload, error: null, loadedAt: Date.now(), refreshing: false }
            const snoozed = pruneSnoozed(state.snoozed, payload, Date.now())
            if (snoozed !== state.snoozed) {
              patch.snoozed = snoozed
              writeSnoozed(snoozed)
            }
            const seconds = payload.settings ? Number(payload.settings.refreshSeconds) : NaN
            // A snapshot started before a confirmed save carries the old settings.
            if (loadRevision === configRevision && Number.isFinite(seconds) && seconds >= 15) patch.pollSeconds = seconds
            set(patch)
            if (patch.snoozed !== undefined) scheduleSnoozeExpiry()
            const transient = hasTransientSnapshotWarning(payload)
            const failed = payload.status === 'error' || payload.status === 'stale'
            if (transient && !transientRetried && subscribers > 0 && !disposed) {
              transientRetried = true
              retryTimer = setTimeout(() => {
                retryTimer = null
                if (subscribers > 0 && !disposed && !pageHidden()) void load(true)
              }, 3000)
            } else if (failed) {
              scheduleErrorRetry()
            }
            if (!transient) transientRetried = false
            if (!failed) errorAttempts = 0
            return payload
          })
          .catch((error) => {
            // A read started before a confirmed save is followed by a fresh one
            // (see finally); its failure says nothing about the saved settings.
            if (loadRevision !== configRevision) return null
            if (loadRevision === saveReloadRevision) {
              // The first read after a save: the plugin may still be coming
              // back from a restart. Retry once before showing the failure.
              saveReloadRevision = -1
              cancelRetry()
              retryTimer = setTimeout(() => {
                retryTimer = null
                if (subscribers > 0 && !disposed && !pageHidden()) void load(false)
                else set({ refreshing: false })
              }, SAVE_RELOAD_RETRY_MS)
              return null
            }
            set({ status: 'error', error: String((error && error.message) || error), refreshing: false })
            scheduleErrorRetry()
            return null
          })
          .finally(() => {
            inflight = null
            if (loadRevision === saveReloadRevision) saveReloadRevision = -1
            if (pendingForce) {
              pendingForce = false
              void load(true)
            } else if (loadRevision !== configRevision) {
              // Started before a confirmed save: read again for the saved settings.
              void load(false)
            }
          })
        return inflight
      }

      /**
       * The snapshot read after a confirmed save. A read already in flight
       * started under the old settings, so load() follows it with a fresh one;
       * the first read for the saved settings retries once if it fails.
       */
      const reloadAfterSave = () => {
        saveReloadRevision = configRevision
        return load(false)
      }

      const loadConfig = (options) => {
        const quiet = options !== undefined && options !== null && options.quiet === true
        const loadRevision = configRevision
        return fetch(CONFIG_URL, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            if (!response.ok || payload === null || payload.config === undefined) {
              const message = payload && payload.error ? payload.error.message : 'HTTP ' + response.status
              throw new Error(message)
            }
            // A read started before persistence confirmed may still carry the
            // old settings. Do not let it undo the saved config or save status.
            if (loadRevision !== configRevision) return state.config
            set({
              config: payload.config,
              // A read never ends a save in progress or hides its outcome.
              configStatus: SAVE_STATUSES.includes(state.configStatus) ? state.configStatus : 'ready',
              configError: null,
              saveError: payload.saveError || null,
            })
            return payload.config
          })
          .catch((error) => {
            if (loadRevision !== configRevision) return state.config
            if (quiet) return null
            set({ configStatus: 'error', configError: String((error && error.message) || error) })
            return null
          })
      }

      /**
       * An older host accepted the save (202) and restarts the plugin before
       * the write is known to be done. Show `applying`, then after the restart
       * window read the config back: the save counts as confirmed unless the
       * restarted host reports `saveError`. A read that fails while the host is
       * still restarting is retried once. Disposal cancels the wait.
       */
      const confirmAccepted = (payload) => {
        set({ configStatus: 'applying' })
        return new Promise((resolve, reject) => {
          let attempts = 0
          const wait = () => {
            applyTimer = setTimeout(() => {
              applyTimer = null
              if (disposed) return
              attempts += 1
              void loadConfig().then((config) => {
                if (disposed) return
                if (config === null) {
                  if (attempts < APPLY_CONFIRM_ATTEMPTS) {
                    set({ configStatus: 'applying' })
                    wait()
                  } else reject(new Error(state.configError || 'the settings could not be read back'))
                  return
                }
                if (state.saveError !== null && state.saveError !== undefined) {
                  reject(new Error(String(state.saveError.message || state.saveError)))
                  return
                }
                const seconds = Number(config.refreshSeconds)
                configRevision += 1
                set({
                  configStatus: 'saved',
                  ...(Number.isFinite(seconds) && seconds >= 15 ? { pollSeconds: seconds } : {}),
                })
                resolve(payload)
              })
            }, APPLY_CONFIRM_MS)
          }
          wait()
        })
      }

      const saveConfig = (patch) => {
        set({ configStatus: 'saving', configError: null })
        return fetch(CONFIG_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
          body: JSON.stringify(patch),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            // 200 confirms persistence. An older running host answers 202 before
            // writing; confirm that against the config it serves after restart.
            if (response.status === 202 && payload !== null && payload.ok === true) return confirmAccepted(payload)
            if (response.status !== 200 || payload === null || payload.ok !== true) {
              // `payload` keeps the host's error code, e.g. `invalid-agent` with the agent id.
              const detail = payload && payload.error ? payload.error : { message: 'HTTP ' + response.status }
              throw Object.assign(new Error(detail.message), { payload: detail })
            }
            const seconds = Number(patch.refreshSeconds)
            configRevision += 1
            set({
              configStatus: 'saved',
              config: Object.assign({}, state.config, patch),
              ...(Number.isFinite(seconds) && seconds >= 15 ? { pollSeconds: seconds } : {}),
            })
            // 200 arrives after the host wrote and applied the config: read the
            // normalized config back (fresh invalidAgents, detection, sources).
            // A failed read keeps the merged patch and the saved status.
            void loadConfig({ quiet: true })
            return payload
          })
          .catch((error) => {
            set({ configStatus: 'error', configError: String((error && error.message) || error) })
            throw error
          })
      }

      const onVisibilityChange = () => {
        if (subscribers === 0 || document.visibilityState === 'hidden') return
        void load(false)
        schedule()
      }

      const subscribe = (listener) => {
        if (disposed) return () => {}
        listeners.add(listener)
        subscribers += 1
        if (subscribers === 1) {
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
          void load(false)
          schedule()
          scheduleSnoozeExpiry()
        }
        return () => {
          if (!listeners.delete(listener)) return
          subscribers -= 1
          if (subscribers === 0) {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
            if (timer !== null) clearTimeout(timer)
            timer = null
            nextPollAt = 0
            cancelRetry()
            transientRetried = false
            errorAttempts = 0
            pendingForce = false
            scheduleSnoozeExpiry()
          }
        }
      }

      const loadAuth = (silent) => {
        if (silent !== true) set({ authStatus: 'loading', authError: null })
        return getJson(AUTH_URL)
          .then((payload) => {
            if (payload.auth === undefined) throw new Error('the auth status is missing')
            set({
              auth: payload.auth,
              authStatus: 'ready',
              authError: null,
              ...(payload.auth && payload.auth.authenticated === true ? { loginStatus: 'idle', loginError: null } : {}),
            })
            return payload.auth
          })
          .catch((error) => {
            set({ authStatus: 'error', authError: String((error && error.message) || error) })
            return null
          })
      }

      const loginGithub = () => {
        set({ loginStatus: 'launching', loginError: null })
        return postJson(AUTH_LOGIN_URL, {})
          .then((payload) => {
            set({ loginStatus: 'launched', auth: payload.auth || state.auth })
            if (payload.already === true) {
              set({ loginStatus: 'idle' })
              void loadAuth(true)
              void load(true)
            }
            return payload
          })
          .catch((error) => {
            set({ loginStatus: 'error', loginError: String((error && error.message) || error) })
            throw error
          })
      }

      /**
       * One timer at the earliest end of a timed snooze while a slot is
       * mounted: the entry is pruned on time, so the badge and the list bring
       * the item back without a refresh. Rescheduled on every snooze change.
       */
      const scheduleSnoozeExpiry = () => {
        if (snoozeTimer !== null) clearTimeout(snoozeTimer)
        snoozeTimer = null
        if (disposed || subscribers === 0) return
        let next = Infinity
        for (const id of Object.keys(state.snoozed)) {
          const until = state.snoozed[id].until
          if (until !== null) next = Math.min(next, Date.parse(until))
        }
        if (!Number.isFinite(next)) return
        snoozeTimer = setTimeout(() => {
          snoozeTimer = null
          const pruned = pruneSnoozed(state.snoozed, null, Date.now())
          if (pruned !== state.snoozed) updateSnoozed(pruned)
          else scheduleSnoozeExpiry()
        }, Math.min(Math.max(0, next - Date.now()), MAX_TIMER_MS))
      }
      const updateSnoozed = (snoozed) => {
        set({ snoozed })
        writeSnoozed(snoozed)
        scheduleSnoozeExpiry()
      }
      /** Sets one snooze entry, or removes it when `entry` is undefined (Unsnooze, Undo). */
      /**
       * Applies `{ [id]: entry | undefined }` in one update (undefined removes
       * the snooze) and returns the entries it replaced, so one Undo restores
       * a whole bulk action exactly.
       */
      const setSnoozes = (changes) => {
        const ids = Object.keys(changes)
        const previous = {}
        if (ids.length === 0) return previous
        const next = Object.assign({}, state.snoozed)
        for (const id of ids) {
          previous[id] = state.snoozed[id]
          if (changes[id] === undefined || changes[id] === null) delete next[id]
          else next[id] = changes[id]
        }
        updateSnoozed(next)
        return previous
      }
      /**
       * Hides the items in every section until new activity, and with `until`
       * (epoch ms) at the latest until then; items without a fingerprint are
       * skipped. Returns the replaced entries for Undo.
       */
      const snoozeItems = (items, until) => {
        const at = new Date(Date.now()).toISOString()
        const end = typeof until === 'number' ? new Date(until).toISOString() : null
        const changes = {}
        for (const item of items) {
          const fingerprint = snoozeFingerprint(item)
          if (fingerprint !== '') changes[String(item.id)] = { fingerprint, until: end, at }
        }
        return setSnoozes(changes)
      }
      const unsnoozeIds = (ids) => {
        const changes = {}
        for (const id of ids) changes[String(id)] = undefined
        return setSnoozes(changes)
      }
      const snooze = (item, until) => snoozeItems([item], until)[String(item.id)]
      const setSnooze = (id, entry) => setSnoozes({ [String(id)]: entry })
      const unsnooze = (id) => setSnooze(id, undefined)

      /** `action` ({ label, run }) adds a button, e.g. Undo; such a toast stays 6 s. */
      const showToast = (text, tone, action) => {
        if (toastTimer !== null) clearTimeout(toastTimer)
        set({ toast: { text: String(text), tone: tone || 'ok', action: action || null } })
        toastTimer = setTimeout(
          () => {
            toastTimer = null
            set({ toast: null })
          },
          action ? 6000 : 5000,
        )
      }
      const dismissToast = () => {
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = null
        set({ toast: null })
      }

      const dispose = () => {
        disposed = true
        cancelRetry()
        pendingForce = false
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
        listeners.clear()
        subscribers = 0
        if (timer !== null) clearTimeout(timer)
        if (toastTimer !== null) clearTimeout(toastTimer)
        if (applyTimer !== null) clearTimeout(applyTimer)
        if (snoozeTimer !== null) clearTimeout(snoozeTimer)
        timer = null
        toastTimer = null
        applyTimer = null
        snoozeTimer = null
      }

      return {
        get, set, subscribe, load, reloadAfterSave, loadConfig, saveConfig, loadAuth, loginGithub,
        snooze, unsnooze, setSnooze, setSnoozes, snoozeItems, unsnoozeIds, showToast, dismissToast, dispose,
      }
    }

    function useStore(store) {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => {
        setSnapshot(store.get())
        return store.subscribe(() => setSnapshot(store.get()))
      }, [store])
      return snapshot
    }

    /* ------------------------------------------------------------- components */

    function Pill({ tone, children, title }) {
      return h('span', { className: 'adx-pill', 'data-tone': tone, title }, children)
    }

    function ChecksPill({ checks, t }) {
      if (!checks || checks.state === 'none') return null
      const tone = checks.state === 'success' ? 'success' : checks.state === 'failure' ? 'danger' : 'warning'
      const label =
        checks.state === 'success'
          ? t('checks.success')
          : checks.state === 'failure'
            ? t('checks.failure')
            : t('checks.pending')
      const title =
        checks.state === 'failure' && Array.isArray(checks.failing) && checks.failing.length > 0
          ? checks.failing.map((entry) => entry.name).join(', ')
          : label
      return h(
        Pill,
        { tone, title },
        h('span', { className: 'adx-pill-dot' }),
        label,
      )
    }

    function ReviewPill({ item, t }) {
      if (item.draft) return h(Pill, { tone: 'neutral' }, t('meta.draft'))
      if (item.mergeable === 'CONFLICTING') return h(Pill, { tone: 'danger' }, t('meta.conflict'))
      const decision = item.reviewDecision
      if (decision === 'APPROVED') return h(Pill, { tone: 'success' }, t('review.approved'))
      if (decision === 'CHANGES_REQUESTED') return h(Pill, { tone: 'warning' }, t('review.changes-requested'))
      if (decision === 'REVIEW_REQUIRED') return h(Pill, { tone: 'outline' }, t('review.required'))
      return null
    }

    /** Why a configured agent cannot launch, from the host's detection reason. */
    function agentMissingLabel(t, detection) {
      const reason = detection && detection.reason
      if (reason === 'alias' || reason === 'function') return t('launch.agentShellAlias')
      if (reason === 'not-executable') return t('launch.agentNotExecutable')
      return t('launch.notInstalled')
    }

    /**
     * The reason code shown and sent for a row: a re-review caused by the
     * author's reply is `author-replied` rather than the section's reason.
     */
    function effectiveReason(item) {
      return item.section === 'rereview' && item.rereviewCause === 'author-reply' ? 'author-replied' : item.reason
    }

    function reasonText(t, item) {
      if (item.reason === 'team-review-requested') {
        const team = teamFromWaiting(item.waitingOn)
        return t('reason.team-review-requested', { team: team || 'review' })
      }
      const key = 'reason.' + String(effectiveReason(item) || '')
      const value = t(key)
      return value === key ? '' : value
    }

    /**
     * Store key for per-row UI state (open launch menu, copied tick). One pull
     * request can sit in several sections at once (changes requested and red
     * CI, approved but red), so the item id alone would open two menus that
     * close each other on the first click.
     */
    function rowStateKey(section, item) {
      return String(section) + ':' + String(item && item.id)
    }

    /**
     * Launch state shared by the row and section menus: `buildRequest(scenarioId)`
     * is the launch/prompt body, `close` closes the menu after a success, and
     * `dshError(base)` maps a failed DSH draft to the error shown in the menu.
     * Retry repeats the last launch, or `fallbackScenario` when there was none.
     */
    function useScenarioLaunch({ store, t, buildRequest, close, fallbackScenario, dshError }) {
      const [busy, setBusy] = useState(false)
      const [lastLaunch, setLastLaunch] = useState(null)
      const [launchError, setLaunchError] = useState(null)

      const launch = (scenarioId, agentId) => {
        if (busy) return
        setLastLaunch({ scenarioId: scenarioId, agentId: agentId || null })
        setBusy(true)
        setLaunchError(null)
        const body = buildRequest(scenarioId)
        if (agentId) body.agent = agentId
        postJson(LAUNCH_URL, body)
          .then((payload) => {
            store.showToast(launchToastText(t, payload), 'ok')
            close()
          })
          .catch((error) => setLaunchError(launchErrorDetail(error)))
          .finally(() => setBusy(false))
      }

      const launchDsh = (scenarioId) => {
        if (busy) return
        setLastLaunch({ scenarioId: scenarioId, agentId: null, target: 'dsh' })
        setBusy(true)
        setLaunchError(null)
        postJson(PROMPT_URL, buildRequest(scenarioId))
          .then((payload) => {
            store.showToast(startDshDraft(t, payload), 'ok')
            close()
          })
          .catch((error) => {
            const base = launchErrorDetail(error)
            setLaunchError(dshError ? dshError(base) : base)
          })
          .finally(() => setBusy(false))
      }

      const retry = () => {
        if (lastLaunch !== null && lastLaunch.target === 'dsh' && lastLaunch.scenarioId) {
          launchDsh(lastLaunch.scenarioId)
          return
        }
        launch(
          lastLaunch !== null && lastLaunch.scenarioId ? lastLaunch.scenarioId : fallbackScenario,
          lastLaunch !== null && lastLaunch.agentId ? lastLaunch.agentId : null,
        )
      }

      return { busy, launchError, setLaunchError, launch, launchDsh, retry }
    }

    /**
     * Document handlers of an open launch menu (Row and Section). A press
     * outside the menu closes it, except on the trigger: the trigger toggles
     * the menu itself, and closing here as well would let its click reopen the
     * menu right away. Escape closes it and returns focus to the trigger.
     * Opening optionally focuses the first menu item (`focusFirst`) and reports
     * through `onFlip(flip)` whether the menu lacks room below the trigger.
     * `close` is taken from the render that opened the menu.
     */
    function useLaunchMenu({ open, close, menuRef, triggerRef, focusFirst, onFlip }) {
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          close()
          if (triggerRef.current !== null && typeof triggerRef.current.focus === 'function') triggerRef.current.focus()
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        const menu = menuRef.current
        if (focusFirst === true && menu !== null) {
          const firstItem = menu.querySelector('[role="menuitem"]')
          if (firstItem !== null && typeof firstItem.focus === 'function') firstItem.focus()
        }
        if (typeof onFlip === 'function' && menu !== null && triggerRef.current !== null) {
          const below = window.innerHeight - triggerRef.current.getBoundingClientRect().bottom
          onFlip(menu.getBoundingClientRect().height + 8 > below)
        }
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
    }

    /** The error detail of a failed launch/prompt request, or a generic one. */
    function launchErrorDetail(error) {
      return error !== null && error !== undefined && error.payload
        ? error.payload
        : { code: 'launch-failed', message: String((error && error.message) || error) }
    }

    function trimmedSuffix(t, payload) {
      return payload.trimmed !== null && payload.trimmed !== undefined
        ? t('launch.trimmed', { shown: payload.trimmed.shown, total: payload.trimmed.total })
        : ''
    }

    /** Toast for a terminal launch; an item launch reports count 1 and no trimming. */
    /** The paste shortcut a user presses in a terminal on this platform. */
    function pasteKeys(platform) {
      if (platform === 'darwin') return '⌘V'
      if (platform === 'linux') return 'Ctrl+Shift+V'
      return 'Ctrl+V'
    }

    /**
     * How a launch hands `agent` its prompt: `draft`, `paste` or `clipboard`.
     * The host reports `detectedAgents[id].draft` (its draftCommandFor); when
     * that field is absent, an agent with a draft flag drafts except on
     * Windows, where the host drafts only a detected `.exe`.
     */
    function promptDeliveryFor(config, agent) {
      const detected = (agent && (configValue(config, 'detectedAgents') || {})[agent.id]) || {}
      const draft = typeof detected.draft === 'boolean'
        ? detected.draft
        : configValue(config, 'platform') !== 'win32' &&
          Boolean(agent && typeof agent.draftFlag === 'string' && agent.draftFlag !== '')
      if (draft) return 'draft'
      const paste = configValue(config, 'promptPaste')
      if (configValue(config, 'promptDelivery') !== 'clipboard' && paste && paste.available === true) return 'paste'
      return 'clipboard'
    }

    /** The terminal app a launch opens: the saved choice when installed, else the automatic one. */
    function launchTerminalLabel(config) {
      const scan = configValue(config, 'terminals')
      if (scan === null || scan === undefined) return ''
      const choice = configValue(config, 'terminal') || 'auto'
      const chosen = (scan.options || []).find((entry) => entry.id === choice && entry.available)
      return chosen ? chosen.label : scan.autoLabel || ''
    }

    function launchToastText(t, payload) {
      const delivery = payload.delivery || {}
      const mode = payload.mode === 'draft' || payload.mode === 'paste' ? payload.mode : 'clipboard'
      let text = t('launch.' + mode, {
        agent: (payload.agent && payload.agent.label) || t('launch.agent'),
        terminal: (payload.terminal && payload.terminal.label) || t('settings.terminalAutoNone'),
        cwd: payload.cwd || '',
        keys: pasteKeys(delivery.platform),
      })
      if (mode === 'clipboard' && delivery.pasteBlocked) text += t('launch.pasteBlocked.' + delivery.pasteBlocked)
      // Windows: detection reported a path the launch could not run by.
      if (typeof delivery.pinBlocked === 'string' && delivery.pinBlocked !== '') text += t('launch.pinBlocked.' + delivery.pinBlocked)
      if (payload.terminal && payload.terminal.fallback) text += t('launch.terminalFallback')
      if (payload.cloneMissing) text += t('launch.workspaceFallback')
      if (typeof payload.count === 'number' && payload.count > 1) text += t('launch.countSuffix', { n: payload.count })
      return text + trimmedSuffix(t, payload)
    }

    /** Opens the rendered prompt as a draft in a new DSH chat; returns the toast text. */
    function startDshDraft(t, payload) {
      const workspace = runtime.uiWorkspace
      if (workspace === null || workspace === undefined) throw new Error('the DSH session service is not available')
      workspace.startSession(undefined, { prompt: payload.prompt || '', whenDraftExists: 'append' })
      return t('launch.dshDraft') + trimmedSuffix(t, payload)
    }

    /**
     * Launch targets of a row or section menu: DSH when the host renders
     * prompts (`supportsPrompt`) and the session service exists, then the
     * default agent, then the other agents with undetected ones last.
     * `selected` is the menu's pick (`picked`) while it is still offered.
     */
    function launchTargets(config, picked) {
      const agents = configList(config, 'agents')
      const detected = configValue(config, 'detectedAgents') || {}
      const dsh = runtime.uiWorkspace !== null && runtime.uiWorkspace !== undefined && configValue(config, 'supportsPrompt') === true
      const fallback = defaultAgentId(config, agents)
      const rank = (agent) =>
        (agent.id === fallback ? 0 : 2) + (detected[agent.id] && detected[agent.id].available === false ? 1 : 0)
      const ordered = agents.slice().sort((left, right) => rank(left) - rank(right))
      const selected =
        dsh && picked === 'dsh'
          ? 'dsh'
          : ordered.some((agent) => agent.id === picked)
            ? picked
            : ordered.length === 0 && dsh
              ? 'dsh'
              : fallback
      return { agents, detected, dsh, ordered, selected }
    }

    /** One line under the agent picker: where the agent opens and how it gets the prompt. */
    function launchVia(t, config, targets) {
      if (targets.selected === 'dsh') return null
      const agent = targets.agents.find((entry) => entry.id === targets.selected)
      const terminal = launchTerminalLabel(config)
      if (agent === undefined || terminal === '') return null
      const text = t('launch.via.' + promptDeliveryFor(config, agent), {
        terminal,
        keys: pasteKeys(configValue(config, 'platform')),
      })
      return h('p', { key: 'via', className: 'adx-launch-via' }, text)
    }

    function launchTargetPicker(t, targets, busy, onPick) {
      const options = targets.dsh ? [h('option', { key: 'dsh', value: 'dsh' }, t('launch.dshTarget'))] : []
      for (const agent of targets.ordered) {
        const detection = targets.detected[agent.id]
        const missing = Boolean(detection && detection.available === false)
        options.push(
          h('option', { key: agent.id, value: agent.id }, agent.label + (missing ? ' · ' + agentMissingLabel(t, detection) : '')),
        )
      }
      return h(
        'label',
        { key: 'agent-picker', className: 'adx-launch-agent' },
        h('span', { className: 'adx-launch-agent-label' }, t('launch.agent')),
        h(
          'select',
          {
            className: 'adx-select adx-launch-agent-select',
            value: targets.selected,
            disabled: busy,
            onChange: (event) => onPick(event.target.value),
          },
          options,
        ),
      )
    }

    /** One scenario of a launch menu; a pinned agent wins over the picked one, except for DSH. */
    function launchScenarioItem(t, scenario, targets, { label, disabled, isDefault, launch, launchDsh }) {
      const pinned = scenarioPinnedAgent(scenario, targets.agents)
      const toDsh = targets.selected === 'dsh'
      return h(
        'button',
        {
          key: 'scenario-' + scenario.id,
          type: 'button',
          role: 'menuitem',
          className: 'adx-launch-item',
          disabled,
          onClick: () => (toDsh ? launchDsh(scenario.id) : launch(scenario.id, pinned !== null ? pinned.id : targets.selected)),
        },
        h('span', { className: 'adx-launch-item-main' }, h('span', { className: 'adx-launch-item-label' }, label)),
        pinned !== null && !toDsh ? h('span', { className: 'adx-launch-badge' }, pinned.label) : null,
        isDefault ? h('span', { className: 'adx-launch-badge' }, t('launch.default')) : null,
      )
    }

    function outlineButton(label, onClick) {
      return h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick }, label)
    }

    /**
     * The row's snooze popover (launch-menu look and behaviour): until new
     * activity, until tomorrow or next Monday at SNOOZE_HOUR; a timed snooze
     * also ends early on new activity.
     */
    function snoozeMenu(t, { now, flip, menuRef, onPick, count }) {
      const title = count > 1 ? t('snooze.menuMany', { n: count }) : t('snooze.menu')
      const labels = {
        activity: [t('snooze.activity'), t('snooze.activityHint')],
        tomorrow: [t('snooze.tomorrowOption')],
        'next-week': [t('snooze.nextWeekOption')],
      }
      return h(
        'div',
        {
          className: 'adx-launch-menu adx-snooze-menu',
          role: 'menu',
          'aria-label': title,
          ref: menuRef,
          'data-flip': flip ? 'true' : 'false',
        },
        h('div', { className: 'adx-launch-menu-head' }, title),
        snoozeChoices(now).map((choice) =>
          h(
            'button',
            {
              key: choice.id,
              type: 'button',
              role: 'menuitem',
              className: 'adx-launch-item',
              'data-choice': choice.id,
              onClick: () => onPick(choice.until),
            },
            h(
              'span',
              { className: 'adx-launch-item-main' },
              h('span', { className: 'adx-launch-item-label' }, labels[choice.id][0]),
              h(
                'span',
                { className: 'adx-launch-item-hint' },
                choice.until === null ? labels[choice.id][1] : formatSnoozeTime(t, choice.until, now),
              ),
            ),
          ),
        ),
        h('p', { className: 'adx-launch-hint adx-snooze-note' }, t('snooze.note')),
      )
    }

    /**
     * Snoozes `items` (a row, a section's visible rows or the selection) and
     * shows one toast whose Undo restores every replaced entry.
     */
    function bulkSnooze(store, t, items, until) {
      const previous = store.snoozeItems(items, until)
      const n = Object.keys(previous).length
      if (n === 0) return
      const when = until === null ? '' : formatSnoozeTime(t, until, Date.now())
      const text =
        n === 1
          ? until === null ? t('snooze.toastActivity') : t('snooze.toastUntil', { when })
          : until === null ? t('snooze.toastManyActivity', { n }) : t('snooze.toastManyUntil', { n, when })
      store.showToast(text, 'neutral', { label: t('snooze.undo'), run: () => store.setSnoozes(previous) })
    }

    /**
     * The Select-mode checkbox (rows and section headers): a button with
     * role=checkbox, so Space and Enter toggle it; `checked` may be 'mixed'.
     */
    function selectCheckbox({ checked, label, onClick }) {
      const state = checked === 'mixed' ? 'mixed' : checked === true ? 'true' : 'false'
      return h(
        'button',
        { type: 'button', role: 'checkbox', className: 'adx-check', 'aria-checked': state, 'aria-label': label, title: label, onClick },
        icon(state === 'mixed' ? 'dash' : 'check', 12, 2),
      )
    }

    function bulkUnsnooze(store, t, ids) {
      const previous = store.unsnoozeIds(ids)
      const n = Object.keys(previous).length
      if (n === 0) return
      store.showToast(n === 1 ? t('snooze.toastUnsnoozed') : t('snooze.toastUnsnoozedMany', { n }), 'neutral', {
        label: t('snooze.undo'),
        run: () => store.setSnoozes(previous),
      })
    }

    function Row({
      item, tone, t, store, section, showSource, config, copied, menuOpen, snoozeMenuOpen, now, snoozed,
      selected, selectMode, onSelect,
    }) {
      const stateKey = rowStateKey(section, item)
      const muted = item.reason === 'new-unassigned' || item.rereviewCause === 'author-reply'
      const repo = shortRepo(item.repo)
      const author = item.author && item.author.login ? item.author.login : ''
      const reason = reasonText(t, item)
      const when = timeAgo(t, (item.lastActivity && item.lastActivity.at) || item.updatedAt || item.createdAt, now)
      const number = item.kind === 'branch' ? item.ref : item.number
      const rowTitle = item.kind === 'branch' ? t('branch.title', { ref: item.ref }) : item.title
      const glyph = item.kind === 'issue' ? 'issue' : item.kind === 'branch' ? 'branch' : 'pull'
      const meta = []
      if (showSource && item.source) {
        const sourceLabel = item.source.kind === 'user' ? t('source.personal') : item.source.login
        meta.push(h('span', { key: 'source', className: 'adx-meta-source' }, sourceLabel))
      }
      meta.push(h('span', { key: 'repo', className: 'adx-meta-repo' }, repo))
      meta.push(h('span', { key: 'num', className: 'adx-meta-num' }, item.kind === 'branch' ? number : '#' + number))
      if (author) meta.push(h('span', { key: 'author', className: 'adx-meta-author' }, author))
      if (item.kind === 'issue' && Array.isArray(item.assignees) && item.assignees.length > 0) {
        meta.push(h('span', { key: 'assignee' }, '@' + item.assignees.join(', @')))
      }
      if (reason) meta.push(h('span', { key: 'reason', title: item.reasonDetail || reason }, reason))
      if ((section === 'review' || section === 'rereview') && item.reviewDecision === 'APPROVED') {
        meta.push(h('span', { key: 'approved' }, t('meta.approvedByOthers')))
      }
      if (when) meta.push(h('span', { key: 'when' }, when))
      if (snoozed) {
        meta.push(
          h(
            'span',
            { key: 'snooze', className: 'adx-meta-snooze' },
            snoozed.until === null
              ? t('snooze.returnsActivity')
              : t('snooze.returnsAt', { when: formatSnoozeTime(t, snoozed.until, now) }),
          ),
        )
      }

      const copy = (event) => {
        event.preventDefault()
        event.stopPropagation()
        copyText(item.url).then(
          () => {
            store.set({ copied: stateKey })
            later(() => {
              if (store.get().copied === stateKey) store.set({ copied: null })
            }, 1600)
          },
          () => store.showToast(t('page.copyFailed'), 'warning'),
        )
      }
      const configuredDefault = configValue(config, 'defaultScenario')
      const defaultScenarioId = typeof configuredDefault === 'string' && configuredDefault !== '' ? configuredDefault : 'link'
      const itemScenarios = scenarioItemScenarios(config, section)
      const hasUrl = isGithubUrl(item.url)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const timersRef = useRef([])
      const [flipMenu, setFlipMenu] = useState(false)
      const [copiedClone, setCopiedClone] = useState(false)
      const [menuAgent, setMenuAgent] = useState('')
      const targets = launchTargets(config, menuAgent)

      const later = (callback, delay) => {
        const id = window.setTimeout(callback, delay)
        timersRef.current.push(id)
        return id
      }

      useEffect(() => {
        return () => {
          for (const id of timersRef.current) window.clearTimeout(id)
          timersRef.current = []
        }
      }, [])

      const { busy, launchError, setLaunchError, launch, launchDsh, retry } = useScenarioLaunch({
        store,
        t,
        buildRequest: (scenarioId) => ({
          scenario: scenarioId,
          url: item.url,
          kind: item.kind,
          number: item.number,
          title: item.title,
          headRefName: item.headRefName,
          ref: item.ref,
          author: author,
          reason: effectiveReason(item),
        }),
        close: () => closeMenu(),
        fallbackScenario: 'link',
        // An older host has no prompt route; say so instead of a bare HTTP 405.
        dshError: (base) => {
          const staleHost = /405/.test(String(base.message || '')) || base.code === 'http-405'
          return { code: 'dsh-failed', message: staleHost ? t('launch.dshHostOutdated') : String(base.message || '') }
        },
      })

      const setMenuOpen = (open) => {
        store.set({ openMenu: open ? stateKey : null })
        if (!open) setLaunchError(null)
      }
      const closeMenu = () => setMenuOpen(false)
      const openSettings = () => {
        closeMenu()
        store.set({ view: 'settings' })
      }
      useLaunchMenu({ open: menuOpen, close: closeMenu, menuRef, triggerRef, focusFirst: true, onFlip: setFlipMenu })

      const snoozeMenuRef = useRef(null)
      const snoozeTriggerRef = useRef(null)
      const [flipSnooze, setFlipSnooze] = useState(false)
      const closeSnoozeMenu = () => store.set({ openMenu: null })
      useLaunchMenu({
        open: snoozeMenuOpen,
        close: closeSnoozeMenu,
        menuRef: snoozeMenuRef,
        triggerRef: snoozeTriggerRef,
        focusFirst: true,
        onFlip: setFlipSnooze,
      })
      const pickSnooze = (until) => {
        closeSnoozeMenu()
        bulkSnooze(store, t, [item], until)
      }
      const unsnooze = (event) => {
        event.preventDefault()
        event.stopPropagation()
        bulkUnsnooze(store, t, [item.id])
      }

      const copyCloneCommand = () => {
        const command = launchError && typeof launchError.cloneCommand === 'string' ? launchError.cloneCommand : ''
        if (command === '') return
        copyText(command).then(
          () => {
            setCopiedClone(true)
            later(() => setCopiedClone(false), 1600)
          },
          () => store.showToast(t('page.copyFailed'), 'warning'),
        )
      }

      const errorTitle = launchError
        ? launchError.code === 'dsh-failed'
          ? t('launch.dshFailed')
          : launchError.code === 'clone-missing' && launchError.repo
            ? t('launch.cloneMissing', { repo: launchError.repo })
            : launchError.code === 'agent-missing'
              ? t('launch.agentMissing', { agent: launchError.label || '' })
              : t('launch.failed')
        : ''
      const errorHint = launchError
        ? launchError.code === 'clone-missing'
          ? t('launch.cloneHint')
          : String(launchError.message || '')
        : ''

      const menu = !menuOpen
        ? null
        : h(
            'div',
            {
              className: 'adx-launch-menu',
              role: 'menu',
              'aria-label': t('launch.openWith'),
              ref: menuRef,
              'data-flip': flipMenu ? 'true' : 'false',
            },
            h('div', { className: 'adx-launch-menu-head' }, busy ? t('launch.opening') : t('launch.openWith')),
            launchError
              ? h(
                  'div',
                  { className: 'adx-launch-error', role: 'alert' },
                  h('p', { className: 'adx-launch-error-title' }, errorTitle),
                  errorHint ? h('p', { className: 'adx-launch-hint' }, errorHint) : null,
                  h(
                    'div',
                    { className: 'adx-launch-error-actions' },
                    typeof launchError.cloneCommand === 'string' && launchError.cloneCommand !== ''
                      ? outlineButton(copiedClone ? t('launch.copied') : t('launch.copyClone'), copyCloneCommand)
                      : null,
                    outlineButton(t('launch.configure'), openSettings),
                    outlineButton(t('launch.retry'), retry),
                  ),
                )
              : null,
            targets.agents.length === 0 && !targets.dsh
              ? h(
                  'div',
                  { className: 'adx-launch-empty' },
                  h('p', null, t('launch.noAgents')),
                  h('p', { className: 'adx-launch-hint' }, t('launch.settingsHint')),
                  outlineButton(t('launch.configure'), openSettings),
                )
              : [
                  launchTargetPicker(t, targets, busy, setMenuAgent),
                  launchVia(t, config, targets),
                  h('div', { key: 'scenarios-head', className: 'adx-launch-group' }, t('launch.scenarios')),
                  ...itemScenarios.map((entry) =>
                    launchScenarioItem(t, entry, targets, {
                      label: scenarioTextLabel(entry, t),
                      disabled: busy,
                      isDefault: entry.id === defaultScenarioId,
                      launch,
                      launchDsh,
                    }),
                  ),
                ],
          )

      return h(
        'li',
        {
          className: 'adx-row',
          'data-tone': tone,
          'data-kind': item.kind,
          'data-muted': muted ? 'true' : 'false',
          'data-snoozed': snoozed ? 'true' : 'false',
          'data-selected': selectMode && selected ? 'true' : 'false',
          'data-select-mode': selectMode ? 'true' : 'false',
          'data-menu-open': menuOpen || snoozeMenuOpen ? 'true' : 'false',
          // Select mode: the whole row toggles its selection (Shift: a range).
          onClick: selectMode ? (event) => onSelect(item, event.shiftKey === true) : undefined,
        },
        selectMode
          ? h(
              'span',
              { className: 'adx-row-select' },
              selectCheckbox({
                checked: selected === true,
                label: t('select.row', { title: rowTitle }),
                onClick: (event) => {
                  event.stopPropagation()
                  onSelect(item, event.shiftKey === true)
                },
              }),
            )
          : null,
        h('span', { className: 'adx-row-glyph' }, icon(glyph, 16)),
        h(
          'span',
          { className: 'adx-row-main' },
          // In Select mode the title is plain text: a click selects, it never navigates.
          selectMode
            ? h('span', { className: 'adx-row-title', title: item.title }, rowTitle)
            : h(
                'a',
                {
                  className: 'adx-row-title',
                  href: item.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: item.title,
                },
                rowTitle,
              ),
          h('span', { className: 'adx-row-meta' }, meta),
        ),
        h(
          'span',
          { className: 'adx-row-end' },
          h(
            'span',
            { className: 'adx-row-pills' },
            item.kind === 'branch'
              ? h(Pill, { tone: 'outline' }, t('meta.branch'))
              : h(ChecksPill, { checks: item.checks, t }),
            item.kind === 'pull' && section !== 'review' && section !== 'rereview' ? h(ReviewPill, { item, t }) : null,
          ),
          selectMode ? null : h(
            'span',
            { className: 'adx-row-launch' },
            h(
              'button',
              {
                type: 'button',
                ref: triggerRef,
                className: 'adx-icon-btn adx-launch-btn',
                'data-active': menuOpen ? 'true' : 'false',
                title: t('launch.title'),
                'aria-label': t('launch.title'),
                'aria-haspopup': 'menu',
                'aria-expanded': menuOpen ? 'true' : 'false',
                disabled: hasUrl === false,
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenuOpen(!menuOpen)
                },
              },
              icon('terminal', 15),
            ),
            menu,
          ),
          selectMode ? null : h(
            'span',
            { className: 'adx-row-actions' },
            snoozed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'adx-btn adx-btn--outline adx-unsnooze',
                    title: t('snooze.unsnooze'),
                    'aria-label': t('snooze.unsnooze'),
                    onClick: unsnooze,
                  },
                  t('snooze.unsnooze'),
                )
              : snoozeFingerprint(item) === ''
                ? null
                : h(
                    'span',
                    { className: 'adx-row-snooze' },
                    h(
                      'button',
                      {
                        type: 'button',
                        ref: snoozeTriggerRef,
                        className: 'adx-icon-btn',
                        'data-active': snoozeMenuOpen ? 'true' : 'false',
                        title: t('snooze.button'),
                        'aria-label': t('snooze.button'),
                        'aria-haspopup': 'menu',
                        'aria-expanded': snoozeMenuOpen ? 'true' : 'false',
                        onClick: (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          store.set({ openMenu: snoozeMenuOpen ? null : 'snooze:' + stateKey })
                        },
                      },
                      icon('snooze', 14),
                    ),
                    snoozeMenuOpen
                      ? snoozeMenu(t, { now: Date.now(), flip: flipSnooze, menuRef: snoozeMenuRef, onPick: pickSnooze, count: 1 })
                      : null,
                  ),
            h(
              'button',
              {
                type: 'button',
                className: 'adx-icon-btn',
                title: copied ? t('page.copied') : t('page.copy'),
                'aria-label': copied ? t('page.copied') : t('page.copy'),
                onClick: copy,
              },
              icon(copied ? 'check' : 'copy', 14),
            ),
          ),
        ),
      )
    }

    // Shallow prop comparison: every prop is a primitive or a stable reference.
    Row = React.memo(Row)

    function Section({
      section, tone, t, store, collapsed, copiedId, openMenu, showSource, config, sectionItemsById, now, snoozed,
      snoozedView, selected, selectionAnchor, selectMode,
    }) {
      const id = section.id
      const items = section.items || []
      const menuId = 'section:' + id
      const menuOpen = openMenu === menuId
      const [menuAgent, setMenuAgent] = useState('')
      const menuRef = useRef(null)
      const triggerRef = useRef(null)

      const targets = launchTargets(config, menuAgent)
      const menuScenarios = sectionScenarios(config, 'section', id)
      const itemsById = sectionItemsById !== null && sectionItemsById !== undefined ? sectionItemsById : {}
      const unionItems = (scenario) => {
        const out = []
        const seen = new Set()
        const wanted = scenario !== null && scenario !== undefined && Array.isArray(scenario.sections) ? scenario.sections : []
        for (const sectionId of SECTION_ORDER) {
          if (wanted.indexOf(sectionId) === -1) continue
          for (const entry of itemsById[sectionId] || []) {
            if (entry === null || entry === undefined || seen.has(entry.id)) continue
            seen.add(entry.id)
            out.push(entry)
          }
        }
        return out
      }

      const { busy, launchError, setLaunchError, launch, launchDsh, retry } = useScenarioLaunch({
        store,
        t,
        buildRequest: (scenarioId) => {
          const scenario =
            configList(config, 'scenarios').find((entry) => entry !== null && entry !== undefined && entry.id === scenarioId) || null
          return { scenario: scenarioId, section: id, urls: scenario === null ? [] : unionItems(scenario).map((entry) => entry.url) }
        },
        close: () => closeMenu(),
        fallbackScenario: '',
      })

      const setOpen = (open) => {
        store.set({ openMenu: open ? menuId : null })
        if (!open) setLaunchError(null)
      }
      const closeMenu = () => setOpen(false)
      const openSettings = () => {
        closeMenu()
        store.set({ view: 'settings' })
      }
      useLaunchMenu({ open: menuOpen, close: closeMenu, menuRef, triggerRef })

      // Section-level snooze acts on the rows this section shows right now
      // (source filter and search applied); the Snoozed view unsnoozes them.
      const snoozeMenuId = 'snooze-section:' + id
      const snoozeOpen = openMenu === snoozeMenuId
      const snoozeMenuRef = useRef(null)
      const snoozeTriggerRef = useRef(null)
      const [flipSnooze, setFlipSnooze] = useState(false)
      const closeSnooze = () => store.set({ openMenu: null })
      useLaunchMenu({
        open: snoozeOpen,
        close: closeSnooze,
        menuRef: snoozeMenuRef,
        triggerRef: snoozeTriggerRef,
        focusFirst: true,
        onFlip: setFlipSnooze,
      })
      const snoozable = snoozedView ? [] : items.filter((item) => snoozeFingerprint(item) !== '')

      // Selection: a stable callback for the memoized rows; Shift+click
      // extends from the last toggled row of this section, in visible order.
      const selectRef = useRef(null)
      selectRef.current = (item, shift) => {
        const current = selected || {}
        const next = Object.assign({}, current)
        const order = items.map((entry) => entry.id)
        const from = shift && selectionAnchor && selectionAnchor.section === id ? order.indexOf(selectionAnchor.id) : -1
        const to = order.indexOf(item.id)
        if (from !== -1 && to !== -1) {
          for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) next[order[index]] = true
        } else if (next[item.id] === true) delete next[item.id]
        else next[item.id] = true
        store.set({ selected: next, selectionAnchor: { section: id, id: item.id } })
      }
      const onSelect = useMemo(() => (item, shift) => selectRef.current(item, shift), [])
      const chosen = selected !== null && selected !== undefined ? selected : {}
      const chosenHere = selectMode ? items.filter((item) => chosen[item.id] === true).length : 0
      // The header checkbox selects or clears every row of this section.
      const toggleSection = () => {
        const next = Object.assign({}, chosen)
        const all = chosenHere === items.length
        for (const item of items) {
          if (all) delete next[item.id]
          else next[item.id] = true
        }
        store.set({ selected: next, selectionAnchor: null })
      }

      const toggle = () => {
        const next = Object.assign({}, store.get().collapsed)
        next[id] = !collapsed
        store.set({ collapsed: next })
      }

      if (items.length === 0) return null

      const menu = !menuOpen
        ? null
        : h(
            'div',
            {
              className: 'adx-launch-menu',
              role: 'menu',
              'aria-label': t('launch.sectionScenarios'),
              ref: menuRef,
            },
            h('div', { className: 'adx-launch-menu-head' }, busy ? t('launch.opening') : t('launch.sectionScenarios')),
            launchError
              ? h(
                  'div',
                  { className: 'adx-launch-error', role: 'alert' },
                  h(
                    'p',
                    { className: 'adx-launch-error-title' },
                    launchError.code === 'clone-missing' && launchError.repo
                      ? t('launch.cloneMissing', { repo: launchError.repo })
                      : t('launch.failed'),
                  ),
                  h('p', { className: 'adx-launch-hint' }, String(launchError.message || '')),
                  h(
                    'div',
                    { className: 'adx-launch-error-actions' },
                    outlineButton(t('launch.configure'), openSettings),
                    outlineButton(t('launch.retry'), retry),
                  ),
                )
              : null,
            targets.agents.length === 0 && !targets.dsh
              ? h(
                  'div',
                  { className: 'adx-launch-empty' },
                  h('p', null, t('launch.noAgents')),
                  outlineButton(t('launch.configure'), openSettings),
                )
              : [
                  launchTargetPicker(t, targets, busy, setMenuAgent),
                  launchVia(t, config, targets),
                  ...menuScenarios.map((entry) => {
                    const union = unionItems(entry)
                    return launchScenarioItem(t, entry, targets, {
                      label: scenarioTextLabel(entry, t) + ' (' + union.length + ')',
                      disabled: busy || union.length === 0,
                      isDefault: false,
                      launch,
                      launchDsh,
                    })
                  }),
                ],
          )
      return h(
        'section',
        { className: 'adx-section', 'data-section': id },
        h(
          'div',
          { className: 'adx-section-head', 'data-menu-open': menuOpen || snoozeOpen ? 'true' : 'false' },
          selectMode
            ? selectCheckbox({
                checked: chosenHere === 0 ? false : chosenHere === items.length ? true : 'mixed',
                label: t('select.section', { section: t('section.' + id) }),
                onClick: (event) => {
                  event.stopPropagation()
                  toggleSection()
                },
              })
            : null,
          h('h2', { className: 'adx-section-title' }, t('section.' + id)),
          h('span', { className: 'adx-section-count' }, String(items.length)),
          h('span', { className: 'adx-section-spacer' }),
          h(
            'span',
            { className: 'adx-section-controls' },
            // Same order as a row: terminal, then snooze (or Unsnooze all), then
            // the chevron in the copy button's column, so the columns line up.
            // Select mode keeps only the chevron.
            selectMode ? null : h(
              'span',
              { className: 'adx-section-launch' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'adx-icon-btn adx-launch-btn',
                  'data-active': menuOpen ? 'true' : 'false',
                  title: t('launch.sectionTitle'),
                  'aria-label': t('launch.sectionTitle'),
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  disabled: menuScenarios.length === 0,
                  ref: triggerRef,
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setOpen(!menuOpen)
                  },
                },
                icon('terminal', 15),
              ),
              menu,
            ),
            h(
              'span',
              { className: 'adx-section-actions' },
              selectMode
                ? null
                : snoozedView
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'adx-btn adx-btn--outline adx-unsnooze',
                      title: t('snooze.unsnoozeAll', { n: items.length }),
                      'aria-label': t('snooze.unsnoozeAll', { n: items.length }),
                      onClick: (event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        bulkUnsnooze(store, t, items.map((item) => item.id))
                      },
                    },
                    t('snooze.unsnoozeAll', { n: items.length }),
                  )
                : snoozable.length === 0
                  ? null
                  : h(
                      'span',
                      { className: 'adx-row-snooze' },
                      h(
                        'button',
                        {
                          type: 'button',
                          ref: snoozeTriggerRef,
                          className: 'adx-icon-btn',
                          'data-active': snoozeOpen ? 'true' : 'false',
                          title: t('snooze.section', { n: snoozable.length }),
                          'aria-label': t('snooze.section', { n: snoozable.length }),
                          'aria-haspopup': 'menu',
                          'aria-expanded': snoozeOpen ? 'true' : 'false',
                          onClick: (event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            store.set({ openMenu: snoozeOpen ? null : snoozeMenuId })
                          },
                        },
                        icon('snooze', 14),
                      ),
                      snoozeOpen
                        ? snoozeMenu(t, {
                            now: Date.now(),
                            flip: flipSnooze,
                            menuRef: snoozeMenuRef,
                            count: snoozable.length,
                            onPick: (until) => {
                              closeSnooze()
                              bulkSnooze(store, t, snoozable, until)
                            },
                          })
                        : null,
                    ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'adx-section-toggle',
                  'aria-expanded': collapsed ? 'false' : 'true',
                  'aria-controls': 'adx-section-' + id,
                  title: collapsed ? t('page.expand') : t('page.collapse'),
                  'aria-label': collapsed ? t('page.expand') : t('page.collapse'),
                  onClick: toggle,
                },
                h('span', { className: 'adx-chevron', 'data-collapsed': collapsed ? 'true' : 'false' }, icon('chevron', 14)),
              ),
            ),
          ),
        ),
        collapsed
          ? null
          : (() => {
              const ordered = items
              const rows = []
              let triageHeadingAdded = false
              for (const item of ordered) {
                const triageOnly = item.reason === 'new-unassigned'
                if (id === 'issues' && triageOnly && !triageHeadingAdded) {
                  triageHeadingAdded = true
                  rows.push(
                    h(
                      'li',
                      { key: 'issues-new-heading', className: 'adx-subhead', 'aria-hidden': 'true' },
                      t('issues.newHeading'),
                    ),
                  )
                }
                rows.push(
                  h(Row, {
                    key: item.id,
                    item,
                    tone,
                    section: id,
                    t,
                    store,
                    showSource,
                    config,
                    copied: copiedId === rowStateKey(id, item),
                    menuOpen: openMenu === rowStateKey(id, item),
                    snoozeMenuOpen: openMenu === 'snooze:' + rowStateKey(id, item),
                    now,
                    snoozed: activeSnooze(snoozed, item, now),
                    selected: selectMode && chosen[item.id] === true,
                    selectMode,
                    onSelect,
                  }),
                )
              }
              return h('ul', { className: 'adx-list', id: 'adx-section-' + id }, rows)
            })(),
      )
    }

    // Shallow prop comparison: every prop is a primitive or a stable reference.
    Section = React.memo(Section)

    function Skeleton({ t }) {
      const rows = []
      for (let index = 0; index < 5; index += 1) {
        rows.push(
          h(
            'div',
            { className: 'adx-skeleton-row', key: index, 'aria-hidden': 'true' },
            h('div', { className: 'adx-skeleton-bar', 'data-width': 'short' }),
            h('div', { className: 'adx-skeleton-bar', 'data-width': 'meta' }),
          ),
        )
      }
      return h(
        'div',
        { className: 'adx-skeleton', role: 'status', 'aria-label': t('page.loading') },
        rows,
      )
    }

    function Notice({ tone, title, detail, actionLabel, onAction }) {
      return h(
        'div',
        { className: 'adx-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
        h(
          'p',
          null,
          title ? h('strong', null, title) : null,
          detail ? h('span', { className: 'adx-notice-detail' }, detail) : null,
        ),
        actionLabel ? h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: onAction }, actionLabel) : null,
      )
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          title: label,
          className: 'adx-switch',
          'data-on': checked ? 'true' : 'false',
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'adx-switch-knob' }),
      )
    }

    function Field({ label, hint, children, row, htmlFor, onToggle }) {
      const main = onToggle
        ? h(
            'button',
            { type: 'button', className: 'adx-field-toggle', onClick: onToggle },
            h('span', { className: 'adx-field-label' }, label),
            hint ? h('span', { className: 'adx-field-hint' }, hint) : null,
          )
        : h(
            'span',
            { className: 'adx-field-main' },
            h('span', { className: 'adx-field-label' }, label),
            hint ? h('span', { className: 'adx-field-hint' }, hint) : null,
          )
      if (row) {
        return h('div', { className: 'adx-field adx-field-row' }, main, children)
      }
      return h(
        'div',
        { className: 'adx-field' },
        h('label', { className: 'adx-field-label', htmlFor }, label),
        children,
        hint ? h('span', { className: 'adx-field-hint' }, hint) : null,
      )
    }

    /**
     * Configured agents plus the saved agents the host rejected
     * (`config.invalidAgents`, omitted from `config.agents`). The rejected rows
     * stay editable and flagged (`_rejectedCommand`) so the user can fix or
     * remove them; dropping them would delete them on the next save and orphan
     * the scenarios pinned to them.
     */
    function settingsFormAgents(config) {
      const rows = []
      const seen = new Set()
      const add = (agent, invalid) => {
        if (agent === null || typeof agent !== 'object' || seen.has(agent.id)) return
        seen.add(agent.id)
        const command = typeof agent.command === 'string' ? agent.command : ''
        rows.push({
          _key: newAgentRowKey(),
          ...(invalid ? { _rejectedCommand: command.trim() } : {}),
          id: agent.id,
          label: typeof agent.label === 'string' ? agent.label : '',
          command,
        })
      }
      for (const agent of configList(config, 'agents')) add(agent, false)
      for (const agent of configList(config, 'invalidAgents')) add(agent, true)
      return rows
    }

    /**
     * A host-rejected agent row whose command is still the rejected one. The
     * command rule lives on the host (it answers a save with `invalid-agent`),
     * so any edit clears the flag until the next save.
     */
    function agentRowUnusable(agent) {
      return typeof agent._rejectedCommand === 'string' && String(agent.command || '').trim() === agent._rejectedCommand
    }

    /** Derives the editable settings form from the public config. */
    function initialSettingsForm(config) {
      const form = {
        orgs: Array.isArray(config.orgs) ? config.orgs.join(', ') : typeof config.org === 'string' ? config.org : '',
        includePersonal: config.includePersonal !== false,
        refreshSeconds: String(config.refreshSeconds || 1200),
        requireGreenChecks: config.requireGreenChecks !== false,
        includeBotReviews: config.includeBotReviews === true,
        agents: settingsFormAgents(config),
        defaultAgent: typeof config.defaultAgent === 'string' ? config.defaultAgent : '',
        terminal: typeof config.terminal === 'string' ? config.terminal : 'auto',
        promptDelivery: config.promptDelivery === 'clipboard' ? 'clipboard' : 'paste',
        cloneDirs: Array.isArray(config.cloneDirs) ? config.cloneDirs.join('\n') : '',
        repoPaths:
          config.repoPaths !== null && typeof config.repoPaths === 'object' && !Array.isArray(config.repoPaths)
            ? Object.keys(config.repoPaths)
                .map((key) => key + ' = ' + config.repoPaths[key])
                .join('\n')
            : '',
        scenarios: Array.isArray(config.scenarios)
          ? config.scenarios.map((scenario) => ({
              _key: newAgentRowKey(),
              id: scenario.id,
              label: typeof scenario.label === 'string' ? scenario.label : '',
              scope: scenario.scope === 'section' ? 'section' : 'item',
              sections: Array.isArray(scenario.sections) ? scenario.sections.slice() : [],
              prompt: typeof scenario.prompt === 'string' ? scenario.prompt : '',
              agent: typeof scenario.agent === 'string' ? scenario.agent : 'default',
              enabled: scenario.enabled !== false,
            }))
          : [],
        defaultScenario: typeof config.defaultScenario === 'string' ? config.defaultScenario : 'link',
      }
      return {
        form,
        refreshCustom: !REFRESH_PRESETS.includes(Number(form.refreshSeconds)),
      }
    }

    function SettingsView({ t, store, state, onBack, onSaved, dirtyRef, onClean }) {
      const config = state.config
      // Render the form on the first pass when the config is already loaded, so
      // the server-side render smoke sees the real settings screen; a config that
      // arrives later is seeded by the effect below.
      const [initial] = useState(() => (config === null ? null : initialSettingsForm(config)))
      const [form, setForm] = useState(initial === null ? null : initial.form)
      const [notice, setNotice] = useState(null)
      const [saved, setSaved] = useState(false)
      const [refreshCustom, setRefreshCustom] = useState(initial === null ? false : initial.refreshCustom)
      const [scanState, setScanState] = useState(null)
      const [picking, setPicking] = useState(null)
      const [openScenario, setOpenScenario] = useState(null)
      const [findingAgents, setFindingAgents] = useState(false)
      const [invalidAgentKey, setInvalidAgentKey] = useState(null)
      const initialized = useRef(initial !== null)
      const baseline = useRef(initial === null ? null : Object.assign({}, initial.form))
      // Async readers (save confirmation, Find agents) need the latest committed
      // form; a layout effect publishes it during commit, before any later
      // event or promise callback can run.
      const currentForm = useRef(form)
      useLayoutEffect(() => {
        currentForm.current = form
      }, [form])

      useEffect(() => {
        void store.loadConfig()
        void store.loadAuth()
      }, [store])

      useEffect(() => {
        if (state.loginStatus !== 'launched') return undefined
        const timer = window.setInterval(() => {
          void store.loadAuth(true).then((auth) => {
            if (auth !== null && auth.authenticated === true) void store.load(true)
          })
        }, 4000)
        return () => window.clearInterval(timer)
      }, [state.loginStatus, store])

      useEffect(() => {
        if (config === null || initialized.current) return
        initialized.current = true
        const seeded = initialSettingsForm(config)
        baseline.current = Object.assign({}, seeded.form)
        setForm(seeded.form)
        setRefreshCustom(seeded.refreshCustom)
      }, [config])

      const update = (patch) => {
        setSaved(false)
        setForm((previous) => Object.assign({}, previous, typeof patch === 'function' ? patch(previous) : patch))
      }

      const updateAgent = (index, patch) => {
        // Editing the row a failed save pointed at clears that marker; a
        // host-rejected row stays flagged while it keeps the rejected command.
        if (form.agents[index] !== undefined && form.agents[index]._key === invalidAgentKey) setInvalidAgentKey(null)
        const agents = form.agents.map((agent, agentIndex) =>
          agentIndex === index ? Object.assign({}, agent, patch) : agent,
        )
        update({ agents })
      }

      const removeAgent = (index) => {
        const removed = form.agents[index]
        const agents = form.agents.filter((_agent, agentIndex) => agentIndex !== index)
        const updates = { agents }
        if (removed !== undefined && form.defaultAgent === removed.id) {
          updates.defaultAgent = agents.length > 0 ? agents[0].id : ''
        }
        update(updates)
      }

      const addCloneDir = (path) => {
        update((previous) => {
          const lines = String(previous.cloneDirs || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          if (!lines.includes(path)) lines.push(path)
          return { cloneDirs: lines.join('\n') }
        })
      }

      const addRepoPath = (repo, path) => {
        update((previous) => {
          const lines = String(previous.repoPaths || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => line.indexOf('=') === -1 || line.slice(0, line.indexOf('=')).trim() !== repo)
          lines.push(repo + ' = ' + path)
          return { repoPaths: lines.join('\n') }
        })
      }

      const pickPath = async (mode) => {
        if (picking !== null) return
        setPicking(mode)
        try {
          const payload = await postJson(mode === 'dir' ? '/triage-desk/pick-directory' : '/triage-desk/pick-clone', {})
          if (payload.path === null || payload.path === undefined) return
          if (mode === 'dir') addCloneDir(payload.path)
          else addRepoPath(payload.repo, payload.path)
        } catch (error) {
          setNotice({
            tone: 'error',
            text: t('settings.pickFailed') + ' ' + (error instanceof Error ? error.message : String(error)),
          })
        } finally {
          setPicking(null)
        }
      }

      const addAgent = () => {
        const taken = new Set(form.agents.map((agent) => agent.id))
        let suffix = form.agents.length + 1
        while (taken.has('agent-' + suffix)) suffix += 1
        const id = 'agent-' + suffix
        const agents = [...form.agents, { _key: newAgentRowKey(), id, label: '', command: '' }]
        const updates = { agents }
        if (form.defaultAgent === '' || form.defaultAgent === undefined) updates.defaultAgent = id
        update(updates)
      }

      const scenarioDefaults = () => configList(config, 'scenarioDefaults')

      const configLimit = (key, fallback) => {
        const limits = configValue(config, 'limits')
        return limits && Number.isInteger(limits[key]) ? limits[key] : fallback
      }
      const scenarioLimit = () => configLimit('scenarios', 30)
      const scenarioTemplateLimit = () => configLimit('scenarioTemplate', MAX_SCENARIO_TEMPLATE)

      const builtinScenarioIds = () => new Set(scenarioDefaults().map((entry) => entry.id))

      const updateScenario = (index, patch) => {
        const current = form.scenarios[index]
        const scenarios = form.scenarios.map((scenario, scenarioIndex) =>
          scenarioIndex === index ? Object.assign({}, scenario, patch) : scenario,
        )
        const updates = { scenarios }
        if (
          patch.scope === 'section' &&
          current !== undefined &&
          form.defaultScenario === current.id
        ) {
          const fallback = scenarios.find((scenario) => scenario.scope === 'item')
          updates.defaultScenario = fallback !== undefined ? fallback.id : ''
        }
        update(updates)
      }

      const removeScenario = (index) => {
        const scenario = form.scenarios[index]
        if (scenario === undefined || scenario.id === 'link') return
        const scenarios = form.scenarios.filter((_entry, scenarioIndex) => scenarioIndex !== index)
        const updates = { scenarios }
        if (form.defaultScenario === scenario.id) {
          const fallback = scenarios.find((entry) => entry.scope === 'item')
          updates.defaultScenario = fallback !== undefined ? fallback.id : ''
        }
        if (openScenario === scenario._key) setOpenScenario(null)
        update(updates)
      }

      const addScenario = () => {
        const taken = new Set(form.scenarios.map((entry) => entry.id))
        let suffix = form.scenarios.length + 1
        while (taken.has('scenario-' + suffix)) suffix += 1
        const scenario = {
          _key: newAgentRowKey(),
          id: 'scenario-' + suffix,
          label: '',
          scope: 'item',
          sections: ['review'],
          prompt: '',
          agent: 'default',
          enabled: true,
        }
        setOpenScenario(scenario._key)
        update({ scenarios: [...form.scenarios, scenario] })
      }

      const moveScenario = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= form.scenarios.length) return
        const scenarios = form.scenarios.slice()
        const moved = scenarios.splice(index, 1)[0]
        scenarios.splice(target, 0, moved)
        update({ scenarios })
      }

      const resetScenario = (index) => {
        const scenario = form.scenarios[index]
        if (scenario === undefined) return
        const fallback = scenarioDefaults().find((entry) => entry.id === scenario.id)
        if (fallback === undefined) return
        const scenarios = form.scenarios.map((entry, scenarioIndex) =>
          scenarioIndex === index
            ? Object.assign({}, entry, {
                label: '',
                scope: fallback.scope,
                sections: fallback.sections.slice(),
                prompt: fallback.prompt,
                agent: 'default',
                enabled: true,
              })
            : entry,
        )
        update({ scenarios })
      }

      const resetAllScenarios = () => {
        const scenarios = scenarioDefaults().map((entry) => ({
          _key: newAgentRowKey(),
          id: entry.id,
          label: '',
          scope: entry.scope,
          sections: entry.sections.slice(),
          prompt: entry.prompt,
          agent: 'default',
          enabled: true,
        }))
        const keepDefault = scenarios.some((entry) => entry.id === form.defaultScenario && entry.scope === 'item')
        setOpenScenario(null)
        update({ scenarios, defaultScenario: keepDefault ? form.defaultScenario : 'link' })
      }

      const findAgents = () => {
        if (findingAgents) return
        const scanAgents = form.agents
        const commandOf = (agent) => String(agent.command || '').trim()
        // Duplicate check only, not the command rule (that lives on the host):
        // the first word that is not a VAR=value assignment, unquoted. It keeps
        // rows typed during the scan, and an older host's answer, from adding
        // a second row for a program that is already configured.
        const programOf = (command) => {
          const words = String(command || '').trim().split(/\s+/)
          const word = words.find((entry) => entry !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) || ''
          return word.replace(/^['"]|['"]$/g, '')
        }
        setFindingAgents(true)
        setNotice(null)
        // The host parses these commands and skips agents whose executable one
        // of them already runs; an older host ignores the body.
        postJson(AGENTS_FIND_URL, { commands: scanAgents.map(commandOf).filter(Boolean) })
          .then((payload) => {
            // Rows edited or added during the scan, and an older host's whole
            // answer, are compared by exact command and by program word.
            // Scan-start rows stay reserved: discovery must not resurrect rows
            // removed meanwhile.
            const reserved = [...scanAgents, ...currentForm.current.agents]
            const commands = new Set(reserved.map(commandOf))
            const ids = new Set(reserved.map((agent) => agent.id))
            const executables = new Set(reserved.map((agent) => programOf(agent.command)).filter(Boolean))
            const additions = []
            for (const found of Array.isArray(payload.found) ? payload.found : []) {
              const command = commandOf(found)
              const executable =
                typeof found.executable === 'string' && found.executable !== '' ? found.executable : programOf(command)
              if (command === '' || commands.has(command) || executables.has(executable) || ids.has(found.id)) continue
              commands.add(command)
              if (executable !== '') executables.add(executable)
              ids.add(found.id)
              additions.push({ _key: newAgentRowKey(), id: found.id, label: found.label, command: found.command })
            }
            if (additions.length > 0) {
              // Functional merge: edits queued after this response are kept, and
              // rows they introduced still win over a discovered duplicate.
              update((previous) => {
                const live = previous.agents
                const liveCommands = new Set(live.map(commandOf))
                const livePrograms = new Set(live.map((agent) => programOf(agent.command)).filter(Boolean))
                const liveIds = new Set(live.map((agent) => agent.id))
                const fresh = additions.filter(
                  (agent) =>
                    !liveCommands.has(commandOf(agent)) && !livePrograms.has(programOf(agent.command)) && !liveIds.has(agent.id),
                )
                return { agents: [...live, ...fresh] }
              })
              setNotice({ tone: 'ok', text: t('settings.agentFound', { n: additions.length }) })
            } else {
              setNotice({ tone: 'ok', text: t('settings.agentFindNone') })
            }
          })
          .catch((error) =>
            setNotice({
              tone: 'error',
              text: t('settings.agentFindFailed', { message: String((error && error.message) || error) }),
            }),
          )
          .finally(() => setFindingAgents(false))
      }

      const scanClones = () => {
        setScanState({ status: 'loading' })
        getJson(CLONES_URL + '?refresh=1')
          .then((payload) => setScanState({ status: 'ready', payload }))
          .catch((error) =>
            setScanState({ status: 'error', error: String((error && error.message) || error) }),
          )
      }

      const dirty =
        form !== null && baseline.current !== null && JSON.stringify(form) !== JSON.stringify(baseline.current)

      // Lift the dirty state to Page's leave guard (Back, Cancel, header gear).
      useLayoutEffect(() => {
        if (dirtyRef) dirtyRef.current = dirty
        if (!dirty && onClean) onClean()
      }, [dirty])
      useLayoutEffect(
        () => () => {
          if (dirtyRef) dirtyRef.current = false
        },
        [],
      )

      const save = () => {
        if (form === null) return
        setNotice(null)
        setInvalidAgentKey(null)
        const agentIds = new Set()
        for (const agent of form.agents) {
          const id = String(agent.id || '').trim().toLowerCase()
          const label = String(agent.label || '').trim()
          const command = String(agent.command || '').trim()
          if (
            !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ||
            label === '' ||
            command === '' ||
            agentIds.has(id)
          ) {
            // Point at the row. The command rule itself is checked by the host
            // on save (an `invalid-agent` answer flags the row the same way).
            setInvalidAgentKey(agent._key)
            setNotice({ tone: 'error', text: t('settings.invalidAgent', { agent: label || id }) })
            return
          }
          agentIds.add(id)
        }
        if (agentIds.size === 0 || !agentIds.has(String(form.defaultAgent || '').trim().toLowerCase())) {
          setNotice({ tone: 'error', text: t('settings.invalidAgents') })
          return
        }
        const refreshValue = Number(form.refreshSeconds)
        if (!Number.isInteger(refreshValue) || refreshValue < 15 || refreshValue > 3600) {
          setNotice({ tone: 'error', text: t('settings.invalidRefresh') })
          return
        }
        const defaults = scenarioDefaults()
        const builtinIds = new Set(defaults.map((entry) => entry.id))
        const scenarioIds = new Set()
        let scenariosValid = form.scenarios.length > 0 && form.scenarios.length <= scenarioLimit()
        for (const scenario of form.scenarios) {
          if (scenariosValid === false) break
          const id = String(scenario.id || '').trim().toLowerCase()
          const label = String(scenario.label || '').trim()
          const prompt = String(scenario.prompt || '').trim()
          const sections = Array.isArray(scenario.sections) ? scenario.sections : []
          const agent = scenarioAgentValue(scenario)
          if (agent !== 'default' && !agentIds.has(agent)) {
            setNotice({
              tone: 'error',
              text: t('settings.invalidScenarioAgent', { scenario: scenarioTextLabel(scenario, t), agent }),
            })
            return
          }
          if (
            !SCENARIO_ID_PATTERN.test(id) ||
            scenarioIds.has(id) ||
            (label === '' && !builtinIds.has(id)) ||
            label.length > MAX_SCENARIO_LABEL ||
            (scenario.scope !== 'item' && scenario.scope !== 'section') ||
            sections.length === 0 ||
            sections.some((sectionId) => SECTION_ORDER.indexOf(sectionId) === -1) ||
            prompt === '' ||
            prompt.length > scenarioTemplateLimit() ||
            (id === 'link' && (scenario.enabled === false || prompt.indexOf('{url}') === -1))
          ) {
            scenariosValid = false
            break
          }
          scenarioIds.add(id)
        }
        const defaultEntry = form.scenarios.find(
          (scenario) => String(scenario.id || '').trim().toLowerCase() === form.defaultScenario,
        )
        if (
          scenariosValid === false ||
          defaultEntry === undefined ||
          defaultEntry.scope !== 'item' ||
          defaultEntry.enabled === false
        ) {
          setNotice({ tone: 'error', text: t('settings.invalidScenarios') })
          return
        }
        const parsedRepoPaths = parseRepoPathsText(form.repoPaths)
        if (parsedRepoPaths.invalidLine !== null) {
          setNotice({ tone: 'error', text: t('settings.invalidRepoPaths', { line: parsedRepoPaths.invalidLine }) })
          return
        }
        store
          .saveConfig({
            orgs: form.orgs
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
            includePersonal: form.includePersonal === true,
            refreshSeconds: Number(form.refreshSeconds),
            requireGreenChecks: form.requireGreenChecks === true,
            includeBotReviews: form.includeBotReviews === true,
            agents: form.agents.map((agent) => ({
              id: String(agent.id || '').trim().toLowerCase(),
              label: String(agent.label || '').trim(),
              command: String(agent.command || '').trim(),
            })),
            defaultAgent: String(form.defaultAgent || '').trim(),
            terminal: form.terminal || 'auto',
            promptDelivery: form.promptDelivery === 'clipboard' ? 'clipboard' : 'paste',
            cloneDirs: form.cloneDirs
              .split('\n')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
            repoPaths: parsedRepoPaths.paths,
            scenarios: form.scenarios.map((scenario) => ({
              id: String(scenario.id || '').trim().toLowerCase(),
              label: String(scenario.label || '').trim(),
              scope: scenario.scope,
              sections: Array.isArray(scenario.sections) ? scenario.sections.slice() : [],
              prompt: String(scenario.prompt || '').trim(),
              agent: scenarioAgentValue(scenario),
              enabled: scenario.enabled !== false,
            })),
            defaultScenario: String(form.defaultScenario || '').trim(),
          })
          .then(() => {
            baseline.current = Object.assign({}, form)
            const unchanged = JSON.stringify(currentForm.current) === JSON.stringify(form)
            setSaved(unchanged)
            setNotice(unchanged ? { tone: 'ok', text: t('settings.saved') } : null)
            if (onSaved) onSaved()
          })
          .catch((error) => {
            // The host's agent-command check names the agent (`invalid-agent`);
            // flag its row. An older host only sends the message.
            const detail = error && error.payload ? error.payload : {}
            const rejected =
              detail.code === 'invalid-agent'
                ? currentForm.current.agents.find((agent) => String(agent.id || '').trim().toLowerCase() === detail.agent)
                : undefined
            if (rejected !== undefined) setInvalidAgentKey(rejected._key)
            // Localize the rule for a named agent; an older host's plain
            // message is shown as it came.
            const text =
              detail.code === 'invalid-agent'
                ? t('settings.invalidAgentCommand', {
                    agent: (rejected !== undefined && String(rejected.label || '').trim()) || String(detail.agent || ''),
                  })
                : t('settings.error') + ': ' + String((error && error.message) || error)
            setNotice({ tone: 'error', text })
          })
      }

      const backButton = h(
        'button',
        { type: 'button', className: 'adx-form-head adx-form-head--button', onClick: onBack },
        h('span', { className: 'adx-form-head-icon' }, icon('back', 16)),
        h('span', { className: 'adx-form-back' }, t('page.back')),
      )

      if (form === null) {
        return h(
          'div',
          { className: 'adx-form' },
          backButton,
          state.configStatus === 'error'
            ? h(Notice, {
                tone: 'error',
                title: t('settings.error'),
                detail: state.configError || '',
                actionLabel: t('page.retry'),
                onAction: () => void store.loadConfig(),
              })
            : h('p', { className: 'adx-form-note' }, t('settings.loading')),
        )
      }

      const editable = config === null || config.editable !== false
      // `applying`: an older host accepted the save (202) and is restarting.
      const pendingSave = state.configStatus === 'saving' || state.configStatus === 'applying'
      const unusableAgents = form.agents.filter(agentRowUnusable)
      const durationLabel = (seconds) =>
        seconds >= 3600 ? t('settings.hours', { n: seconds / 3600 }) : t('settings.minutes', { n: seconds / 60 })
      const sourceLabels = configList(config, 'sources').map((source) =>
        source.kind === 'user' ? t('source.personal') : source.login,
      )
      const sourcesLine = sourceLabels.length > 0 ? t('settings.sourcesEffective', { list: sourceLabels.join(', ') }) : ''

      const checkAuth = () => {
        void store.loadAuth(true).then((auth) => {
          if (auth !== null && auth.authenticated === true) void store.load(true)
        })
      }
      const startLogin = () => {
        void store.loginGithub().catch(() => undefined)
      }
      const renderAuth = () => {
        const auth = state.auth
        const rows = []
        rows.push(
          h(
            'div',
            { className: 'adx-auth-head', key: 'head' },
            h('span', { className: 'adx-auth-title' }, t('settings.githubTitle')),
          ),
        )
        if (state.authStatus === 'loading' && auth === null) {
          rows.push(h('p', { className: 'adx-form-note', key: 'loading' }, t('settings.githubChecking')))
        }
        if (state.authError !== null) {
          rows.push(
            h(
              'p',
              { className: 'adx-form-note', key: 'error' },
              t('settings.githubAuthError', { message: state.authError }),
            ),
          )
        }
        if (auth !== null) {
          if (auth.available === false) {
            rows.push(h('p', { className: 'adx-auth-line', key: 'missing' }, t('settings.githubGhMissing')))
            rows.push(
              h(
                'p',
                { className: 'adx-form-note', key: 'install' },
                t('settings.githubInstall', {
                  command: (auth.install && auth.install.command) || 'brew install gh',
                  url: (auth.install && auth.install.url) || 'https://cli.github.com/',
                }),
              ),
            )
            rows.push(
              h(
                'div',
                { className: 'adx-auth-actions', key: 'missing-actions' },
                h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: checkAuth }, t('settings.githubCheck')),
              ),
            )
          } else if (auth.authenticated === true) {
            rows.push(
              h(
                'p',
                { className: 'adx-auth-line', key: 'connected' },
                t('settings.githubConnected', { login: auth.login || '' }),
              ),
            )
            rows.push(
              h(
                'div',
                { className: 'adx-auth-actions', key: 'actions' },
                h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: checkAuth }, t('settings.githubCheck')),
              ),
            )
          } else {
            rows.push(h('p', { className: 'adx-auth-line', key: 'offline' }, t('settings.githubNotLoggedIn')))
            rows.push(
              h(
                'div',
                { className: 'adx-auth-actions', key: 'login-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'adx-btn adx-btn--primary',
                    disabled: state.loginStatus === 'launching',
                    onClick: startLogin,
                  },
                  state.loginStatus === 'launching' ? t('settings.githubOpening') : t('settings.githubLogin'),
                ),
                h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: checkAuth }, t('settings.githubCheck')),
              ),
            )
            if (state.loginStatus === 'launched') {
              rows.push(h('p', { className: 'adx-form-note', key: 'waiting' }, t('settings.githubWaiting')))
            }
            if (state.loginStatus === 'error' && state.loginError !== null) {
              rows.push(
                h(
                  'p',
                  { className: 'adx-form-status', 'data-tone': 'error', key: 'login-error' },
                  t('settings.githubLoginFailed', { message: state.loginError }),
                ),
              )
            }
          }
        }
        return h('div', { className: 'adx-auth' }, rows)
      }

      const renderScenarios = () => {
        const builtinIds = builtinScenarioIds()
        const linkFirst = form.scenarios.length > 0 && form.scenarios[0] !== undefined && form.scenarios[0].id === 'link'
        const rows = form.scenarios.map((scenario, index) => {
          const isLink = scenario.id === 'link'
          const isBuiltin = builtinIds.has(scenario.id)
          const isOpen = openScenario === scenario._key
          const scopeLabel = t(scenario.scope === 'section' ? 'settings.scenarioScopeSection' : 'settings.scenarioScopeItem')
          const agentLabel = scenarioAgentHint(scenario, { agents: form.agents, defaultAgent: form.defaultAgent })
          const meta = [scopeLabel, agentLabel].filter((entry) => entry !== '').join(' · ')
          const body = isOpen
            ? h(
                'div',
                { className: 'adx-scenario-body' },
                h(
                  'div',
                  { className: 'adx-scenario-fields' },
                  h(
                    'label',
                    { className: 'adx-scenario-field' },
                    h('span', { className: 'adx-scenario-field-label' }, t('settings.agentName')),
                    h('input', {
                      className: 'adx-input',
                      value: scenario.label,
                      placeholder: isBuiltin ? t('scenario.' + scenario.id + '.name') : t('settings.agentName'),
                      spellCheck: false,
                      autoComplete: 'off',
                      onChange: (event) => updateScenario(index, { label: event.target.value }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'adx-scenario-field' },
                    h('span', { className: 'adx-scenario-field-label' }, t('settings.scenarioScope')),
                    isLink
                      ? h('span', { className: 'adx-input adx-input--static' }, t('settings.scenarioScopeItem'))
                      : h(
                          'select',
                          {
                            className: 'adx-select',
                            value: scenario.scope,
                            onChange: (event) => updateScenario(index, { scope: event.target.value }),
                          },
                          h('option', { value: 'item' }, t('settings.scenarioScopeItem')),
                          h('option', { value: 'section' }, t('settings.scenarioScopeSection')),
                        ),
                  ),
                  h(
                    'label',
                    { className: 'adx-scenario-field' },
                    h('span', { className: 'adx-scenario-field-label' }, t('settings.scenarioAgent')),
                    isLink
                      ? h('span', { className: 'adx-input adx-input--static' }, t('settings.scenarioAgentDefault'))
                      : h(
                          'select',
                          {
                            className: 'adx-select',
                            value: scenarioAgentValue(scenario),
                            onChange: (event) => updateScenario(index, { agent: event.target.value }),
                          },
                          h('option', { value: 'default' }, t('settings.scenarioAgentDefault')),
                          form.agents.map((agent) =>
                            h('option', { key: agent.id, value: agent.id }, agent.label || agent.id),
                          ),
                          // A pinned agent missing from the form must stay visible and
                          // selected, not fall back to the first option ("Default").
                          scenarioAgentValue(scenario) !== 'default' &&
                            !form.agents.some((agent) => agent.id === scenarioAgentValue(scenario))
                            ? h(
                                'option',
                                { key: 'unknown', value: scenarioAgentValue(scenario) },
                                t('settings.scenarioAgentUnknown', { agent: scenarioAgentValue(scenario) }),
                              )
                            : null,
                        ),
                  ),
                ),
                h(
                  'div',
                  { className: 'adx-scenario-field' },
                  h('span', { className: 'adx-scenario-field-label' }, t('settings.scenarioSections')),
                  h(
                    'div',
                    { className: 'adx-scenario-sections' },
                    SECTION_ORDER.map((sectionId) =>
                      h(
                        'button',
                        {
                          key: sectionId,
                          type: 'button',
                          className: 'adx-chip',
                          'aria-pressed': scenario.sections.indexOf(sectionId) !== -1 ? 'true' : 'false',
                          onClick: () => {
                            const sections =
                              scenario.sections.indexOf(sectionId) === -1
                                ? [...scenario.sections, sectionId]
                                : scenario.sections.filter((entry) => entry !== sectionId)
                            updateScenario(index, { sections })
                          },
                        },
                        t('section.' + sectionId),
                      ),
                    ),
                  ),
                ),
                h(
                  'label',
                  { className: 'adx-scenario-field' },
                  h('span', { className: 'adx-scenario-field-label' }, t('settings.scenarioPrompt')),
                  h('textarea', {
                    className: 'adx-textarea adx-scenario-prompt',
                    rows: 4,
                    value: scenario.prompt,
                    placeholder: t('settings.scenarioPrompt'),
                    spellCheck: false,
                    onChange: (event) => updateScenario(index, { prompt: event.target.value }),
                  }),
                ),
                h('p', { className: 'adx-form-note' }, t('settings.scenarioPromptHint')),
                isLink ? h('p', { className: 'adx-scenario-note' }, t('settings.scenarioProtected')) : null,
                h(
                  'details',
                  { className: 'adx-scenario-preview' },
                  h('summary', null, t('settings.scenarioPreview')),
                  h('pre', null, scenarioPreviewText(scenario, configValue(config, 'labels'))),
                ),
                h(
                  'div',
                  { className: 'adx-scenario-footer' },
                  h(
                    'span',
                    { className: 'adx-scenario-order' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'adx-icon-btn',
                        title: t('settings.scenarioUp'),
                        'aria-label': t('settings.scenarioUp'),
                        disabled: index === 0 || (linkFirst && index === 1),
                        onClick: () => moveScenario(index, -1),
                      },
                      '↑',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'adx-icon-btn',
                        title: t('settings.scenarioDown'),
                        'aria-label': t('settings.scenarioDown'),
                        disabled: index === form.scenarios.length - 1,
                        onClick: () => moveScenario(index, 1),
                      },
                      '↓',
                    ),
                  ),
                  isBuiltin
                    ? h(
                        'button',
                        { type: 'button', className: 'adx-btn adx-btn--outline', onClick: () => resetScenario(index) },
                        t('settings.scenarioReset'),
                      )
                    : null,
                  isLink
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'adx-btn adx-btn--outline', onClick: () => removeScenario(index) },
                        t('settings.scenarioRemove'),
                      ),
                ),
              )
            : null
          return h(
            'div',
            {
              key: scenario._key || 'scenario-' + index,
              className: 'adx-scenario',
              'data-open': isOpen ? 'true' : 'false',
              'data-disabled': scenario.enabled === false ? 'true' : 'false',
            },
            h(
              'div',
              { className: 'adx-scenario-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'adx-scenario-toggle',
                  'aria-expanded': isOpen ? 'true' : 'false',
                  onClick: () => setOpenScenario(isOpen ? null : scenario._key),
                },
                h(
                  'span',
                  { className: 'adx-scenario-open', 'data-open': isOpen ? 'true' : 'false' },
                  icon('chevron', 12),
                ),
                h(
                  'span',
                  { className: 'adx-scenario-summary' },
                  h('span', { className: 'adx-scenario-name' }, scenarioTextLabel(scenario, t)),
                  h(
                    'span',
                    { className: 'adx-scenario-meta' },
                    meta + (scenario.id === form.defaultScenario ? ' · ' + t('launch.default') : ''),
                  ),
                ),
              ),
              isLink
                ? null
                : h(Switch, {
                    checked: scenario.enabled !== false,
                    onChange: (value) => updateScenario(index, { enabled: value }),
                    label: t('settings.scenarioEnabled'),
                  }),
            ),
            body,
          )
        })
        const itemScenarios = form.scenarios.filter(
          (scenario) => scenario.scope === 'item' && scenario.enabled !== false,
        )
        return h(
          'div',
          { className: 'adx-scenarios' },
          h('p', { className: 'adx-form-section-title' }, t('settings.scenarios')),
          h('p', { className: 'adx-form-note' }, t('settings.scenariosHint')),
          rows,
          h(
            'div',
            { className: 'adx-form-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'adx-btn adx-btn--outline adx-agent-add',
                disabled: form.scenarios.length >= scenarioLimit(),
                onClick: addScenario,
              },
              t('settings.scenarioAdd'),
            ),
            h(
              'button',
              { type: 'button', className: 'adx-btn adx-btn--outline', onClick: resetAllScenarios },
              t('settings.scenarioResetAll'),
            ),
            h('span', { className: 'adx-spacer' }),
          ),
          h(
            Field,
            { label: t('settings.scenarioDefault'), htmlFor: 'adx-default-scenario' },
            h(
              'select',
              {
                id: 'adx-default-scenario',
                className: 'adx-select',
                value: form.defaultScenario,
                onChange: (event) => update({ defaultScenario: event.target.value }),
              },
              itemScenarios.map((scenario) =>
                h('option', { key: scenario.id, value: scenario.id }, scenarioTextLabel(scenario, t)),
              ),
            ),
          ),
        )
      }

      /** Terminal app picker: Automatic plus this platform's apps, uninstalled ones disabled. */
      function renderTerminalChoice() {
        const scan = configValue(config, 'terminals')
        if (scan === null || scan === undefined || !Array.isArray(scan.options) || scan.options.length === 0) return null
        const selected = scan.options.find((entry) => entry.id === form.terminal && entry.available)
        const effective = selected || scan.options.find((entry) => entry.id === scan.auto) || null
        const label = effective ? effective.label : scan.autoLabel
        const hint = label === ''
          ? null
          : t(effective && effective.tabs ? 'settings.terminalTabs' : 'settings.terminalWindows', { app: label })
        return h(
          Field,
          { label: t('settings.terminalApp'), htmlFor: 'adx-terminal', hint },
          h(
            'select',
            {
              id: 'adx-terminal',
              className: 'adx-select',
              value: form.terminal === 'auto' || scan.options.some((entry) => entry.id === form.terminal) ? form.terminal : 'auto',
              onChange: (event) => update({ terminal: event.target.value }),
            },
            h(
              'option',
              { value: 'auto' },
              scan.autoLabel ? t('settings.terminalAuto', { app: scan.autoLabel }) : t('settings.terminalAutoNone'),
            ),
            scan.options.map((entry) =>
              h(
                'option',
                { key: entry.id, value: entry.id, disabled: !entry.available && entry.id !== form.terminal },
                entry.available ? entry.label : t('settings.terminalMissing', { app: entry.label }),
              ),
            ),
          ),
        )
      }

      /** Two radio cards: type the prompt into the agent (default) or copy it to the clipboard. */
      function renderPromptDelivery() {
        const paste = configValue(config, 'promptPaste')
        const blocked = paste && paste.available === false ? paste.reason : null
        const keys = pasteKeys(configValue(config, 'platform'))
        const choices = [
          {
            value: 'paste',
            title: t('settings.deliveryPaste'),
            hint: t('settings.deliveryPasteHint'),
            badge: t('settings.deliveryRecommended'),
            warning: blocked ? t('settings.pasteUnavailable.' + blocked) : null,
          },
          { value: 'clipboard', title: t('settings.deliveryClipboard'), hint: t('settings.deliveryClipboardHint', { keys }) },
        ]
        const current = form.promptDelivery === 'clipboard' ? 'clipboard' : 'paste'
        const move = (event) => {
          if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
          event.preventDefault()
          const next = current === 'paste' ? 'clipboard' : 'paste'
          update({ promptDelivery: next })
          const target = event.currentTarget.querySelector('[data-value="' + next + '"]')
          if (target && typeof target.focus === 'function') target.focus()
        }
        return h(
          'div',
          { className: 'adx-field' },
          h('span', { className: 'adx-field-label', id: 'adx-delivery-label' }, t('settings.promptDelivery')),
          h(
            'div',
            { className: 'adx-choices', role: 'radiogroup', 'aria-labelledby': 'adx-delivery-label', onKeyDown: move },
            choices.map((choice) =>
              h(
                'button',
                {
                  key: choice.value,
                  type: 'button',
                  role: 'radio',
                  className: 'adx-choice',
                  'data-value': choice.value,
                  'aria-checked': current === choice.value ? 'true' : 'false',
                  tabIndex: current === choice.value ? 0 : -1,
                  onClick: () => update({ promptDelivery: choice.value }),
                },
                h('span', { className: 'adx-choice-dot', 'aria-hidden': 'true' }),
                h(
                  'span',
                  { className: 'adx-choice-body' },
                  h(
                    'span',
                    { className: 'adx-choice-title' },
                    choice.title,
                    choice.badge ? h('span', { className: 'adx-choice-badge' }, choice.badge) : null,
                  ),
                  h('span', { className: 'adx-choice-hint' }, choice.hint),
                  choice.warning ? h('span', { className: 'adx-choice-warning', role: 'note' }, choice.warning) : null,
                ),
              ),
            ),
          ),
          h('span', { className: 'adx-field-hint' }, t('settings.promptDeliveryHint')),
        )
      }

      return h(
        'div',
        { className: 'adx-form' },
        backButton,
        state.saveError !== null
          ? h(Notice, {
              tone: 'warning',
              title: t('settings.saveErrorTitle'),
              detail: t('settings.saveErrorDetail', {
                message: String(state.saveError.message || state.saveError),
              }),
              actionLabel: t('page.retry'),
              onAction: () => void store.loadConfig(),
            })
          : null,
        renderAuth(),
        h(
          Field,
          {
            label: t('settings.orgs'),
            htmlFor: 'adx-orgs',
            hint: (sourcesLine ? sourcesLine + ' — ' : '') + t('settings.orgsHint'),
          },
          h('input', {
            id: 'adx-orgs',
            type: 'text',
            className: 'adx-input',
            value: form.orgs,
            placeholder: t('settings.orgsPlaceholder'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => update({ orgs: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: t('settings.personal'), hint: t('settings.personalHint'), row: true, onToggle: () => update({ includePersonal: form.includePersonal !== true }) },
          h(Switch, {
            checked: form.includePersonal === true,
            onChange: (value) => update({ includePersonal: value }),
            label: t('settings.personal'),
          }),
        ),
        h(
          Field,
          { label: t('settings.refresh'), hint: t('settings.refreshHint'), htmlFor: 'adx-refresh' },
          h(
            'div',
            { className: 'adx-select-custom' },
            h(
              'select',
              {
                id: 'adx-refresh',
                className: 'adx-select',
                value: refreshCustom ? 'custom' : form.refreshSeconds,
                onChange: (event) => {
                  if (event.target.value === 'custom') {
                    setRefreshCustom(true)
                    return
                  }
                  setRefreshCustom(false)
                  update({ refreshSeconds: event.target.value })
                },
              },
              REFRESH_PRESETS.map((seconds) =>
                h('option', { key: seconds, value: String(seconds) }, durationLabel(seconds)),
              ),
              h('option', { value: 'custom' }, t('settings.custom')),
            ),
            refreshCustom
              ? h(
                  'span',
                  { className: 'adx-custom-wrap' },
                  h('input', {
                    type: 'number',
                    className: 'adx-input adx-custom-number',
                    min: 1,
                    max: 60,
                    step: 1,
                    value: String(Number(form.refreshSeconds) / 60),
                    'aria-label': t('settings.refresh'),
                    onChange: (event) => {
                      const minutes = Number(event.target.value)
                      update({
                        refreshSeconds: Number.isFinite(minutes) ? String(Math.round(minutes * 60)) : '',
                      })
                    },
                  }),
                  h('span', { className: 'adx-custom-unit' }, t('settings.minuteUnit')),
                )
              : null,
          ),
        ),
        h(
          Field,
          { label: t('settings.green'), hint: t('settings.greenHint'), row: true, onToggle: () => update({ requireGreenChecks: !(form.requireGreenChecks === true) }) },
          h(Switch, {
            checked: form.requireGreenChecks === true,
            onChange: (value) => update({ requireGreenChecks: value }),
            label: t('settings.green'),
          }),
        ),
        h(
          Field,
          { label: t('settings.bots'), hint: t('settings.botsHint'), row: true, onToggle: () => update({ includeBotReviews: !(form.includeBotReviews === true) }) },
          h(Switch, {
            checked: form.includeBotReviews === true,
            onChange: (value) => update({ includeBotReviews: value }),
            label: t('settings.bots'),
          }),
        ),
        h('p', { className: 'adx-form-note' }, t('settings.applyHint')),
        h(
          'details',
          { className: 'adx-advanced' },
          h('summary', { className: 'adx-advanced-summary' }, t('settings.terminal')),
          h('p', { className: 'adx-form-note' }, t('settings.terminalHint')),
          renderTerminalChoice(),
          renderPromptDelivery(),
        h(
          Field,
          { label: t('settings.defaultAgent'), htmlFor: 'adx-default-agent' },
          h(
            'select',
            {
              id: 'adx-default-agent',
              className: 'adx-select',
              value: form.defaultAgent,
              onChange: (event) => update({ defaultAgent: event.target.value }),
            },
            form.agents.map((agent) =>
              h('option', { key: agent.id, value: agent.id }, agent.label || agent.id),
            ),
          ),
        ),
        h(
          'div',
          { className: 'adx-agents' },
          unusableAgents.length > 0
            ? h(
                'div',
                { className: 'adx-notice adx-agents-unusable', 'data-tone': 'warning', role: 'status' },
                h(
                  'p',
                  null,
                  h('strong', null, t('settings.agentsUnusable', { n: unusableAgents.length })),
                  h('span', { className: 'adx-notice-detail' }, t('settings.agentsUnusableHint')),
                ),
              )
            : null,
          form.agents.map((agent, index) => {
            const flagged = agentRowUnusable(agent) || agent._key === invalidAgentKey
            const key = agent._key || 'agent-row-' + index
            return [
              h(
                'div',
                { className: 'adx-agent-row', key, 'data-invalid': flagged ? 'true' : 'false' },
                h('input', {
                  className: 'adx-input',
                  value: agent.label,
                  placeholder: t('settings.agentName'),
                  'aria-label': t('settings.agentName'),
                  spellCheck: false,
                  onChange: (event) => updateAgent(index, { label: event.target.value }),
                }),
                h('input', {
                  className: 'adx-input adx-agent-command',
                  value: agent.command,
                  placeholder: 'claude {prompt}',
                  'aria-label': t('settings.agentCommand'),
                  'aria-invalid': flagged ? 'true' : 'false',
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: (event) => updateAgent(index, { command: event.target.value }),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'adx-icon-btn',
                    title: t('settings.agentRemove'),
                    'aria-label': t('settings.agentRemove'),
                    disabled: form.agents.length <= 1,
                    onClick: () => removeAgent(index),
                  },
                  icon('close', 14),
                ),
              ),
              flagged
                ? h(
                    'p',
                    { key: key + ':invalid', className: 'adx-agent-invalid-note', role: 'note' },
                    agentRowUnusable(agent) ? t('settings.agentUnusableRow') : t('settings.agentInvalidRow'),
                  )
                : null,
            ]
          }),
          h(
            'div',
            { className: 'adx-form-actions' },
            h(
              'button',
              { type: 'button', className: 'adx-btn adx-btn--outline adx-agent-add', onClick: addAgent },
              t('settings.agentAdd'),
            ),
            configValue(config, 'supportsAgentDiscovery') === true
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'adx-btn adx-btn--outline',
                    disabled: findingAgents,
                    onClick: findAgents,
                  },
                  findingAgents ? t('settings.agentFinding') : t('settings.agentFind'),
                )
              : null,
            h('span', { className: 'adx-spacer' }),
          ),
          h('p', { className: 'adx-form-note' }, t('settings.agentsHint')),
        ),
        renderScenarios(),
        ),
        h(
          'details',
          { className: 'adx-advanced' },
          h('summary', { className: 'adx-advanced-summary' }, t('settings.advanced')),
          h('p', { className: 'adx-form-note' }, t('settings.advancedHint')),
        h(
          Field,
          {
            label: t('settings.cloneDirs'),
            htmlFor: 'adx-clone-dirs',
            hint: t('settings.cloneDirsHint', {
              list: configList(config, 'cloneDirsDefault').join(', '),
            }),
          },
          h('div', { className: 'adx-path-edit' },
            h('textarea', {
              id: 'adx-clone-dirs',
              className: 'adx-textarea',
              rows: 3,
              value: form.cloneDirs,
              placeholder: t('settings.cloneDirsPlaceholder'),
              spellCheck: false,
              onChange: (event) => update({ cloneDirs: event.target.value }),
            }),
            h('div', { className: 'adx-path-actions' },
              h('button', {
                type: 'button',
                className: 'adx-btn adx-btn--outline',
                disabled: picking !== null,
                onClick: () => void pickPath('dir'),
              }, picking === 'dir' ? t('settings.picking') : t('settings.pickFolder')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'adx-scan' },
          h(
            'button',
            {
              type: 'button',
              className: 'adx-btn adx-btn--outline',
              onClick: scanClones,
              disabled: scanState !== null && scanState.status === 'loading',
            },
            scanState !== null && scanState.status === 'loading' ? t('settings.scanning') : t('settings.scan'),
          ),
          scanState !== null && scanState.status === 'ready'
            ? h(
                'span',
                { className: 'adx-scan-result' },
                (scanState.payload.clones || []).length > 0
                  ? t('settings.scanResult', { n: (scanState.payload.clones || []).length })
                  : t('settings.scanEmpty'),
              )
            : null,
          scanState !== null && scanState.status === 'error'
            ? h('span', { className: 'adx-scan-result', 'data-tone': 'error' }, t('settings.scanFailed'))
            : null,
        ),
        scanState !== null && scanState.status === 'ready' && (scanState.payload.clones || []).length > 0
          ? h(
              'div',
              { className: 'adx-scan-clones' },
              (scanState.payload.clones || []).slice(0, 8).map((clone) =>
                h(
                  'div',
                  { className: 'adx-scan-clone', key: clone.path },
                  h('span', { className: 'adx-scan-clone-repo' }, clone.repo),
                  h('span', { className: 'adx-scan-clone-path', title: clone.path }, clone.path),
                ),
              ),
            )
          : null,
        h(
          Field,
          { label: t('settings.repoPaths'), htmlFor: 'adx-repo-paths', hint: t('settings.repoPathsHint') },
          h('div', { className: 'adx-path-edit' },
            h('textarea', {
              id: 'adx-repo-paths',
              className: 'adx-textarea',
              rows: 2,
              value: form.repoPaths,
              placeholder: t('settings.repoPathsPlaceholder'),
              spellCheck: false,
              onChange: (event) => update({ repoPaths: event.target.value }),
            }),
            h('div', { className: 'adx-path-actions' },
              h('button', {
                type: 'button',
                className: 'adx-btn adx-btn--outline',
                disabled: picking !== null,
                onClick: () => void pickPath('clone'),
              }, picking === 'clone' ? t('settings.picking') : t('settings.pickClone')),
            ),
          ),
        ),
        ),
        h('p', { className: 'adx-form-note' }, t('settings.terminalNote')),
        h(
          'div',
          { className: 'adx-form-actions' },
          saved
            ? h(
                'button',
                { type: 'button', className: 'adx-btn adx-btn--primary', onClick: onBack },
                t('settings.done'),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'adx-btn adx-btn--primary',
                  onClick: save,
                  disabled: !editable || !dirty || pendingSave,
                },
                pendingSave ? t('settings.saving') : t('settings.save'),
              ),
          saved ? null : h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: onBack }, t('settings.cancel')),
          h('span', { className: 'adx-spacer' }),
        ),
        state.configStatus === 'applying'
          ? h('p', { className: 'adx-form-status', 'data-tone': 'warning', role: 'status' }, t('settings.applying'))
          : null,
        notice
          ? h('p', { className: 'adx-form-status', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
          : null,
        state.configStatus === 'error' && notice === null
          ? h('p', { className: 'adx-form-status', 'data-tone': 'error', role: 'alert' }, t('settings.error') + ': ' + (state.configError || ''))
          : null,
        editable ? null : h('p', { className: 'adx-form-status', 'data-tone': 'error' }, t('settings.unavailable')),
      )
    }

    /**
     * The Select-mode bar, sticky at the bottom of the scroll area. Without a
     * selection it hints what to do; with one it offers Snooze (the row snooze
     * popover, opened upward) or, in the Snoozed view, Unsnooze, Select all /
     * Deselect all over every visible row, and Done. A bulk action ends the mode.
     */
    function SelectionBar({ t, store, items, allItems, snoozedView, menuOpen, onDone }) {
      const menuRef = useRef(null)
      const triggerRef = useRef(null)
      const close = () => store.set({ openMenu: null })
      useLaunchMenu({ open: menuOpen, close, menuRef, triggerRef, focusFirst: true })
      const n = items.length
      const selectAll = (all) => {
        const next = {}
        if (all) for (const item of allItems) next[item.id] = true
        store.set({ selected: next, selectionAnchor: null, ...(menuOpen ? { openMenu: null } : {}) })
      }
      const action =
        n === 0
          ? null
          : snoozedView
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'adx-btn adx-btn--outline',
                  onClick: () => {
                    bulkUnsnooze(store, t, items.map((item) => item.id))
                    onDone()
                  },
                },
                t('snooze.unsnooze'),
              )
            : h(
                'span',
                { className: 'adx-row-snooze' },
                h(
                  'button',
                  {
                    type: 'button',
                    ref: triggerRef,
                    className: 'adx-btn adx-btn--outline adx-selection-snooze',
                    'data-active': menuOpen ? 'true' : 'false',
                    'aria-haspopup': 'menu',
                    'aria-expanded': menuOpen ? 'true' : 'false',
                    onClick: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      store.set({ openMenu: menuOpen ? null : 'snooze:selection' })
                    },
                  },
                  icon('snooze', 14),
                  t('snooze.button'),
                  icon('chevron', 12),
                ),
                menuOpen
                  ? snoozeMenu(t, {
                      now: Date.now(),
                      flip: true,
                      menuRef,
                      count: n,
                      onPick: (until) => {
                        bulkSnooze(store, t, items, until)
                        onDone()
                      },
                    })
                  : null,
              )
      return h(
        'div',
        { className: 'adx-selection-bar', role: 'toolbar', 'aria-label': t('select.bar'), 'data-menu-open': menuOpen ? 'true' : 'false' },
        h(
          'span',
          { className: 'adx-selection-count', role: 'status', 'data-empty': n === 0 ? 'true' : 'false' },
          n === 0 ? t(snoozedView ? 'select.hintUnsnooze' : 'select.hint') : t('select.count', { n }),
        ),
        h('span', { className: 'adx-section-spacer' }),
        action,
        n === 0
          ? null
          : n < allItems.length
            ? h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: () => selectAll(true) }, t('select.all'))
            : h('button', { type: 'button', className: 'adx-btn adx-btn--outline', onClick: () => selectAll(false) }, t('select.none')),
        h('button', { type: 'button', className: 'adx-btn adx-btn--primary', onClick: onDone }, t('select.done')),
      )
    }

    function Page(props) {
      const t = props.t || ((key) => key)
      const store = props.store || runtime.store
      const state = useStore(store)
      const [search, setSearch] = useState('')
      const [stuck, setStuck] = useState(false)
      const scrollRef = useRef(null)
      // Written by SettingsView in a layout effect, so the gear/Back/Cancel
      // guard reads the committed dirty state without waiting for a re-render.
      const settingsDirtyRef = useRef(false)
      const [confirmLeave, setConfirmLeave] = useState(false)
      const [tick, setTick] = useState(() => Date.now())

      // Relative times ("updated 3 min ago", row ages) advance once a minute
      // while the page is mounted; `now` reaches memoized Section/Row as a prop.
      useEffect(() => {
        let id = null
        const advance = () => {
          setTick(Date.now())
          id = window.setTimeout(advance, MINUTE_MS)
        }
        id = window.setTimeout(advance, MINUTE_MS)
        return () => window.clearTimeout(id)
      }, [])

      useEffect(() => {
        if (store.get().config === null) void store.loadConfig()
      }, [store])

      const data = state.data
      const snoozed = state.snoozed
      const sections = (data && data.sections) || []
      const sources = (data && data.sources) || []
      const sourceLabels = sources.map((source) => (source.kind === 'user' ? t('source.personal') : source.login))
      const user = data && data.user ? data.user : null
      const settings = (data && data.settings) || {}
      const sourcesAuto = settings.sourcesAuto === true
      const showSources = sources.length > 1
      const updated = clock(data && data.generatedAt)
      const status = state.status
      const view = state.view || 'list'
      // A fresh snapshot is measured from its load time, not the last tick.
      const now = Math.max(tick, Number(state.loadedAt) || 0)

      const query = search.trim().toLowerCase()
      const activeFilter = state.filter || 'all'
      const sourceKeys = new Set(sources.map((source) => source.kind + ':' + source.login))
      const requestedSource = state.sourceFilter || 'all'
      const activeSource = requestedSource === 'all' || sourceKeys.has(requestedSource) ? requestedSource : 'all'

      // Every count is the number of rows the list shows: the source filter,
      // the search and snoozing apply to the section chips as well. Snoozed
      // items only appear in the Snoozed view (`filter: 'snoozed'`).
      const listing = useMemo(() => {
        const snoozedIds = new Set()
        const anySnoozed = new Set()
        const normal = []
        const snoozedList = []
        for (const section of sections) {
          if (!section || !Array.isArray(section.items)) continue
          const shown = []
          const hidden = []
          for (const item of section.items) {
            const asleep = isSnoozed(snoozed, item, now)
            if (asleep) anySnoozed.add(item.id)
            if (!itemMatchesSource(item, activeSource) || !itemMatchesQuery(item, query)) continue
            if (!asleep) shown.push(item)
            else {
              snoozedIds.add(item.id)
              hidden.push(item)
            }
          }
          normal.push({ id: section.id, items: shown })
          snoozedList.push({ id: section.id, items: hidden })
        }
        return { normal, snoozedList, snoozedCount: snoozedIds.size, snoozedTotal: anySnoozed.size }
      }, [sections, activeSource, query, snoozed, now])
      const snoozedView = activeFilter === 'snoozed'
      const snoozedCount = listing.snoozedCount
      const sectionCounts = {}
      for (const section of listing.normal) sectionCounts[section.id] = (sectionCounts[section.id] || 0) + section.items.length
      const allCount = listing.normal.reduce((sum, section) => sum + section.items.length, 0)
      const visible = useMemo(
        () =>
          (snoozedView ? listing.snoozedList : listing.normal).filter(
            (section) => (snoozedView || activeFilter === 'all' || section.id === activeFilter) && section.items.length > 0,
          ),
        [listing, activeFilter, snoozedView],
      )
      // Section launches act on the visible rows, never on snoozed ones.
      const launchItemsById = useMemo(() => {
        const map = {}
        if (!snoozedView) for (const entry of visible) map[entry.id] = entry.items
        return map
      }, [visible, snoozedView])
      // The header total is the attention badge for the selected source.
      const total = attentionCount(sections, snoozed, (item) => itemMatchesSource(item, activeSource), now)
      const previousFilter = state.filterBeforeSnoozed && state.filterBeforeSnoozed !== 'snoozed' ? state.filterBeforeSnoozed : 'all'
      const toggleSnoozedView = () =>
        store.set(snoozedView ? { filter: previousFilter } : { filter: 'snoozed', filterBeforeSnoozed: activeFilter })

      // Unsnoozing (or the return of) the last snoozed item leaves the Snoozed view.
      useEffect(() => {
        if (snoozedView && listing.snoozedTotal === 0) store.set({ filter: previousFilter })
      }, [snoozedView, listing.snoozedTotal])

      // Select mode: a selection (by item id) of rows the list shows.
      const selectMode = state.selectMode === true && view === 'list'
      const selected = state.selected || {}
      const visibleItems = useMemo(() => {
        const out = []
        const seen = new Set()
        for (const section of visible) {
          for (const item of section.items) {
            if (!seen.has(item.id)) {
              seen.add(item.id)
              out.push(item)
            }
          }
        }
        return out
      }, [visible])
      const selectedItems = useMemo(() => visibleItems.filter((item) => selected[item.id] === true), [visibleItems, selected])
      const enterSelect = () => store.set({ selectMode: true, selected: {}, selectionAnchor: null, openMenu: null })
      const exitSelect = () => store.set({ selectMode: false, selected: {}, selectionAnchor: null, openMenu: null })
      // A filter, source or search change keeps the mode but starts a new selection.
      const selectionScope = activeFilter + '\n' + activeSource + '\n' + query
      const scopeRef = useRef(selectionScope)
      useEffect(() => {
        if (scopeRef.current === selectionScope) return
        scopeRef.current = selectionScope
        if (Object.keys(store.get().selected || {}).length > 0) store.set({ selected: {}, selectionAnchor: null })
      }, [selectionScope])
      // Ids the list no longer shows (refresh, snooze, new activity) leave the selection.
      useEffect(() => {
        if (Object.keys(selected).length === selectedItems.length) return
        const keep = {}
        for (const item of selectedItems) keep[item.id] = true
        const anchor = state.selectionAnchor
        store.set({ selected: keep, selectionAnchor: anchor && keep[anchor.id] === true ? anchor : null })
      }, [selected, selectedItems])
      // Escape leaves Select mode; an open popover closes first (its own Escape).
      const menuOpenNow = state.openMenu !== null && state.openMenu !== undefined
      useEffect(() => {
        if (!selectMode || menuOpenNow) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') exitSelect()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [selectMode, menuOpenNow])

      const visibleCount = visible.reduce((sum, section) => sum + section.items.length, 0)
      const errorPayload = data && data.error ? data.error : null
      const errorText = errorPayload
        ? String(errorPayload.message || errorPayload.code || '')
        : state.error || ''
      const errorCode = errorPayload ? String(errorPayload.code || '') : ''
      const unauth = /unauth|auth/i.test(errorCode) || /auth|401/i.test(errorText)
      const unavailable = /unavailable|not found/i.test(errorCode) || /not found|ENOENT|not installed/i.test(errorText)
      const hint = unauth ? t('page.unauthHint') : unavailable ? t('page.unavailableHint') : ''
      const loading = status === 'loading' && data === null
      const hostError = data !== null && data.status === 'error'
      const showEmpty = loading === false && hostError === false && data !== null && visibleCount === 0
      const filtered = activeFilter !== 'all' || activeSource !== 'all' || query !== ''

      const onScroll = () => {
        const node = scrollRef.current
        if (node === null) return
        const next = node.scrollTop > 4
        if (next !== stuck) setStuck(next)
      }

      const rateLimit = data && data.meta ? data.meta.rateLimit : null
      const remaining = rateLimit && Number.isFinite(rateLimit.remaining) ? rateLimit.remaining : null
      const pollSeconds = Number.isFinite(Number(state.pollSeconds)) ? Number(state.pollSeconds) : 1200

      const sectionTone = (id) =>
        id === 'review' ? 'info' : id === 'rereview' || id === 'respond' ? 'warn' : id === 'merge' ? 'ok' : id === 'ci' ? 'err' : 'idle'

      const openSettings = () => {
        setConfirmLeave(false)
        store.set({ view: 'settings', selectMode: false, selected: {}, selectionAnchor: null })
      }
      const leaveSettings = () => {
        setConfirmLeave(false)
        settingsDirtyRef.current = false
        store.set({ view: 'list' })
        void store.load(false)
      }
      // Back, Cancel and the header gear share this guard: unsaved edits ask
      // for an in-app confirmation instead of being dropped.
      const closeSettings = () => {
        if (settingsDirtyRef.current) {
          setConfirmLeave(true)
          return
        }
        leaveSettings()
      }
      const keepEditing = () => setConfirmLeave(false)
      // The save is applied by the time it is confirmed; a non-forced read
      // serves the snapshot for the saved settings without an extra GitHub scan.
      const afterSave = () => void store.reloadAfterSave()

      const settingsButton = h(
        'button',
        {
          type: 'button',
          className: 'adx-icon-btn',
          title: t('page.settings'),
          'aria-label': t('page.settings'),
          'aria-pressed': view === 'settings' ? 'true' : 'false',
          onClick: view === 'settings' ? closeSettings : openSettings,
        },
        icon('settings', 16),
      )

      return h(
        'div',
        { className: 'adx-root', 'data-panel': PANEL_ID, 'aria-busy': status === 'loading' && data === null ? 'true' : 'false' },
        h(
          'div',
          { className: 'adx-scroll', ref: scrollRef, onScroll },
          h(
            'div',
            { className: 'adx-col' },
            h(
              'header',
              { className: 'adx-head', 'data-stuck': stuck ? 'true' : 'false' },
              h(
                'div',
                { className: 'adx-heading' },
                h(
                  'div',
                  { className: 'adx-title-row' },
                  h('h1', null, view === 'settings' ? t('settings.title') : t('page.title')),
                  view === 'list' && total > 0 ? h('span', { className: 'adx-total' }, total > 99 ? '99+' : String(total)) : null,
                ),
                view === 'settings'
                  ? h('p', { className: 'adx-sub' }, t('settings.subtitle'))
                  : h(
                      'p',
                      { className: 'adx-sub' },
                      sources.length > 0
                        ? h('span', null, t('page.sources', { list: sourceLabels.join(' + ') }))
                        : h('span', null, t('page.subtitle')),
                      sourcesAuto ? h('span', { className: 'adx-sub-sep' }, '·') : null,
                      sourcesAuto ? h('span', null, t('settings.auto')) : null,
                      user && user.login ? h('span', { className: 'adx-sub-sep' }, '·') : null,
                      user && user.login ? h('span', null, '@' + user.login) : null,
                      h('span', { className: 'adx-sub-sep' }, '·'),
                      h(
                        'span',
                        null,
                        updated
                          ? t('page.updated', { time: updated }) +
                            (data && data.generatedAt ? ' · ' + t('page.updatedAgo', { age: timeAgo(t, data.generatedAt, now) }) : '')
                          : t('page.never'),
                      ),
                    ),
              ),
              h(
                'div',
                { className: 'adx-toolbar' },
                settingsButton,
                view === 'list'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'adx-btn adx-btn--outline',
                        title: t('page.refreshHint'),
                        onClick: () => void store.load(true),
                        disabled: state.refreshing === true,
                      },
                      h(
                        'span',
                        { className: 'adx-icon-wrap', 'data-spinning': state.refreshing === true ? 'true' : 'false' },
                        h('span', { style: { display: 'inline-flex' } }, icon('refresh', 15)),
                      ),
                      t('page.refresh'),
                    )
                  : null,
              ),
              view === 'settings' && confirmLeave
                ? h(
                    'div',
                    { className: 'adx-leave-confirm', role: 'alert' },
                    h('span', { className: 'adx-leave-confirm-text' }, t('settings.discardTitle')),
                    h(
                      'button',
                      { type: 'button', className: 'adx-btn adx-btn--outline', onClick: leaveSettings },
                      t('settings.discard'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'adx-btn adx-btn--primary', onClick: keepEditing },
                      t('settings.keepEditing'),
                    ),
                  )
                : null,
            ),
            view === 'settings'
              ? h(SettingsView, {
                  t,
                  store,
                  state,
                  onBack: closeSettings,
                  onSaved: afterSave,
                  dirtyRef: settingsDirtyRef,
                  onClean: keepEditing,
                })
              : h(
                  'div',
                  null,
                  data !== null && sourcesAuto && !hostError
                    ? h(
                        'div',
                        { className: 'adx-auto' },
                        h('span', null, t('page.orgAuto', { list: sourceLabels.join(', ') })),
                        h('button', { type: 'button', className: 'adx-link', onClick: openSettings }, t('page.orgAutoAction')),
                      )
                    : null,
                  data === null
                    ? null
                    : h(
                        'div',
                        { className: 'adx-filters', role: 'group', 'aria-label': t('page.filterAll') },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'adx-chip',
                            'aria-pressed': activeFilter === 'all' ? 'true' : 'false',
                            onClick: () => store.set({ filter: 'all' }),
                          },
                          t('page.filterAll'),
                          h('span', { className: 'adx-chip-count' }, String(allCount)),
                        ),
                        SECTION_ORDER.filter((id) => (sectionCounts[id] || 0) > 0 || activeFilter === id).map((id) =>
                          h(
                            'button',
                            {
                              key: id,
                              type: 'button',
                              className: 'adx-chip',
                              'aria-pressed': activeFilter === id ? 'true' : 'false',
                              onClick: () => store.set({ filter: activeFilter === id ? 'all' : id }),
                            },
                            t('section.' + id),
                            h('span', { className: 'adx-chip-count' }, String(sectionCounts[id] || 0)),
                          ),
                        ),
                        snoozedCount > 0 || snoozedView
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'adx-chip adx-chip--snoozed',
                                'aria-pressed': snoozedView ? 'true' : 'false',
                                title: t('snooze.chip'),
                                onClick: toggleSnoozedView,
                              },
                              icon('snooze', 13),
                              t('snooze.chip'),
                              h('span', { className: 'adx-chip-count' }, String(snoozedCount)),
                            )
                          : null,
                      ),
                  data !== null && showSources
                    ? h(
                        'div',
                        { className: 'adx-filters adx-filters--sources', role: 'group', 'aria-label': t('filter.allSources') },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'adx-chip',
                            'aria-pressed': activeSource === 'all' ? 'true' : 'false',
                            onClick: () => store.set({ sourceFilter: 'all' }),
                          },
                          t('filter.allSources'),
                        ),
                        sources.map((source) => {
                          const key = source.kind + ':' + source.login
                          return h(
                            'button',
                            {
                              key,
                              type: 'button',
                              className: 'adx-chip',
                              'aria-pressed': activeSource === key ? 'true' : 'false',
                              onClick: () => store.set({ sourceFilter: activeSource === key ? 'all' : key }),
                            },
                            source.kind === 'user' ? t('source.personal') : source.login,
                          )
                        }),
                      )
                    : null,
                  data === null
                    ? null
                    : h(
                        'div',
                        { className: 'adx-search-row' },
                        h(
                        'div',
                        { className: 'adx-search', role: 'search' },
                        icon('search', 14),
                        h('input', {
                          type: 'search',
                          value: search,
                          placeholder: t('page.search'),
                          'aria-label': t('page.search'),
                          onChange: (event) => setSearch(event.target.value),
                        }),
                        search !== ''
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'adx-icon-btn adx-search-clear',
                                title: t('page.searchClear'),
                                'aria-label': t('page.searchClear'),
                                onClick: () => setSearch(''),
                              },
                              icon('close', 14),
                            )
                          : null,
                      ),
                        // Select mode for bulk actions; hidden while the view has no rows.
                        visibleCount > 0 || selectMode
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'adx-btn adx-btn--outline adx-select-toggle',
                                'aria-pressed': selectMode ? 'true' : 'false',
                                onClick: selectMode ? exitSelect : enterSelect,
                              },
                              t('select.enter'),
                            )
                          : null,
                      ),
                  (status === 'error' && data === null) || hostError
                    ? h(Notice, {
                        tone: 'error',
                        title: t('page.error'),
                        detail: hostError
                          ? [errorPayload && errorPayload.message, hint].filter(Boolean).join(' — ')
                          : [errorText, hint].filter(Boolean).join(' — '),
                        actionLabel: unauth || unavailable ? t('settings.githubLogin') : t('page.retry'),
                        onAction:
                          unauth || unavailable
                            ? () =>
                                void store.loginGithub().then((payload) => {
                                  if (payload !== null && payload !== undefined) {
                                    if (payload.already === true) void store.load(true)
                                    else store.showToast(t('settings.githubWaiting'), 'ok')
                                  }
                                }).catch((error) =>
                                  store.showToast(
                                    t('settings.githubLoginFailed', {
                                      message: String((error && error.message) || error),
                                    }),
                                    'warning',
                                  ),
                                )
                            : () => void store.load(true),
                      })
                    : null,
                  state.status === 'error' && data !== null && data.status !== 'stale'
                    ? h(Notice, {
                        tone: 'warning',
                        title: t('page.stale', { time: updated }),
                        detail: state.error || '',
                        actionLabel: t('page.retry'),
                        onAction: () => void store.load(true),
                      })
                    : null,
                  state.saveError !== null
                    ? h(Notice, {
                        tone: 'warning',
                        title: t('settings.saveErrorTitle'),
                        detail: t('settings.saveErrorDetail', {
                          message: String(state.saveError.message || state.saveError),
                        }),
                        actionLabel: t('page.settings'),
                        onAction: openSettings,
                      })
                    : null,
                  data && data.status === 'stale'
                    ? h(Notice, {
                        tone: 'warning',
                        title: t('page.stale', { time: updated }),
                        detail: staleDetail(data),
                        actionLabel: t('page.retry'),
                        onAction: () => void store.load(true),
                      })
                    : null,
                  data && data.status === 'partial'
                    ? h(Notice, {
                        tone: 'warning',
                        title: t('page.partial'),
                        detail: (data.warnings || []).map((entry) => entry.message).slice(0, 2).join('; '),
                      })
                    : null,
                  loading ? h(Skeleton, { t }) : null,
                  showEmpty
                    ? h(
                        'div',
                        { className: 'adx-empty', role: 'status' },
                        h('span', { className: 'adx-empty-glyph' }, icon(filtered ? 'search' : 'check', 24, 1.4)),
                        h('h3', { className: 'adx-empty-title' }, filtered ? t('page.filtered') : t('page.empty')),
                        h('p', null, filtered ? t('page.filteredHint') : t('page.emptyHint')),
                        filtered
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'adx-btn adx-btn--outline adx-empty-action',
                                onClick: () => {
                                  setSearch('')
                                  store.set({ filter: 'all', sourceFilter: 'all' })
                                },
                              },
                              t('page.reset'),
                            )
                          : null,
                      )
                    : null,
                  visible.map((section) =>
                    h(Section, {
                      key: section.id,
                      section,
                      tone: sectionTone(section.id),
                      t,
                      store,
                      collapsed: state.collapsed[section.id] === true,
                      copiedId: state.copied,
                      openMenu: state.openMenu,
                      showSource: showSources,
                      config: state.config,
                      sectionItemsById: launchItemsById,
                      now,
                      snoozed,
                      snoozedView,
                      selected,
                      selectionAnchor: state.selectionAnchor,
                      selectMode,
                    }),
                  ),
                  selectMode
                    ? h(SelectionBar, {
                        t,
                        store,
                        items: selectedItems,
                        allItems: visibleItems,
                        snoozedView,
                        menuOpen: state.openMenu === 'snooze:selection',
                        onDone: exitSelect,
                      })
                    : null,
                  h(
                    'footer',
                    { className: 'adx-foot' },
                    t('page.footer', { sec: pollSeconds }) +
                      (remaining === null ? '' : t('page.footerRate', { n: remaining })),
                  ),
                ),
          ),
        ),
        state.toast
          ? h(
              'div',
              { className: 'adx-toast', 'data-tone': state.toast.tone || 'ok', role: 'status' },
              h('span', { className: 'adx-toast-text' }, state.toast.text),
              state.toast.action
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'adx-toast-action',
                      onClick: () => {
                        state.toast.action.run()
                        store.dismissToast()
                      },
                    },
                    state.toast.action.label,
                  )
                : null,
            )
          : null,
      )
    }

    function PanelIcon(props) {
      const store = props.store || runtime.store
      const state = useStore(store)
      const total = attentionCount(state.data && state.data.sections, state.snoozed)
      const edge = typeof props.size === 'number' ? props.size : 18
      return h(
        'span',
        { className: 'adx-icon-wrap' },
        icon('inbox', edge, 1.3),
        total > 0
          ? h('span', { className: 'adx-badge', 'aria-hidden': 'true' }, total > 99 ? '99+' : String(total))
          : null,
      )
    }

    /* ------------------------------------------------------------------ apply */

    function apply(ctx) {
      const store = createStore()
      runtime.store = store
      // The DSH target needs the Workspace UI service. It is registered by
      // another client plugin that can apply after this one, so a one-time
      // ctx.get() at apply often returned undefined and the target never
      // appeared. Track it through ctx.inject instead (as DSH's own client
      // plugins do), keeping the immediate read for a service that is already
      // there and as the fallback where ctx.inject is unavailable.
      const adoptWorkspace = (service) =>
        service !== null && service !== undefined && typeof service.startSession === 'function' ? service : null
      runtime.uiWorkspace = (() => {
        try {
          return adoptWorkspace(typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null)
        } catch {
          return null
        }
      })()
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], (scope) => {
          runtime.uiWorkspace = adoptWorkspace(scope.uiWorkspace)
          store.set({ dshAvailable: runtime.uiWorkspace !== null })
          const release = () => {
            runtime.uiWorkspace = null
            store.set({ dshAvailable: false })
          }
          if (typeof scope.effect === 'function') scope.effect(() => release, 'triage-desk: uiWorkspace')
        })
      }
      const t = ctx.locale.bind(NS)

      ctx.effect(() => () => store.dispose(), 'triage-desk: store cleanup')

      ctx.effect(() => {
        const en = ctx.locale.register(NS, 'en', EN)
        const zh = ctx.locale.register(NS, 'zh', ZH)
        return () => {
          en()
          zh()
        }
      }, 'triage-desk: dictionaries')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ store }),
          },
          Page,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 15,
            locale: NS,
            label: () => t('panel.label'),
            inject: () => ({ store }),
          },
          PanelIcon,
        ),
      )
    }

    return {
      name: 'triage-desk',
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
