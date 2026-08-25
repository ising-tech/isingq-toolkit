# 安装 IsingQ MCP

Agent 应以 [SKILL.md](SKILL.md) 作为规范入口；本文件提供中文对照。

## 目标

只在用户指定的一个 Agent Host 中接入 IsingQ。选择唯一的分发路径，通过本机私密输入配置个人 API Key，在真实 Host 中验证原生工具，报告实际加载版本，然后停止。

Host 配置边界和回退方式见 [HOSTS.md](HOSTS.md)。只读取本次目标 Host 对应的章节。

## 不可突破的边界

- 不得通过对话、命令参数、环境变量、日志、Host 配置或 Agent 可见输出接收 IsingQ API Key。
- Headless 部署管理员可以在 Agent 启动前预置 `ISINGQ_API_KEY`。Agent 只能将其视为已配置的运行时来源，不得检查、设置、复制或回显。
- 用户没有 Key 时，引导其登录 `https://console.isingq.com/`，进入 **设置 → API → 创建API**。不得代替用户注册、读取、复制或显示 Key。
- 打开操作系统 API Key 私密输入框前先取得用户同意。只有用户明确要求更换已有 Key 时才使用 `force=true`。
- 只配置当前请求指定的 Host，不得根据电脑安装了哪些应用批量配置。
- 不得绕过 Host 沙箱或把凭据移到项目目录。只请求本路径所需的准确用户安装目录、私有配置目录和目标 Host 配置目录权限。
- 分发来源只允许 npm 官方组织和 `https://github.com/ising-tech/isingq-toolkit`。
- 不得为测试安装而提交真实求解。手写 NDJSON 只能证明进程可访问，不能证明 Host 已完成接入。
- `isingq_solve_start` 被 Host 放行后立即提交。Agent 调用前必须展示模型摘要和矩阵 SHA-256，并取得用户明确确认。

## 选择唯一分发路径

升级时保留当前已正常工作的分发方式。只有用户明确要求，或原路径不可用时才切换。

按以下顺序判断：

1. **Codex Plugin**：当前 Codex 会话已经出现 Plugin 提供的原生 `isingq_api_key_setup` 工具。
2. **DSH Plugin**：目标 Host 是 DeepSeek Harness。
3. **npx**：目标是标准 stdio MCP Host，并且本机已有 Node.js 18+ 与 npm。
4. **Release**：目标是标准 stdio MCP Host，但没有 Node.js 18+，或用户希望使用独立程序。
5. **source**：用户明确要求源码开发；或者 npm 和 Release 都不可用，并且已经存在官方源码检出。

一条路径达到验收条件后立即停止，不得再额外安装其他 Plugin、MCP Bridge、二进制或 npm 运行时。

## Codex Plugin 路径

1. 不下载二进制，也不修改 Codex MCP 配置；已安装 Plugin 会注册其内置源码 MCP。
2. 验证 7 个原生 `isingq` 工具，并读取实际加载的 server 或 Plugin 版本。
3. 取得用户同意后，调用无 API Key 参数的 `isingq_api_key_setup`。已有可读取配置时可以返回 `already_configured`。
4. 使用 `topic="company"` 调用 `isingq_knowledge_get`，完成不联网冒烟验证。

如果当前会话看不到原生工具，就不能选择这条路径。不能仅凭磁盘上存在文件判断 Plugin 已安装。

## DSH Plugin 路径

1. 确认实际使用的 Profile，不得默认选择 `web`、`tui` 或 `headless`。
2. 运行 `dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin`。只有复现或回滚时才显式指定版本。
3. 重启对应 Profile，验证 9 个 `isingq_*` 工具，其中包括 `isingq_resource_list` 和 `isingq_resource_read`，并记录安装包版本。
4. 取得用户同意后调用 `isingq_api_key_setup`，再调用 `isingq_knowledge_get(topic="company")`。

同一个 Profile 不得同时启用原生 Plugin 和旧 MCP Bridge。移除旧桥接属于另一个修改行为，需要用户批准。

## 标准 MCP 的 npx 路径

1. 确认本机已有 Node.js 18+ 和 npm，不修改全局包。
2. 对支持的命名 Host，运行 `npx @ising-tech/isingq-mcp configure-host --name <host> --npx`。
3. 对需要手工注册的 Host，运行 `npx @ising-tech/isingq-mcp config --json --npx`，通过其官方 MCP 设置导入原样 stdio JSON。
4. 先重连 `isingq`；只有 Host 不支持动态重载或仍加载旧版本时才重启。
5. 在 Host 内验证 7 个原生工具和实际 server 版本。然后取得用户同意，调用 `isingq_api_key_setup` 并执行本地知识冒烟验证。

不得运行 `setup`、通过 stdin 传 Key，或把 Key 放入 MCP JSON。由加载后的工具负责私密 Key 配置。

## 标准 MCP 的 Release 路径

1. 从官方 GitHub Release 选择当前系统和架构：macOS arm64/x64、Linux arm64/x64 或 Windows x64。
2. 下载固定版本程序和同一 Release 的 `SHA256SUMS`，执行前完成校验；任何不一致都必须停止。
3. 安装到用户拥有的程序目录，不要求管理员权限，也不执行宽泛的 PATH 修改。
4. 只在目标 Host 中注册该程序的绝对路径和 `serve` 参数。无法自动写入时，通过官方 MCP 设置导入准确 JSON。
5. 重连后验证 7 个原生工具和二进制/server 版本，再经用户同意通过 `isingq_api_key_setup` 配置 Key。

只有 Release 路径可以声称完成 Release 哈希校验。npm、Plugin 和 source 安装不能使用这一表述。

## source 路径

只在开发或上述明确回退条件下使用源码。远程读取 Skill 后若选择 source，应克隆官方仓库并重新读取本地文件；不得根据文档拼接安装脚本。

在用户桌面会话中，对唯一目标 Host 运行对应仓库脚本：

- macOS：`ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-macos.sh`
- Linux：`ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-linux.sh`
- Windows PowerShell：`$env:ISINGQ_MCP_TARGET_HOST='<target-host>'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1`

源码脚本要求 Node.js 18+ 和 npm，只安装当前检出的源码，保留本地记录，并可能打开 Key 私密输入框。它们不执行 Release 哈希校验。

## 验收状态

最终只报告一个与分发方式无关的状态对象：

```json
{
  "distribution_mode": "codex-plugin | dsh-plugin | npx | release | source",
  "runtime_available": true,
  "api_key_configured": true,
  "host_registered": true,
  "tools_loaded": true,
  "loaded_version": "<observed-version>",
  "blocked_by": null,
  "next_action": null
}
```

- `runtime_available`：所选 Plugin、包、二进制或 server 能实际初始化；不表示一定存在原生二进制。
- `api_key_configured`：本机已经私密保存非空 Key 且可以读取，不表示远端 API 已接受该 Key。
- `host_registered`：目标 Host 已接受源配置、手工导入或原生 Plugin 注册。
- `tools_loaded`：Host 内出现标准 MCP 的 7 个工具，或 DSH 原生 Plugin 的 9 个工具。CLI 或 NDJSON harness 不能把它设为 true。
- `loaded_version`：从实际加载 server、Plugin manager 或二进制观察到的版本；不得用仓库文件中的版本替代。
- `blocked_by`：稳定、可机读的阻塞原因；没有则为 null。
- `next_action`：解除阻塞所需的最小用户授权动作；没有则为 null。

只有 `runtime_available`、`host_registered` 和 `tools_loaded` 都为 true 时才能说“已接入”。只有这三项、`api_key_configured` 都为 true 且已观察到 `loaded_version` 时，才能说“可以求解”。

用户拒绝配置 Key 时，应报告工具已接入但尚不能求解。在用户发起的真实 API 操作成功前，不得把“已配置”描述成“远端有效”。

## 验证与升级

1. 先重连，再考虑重启，并让用户自行批准 Host 信任提示。
2. 在真实 Host 中确认工具数量与 typed schema。
3. 调用 `isingq_knowledge_get(topic="company")` 和 `isingq_modeling_guide_get`；两者都是本地、不联网验证。
4. 升级时保留当前分发方式和本地数据。重载后验证实际加载版本，包管理器或仓库版本不能代替运行版本。

## 失败处理

- **沙箱拒绝**：只请求准确路径和操作权限，不得改换凭据位置绕过。
- **npm 不可用或 Node 版本过低**：改选 Release，不得在用户未要求时安装 Node。
- **Host 配置写入失败**：输出准确 stdio JSON，通过 Host 官方 MCP 设置导入。
- **哈希不一致**：删除不可信下载并停止，不得执行，也不得改用未经验证的镜像。
- **没有工具或版本未更新**：检查 Host 源配置和 MCP 日志，先重连，必要时再重启。
- **Key 已配置但被拒绝**：报告远端认证错误，引导用户在玉盘·伊辛云更换或撤销 Key。
