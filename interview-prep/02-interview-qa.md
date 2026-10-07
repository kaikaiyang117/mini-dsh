# 02 · Agent 开发岗面试题库与参考答案（mini-dsh）

> 用法：先按分组把问题过一遍，能不看答案讲出"要点 + 一个具体代码/数据证据"才算过关。标 **【深挖】** 的题在 `research/` 三份事实清单里有代码级细节；标 **【通识】** 的是 Agent 岗通用题，答案不依赖本项目但尽量用本项目举例。

## 使用说明

- 面试节奏通常是：**自我介绍 → 挑简历上最亮的项目深挖 → 通用 Agent 知识 → 系统设计 → 行为/反问**。本文件按这个顺序组织。
- 每个答案都遵循同一个结构：**结论 → 机制 → 取舍/边界 → 证据**。面试官打断在任何一层都能接住。
- 数字只能引用 `01-overview-and-pitch.md` 第十节"数字卡片"里的，且必须带"合成评测/Mock LLM"限定。
- 遇到确实不会的：明确说"这块我目前的理解边界是 X，我会这样验证 Y"，不要编。

---

# A. 项目动机与定位

### A1. 为什么做这个项目？它解决什么问题？
**答**：我想搞清楚"为什么很多 Agent demo 能跑通，但一到长任务就不稳定"。结论是：**难点基本不在模型，而在 Harness 层**——状态持久化、工具执行可靠性、并发顺序、上下文治理、停止与预算、可复现评测。
所以 mini-dsh 不是又一个 prompt 套壳，而是把 `Coding Agent = Model + Harness` 里的 Harness 工程化：append-only Event Log 做唯一事实源，Tool Runtime 做校验/归一化/有界并行，ContextManager 做可重建的上下文投影，RunController 做预算与停止，再加 7 个确定性 Eval Suite 验证行为。
**边界**：它不训练模型，也不是生产级分布式系统。

### A2. 什么是 Harness？和 LangChain / LlamaIndex 有什么区别？
**答**：Harness = 模型之外、负责"把一次推理变成可靠任务执行"的运行时。LangChain/LlamaIndex 更偏**编排与应用层抽象**（chain、retriever、agent executor、工具接入）；mini-dsh 更偏**运行时内核语义**：协议不变量、事件日志、恢复、并发提交顺序、预算/停止原因、上下文压缩边界、评测方法论。
一句话：它们关注"怎么快速搭起来"，我关注"搭起来之后为什么会在长任务里坏、怎么证明它没坏"。

### A3. 为什么不直接用一个现成 Agent 框架，而要自己写循环？
**答**：这个项目的目的就是学习并掌控运行时语义，所以**故意自己实现核心 Harness 逻辑**，而不是再包一层框架。同时我也刻意划清依赖边界：Cordis 提供插件/服务/生命周期，官方 MCP client 提供协议与传输，Ajv 提供 JSON Schema 校验；Agent Loop、Session、RunController、ToolRuntime/Scheduler、Context、Visibility、Progress、Eval 都是本仓库实现。
**取舍**：如果目标是快速交付产品，我会优先用成熟框架；但要做可靠性和可评测性研究，掌控内核是必要的。

### A4. 你个人在这个项目里最大的贡献是什么？
**答**：项目共 61 个 commit、11 个 Phase，其中 52 个是我提交的，上游只保留一个 snapshot 作为 baseline。我个人的重点在 Phase 8/9/10/11：
- **Progressive Tool Disclosure**：词法 Top-K + Run-scoped `tool_search` 激活；
- **Deterministic Progress Guard**：规范化调用 + 结果类别 + 指纹 + 新颖度；
- **Harness Evaluation Framework**：7 个 suite；
- **可靠性评测**：fault injection / crash recovery / MCP failure。
**证据**：`git log` 能看到每个模块独立演进的 commit，不是一次性生成的。

### A5. 项目里你最有成就感的点？
**答**：把"**每条 committed Tool Call 最终恰好有一条 Tool Result**"这条不变量，在**正常、取消、预算耗尽、调度器异常、进程崩溃**五条路径上全部闭合，并且用 fault injection + crash recovery 评测证明它。这比单纯多支持一个工具难得多，因为它要求在异常路径上仍然保持协议完整。
**证据**：`agent-loop-runtime.js` 的 synthetic result / unknown result 逻辑 + `session-runtime.js` 的恢复补写 + 对应 suite 全绿。

### A6. 如果重做，你会怎么改？ 
**答**：四点：
1. **TokenMeter 换成真实 tokenizer 校准**，现在 3 bytes/token 是确定性守卫，不是精度保证；
2. **词法路由升级为可评测的 embedding / 混合检索**，并让模型生成检索 query，而不是 harness 猜语义；
3. **补多 case 真实模型 benchmark**，验证合成评测结论能否迁移；
4. **把 JSONL 的并发/多进程边界补齐**（锁或单写者 + fsync 策略），并加超长日志的 O(n) 投影性能优化。
**加分点**：主动说这些说明你知道项目的天花板在哪。

---

# B. 架构与插件化

### B1. 画出整体架构，讲清数据流。
**答**：分三层讲（详见 `01-overview-and-pitch.md` 第七节）：

```
CLI → AgentRuntime → AgentLoopRuntime
                       ├── RunController（是否继续）
                       ├── ContextManager（看到什么）
                       ├── ToolCatalog → ToolVisibility（可见哪些 schema）
                       ├── ToolScheduler → ToolRuntime（怎么执行/并发）
                       ├── LlmRuntime → Provider Adapter
                       └── SemanticProgressDetector / TraceRuntime
                     ↕
               SessionRuntime → SessionStore（Memory / JSONL）
                                 └── Event Log（唯一事实源）→ 投影/压缩/恢复
```
数据流：用户输入 → append `user/message` → 每 Step 组装 system prompt + 可见 schema → ContextManager.prepare 投影 → LLM → 有 tool call 就先 append 再调度 → 按原序 append result → RunController 决定下一步或停止。

### B2. 为什么用 Cordis 插件化？带来什么好处？
**答**：Cordis 提供 `Context / Plugin / Service / Fiber` 生命周期与依赖注入。好处：
1. **可替换**：Session 有 Memory / JSONL 两种 Store，MCP client、LLM provider 都能换；
2. **可独立测试**：`src/core/*` 是纯 JS 类，不依赖 CLI 也能单测；
3. **生命周期清晰**：MCP 的 connect/disconnect/reload/dispose 直接映射到 Fiber 生命周期；
4. **解耦**：Agent Loop 用统一的 Tool Runtime，不感知 Bash / Files / Context7 的区别。
**取舍**：引入框架心智负担；核心类我仍然写成不依赖容器的普通对象，便于测试。

### B3. AgentRuntime 和 AgentLoopRuntime 为什么拆开？
**答**：`AgentRuntime` 是一个很薄的 `sessionId + model + loop` 句柄，`send()` 委托给 Loop；`AgentLoopRuntime` 才持有单次 Run 的完整状态（RunController、deadline、trace、progress detector、activation store）。
这样拆的好处：Agent 是"长期存在的会话身份"，Run 是"一次有预算、有生命周期、可取消的执行"，两者生命周期不同。把 Run 状态隔离在 loop 内，避免跨 Run 污染（比如 Progressive 激活集必须每 Run 清空）。

### B4. 哪些是自研、哪些是依赖？边界怎么划？
**答**：
- **依赖**：Cordis（插件/服务/生命周期）、`@deepseek-ai/dsh-mcp-client`（MCP 协议/transport/远端重连/工具同步）、Ajv（Schema 编译与校验）、DeepSeek 模型服务。
- **自研**：Agent Loop、SessionRuntime/Store、RunController、ToolRuntime/Scheduler、Context Projection/Compaction、Tool Visibility/Search、Progress Guard、McpManager 本地生命周期、Trace、Eval Framework。
**证据**：ARCHITECTURE 有专门的"Implemented here / Provided by dependencies"表。

### B5. 如果让你把 Session 存储换成 SQLite，你改哪里？
**答**：`SessionStore` 已经是抽象 seam（create/open/append/list/flush/close/dispose），只需实现一个新的 `SqliteSessionStore`，在 `plugins/sessions.js` 切换，SessionRuntime 与 Event Log 语义不变。
**注意两点**：1）SQLite 只应做查询/索引/指标，**权威历史仍是 append-only 事件语义**；2）SQLite 能提供更好的并发读写与事务，但"恰好一条 result"和"不盲目重试副作用"的语义不会自动成立，仍需要幂等键/对账。
---

# C. Agent Loop 与协议不变量【深挖】

### C1. 完整讲一遍一次 Run 的执行时序。
**答**（按 Step 讲）：
1. `send()` → `SessionRunCoordinator.run(sessionId)` 排队；创建 RunController、deadline、Trace、可选 progress detector；append `user/message`。
2. `beforeStep()` 检查预算/取消；组装 system prompt；对当前注册工具做 ToolCatalog 快照并选可见 schema。
3. `ContextManager.prepare()` 投影出模型消息；如果准备后仍到 hard limit → `context_overflow`，**本轮不发请求**。
4. 调 LLM 并记录 usage。没有 tool call → append `assistant/message`，按预算/完成结束；有 tool call → **先 append `assistant/tool_calls`**。
5. ToolScheduler 执行（按 index 回填结果），Loop 再**按原始调用顺序** append `tool/result`；观察 progress。
6. 决定继续下一步或停止；清空 Run 级激活状态、结束 deadline/Trace、通知 onStop。
**证据**：`agent-loop-runtime.js:62-401`。

### C2. 核心不变量是什么？为什么先落 tool_calls 再执行？
**答**：不变量是 **每条已提交的 Tool Call 最终恰好有一条匹配的 Tool Result**。
先落 `assistant/tool_calls` 再执行，是为了让崩溃恢复有依据：日志里先有"承诺"，才可能在 result 缺失时识别出"已承诺未闭环"，补 `outcome=unknown`。如果反过来先执行后记 call，崩溃时副作用可能已发生但日志完全不知情，连 unknown 都写不出来。
**代价**：存在 critical window（call 已落盘、副作用可能已发生、result 未落盘）；恢复只能标 unknown 且不重试。

### C3. 取消 / 预算耗尽 / 调度器异常 / 进程崩溃，各路径怎么闭环？
**答**：
- **正常**：调度结果按 index 回填，按原序提交真实 result。
- **取消 / 超时 / 预算**：未启动的调用写 synthetic result，`outcome=not_executed`、`skipped=true`、`retryable=false`。
- **调度器异常**：catch 里用 answered 集去重，把"已 settle 的真实结果 / 已启动但无结果的 unknown / 未启动的 synthetic"三类补齐。
- **进程崩溃**：重开 session 时找出无 result 的调用，补 `outcome=unknown, recovered=true, retryable=false`，且不重复执行。
**真正的缺口**：store 写入失败的极端情况；以及 `toolCallId` 在 session 内唯一这个前提代码没强制校验。

### C4. 为什么把工具错误做成数据，而不是抛异常？
**答**：异常逃逸会让已提交的调用没有 result，也剥夺模型自我纠正的机会。ToolRuntime 把 `unknown_tool / invalid_arguments / timeout / cancelled / execution_error` 统一归一化成 Tool Result，成功和失败走同一条记录路径，模型下一轮能看到失败原因并调整。
**边界**：不是所有基础设施故障都能变成返回值——注册错误和内部编排错误仍会抛；协作式超时也不能强杀工具。

### C5. 同一个 Session 的两个 send 会并发吗？不同 Session 呢？
**答**：同 Session **FIFO 串行**：`SessionRunCoordinator` 为每个 sessionId 维护一条 promise 尾链，前一个 settle（包括 reject）后下一个才开始，且用 `previous.catch(()=>{})` 防止失败毒化队列。不同 Session 各有一条队列，可以并发。
**边界**：只覆盖本进程，没有跨进程分布式锁。

### C6. 模型返回不存在的工具或坏参数怎么办？
**答**：`ToolRuntime` 在注册时用 Ajv 编译 validator；调用前校验参数（不做类型强转）。未知工具 → `unknown_tool`；参数不合法 → `invalid_arguments`，两者都作为 Tool Result 返回给模型，而不是中断 Run。注册本身非法则直接抛错（这是开发者错误，不是模型可恢复错误）。

### C7. 有哪些 stop reason？优先级是什么？
**答**：共 12 类：`completed`、`cancelled`、`step_limit`、`tool_call_limit`、`time_limit`、`input_token_limit`、`output_token_limit`、`cost_limit`、`tool_failure_limit`、`context_overflow`、`no_progress`、`internal_error`。
优先级：**external（取消）最高** → duration → token（input 先于 output）→ cost → tool failure → step/tool_call（按入口）。所以同时超时和超 token 会报 `time_limit`；同时 input/output 超报 `input_token_limit`。
**边界**：检查发生在执行边界，不是精确截断单次 LLM 响应。

### C8. 这个项目最大的技术难点是什么？
**答**：**让协议不变量在所有退出路径上闭合**。普通开发只会写 happy path；真正的难点是-cancel、预算停止、并行组部分完成、调度器 reject、进程 SIGKILL 这些路径都不能让"已提交的 call 没有 result"。我为此把结果统一成 `settled / not_started / unknown` 三类状态，并让恢复层只补记录、不重放副作用。
**证据**：fault-injection 11 个用例全绿，且每个用例都断言"故障真的发生了"。

---

# D. Tool Runtime 与并发【深挖】

### D1. Tool 定义有哪些字段？各自什么语义？
**答**：`name / description / parameters(JSON Schema)`；`execute(args, exec)`；可选 `output.render`；`timeoutMs`；以及四个显式声明 `readOnly`、`idempotent`、`concurrencySafe`、`sideEffect`（全部默认 `false`，`sideEffect` 默认 `true`）。
执行上下文 `exec` 带 `signal`、Session/Run/Step/ToolCall 标识与 agent。这些声明是**作者承诺**，框架不做运行时验证。

### D2. 为什么只有 concurrencySafe 能并行？readOnly / idempotent 为什么不够？
**答**：`readOnly` 只说明不写，不等于没有共享可变状态（内存缓存、文件句柄、迭代器）；`idempotent` 只说明重复执行安全，不等于并发安全（两个并发请求仍可能互相干扰）。并发安全的必要条件更严格，所以必须显式声明；默认全 false，未知工具也走独占路径（fail-closed）。
**取舍**：会漏掉一些本可并行的机会，且依赖作者如实声明。

### D3. 并行执行后怎么保证结果顺序？谁负责重排？
**答**：`ToolScheduler` 预分配 `results` 数组，每个 worker 按 `entry.index` 回填，所以**完成顺序任意、数组位置固定**；Loop 最后按原始 `toolCalls.entries()` 顺序提交 Event Log。
金句：**完成顺序 ≠ 提交顺序**。这样模型下一轮看到的 tool messages 顺序稳定、可复现。
**代价**：整体耗时会受最慢工具影响，barrier 也会阻塞后面的并行组。

### D4. Timeout 怎么实现的？为什么不能强杀？怎么改成强制超时？
**答**：`timeoutMs` 创建一个 `AbortController` + `setTimeout`，abort reason 带 `errorCode:'timeout'`，与 parent signal 用 `AbortSignal.any` 合并；执行只 await 工具 settle，不 race、不 terminate。工具若不响应 signal 就能继续跑，所以是**协作式**超时。
要强制：把工具放进 worker / 子进程，超时后 terminate 并写 timeout result。但要额外处理 stdout 丢失、副作用半完成、清理协议——所以不是简单换个 API。
**证据**：代码注释明确说 forced preemption 需要进程/worker 隔离，V2 不做。

### D5. maxParallelToolCalls 和 barrier 是怎么工作的？
**答**：`partition` 把调用切成"连续 parallel 组 + 独占 exclusive barrier"。连续 `concurrencySafe=true` 的调用进同一组，由 `maxParallelToolCalls`（默认 4）个 worker 用共享 cursor 领取；遇到非并发安全工具就 flush 当前组、把它作为 barrier 单独跑，跑完再释放后面的组。
例子：`safeA, safeB | writeC | safeD, safeE` → 并行 A、B → C 独占 → 并行 D、E；提交始终 A,B,C,D,E。

### D6. 工具调用失败会中断整个 Run 吗？
**答**：不会（按默认策略）。Tool Result 带 `isError` 与 errorCode 回到 Loop；RunController 统计 `toolFailures`，只有达到 `tool_failure_limit`（默认 3）才以 `tool_failure_limit` 停止。这样模型有机会换工具或换方案。
**注意**：取消/超时导致的失败也计入统计；这个是可配置策略。

### D7. 如果 ToolScheduler 自己抛异常怎么办？
**答**：Loop 的 catch 必须保证"已提交的调用都有结局"：保留已经 settle 的真实结果；对"已启动但没有结果"的调用写 `outcome=unknown`；对"未启动"的写 synthetic `not_executed`。然后以 `internal_error`（或相应 stop reason）结束，而不是让异常裸奔。
**竞态边界（主动交代）**：Promise.all eager reject 后，后台仍在跑的工具不会被自动 abort，Loop 可能在它 settle 前就标 unknown——unknown 是保守标签，这个时间窗口文档没展开。

### D8. 如果工具声明撒谎（声明 concurrencySafe 但实际不安全）怎么办？
**答**：框架无法在运行时证明声明，这是明确的信任边界。缓解手段：
1. 默认全 false，最危险的是"显式声明错"而不是"忘记声明"；
2. Eval 里对并行调度有独立测试（顺序、限流、取消、异常）；
3. 生产上应对高风险工具加锁 / 幂等键 / 人工审批；
4. 未来可以引入静态/运行时探针或按工具白名单审批。
**金句**：框架能保证"声明被尊重"，不能保证"声明是真实的"。
---

# E. Context 管理与压缩【深挖】

### E1. 为什么要把 Durable History 和 Model Context 分开？
**答**：长任务的完整事实必须保留，但模型窗口有限。如果直接删历史，就失去了审计和恢复能力；如果全部塞给模型，就会爆窗。
所以设计成：**Event Log 存事实，模型读的是这份日志的可重建投影**。压缩只是追加一条 `context/compaction` 记录并移动投影游标，原始事件永不删除。请求可以变小，但还能重建、审计、回退。
**金句**：Durable Event Log 是 source of truth；model messages 是 projection。

### E2. hard limit / soft limit / reservedOutputTokens 怎么算？reserved 是 max_tokens 吗？
**答**：
- `hard = maxContextTokens - reservedOutputTokens`；
- `soft = (maxContextTokens - reservedOutputTokens) * compactAtRatio`；
- 没配 `maxContextTokens` 时 pressure 直接 `disabled`，`prepare()` 也不写压缩事件。
**关键区分**：`reservedOutputTokens` 只是本地把输入预算扣小，**不会变成请求里的 `max_tokens`**（DeepSeek 适配器请求体没有 max_tokens）；模型输出预算由 RunPolicy 的 `maxOutputTokens` 基于 provider usage 单独统计。两个体系不要混。

### E3. TokenMeter 怎么估算的？`exact=false` 还敢用来做上下文决策吗？
**答**：`heuristic-v1` = system + messages + tools 的稳定序列化文本 UTF-8 字节数 ÷ 3 向上取整，`model` 参数被刻意忽略，永远 `exact=false`。
**为什么敢用**：它是 provider-neutral 的**确定性压力守卫**，不是计费来源。固定 3 bytes/token 对英文/代码可能高估，对 CJK/emoji 可能低估：低估会漏放超窗请求，高估会过早压缩/过早 overflow。
**边界**：接口留了注入真实 tokenizer 的位置；我也承认没做过与 provider tokenizer 的对照校准。**不要把 estimated input 和 provider usage 混用**。

### E4. 压缩怎么保证不切断 Tool Call / Tool Result 对？
**答**：`findProtocolSafeBoundaries` 维护一个 `openToolCalls` 集合：只有 `assistant/message` 或 `tool/result` 且 open 集合为空时，才允许作为切点。单个 call 必须等到它的 result；并行多个 call 必须全部 result。Planner 还传 `beforeSeq: latestRaw.seq`（开区间），保证最新一条原始 model-context 事件永远不会被压掉。
**前提**：未闭合的调用要先被 session 恢复补上 synthetic result，否则它之后的边界会全部被封死。

### E5. 压缩摘要到底是什么？为什么不用 LLM 总结？
**答**：`deterministic-v1` compactor 生成一条有界确定性摘要，只包含：目标摘录、上一条摘要、最近 3 条 assistant 文本、最后 8 条工具活动，并统一标注为"历史上下文"。**它是 lossy 的**，不保证保留全部语义。
**为什么不用 LLM 总结**：确定性、可复现、零额外模型调用/成本、可测试；如果引入 LLM 总结，压缩本身会变成不可复现的模型行为，且可能引入额外失败点。
**取舍**：细节会丢，且没有语义保真保证——这是明确写进文档的边界。

### E6. 压缩后仍然 hard limit 怎么办？如果压完 token 反而更大呢？
**答**：Planner 只有在候选 `afterTokens` 小于 `before` 时才接受，否则返回 `null`（宁可压不动也不放大）。如果 `prepare()` 拿到 plan 会先 append 再重新投影；Controller 若看到仍 `hard_limit`，就返回 `context_overflow`，**本轮不发 LLM 请求**。如果找不到安全边界，就不压缩、直接停。
**证据**：测试覆盖"无 safe boundary 时 LLM 0 次、stopReason=context_overflow"，以及"压缩后仍 hard 也先留下压缩事件再停"。

### E7. lineage（压缩链）怎么校验？压缩事件损坏怎么办？
**答**：Projector 会重新验证每条 compaction 的 summary、区间整数、`through` 的协议边界，并要求 `previousCompactionSeq` 必须指向"当前事件之前最近的有效压缩"，且 from 相同、through 严格递增。因此不能从更早节点 fork，伪造链路会被拒绝。
损坏的中间压缩会被跳过，投影回退到上一条有效节点或原始历史；这保证 `project()` 是纯函数、可重建。

### E8. 为什么压缩不直接删旧事件？磁盘不会一直涨吗？
**答**：不删是为了审计、恢复、可重建和回退；压缩只移动视图游标。
**代价**：磁盘不缩小，且每步投影是 O(n) 扫描。如果要优化，可以加"压缩段索引/快照"或分段落盘，但那是性能优化，不该牺牲事实源的完整性。

---

# F. Tool Discovery / Progressive Disclosure【深挖】

### F1. 三种可见性模式的区别？
**答**：
- **All（默认）**：每轮暴露全部已注册工具 schema，兼容性最好、开销最大。
- **Deterministic**：小 catalog 直接全量；大 catalog 做词法 Top-K + pinned；无命中时回退全部（兼容行为）。
- **Progressive**：基础选择（无命中时只留 pinned）+ 固定可见的 `tool_search` + 当前 Run 的激活集；命中只在下一 Step 生效。
**共同点**：都只是"给模型看哪些 schema"，不是授权。

### F2. 词法排序怎么做的？为什么不用 embedding？中文 query 会怎样？
**答**：`rankTools` 把 name、description、schema property 名切成小写 ASCII 字母/数字 token，按重叠打分排序，平局保留 catalog 顺序。**纯词法、离线、确定性、零模型调用**。
**为什么不用 embedding**：为了确定性、可测试、无网络、无额外成本；代价是跨语言、同义词、语义相似度全部缺失。
**中文**：中文没有 `[a-z0-9]` token，query token 为空直接返回 `[]`；所以正式测试里是让模型把 `tool_search` 的 query 改写成英文（如 `github issues`）。这证明的是"搜索→激活链路能工作"，**不能证明 harness 具备跨语言语义检索能力**。
**改进方向**：让模型生成 query + 混合检索（BM25/embedding）+ 可评测的 recall@K。

### F3. Top-K 是"最多 12 个 schema"的硬上限吗？
**答**：不是。几个原因：
1. 小 catalog 直接全量，根本不用 Top-K；
2. 结果 = Top-K + pinned，可以超过 `maxVisibleTools`；
3. 无正分命中时 fallback 到 all，直接全量；
4. Progressive 还要再加 `tool_search` 与激活集。
文档自己也承认它不是绝对上限。

### F4. `tool_search` 怎么工作？激活怎么隔离和清理？
**答**：它只在 Progressive 模式注册；搜索执行时**已注册**的完整 catalog（排除自己），返回紧凑的 name/description，并把命中写入当前 Run 的 activation store。激活状态是 `Map<runId, Set<name>>`，`beginRun/endRun` 都清空当前 runId；`select` 每轮用当前 catalog 过滤激活集，所以已注销的工具不会继续暴露。
**边界**：stale 名字仍占 `maxActivatedTools` 容量直到 Run 结束；没有按注销即时清理的 API。

### F5. "可见性 ≠ 授权"具体危险在哪？
**答**：LLM 请求只包含 `view(visibleNames).schemas()`，但执行走完整 `tools.execute(call.name, ...)`，**只按注册表查名字，不检查可见性**。测试直接证明：只暴露 tool-a，工具内部调用不可见的 tool-b 仍然成功。
所以任何已注册工具（包括已连接的 MCP 工具）都能被模型按名调用。要做访问控制，必须在 ToolRuntime / policy / approval 层实现。当前项目把它定位为 schema 成本优化，不是安全边界。

### F6. Progressive 的收益和代价？为什么累计输入反而比 Top-K 高？
**答**：收益是**每请求 schema 开销大幅下降**：All 9,268 → Progressive 199.6 schema token/请求；可见工具 19 → 1.93。
代价是**多了一次 `tool_search` 请求**：该 suite 里 Progressive 总请求数 15、Deterministic 10，所以整 Run 的累计估算输入 Progressive（1,016.2）反而高于 Deterministic（786.8）。
**结论**：这不是"无脑更优"，而是一个可测量的 trade-off——它适合工具极多、单轮 schema 成本占主导的场景；如果工具不多，Deterministic 可能更划算。
**这句话很加分**：主动讲出自己优化的代价，而不是只报好数字。
---

# G. 可靠性 / 崩溃恢复 / Exactly-once【深挖】

### G1. 为什么用 Event Log 作为唯一事实源？
**答**：最终答案或内存里的 messages 无法区分"意图、执行结果、未知结果"。append-only Event Log 把 `session/start`、`user/message`、`assistant/message`、`assistant/tool_calls`、`tool/result`、`context/compaction`、`session/reset` 都记为事实，一份历史同时支撑审计、投影和恢复。
**不变量**：每条 committed Tool Call 最终恰好一条匹配 Tool Result。

### G2. JSONL 的写入和恢复是怎么做的？
**答**：`SessionRuntime` 按 session 序列化 append，**只有 Store 写成功后才更新内存事件数组**；`JsonlSessionStore` 校验 sessionId 与 seq，用队列串行写，append 直接 `writeFile(...,{flag:'a'})`，`flush()/close()/dispose()` 才做 `sync()`。恢复时按字节偏移读取、校验 seq 连续，只允许截断"最后一行解析失败且前面有合法事件"的 torn tail。
**边界**：不每事件 fsync，也无线程/进程锁，所以"durable"只到进程崩溃级，不等于掉电持久化或多进程一致性。

### G3. 为什么只截断最后一行？中间损坏为什么不跳过？
**答**：只有文件尾部可能是"写到一半"的 torn tail，截断后前缀仍保持 seq 连续。中间损坏无法区分是丢字节、乱序还是外部篡改；如果静默跳过，seq 校验就失去意义，可能掩盖协议不一致，所以直接抛 `SessionCorruptionError`。
第一行就坏（此前没有合法事件）也不截断，因为无法区分空文件与完全损坏——选择 fail 而不是猜。

### G4. `not_executed / unknown / retryable` 分别什么语义？
**答**：
- `not_executed`：调用**确定没开始执行**（取消/预算/准入拒绝），`skipped=true`、`retryable=false`。
- `unknown`：调用**可能已经开始但结果未落盘**（调度器异常时已启动、或进程崩溃重开），`recovered=true`、`retryable=false`。
- `retryable=false` 是刻意的：在副作用不确定时，默认不重试。
**金句**：缺一条 result 不等于"没执行过"，所以不能盲重试。

### G5. "exactly one result" 等于 exactly-once 副作用吗？多进程/掉电怎么办？
**答**：**不等价**。日志层保证的是"记录层恰好一条 result"；外部副作用可能发生 0 次、1 次或未知次。
崩溃窗口：call 已持久化 → 副作用可能已发生 → result 未持久化 → 重开只能写 `unknown`。
掉电：append 不是每事件 fsync，测试用 SIGKILL 而非断电，所以不能宣称掉电持久化。
多进程：没有文件锁，coordinator 和 store queue 都只是进程内。
所以项目明确**不承诺分布式 exactly-once**。

### G6. "副作用不确定时不盲目重试"的取舍是什么？
**答**：好处是不会因为"看起来能自动恢复"而重复写文件、重复调用付费 API、重复发消息。代价是调用方可能需要人肉对账或外部幂等键；系统把不确定性显式暴露出来（unknown + retryable=false），而不是假装成功。
**这是设计选择，不是能力缺失**：对支付、写文件这类副作用，宁可不自动恢复，也不能重复执行。

### G7. 如果要求 exactly-once，你会怎么设计？
**答**：至少需要三件事：
1. **幂等键**：给每次工具调用一个业务可识别的 idempotency key，外部系统按 key 去重；
2. **两阶段 / 对账**：执行前记录 intent，执行后记录 result；崩溃后用 key 去外部系统查询真实状态，而不是盲目重放；
3. **存储层保证**：跨进程锁或单写者、事务/日志先写（WAL）、必要的 fsync 策略。
框架层能做的是"记录 + 暴露状态"，真正的 exactly-once 必须由副作用持有方配合。

---

# H. Progress Guard【深挖】

### H1. 为什么需要 Progress Guard？
**答**：Agent 常见的失效模式是"重复做同一件无效的事"：换了个参数但结果一模一样，token 一直烧、任务不推进。仅检测"完全相同的连续调用"不够，所以我在 Run 级做更宽的确定性启发式：识别"连续重复/低信息量"的 Step，先温和提醒，再决定是否停。
默认 `off`，可配 `remind` 或 `guarded`。

### H2. 具体算法是什么？
**答**：四要素：
1. **normalized call**：对 tool name + args 做规范化（对象 key 排序、去掉 volatile 字段、CRLF/trim 统一）。
2. **result category**：把结果分成成功/失败/空等类别。
3. **fingerprint**：对规范化后的 call 与结果做 sha256；结果里若回显了入参，会删掉与 args 同名的同值字段，避免"参数不同但只是回显不同"被误判为新信息。
4. **novelty**：第一次见到的低信息结果算 neutral 并清零 streak；只有**连续重复**才累积 no-progress streak。
**装配**：`remind` 在软阈值注入一次针对当前 streak 的策略提醒；`guarded` 在硬阈值请求 `no_progress` 停止；检测自身异常 fail-open。

### H3. 阈值到底怎么数？（很容易讲错）
**答**：soft/hard 数的是**连续重复的 Step**，且第一次低信息结果是 neutral 并清零 streak。默认 soft=3、hard=6 的实际效果是：**第 4 次相同失败提醒、第 7 次 stop**。
另外"one-shot reminder"是 **per streak one-shot**，不是整个 Run 只提醒一次——progress/neutral 会重置，之后可能再次提醒。
**面试建议**：主动说清这个 off-by-one，面试官会觉得你真的读过代码。

### H4. 为什么 fail-open？它有哪些局限？
**答**：Progress Guard 是启发式，不是语义判断。**宁可漏报，不可误报**：如果把探索性重试误判成 no_progress 而停掉，代价比多跑几步大得多。所以检测失败 open、中性 step 清零 streak。
**局限**：看不懂 workspace diff、goal delta、语义等价（`grep Agent` / `grep agent` 在它看来是不同的 call）；也没有 LLM judge。
**改进方向**：纳入 diff/新信息/目标状态 delta，并用 Eval 量化误杀率和收益。

---

# I. MCP 生命周期【深挖】

### I1. MCP 在你的架构里怎么接的？哪些是你实现的？
**答**：
```
McpManager（本仓库：本地插件实例生命周期）
  → @deepseek-ai/dsh-mcp-client（官方：协议/transport/远端重连/工具发现与同步）
  → MCP Server
```
我实现的是 `McpManager`：connect / disconnect / reload / dispose 的本地生命周期、状态机、串行化与清理；协议、网络、远端重连、远端工具发现都用官方 client。工具通过 `ctx.tools.register()` 注册进 ToolRuntime，Loop 不感知 MCP。
**边界**：不宣称"从零实现 MCP 协议"。

### I2. 状态机有哪些状态？为什么 `ACTIVE` 不等于远端健康？
**答**：`DISCONNECTED / CONNECTING / ACTIVE / FAILED` 描述的是**本地 plugin fiber**。`ACTIVE` 只在本地 activate 成功后设置，没有 ping/heartbeat/远端 enumerate；对已 ACTIVE 的 connect 直接返回 snapshot，不探测远端。
所以远端故障的表现是"工具调用失败并作为 Tool Result 回到 Loop"，而不是状态变 FAILED。把 lifecycle 与 remote health 分层，避免一个本地状态误导恢复策略。

### I3. connect/disconnect/reload 的并发和失败清理怎么处理？
**答**：每个 server 一条 per-record Promise 尾链，前一个操作失败用 `catch(()=>{})` 吞掉再跑下一个，所以失败不毒化队列；同一 server FIFO，不同 server 并发独立。
- activation 失败：state=FAILED、fiber=null、保存 lastError，桥层负责 dispose 半成品 Fiber。
- disconnect 失败：**保留 fiber**、state=FAILED，下一次可重试。
- reload：先清理旧实例，清理失败就不会启动新 fiber。
**证据**：MCP failure suite 9/9。

### I4. dispose 的语义是什么？
**答**：用 `Promise.allSettled` 对所有 server 都尝试清理；只要有一个失败，就抛出该原因、**保留 records 且不置 disposed**，因此可以再次调用重试。这样不会因为一个坏 server 导致其他 server 清理被跳过。

### I5. `tool_search` 为什么不顺手连接休眠的 MCP server？
**答**：因为搜索会从"本地只读发现"变成"可能阻塞/失败/产生远端副作用的网络操作"，破坏"先本地发现、再显式连接"的边界；而且未连接的工具根本不在 catalog 里。
**代价**：Progressive 不能发现"配置了但没连接"的 MCP 能力，必须有人或策略先 connect。未来可以做 Lazy MCP（保留 server metadata，需要时才连接），但要先把生命周期和失败语义设计清楚。
---

# J. 评测与数据【深挖】

### J1. 为什么自己搭 Eval 框架？为什么用 Mock LLM？
**答**：因为要验证的是 **Harness 行为**，不是模型能力。用 Mock LLM 才能做到：完全确定、可复现、离线、能精确构造故障（超时、取消、非法调用、context overflow、scheduler failure）、不受模型随机性干扰。7 个 suite 覆盖 tool routing / progress / context pressure / long-horizon / fault injection / crash recovery / MCP failure。
**边界**：这证明的是"在指定条件下 Harness 的行为符合设计"，不是"真实模型任务成功率"。

### J2. README 里的数字可信吗？你核实过吗？
**答**：核实过，README Evaluation 表格的所有数值都能在 `.eval/*.json` 找到一致结果：
- Tool Routing：19 / 5 / 1.93 可见工具；9,268 / 336 / 199.6 schema token/请求；18,650.8 / 786.8 / 1,016.2 累计估算输入/run。
- Context Pressure：full 5,697 / 20,884；constrained 1,234 / 2,593；compacted 1,578 / 9,040；compaction 17 次。
- Long-Horizon：25 → 9 可见工具；194,553 → 98,657 累计估算输入；两 variant 各 5/5。
- Reliability：fault-injection 11/11、crash-recovery 5/5、mcp-failure 9/9。
**但必须同时说边界**：全部是 Mock LLM synthetic；provider tokens/cost 全为 unavailable；`managed` 是组合变体，不能单因素归因；MCP failure 用的是本地 fake plugin。

### J3. 72% 和 57% 分别怎么算的？
**答**：都来自 `.eval/context-pressure.json`：
- 峰值：`(5,697 − 1,578) / 5,697 = 72.30%`；
- 累计：`(20,884.33 − 9,039.67) / 20,884.33 = 56.72%`。
**注意**：constrained 模式不参与这两个降幅，它是"有限窗口但不压缩"的溢出基线；compacted 才是开启压缩的对比组。

### J4. Progressive 的 schema 开销降了 98%，那它一定更好吗？
**答**：不一定。它每请求 schema 从 9,268 降到 199.6，但**多了一次 `tool_search` 请求**（该 suite 总请求 15 vs Deterministic 10），所以整 Run 累计估算输入 Progressive（1,016.2）反而高于 Deterministic（786.8）。
**结论**：适合工具极多、单轮 schema 成本主导的场景；工具不多时 Deterministic 更划算。这是一个可测量的 trade-off，不能只报单指标。

### J5. Long-Horizon 里 managed 的收益能归因给 Progress Guard 吗？
**答**：不能。`managed` 同时开启 routing + progress + compaction，是组合变体；报告显示 5 个 case 里 `reminderCount=0`、`progressStops=0`，**Progress Guard 实际没触发**；compaction 只在 `large-context-fix` 触发 2 次。所以收益主要来自确定性 visibility（以及那个 case 的 compaction），不能单因素归因。
**这句话很关键**：主动承认评测设计的归因限制，而不是把功劳都算给自己。

### J6. Context Pressure 里 constrained 的 success=true，是完成任务了吗？
**答**：不是。`success` 只表示"命中了预期 stop reason"；constrained 的预期就是 `context_overflow`，它的 `finishSucceeded=false`。这正是"**提前终止不是优化成功**"的体现。compacted 才是"能完成任务同时降低峰值"。

### J7. 你们的 Scorer 怎么防止"假阳性"？
**答**：Scorer 不只看最终文件或最后一条消息，而是绑定证据链：
- 长程编码：断言"初始测试确实失败 + 最终测试确实通过 + 目标文件有 diff + 必需的 read/edit 发生过 + 没有多余文件 + Tool 协议闭合"；
- 故障注入：断言"故障真的被触发过"，而不是只看最终 stop reason；
- 崩溃恢复：真实 SIGKILL + JSONL 重开，断言副作用只发生一次、恢复后 `sideEffectExecutionCountAfterResume=0`、unknown 标记 `retryable=false`、seq 连续；
- context：断言压缩后目标/摘要安全、协议边界不被破坏、durable event 不变。
**设计理念**：Scorer 本身也要被"打破证据"的测试验证，防止"测试通过测试"。

### J8. 你有真实模型的数据吗？Coding Benchmark 是什么状态？
**答**：诚实说：**目前没有可引用的真实模型报告**。
- 有一个 `coding-smoke` 基础设施 smoke case，用来验证真实 provider 接线、隔离重复、成本保护和报告；
- 已经实现并提交了 **Coding Benchmark V1：16 个本地可复现 case**（4 个单文件 bugfix、4 个跨文件 bugfix、4 个 feature、4 个仓库理解/重构/长上下文任务），带 baseline/reference/public tests/hidden verifiers/workspace policy，可以不联网验证；
- 但**仓库里没有真实模型跑出来的报告**，所以不能做模型排名或成功率结论。
**为什么不自称 benchmark 结论**：16 个 case 规模有限、任务分布偏本地、成本未测量（`cost=null` 表示 unknown 不是 0），报告是"可复现工件"，不是 leaderboard。

### J9. 如果让你把它做成可信的真实模型评测，你会补什么？
**答**：
1. 固定模型版本与解码参数，跑多次取分布（报均值和方差，而不是单次成功）；
2. 分离"模型能力"与"Harness 策略"：对 minimal / full 做对照，但避免把组合变体当单因素；
3. 接入真实 token usage 与 pricing，报真实成本；`cost=null` 不能当 0；
4. 增加任务规模与多样性，引入隐藏测试防过拟合；
5. 预注册指标（成功率、步数、工具调用、成本、时长、协议违规率）与失败分类；
6. 用人工或更强模型做交叉复核，报告置信区间。

---

# K. Sandbox / 安全【深挖】

### K1. 你的沙箱是怎么做的？它是安全边界吗？
**答**：**不是安全边界**，是应用层 policy gate。分三层：
1. **路径 gate**：内置文件工具的唯一入口做 `resolveInside`（词法 + realpath 二次包含性检查），这是最强的一层；
2. **命令策略**：对 bash 工具的命令做形态/denylist 检查，并做 workspace 路径与网络 host 的 allowlist；
3. **人工审批**：bash / write_file / edit_file 触发 `[Y/n]`，这才是真正的权限边界。
**关键限制**：解释器（`python3 -c`、`node -e`）、管道（`base64 | sh`）、系统二进制（`/usr/bin/curl`）都可能绕过命令启发式；它没有 seccomp/container 隔离，也不能约束远程 MCP 工具。

### K2. `[Y/n]` 在哪里触发？会被绕过吗？
**答**：在 CLI 的 `askApproval` 里触发，由 bash / write_file / edit_file 调用。但存在 `MINI_DSH_AUTO_APPROVE=1` / `config.autoApprove` 旁路——**这个旁路没有写进 README 和 .env.example**，是我主动要交代的点。生产部署应把审批作为真正的权限控制，并配合 OS 级隔离。

### K3. 命令策略是 denylist 吗？
**答**：简化说不准确。它同时包含：workspace 路径 allowlist、网络 host allowlist（硬编码默认值，插件没有透传 `allowHosts`）、以及命令形态 denylist。说"应用层 policy gate"更准确；denylist 只能提高事故成本，不能证明安全。

### K4. 如果要在生产环境跑不可信代码 / 不可信 MCP，你会怎么做？
**答**：
1. **OS/容器隔离**：容器、只读文件系统、最小权限用户、seccomp/AppArmor、网络 egress 白名单；
2. **凭据隔离**：短期凭证、按工具最小授权，绝不让模型直接持有高权限 token；
3. **工具级授权**：把"可见性"和"授权"分开，ToolRuntime 执行前做策略检查，而不是只靠 schema 隐藏；
4. **对副作用加幂等键与审批**；
5. **MCP 不可信**：视为外部服务，做超时/熔断/输出校验与人工确认，不能因为 ACTIVE 就信任。
---

# L. Agent 通用知识题【通识】

### L1. 讲一下 ReAct / function calling 的原理，你的循环和它什么关系？
**答**：ReAct = Reasoning + Acting 交替：模型先产生 thought，再产生 action（工具调用），环境返回 observation，模型基于 observation 继续推理，直到给出最终答案。Function calling / tool use 是把 action 结构化成可校验的 JSON schema。
我的 Agent Loop 就是 ReAct 范式的一个工程化实现：每 Step 调一次 LLM，有 tool call 就执行并把结果作为 observation 回灌，没有就结束。区别在于我把重点放在**循环之外的可靠性**：协议不变量、持久化、并发顺序、预算停止、上下文压缩与评测。

### L2. 怎么防止 Agent 无限循环 / 失控执行？
**答**：多层防护：
1. **RunController 硬预算**：max steps、max tool calls、max duration、token、cost、tool failures；
2. **Progress Guard**：检测连续重复/低信息执行，先提醒再停（no_progress）；
3. **工具准入**：并行只给 concurrencySafe，非只读工具需人工审批；
4. **超时与取消**：AbortSignal 协作式取消；
5. **可观测**：Trace 记录每步 stop reason，便于归因。
**金句**：预算管"最多做多少"，Progress Guard 管"有没有必要继续做"。

### L3. 上下文压缩有哪些常见方案？你怎么选？
**答**：常见有：
- **截断/滑动窗口**：简单，但会丢关键早期信息；
- **摘要压缩**（LLM summarization）：保留语义好，但不可复现、有额外成本与失败点；
- **结构化/分层记忆**：把长期信息外置到检索或数据库，按需召回；
- **KV cache / 前缀复用**：推理层优化，不改变 prompt 语义。
我选的是**确定性摘要 + 协议安全边界 + append-only 视图游标**：可复现、可测试、可回退，代价是 lossy。
**进阶回答**：更好的方案是分层——短期原始对话 + 长期结构化记忆 + 按需检索，而不是只在 prompt 里做压缩。

### L4. 多 Agent 协作你了解吗？你的项目往这个方向怎么演进？
**答**：多 Agent 的核心问题是**通信、上下文隔离、任务分解、冲突解决、成本控制**。我的架构已经具备演进基础：SessionRunCoordinator 可扩展为按 session 队列，Session Store 可做共享事实源，Tool Runtime 可把"派生子 Agent"建模成一个工具（sub-agent as tool），Trace 可跨 Run 关联。
**注意**：我没有实现多 Agent，不要不懂装懂；我会先想清楚"什么时候需要多 Agent"——当任务可并行、需要角色隔离或上下文太大时，而不是为了架构好看。

### L5. RAG 和 Agent memory 的区别？你的 Session 算 memory 吗？
**答**：RAG 通常是"外部知识检索 → 拼进 prompt"，是无状态、只读的知识增强；Agent memory 是"跨时间保留交互与状态"，包含工作记忆、情景记忆、语义记忆，既要读写也要治理。
我的 Session Event Log 更接近**情景记忆 + 审计日志**：记录发生过的事实，投影成模型上下文；它不是向量检索式语义记忆。
**如果要加语义记忆**：可以在 Event Log 之外建索引，把"可检索的记忆"作为派生数据，权威事实仍在日志里——保持"权威 vs 派生"的分离。

### L6. 工具特别多（几百个）时，除了渐进式披露还有什么办法？
**答**：
1. **命名空间 / 层级工具**：先选工具域，再选具体工具；
2. **检索式路由**：BM25 / embedding / 混合检索，按 query 选 Top-K（我的词法版就是简化版）；
3. **工具组合/宏**：把常用序列封装成高层工具，减少选择面；
4. **工具描述工程**：清晰的 when-to-use、反例、参数约束；
5. **运行时动态注册**：按需加载（如 Lazy MCP）；
6. **分层授权**：可见 ≠ 可用，高风险工具需要显式授权。
**取舍**：检索本身有成本；工具越多，选择错误率越高，所以"少而准"往往优于"全而杂"。

### L7. 怎么提升工具调用的准确率？
**答**：
1. **Schema 质量**：描述具体、给示例、明确边界与反例；
2. **参数校验**：严格 schema + 不做隐式类型转换，错误作为 observation 回灌让模型纠正；
3. **工具选择**：Top-K 路由 / 渐进式披露，减少干扰项；
4. **反馈闭环**：把 `unknown_tool` / `invalid_arguments` / `execution_error` 明确返回，让模型自我修复；
5. **Few-shot / 微调**：针对高频工具补充示例或做 SFT；
6. **可观测与评测**：统计目标工具命中率、参数错误率，用 eval 回归。

### L8. 如果让你从零评测一个 Agent，你会怎么设计？
**答**：分四层：
1. **任务层**：真实任务集 + 隐藏测试，防过拟合；报成功率（多次运行取分布）；
2. **轨迹层**：步数、工具调用数、错误率、协议违规、停止原因分布；
3. **资源层**：真实 token、真实成本、时长；
4. **可靠性层**：故障注入、崩溃恢复、幂等/重复副作用、超时取消。
**关键原则**：区分"模型能力"与"Harness 效果"；区分"合成可控评测"与"真实模型评测"；报边界和置信区间，不做单一数字排名。

### L9. Agent 上线到生产要考虑什么？
**答**：
1. **安全**：OS 级隔离、最小权限、凭据隔离、审批与审计；
2. **可靠性**：超时/重试/幂等/对账、崩溃恢复、限流熔断；
3. **成本**：token/工具调用预算、缓存、模型分级路由；
4. **可观测**：Trace、指标、日志、回放；
5. **评测与回归**：CI 里跑确定性 eval，线上做 canary 与 A/B；
6. **数据与合规**：脱敏、留存策略、用户授权。

### L10. 你了解哪些 Agent 框架 / 工作？
**答**：LangChain / LlamaIndex（编排与工具生态）、AutoGPT/BabyAGI（早期自治循环）、ReAct、Reflexion、Plan-and-Execute、Toolformer、MCP（工具/资源协议）、DeepSeek Harness（我参考的分层设计）。
**回答策略**：不要背名词，挑 1-2 个说清"它解决什么问题、有什么局限、和我的项目怎么互补"。

---

# M. 压力题与反问

### M1. 这个项目是不是 AI 生成的？
**答**（不要辩解，展示掌控力）：
"代码是我按 Phase 逐个 commit 演进出来的，`git log` 能看到每个模块独立实现。有没有用 AI 辅助？有，我把它当加速器，但设计决策、不变量定义、故障路径和评测都是我自己推敲的。您可以随便挑一个文件，我现场讲关键行和踩过的坑。"
**准备动作**：熟练打开 2-3 个核心文件（`agent-loop-runtime.js` 的 result 补全、`tool-scheduler.js` 的 partition、`context-projector.js` 的边界校验），能逐行解释。

### M2. 你不就是用了现成框架吗？
**答**：我明确区分依赖与自研：Cordis 提供插件容器，官方 MCP client 提供协议与传输，Ajv 提供 schema 校验——这些我不重复造轮子。但 **Agent Loop、RunController、ToolRuntime/Scheduler、Context 投影与压缩、Visibility/Search、Progress Guard、Eval 框架都在本仓库实现**，README 和 ARCHITECTURE 都有边界表。
**加分**：主动说"造轮子不是目的，把力气花在真正需要掌控的运行时语义上"。

### M3. 这些机制大厂都做了，你的创新点是什么？
**答**：我从不宣称持久化/压缩/并行工具是我原创——它们是成熟 Harness 的通用设计，我做的是简化版实现。我的**个人重点**是：
1. **Progressive Tool Disclosure** 的可测量 trade-off（schema 降 98% 但多一次搜索请求）；
2. **RunController 的停止语义**与 12 类 stop reason 的优先级；
3. **确定性 Progress Guard** 的 fingerprint/novelty 与阈值语义；
4. **可靠的评测方法论**：防假阳性 Scorer、故障注入、崩溃恢复。
**金句**：创新不一定是机制首创，也可以是"把语义定义清楚并用证据证明"。

### M4. 没有真实模型数据，这个项目的价值在哪？
**答**：它的价值是**可复现地验证 Harness 行为**，而不是证明模型强弱。真实模型评测有随机性、成本高、难以构造故障；合成评测能精确控制条件，证明"在 context overflow / 工具超时 / 崩溃 / MCP 失败时系统行为正确"。
我也把真实 benchmark 的基础设施做好了（16 个 case + provider 接线），只是**没有真实报告就不下结论**——这本身就是工程诚实的一部分。

### M5. 你的项目有什么已知缺陷 / 没做好的地方？
**答**（主动、具体、给方案）：
1. **TokenMeter 是 3 bytes/token 估算**，没和真实 tokenizer 校准；
2. **unknown cost 是 fail-open**：一次缺 cost 会让该 Run 成本报告不可用、cost 上限不触发；
3. **JSONL 不 fsync 每事件、无跨进程锁**，只保证进程崩溃级恢复；
4. **调度器异常存在竞态窗口**：后台工具可能在被标 unknown 后才 settle；
5. **词法路由不支持中文/语义**，依赖模型把 query 改写成英文；
6. **Sandbox 命令策略可被解释器/管道/系统二进制绕过**，不是安全边界；
7. **latent bug**：`JsonlSessionStore.append` 在 store 未 create/open 时会自等待死锁（生产路径不触发，但接口级隐患）。
**态度**：能自己指出缺陷，比被面试官问出来强得多。

### M6. 你还有什么问题问我们？（反问清单，挑 2-3 个）
- 团队现在的 Agent 主要用于什么场景？最大的瓶颈是模型能力还是 Harness 工程？
- Agent 的评测体系是怎么做的？有没有真实任务集和线上指标？
- 工具生态是怎么治理的——自研工具、MCP、还是内部平台？怎么做权限隔离？
- 长会话/长任务的上下文策略是自研还是用现成方案？
- 团队怎么看待 Agent 的可靠性与副作用幂等？有没有对账机制？
- 如果我入职，前三个月最希望我解决什么问题？

---

## 附：答题节奏建议

| 场景 | 时长 | 内容 |
|---|---|---|
| 自我介绍 | 60s | 定位 + 核心不变量 + 一个数字 + 一个个人亮点 |
| 项目深挖 | 5-10min | 先讲问题与不变量，再按面试官兴趣展开某个模块 |
| 系统设计 | 15-30min | 先问清需求与约束，再画分层，最后讲失败路径与权衡 |
| 行为面 | 5min | STAR + 反思 + 主动暴露一个缺陷 |
| 反问 | 5min | 问团队瓶颈、评测体系、工具治理 |
