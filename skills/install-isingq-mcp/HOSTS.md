# Agent Host 接入差异

这份文件只记录 Host 特例，不能把任何一项当成所有 Agent 的通用行为。

## 通用原则

- 每个 Host 只选择一种分发路径；同一 Host 不得同时加载 Plugin、npx、Release 或源码 MCP。
- 使用独立程序时，同一台电脑可以由不同 Host 分别注册同一个绝对路径和 `serve` 参数；Plugin 和 npx 不要求存在这份程序。
- 优先通过 Host 官方 MCP 设置或其明确公开的用户配置接入。
- Host 自动生成的代理、缓存、会话配置和运行时端口不属于安装器写入目标。
- 沙箱阻止用户目录写入时，请求用户授权；不允许换到项目目录保存 Key 或伪造“安装完成”。
- 求解前由 Agent 展示模型、所选目标、数据去向与适用资源摘要并取得明确确认；矩阵/hash 细节按需提供。提交工具被 Host 放行后创建任务，MCP 不再弹出额外的系统求解确认框。

## 工具数量与版本

以 Host 实际加载的版本与入口为准，不能用仓库版本、旧截图或单独 CLI 探针判定接入完成。

| 实际加载版本 | MCP 默认 `serve` | MCP `serve --technical` | DSH 原生 Plugin |
| --- | ---: | ---: | ---: |
| 0.9.x | 4 | 20 | 21 |
| 0.8.2（兼容已发布旧版） | 10 | 不适用 | 12 |

0.9.x 默认 MCP 的确切工具为 `isingq_api_key_setup`、`isingq_knowledge_get`、`isingq_modeling_guide_get`、`isingq_solve`。DSH 的 21 项来自 19 个共享 Core 工具及 2 个资源工具；不包含 MCP 统一求解门面。

其他版本按对应发布文档和实际工具清单验证，不猜测数量。npm/npx 只安装已发布包；没有加载 0.9.x 时，不宣称本地目标接入已就绪，也不为凑数量重复安装或自动切换技术入口。API Key 配置仅用于云端，不能作为本地接入的前提。

## Codex Plugin

- 只有当前会话已出现 Plugin 提供的原生 `isingq_*` 工具时，才选择 `codex-plugin`。
- 已加载 Plugin 不需要额外写入 Codex MCP 配置，也不得继续安装独立 MCP。
- 从实际加载的 server 或 Plugin metadata 读取 `loaded_version`，不能用仓库文件版本代替。

## WorkBuddy

- 用户 stdio 源配置：`~/.workbuddy/mcp.json`。
- `~/.workbuddy/.mcp.json`、`connector-proxy` 和本地代理端口是 WorkBuddy 生成的运行状态，不得由 Skill 修改。
- WorkBuddy 可以在内部把多个底层 stdio MCP 聚合到代理；看到代理不表示底层 stdio 配置错误。
- 写入源配置后先重连连接器；无法动态重载或工具仍未更新时，再重启、信任并确认原生工具已加载。

## Trae

- 不得把 `~/.workbuddy/*` 当成 Trae 配置。
- Trae 沙箱可能阻止 Agent 写入用户安装和配置目录；应请求用户对准确脚本与目录授权或加入 allowlist。
- 当前 Skill 不猜测 Trae 私有配置路径。脚本输出标准 stdio JSON，由 Agent 通过 Trae 的 MCP 设置页面导入。
- 导入并重连前，`host_registered=false` 和 `tools_loaded=false` 是正确状态；Trae 无法动态重载时再重启。

## DeepSeek Harness

- 优先使用 `@ising-tech/isingq-dsh-plugin` 原生包，不通过 `dsh-mcp-client` 启动 stdio 子进程。
- 安装必须指定用户实际使用的 Profile，例如 `dsh plugin --profile web add @ising-tech/isingq-dsh-plugin`。
- 重启后按“工具数量与版本”表核对实际加载的 `isingq_*` 工具；工具名不带 `mcp__isingq__` 前缀。
- 不得在同一 Profile 同时加载原生 Plugin 和旧 MCP Bridge，移除旧配置前需要用户同意。

## Codex MCP、Claude Code、Cursor、VS Code

- 使用 `configure-host --name <host>` 只写入用户指定的目标 Host；不得使用“检测到就全部配置”的策略。
- Codex 只有在未选择 Plugin 路径时才进入本节；不能让 Plugin 和独立 MCP 同时注册。
- 配置写入成功不等于工具已加载；先重连 MCP，Host 不支持动态重载时再重启，并按“工具数量与版本”表核对原生工具。

## 其他 Host

- 使用 `isingq-mcp config --json` 获取标准 stdio 配置。
- 通过该 Host 的官方 MCP 设置导入；如果它只支持 Streamable HTTP，不要自行把本地 stdio MCP 改造成非标准 socket。
