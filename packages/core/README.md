# @ising-tech/isingq-core

IsingQ 本地 Agent 集成的共享运行时，包含公开知识、QUBO 建模与校验、IsingQ HTTPS 调用、API Key 安全输入和本地求解记录。求解授权由 Agent 与 Host 负责；运行时不额外弹出操作系统求解确认框。

该包不直接注册 MCP 或 DSH 工具，通常不需要最终用户单独安装。标准 MCP 使用 `@ising-tech/isingq-mcp`，DeepSeek Harness 使用 `@ising-tech/isingq-dsh-plugin`。
