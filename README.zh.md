# Triage Desk

[![check](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml/badge.svg)](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml)
[![npm version](https://img.shields.io/npm/v/dsh-triage-desk.svg)](https://www.npmjs.com/package/dsh-triage-desk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，每天早上只回答一个问题：**现在有什么需要我处理？** 它把 GitHub 动态汇总成一个收件箱面板——等待你审核或重新审核的拉取请求、可以合并的自己的 PR、需要答复的 PR 与提及、失败的 CI，以及新的或分配给你的议题。所有操作都通过 GitHub CLI 在本地完成；插件从不存储或转发访问令牌。

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [更新日志](CHANGELOG.md)

**仅支持 GitHub。** Triage Desk 通过已登录的 GitHub CLI 读取拉取请求、议题、审核和 CI；不支持 GitLab、Bitbucket、Gitea 及其他代码托管平台。

如果 GitHub 尚未连接，错误提示中会提供**登录 GitHub**操作；设置中也会显示 `gh` 是否已安装、当前连接的账号，并提供相同的登录按钮。

## 功能

- **等待你审核**——直接或通过团队请求你审核、且你尚未审核当前 head 提交的开放 PR。
- **需要重新审核**——你已审核过、但 head 提交已不是你审核时的那个（有新提交、rebase 或 force-push；按提交 ID 匹配，而非提交日期）的 PR；作者点击了**重新请求审核**、指定你审核的 PR；或作者在你上次操作后**回复你**（在你的审核评论下回复或明确 @ 提及）的 PR。仅仅是作者回复属于次要情况：它仍留在同一分类中，但会弱化显示并排在底部，行内悬停提示会给出确切原因。仅凭其他审核者的活动，不会要求你再审一遍。
- **可以合并**——你的 PR 中已获批准、可以合并且（默认）检查通过的那些。即使批准和检查都通过，被 GitHub 标记为 `BLOCKED` 的 PR 也会被排除。
- **需要你处理**——你的 PR 中有人要求修改、存在冲突，或新的审核者评论（包括行内审核讨论串）期待你修复的；此外还有分配给你的议题，以及提到了你、而你尚未回复的议题/PR（包括你自己创建的议题和 PR）。较新的批准不会被当作“需要回复”：它反而会把 PR 推向*可以合并*。
- **CI 失败**——个人仓库和组织仓库中，你的 PR 和分支上的红色检查：你管理或维护的仓库的默认分支变红，以及任何红色分支（包括默认分支）的最新提交由你（或配置的本人别名）在过去一周内提交的情况。
- **议题**——你维护的仓库中最近 30 天内新创建、**尚未分配**的议题，归在*你仓库中的新议题*下，样式更低调：它们不会增加关注计数。已有负责人的议题要么属于你的待办（分配给你，显示在*需要你处理*下），要么是那个人的工作，因此永远不会出现在这里。30 天窗口是固定的；不想看到的议题可以延后。
- **复制链接**——复制某一行的单个链接。工具栏和分类标题不会重复提供该操作；只保留这一处操作，工具栏才能保持紧凑。
- **延后**——行上的时钟按钮会打开一个小菜单：*直到有新动态*（默认）、*延后到明天*（本地时间 09:00）或*延后到下周*（周一 09:00）。条目会从所有分类和徽标中消失；GitHub 上出现任何新动态（更新的 `updatedAt`，或分支上的新提交）都会让它提前重新出现，定时延后也一样；而定时延后到期后会准时结束，无需刷新。Toast 提示会确认延后，并提供约 6 秒的*撤销*。分类标签之后的*已延后（n）*标签可打开已延后的条目，它们以淡化样式显示，各自带有重新出现时间和*取消延后*；没有延后条目时该标签消失。延后状态保存在此浏览器的本地存储中（`triage-desk:snoozed:v2`），不会在设备之间同步；已离开收件箱的条目的记录会在一次完整刷新后被清理。
- **批量延后**——分类标题中的时钟按钮会通过同一菜单延后该分类当前显示的所有行（已应用来源筛选和搜索之后）；在已延后视图中，它变为*全部取消延后（n）*。如需只处理部分条目，点击搜索框旁的*选择*：每一行的图标前会出现复选框，点击行内任意位置会选中该行而不是打开链接（聚焦复选框后按空格键同样有效；Shift+点击可在同一分类内选择连续范围），每个分类标题会出现全选复选框，行内按钮则暂时隐藏。底部栏提供*延后*（在已延后视图中为*取消延后*）、*全选*/*取消全选*和*完成*。在两个分类中同时出现的 PR 只算一个选中项。更改筛选条件、来源或搜索会清空选择，但保留选择模式；完成、Escape 或批量操作结束会退出该模式。整个批量操作只用一个 Toast 提示和一次*撤销*。
- **如实的计数**——侧边栏徽标对每个条目只计一次（同时出现在*需要你处理*和*CI 失败*中的 PR 只算一项），不计那些因他人已批准而变得可选的审核请求，也不计已延后的条目和新的未分配议题。分类标签（以及*已延后*）统计的是当前来源筛选和搜索下列表实际显示的行数；页面总数则是所选来源对应的徽标数。
- **启动场景**——每一行的终端按钮会打开一个菜单，其中包含智能体选择器和命名的可编辑提示。内置场景涵盖审查 PR（仅出现在等待你审核的行上）、更改后重新审核（仅在需要重新审核的行上）、修复 PR、在讨论串中回复，以及梳理议题。分类标题有各自的场景，会用当前所有可见行的清单启动**一个**智能体——“审查所有待我处理的 PR”“修复我的 PR”“梳理新任务”“回复提及”——同样带智能体选择器，提示会要求智能体把每个条目隔离到单独的子智能体里处理。
- **在 DSH 中打开**——启动菜单中有一个 **DSH — 本应用**目标：场景会在当前 DSH 窗口中打开新对话，提示已填入输入框且**尚未发送**。不会创建终端窗口；准备好后按 Enter。
- **在终端中打开**——场景会在仓库的本地克隆中打开终端，并启动一个编码智能体（Claude Code、Codex、opencode、Gemini CLI、Cursor Agent、Antigravity、pi，或你自己的命令），提示已准备好但**尚未发送**。多次启动共用一个 Triage Desk 终端窗口：macOS 在安装了 iTerm2 时打开 iTerm2 标签页，否则新建 Terminal 窗口；Windows Terminal 和 Linux 终端模拟器在支持时以标签页打开。在同一条目上重新启动同一智能体会在终端支持时聚焦其标签页。智能体退出后，窗口会保留并停留在 shell 中。
- **两种界面语言：英文和中文**——插件本身没有语言设置；面板跟随 DSH 的界面语言。将 DSH 切换为中文即显示中文面板；其他任何界面语言都显示英文。
- **智能体工具**——`triage_desk` 把同一份快照提供给智能体，因此“什么需要我关注？”只需一个数据源即可回答。当你明确要求时，它还能为某个 URL 打开终端。
- **已连接的来源**——GitHub 个人仓库，以及账号所属的最多 10 个 GitHub 组织（或显式指定的最多 10 个组织）。每一行都带有来源；当连接了多个来源时，来源筛选可以缩小列表范围（以及相应计数）。
- **面板内设置**——组织、个人仓库、自动刷新间隔、仅绿色 CI 的合并规则、机器人审核的处理方式、终端智能体、启动场景和克隆目录。

## 环境要求

- DeepSeek Harness `0.2.2-rc.2` 或更高版本。
- **仅支持 GitHub**——插件通过 `gh` 读取 GitHub 的拉取请求、议题、审核和 CI；不支持 GitLab、Bitbucket、Gitea 及其他托管平台。
- 已安装并登录 GitHub CLI（`gh auth login`）。插件在主机上运行 `gh`，从不存储或转发访问令牌；私有仓库需要 `gh auth login` 通常会授予的 `repo` 权限范围。设置中会显示当前连接状态，点击**登录 GitHub**按钮会在终端中打开交互式 `gh auth login`，并在 `gh` 本身未安装时明确说明。
- 一个拥有个人仓库和/或组织成员身份的 GitHub 账号。组织列表为空时，插件会自动检测最多 10 个组织，并包含该账号拥有的个人仓库。

## 安装

Triage Desk 是一个 DSH **bundle**：DSH 将它安装到某个 profile 中，并作为插件加载。没有构建步骤，面板在运行时不会从 npm 导入任何内容。

### 从 npm 安装

```sh
dsh plugin --profile <profile> add dsh-triage-desk
```

`<profile>` 是你运行所用的 profile：`dsh web` 用 `web`，Desktop 应用用 `desktop`。重启 DSH，刷新页面，然后打开侧边栏中的**分诊**入口。首次运行会自动检测组织；标题栏中的齿轮按钮可以修改。也可以通过 Plugin Manager 按包名安装。

日后更新：

```sh
dsh plugin --profile <profile> add dsh-triage-desk@latest
```

然后重启 DSH。

### 从本地检出安装（开发）

1. 克隆仓库。
2. 在 DSH 中打开**插件 → 添加插件**并选择仓库目录，或者在其父目录中运行 `dsh plugin --profile <profile> add ./dsh-triage-desk`。
3. 打开侧边栏中的**分诊**入口。

修改主机部分后，退出并重新打开 DSH，然后刷新页面。仅修改客户端时只需刷新页面，除非客户端 bundle 监听器正在运行。不要用停用再启用插件来代替重新加载；参见[本地开发](docs/DEV_LOCAL.md)。

## 终端启动器

终端设置（智能体、启动场景、默认场景）与可选的克隆搜索设置一起折叠在*高级：克隆搜索*下。

每一行带有 GitHub 链接的条目都会获得一个终端按钮。点击后打开一个紧凑菜单：首先是**目标选择器**（**DSH — 本应用**加上已安装的终端智能体），然后是适用于该行的场景，默认场景排在最前。场景是命名的提示模板；内置场景有*仅链接*、*审查此 PR*（仅在等待你审核的行上）、*复查更改*（仅在需要重新审核的行上）、*修复此 PR*、*回复讨论串*和*梳理 Issue*。场景可以固定自己的终端智能体：此时它会将该智能体显示为徽标，并忽略选择器。分类标题有自己的终端按钮，提供适用于整个分类的场景和相同的目标选择器。所有场景都可以在设置中编辑：名称、范围（单行或分类）、绑定的分类、提示、首选智能体、顺序和启用开关。*仅链接*不可删除，且必须包含 `{url}`。

选择 **DSH** 目标时，主机端会渲染同样的场景提示，并通过 `uiWorkspace.startSession` 客户端服务将其作为新的 DSH 会话草稿打开；如果空白会话已有草稿，提示会追加到其中。在你按 Enter 之前，不会提交任何内容。

分类场景会选取它所绑定的每个分类中当前可见的行（遵循当前分类/来源筛选和搜索，并排除已延后的条目），用这个清单构建一条提示，并启动**一个**智能体；菜单会显示数量——“审查所有待我处理的 PR（12）”。提示会要求智能体在合适时把每个条目交给单独的子智能体处理。如果所有条目都来自同一个仓库，智能体就在该仓库的克隆中打开；否则在工作区中打开。

提示模板使用单花括号占位符。单行场景：`{url}`、`{repo}`、`{owner}`、`{name}`、`{number}`、`{title}`、`{branch}`、`{kind}`、`{ref}`、`{author}`、`{reason}`。分类场景：`{links}`（生成的清单）、`{count}`、`{section}`、`{date}`。未知的 `{…}` 标记会保持原样。没有 `{links}` 的分类提示会在末尾追加生成的清单；没有 `{url}`（也没有 `{links}`）的单行提示会追加只含一个条目的清单。清单本身用英文书写（`reason: new commits since my review`），以便与内置的英文提示匹配。

提示由主机根据快照渲染；模板上限为 4 000 个字符，渲染后的提示上限为 16 000 个字符。当分类清单放不下时，会丢弃末尾部分，提示中会写明 `Items: first N of M`，面板也会用 Toast 提示提醒。

启动机制：

1. 插件解析该行仓库的本地克隆：手动的 `owner/repo = /path` 覆盖优先（仓库名不区分大小写），然后是配置的克隆目录；未配置目录时，它会搜索实际存在的常见文件夹（`~/Projects`、`~/Developer`、`~/Documents/GitHub` 等）以及主目录中检测到的项目根目录。若分类启动涉及多个仓库，则改为打开当前**工作区**。缺少单仓库克隆时，Terminal 会在工作区中打开，提示中会包含链接。它从不运行 `git fetch`，也不改动工作树。可以用系统原生文件夹选择器添加克隆文件夹；对于手动路径，选择一个克隆文件夹后，插件会推导出其 `owner/repo`（依次来自 `upstream`、`origin`，然后是第一个其他 GitHub 远程）。选择器的结果会保留对话框打开期间所做的编辑。每条非空的手动映射行都需要 `owner/repo = /absolute/path`；缺少分隔符、仓库或路径时，保存会被阻止，并给出指明行号的错误，同时保留文本供修正。
2. 它为该行或可见的分类清单渲染场景提示。
3. **Claude Code** 使用其原生草稿参数启动：`claude --prefill '<prompt>'`。TUI 打开时提示已在输入框中，尚未提交；检查后准备好时按 Enter。
4. 其他智能体没有可靠的草稿模式，因此会以**空白状态**打开，提示会被复制到系统剪贴板（`pbcopy`、`clip.exe` 或 Linux 剪贴板工具）。你可以自行粘贴、编辑并发送；智能体上方会打印提示。

终端平台支持：

多次启动会归入同一个共享的 **Triage Desk** 终端窗口，并在终端支持时以标签页打开。在*同一条目*上重新启动*同一*智能体时，终端允许的情况下会聚焦已有标签页，而不是打开重复标签页（macOS 上的 iTerm2；Linux 上的 `wmctrl` 或 `xdotool`）；Windows Terminal 会在共享窗口中再开一个标签页，而 Terminal.app 会打开新窗口。这种“聚焦或复用”属于尽力而为，不可用时会退回到新标签页或新窗口。

- **macOS**——安装了 **iTerm2** 时使用它：每次启动都在当前 iTerm 窗口中打开新标签页（`create tab with default profile command …`），重新启动会聚焦匹配的标签页。没有 iTerm2 时，回退方案是每次启动都新建一个 **Terminal.app** 窗口——Terminal 的 AppleScript 接口无法创建标签页（`do script … in window` 会写入当前标签页，可能破坏正在运行的智能体输入），因此它既没有共享窗口，也无法聚焦复用。
- **Windows**——Windows Terminal（`wt.exe`）在 PATH 中时，会把每次启动作为共享窗口中的新标签页打开（`wt -w 0 new-tab`）；无法打开标签页时，会尝试新建 Windows Terminal 窗口（`wt -w -1 new-tab`）。没有 Windows Terminal 时，PowerShell 会打开新的控制台窗口（`cmd.exe /c start`）。Windows Terminal 把标签页多路复用到一个宿主窗口中，因此重新启动会在该窗口中再开一个标签页；无法按标题聚焦单个标签页。脚本是 PowerShell 5.1 `.ps1` 文件，剪贴板使用 `clip.exe`。
- **Linux**——`$TERMINAL` 为绝对路径时使用它，否则依次查找 `gnome-terminal`、`konsole`、`xfce4-terminal`、`kitty`、`alacritty`、`x-terminal-emulator`、`xterm` 中第一个可用的。前三个在对应服务器运行时以标签页打开；其余打开新窗口。“聚焦或复用”在安装了 `wmctrl -a`（或以 `xdotool` 作为回退）时，会按标题提升匹配的窗口；两者都是 X11 工具，因此在纯 Wayland 会话上可能无法聚焦复用，且两者都不是必需的。剪贴板使用 `wl-copy`、`xclip` 或 `xsel`。已打开的终端在插件重新加载后仍然存在，并在 DSH 退出时关闭。

设置中还有**查找智能体**按钮：它会扫描登录环境中的已知 CLI——Claude Code、Codex、opencode、Gemini CLI、Cursor Agent、Antigravity、pi、Aider、Amp、Droid、Goose 和 Crush——并把已安装的那些添加进来，同时不改动你已配置的智能体。扫描期间所做的编辑、添加和删除都会被保留。

内置智能体（可在设置中编辑或扩展；表单编辑的是名称和启动命令，内部智能体 ID 保持稳定且不会显示）：

| 智能体 ID | 启动命令 | 提示传递方式 |
|---|---|---|
| `claude` | `claude {prompt}` | 原生 `--prefill`（输入框，不发送） |
| `codex` | `codex {prompt}` | 剪贴板 |
| `opencode` | `opencode --prompt {prompt}` | 剪贴板 |
| `gemini` | `gemini {prompt}` | 剪贴板 |
| `cursor-agent` | `cursor-agent {prompt}` | 剪贴板 |
| `agy` | `agy {prompt}` | 剪贴板 |
| `pi` | `pi {prompt}` | 剪贴板 |

检测是尽力而为的：它会向登录环境一次性询问所有已配置的命令，因为 DSH 应用本身经常以最小化的 `PATH` 启动：

- **macOS**——交互式登录 zsh（`/bin/zsh -lic`、`whence -p`），因此 `~/.zshrc` 中的 PATH 配置（例如 nvm）会被计入。
- **Linux**——`$SHELL` 是 POSIX 系列 shell 时使用该登录 shell，否则使用 `/bin/sh`；bash 以交互式登录 shell 方式询问（`-lic`、`type -P`），因此 `~/.bashrc` 中的 PATH 配置（例如 nvm）会被计入。
- **Windows**——PowerShell `Get-Command`，仅限应用程序和脚本。

只有绝对路径才算数。如果某个别名的值是一个绝对路径的可执行文件，则解析为该可执行文件；其他别名或 shell 函数会报告为不可用（菜单显示*shell 别名或函数——请使用路径*），因为启动用的 shell 没有你的别名。找不到的已配置二进制文件会显示为*未安装*，且无法启动。在 macOS 和 Linux 上，启动时会运行检测到的绝对路径，并在其目录不在 `PATH` 中时加入 `PATH`，因此 `#!/usr/bin/env node` 垫片（nvm）能找到其运行时。`triage_desk` 智能体工具提供相同的操作，因此在聊天中说“在 PR 288 上打开 Codex”会打开同一个窗口。由工具发起的启动使用相同的草稿/剪贴板行为：智能体可以启动，但不会提交任何内容。

智能体命令必须在可执行词之后恰好包含一个未加引号、未转义的 `{prompt}`：要么作为独立参数（`codex {prompt}`），要么紧跟在 `--flag=` 之后（`aider --message={prompt}`）。带引号或以其他方式嵌入的占位符、命令替换（`$( )`、`${ }`、反引号）、注释和 shell 运算符（`; & | < > ( )`）都会被拒绝；复杂的 shell 配置请使用包装可执行文件。支持带引号的可执行文件路径和静态参数，也支持可执行文件之前的 POSIX 环境变量赋值（包括带空格、带引号的值）。剪贴板启动会保留命令其余部分的引号和参数间距；Windows 的草稿/剪贴板启动还会把带引号的路径和参数保持为单个词。提示文本会作为数据加引号，但配置的命令本身是受信任的代码，而非沙箱。

违反该规则的已保存智能体（例如手工写入 profile 的）不会被静默丢弃：有效智能体仍然可用，无效的会作为标记为无效的可编辑行出现在设置中（保存前请修正命令或删除该行），绑定到这类智能体的场景在修复前会失败并给出说明。当没有任何已保存的智能体有效时，会使用内置预设，并在警告中列出被拒绝的智能体。

安全说明：原生 `--prefill` 会把提示作为智能体参数传递，因此它在进程列表中可见。默认场景的提示就是 GitHub URL；更长的场景提示和分类清单也同样可见。其他智能体只通过剪贴板接收提示。

## 配置

设置表单会把插件行的 `config` 写入当前 DSH profile。同样的字段也可以在 `cordis.patch.yml` 中手动设置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `orgs` | `[]` | 要扫描的组织，最多 10 个；留空会自动检测成员身份，并扫描前 10 个（出现 `orgs-truncated` 警告表示达到上限） |
| `includePersonal` | `true` | 是否把账号的个人仓库作为来源包含进来 |
| `refreshSeconds` | `1200` | 面板自动刷新间隔，15–3600 秒 |
| `ttlMs` | `max(refreshSeconds, 600)` 秒，上限 1 小时 | 主机快照缓存有效期 |
| `requireGreenChecks` | `true` | 仅在检查通过或没有检查时才列在“可以合并”下（进行中/失败会被排除） |
| `includeBotReviews` | `false` | 在搜索返回的 PR 上，把机器人账号的审核算作你的审核 |
| `agents` | 内置预设 | 智能体列表（最多 12 个）：`{ id, label, command }`；`command` 在可执行文件之后恰好包含一个未加引号的 `{prompt}`，作为独立单词或位于 `--flag=` 之后（参见[终端启动器](#终端启动器)） |
| `defaultAgent` | `claude` | 未显式打开菜单时使用的智能体 ID |
| `cloneDirs` | `[]` | 可选的克隆发现基础目录，最多 8 个（隐藏在*高级：克隆搜索*下）；留空则搜索实际存在的常见目录（`~/Projects`、`~/Developer` 等）以及主目录中检测到的项目根目录 |
| `repoPaths` | `{}` | 可选的 `owner/repo` → 绝对克隆路径例外映射，最多 50 条，不区分大小写匹配（隐藏在*高级：克隆搜索*下） |
| `scenarios` | 内置场景集 | 命名的启动场景：`{ id, label?, scope: 'item' \| 'section', sections, prompt, agent: 'default' \| <agent id>, enabled }`；数组顺序即菜单顺序；`link` 场景必须存在、保持启用并包含 `{url}` |
| `defaultScenario` | `link` | 在菜单中排在最前的单行场景 |
| `ghCommand` | `gh` | GitHub CLI 的路径 |
| `timeoutMs` | `30000` | 单次 `gh` 调用的超时时间 |
| `meLogins` | `[]` | 额外的本人登录名：用于判断归属、直接审核请求、你的活动，以及登录账号搜索到的条目上近期的分支作者。只涉及别名的 PR 不会被找到；别名不会增加来源或团队成员身份 |
| `teams` | `[]` | 审核者团队，用于 `gh` 无法读取团队成员身份时 |

自动刷新下拉框也接受自定义值：选择**自定义…**并输入分钟数（1–60）。配置字段 `refreshSeconds` 以秒为单位。

## 工作原理

- **主机部分**（`index.js` + `github.js`）通过已登录的 `gh` CLI 收集快照。来源是个人账号（`user:<login>`）和每个组织（`org:<login>`）。对每个来源，一个 GraphQL 请求会读取你的团队成员身份，并针对非归档仓库中的开放拉取请求执行三次搜索，按最近更新排序——`review-requested:<you>`（也会匹配发给你所在团队的请求）、`reviewed-by:<you>` 和 `author:<you>`——第二个查询则搜索分配给你的议题、新的未分配议题和提及。每次 PR 搜索每页读取 25 条结果，最多跟进 4 页（100 个 PR）；被多次搜索命中的 PR 只列出一次。分支 CI 来自一次独立的仓库扫描（不读取拉取请求）：每页 100 个仓库，按最近推送排序，每个来源最多 3 页（300 个仓库），读取每个仓库默认分支的检查以及最多 100 个分支 head。各来源轮流进行：每个来源都先发出自己的第一个请求，之后才会读取第二页，因此一个大型组织无法独占整次刷新。结果会被缓存（single-flight，TTL 见上），并由 Host 自带的 Web 服务器通过 `GET /triage-desk/snapshot` 提供给面板；该路由有浏览器信任检查防护。
- 搜索仅针对已登录账号运行。`meLogins` 别名决定这些搜索返回的 PR 上的归属、审核请求和活动，`includeBotReviews` 也作用于同一批 PR；只涉及别名的 PR 不会被找到。
- **客户端部分**（`client.js`）是一个纯 JavaScript 的 DSH 客户端 bundle：它注册侧边栏面板和页面，轮询快照，并使用宿主主题 token 渲染。切回隐藏的浏览器标签页时，会立即通过主机缓存重新检查快照；更改间隔会重启计时器；相对时间（“3 分钟前更新”）每分钟推进一次。加载失败后，面板会分别在 15 秒、60 秒和 5 分钟后重试（每次重试都受刷新间隔限制），之后等待常规轮询。过期快照的横幅会显示当前错误。当最后一个视图卸载或插件被释放时，延迟恢复会被取消，包括之后到达的更旧响应。没有构建步骤，也没有外部网络调用。
- 设置通过 DSH 的配置编辑器保存到 profile 补丁中；任何更改都会重启插件，面板会自行刷新。主机只有在 profile 写入和插件重启都完成后才会响应，面板也只在此时显示**已保存**。写入失败时，表单会保持打开并显示错误，编辑内容可以重试。在确认保存之前启动的设置读取，无法覆盖其值或状态。带着未保存的编辑离开设置（返回、取消或齿轮按钮）时，会询问是放弃还是继续编辑。
- 团队审核请求会与实际所属的团队匹配（`teams(userLogins:)`），而不是与组织中的所有团队匹配。当无法读取该成员身份时（例如缺少 `read:org` 范围，或涉及嵌套团队），GitHub 的 `review-requested:` 搜索返回的 PR 会归因于其请求审核者中的第一个团队。
- 启动场景在 `launcher.js` 中规范化，其提示也在那里渲染（纯辅助函数：token、条目清单块、截断）；`POST /triage-desk/launch` 校验场景和 URL，在主机上解析克隆和智能体，然后才请求操作系统打开终端。`GET /triage-desk/clones` 为设置中的“检查克隆”按钮提供数据。
- 瞬时网络故障会重试一次。PR 搜索失败的来源会报告为不可用，快照变为部分可用；议题搜索或分支扫描失败时，该来源的拉取请求仍会保留，只是快照变为部分可用。当一次刷新无法扫描任何来源时（网络中断、速率限制、插件重载），面板和智能体工具会保留上一份快照，并标记为过期并附上原因，而不是显示空收件箱；没有上一份快照时，会明确报告错误。单个来源的权限拒绝（HTTP 403）不会阻止其他来源；显式的速率限制错误或 HTTP 429 会停止后续请求。被取消的智能体工具调用会停止等待，但不会取消共享的刷新。

## 限制

- 每次刷新的覆盖范围有限：最多 10 个组织（`orgs-truncated` 警告）、每个来源每次搜索 100 个开放 PR（`prs-truncated`）、每个来源 300 个仓库用于分支 CI（`repos-truncated`）。这些限制会保留最近更新的 PR 和最近推送的仓库，但这并不保证更早的条目没有待处理工作。
- 一次刷新没有固定的点数预算。只有当 GitHub 报告速率限制或剩余点数不超过 100 时，它才会停止发起查询；已获取的结果会保留，`scan-budget` 警告会把快照标记为部分可用。按照 GitHub 文档中的成本公式（只是一个估算，并非实测），一个来源在典型刷新中约消耗 21 点，当所有搜索和仓库页都被跟进时约消耗 70 点；返回的成本记录在快照元数据中。
- 仅支持 GitHub。数据层隔离在 `github.js` 中，快照契约与提供方无关，因此可以在不改动 UI 的情况下添加 GitLab（或其他）提供方。
- 重新审核使用 `viewerLatestReview` 获取你自己的最近一次审核，因此审核窗口不会把它隐藏。其他 PR 历史按有限的窗口读取：最近 50 条审核、最近 30 条评论，以及最近 10 个审核讨论串及其各自最近 5 条评论。当 GitHub 报告更多内容时，快照会带有 `truncated-history` 警告，而不是静默丢弃。新提交始终能被检测到：head 提交 ID 会与你最近一次审核所附带的提交进行比较。
- 终端启动器支持 macOS（iTerm2 标签页，否则 Terminal.app 窗口）、Windows（Windows Terminal 或 PowerShell）和 Linux（常见终端模拟器）。多次启动共用一个 Triage Desk 窗口；聚焦复用在 macOS 上通过 iTerm2 生效，在 Linux（X11）上通过 `wmctrl` 或 `xdotool` 生效，而 Windows 会在共享窗口中另开一个标签页。Orca 管理的终端和 DSH 内嵌终端是自然的下一步。
- 没有 iTerm2 的 macOS 每次启动都会新建 Terminal.app 窗口：Terminal 的脚本接口没有创建标签页的 API，因此安装 iTerm2 才能获得共享窗口标签页和聚焦复用。Windows 标签页需要 Windows Terminal ≥ 1.5。
- Windows：PowerShell 脚本以带 BOM 的 UTF-8 写入，草稿提示文件明确按 UTF-8 读取；标签页标题或脚本路径中的 `;` 会针对 Windows Terminal 转义为 `\;`；提示中的双引号会针对 PowerShell 5.1 的原生参数传递进行转义。以反斜杠结尾的提示参数和以 `.cmd` 垫片安装的智能体尚未在真实的 Windows 主机上验证。
- Linux 启动会观察启动初期的错误 500 毫秒，然后报告成功；终端模拟器会一直运行，没有生命周期超时。观察窗口之后的失败不会被报告。
- 克隆发现会扫描搜索目录三层深，每个根目录有独立的 400 个目录预算，并跳过隐藏目录和体积大的目录。符号链接目录会被跟随，每个真实目录只扫描一次。所有指向 GitHub 的 git 远程都算数，因此同时带有 `origin` 和 `upstream` 的 fork 可服务两个仓库中的任意一个。可识别 HTTPS、`ssh://` 和 scp 风格的远程（带或不带 `git@`），也可识别 `~/.ssh/config` 中 `HostName` 为 `github.com` 或 `ssh.github.com` 的 SSH 主机别名（仅限字面 `Host` 名称；通配符块、`Match` 和 `Include` 不会被求值）。在能读取 git 配置时可找到 worktree 和子模块；否则请添加 `repoPaths` 覆盖。
- 启动操作从不克隆、fetch、检出或改变 git 状态。找不到本地克隆时，它会在当前工作区中打开智能体；克隆搜索设置位于设置的*高级：克隆搜索*中。
- 浅色/深色主题都使用宿主主题 token。
- DSH 目标会在当前工作区中打开会话，因此不会切换目录到仓库克隆；提示中包含链接和场景文本。

## 开发

```
index.js     主机插件入口：连接 host/ 模块、路由和智能体工具
host/        主机模块：快照缓存与存储、配置、进程与终端、智能体、克隆、启动
github.js    GitHub 数据层：GraphQL、gh 运行器、快照规范化
launcher.js  启动器入口：重新导出 launcher/（智能体命令、预设、场景与提示、克隆发现、脚本、终端方案）
launcher/    启动器模块、纯辅助函数与平台脚本
client.js    客户端 bundle：侧边栏面板 + 页面 + 设置表单 + 场景菜单
locale/      Plugin Manager 显示元数据（en、zh）
icon.svg     插件图标
docs/        架构图、共享契约与本地开发流程（[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DEV_LOCAL.md](docs/DEV_LOCAL.md)）
dev/         开发时使用的 smoke 脚本（不随 npm 包发布）
```

开发环境设置与默认检查：

```sh
npm install           # 安装 ESLint + React（用于 render smoke），并设置 .githooks
npm run check         # lint + 文档链接 + client/render/launcher/routes/cache/snapshot
npm test              # npm run check 的别名
```

pre-commit 钩子会运行 `npm run check`；它由 `prepare` 脚本启用（`git config core.hooksPath .githooks`）。CI（`.github/workflows/check.yml`）使用 `npm ci` 运行同一条命令。组织成员提交的拉取请求还会收到 DeepSeek 审查机器人（`.github/workflows/deepseek-review.yml`）的自动审查；它通过 GitHub API 读取 diff，从不检出或运行拉取请求代码。

- `npm run smoke:client`——在模拟模块加载器上注册客户端 bundle，检查 slot 注册，校验 EN/ZH 词典一致性（键集合、占位符、字面量 `t()` 键），并用假计时器测试轮询、重试和可见性处理。
- `npm run smoke:render`——使用 fixture 快照渲染真实的 `Page` 和设置页面（可捕获读取缺失 props/state 的组件，以及本应隐藏的、受能力门控的控件），并通过确定性的 hook 运行器（而不是浏览器 DOM）驱动设置流程、分钟 tick 和启动菜单交互。
- `npm run check:docs`——校验两个 README（英文和中文）中的相对链接/图片是否可解析。
- `npm run smoke:launcher`——检查场景提示和 token、克隆发现/匹配、原生草稿启动器（`--prefill`）以及剪贴板回退脚本。
- `npm run smoke:routes`——使用假子进程层演练主机路由、路由防护、克隆扫描、原生选择器路由、启动成功/失败路径以及启动工具操作（绝不会打开终端）。
- `npm run smoke:cache`——检查快照缓存行为：成功会被缓存，失败会重试，构建进行中强制刷新会排队，TTL 可动态提供。
- `npm run smoke:snapshot`——让真实的快照构建器和主机缓存针对一个按 GraphQL 操作名（`ViewerSources`、`PullSearch`、`IssueSearch`、`PullSearchPage`、`BranchScan`）应答、并拒绝含未使用或未声明变量的查询的假 `gh` 运行：分类归类、搜索分页与截断、分支 CI、配额停止、部分可用和失败的来源、保留上一份快照并标记过期，以及被取消的工具调用不会取消构建。
- `npm run smoke:host`——**仅限线上/自愿运行**：让主机部分针对假的 Cordis 上下文和真实的 `gh` CLI（需要 `gh auth login`）运行；它会消耗 GitHub 配额，因此不属于 `npm run check` 或 CI。

### 发布（维护者）

```sh
npm run check        # 完整检查；prepublishOnly 会在发布时再运行一次
npm pack --dry-run   # 检查会进入 tarball 的内容
npm publish          # 发布非作用域公共包
```

在 `package.json` 中提升 `version`（项目从 `0.1.0` 开始），并在 `CHANGELOG.md` 中添加对应章节。发布包包含主机和客户端部分、启动预设、locale 元数据、两个 README（英文和中文）、更新日志、许可证、`docs/ARCHITECTURE.md` 以及 `docs/DEV_LOCAL.md`；开发用 smoke 脚本和贡献者文档（`AGENTS.md`、`CODING_STANDARDS.md`）不会包含在内。

在公布 npm 包之前应先创建 GitHub Release（`v0.1.0`，说明取自更新日志），这样 `repository`、`homepage` 和 `bugs` 链接才能解析。若要将插件列入社区市场，请向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交一个 pull request，新增一条 `data/plugins/<owner>__<repo>.yml` 条目（分类为 `git`）；该精选列表会提供给 [dsh-market](https://github.com/dsh-market/dsh-market) 和 DSH Discover 索引。npm 映射会根据已发布的 `repository` 字段自动获取，而 `npm pack --dry-run` 是最终确认 tarball 中包含两个 README、两个 locale 文件和两个文档的好方法。

这里有意不提供 `export const Config`：行配置由设置端点校验，并在代码中带默认值读取，因此 bundle 不需要 `@deepseek-ai/*` 依赖（链接的本地 bundle 无法解析它们）。

## 许可证

[MIT](LICENSE)
