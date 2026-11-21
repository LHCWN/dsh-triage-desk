# Triage Desk

[![check](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml/badge.svg)](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml)
[![npm version](https://img.shields.io/npm/v/dsh-triage-desk.svg)](https://www.npmjs.com/package/dsh-triage-desk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![已收录于 DSH 1024Store](https://img.shields.io/badge/DSH_1024Store-listed-0969da.svg)](https://deepseek1024.com/plugins/LHCWN/dsh-triage-desk)
[![已收录于 dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/lhcwn/dsh-triage-desk)
[![开放插件市场](https://img.shields.io/endpoint?url=https%3A%2F%2Fdshopen.org%2Fbadge%2Fdsh-triage-desk.json)](https://dshopen.org/zh/plugins/dsh-triage-desk/)
[![已收录于 Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/zh/p/LHCWN/dsh-triage-desk/)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，每天早上只回答一个问题：**现在有什么需要我处理？** 它把 GitHub 动态汇总成一个收件箱面板：等待你审核的 PR、可以合并的自己的 PR、需要答复的讨论、失败的 CI，以及新的或分配给你的议题。可复制场景提示，或在 DSH、本地智能体或 SSH 主机中将其作为草稿打开。收件箱通过已登录的本地 GitHub CLI 读取数据。

<img src="docs/screenshots/inbox.png" width="900" alt="分诊收件箱显示所有来源，按等待我复审、我的 PR 收到的反馈和可以合并分组">

[English](README.md) · [参考文档（英文）](docs/REFERENCE.md) · [架构](docs/ARCHITECTURE.md) · [更新日志](CHANGELOG.md)

## 显示内容

- **审核**按下一步由谁处理来分组。**等待我审核**列出你尚未审核的 PR 上直接或通过团队发来的审核请求。**等待我复审**列出审核后作者再次请求审核（即使提交未变）、推送新提交或回复你的 PR，可复查上次审核以来的更改与回复。团队审核请求仍然待处理时，新提交也会使 PR 进入复审。**我的 PR 收到的反馈**列出你的 PR（包括草稿）收到的评论和修改请求。点击标题可打开 PR，点击智能体按钮可起草回复。对于修改请求，还可直接打开变更文件。
- **可以合并**列出你已获批准或无需批准且可以合并的 PR。默认仅列出检查通过或没有检查的 PR。检查失败的 PR 会出现在“CI 失败”中。检查通过后，只要满足其他合并条件，下次刷新时该 PR 就会出现在“可以合并”中。
- **需要你处理**：存在合并冲突的 PR，分配给你的议题，以及尚未回复的提及。
- **CI 失败**：你的 PR、你维护的默认分支，以及最新提交由你在过去一周内提交的分支上的红色检查。
- **你仓库中的新议题**：最近 30 天内未分配的议题，不计入关注计数。
- **延后**：按行、按分类或按所选条目延后，直到有新动态、明天或下周。
- **启动场景**：可针对单行或一组条目自定义场景提示。升级并重启 DSH 主机后，原先用于**需要你处理**的场景也适用于**我的 PR 收到的反馈**。你可以在设置中单独调整这两项。
- **智能体工具**：`triage_desk` 把同一份快照提供给 DSH 智能体，并可按要求打开终端。
- **来源与语言**：个人仓库加最多 10 个组织；面板跟随 DSH 的界面语言（英文或中文）。
- **大型组织**：像 `llvm` 这样大的组织会以精简模式加载，而不是直接失败（[详情](docs/REFERENCE.md#large-sources)）。

<img src="docs/screenshots/reviews.png" width="900" alt="审核标签页显示上次审核后有新提交的 PR，以及我的 PR 收到的反馈">

*分诊* 旁的计数表示需要你处理的事项；将鼠标悬停或聚焦在计数上，可查看它未计入的内容。

每项功能的完整说明见[参考文档](docs/REFERENCE.md#inbox)。

## 环境要求

- DeepSeek Harness `0.2.2-rc.2` 或更高版本。
- **仅支持 GitHub**：不支持 GitLab、Bitbucket、Gitea 及其他代码托管平台。
- 已安装并登录 GitHub CLI（`gh auth login`）。私有仓库需要 `gh auth login` 通常会授予的 `repo` 权限范围。设置中会显示连接状态，并提供**登录 GitHub**按钮。
- 可选，用于把提示填入 Claude Code 以外的智能体：macOS 和 Linux 上需要 Python 3，Windows 上需要 Windows 10 1809 或更高版本（参见[提示传递方式](docs/REFERENCE.md#prompt-delivery)）。

## 安装

Triage Desk 是一个 DSH **bundle**：DSH 将它安装到某个 profile 中，并作为插件加载。没有构建步骤。

### 从 npm 安装

```sh
dsh plugin --profile <profile> add dsh-triage-desk
```

`<profile>` 是你运行所用的 profile：`dsh web` 用 `web`，Desktop 应用用 `desktop`。重启 DSH，刷新页面，然后打开侧边栏中的**分诊**入口。首次运行会自动检测你的组织；标题栏中的齿轮按钮可以修改。也可以通过 Plugin Manager 按包名安装。

日后更新时运行以下命令，然后重启 DSH：

```sh
dsh plugin --profile <profile> add dsh-triage-desk@latest
```

移除插件（`dsh plugin --profile <profile> remove dsh-triage-desk`，或在 Plugin Manager 中点击**移除**）不会删除 profile 中已保存的设置，重新安装后会再次使用这些设置。如需恢复默认值，参见[卸载与已保存的设置](docs/REFERENCE.md#uninstall-and-saved-settings)。

### 从本地检出安装（开发）

1. 克隆仓库。
2. 在 DSH 中打开**插件 → 添加插件**并选择仓库目录，或者在其父目录中运行 `dsh plugin --profile <profile> add ./dsh-triage-desk`。
3. 打开侧边栏中的**分诊**入口。

修改主机部分后，退出并重新打开 DSH，然后刷新页面；重新加载规则参见[本地开发](docs/DEV_LOCAL.md)。

## 启动智能体

点击行或分类标题上的终端按钮。「提示词」会按任务填入配置的模板；首次审核、复审和议题各用对应的模板。在「设置 → 智能体 → 提示模板」中修改模板，或在启动时直接编辑本次草稿。先选本机或 SSH 主机，再选智能体；切换机器会保留已编辑的内容。「打开」会把草稿交给智能体，由你决定何时发送。「复制提示」复制当前文本，行上的「复制链接」只复制网址。收件箱刷新时，已打开的草稿会保留编辑内容和原先的条目。重新打开编辑器即可使用最新列表。

<img src="docs/screenshots/group-prompt.png" width="400" alt="在本机选择 Codex，编辑草稿，为两个 PR 收到的反馈起草回复">

即使在“全部”视图中，初审组的草稿也只包含该组可见的初审 PR。复审有单独的操作，批量提示会列出每个 PR 的复审原因，即使没有代码变更，也会让智能体阅读作者的回复。在“我的 PR 收到的反馈”中，点击行上的终端按钮可为该 PR 起草回复，点击组标题上的终端按钮可为多个 PR 起草回复。数量随来源筛选和搜索更新，忽略已延后的条目，同一个 PR 只计一次。默认跳过标有“可选审核”的行。要指定 PR（包括可选审核），请点击“选择”，勾选所需的行，再点击该分类标题上的终端按钮。菜单会显示在该分类中选中的数量。如果提示长度超限，草稿和通知都会显示实际包含的条目数。如果连第一项都放不下，面板会显示错误，并停止打开草稿。每次从终端启动批量操作时都会打开新的标签页或窗口。

如果 PR 在你审核后有新提交，只有其他审核者批准了当前最新提交，复审才可能标记为可选。如果草稿中实际包含的 PR 都属于同一个仓库，启动器会在本机或所选 SSH 服务器查找匹配的工作副本。

发送后，审核类场景会在 GitHub 上提交一次审核，以行内评论给出发现的问题并标注 `[P1]`–`[P3]`，从不批准。修复和回复类场景在推送或发布前会等待你确认；分诊只汇报结果。所有场景都不会添加 AI 署名。

**GitHub 设置。** 展开「GitHub」可以查看连接、组织、个人仓库、刷新间隔及 PR 规则。已连接的账号默认折叠，标题中显示登录名。连接检查失败时，标题会显示错误，展开后可重试。需要登录时默认展开。

**运行位置。** 在 GitHub 下方的「设置 → 智能体」中选择「本机」或 SSH 主机。打开草稿时也可使用同一个列表，包括已保存的目标和 `~/.ssh/config` 中具名的主机。选择主机后会检查其已安装的智能体。安装新智能体后可「重新扫描」，连接失败时可「重试」，需要交互式 SSH 登录的主机也可手动选择智能体。也可通过「添加 SSH 主机…」手动输入别名。主机别名区分大小写。「重命名已保存的主机…」会将该主机的智能体偏好和仓库目录保留在新别名下。即使扫描没有找到智能体，也能将已保存的默认智能体重置为「自动」。

每台机器分别保存默认智能体。在设置中切换主机仅切换正在编辑的配置。提示词模板由所有机器共享；已有本机智能体例外的模板可选择「使用机器默认设置」清除例外。

<img src="docs/screenshots/ssh-agents.png" width="680" alt="SSH 主机检测到五个智能体，默认使用 Claude Code">

本机上若有同一仓库的多个工作副本，可在「启动环境」选择「本机」，展开「仓库路径例外」，添加仓库和要使用的本机文件夹。「仓库」留空时，选择 Git 工作副本会自动填入 GitHub 仓库名。每个仓库只能指定一个文件夹，例如 `Acme/App` 和 `acme/app` 指向同一仓库。折叠后，标题会显示例外数量。

在「启动环境 → 仓库目录所在主机」中选择主机，然后逐行填写目录，例如 `~/projects` 或 `/srv/git`。主目录在服务器上展开。保存后可「查找仓库」查看工作副本。

启动时按 Git 远程地址匹配工作副本，包括派生仓库的 `upstream`。多个副本匹配时可选择并记住路径。找不到副本时，终端提示选择文件夹并显示按回车将使用的目录。智能体不可用时，可选择备选智能体或明确打开远程 shell。

连接失败，可在同一终端用原草稿重试。如果在智能体启动前退出，启动器会尝试通过 SSH 删除其私有暂存文件。如果服务器无法连接或需要再次输入密码，终端会显示文件名，方便你重新连接后删除。强制关闭启动器也可能在远程主目录留下名为 `.triage-desk-<uuid>.sh` 的暂存文件。

本机需要 OpenSSH。服务器需要 POSIX shell 和可写的用户主目录。仓库搜索需要 Git，智能体通过远程交互式 shell 的 PATH 查找。Claude Code 使用原生 `--prefill` 将草稿作为命令行参数传入。在共享服务器上，有权查看该进程参数的人可以读取提示。如需避免提示出现在进程列表中，请自行打开 Claude 并使用**复制提示**。其他远程智能体需要 Python 3 和括号粘贴支持。如果两分钟内未能填入草稿，请先在面板中点击**复制提示**，再粘贴到远程智能体。等待确认已识别的文件夹信任对话框的时间不计入此限制。远程智能体以自身默认权限启动。**复制提示**也适用于已打开的 SSH 会话和其他智能体。

<img src="docs/screenshots/launch-environments.png" width="700" alt="启动环境选用 Ghostty 和自动输入提示词，并设置了本机仓库搜索目录">

**终端。** 设置 → *启动环境* → **智能体打开位置**提供*自动*或本平台的某个终端；未安装的终端会显示为禁用。

| 平台 | 终端 | 自动 |
|---|---|---|
| macOS | Terminal、iTerm2、Ghostty | 已安装 iTerm2 时使用它，否则使用 Terminal |
| Linux | GNOME Terminal、Konsole、Xfce Terminal、Ghostty、kitty、Alacritty、xterm | `$TERMINAL`，然后是第一个已安装的终端模拟器 |
| Windows | Windows Terminal、PowerShell 窗口 | 已安装 Windows Terminal 时使用它 |

iTerm2、Ghostty（macOS）、GNOME Terminal、Konsole、Xfce Terminal 和 Windows Terminal 会打开标签页；其他终端每次启动都会打开新窗口。已保存但未安装的终端会回退到“自动”。本地和 SSH 启动的 Toast 提示都会说明这一点。

**提示传递方式。** Claude Code 以其原生 `--prefill` 草稿打开提示。在 Windows 上这要求 Claude Code 是 `.exe`：通过 npm 安装的版本（`.cmd` 包装脚本）按其他智能体的方式处理，因为 `cmd.exe` 无法原样传递提示。Scoop、bun、Chocolatey、Volta、mise 或 proto 的 `.exe` 包装程序同样如此，因为它们可能启动 `.cmd`（[提示传递方式](docs/REFERENCE.md#prompt-delivery)）。对于其他所有智能体，**设置 → 启动环境 → 提示传递方式**提供：

- **填入智能体**（默认，推荐）：一个小型粘贴包装器会等到智能体的输入框就绪，然后把提示粘贴进去，但不按 Enter。macOS 上需要 Python 3（`xcode-select --install`），Linux 上需要 Python 3，Windows 上需要 Windows 10 1809 或更高版本；不满足时，启动会改用剪贴板，设置和 Toast 提示会说明如何解决。本地启动时如果自动粘贴超时，可直接从剪贴板粘贴提示。
- **复制到剪贴板**：智能体以空白状态打开，由你自行粘贴提示（macOS 上按 ⌘V，Linux 终端中按 Ctrl+Shift+V，Windows 上按 Ctrl+V）。

Toast 提示会写明智能体和终端，例如*已在 Ghostty 中打开 Codex（/path）：提示将出现在输入框中，尚未发送——检查后按 Enter*。

**智能体。** 默认情况下，启动会打开一个带有提示的新 DSH 对话；菜单列出本机已安装的编码智能体：Claude Code、Codex、opencode、Gemini CLI、Cursor Agent、Antigravity（`agy`）、pi、Aider、Amp、Droid、Goose 和 Crush。可以在设置中选择其他默认目标，或添加自己的命令。命令必须恰好包含一个未加引号的 `{prompt}`，作为独立参数，或紧跟在 `--flag=` 之后。

与 Orca 的默认设置一样，本地智能体以**完全访问**模式启动：每个内置命令都带有该智能体跳过权限确认的参数，例如 `codex --dangerously-bypass-approvals-and-sandbox` 或 `agy --dangerously-skip-permissions`。此时，场景要求智能体先确认的步骤（例如推送）只依赖智能体遵循提示。如需恢复权限确认，在设置中从该智能体的命令里删除这个参数（[各智能体的参数](docs/REFERENCE.md#agents)）。

详情：[终端启动器参考](docs/REFERENCE.md#terminal-launcher)。

## 设置

面板标题栏中的齿轮按钮会打开设置。保存的设置通常直接作用于正在运行的插件，无需重启，因此保存期间 `triage_desk` 工具保持可用。最常用的字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `orgs` | `[]` | 要扫描的组织（最多 10 个）；留空则自动检测 |
| `includePersonal` | `true` | 包含你的个人仓库 |
| `refreshSeconds` | `1200` | 自动刷新间隔，15–3600 秒 |
| `requireGreenChecks` | `true` | 关闭后，检查尚未完成或已失败但满足其他条件的 PR 也会列入“可以合并”。无论此设置是否开启，GitHub 标记为 `BLOCKED` 的 PR 都不会列入。 |
| `defaultAgent` | `dsh` | 「本机」的默认目标。选 `dsh` 可打开新的 DSH 对话，也可指定本机智能体 ID。每台 SSH 主机单独设置。 |
| `defaultScenario` | 空 | 按任务选择，或保存适用于该行的场景 ID |
| `sshServers` | `[]` | SSH 别名、首选智能体 `agent`、可选的备选智能体 `alternatives` 及有序的远程路径（绝对路径或 `~/…`） `folders`。已有的 `cwd` 会作为单个文件夹读取。 |
| `terminal` | `auto` | 启动所用的终端：`auto` 或某个终端 ID |
| `promptDelivery` | `paste` | `paste`（填入智能体）或 `clipboard`（复制到剪贴板） |

所有字段（包括智能体、场景和克隆搜索）见[配置参考](docs/REFERENCE.md#configuration)。

## 开发

```sh
npm install     # 安装开发依赖并启用 pre-commit 钩子
npm run check   # lint、文档链接以及所有离线 smoke
```

`npm run smoke:host` 是针对 GitHub 的线上检查，会消耗配额，因此不属于 `npm run check`。smoke 说明、目录结构和发布流程见[参考文档](docs/REFERENCE.md#development)；模块地图见[架构](docs/ARCHITECTURE.md)。

## 许可证

[MIT](LICENSE)
