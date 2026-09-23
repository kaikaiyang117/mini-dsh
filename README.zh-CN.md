# mini-dsh

[English](./README.md) | 中文（主要展示版本）

一个轻量、插件化、可恢复、可测评的 **Coding Agent Harness**，聚焦长任务可靠执行、渐进式工具发现、持久会话、上下文管理与可复现测评。

受 DeepSeek Harness / DSH 的设计启发，基于 Cordis 组织插件；核心 Harness 逻辑在本仓库实现。它不是完整 DSH clone，也不是生产级替代品。

## 项目特点

- **Durable Session & Resume**：追加式 JSONL 历史、会话恢复与中断 Tool Call 补齐。
- **Tool Runtime & Parallel Scheduling**：Schema 校验、统一错误结果、显式安全工具的有界并行。
- **Context Management & Compaction**：从事实历史投影模型上下文，在协议安全边界压缩。
- **Progressive Tool Discovery**：通过 `tool_search` 按需发现工具，并在当前 Run 内激活。
- **Run Governance**：独立管理步数、调用数、时间、token、费用和失败预算。
- **Managed MCP Lifecycle**：管理 MCP 插件的连接、断开、重载和清理。
- **Semantic Progress Guard**：可选的确定性重复行为检测、提醒与停止。
- **Evaluation & Fault Recovery**：测量执行路径、资源使用、协议一致性与崩溃恢复语义。

## 架构

```text
User / CLI
  ↓
AgentRuntime
  ↓
AgentLoopRuntime
  ├── RunController         是否继续
  ├── ContextManager
  │     ├── Context Projection
  │     └── Compaction Planner
  ├── Tool Visibility       All / Deterministic / Progressive
  ├── ToolScheduler
  │     └── ToolRuntime     Bash / Files / MCP Tools
  └── LLM Runtime           Provider Adapter → Model
  ↕
SessionRuntime
  └── SessionStore          Memory / JSONL
```

**本仓库实现**：Agent Loop、Session、Run Controller、Tool Runtime / Scheduler、Context Projection / Compaction、Tool Visibility、Progress Guard、MCP 生命周期管理与 Eval 框架。**依赖提供**：`@deepseek-ai/cordis` 的 Context / Plugin / Service，`@deepseek-ai/dsh-mcp-client` 的 MCP 协议与远端交互，以及 Ajv 的 JSON Schema 校验引擎。

## 为什么需要 Harness

Coding Agent 的困难不止是生成下一段代码。长任务需要持续状态；Tool Call 需要可靠执行，并发结果需要保持协议完整；上下文增长后需要压缩，进程崩溃后需要恢复。工具多时还要控制 Schema 开销、检测无进展的重复行为、管理 MCP 生命周期，并用可重复的实验验证这些设计。

```text
Coding Agent = Model（推理与生成）+ Harness（执行、状态与约束）
```

mini-dsh 将这些工程问题拆成可读、可替换、可测试的组件。第一次阅读可以先看下面的核心设计和 Eval 表，再沿链接深入源码。

## 核心设计

### Durable Sessions

**Durable History ≠ Model Context。** Event Log 保存事实历史；模型消息只是它的投影：

```text
Durable Event Log → Context Projection → Compaction → Model Messages
```

`session/start`、`user/message`、`assistant/message`、`assistant/tool_calls`、`tool/result`、`context/compaction` 保存消息、调用、结果、工具调用轮的 reasoning 和压缩 lineage。Compaction 只追加记录、改变投影，不能改写或删除已有 Event Log。恢复依赖 Event Log，而不是已经压缩的 Prompt。

核心不变式：**每个已提交到 `assistant/tool_calls` 的 Tool Call 最终必须恰好对应一个 `tool/result`**。正常执行、预算停止、取消和恢复都围绕这一协议闭合目标设计；崩溃中途可以暂时未闭合，重新打开会话后补齐未知结果。

### Run Governance

AgentLoop 管 **how to execute**，RunController 管 **whether to continue**。每个 Run 独立管理 step、tool call、duration、input/output token、cost、tool failure、context overflow 和 cancel。

停止原因包括 `completed`、`cancelled`、`step_limit`、`tool_call_limit`、`time_limit`、`input_token_limit`、`output_token_limit`、`cost_limit`、`tool_failure_limit`、`context_overflow`、`no_progress`、`internal_error`。Token / cost 预算依赖可用的 usage / pricing，不能把未知费用视为零。

Progress Guard 根据规范化调用、结果类别、指纹和新颖度检测重复。默认 `off`；`remind` 提供临时提醒，`guarded` 还可触发 `no_progress`。名称中的 Semantic 不代表 LLM 语义裁判或完整目标状态推理。

### Context Management

ContextManager 不是 Session Store；它负责 **Durable History → Model Context**，包括 token estimation、pressure state、protocol-safe boundary 和 deterministic compaction。

输入 hard limit 是 context window 减去 reserved output tokens；soft limit 提前触发压缩。压缩后仍达 hard limit 则停止。压缩不能切断 Tool Call / Result 配对；当前压缩器生成有长度限制的确定性连续性摘要，不保证保留全部语义。

### Tool Runtime

Tool Definition 包含 JSON Schema（`parameters`）、`timeoutMs`、`readOnly`、`idempotent`、`concurrencySafe`、`sideEffect`。Runtime 负责参数校验、结果渲染，并尽量把错误规范化成 Tool Result：`unknown_tool`、`invalid_arguments`、`timeout`、`cancelled`、`execution_error`。

只有 `concurrencySafe=true` 的工具可以并行，其余工具作为 barrier。**执行完成顺序与 Event Log 提交顺序不同**：结果按原始 Tool Call 顺序提交。Timeout / cancel 是协作式的，需要工具响应 AbortSignal 并完成清理；不是强制抢占。

### Tool Discovery

| 模式 | 模型看到什么 |
| --- | --- |
| All（默认） | 全量已注册 Tool Schema |
| Deterministic | 按词法相关性选择 Top-K |
| Progressive | `tool_search` + 基础选择 + 当前 Run 激活的工具 |

Visibility 控制 Schema 暴露，**不是授权机制**。Progressive 只搜索已注册工具，不会惰性连接 MCP；搜索算法与回退规则见[架构文档](./ARCHITECTURE.zh-CN.md#9-tool-visibility)。

### MCP

```text
McpManager → dsh-mcp-client → MCP Server
                    ↓ 发现并同步工具
             ctx.tools.register() → ToolRuntime
```

mini-dsh 管 MCP Plugin lifecycle；MCP protocol、transport、remote reconnect、remote tool discovery 由官方 `@deepseek-ai/dsh-mcp-client` 提供。`ACTIVE` 只表示客户端插件 Fiber 已激活，**不代表远端 endpoint 健康**。

## Evaluation

以下数据来自基线 `588e764` 的已有 suites，均为 **deterministic synthetic Eval**，使用 Mock LLM 验证 Harness；不是生产模型 Benchmark、SWE-bench 或真实模型能力排名。Token 是 Harness 估算，独立于 provider usage / 实际费用。复现命令和报告口径见[架构文档](./ARCHITECTURE.zh-CN.md#13-evaluation)。

### Tool Routing

来源：[tool-routing suite](./evals/tool-routing/suite.js)，每种模式运行同一组案例。

| 模式 | 平均可见工具 / request | Schema tokens / request | 平均估算输入 / run |
| --- | ---: | ---: | ---: |
| All | 19 | 9,268 | 18,650.8 |
| Deterministic | 5 | 336 | 786.8 |
| Progressive | 1.93 | 199.6 | 1,016.2 |

三个模式均通过全部案例。Progressive 降低单次请求的 Schema 开销，但多了一步 Tool Search，因此本组实验的整个 Run 估算输入高于 Deterministic。这是发现能力与额外请求之间的取舍。

### Context Pressure

来源：[context-pressure suite](./evals/context-pressure/suite.js)。Constrained / Compacted 使用 1,900 token 窗口，预留 200 output tokens；Full-history 不设窗口限制。

| 模式 | 峰值估算输入 / request | 平均估算输入 / run | Compactions（整组总数） | 任务结果 |
| --- | ---: | ---: | ---: | --- |
| full-history | 5,697 | 20,884 | 0 | 全部完成 |
| constrained | 1,234 | 2,593 | 0 | 全部 `context_overflow` |
| compacted | 1,578 | 9,040 | 17 | 全部完成 |

Compacted 相比 Full-history，峰值降低约 **72%**，累计估算输入降低约 **57%**，任务仍完成。峰值只统计实际发出的模型请求；Constrained 被拒绝的超限请求不计入峰值，不能把提前停止当作优化成功。

### Long-Horizon Coding

来源：[long-horizon suite](./evals/long-horizon/suite.js)。Mock LLM 驱动一次性本地仓库中的真实文件操作和测试：

```text
search → read → test（失败）→ edit → retest（通过）→ finish
```

Scorer 不只看最终文件，还检查初始测试失败、最终测试通过、required reads、workspace diff、unexpected files 和 Tool protocol。

| 模式 | 平均可见工具 / request | 估算输入（整组总量，约） | 完成 |
| --- | ---: | ---: | ---: |
| baseline | 25 | 195,000 | 5/5 |
| managed | 9 | 99,000 | 5/5 |

工具暴露降低 **64%**，估算输入降低约 **49%**。这里使用本地报告的近似值；测试输出和临时路径等环境文本会影响 token 估算。Managed 同时启用 **Tool Routing、Progress Guard、Context Compaction**，不能把全部收益归因于其中某一个机制。

### Reliability

| Suite | 故障覆盖 | 验证重点 |
| --- | --- | --- |
| [Fault Injection](./evals/fault-injection/suite.js) | LLM failure、Tool error / timeout、invalid call、unknown tool、parallel cancellation、context overflow、scheduler failure | 停止原因、故障确实触发、调用与结果配对 |
| [Crash Recovery](./evals/crash-recovery/suite.js) | 真实进程 SIGKILL、JSONL reopen、torn tail、unknown outcome | 恢复后协议闭合、副作用证据、no blind retry |
| [MCP Failure](./evals/mcp-failure/suite.js) | activation cleanup、server isolation、disconnect/reload、stale schema、cleanup retry、remote-like Tool failure | 插件生命周期、注册工具清理、失败隔离 |

如果副作用已发生，Tool Result 尚未持久化时进程崩溃，Harness 无法确定执行结果：恢复记录 `outcome=unknown`、`retryable=false`。

**mini-dsh 明确选择“副作用结果不确定时，不盲目重试”，不声称实现分布式 exactly-once。** MCP Failure 使用本地 fake plugin，不代表远端 MCP chaos testing 或健康检测。

## 快速开始

环境要求见 [package.json](./package.json)：Node.js `>=20.18.1`，pnpm `11.22.0`。

```bash
pnpm install
cp .env.example .env
# 在 .env 填写 DEEPSEEK_API_KEY
pnpm start
```

[.env.example](./.env.example) 默认模型为 `deepseek/deepseek-v4-flash`；未设置 `MINI_DSH_MODEL` 时，入口回退到 `deepseek/deepseek-v4-pro`。CLI 默认将会话写入 `.data/sessions`，可通过 `MINI_DSH_SESSION_DIR` 更改。

Context7 是可选集成，配置见 [mcp.config.js](./mcp.config.js)。可填写 `CONTEXT7_API_KEY`；远端首次连接失败不会阻止 CLI 启动，后续远端重连由官方客户端管理。

可选策略配置（下列为默认值；其余预算配置见 `.env.example`）：

```dotenv
MINI_DSH_TOOL_ROUTING=all
MINI_DSH_MAX_VISIBLE_TOOLS=12
MINI_DSH_MAX_ACTIVATED_TOOLS=24
MINI_DSH_MAX_PARALLEL_TOOL_CALLS=4
MINI_DSH_PROGRESS_MODE=off
MINI_DSH_MAX_CONTEXT_TOKENS=null
```

## CLI

| 命令 / 操作 | 用途 |
| --- | --- |
| `/tools` | 查看已注册工具 |
| `/sessions`、`/resume <session-id>`、`/new` | 列出、恢复或创建会话 |
| `/history`、`/reset` | 查看事件历史；追加 reset 事件，重置上下文视图 |
| `/models`、`/model [provider/model]` | 查看或切换模型 |
| `/prompt` | 查看系统提示词 |
| `/mcp list`、`/mcp connect <name>`、`/mcp disconnect <name>`、`/mcp reload <name>` | MCP 生命周期管理 |
| `Esc`、`/exit` | 取消当前 Run；退出 CLI |

写文件和 Bash 执行前会请求 `[Y/n]` 确认。演示见 [CLI 截图](./images/demo.png)。

## 当前边界

- 聚焦本地 Harness 的工程设计，不是完整 DSH 产品或生产级替代品。
- JSONL 面向本地会话恢复，没有跨进程写入协调或分布式 exactly-once 保证。
- Sandbox 是应用层路径 / 命令策略和人工确认，不是 OS 隔离；也不为远端 MCP 工具提供隔离。
- Visibility 不是权限；词法路由没有跨语言语义理解。Compaction 有信息损失，Progress Guard 是启发式规则。
- 协作式取消不保证强制终止不配合的工具；`ACTIVE` 不代表远端 MCP 健康。
- Synthetic Eval 证明的是指定条件下的 Harness 行为，不推导真实模型任务成功率。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) | 当前系统分层、协议与恢复语义 |
| [DESIGN_DECISIONS.zh-CN.md](./docs/DESIGN_DECISIONS.zh-CN.md) | 关键选择的原因和取舍 |
| [LEARNING.md](./LEARNING.md) | 从零手写的学习路线 |
| [SOURCE_STUDY_ROADMAP.zh-CN.md](./SOURCE_STUDY_ROADMAP.zh-CN.md) | 按开发历史阅读源码与自测 |
| [DEVELOPMENT_ROADMAP.zh-CN.md](./DEVELOPMENT_ROADMAP.zh-CN.md) | 阶段演进规划与历史背景；当前能力以架构文档和源码为准 |

## 开发与验证

```bash
pnpm test
pnpm check
pnpm lint
pnpm eval:tool-routing
pnpm eval:progress
pnpm eval:context-pressure
pnpm eval:long-horizon
pnpm eval:fault-injection
pnpm eval:crash-recovery
pnpm eval:mcp-failure
```

Eval 报告写入 `.eval/*.json`；上述检查均已纳入 [CI](./.github/workflows/ci.yml)。
