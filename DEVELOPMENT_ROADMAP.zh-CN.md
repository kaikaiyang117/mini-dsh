# mini-dsh 后续开发路线：从最小 Harness 到可评测 Coding Agent Harness

> 本文档用于指导 `kaikaiyang117/mini-dsh` 后续开发。目标不是复刻完整 DeepSeek Harness，而是以当前最小 Harness 为基线，参考官方 DSH 已验证的核心抽象，自主实现一套可恢复、可控、可扩展、可评测的轻量级 Coding Agent Harness。

---

## 0. 最终目标

项目顶层定位统一使用 **Agent Harness**；`Runtime` 用来描述 Harness 内部具体执行层。

最终定位：

> **A lightweight Coding Agent Harness for reliable long-horizon execution, progressive tool discovery and reproducible evaluation.**
>
> 面向长任务执行、工具规模化与可重复评测的轻量级 Coding Agent Harness。

项目最终分成三层：

```text
第一层：当前 mini-dsh 最小 Harness
────────────────────────────
Cordis Context / Plugin / Service
Session Event Log
System Prompt
Tool Registry
LLM Provider Adapter
Agent Loop
DeepSeek Streaming
Bash / File Tools
MCP Plugin Integration

第二层：参考成熟 Harness 自主实现的工程能力
────────────────────────────
Session Persistence / Resume
Run Controller / Budget
Tool Validation / Timeout / Cancellation
Parallel Tool Calls
Context Compaction
Managed MCP Lifecycle
Trace / Metrics

第三层：项目自己的重点增强
────────────────────────────
Progressive Tool Disclosure
Lazy MCP / Tool Search
Semantic Progress Detection
Agent Evaluation
Fault Injection
```

开发原则：

1. 官方 DeepSeek Harness 是**能力地图与设计参考**，不是源码复制目标；
2. 每个核心模块自己设计接口、实现代码、补测试；
3. 每个“优化”必须有 Baseline 与可量化结果；
4. Session Event Log 始终保持权威事实源；
5. 不为了“功能多”引入与主线无关的大型模块。

---

# 1. 当前项目现状

## 1.1 已有能力

当前 mini-dsh 已经完成一个 Agent Harness 的最小闭环：

```text
User
  ↓
Agent.send()
  ↓
AgentLoopRuntime
  ├── append session event
  ├── derive messages
  ├── compose system prompt
  ├── invoke LLM
  └── execute tool calls
          ↓
      append tool results
          ↓
        next step
```

当前已有：

- Cordis `Context / Plugin / Service`；
- Session Event Log 与 `deriveMessages()`；
- Tool Registry：`register / schemas / execute`；
- System Prompt Runtime；
- LLM Provider Runtime；
- Agent / Agent Loop Runtime；
- DeepSeek Streaming Chat Completion；
- Reasoning / Content / Tool Call 流式解析；
- Bash / File Tools；
- Workspace 路径限制和应用层命令策略；
- CLI `[Y/n]` 人工批准；
- Esc 取消当前 Run；
- 外部 Cordis Plugin 加载；
- 使用官方 `@deepseek-ai/dsh-mcp-client` 接入 Context7；
- Tool Call / Tool Result 取消一致性修复；
- Symbolic Link Workspace Escape 防护；
- 单元测试和真实 Cordis Context 集成测试。

这个最小闭环必须保留。后续能力尽量以新的 Store / Policy / Runtime / Plugin 形式扩展，不把 `AgentLoopRuntime` 堆成上帝类。

## 1.2 当前缺口

当前项目仍然属于学习型 Harness，主要缺失：

```text
Session 只存在内存
重启后无法恢复 Session
缺少持久 Session Event Log
缺少 Run 级资源预算
缺少结构化 Stop Reason
缺少 Context Compaction
Tool 参数 / 输出治理较弱
多 Tool Call 主要顺序执行
缺少 Tool Timeout 策略
MCP 生命周期主要由外部插件直接负责
工具增多后 Schema 会持续占用模型上下文
缺少结构化 Trace / Metrics
缺少系统化 Eval / Fault Injection
```

---

# 2. 与官方 DeepSeek Harness 的关系

官方 DSH 已经将 Harness 拆成非常完整的能力系列，包括 core、session、compaction、guard、sandbox、skill、subagent、jobs、workflow、mcp、interaction、test-support 等。

本项目不追求功能数量与官方对齐，而是选择最有学习价值、最适合 Coding Agent Harness 主线的能力重新实现。

## 2.1 Session：参考官方的“权威日志 + 持久化后端”思路

官方 DSH 的 Session 核心仍然是**仅追加会话事件日志**；持久化由独立 `sessionPersistence` seam 提供。

官方第一方持久化后端不是 SQLite，而是：

```text
Per-session append-only JSONL
        +
optional/default Zstandard encoding
```

官方存储层负责持久日志、flush、格式 generation、尾部崩溃恢复等；Agent 层负责对中断轮次进行语义恢复。

因此 mini-dsh 后续也采用：

```text
Session Event Log = Source of Truth

SessionRuntime
    ↓
SessionStore
    ├── MemorySessionStore
    └── JsonlSessionStore
```

第一版不做官方完整的 generation / Zstd / format migration 系统，但保持相同的核心边界：

> 持久化后端保存事件日志；Message、统计信息、上下文等全部从日志派生。

SQLite 不再作为 Session 的主持久化存储。后续如有需要，可把 SQLite 用在：

```text
Trace / Metrics
Eval Result
Session Search Index
FTS Query
Derived Projection
```

即：**JSONL 保存权威历史，SQLite 保存可重建的查询/分析数据。**

## 2.2 Tool：参考官方“Registry + Guarded Execution Pipeline”

官方 DSH 的 Tool 不只是 `name + execute`，还区分：

- model-facing schema；
- canonical output；
- timeout metadata；
- concurrency safety；
- pre / execute / post execution pipeline；
- cancellation signal；
- tool restrictions / policy。

mini-dsh 不需要完全复制这套复杂度，但 Tool Runtime V2 应至少覆盖：

```text
Schema Validation
Execution Metadata
Timeout / Cancellation
Normalized Result
Concurrency Safety
Trace Hook
```

## 2.3 Agent Loop：参考官方“Turn / Step + bounded parallel safe calls”

官方 `dsh-agent-loop` 负责创建/恢复 Agent，并以“模型请求 → 工具执行 → 继续步骤”驱动 Turn / Step 生命周期；并行安全 Tool 可以在一个 Step 内有界并行，独占 Tool 作为顺序屏障。

mini-dsh 保留自己的最小 Agent Loop，但补充：

```text
Run Controller
Step identity
Parallel-safe tool scheduler
Structured stop reason
```

## 2.4 Context Compaction：参考“压缩旧历史、保留近期对话”

官方 DSH 的 compaction 会在上下文压力增大时把较早历史压缩为摘要，同时保留近期会话；另有 Tool Result Pruner 等辅助机制。

mini-dsh 第一版只实现最核心策略：

```text
Durable Event Log
      ↓
Context Projection
      ├── Compacted Summary
      └── Recent Raw Conversation
      ↓
LLM Request
```

原始 Event 不删除，Compaction 只改变模型可见投影。

## 2.5 MCP：参考官方生命周期，但不重写 MCP 协议

官方 DSH MCP Client 已经覆盖 stdio / Streamable HTTP、server-qualified namespace、tool discovery、timeout、reconnect 与生命周期释放。

mini-dsh 已使用官方 MCP Client，并完成 Harness 层 `McpManager` 的 plugin-instance lifecycle；不重写 MCP 协议栈。当前 Manager 管理 registry 与生命周期，不自行观测远端 transport health，也不实现 search-triggered lazy activation。后续增强可以包括：

```text
registry
state
health
reconnect policy
lazy activation
tool catalog integration
```

这样个人工作重点放在 Harness 治理，而不是重复实现协议细节。

## 2.6 官方已有但本项目不优先复刻

暂不作为主线：

```text
Browser Use
Computer Use
SSH
LSP
ACP / Remote BFF
完整 Sandbox 平台后端
复杂 Workflow Engine
Webhook
完整 Settings / Credential Center
Web GUI
```

---

# 3. 核心设计原则

## 3.1 Event Log 是唯一事实源

保持：

```text
SessionEvent[]
   ↓
derive / project
   ├── LLM Messages
   ├── Context View
   ├── Session Stats
   ├── Trace Correlation
   └── Query Index
```

不要再维护一套“最终 messages 表”作为第二事实源。

## 3.2 Durable History 与 Model Context 分离

```text
Durable Session History
        !=
Model-visible Context
```

完整历史用于：

- Resume；
- Replay；
- Debug；
- Eval；
- Audit。

模型上下文用于：

- 当前推理；
- Token 控制；
- Compaction。

## 3.3 权威数据与派生数据分离

```text
JSONL Session Log    -> authoritative
Trace JSON / SQLite  -> derived
Search Index         -> derived
Eval Metrics         -> derived
```

派生数据损坏后应该可以从 Event Log 重建。

## 3.4 Tool Side Effect 与 Concurrency 显式建模

至少增加：

```text
readOnly
idempotent
concurrencySafe
sideEffect
```

默认值采用 fail-closed：未明确声明 `concurrencySafe === true` 的 Tool 不并行。

## 3.5 Cancellation 是协议语义，不只是 UI

必须继续维持当前已经建立的不变式：

> 一旦 Assistant Event 中记录了 Tool Calls，每个 Tool Call 最终都必须有可以关联的 Tool Result / Cancelled Result。

并行 Tool、Timeout、Crash Recovery 都不能破坏这个约束。

## 3.6 当前 Sandbox 只描述为应用层 Policy Gate

除非后续真正接入 bubblewrap / Landlock / Seatbelt / Container 等隔离，否则 README 和简历不要使用“安全沙箱”“强隔离执行”等表述。

---

# 4. 目标架构

```text
                               User
                                │
                                ▼
                         Agent / Harness API
                                │
                                ▼
                         AgentLoopRuntime
                                │
             ┌──────────────────┼───────────────────┐
             ▼                  ▼                   ▼
       RunController      ContextManager       SessionRuntime
             │                  │                   │
      step / token /       token pressure       Event Log
      cost / duration      compaction                │
             │                  │                    ▼
             │                  │                SessionStore
             │                  │              ┌──────┴──────┐
             │                  │              ▼             ▼
             │                  │          MemoryStore   JsonlStore
             │                  │
             └───────────┬──────┘
                         ▼
                     ToolRouter
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
           ToolRuntime          McpManager
               │                   │
       schema / timeout        lifecycle
       cancel / scheduler      discovery
       normalized result       lazy activation
               │                   │
               └─────────┬─────────┘
                         ▼
                    TraceRuntime
                         │
                         ▼
                      EvalRunner
```

---

# 5. 推荐目录

随着阶段推进逐步增加，不要求一次创建完。

```text
src/
├── core/
│   ├── agent-loop-runtime.js
│   ├── agent-runtime.js
│   ├── context-runtime.js
│   ├── llm-runtime.js
│   ├── run-controller-runtime.js
│   ├── session-runtime.js
│   ├── tool-runtime.js
│   └── trace-runtime.js
│
├── session/
│   ├── session-store.js
│   ├── memory-session-store.js
│   ├── jsonl-session-store.js
│   └── recovery.js
│
├── context/
│   ├── token-meter.js
│   ├── context-projector.js
│   └── compactor.js
│
├── tools/
│   ├── bash.js
│   ├── files.js
│   ├── tool-schema.js
│   └── tool-router.js
│
├── mcp/
│   └── mcp-manager.js
│
├── eval/
│   ├── eval-runner.js
│   ├── scorer.js
│   ├── metrics.js
│   └── fault-injector.js
│
└── plugins/
    ├── sessions.js
    ├── run-controller.js
    ├── context.js
    ├── trace.js
    └── ...

evals/
├── filesystem/
├── long-horizon/
├── tool-routing/
├── tool-failure/
├── mcp-failure/
└── context-pressure/

docs/design/
├── session-persistence.md
├── run-controller.md
├── tool-runtime-v2.md
├── compaction.md
├── progressive-tools.md
└── evaluation.md
```

---

# 6. Phase 0：固定 Baseline 与个人贡献边界

目标：所有后续优化都有可比较的起点。

要做：

- 保证 `pnpm test`、`pnpm check` 全部通过；
- 固定普通问答、单 Tool、多 Tool、取消、Tool Error、MCP 不可达等行为；
- 新增 `UPSTREAM.md`；
- 记录原始 mini-dsh snapshot / commit；
- 后续个人代码使用独立 commit 逐步演进。

Definition of Done：

- 上游代码与个人贡献边界清晰；
- Baseline Integration Tests 稳定；
- 后续任何 benchmark 都可以回到基线。

---

# 7. Phase 1：Trace / Metrics

目标：先让 Harness 的执行过程可观测，再开始优化。

建议身份层级：

```text
sessionId
  └── runId
       └── stepId
            └── toolCallId
```

第一版 Trace：

```js
RunTrace {
  runId,
  sessionId,
  startedAt,
  endedAt,
  stopReason,
  usage,
  steps,
  toolCalls
}
```

记录至少包括：

- provider / model；
- input / output / reasoning token（provider 可提供时）；
- LLM latency / TTFT（可得时）；
- Tool latency；
- Tool success / error / timeout / cancelled；
- Step 数；
- Stop Reason。

第一版输出到 `.trace/<run-id>.json` 即可。

要求 Trace 写失败不影响正常 Agent Run。

---

# 8. Phase 2：Session Persistence + Resume

这是最重要的生产能力之一。

## 8.1 当前问题

```text
SessionRuntime -> in-memory Map

process exit
    ↓
all sessions lost
```

## 8.2 目标

```text
SessionRuntime
    ↓
SessionStore
    ├── MemorySessionStore
    └── JsonlSessionStore
```

建议接口：

```js
class SessionStore {
  create(header)
  open(sessionId)
  append(sessionId, events)
  flush(sessionId)
  list()
  close(sessionId)
}
```

`SessionRuntime` 负责 Session / Event 语义；`SessionStore` 只负责持久日志。

## 8.3 JSONL Layout

第一版可以简单：

```text
.data/sessions/
  <session-id>/
    session.jsonl
```

每行一个持久事件：

```json
{"seq":1,"type":"user/message","data":{...},"createdAt":"..."}
{"seq":2,"type":"assistant/message","data":{...},"createdAt":"..."}
```

第一版关键不是压缩，而是：

- append-only；
- seq 单调；
- restart 后可完整读取；
- 写入失败不破坏已提交前缀；
- 尾部半行可检测并恢复/截断；
- `flush()` 形成明确持久化屏障。

后续可选：

```text
zstd compression
format version
immutable generation
migration
checksum
```

这些属于参考官方 DSH 后继续加深的方向，不阻塞第一版。

## 8.4 Resume

CLI：

```text
/sessions
/resume <session-id>
/new
```

流程：

```text
JsonlSessionStore
      ↓ read committed events
SessionRuntime
      ↓
deriveMessages()
      ↓
Agent continues
```

## 8.5 Crash Recovery

把“物理日志恢复”和“Agent 语义恢复”分开：

```text
Storage Recovery
  - truncated final line
  - invalid tail
  - committed prefix

Agent Recovery
  - interrupted turn
  - unmatched tool call
  - side-effect uncertainty
```

第一版规则：

```text
readOnly && idempotent
    -> 允许明确策略决定是否 retry

side-effect / unknown
    -> 不自动 retry
    -> 记录 interrupted / unknown outcome
```

Definition of Done：

- create -> restart -> resume；
- conversation -> restart -> continue；
- multi-session isolation；
- malformed/torn tail 恢复；
- 中断 Tool Call 不产生盲目副作用重试；
- Event Log 与 Tool Call / Tool Result 协议仍然一致。

---

# 9. Phase 3：Run Controller / Execution Budget

当前 `while (true)` 只依赖模型停止 Tool Calling。

增加：

```js
RunPolicy {
  maxSteps,
  maxToolCalls,
  maxDurationMs,
  maxInputTokens,
  maxOutputTokens,
  maxCost
}
```

统一 Stop Reason：

```text
completed
cancelled
step_limit
tool_call_limit
time_limit
token_budget
cost_budget
no_progress
tool_failure_limit
context_overflow
internal_error
```

职责边界：

```text
RunController -> 能否继续执行
AgentLoop     -> 下一步怎么执行
```

AgentLoop 结构变为：

```text
begin run
  ↓
before step
  ↓
model request
  ↓
tool dispatch
  ↓
after step
  ↓
policy check
```

Definition of Done：分别构造无限调用、超时、Token 超限等测试，并验证 Trace 中 Stop Reason 与真实停止原因一致。

---

# 10. Phase 4：Tool Runtime V2

目标：从简单 Registry 发展为最小但完整的 Tool Execution Pipeline。

建议 ToolDefinition：

```js
{
  name,
  description,
  parameters,
  execute,
  timeoutMs,
  readOnly,
  idempotent,
  concurrencySafe,
  sideEffect
}
```

执行路径：

```text
model tool call
    ↓
parse / validate args
    ↓
policy / metadata
    ↓
timeout + cancellation signal
    ↓
execute
    ↓
normalize result
    ↓
append tool/result
    ↓
trace
```

建议 JSON Schema + AJV 做参数验证。

Normalized Result：

```js
{
  value,
  content,
  isError,
  errorCode,
  metadata
}
```

必须覆盖：

```text
invalid args
unknown tool
throw error
timeout
cancel
normal success
large result
```

注意：JS 同进程 Timeout 本质上通常是 cooperative cancellation，不宣称可以强杀任意同步代码。

---

# 11. Phase 5：Parallel Tool Calls

参考官方 DSH 的原则：只有明确标记为并发安全的调用才允许重叠执行，独占调用保持顺序。

第一版规则：

```text
concurrencySafe === true -> bounded parallel pool
otherwise                -> exclusive barrier
```

增加：

```text
maxParallelToolCalls
```

关键不变式：

- 模型 Tool Call 顺序可以不同于执行完成顺序；
- 结果必须通过 `tool_call_id` 正确关联；
- Cancellation 后每个已记录 Tool Call 都必须有 Result / Cancelled Result；
- Exclusive Tool 不能与其前后的并行组越过屏障执行。

Benchmark：用多个独立 read / grep 调用比较 serial vs bounded parallel latency。

---

# 12. Phase 6：Context Manager + Compaction

目标：把持久 Session History 与模型请求 Context 正式分离。

```text
Full Durable Event Log
       ↓
ContextManager
       ├── Token Meter
       ├── Compaction Policy
       ├── Older History Summary
       └── Recent Raw Conversation
       ↓
LLM Request
```

Trigger 采用 Token Pressure，而不是固定轮数。

推荐在 Session Event Log 中追加 Compaction 事实，例如：

```text
context/compaction
```

记录：

```text
shadowed range
summary
strategy/model
createdAt
```

原始历史仍保留。

必须避免把一个 Tool Call / Result 协议单元从中间切断。

Benchmark：50~100 Step 长任务，比较：

- context tokens；
- total input tokens；
- compaction count；
- task success；
- latency。

---

# 13. Phase 7：Managed MCP Lifecycle ✅

已完成 `McpManager` 的 server registry 和 plugin-instance lifecycle，支持 `DISCONNECTED`、`CONNECTING`、`ACTIVE`、`FAILED` 状态，以及 `/mcp list|connect|disconnect|reload`。生命周期清理失败会保留 fiber 句柄并允许重试；server 间 lifecycle 操作可并发，同一 server 的操作有序执行。

MCP 协议、transport、discovery、Tool 同步和 reconnect 仍由官方 `@deepseek-ai/dsh-mcp-client` 负责。`ACTIVE` 仅表示客户端 Plugin Fiber 激活成功，不代表远端 transport 健康；本项目不做 MCP transport health observation。搜索已注册 MCP Tools 可用，但通过 Tool Search 惰性连接未连接 Server 尚未实现，属于后续 enhancement。

---

# 14. Phase 8：Progressive Tool Disclosure【个人重点】

Phase 8.1 Tool Catalog & Visibility Contract ✅：AgentLoop 每个 Step 从当前 ToolRuntime 创建 `ToolCatalog` 快照，由 Visibility 选择 Model-visible schemas；默认 `AllToolsVisibility` 暴露全部已注册 Tool。该边界不承担授权。

Phase 8.2 Deterministic Tool Routing ✅：opt-in `DeterministicToolVisibility` 基于名称、描述和 Schema property 名中的 ASCII lexical overlap 排序；默认仍为全量可见，无可靠命中时回退全部 Tool。它不提供跨语言语义、同义词或 intent tracking。

Phase 8.3 Progressive Tool Search ✅：`ProgressiveToolVisibility` 将 no-match 时只返回 pinned Tool 的确定性基础集合、固定可见的 `tool_search` 与 Run-scoped activation 合并；搜索完整的当前注册 Tool Catalog，命中只会在下一 Step 暴露，Run 结束清理激活，并受 `MINI_DSH_MAX_ACTIVATED_TOOLS` 限制。单独使用 Deterministic 模式仍保留 no-match 回退全部 Tool 的兼容行为，小 Catalog 仍全部可见。搜索仍是 ASCII lexical matching；当前阶段不连接未启动 MCP Server。后续 Eval、Semantic Progress Detection、Fault Injection，以及作为 enhancement 的 Lazy MCP 均未实现。

问题：随着 MCP Server / Tool 数量增长，如果所有 Tool Schema 每轮都发送给模型，会增加上下文开销并引入无关候选。

目标：

```text
Tool Catalog
    ↓
Tool Router
    ↓
Top-K Candidate Tools
    ↓
Visible Tool Schemas
    ↓
LLM
```

Tool Catalog：

```js
{
  name,
  description,
  source,
  tags,
  schemaSummary,
  fullDefinition
}
```

V1 先使用 lexical / BM25 类检索，不急于引入 embedding。

进一步增加：

```text
tool_search(query)
```

让模型初始只看到 Core Tools；需要额外能力时再搜索并激活。

Tool Activation 当前按 Run 维护，并在 Run 结束后清理：

```text
base tools + activated tools
```

未来可与已完成的 MCP Manager 联动实现 Lazy MCP：先保留 server metadata，需要时才连接、discover、activate。

核心实验：

```text
All Schemas
vs
Top-K Routing
vs
Tool Search
```

比较：

- tool schema tokens；
- total input tokens；
- tool selection accuracy；
- task success；
- latency。

---

# 15. Phase 9：Semantic Progress Detection【个人重点】

官方已有 repeat-tool-reminder，主要针对连续完全相同的 Tool Call。

本项目继续研究更高层“是否真的取得进展”。

Progress Signal 可以组合：

```text
tool name / normalized args
result class / result hash
workspace diff
new information
failed outcome class
goal state delta
```

例如：

```text
grep("Agent") -> no match
grep("agent") -> no match
grep("AgentRuntime") -> no match
```

参数不同，但语义上可能仍然没有进展。

策略：

```text
soft threshold -> inject strategy reminder
hard threshold -> stopReason = no_progress
```

必须通过 Eval 证明误判率和收益，不能只凭规则主观判断。

---

# 16. Phase 10：Agent Evaluation【个人重点】

建立统一 Eval Case：

```yaml
name: locate-config
prompt: Find where database connection is configured.
limits:
  steps: 20
  inputTokens: 20000
expected:
  files:
    - src/config/database.ts
```

Eval Runner 统一收集：

```text
success
steps
tool_calls
input_tokens
output_tokens
tool_schema_tokens
latency
cost
repeated_calls
stop_reason
```

至少建立：

```text
filesystem/
long-horizon/
tool-routing/
context-pressure/
tool-failure/
mcp-failure/
```

所有“优化”结论必须来自 Baseline 对照。

---

# 17. Phase 11：Fault Injection

注入：

```text
LLM 429 / 500 / timeout
invalid tool call
Tool exception / timeout
MCP disconnect / restart
cancel during multi-tool step
process crash after committed event
context overflow
```

验证：

```text
Session Log 是否保持可恢复
Tool Call / Result 是否保持协议一致
是否重复执行副作用
Run Stop Reason 是否正确
Resume 后是否继续
Trace 是否能够解释失败路径
```

---

# 18. 暂不作为主线的功能

为了避免项目失控，以下功能只在核心 Harness 完成后再考虑：

```text
Web / TUI
Browser Use
Computer Use
SSH / Remote Execution
LSP
Full Sandbox
Workflow Engine
Subagent
Scheduling / Webhook
```

Subagent 如果后续实现，应重点研究：

```text
context isolation
tool restriction
budget inheritance
cancellation propagation
result aggregation
```

而不是只做“再调用一次 Agent”。

---

# 19. 推荐开发顺序

严格按依赖推进：

```text
Phase 0  Baseline
   ↓
Phase 1  Trace / Metrics
   ↓
Phase 2  JSONL Session Persistence / Resume
   ↓
Phase 3  Run Controller
   ↓
Phase 4  Tool Runtime V2
   ↓
Phase 5  Parallel Tool Calls
   ↓
Phase 6  Context Compaction
   ↓
Phase 7  Managed MCP Lifecycle
   ↓
Phase 8  Progressive Tool Disclosure
   ↓
Phase 9  Semantic Progress Detection
   ↓
Phase 10 Agent Evaluation
   ↓
Phase 11 Fault Injection
```

不要同时让 Coding Agent 修改多个 Phase。

每个阶段使用：

```text
Design Doc
  ↓
Implementation
  ↓
Unit Tests
  ↓
Integration Tests
  ↓
Benchmark / Failure Tests
  ↓
Commit
```

---

# 20. Git Commit 建议

```text
chore: establish runtime baseline
feat(trace): add structured run and tool tracing
feat(session): introduce session persistence seam
feat(session): add append-only jsonl session store
feat(session): support persisted session resume
feat(session): recover torn jsonl tail
feat(agent): add run controller and execution budgets
feat(tools): add schema validation pipeline
feat(tools): add timeout and cancellation
feat(tools): support bounded parallel safe calls
feat(context): add token-aware compaction
feat(mcp): add managed mcp lifecycle
feat(tools): add progressive tool disclosure
feat(agent): add semantic progress detection
feat(eval): add reproducible evaluation runner
feat(eval): add fault injection scenarios
```

Git 历史应成为“从最小 Harness 一层层做出工程能力”的直接证据。

---

# 21. 简历项目描述的技术口径

完成主要路线后，简历项目顶层统一使用 **Coding Agent Harness**，内部模块再使用 Runtime。

推荐版本：

## Mini-dsh — 基于插件化架构的轻量级 Coding Agent Harness

**项目简介：** 参考 DeepSeek Harness 的架构设计，自主实现轻量级 Coding Agent Harness，围绕持久会话、长任务执行、上下文治理、Tool / MCP 调度与 Agent 评测构建核心能力，并针对大规模工具场景设计 Progressive Tool Disclosure 等运行时优化机制。

**技术栈：** Node.js · DeepSeek API · Cordis · MCP · JSONL · JSON Schema

**项目内容：**

1. **插件化 Harness 架构：** 基于 Cordis `Context / Plugin / Service` 将 Session、System Prompt、LLM、Tool 与 Agent Loop 解耦为可替换服务，并以 append-only Session Event Log 作为权威历史，派生模型消息与运行状态；解决 Harness 核心能力强耦合、模块难独立演进的问题。

2. **持久会话与长任务治理：** 设计 `SessionStore` 持久化 seam，自主实现 append-only JSONL Session Store、Resume 与 Replay，并对日志撕裂尾部和中断轮次进行恢复；同时引入 Run Controller，对 Step、Tool Call、Token、Cost 与执行时长进行统一预算控制，解决进程重启后会话丢失及 Agent 长任务无限执行的问题。

3. **上下文与 Tool / MCP 治理：** 通过 Token-aware Compaction 将完整 Event Log 与模型可见 Context 解耦，压缩较早历史并保留近期原始对话；重构 Tool Runtime，加入 Schema Validation、Timeout / Cancellation 与 bounded parallel tool scheduling，并在 MCP 生命周期管理之上设计 Progressive Tool Disclosure，按任务选择并动态暴露相关 Tool Schema，解决长会话上下文膨胀及大规模工具带来的 Schema 开销问题。

4. **可观测与评测：** 构建 `Session → Run → Step → Tool Call` 级 Trace，记录 Token、Tool Call、Latency、Cost 与 Stop Reason；实现 Agent Evaluation 与 Fault Injection，对 Context Compaction、Tool Routing、长任务控制和故障恢复进行 Baseline 对照，解决 Harness 优化效果缺少统一量化依据的问题。

### 简历措辞约束

- 没有实现内核/容器隔离前，不写“安全沙箱”；
- 使用官方 MCP Client 时，不写“从零实现 MCP 协议”；
- JSONL 是 Session 权威存储，SQLite 若后续加入，只描述为 Query / Metrics / Index；
- 没有真实 Benchmark 数据前，不写“降低 XX%”“提升 XX%”；
- `Progressive Tool Disclosure`、`Run Controller`、`Semantic Progress Detection` 属于本项目自己的重点扩展，可以重点讲设计与实验；
- 官方已经存在的 Persistence / Compaction / Parallel Tool 等能力，表述为“参考成熟 Harness 的设计思想后自主实现简化版本”，不要暗示这些机制由本项目原创提出。

---

# 22. 最终验收标准

核心路线完成后，至少满足：

```text
[x] Session 可以跨进程恢复
[x] JSONL Event Log 是唯一权威历史
[x] 撕裂尾部可以恢复
[x] 中断 Tool Call 不会盲目重试副作用
[x] Run 有统一 Budget 和 Stop Reason
[x] Tool 参数会被统一校验
[x] Tool Timeout / Cancellation 有明确语义
[x] 并发安全 Tool 支持有界并行
[x] Cancellation 保持 Tool Call / Result 一致性
[x] 长 Session 支持 Token-aware Compaction
[x] MCP Server 有 Harness 级生命周期视图
[x] 大规模 Tool 支持 Progressive Disclosure
[ ] 可以检测重复/无进展执行
[x] 每个 Run 有结构化 Trace
[ ] 有可重复 Eval Suite
[ ] 有 Fault Injection Cases
[ ] 所有优化都有 Baseline 数据
[ ] Git 历史可以清楚看到每个模块独立实现过程
```

当以上核心项完成后，这个项目不再只是“学习 mini-dsh”，而是一套有清晰设计边界、可解释故障语义、可量化实验结果的轻量级 Coding Agent Harness。
