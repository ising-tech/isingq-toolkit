# 安装 IsingQ MCP

默认入口及英文版本：[SKILL.md](SKILL.md)

## 安全与判断规则

- 不得通过聊天、命令参数、环境变量、日志、Host 配置或 Agent 可见输出接收 IsingQ API Key。本机没有有效 Key 时，脚本会弹出操作系统原生隐藏输入框。
- 不得绕过 Host 沙箱。运行前应请求用户批准脚本写入用户安装目录、私有配置目录和目标 Host 配置目录；用户拒绝时停止，并报告被阻塞阶段。
- 根据当前用户请求或会话确定目标 Host，不能根据电脑安装了哪些应用来猜。一次只配置一个 Host。
- 必须区分每个 Host 的用户源配置、自动生成的运行状态以及代理/缓存层。禁止用另一个产品的路径推断当前 Host，也禁止通过修改生成状态来注册 MCP。
- 手写 NDJSON 调用成功只能证明服务可访问。标准 MCP 注册出 7 个工具，或 DSH 原生 Plugin 注册出 9 个工具，接入才算成功。

不同 Host 的边界和回退方式见：[HOSTS.md](HOSTS.md)。

## Codex Plugin 路径

如果当前 Codex 会话已经能看到 IsingQ Plugin 提供的原生 `isingq_api_key_setup` 工具：

1. 不下载二进制，也不修改 Codex MCP 配置；Plugin 已经内置并注册源码 MCP。
2. 先取得用户明确同意，再调用不含 API Key 参数的 `isingq_api_key_setup` 打开操作系统安全输入框。只有用户明确要求更换已有 Key 时才传 `force=true`。
3. 确认 7 个 `isingq` 原生工具，使用 `topic="company"` 调用 `isingq_knowledge_get`，并说明真实求解仍受模型确认门禁保护。

Plugin 路径成功后不得继续执行独立安装脚本。

## DeepSeek Harness 原生 Plugin 路径

目标 Host 是 DSH 时优先安装原生包，不再配置 `dsh-mcp-client`：

1. 确认用户实际使用的 Profile，不能看到 DSH 就默认写成 `web`。
2. 在用户桌面会话运行 `dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin`；仅在复现或回滚时显式指定版本。
3. 完全重启对应 Profile，确认出现 9 个 `isingq_*` 工具，其中包括 `isingq_resource_list` 和 `isingq_resource_read`。
4. 本机没有有效 Key 时，先取得用户同意，再调用 `isingq_api_key_setup`。

同一 Profile 不得同时加载原生 Plugin 和旧 MCP Bridge。发现两者并存时，先验证原生路径，再取得用户同意，通过官方 `dsh plugin` 命令移除旧桥接配置。

## 独立安装或升级

脚本路径相对于本文件解析。先把下方 `<target-host>` 替换成本次请求所在的 Host，只能是 `workbuddy`、`codex`、`claude-code`、`cursor`、`vscode`、`trae` 或 `generic` 中的一个，再由 Agent 自行运行对应脚本：

- macOS：`ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-macos.sh`
- Linux 桌面：`ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-linux.sh`
- Windows PowerShell：`$env:ISINGQ_MCP_TARGET_HOST='<target-host>'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1`

这些仓库内置脚本只会使用 Node.js 18+ 和 npm 安装当前检出的源码，不下载或执行远程脚本。不得要求用户操作终端。脚本应在用户桌面会话运行；它会复用已有有效 Key、仅在缺少 Key 时安全弹窗，并保留本地求解记录。npm 包可用后，等价的通用配置命令是 `npx -y @ising-tech/isingq-mcp config --json --npx`。

对于 WorkBuddy、Codex、Claude Code、Cursor 和 VS Code，脚本只写入指定 Host。对于 Trae 或 `generic`，脚本只输出直接 stdio JSON，不猜测或写入私有 Host 路径；应通过对应 Host 的 MCP 设置页面导入。

## 判断最终状态

读取脚本最后输出的 JSON，逐项报告：

- `binary_installed`：原生可执行文件已安装且哈希校验通过。
- `api_key_configured`：本机 Key 有效且 `self-check` 通过。
- `host_registered`：指定 Host 的源配置已写入或导入。
- `native_tools_loaded`：标准 MCP 出现 7 个工具，或 DSH 原生 Plugin 出现 9 个工具后才能设为 true。
- `blocked_by` 与 `next_action`：准确的阻塞原因和需要用户批准的下一步。

四个布尔值没有全部为 true 时，禁止声称“安装完成”。Trae 脚本在 MCP 设置导入前正常应返回 `host_registered=false`。

## Host 验证

1. 完全退出并重启目标 Host，由用户决定是否批准信任提示。
2. 标准 MCP 应出现 7 个带 `outputSchema.type="object"` 的工具；DSH 原生 Plugin 应出现 9 个 typed tools。
3. 先用 `topic="company"` 调用 `isingq_knowledge_get`，再调用 `isingq_modeling_guide_get`；两者都是不联网的冒烟验证。
4. 不得为了测试安装而提交真实求解任务。

## 失败处理

- 沙箱拒绝：请求 Host 对准确脚本和用户目录显式授权或加入 allowlist；禁止把 Key 改存项目目录来绕过。
- `local_source_install_failed`：确认 Node.js 18+、npm 和用户安装目录写入权限。
- npm 包不可用：使用当前检出的本地脚本或官方固定版本 Release，禁止自行猜测下载来源。
- `host_config_write_denied`：展示 `isingq-mcp config --json`，通过 Host MCP 设置页面导入。
- 红点或没有工具：检查版本和绝对路径，重启 Host，批准信任，然后查看 MCP 日志。

用户只需要说：“读取 `install-isingq-mcp` Skill，帮我安装并接入当前 Agent。”
