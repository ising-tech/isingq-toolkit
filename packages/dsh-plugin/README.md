# @ising-tech/isingq-dsh-plugin

Native IsingQ integration for DeepSeek Harness. The Plugin registers twelve typed tools in the DSH process and reuses `@ising-tech/isingq-core` for QUBO guidance, validation, public knowledge, HTTPS solving, and local result records.

[中文说明](#中文说明)

## Install

Install into the Profile the desktop app actually runs. Use the CLI bundled with the app so the install targets the same runtime:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add @ising-tech/isingq-dsh-plugin@0.8.2
```

`0.8.2` is not published yet; this is the post-publication registry command. For a local candidate, pass the packed tarball path instead. Confirm the bundled CLI reports `0.2.2-rc.1` before installing.

The app loads its Profile at startup, so fully quit the app (not only the window) and reopen it. Read the installed version back without printing any configuration:

```bash
node -e "console.log(require(process.env.HOME + '/.dsh/profiles/desktop/node_modules/@ising-tech/isingq-dsh-plugin/package.json').version)"
```

Do not edit the installed package in place. To recover, remove it and fully restart:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @ising-tech/isingq-dsh-plugin
```

After reopening, confirm that twelve `isingq_*` tools are available. Do not enable this native Plugin and an IsingQ MCP bridge in the same Profile.

## Configure an API Key

1. Sign in or register at [IsingQ Cloud](https://console.isingq.com/).
2. Open **Settings → API → Create API** and create a personal API Key.
3. Ask the Agent to call `isingq_api_key_setup`, then enter the Key in the operating system's private prompt.

The API Key is stored in a private local file and used only for HTTPS authentication with the IsingQ API. It does not enter Agent chat, tool arguments, DSH Profile configuration, issues, or logs.

A Headless deployment administrator may inject `ISINGQ_API_KEY` before the Agent process starts. The runtime does not persist it. The Agent must not inspect, set, copy, or echo this administrator-provided value.

The private prompt starts only local operating-system components: `osascript` on macOS, PowerShell Forms on Windows, or `zenity`, `kdialog`, and `systemd-ask-password` on Linux. It does not download or execute remote scripts.

## Solve safely

Before `isingq_solve_start`, the Agent must show the variable mapping, objective, constraints, penalties, matrix summary, and SHA-256, then obtain your explicit confirmation.

Once the DSH Host permits `isingq_solve_start`, the Plugin creates the remote task immediately. It does not open a second operating-system solve prompt; any additional confirmation is controlled by the Host's tool-permission policy.

## Tools

| Tool | Purpose | Network |
| --- | --- | --- |
| `isingq_update_check` | Explicit stable-version check; automatic notices use runtime background work | Version metadata only |
| `isingq_api_key_setup` | Configure or replace the local API Key through a private OS prompt | No |
| `isingq_knowledge_get` | Read versioned public IsingQ knowledge | No |
| `isingq_modeling_guide_get` | Get QUBO modeling and constraint guidance | No |
| `isingq_qubo_validate` | Validate a QUBO and produce a matrix summary | No |
| `isingq_delivery_validate` | Validate supplied delivery artifacts and derive objective report facts; business correctness remains unverified | No |
| `isingq_report_verify` | Verify declared finite integer models locally; consume computed reports and rank only provided feasible candidates | No |
| `isingq_solve_start` | Submit a confirmed QUBO solve task | Yes |
| `isingq_solve_poll` | Query task status once and save the result | Yes |
| `isingq_solve_result_get` | Read a locally stored solve result | No |
| `isingq_resource_list` | List local public knowledge resources | No |
| `isingq_resource_read` | Read one local public knowledge resource | No |

## Data boundary

Modeling guidance, QUBO validation, public knowledge, and result records stay on the user's computer. A QUBO matrix is sent to IsingQ only after the confirmed solve tool is called.

API requests use HTTPS. Matrix upload uses a short-lived signature and does not carry the personal API Key. The Key remains outside Agent-visible inputs and outputs.

## Compatibility

- Node.js 18.17 or later.
- Minimum supported DeepSeek Harness baseline: `0.1.0-rc.7`.
- `engines.dsh` and `@deepseek-ai/dsh-tools` peer range: `>=0.1.0-rc.7 <0.3.0-0`.
- Current development validation version: `0.2.2-rc.1`.

DSH 0.2 reads `engines.dsh` alone when it is declared and falls back to `@deepseek-ai/dsh-*` peers only when it is absent. This range covers the `0.1.x` and `0.2.x` runtime lines that share the `defineTool` / `ctx.tools` API the Plugin uses; newer minor lines still need a compatibility check before this range is widened.

### Compatibility policy

`engines.dsh` is the compatibility contract, not a per-release pin: a new patch or prerelease on a supported line installs without a Plugin release. This release was validated against DSH `0.2.2-rc.1` with the full-package acceptance script below. Repository unit tests pin `@deepseek-ai/dsh-tools@0.1.0-rc.8`; they do not exercise newer SDK builds, so widen the range only after rerunning full-package acceptance on the target host.

## Verification

`scripts/verify-dsh-plugin.js` runs the full acceptance on an isolated `DSH_HOME`: it installs the packed plugin and core tarballs, boots the real host, and checks 12 tools, 13 resources, the three local tool results, the resolved core path/version/digest, host stability across a grace window, and a separate shutdown snapshot.

```bash
node scripts/verify-dsh-plugin.js \
  --host desktop --host-version 0.2.2-rc.1 \
  --dsh "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --plugin <plugin.tgz> --core <core.tgz> \
  --out /tmp/isingq-verify-desktop
```

A copied `index.mjs` or a call that succeeds just before the host exits is not acceptance; the script fails when the host does not survive the grace window.

## Troubleshooting

- **Tools are missing:** verify that the package is present in the target Profile and reconciled into `dsh.profile.bundles`, remove any duplicate IsingQ MCP bridge, then restart the Profile only if it did not reload.
- **API Key is missing:** call `isingq_api_key_setup`; never paste the Key into Agent chat.
- **Installation reports a peer conflict:** confirm that DSH is within the documented `0.1` compatibility range.

---

## 中文说明

这是面向 DeepSeek Harness 的 IsingQ 原生 Plugin。它在 DSH 进程内注册 12 个 typed tools，并复用 `@ising-tech/isingq-core` 提供 QUBO 建模引导、校验、公开知识、HTTPS 求解和本地结果记录。

## 安装

安装到桌面端实际使用的 Profile。使用应用自带的 CLI，确保安装目标与运行目标一致：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add @ising-tech/isingq-dsh-plugin@0.8.2
```

`0.8.2` 尚未公开发布；这是发布后的 registry 命令。本地候选请改为传入打包 tarball 路径。安装前先确认自带 CLI 版本为 `0.2.2-rc.1`。

桌面端在启动时加载 Profile，因此必须完全退出应用（只关窗口不够）后重新打开。用以下命令回读安装版本，不打印任何配置：

```bash
node -e "console.log(require(process.env.HOME + '/.dsh/profiles/desktop/node_modules/@ising-tech/isingq-dsh-plugin/package.json').version)"
```

不要直接修改已安装包。恢复方式：移除插件后完全重启：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @ising-tech/isingq-dsh-plugin
```

重新打开后确认出现 12 个 `isingq_*` 工具。不要在同一个 Profile 中同时启用该原生 Plugin 和 IsingQ MCP Bridge。

## 配置 API Key

1. 登录或注册[玉盘·伊辛云](https://console.isingq.com/)。
2. 进入 **设置 → API → 创建API**，创建个人 API Key。
3. 让 Agent 调用 `isingq_api_key_setup`，在操作系统私密输入框中填写 Key。

API Key 保存在本机私有文件中，只用于 IsingQ API 的 HTTPS 鉴权。它不会进入 Agent 对话、工具参数、DSH Profile 配置、Issue 或日志。

Headless 部署管理员可以在 Agent 进程启动前注入 `ISINGQ_API_KEY`，运行时不会持久化该变量。Agent 不得检查、设置、复制或回显管理员预置的值。

私密输入框只启动本机系统组件：macOS 使用 `osascript`，Windows 使用 PowerShell Forms，Linux 使用 `zenity`、`kdialog` 或 `systemd-ask-password`。它不下载或执行远程脚本。

## 安全求解

调用 `isingq_solve_start` 前，Agent 必须展示变量映射、目标函数、约束、Penalty、矩阵摘要和 SHA-256，并取得你的明确确认。

DSH Host 放行 `isingq_solve_start` 后，Plugin 会立即创建远端任务，不再弹出第二个操作系统求解确认框。是否增加确认由 Host 的工具权限策略决定。

## 工具

| 工具 | 作用 | 是否联网 |
| --- | --- | --- |
| `isingq_update_check` | 用户主动查询版本；自动提醒由后台完成 | 仅版本元数据 |
| `isingq_api_key_setup` | 通过操作系统私密输入框配置或更换 API Key | 否 |
| `isingq_knowledge_get` | 查询版本化的 IsingQ 公开知识 | 否 |
| `isingq_modeling_guide_get` | 获取 QUBO 建模与约束引导 | 否 |
| `isingq_qubo_validate` | 校验 QUBO 并生成矩阵摘要 | 否 |
| `isingq_delivery_validate` | 本地校验交付契约并生成客观摘要；不证明业务正确性或测试真实性 | 否 |
| `isingq_report_verify` | 本地复算数学规格、候选与基线，消费核验报告；仅排名供应可行候选 | 否 |
| `isingq_solve_start` | 提交已经确认的 QUBO 求解任务 | 是 |
| `isingq_solve_poll` | 查询一次任务状态并保存结果 | 是 |
| `isingq_solve_result_get` | 读取本机保存的求解结果 | 否 |
| `isingq_resource_list` | 列出本机公开知识资源 | 否 |
| `isingq_resource_read` | 读取一项本机公开知识资源 | 否 |

## 数据边界

建模引导、QUBO 校验、公开知识和结果记录在用户电脑上完成。只有用户确认并调用求解工具后，QUBO 矩阵才会提交到 IsingQ。

API 请求使用 HTTPS。矩阵上传使用短期签名，不携带个人 API Key；Key 不会进入 Agent 可见的输入或输出。

## 兼容性

- Node.js 18.17 或更高版本。
- DeepSeek Harness 最低兼容基线：`0.1.0-rc.7`。
- `engines.dsh` 与 `@deepseek-ai/dsh-tools` peer range：`>=0.1.0-rc.7 <0.3.0-0`。
- 当前开发验证版本：`0.2.2-rc.1`。

DSH 0.2 在声明了 `engines.dsh` 时只按该范围判断，未声明时才回退到 `@deepseek-ai/dsh-*` peer。该范围覆盖共用 `defineTool` / `ctx.tools` API 的 `0.1.x` 与 `0.2.x` 运行时；更新的次版本线仍需先做兼容性验证再放宽范围。

### 兼容策略

`engines.dsh` 是兼容契约，不是逐版本钉死：同一支持线内的补丁或预发布版本无需重新发布 Plugin。本次验证对应 DSH `0.2.2-rc.1`，使用下方完整包验收脚本。仓库单测固定 `@deepseek-ai/dsh-tools@0.1.0-rc.8`，不会自动覆盖更新的 SDK；放宽范围前必须在目标 Host 上重跑完整包验收。

## 验证

`scripts/verify-dsh-plugin.js` 在隔离 `DSH_HOME` 上完成完整包验收：安装候选插件与 core tarball，启动真实 Host，核对 12 个工具、13 个 Resources、三个本地工具字段、实际加载 core 的路径/版本/摘要、Host 在宽限期内的存活，以及独立的关闭快照。

```bash
node scripts/verify-dsh-plugin.js \
  --host desktop --host-version 0.2.2-rc.1 \
  --dsh "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --plugin <plugin.tgz> --core <core.tgz> \
  --out /tmp/isingq-verify-desktop
```

复制 `index.mjs` 或在 Host 退出前调用成功都不算验收；Host 未通过宽限期时脚本会失败。

## 故障排查

- **没有出现工具：**确认包已安装到目标 Profile 并进入 `dsh.profile.bundles`，移除重复的 IsingQ MCP Bridge；只有 Profile 未重新加载时才重启。
- **缺少 API Key：**调用 `isingq_api_key_setup`，不要把 Key 粘贴到 Agent 对话。
- **安装出现 peer 冲突：**确认 DSH 位于文档声明的 `0.1` 兼容范围内。
