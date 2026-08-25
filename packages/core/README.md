# @ising-tech/isingq-core

IsingQ 本地 Agent 集成的共享运行时，包含公开知识、QUBO 建模与校验、IsingQ HTTPS 调用、API Key 安全输入和本地求解记录。求解授权由 Agent 与 Host 负责；运行时不额外弹出操作系统求解确认框。

该包不直接注册 MCP 或 DSH 工具，通常不需要最终用户单独安装。标准 MCP 使用 `@ising-tech/isingq-mcp`，DeepSeek Harness 使用 `@ising-tech/isingq-dsh-plugin`。

交互环境默认从用户私有配置文件读取 API Key。Headless 管理员可以在 Agent 进程启动前注入 `ISINGQ_API_KEY`；Agent 不得接收、设置或显示该变量。Toolkit 默认 Adapter 固定访问 `https://api.isingq.com`；显式构造 `IsingQTransport` 的嵌入式调用方自行提供 endpoint 和 API Key provider。
