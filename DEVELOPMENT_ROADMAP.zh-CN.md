# mini-dsh 后续开发路线：从学习型 Harness 到可评测 Agent Runtime

> 文档定位：本文件用于指导 `kaikaiyang117/mini-dsh` 后续开发。它不是功能愿望清单，而是工程实施路线图：说明当前项目已经有什么、还缺什么、为什么要改、建议如何改、每个阶段应该达到什么效果，以及最终如何形成可验证、可面试、可写入简历的个人贡献。

---

## 0. 项目目标

当前 mini-dsh 最有价值的地方，是它用很少的代码把 Agent Harness 的核心链路讲清楚：

```text
Cordis Context / Plugin / Service
            │
            ├── Session Event Log
            ├── Tool Runtime
            ├── System Prompt
            ├── LLM Provider
            └── Agent Loop
                    │
                    └── Model -> Tool -> Model -> Answer
```

后续开发的目标不是复刻完整 DeepSeek Harness，也不是堆叠 Web UI、Browser Use、Computer Use、RAG、多 Agent 等表面功能，而是基于这个最小内核，自己从 0 实现一套关键的 Agent Runtime 工程能力。

最终希望把项目定位升级为：

> **A lightweight Agent Runtime for reliable long-horizon execution, progressive tool discovery, and reproducible evaluation.**
>
> 面向长任务执行、工具规模化与可重复评测的轻量级 Agent Runtime。

整个项目分为三层：

```text
第一层：原始 mini-dsh 核心
────────────────────────
Session Event Log
Tool Registry
LLM Adapter
Agent Loop
Cordis Plugin System

第二层：自己实现的 Runtime 基础设施
────────────────────────
Session Persistence / Resume
Run Controller / Budget
Tool Validation / Timeout / Cancellation
Parallel Tool Calls
Context Compaction
MCP Lifecycle
Trace / Metrics

第三层：项目自己的增强方向
────────────────────────
Progressive Tool Disclosure
Lazy MCP / Tool Search
Semantic Progress Detection
Agent Evaluation
Fault Injection
```

第一层负责“理解 Agent 怎么跑起来”，第二层负责“让 Agent Runtime 可以可靠运行”，第三层负责“形成区别于普通 mini Harness 的个人设计”。

---

# 1. 当前项目现状

## 1.1 当前已经具备的核心能力

当前仓库是一个按 DeepSeek Harness 概念手写的最小 Runtime，核心能力包括：

1. Cordis Context / Plugin / Service；
2. Session Event Log 与 `deriveMessages()`；
3. Tool Registry：`register / schemas / execute`；
4. LLM Provider Adapter；
5. Agent Loop：`model -> tool -> model -> answer`；
6. DeepSeek Streaming Adapter；
7. Bash / File 工具；
8. 应用层 workspace 路径限制与危险命令检查；
9. CLI `[Y/n]` 人工批准；
10. Esc 取消当前 Agent Run；
11. 外部 Cordis Plugin 加载；
12. 使用官方 `@deepseek-ai/dsh-mcp-client` 接入 Context7；
13. 基础单元测试与真实 Cordis Context 集成测试。

当前最重要的数据流是：

```text
User
  │
  ▼
Agent.send()
  │
  ▼
AgentLoopRuntime
  │
  ├── sessions.append(user/message)
  ├── sessions.deriveMessages()
  ├── systemPrompt.compose()
  ├── llm.invoke()
  │
  ├── no tool call ───────────────> answer
  │
  └── tool calls
          │
          ▼
      tools.execute()
          │
          ▼
      session event log
          │
          └──────────────> 下一轮 LLM
```

这个结构应该保留。后续所有生产化能力尽量通过新的 Runtime / Policy / Store / Plugin 扩展，而不是把 `AgentLoopRuntime` 改成一个几千行的“上帝类”。

---

## 1.2 当前明确缺失的能力

当前 README 已经明确说明以下能力尚未实现：

```text
maxSteps
token / cost budget
context compaction
no-progress detector
stop hooks
steering queue
完整权限系统
完整模型配置中心
TUI / Web UI
```

此外，从工程角度还有下面这些缺口：

```text
Session 仅内存保存
程序重启后无法 Resume
Run 没有结构化状态与停止原因
Tool 参数/结果治理较弱
Tool 调用主要顺序执行
缺少 Run / Step / Tool Trace
缺少统一 Metrics
MCP 生命周期主要依赖外部插件
工具数量增加后全部 Schema 会进入模型上下文
缺少系统化 Eval
缺少故障注入与回归实验
```

因此现在的项目仍然应该被理解为：

> 一个优秀的 Agent Harness 学习基线，而不是生产 Agent Runtime。

---

# 2. 与官方 DeepSeek Harness 的关系

## 2.1 官方项目应该作为“能力地图”，不是源码复制目标

当前官方 DeepSeek Harness 已经具有非常完整的模块化能力，包括：

- 持久 Session 数据平面；
- JSONL Persistence；
- Session Checkpoint；
- Session Projection / Cache；
- Compaction；
- Tool Result Pruning；
- Tool Schema / Output Validation；
- Tool Timeout；
- Parallel Tool Calls；
- Repeat Tool Guard；
- MCP reconnect / namespace / lifecycle；
- Skills；
- Subagent；
- Jobs；
- Workflow；
- Interaction / Approval；
- Linux bwrap / Landlock；
- macOS Seatbelt；
- Windows Restricted Token / ACL；
- OpenTelemetry；
- Replay / Mock / Testkit；
- Browser / Computer / SSH / LSP 等大量能力。

因此本项目**不追求功能数量与官方对齐**。

正确策略是：

```text
官方 DSH
   │
   ├── 研究它解决了什么 Runtime 问题
   ├── 理解为什么需要这个能力
   ├── 自己重新设计一个适合 mini-dsh 的简化版本
   └── 通过测试 / Benchmark 验证自己的实现
```

原则：

> 可以参考问题、抽象和架构思想，但核心代码、接口设计、测试与实验必须自己实现。

---

## 2.2 哪些官方能力值得自己重新实现

高优先级：

```text
Session Persistence / Resume
Context Compaction
Run Budget
Tool Validation
Tool Timeout / Cancellation
Parallel Tool Calls
MCP Lifecycle
Trace / Metrics
```

这些能力即使官方已经存在，自己重新实现仍然非常有价值，因为它们属于 Agent Runtime 的核心工程机制。

低优先级或暂不实现：

```text
Browser Use
Computer Use
Web GUI
ACP
Remote BFF
SSH
LSP
Windows Sandbox
完整 Landlock / Seatbelt
复杂 Workflow Engine
Webhook
大型 Settings / Credential Center
```

原因不是这些能力不重要，而是它们会显著扩大项目边界，却不能明显增强“理解并实现 Agent Runtime 核心机制”这条主线。

---

# 3. 开发原则

## 3.1 原始 Event Log 继续作为 Source of Truth

不要因为增加数据库就放弃当前设计。

保持：

```text
Session Events
    │
    ├── user/message
    ├── assistant/message
    ├── assistant/tool_calls
    ├── tool/result
    └── ... future events

        ↓ derive / project

LLM Messages / UI State / Metrics
```

数据库保存的是事件，不应该同时维护一套容易不一致的“最终 messages 表”。

---

## 3.2 Durable History 与 Model Context 必须分离

未来必须明确：

```text
完整 Session 历史
!=
每次发送给模型的上下文
```

即：

```text
Durable Event Log
       │
       ▼
Context Projector / Compactor
       │
       ├── Summary
       └── Recent Raw Events
       │
       ▼
LLM Request
```

完整历史负责恢复、审计和评测；上下文投影负责控制 token。

---

## 3.3 Side Effect 必须显式建模

工具不能只分“能不能执行”。

至少应增加：

```text
readOnly
idempotent
concurrencySafe
sideEffect
```

例如：

```text
read_file
  readOnly = true
  idempotent = true
  concurrencySafe = true

write_file
  readOnly = false
  idempotent = false / conditional
  concurrencySafe = false

bash
  sideEffect = unknown
  concurrencySafe = false by default
```

这会影响并发、Crash Recovery、Retry 和权限策略。

---

## 3.4 每个 Runtime 增强都必须可测试

每一个阶段至少包含：

```text
Design
Implementation
Unit Test
Integration Test
Failure Case
```

涉及性能/效率的能力还必须包含：

```text
Baseline
Experiment
Metrics
Comparison
```

如果不能测量，就不要在简历中写“显著优化”“提升效率”等结论。

---

## 3.5 不把当前 Sandbox 描述为安全隔离

当前 mini-dsh 的 workspace/path/command gate 是**应用层策略**，不是内核级安全边界。

必须继续保持这种描述：

> application-level policy gate

真正的安全边界目前仍然主要依靠 Human Approval。

除非未来真的接入 Docker / bubblewrap / Landlock / Seatbelt 等隔离机制，否则 README 和简历都不要使用“安全沙箱”“强隔离执行”等措辞。

---

# 4. 目标架构

完成主要路线后，希望形成下面的结构：

```text
                              User
                               │
                               ▼
                           AgentRuntime
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
   RunController         ContextManager          SessionRuntime
         │                     │                     │
   step/token/cost        token meter            Event Log
   time/tool budget       compaction              │
   progress state         projection               ▼
         │                     │                SessionStore
         │                     │              ┌──────┴──────┐
         │                     │              ▼             ▼
         │                     │          MemoryStore   SQLiteStore
         │                     │
         └──────────────┬──────┘
                        ▼
                  AgentLoopRuntime
                        │
                        ▼
                    ToolRouter
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
         ToolRuntime            McpRuntime
              │                    │
      validation/policy        connection
      timeout/cancel           discovery
      parallel groups          reconnect
              │                    │
              └─────────┬──────────┘
                        ▼
                   TraceRuntime
                        │
                        ▼
                     EvalRunner
```

---

# 5. 推荐新增目录结构

不要求一次性创建。随着阶段推进逐步增加。

```text
src/
├── core/
│   ├── agent-loop-runtime.js
│   ├── agent-runtime.js
│   ├── context-runtime.js             # 新
│   ├── llm-runtime.js
│   ├── run-controller-runtime.js      # 新
│   ├── session-runtime.js
│   ├── tool-runtime.js
│   ├── trace-runtime.js               # 新
│   └── ...
│
├── session/
│   ├── session-store.js               # 新
│   ├── memory-session-store.js        # 新
│   └── sqlite-session-store.js        # 新
│
├── context/
│   ├── token-meter.js                 # 新
│   ├── context-projector.js           # 新
│   └── compactor.js                   # 新
│
├── tools/
│   ├── bash.js
│   ├── files.js
│   ├── tool-schema.js                 # 新
│   └── tool-router.js                 # 后期新增
│
├── mcp/
│   └── mcp-runtime.js                 # 后期新增
│
├── eval/
│   ├── eval-runner.js                 # 后期新增
│   ├── scorer.js
│   └── metrics.js
│
└── plugins/
    ├── sessions.js
    ├── run-controller.js              # 新
    ├── trace.js                       # 新
    ├── context.js                     # 新
    └── ...

evals/
├── fixtures/
├── filesystem/
├── tool-routing/
├── long-horizon/
├── tool-failure/
├── mcp-failure/
└── context-pressure/

docs/
└── design/
    ├── session-persistence.md
    ├── run-controller.md
    ├── tool-runtime-v2.md
    ├── compaction.md
    ├── progressive-tools.md
    └── evaluation.md
```

目录仅表示模块边界，具体文件可以根据实现保持精简。

---

# 6. Phase 0：建立个人开发基线

## 目标

在修改 Runtime 前，先明确项目当前行为和自己的贡献边界。

## 要做的事情

### 6.1 保存基线测试

要求当前：

```bash
pnpm test
pnpm check
```

必须全部通过。

新增一组 Baseline Integration Test，固定以下行为：

```text
普通问答
1 次 Tool Call
连续多次 Tool Call
一次返回多个 Tool Call
取消执行
工具失败
MCP 不可达但 CLI 可启动
```

后续每个 Phase 都必须保证这些旧行为没有被破坏。

### 6.2 明确 upstream 与个人扩展

新增或后续补充：

```text
UPSTREAM.md
CHANGELOG.md
```

`UPSTREAM.md` 应说明：

- 原始项目来源；
- MIT License；
- 哪个 commit / snapshot 作为开发起点；
- 后续哪些模块属于自己的实现。

## 完成标准

- 当前测试全部绿色；
- 有一个固定 baseline；
- 后续任何性能对比都可以回到 baseline；
- Git 历史能够区分“同步上游”和“个人开发”。

---

# 7. Phase 1：Trace / Metrics 基础设施

> 建议先做 Trace，再做优化。否则后续很多改动无法量化。

## 当前问题

现在运行过程主要依靠 CLI callback 输出：

```text
onReasoning
onContent
onToolCall
onToolResult
```

但缺少结构化 Run 级数据。

## 目标

为一次 Agent 执行建立统一身份：

```text
sessionId
   └── runId
        └── stepId
             └── toolCallId
```

## 建议数据结构

```js
RunTrace {
  runId,
  sessionId,
  startedAt,
  endedAt,
  stopReason,
  usage: {
    inputTokens,
    outputTokens,
    reasoningTokens,
    estimatedCost
  },
  steps: [],
  toolCalls: []
}
```

Tool Trace 至少记录：

```text
tool name
arguments hash
start/end time
latency
success/failure
cancelled/timeout
```

LLM Trace 至少记录：

```text
provider/model
TTFT（如果可得）
latency
input/output token
finish reason
```

## 实现原则

Trace 不能成为 AgentLoop 的业务逻辑。

推荐：

```text
AgentLoop
  │ emits events
  ▼
TraceRuntime
```

第一版可以只输出：

```text
.trace/<run-id>.json
```

暂时不需要 OpenTelemetry。

## 验收标准

- 每个 Agent Run 都生成唯一 `runId`；
- 可以从 Trace 重建一次执行的 Step 和 Tool Call 顺序；
- Cancellation / Tool Error 都能在 Trace 中体现；
- 不改变 Session Event Log 的语义；
- Trace 写入失败不能把正常 Agent Run 打挂。

---

# 8. Phase 2：Session Persistence + Resume

这是第一块真正从“学习 Demo”迈向 Runtime 的关键能力。

## 当前问题

当前 `SessionRuntime` 使用内存 `Map`。

```text
process exit
    ↓
all sessions lost
```

## 目标

把 Session 存储抽象成：

```text
SessionRuntime
     │
     ▼
SessionStore
     │
 ┌───┴─────────┐
 ▼             ▼
Memory       SQLite
```

## 建议接口

```js
class SessionStore {
  create(session)
  get(sessionId)
  list()
  append(sessionId, event)
  clear(sessionId)
}
```

`SessionRuntime` 仍然负责：

```text
Session 语义
Event 类型
deriveMessages()
```

`SessionStore` 只负责持久化。

不要让数据库后端理解 LLM Message。

## SQLite 建议表

第一版保持简单：

```sql
sessions(
  id,
  created_at,
  updated_at,
  metadata_json
)

events(
  session_id,
  seq,
  type,
  data_json,
  created_at,
  PRIMARY KEY(session_id, seq)
)
```

不要过度范式化每一种 Event。

## Resume

CLI 增加类似：

```text
/sessions
/resume <session-id>
/new
```

恢复流程：

```text
SQLite
  ↓
load events
  ↓
SessionRuntime
  ↓
deriveMessages()
  ↓
Agent continues
```

## Crash Recovery 第一版

至少检测 Event Log 中不完整的 Tool Call。

必须区分：

```text
read-only / idempotent tool
side-effect tool
```

不要在重启后无脑重新执行 side-effect tool。

推荐第一版行为：

```text
发现未完成 tool call

readOnly && idempotent
    -> 可由策略决定 retry

otherwise
    -> 标记 interrupted / unknown
    -> 不自动重试
```

## 验收标准

测试：

```text
create -> restart -> load
conversation -> restart -> continue
clear -> restart -> remains clear
multi-session isolation
invalid/corrupt event handling
interrupted tool call detection
```

成功标准：

> kill 进程后重新启动，可以使用同一个 sessionId 继续对话，而且 Event Log 顺序和 tool_call/tool_result 协议仍然一致。

---

# 9. Phase 3：Run Controller / Execution Budget

## 当前问题

当前 Agent Loop 的核心是：

```js
while (true) {
  ...
}
```

模型只要持续调用 Tool，Runtime 就会持续运行。

## 目标

引入独立：

```text
RunController
```

统一治理一次 Agent Run 的资源预算。

## Run Policy

第一版建议：

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

不要把所有配置直接散落在 AgentLoop 中。

## Run State

```js
RunState {
  stepCount,
  toolCallCount,
  startedAt,
  usage,
  failures
}
```

## Stop Reason

必须统一定义：

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

## AgentLoop 改造

从：

```text
while true
```

变为：

```text
beforeRun

while controller.canContinue(runState)
    beforeStep
    model
    tools
    afterStep

finish(stopReason)
```

注意：

> RunController 决定“是否允许继续”，AgentLoop 决定“下一步如何执行”。

两个职责不要混在一起。

## 返回值

未来可以让内部 Runtime 返回：

```js
RunResult {
  status,
  answer,
  stopReason,
  usage,
  runId
}
```

CLI 再决定如何展示。

## 验收标准

分别构造无限 Tool Agent，验证：

```text
step limit 生效
tool call limit 生效
time limit 生效
cancel 优先级正确
正常完成不会误判 limit
stop reason 与 Trace 一致
```

---

# 10. Phase 4：Tool Runtime V2

这是后续 Parallel、Crash Recovery、Tool Routing、MCP 的基础。

## 当前问题

当前 ToolRuntime 主要解决：

```text
register
schemas
execute
```

但工具执行缺少统一治理。

## 目标结构

```text
ToolRuntime
    │
    ├── Registry
    ├── Schema Validation
    ├── Metadata
    ├── Execution Pipeline
    ├── Timeout
    ├── Cancellation
    └── Normalized Result
```

## ToolDefinition 建议升级

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

第一版 Metadata 不需要完美，只需要有清晰默认值：

```text
未声明 concurrencySafe -> false
未声明 readOnly -> false
未声明 idempotent -> false
```

默认 fail closed。

## Schema Validation

工具参数必须在 Runtime 层统一验证。

可以选：

```text
JSON Schema + AJV
```

要求：

```text
invalid model arguments
     ↓
normalized tool error
     ↓
记录 tool/result
     ↓
返回模型
```

不能因为模型产生错误 JSON 参数就破坏 Event Log。

## Timeout

```text
ToolDefinition.timeoutMs
        ↓
AbortController / AbortSignal
        ↓
Tool execution
```

必须明确：

> JS 同进程 Tool 的 timeout 通常是 cooperative cancellation，并不代表能够强杀任意同步代码。

README 要保持准确描述。

## Normalized Result

统一：

```js
{
  value,
  content,
  isError,
  errorCode,
  metadata
}
```

避免每个 Tool 自己发明错误格式。

## 验收标准

覆盖：

```text
invalid args
throw error
timeout
cancel
normal value
large result
unknown tool
```

并确认每一种情况最终都产生合法 Tool Result。

---

# 11. Phase 5：Parallel Tool Calls

## 当前问题

当模型一次产生多个 Tool Call 时，当前 Runtime 主要顺序执行。

## 目标

让安全的 Tool 并行执行：

```text
LLM
 ↓
read_file A
read_file B
grep C
 ↓
parallel group
```

而副作用 Tool 默认串行：

```text
write_file
bash
git commit
```

## 调度规则

推荐第一版：

```text
concurrencySafe === true
    -> 可以进入 parallel group

otherwise
    -> exclusive
```

再增加：

```text
maxParallelToolCalls
```

作为全局并发上限。

## 关键难点

必须保证：

```text
模型发出的 tool_call 顺序
!=
执行完成顺序
```

但最终 Event Log / Tool Result 必须能够按照 `tool_call_id` 正确关联。

Cancellation 时也必须继续保持：

> 每一个已经写入 assistant tool_calls 的 call 都有对应 result/cancelled result。

这是现有项目已经解决过一次的重要协议不变式，不允许因为并行执行重新引入。

## Benchmark

准备多个独立 `read_file / grep` Tool Call：

```text
serial latency
vs
parallel latency
```

只允许写真实测量结果。

---

# 12. Phase 6：Context Manager + Compaction

## 当前问题

现在每一步通过完整 Event Log：

```text
deriveMessages()
```

长期运行后模型上下文会持续增长。

## 目标

新增：

```text
ContextManager
```

让：

```text
Session History
```

和：

```text
Model Context
```

正式解耦。

## 第一版策略

采用最容易解释的：

```text
Summary + Recent Window
```

例如：

```text
Event 1 ~ 70
      ↓
 summary

Event 71 ~ 100
      ↓
 raw events
```

发送：

```text
System Prompt
Summary
Recent Raw Messages
```

## Token Meter

需要独立：

```text
TokenMeter
```

至少允许：

```text
estimate messages token
estimate tool schema token
record actual provider usage when available
```

## Compaction Trigger

```text
contextTokens >= threshold
```

而不是按固定“第 20 轮”压缩。

## Compaction Event

推荐把压缩记录进 Event Log，例如：

```text
context/compaction
```

保存：

```text
shadowed event range
summary
createdAt
model / strategy
```

但原始 Event 不删除。

## 必须保证

不能从中间切断：

```text
assistant/tool_calls
        +
tool/result
```

它们必须作为逻辑完整单元处理。

## 验收标准

创建 50~100 Step 长任务：

比较：

```text
baseline context tokens
compaction context tokens
任务成功率
summary 次数
总 LLM token
```

---

# 13. Phase 7：Managed MCP Runtime

## 当前现状

现在 mini-dsh 通过官方 `@deepseek-ai/dsh-mcp-client` 加载 Context7，已经验证了：

```text
MCP tool
   ↓
ctx.tools.register()
   ↓
AgentLoop 无需理解 MCP
```

这个设计应该保留。

## 后续目标

不要重写 MCP 协议本身。

在现有客户端之上增加自己的：

```text
McpRuntime / McpManager
```

负责 Runtime 生命周期治理：

```text
server registry
connection state
health
reconnect
backoff
tool generation
namespace
reload
```

## 状态机

```text
DISCONNECTED
    ↓
CONNECTING
    ↓
READY
    ↓
DEGRADED / FAILED
    ↓
RECONNECTING
```

## 第一版功能

```text
/mcp list
/mcp connect <name>
/mcp disconnect <name>
/mcp reload <name>
```

## Reconnect

建议：

```text
exponential backoff
max attempts
jitter optional
```

## 验收标准

故障测试：

```text
server unavailable at startup
server disconnect during run
server restart
reconnect success
reconnect exhausted
namespace collision
```

MCP 故障不能污染本地 Tool Runtime。

---

# 14. Phase 8：Progressive Tool Disclosure【个人重点方向】

这是项目最值得形成个人特色的模块之一。

## 问题

如果未来接入大量 MCP Server：

```text
GitHub
Filesystem
Database
Kubernetes
Slack
Jira
Browser
...
```

可能出现：

```text
100~300 tools
```

传统做法把所有 Tool Schema 每轮发送给模型：

```text
Prompt
+
All Tool Schemas
```

导致：

- tool schema token 增长；
- 无关工具干扰 Tool Selection；
- MCP 数量越多，模型请求越重；
- 新增工具会影响所有任务。

## 目标

引入：

```text
Tool Catalog
     │
     ▼
Tool Router
     │
     ▼
Top-K Candidate Tools
     │
     ▼
LLM Request
```

## Tool Catalog

Catalog 保存完整工具元数据，但不代表全部暴露给模型。

```js
ToolCatalogItem {
  name,
  description,
  tags,
  source,
  schemaSummary,
  fullDefinition
}
```

## Tool Router V1

不要一开始就引入 embedding。

先实现：

```text
keyword / BM25 / simple lexical retrieval
```

输入：

```text
user request
recent context
```

输出：

```text
Top-K tools
```

之后再增加 dense retrieval，做实验对比。

## `tool_search`

更进一步，让模型初始只看到少数 Core Tool：

```text
read_file
bash
grep
tool_search
```

当需要新能力：

```text
tool_search("create github issue")
     ↓
GitHub candidate tools
     ↓
activate in session
```

## Tool Activation Scope

第一版按 Session 维护：

```text
base tools
+
activated tools
```

后续允许 LRU / TTL。

## Lazy MCP

与 McpRuntime 结合：

```text
MCP Registry
   │
server metadata only
   │
Tool Router identifies server
   │
connect / discover
   │
activate selected tools
```

这可以避免 Agent 启动时连接所有 MCP Server。

## 最重要的 Benchmark

创建不同 Tool Scale：

```text
10
50
100
200
```

比较：

```text
All Tools
Top-K Router
Tool Search
```

指标：

```text
success rate
tool schema tokens
total tokens
first correct tool rate
tool selection latency
end-to-end latency
```

这个模块应该成为最终简历和答辩的重点之一。

---

# 15. Phase 9：Semantic Progress Detection【个人重点方向】

## 当前问题

简单的 Repeat Detector 只能识别：

```text
完全相同 Tool + 完全相同 Args
```

但真实 Agent 可能这样卡住：

```text
grep("Agent") -> no match
grep("agent") -> no match
grep("AgentRuntime") -> no match
```

调用不同，但任务没有推进。

## 目标

定义：

```text
ProgressDetector
```

分析最近 N Step 是否产生真正的新状态。

## V1：Action / Result Signature

```text
signature =
  toolName
  + normalizedArgs
  + resultClass
  + resultHash
```

识别相近重复。

## V2：Workspace Delta

针对 Coding Agent：

```text
files changed
new file
command exit state
new test result
new discovered symbol
```

用于判断任务是否发生客观状态变化。

## V3：Intervention

不是第一次检测到就终止。

推荐：

```text
Level 1
soft reminder

Level 2
force reflection / strategy change

Level 3
stopReason = no_progress
```

## 验收标准

准备固定 Loop Cases：

```text
identical repeat
semantically equivalent repeat
legitimate repeated polling
progress after failure
```

必须避免把正常 retry 全部误杀。

重点记录：

```text
precision / false positive cases
saved steps
saved tokens
success rate impact
```

---

# 16. Phase 10：Agent Evaluation Framework【个人重点方向】

这个阶段负责把前面所有“优化”变成可证明的工程结果。

## 目标结构

```text
EvalCase
   ↓
EvalRunner
   ↓
Agent Runtime
   ↓
Trace
   ↓
Scorer
   ↓
EvalReport
```

## EvalCase

建议 YAML / JSON：

```yaml
name: find-database-config
prompt: |
  Find where the database connection is configured.

workspace: ./fixtures/project-a

limits:
  maxSteps: 20
  maxTokens: 20000

expect:
  files:
    - src/config/database.js
```

## Eval 类型

至少准备：

```text
filesystem-basic
multi-tool
coding-edit
long-horizon
tool-failure
mcp-failure
context-pressure
tool-routing
no-progress
crash-recovery
```

## Metrics

统一：

```text
success
steps
tool calls
failed tool calls
repeated calls
input tokens
output tokens
tool schema tokens
cost
latency
stop reason
```

## Baseline Matrix

最终至少做：

```text
Baseline mini-dsh

+ Run Controller
+ Parallel Tools
+ Compaction
+ Tool Router
+ Progress Detector
```

严禁在 README 中提前填写漂亮数字。

只有真实 Benchmark 结果才能写：

```text
减少 xx% token
降低 xx% step
提高 xx% success rate
```

## 报告

可以输出：

```text
reports/eval-YYYYMMDD.json
reports/eval-YYYYMMDD.md
```

后期可再生成图表。

---

# 17. Phase 11：Fault Injection / Reliability Testing

与 Eval Framework 配套，而不是独立做一个大系统。

## LLM 故障

模拟：

```text
429
500
timeout
connection reset
invalid SSE
invalid tool arguments
partial tool call stream
```

## Tool 故障

```text
throw
timeout
cancel
invalid result
large result
partial side effect
```

## MCP 故障

```text
disconnect
restart
tool list changed
server unavailable
slow response
```

## Runtime 故障

```text
cancel during multi-tool
process crash
restart
corrupt persistence entry
context overflow
```

## 核心检查

```text
Event Log 是否仍合法？
每个 tool_call 是否都有结果？
是否重复产生副作用？
是否可以 resume？
StopReason 是否准确？
Trace 是否完整？
```

这部分会形成项目非常好的可靠性故事。

---

# 18. Optional Phase：Subagent

只在单 Agent Runtime 基础稳定后做。

不要把它做成“多 Agent 聊天”。

真正值得研究的是：

```text
Parent Agent
    │
    ├── context isolation
    ├── tool restriction
    ├── budget inheritance
    ├── cancellation propagation
    └── result aggregation
```

示例：

```text
Parent Run Budget = 100K tokens

Child A <= 20K
Child B <= 20K
```

这会把前面已经实现的 RunController / ToolRuntime / Session 复用起来。

如果这些底层能力尚未稳定，不要提前做 Subagent。

---

# 19. 明确不做或暂缓的内容

为了避免项目失控，以下内容不是近期目标：

```text
完整 Web/TUI
完整 Browser Agent
Computer Use
RAG 知识库平台
复杂 Workflow DSL
企业级 Credential Center
跨平台内核 Sandbox 全实现
Kubernetes 调度
分布式 Agent Cluster
大量模型 Provider
```

判断一个需求是否应该加入主线时，先问：

> 它是否帮助我们理解或改进 Agent Runtime 的可靠性、长任务控制、工具治理或可评测性？

如果答案是否定的，优先不做。

---

# 20. 推荐开发顺序

最终建议严格按照：

```text
Phase 0  Baseline / Ownership
    ↓
Phase 1  Trace / Metrics
    ↓
Phase 2  Session Persistence / Resume
    ↓
Phase 3  Run Controller / Budget
    ↓
Phase 4  Tool Runtime V2
    ↓
Phase 5  Parallel Tool Calls
    ↓
Phase 6  Context Manager / Compaction
    ↓
Phase 7  MCP Runtime
    ↓
Phase 8  Progressive Tool Disclosure
    ↓
Phase 9  Semantic Progress Detection
    ↓
Phase 10 Agent Evaluation
    ↓
Phase 11 Fault Injection
    ↓
Optional  Subagent
```

其中真正决定项目是否适合简历的核心不是“做完多少阶段”，而是：

```text
Phase 2~6 是否实现扎实
+
Phase 8~10 是否形成自己的设计与实验
```

---

# 21. 每个 Phase 的开发模板

后续交给 Coding Agent 开发时，每一阶段必须按下面顺序执行。

## Step 1：读现有代码

先指出：

```text
当前行为
入口文件
相关 Runtime
已有测试
不允许破坏的不变式
```

## Step 2：写 Design Note

在：

```text
docs/design/<feature>.md
```

至少回答：

```text
Problem
Goals
Non-goals
Architecture
Public API
Data Model
Failure Semantics
Compatibility
Testing
```

## Step 3：先增加核心测试

至少包含：

```text
happy path
edge case
failure path
cancellation
```

## Step 4：实现最小闭环

不要一次加入 V1/V2/V3 所有功能。

例如 Persistence：

```text
MemoryStore abstraction
      ↓
SQLiteStore
      ↓
Resume
      ↓
Crash recovery
```

分 commit 完成。

## Step 5：Integration Test

必须通过真实：

```text
Cordis Context
Plugins
AgentLoop
Mock LLM
```

不能只测孤立 class。

## Step 6：更新文档

同步更新：

```text
README
ARCHITECTURE
CHANGELOG
Design Note
```

## Step 7：Benchmark（适用时）

保存原始输出，不手工编写数字。

---

# 22. Git Commit 规范建议

希望最终 Git History 本身就是开发过程说明书。

例如：

```text
feat(trace): add structured agent run tracing

feat(session): introduce session store abstraction
feat(session): persist event logs with sqlite
feat(session): resume persisted sessions
feat(session): detect interrupted tool calls on recovery

feat(agent): add run budget controller
feat(agent): return structured stop reasons

feat(tools): add schema validation pipeline
feat(tools): enforce cooperative tool timeouts
feat(tools): add tool execution metadata
feat(tools): execute concurrency-safe calls in parallel

feat(context): add token-aware context projection
feat(context): compact old history into summaries

feat(mcp): add managed server lifecycle
feat(mcp): reconnect failed servers with backoff

feat(router): add tool catalog and top-k routing
feat(router): add dynamic tool_search activation

feat(agent): detect no-progress execution patterns

feat(eval): add reproducible evaluation runner
feat(eval): add failure injection suite
```

不要把一个月的开发全部压成：

```text
feat: improve agent
```

---

# 23. 最终 README 应该如何演进

当前 README 仍然应继续说明“这是从 mini-dsh 学习版演进而来”。

随着功能完成，可以逐步把首页结构改成：

```text
Project Positioning
Architecture
Core Runtime
Reliability
Tool Scaling
Evaluation
Benchmarks
Learning / Upstream
```

但必须满足：

> 功能真正完成并通过测试后，才能从 Roadmap 移到 Features。

Roadmap 中的内容不能提前包装成已有能力。

---

# 24. 最终简历叙事

只有真正完成后才允许使用下面的描述。

## Runtime 基础

可以形成：

> 基于 Cordis 插件架构扩展轻量级 Agent Runtime，将 Session、LLM、Tool 与 Agent Loop 解耦为可插拔服务，并围绕 Event Sourcing 实现持久会话、执行控制和上下文治理。

## Persistence

完成 Phase 2 后：

> 基于 Event Sourcing 与 SQLite 实现 Agent Session 持久化、Resume 与异常中断恢复，保持 Tool Call / Tool Result 协议一致性，并针对非幂等副作用工具避免盲目重试。

## Run Controller

完成 Phase 3 后：

> 设计 Run Controller，对 Agent 长任务统一实施 Step、Tool Call、Token、Cost 与执行时长预算治理，并通过结构化 Stop Reason 管理正常结束、取消和资源超限等状态。

## Tool Runtime

完成 Phase 4~5 后：

> 重构 Tool Runtime 执行流水线，实现参数校验、超时与取消、标准化错误及工具并发元数据，并依据副作用与并发安全属性调度多 Tool 并行执行。

## Tool Scaling

完成 Phase 8 后：

> 面向大规模 Tool/MCP 场景设计 Progressive Tool Disclosure，通过 Tool Catalog、Top-K Routing 与动态 Tool Search 按需暴露工具 Schema，降低无关工具带来的上下文开销。

## Evaluation

完成 Phase 9~11 后：

> 构建 Agent Trace、Evaluation 与 Fault Injection 框架，对长任务、工具路由、上下文压力及故障恢复进行可重复评测，统计任务成功率、Step、Tool Call、Token、Cost 与时延，并通过 Baseline 实验验证 Runtime 优化效果。

注意：

> 没有真实 Benchmark 数字之前，禁止在简历中虚构百分比。

---

# 25. 面试时最终应该能回答的问题

如果这个项目开发成功，至少应该可以不看代码回答：

1. 为什么 Session Event Log 比直接保存 Messages 更适合作为 Source of Truth？
2. Event Log 持久化以后，为什么仍然需要 Context Projection？
3. Crash Recovery 时为什么不能直接 retry 所有 Tool？
4. 幂等性与 Side Effect 有什么区别？
5. Agent Loop 为什么需要 Run-level Budget，而不仅仅是 Tool Timeout？
6. Step Limit、Token Limit、Cost Limit 的优先级如何处理？
7. Cancellation 为什么可能破坏 tool_calls / tool_result 协议？
8. JS Tool Timeout 为什么通常只是 cooperative cancellation？
9. 哪些 Tool 可以并行？如何定义 concurrency safe？
10. 并行 Tool 完成顺序与模型 Tool Call 顺序不同怎么办？
11. Context Compaction 为什么不能直接删除旧 Event？
12. Compaction 如何避免截断 Tool Call / Tool Result？
13. MCP Server 断线时为什么不应该把 Agent Runtime 一起打挂？
14. 为什么工具数量增加会产生 Tool Schema Token 问题？
15. Progressive Tool Disclosure 与 Skill Progressive Disclosure 有什么区别？
16. Top-K Tool Routing 可能导致什么 Recall 问题？
17. 为什么需要 `tool_search` 作为 Router 的补充？
18. 完全相同 Tool Call Detection 为什么不足以判断 No Progress？
19. 怎么定义“Agent 有进展”？
20. 如何证明 Compaction / Tool Routing / Parallel Tool 真正有效？
21. Eval 如何减少 LLM 随机性造成的误判？
22. Replay Test 和真实模型 Benchmark 的作用分别是什么？
23. Fault Injection 应该验证哪些 Runtime invariant？
24. 当前 Sandbox 为什么不能称为真正安全隔离？
25. 与官方 DeepSeek Harness 相比，这个项目为什么没有复刻所有能力？
26. 哪些模块是上游 mini-dsh 已有，哪些是你自己实现的？
27. 如果再给你一个月，你会优先优化哪一个 Runtime 问题？

这些问题答得清楚，比功能数量更重要。

---

# 26. 完成定义（Definition of Done）

这个项目不要求变成完整生产系统。

达到下面状态，就已经可以认为这一轮改造成功：

```text
[ ] Session 可以持久化并 Resume
[ ] 一次 Run 有明确预算和 StopReason
[ ] Tool 有统一 Schema / Timeout / Cancellation 流水线
[ ] 安全 Tool 可以并行执行
[ ] 长 Session 可以进行 Context Compaction
[ ] MCP 有自己的生命周期管理层
[ ] 每次 Run 有结构化 Trace
[ ] Tool 数量增加时支持 Progressive Disclosure
[ ] 可以检测至少一类 Semantic No-Progress
[ ] 有可重复 Eval Runner
[ ] 有 Fault Injection Cases
[ ] 所有核心能力都有 Unit + Integration Test
[ ] README 明确上游与个人贡献
[ ] Benchmark 数字全部来自真实实验
```

---

# 27. 最后原则

这个项目后续不要追求：

> “我实现了和官方 DSH 一样多的功能。”

应该追求：

> “我从一个最小 Agent Harness 出发，理解成熟 Agent Runtime 为什么需要这些机制，然后自己重新实现关键生产能力，并针对工具规模化和长任务执行问题设计了额外方案，最后通过可重复实验验证。”

这才是整个项目最适合学习、GitHub 展示和简历面试的主线。
