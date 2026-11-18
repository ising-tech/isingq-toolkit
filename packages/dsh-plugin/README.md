# @ising-tech/isingq-dsh-plugin

IsingQ 的 DeepSeek Harness 原生 Plugin，支持 QUBO 建模、校验、云端及内网本地求解器接入，在 DSH 进程内复用 `@ising-tech/isingq-core`。

简体中文 · [English](README.en.md)

本文对应 **0.9.x**，原生 Plugin 注册 **21 个工具**。安装包以 [npm](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin) 实际发布为准；安装后核对实际加载版本，源码不代表已发布。

## 安装

### 界面安装

在 DeepSeek Harness 中点击 **插件 → 添加插件**，输入 `@ising-tech/isingq-dsh-plugin`，再点击 **安装**，按界面提示完成即可，无需使用终端。

### 命令行安装

在实际使用的 Profile 中安装：

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

macOS 桌面端先完全退出应用，使用应用自带的 CLI `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，选择实际使用的 `desktop` Profile。其他入口使用各自的真实 Profile。

重新打开后验证实际加载的 Plugin 版本及对应工具。npm 安装的是已发布版本，使用本文的本地设备接入能力前须确认已加载 0.9.x。不要在同一个 Profile 中同时启用原生 Plugin 和 IsingQ MCP Bridge。

兼容范围：Node.js **18.17+**；DSH 与 `@deepseek-ai/dsh-tools` 均为 **`>=0.1.0-rc.7 <0.3.0-0`**。开发验证基线为 DSH `0.2.2-rc.1`。

## 基本使用

对 Agent 描述问题，先查看变量、目标函数、约束与矩阵摘要，在确认求解时选择目标并明确确认：

- **云端**：查看公开机型与适配建议；实际提交前在[云平台](https://console.isingq.com/api-keys)创建个人 API Key，通过 `isingq_api_key_setup` 安全输入框配置，再选择算力券或账户余额。
- **本地**：说“添加／管理本地求解器”，在配置页填写设备名称和服务地址、测试连接。支持多台设备，不要求云端 API Key，不使用云端算力券或余额。

机型建议不阻塞用户选择；保存本地配置不提交求解。调用记录保留实际求解目标及当时的查阅位置，分别回到云平台或本地可访问地址。

API Key 不进入对话、工具参数、Profile 配置或日志。云端任务提交矩阵到 IsingQ，内网本地任务发送到选定设备。

## 更新、卸载与排查

更新时保留原 Profile 和分发方式，按 DSH 的插件管理流程安装已发布版本，再重载并核对实际版本。Toolkit 内置版本检查只提供提醒。

卸载：

```bash
dsh plugin --profile <profile> remove @ising-tech/isingq-dsh-plugin
```

- **工具缺失**：确认选对 Profile、没有重复 MCP Bridge，先重载，必要时重启。
- **版本冲突**：核对上面的 DSH 和 SDK 兼容范围。
- **本地无法连接**：核对网络和服务地址，使用管理页测试连接。
- **云端鉴权失败**：通过安全输入框更换 Key，不要粘贴到聊天中。

[Toolkit 使用说明](https://github.com/ising-tech/isingq-toolkit#readme) · [接口与开发验收](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md) · [求解目标接口](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/solver-targets.md) · [Apache-2.0](LICENSE)
