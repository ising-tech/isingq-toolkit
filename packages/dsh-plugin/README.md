# @ising-tech/isingq-dsh-plugin

DeepSeek Harness 的 IsingQ 原生 Plugin。它在 DSH 进程内注册 9 个 `isingq_*` typed tools，并复用 `@ising-tech/isingq-core` 的建模、校验、公开知识、HTTPS 求解和本地记录逻辑。

安装到实际使用的 DSH Profile：

```bash
dsh plugin --profile web add @ising-tech/isingq-dsh-plugin
```

将 `web` 换成实际 Profile，完全重启后确认 9 个工具。不要在同一 Profile 同时加载该原生 Plugin 与 `dsh-mcp-client` 形式的 IsingQ MCP Bridge。

首次求解前，让 Agent 调用 `isingq_api_key_setup`。API Key 通过操作系统安全输入框写入用户本机，不进入工具参数或对话；每次提交求解仍需用户确认当前模型摘要与矩阵哈希。

当前兼容基线：DeepSeek Harness `0.1.0-rc.7`、`@deepseek-ai/dsh-tools` `0.1.0-rc.7`。
