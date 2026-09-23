# mini-dsh 架构

[English](./ARCHITECTURE.md) | 中文（主要展示版本）

本文描述当前实现。项目概览和结果表见 [README](./README.zh-CN.md)，设计原因见 [Design Decisions](./docs/DESIGN_DECISIONS.zh-CN.md)。

## 1. 系统边界

`Agent = Model + Harness`。模型负责生成内容和 Tool Calls；Harness 负责执行、记录事实、构建上下文、决定是否继续以及验证这些行为。

| 本仓库实现 | 依赖提供 |
| --- | --- |
| Agent / Loop、Session / Store、RunController | `@deepseek-ai/cordis`：Context、Plugin、Service、Fiber 生命周期 |
| Tool Runtime / Scheduler、Visibility / Search | Ajv：JSON Schema 编译与校验 |
| Context Projection / Compaction、Progress Guard、Trace / Eval | `@deepseek-ai/dsh-mcp-client`：MCP 协议、transport、远端发现、工具同步和重连 |
| McpManager、应用层 Sandbox、DeepSeek Provider Adapter | 模型服务：推理、生成和可用时的 usage |

mini-dsh 管理本地执行与插件实例，不实现远端 MCP 健康检测、跨进程 Session 锁或操作系统隔离。

## 2. Runtime 分层

[入口](./src/index.js) 将 `src/core` 中的独立 Runtime 通过 `src/plugins` 包装为 Cordis Service，再挂载 Provider、Bash / Files、MCP 和 CLI。

```text
CLI → AgentRuntime → AgentLoopRuntime
                       ├── RunController / RunDeadline
                       ├── SystemPromptRuntime
                       ├── ToolCatalog → ToolVisibility
                       ├── ContextManager → Planner / Compactor
                       ├── LlmRuntime → DeepSeek Adapter
                       ├── ToolScheduler → ToolRuntime
                       ├── SemanticProgressDetector
                       └── TraceRuntime
                       ↕
                 SessionRuntime → SessionStore
                                  ├── MemorySessionStore
                                  └── JsonlSessionStore
```

[AgentRuntime](./src/core/agent-runtime.js) 是 `sessionId + model + loop` 的薄封装，`send()` 委托 Loop。Loop 不需要识别 Bash、Files 或 Context7，只调用统一 Tool Runtime。System Prompt 和临时进展提醒在请求时组装，不替代 Session 事实。

## 3. Event Log

[SessionRuntime](./src/core/session-runtime.js) 负责事件语义，Store 只持久化记录。事件外壳为 `{ seq, type, data, at }`；序号在会话内连续递增，Run / Step 标识放在适用的事件数据中。

| 事件 | 事实内容 |
| --- | --- |
| `session/start` | 初始会话 metadata |
| `user/message` | 用户输入 |
| `assistant/message` | 无 Tool Calls 时的助手文本 |
| `assistant/tool_calls` | 调用列表、附带文本、Provider 返回的 `reasoningContent` |
| `tool/result` | `toolCallId`、工具名、渲染结果、错误信息，以及适用时的恢复 / 跳过标记 |
| `context/compaction` | 摘要、覆盖区间、压缩策略、前后 token 估算和 `previousCompactionSeq` |
| `session/reset` | 新上下文视图的起点；旧事件保留 |

Reasoning 的持久化范围是工具调用轮返回的 `reasoningContent`，不是所有内部推理或全部流式片段。

**协议不变式：每个已提交的 Tool Call 最终恰好对应一个 `tool/result`。** 取消或预算不足不能直接丢弃已记录的调用。未执行调用写入 `outcome=not_executed`；已开始但结果未知的调用写入 `outcome=unknown`。该不变式约束 Loop 生成及恢复后的有效历史，不是 Store 对任意外部输入的通用协议校验。

## 4. Agent Loop

[AgentLoopRuntime](./src/core/agent-loop-runtime.js) 的一次 Run：

1. 经 SessionRunCoordinator 入队，创建 RunController、deadline、Trace 和可选进展检测器，追加 `user/message`。
2. `beforeStep()` 判断能否继续；组装 System Prompt，读取新 ToolCatalog snapshot，选择可见 Schema。
3. ContextManager 准备消息；若压缩后仍到 hard limit，以 `context_overflow` 停止，不发送该请求。
4. 调用 LLM 并记录 usage。无 Tool Calls 时追加 `assistant/message`，根据预算决策或正常完成结束。
5. 有 Tool Calls 时先追加 `assistant/tool_calls`，再通过 Scheduler 执行；预算已耗尽也要为已提交调用补齐结果。
6. 按原始调用顺序追加 `tool/result`；观察进展、判断停止或进入下一步。
7. 清理 Run 激活状态和 deadline，结束 Trace，通知停止观察者。

同一 Session 的 Run 在当前 Loop 的 coordinator 内 FIFO 串行，不同 Session 可并发。取消、异常或 scheduler failure 的处理仍要尽量闭合 Tool 协议；观察者回调失败不应替换执行结果。不可恢复的 LLM / 内部异常可向调用者抛出，并记录停止原因。

## 5. Run Controller

[RunController](./src/core/run-controller.js) 管 **whether to continue**；Loop 管 **how to execute**。Controller 不执行工具，也不保存持久事实。每个 Run 有独立计数器，单项限制用 `null` 关闭。

| 输入 / 限制 | 停止原因 |
| --- | --- |
| 正常生成最终回答 | `completed` |
| 外部取消 / duration deadline | `cancelled` / `time_limit` |
| step / tool call 上限 | `step_limit` / `tool_call_limit` |
| 累计 input / output usage | `input_token_limit` / `output_token_limit` |
| 可用的累计 cost / tool failures | `cost_limit` / `tool_failure_limit` |
| 准备后 context 仍超限 / guarded 无进展 | `context_overflow` / `no_progress` |
| 内部或执行编排异常 | `internal_error` |

累计 token 预算读取 LLM usage，不使用 ContextManager 的请求估算代替。CostEstimator 使用 Provider cost 或配置 pricing 推算；未知 cost 保持 `null`，不能保证此时的费用上限。预算在执行边界检查，不是对单次 LLM 响应的精确截断。

[SemanticProgressDetector](./src/core/semantic-progress-detector.js) 是 Run 内的确定性启发式检测器：结合规范化调用、结果类别、指纹和新颖度。`off` 不创建检测器；`remind` 注入一次性的临时策略提醒；`guarded` 还可请求 `no_progress`。辅助检测失败时 fail-open；它不判断任意代码改动是否真的推进用户目标。

## 6. Context Manager

[ContextManager](./src/core/context-manager.js) 不是 Session Store。**Durable Event Log 是事实，Model Context 是可重建的投影。**

```text
Durable Event Log
  ↓ Context Projection（reset + 有效 compaction lineage）
  ↓ Compaction（需要时规划，并追加 context/compaction）
Model Messages + System Prompt + Visible Tool Schemas
  ↓
LLM Request
```

`project()` 是纯投影；`prepare()` 是追加压缩事件的显式持久化边界，随后重新投影。Compaction 不修改任何已有 Event Log 记录，恢复仍从原始事件及压缩 lineage 重建视图。

[TokenMeter](./src/core/token-meter.js) 对 system、messages、tools 的稳定序列化文本按 UTF-8 字节估算，标记 `exact=false`、`method=heuristic-v1`；它不是 Provider tokenizer 或账单来源。

- **Hard limit**：`maxContextTokens - reservedOutputTokens`；达到该值即进入 `hard_limit`。
- **Soft limit**：可用输入预算乘以 `compactAtRatio`，提前触发压缩。
- **Reserved output tokens**：为输出留出输入预算空间，不代表强制设置模型的最大输出参数。
- 未配置窗口时 pressure 为 `disabled`。CLI 启用窗口后，未指定输出预留时默认预留 4,096 tokens；小窗口必须显式配置更小预留。

[Planner](./src/core/context-compaction-planner.js) 只选择 Tool Call / Result 全部闭合的边界，并保留最近原始消息；尝试压到留有余量的目标，做不到时只接受能减少估算输入的候选。没有安全边界就不压缩。准备后仍超限由 Controller 停止。

[Compactor](./src/core/context-compactor.js) 生成有长度限制的确定性摘要，保留部分目标、旧摘要、助手文本和工具活动。它不是 LLM 摘要器，会丢失细节。[Projector](./src/core/context-projector.js) 校验覆盖区间、协议边界和 `previousCompactionSeq` 链；使用最新有效摘要加后续原始事件。摘要作为带历史说明的 assistant 消息注入，不把工具文本提升为 system 指令。

## 7. Tool Runtime

[ToolRuntime](./src/core/tool-runtime.js) 统一注册、Schema 输出、执行和结果渲染。注册时编译 Ajv validator，执行前校验参数，不做类型强制转换。

| Definition 字段 | 意义 / 默认 |
| --- | --- |
| `name`、`description`、`parameters` | 工具标识、描述和 JSON Schema |
| `execute(args, exec)`、可选 `output.render` | 执行入口和结果渲染 |
| `timeoutMs` | 工具超时；默认 `null` |
| `readOnly`、`idempotent`、`concurrencySafe` | 显式声明；默认均为 `false` |
| `sideEffect` | 副作用声明；默认 `true` |

Execution context 传递 `signal`、Session / Run / Step / Tool Call 标识和 agent。返回值归一为包含 `isError`、`errorCode`、内容与执行 metadata 的结果；未知工具、参数错误、超时、取消、执行或渲染异常分别映射为 `unknown_tool`、`invalid_arguments`、`timeout`、`cancelled`、`execution_error`。定义注册错误仍抛异常。

Timeout 和 cancel 通过 AbortSignal 协作执行，等待工具清理并 settle 后返回。忽略 signal 的工具可能持续运行；metadata 声明本身也不是安全证明，`idempotent` 不会触发自动重试。

## 8. Parallel Scheduler

[ToolScheduler](./src/core/tool-scheduler.js) 将同一批调用按原序划分为连续并行组和独占 barrier。只有 `concurrencySafe === true` 能进入并行组；未声明工具及未知工具均走独占路径。并行组受 `maxParallelToolCalls` 限制，barrier 等前组完成后单独执行，再开放后组。

```text
Calls:     safe A, safe B | write C | safe D, safe E
Execution: A 与 B 并行   → C 单独  → D 与 E 并行
Commit:    result A, result B, result C, result D, result E
```

**执行完成顺序 ≠ Event Log 提交顺序。** Scheduler 返回带原始 index 的结果，由 Loop 按调用原序提交。停止接纳新调用后，未开始项补 `not_executed`；scheduler 异常时保存已 settle 的结果、对已开始但未获结果项补 `unknown`，然后报告异常。并行和取消不能省略已提交调用的终结记录。

## 9. Tool Visibility

[ToolCatalog](./src/core/tool-catalog.js) 每个 Step 为当前注册工具创建 metadata snapshot，Visibility 只选本次请求的 Schema。

| 模式 | 选择逻辑 |
| --- | --- |
| All | 返回全部已注册工具 |
| Deterministic | 小 Catalog 全量；大 Catalog 做词法 Top-K，合并 pinned 工具；无匹配回退全量 |
| Progressive | 基础词法选择在无匹配时只保留 pinned 工具，再合并 `tool_search` 和当前 Run 的激活集 |

[词法排序](./src/core/tool-ranking.js) 使用小写 ASCII 字母 / 数字词元，匹配工具名、描述和参数属性名；按得分排序，同分保持 Catalog 顺序。它不理解跨语言语义、同义词或 embedding 相似度。Top-K 不是最终 Schema 数的绝对上限：pinned、搜索工具、激活集及兼容性回退会扩展结果。

[`tool_search`](./src/tools/tool-search.js) 搜索当前完整已注册 Catalog，返回精简名称 / 描述并激活命中项；激活上限之外的命中会标为未激活。下一 Step 读取新 snapshot，已移除工具不会继续暴露。激活按 Run 隔离，开始和结束时清理；不进行 MCP 惰性连接。

**Tool Visibility ≠ Authorization。** 隐藏工具仍可能通过 Tool Runtime 按名称执行；访问控制必须由工具与相应 policy 实现。`/tools` 显示注册集合而不是当前可见集合。

## 10. Session Persistence

[SessionStore](./src/core/session-store.js) 抽象创建、打开、追加、列出、flush、关闭与释放；Memory 用于内存执行，JSONL 用于持久会话。CLI 默认使用 `.data/sessions/<id>/session.jsonl`。

SessionRuntime 按会话串行 append，**Store 写入成功后**才更新内存事件数组。[JSONL Store](./src/core/jsonl-session-store.js) 校验 Session ID、事件序号，并串行写入。Append 是文件追加；`flush()` 才调用文件 sync，close / dispose 会 flush。它不是每个事件都 fsync，也没有跨进程 writer lock，不能从进程崩溃实验推导断电保证。

`/resume` 重新打开事件流并补齐中断调用；`/reset` 追加事件，改变投影起点，不删除历史。SessionRunCoordinator 的 Run 排队与 Store 的写入队列职责不同，均不构成分布式协调。

## 11. Crash Recovery

[JSONL recovery](./src/core/session-recovery.js) 按字节读取并检查连续序号。仅末尾 JSON 解析失败且之前有有效事件时可截去受损尾行；中间损坏、无效事件结构或序号缺口报错，不默默跳过。

关键故障窗口：

```text
assistant/tool_calls 已持久化
  ↓
外部副作用已发生
  ↓
tool/result 尚未持久化
  ↓ process crash
重新打开 JSONL → 无法知道实际结果
  ↓
追加 tool/result: outcome=unknown, recovered=true, retryable=false
```

恢复扫描没有匹配结果的调用并补记录；不重新执行工具。再次打开不会重复补已有结果。它也不会推断“没有结果就一定没执行”。

**mini-dsh 明确选择副作用不确定时不盲目重试，不声称分布式 exactly-once。** 结果记录恰好配对与外部副作用恰好执行一次是两种不同保证。

## 12. MCP Lifecycle

```text
McpManager（本仓库：插件实例生命周期）
  ↓
@deepseek-ai/dsh-mcp-client（官方：协议 / transport / 重连）
  ↕
MCP Server
  ↓ 经客户端发现与同步
ctx.tools.register() → ToolRuntime → AgentLoop
```

[McpManager](./src/core/mcp-manager.js) 对每个 server 串行 connect / disconnect / reload，不同 server 独立；reload 先清理再激活。[插件桥接层](./src/plugins/mcp.js) 在激活失败时尝试 dispose 部分创建的 Fiber。Disconnect 清理失败保留 Fiber 供重试，manager dispose 使用 all-settled 尝试各 server 清理，失败后允许再次调用。

状态为 `DISCONNECTED`、`CONNECTING`、`ACTIVE`、`FAILED`，表达的是本地 Plugin lifecycle。**`ACTIVE ≠ remote endpoint healthy`**。远端初次连接失败不一定让官方客户端 Fiber 激活失败；协议连接、远端发现、工具同步与 remote reconnect 都交给官方客户端。

已发送的 Schema 可能在执行前失效：工具注销后调用得到 `unknown_tool`，下一 Step 使用新 Catalog。MCP Failure 的 fake plugin 验证这些本地契约，不验证真实网络可用性。

## 13. Evaluation

```text
EvalCase → EvalSuite → Fixture → Agent Harness
                                   ↓
                                 Scorer
                                   ↓
                              EvalResult → Reporter
```

[EvalCase / EvalSuite](./src/eval/eval-suite.js) 定义 prompt、expected、可选 limits / metadata / scorer、variant 和 fixture factory。[Runner](./src/eval/eval-runner.js) 驱动每个案例；Fixture 至少提供 agent、trace、recordingTokenMeter，可附带 inspectors 和 dispose。Scorer 接收具名参数并返回 success 和有界 details。Fixture / scorer / cleanup 出错会留下失败结果，不能当作成功。

[Reporter](./src/eval/eval-reporter.js) 输出表格与 `schemaVersion: 1` JSON，包含逐案例结果和按 variant 聚合。Provider input / output / reasoning usage 与 cost 的 availability 单独记录；缺失时为 `null`。Harness 的 `estimatedInputTokens` 和 `toolSchemaTokens` 不冒充实际计费。

体系按测量问题扩展，共用上述契约：

| 层次 | Suite / 命令 | 验证问题 |
| --- | --- | --- |
| 策略 | `pnpm eval:tool-routing`、`pnpm eval:progress` | Schema 暴露、发现成本、重复提醒与停止、避免误停 |
| Context | `pnpm eval:context-pressure` | 安全压缩、目标 / 最近上下文保留、overflow、历史不变 |
| Workflow | `pnpm eval:long-horizon` | search → read → test → edit → retest → finish 的真实文件 / 测试路径 |
| Fault | `pnpm eval:fault-injection` | 故障触发证据、停止原因、工具协议闭合 |
| Crash | `pnpm eval:crash-recovery` | child process SIGKILL、JSONL 重开、尾行修复、副作用未知且不重试 |
| Lifecycle | `pnpm eval:mcp-failure` | fake MCP plugin 的激活、隔离、注销、重载、清理重试 |

这些是 deterministic synthetic Eval。Workflow 操作真实临时仓库，但决策来自 Mock LLM；Crash 使用真实子进程，但不模拟断电；MCP 使用本地 fake plugin，不是远端 chaos testing。核心测量包括 **execution path、resource usage、protocol consistency、recovery semantics**，不仅是最终回答。

Scorer 也需要防假阳性：Workflow 检查初始失败 / 最终通过、required reads、必需修改、禁止文件和 workspace 边界；Crash 检查实际终止、持久记录与副作用证据；MCP 检查真实事件、工具注册和生命周期证据，不能仅看到预期 stop reason 就给分。对应回归在 [test](./test) 中。

README 数字来自基线 `588e764` 的本地报告（2026-09-23 复跑核对），报告输出 `.eval/<suite>.json`，不提交生成文件。具体口径：

- Tool Routing：`variants.*.avgVisibleTools`、`avgToolSchemaTokensPerRequest`、`avgEstimatedInputTokens`。
- Context：峰值取全部实际请求 `estimatedInputTokensByStep` 的最大值；平均输入取 `avgEstimatedInputTokens`；compactions 为各 case 的 `scoreDetails.compactionCount` 之和。Constrained 的 scorer 成功意味着按预期 overflow，不意味着任务完成。
- Long-Horizon：`avgVisibleTools` 和 `totalEstimatedInputTokens`；本地原始值 baseline **194,553**、managed **98,657**，README 四舍五入为约 195,000 / 99,000。测试输出和临时路径等环境文本会影响估算，不能把快照当成所有平台的固定值。
- 百分比为 `1 - managed / baseline`（Context 用 compacted / full-history）。Long-Horizon 同时改变 routing、progress 和 compaction，不是单因素消融实验。

## 14. Sandbox

[SandboxRuntime](./src/core/sandbox-runtime.js) 是应用层 policy gate。内置文件工具通过 [resolveInside](./src/utils/path.js) 做词法和 realpath 包含性检查，限制 workspace 外路径与静态 symlink 逃逸；Bash 有命令 denylist；写文件和 Bash 执行通过 CLI 人工批准。

这些检查不是 OS 隔离、通用 Shell 安全解析或抗恶意代码边界。二级解释器、检查后文件系统变化及插件自行访问资源不由这些检查完整约束；MCP 远端执行也不因此受隔离。Eval Fixture 的受控执行环境不能当成生产 Sandbox 的隔离能力。

## 15. 当前边界

当前已实现 compaction、run budgets、parallel scheduler、durable sessions、MCP lifecycle 和离线 Eval，不再是只包含 model → tool 的早期学习骨架。

仍然明确保留的限制：本地单进程协调；协作式取消；有损确定性摘要；ASCII 词法路由；启发式进展检测；依赖可用 usage / pricing 的预算；应用层 Sandbox；MCP 生命周期与远端健康分离；结果未知时不盲目重试。未提供完整 DSH 产品、分布式事务保证或真实模型性能结论。
