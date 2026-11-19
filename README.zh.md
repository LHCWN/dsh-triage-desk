# Triage Desk

[![check](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml/badge.svg)](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml)
[![npm version](https://img.shields.io/npm/v/dsh-triage-desk.svg)](https://www.npmjs.com/package/dsh-triage-desk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，每天早上只回答一个问题：**现在有什么需要我处理？** 它把 GitHub 动态汇总成一个收件箱面板：等待你审核的 PR、可以合并的自己的 PR、需要答复的讨论、失败的 CI，以及新的或分配给你的议题。只需一次点击，就能针对任意条目打开编码智能体，并带好准备好的提示，由你检查后再发送。所有操作都通过 GitHub CLI 在本地完成；插件从不存储或转发访问令牌。

[English](README.md) · [参考文档（英文）](docs/REFERENCE.md) · [架构](docs/ARCHITECTURE.md) · [更新日志](CHANGELOG.md)

## 显示内容

- **等待你审核**：直接或通过团队请求你审核、且你尚未审核当前 head 的 PR。
- **需要重新审核**：自你审核后有新提交、被重新请求审核，或作者回复了你的 PR。
- **可以合并**：你的已获批准且可以合并的 PR；默认仅限检查通过的。
- **需要你处理**：被要求修改、存在冲突、有审核者评论的 PR，分配给你的议题，以及尚未回复的提及。
- **CI 失败**：你的 PR、你维护的默认分支，以及最新提交由你在过去一周内提交的分支上的红色检查。
- **你仓库中的新议题**：最近 30 天内未分配的议题，不计入关注计数。
- **延后**：按行、按分类或按所选条目延后，直到有新动态、明天或下周。
- **启动场景**：命名的可编辑提示，可在本地克隆中打开编码智能体，或打开新的 DSH 对话。
- **智能体工具**：`triage_desk` 把同一份快照提供给 DSH 智能体，并可按要求打开终端。
- **来源与语言**：个人仓库加最多 10 个组织；面板跟随 DSH 的界面语言（英文或中文）。

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

行（或分类标题）上的终端按钮会打开启动菜单：先选择目标（**DSH — 本应用**或已安装的智能体），再选择场景。单行场景会在仓库的本地克隆中打开智能体；分类场景会用所有可见行的清单启动一个智能体。提示总是已准备好但**尚未发送**。智能体选择器下方的一行会说明在哪里打开以及提示如何送达，例如*在 Ghostty 中打开 · 提示自动填入输入框，尚未发送*。

**终端。** 设置 → *终端与智能体* → **智能体打开位置**提供*自动*或本平台的某个终端；未安装的终端会显示为禁用。

| 平台 | 终端 | 自动 |
|---|---|---|
| macOS | Terminal、iTerm2、Ghostty | 已安装 iTerm2 时使用它，否则使用 Terminal |
| Linux | GNOME Terminal、Konsole、Xfce Terminal、Ghostty、kitty、Alacritty、xterm | `$TERMINAL`，然后是第一个已安装的终端模拟器 |
| Windows | Windows Terminal、PowerShell 窗口 | 已安装 Windows Terminal 时使用它 |

iTerm2、Ghostty（macOS）、GNOME Terminal、Konsole、Xfce Terminal 和 Windows Terminal 会打开标签页；其他终端每次启动都会打开新窗口。已保存但未安装的终端会回退到“自动”，启动时的 Toast 提示会说明这一点。

**提示传递方式。** Claude Code 以其原生 `--prefill` 草稿打开提示。在 Windows 上这要求 Claude Code 是 `.exe`：通过 npm 安装的版本（`.cmd` 包装脚本）按其他智能体的方式处理，因为 `cmd.exe` 无法原样传递提示。对于其他所有智能体，设置 → **提示传递方式**提供：

- **填入智能体**（默认，推荐）：一个小型粘贴包装器会等到智能体的输入框就绪，然后把提示粘贴进去，但不按 Enter。macOS 上需要 Python 3（`xcode-select --install`），Linux 上需要 Python 3，Windows 上需要 Windows 10 1809 或更高版本；不满足时，启动会改用剪贴板，设置和 Toast 提示会说明如何解决。
- **复制到剪贴板**：智能体以空白状态打开，由你自行粘贴提示（macOS 上按 ⌘V，Linux 终端中按 Ctrl+Shift+V，Windows 上按 Ctrl+V）。

Toast 提示会写明智能体和终端，例如*已在 Ghostty 中打开 Codex（/path）：提示将出现在输入框中，尚未发送——检查后按 Enter*。

**智能体。** 内置预设涵盖 Claude Code、Codex、opencode、Gemini CLI、Cursor Agent、Antigravity（`agy`）和 pi；设置中的**查找智能体**还能检测 Aider、Amp、Droid、Goose 和 Crush，你也可以添加自己的命令。命令必须恰好包含一个未加引号的 `{prompt}`，作为独立参数，或紧跟在 `--flag=` 之后。

详情：[终端启动器参考](docs/REFERENCE.md#terminal-launcher)。

## 设置

面板标题栏中的齿轮按钮会打开设置。保存的设置直接作用于正在运行的插件，无需重启，因此保存期间 `triage_desk` 工具始终可用。最常用的字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `orgs` | `[]` | 要扫描的组织（最多 10 个）；留空则自动检测 |
| `includePersonal` | `true` | 包含你的个人仓库 |
| `refreshSeconds` | `1200` | 自动刷新间隔，15–3600 秒 |
| `requireGreenChecks` | `true` | 仅在检查通过或没有检查时列入*可以合并* |
| `defaultAgent` | `claude` | 启动菜单中选中的智能体 |
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
