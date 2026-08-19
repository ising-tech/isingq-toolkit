# Agent Host 接入差异

这份文件只记录 Host 特例，不能把任何一项当成所有 Agent 的通用行为。

## 通用原则

- 每台电脑只安装一份 `isingq-mcp`；不同 Host 分别注册同一个绝对路径和 `serve` 参数。
- 优先通过 Host 官方 MCP 设置或其明确公开的用户配置接入。
- Host 自动生成的代理、缓存、会话配置和运行时端口不属于安装器写入目标。
- 沙箱阻止用户目录写入时，请求用户授权；不允许换到项目目录保存 Key 或伪造“安装完成”。

## WorkBuddy

- 用户 stdio 源配置：`~/.workbuddy/mcp.json`。
- `~/.workbuddy/.mcp.json`、`connector-proxy` 和本地代理端口是 WorkBuddy 生成的运行状态，不得由 Skill 修改。
- WorkBuddy 可以在内部把多个底层 stdio MCP 聚合到代理；看到代理不表示底层 stdio 配置错误。
- 写入源配置后仍需重启、信任并确认原生工具已加载。

## Trae

- 不得把 `~/.workbuddy/*` 当成 Trae 配置。
- Trae 沙箱可能阻止 Agent 写入用户安装和配置目录；应请求用户对准确脚本与目录授权或加入 allowlist。
- 当前 Skill 不猜测 Trae 私有配置路径。脚本输出标准 stdio JSON，由 Agent 通过 Trae 的 MCP 设置页面导入。
- 导入并重启前，`host_registered=false` 和 `native_tools_loaded=false` 是正确状态。

## DeepSeek Harness

- 优先使用 `@ising-tech/isingq-dsh-plugin` 原生包，不通过 `dsh-mcp-client` 启动 stdio 子进程。
- 安装必须指定用户实际使用的 Profile，例如 `dsh plugin --profile web add @ising-tech/isingq-dsh-plugin`。
- 重启后应看到 9 个 `isingq_*` 工具；工具名不带 `mcp__isingq__` 前缀。
- 不得在同一 Profile 同时加载原生 Plugin 和旧 MCP Bridge，移除旧配置前需要用户同意。

## Codex、Claude Code、Cursor、VS Code

- 使用 `configure-host --name <host>` 只写入用户指定的目标 Host；不得使用“检测到就全部配置”的策略。
- 配置写入成功不等于工具已加载，必须在 Host 重启后验证 7 个原生工具。

## 其他 Host

- 使用 `isingq-mcp config --json` 获取标准 stdio 配置。
- 通过该 Host 的官方 MCP 设置导入；如果它只支持 Streamable HTTP，不要自行把本地 stdio MCP 改造成非标准 socket。
