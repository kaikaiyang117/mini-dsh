# mini-dsh 运行时事实清单（task-1）

> 分析基线：工作区当前文件，`git rev-parse --short HEAD` = `cab52c8`（2026-09-23），工作区存在未提交改动（benchmark 相关）。所有结论均以源码为准；文档措辞单独标注。
> 验证方式：通读 task-1 指定的 13 个源码文件；对关键路径运行 `test/run-controller`、`test/run-governance`、`test/parallel-tool-scheduler`、`test/session-persistence`、`test/semantic-progress-detector`、`test/tool-runtime-v2`、`test/trace`、`test/fault-injection-eval`、`test/crash-recovery-eval`、`test/session-run-coordinator`、`test/progress-config`、`test/semantic-progress-integration` 等测试（80 + 31 项通过，除下文单独指出的隐藏缺陷外）。
> 阅读提示：本文中 `src/...:Lx` 表示文件第 x 行；"未验证"表示仅静态阅读、未通过实验确认。

## 0. 一页速览（先看这 10 条）

1. Run 的五层结构：CLI → `AgentRuntime` → `AgentLoopRuntime` → `SessionRunCoordinator`（按 session FIFO）→ 单次 `#runOnce`。`agent-runtime.js:31-45`、`agent-loop-runtime.js:58-60`、`session-run-coordinator.js:11-27`。
2. 每个 Run 有独立的 RunController、deadline、trace、progress detector；Session 事件日志是唯一持久事实。`agent-loop-runtime.js:62-87`。
3. 一次循环 = Step：`beforeStep` → system prompt + tool 可见性 → ContextManager.prepare → LLM → (无 tool call: assistant/message 结束) / (有 tool call: 先 append assistant/tool_calls，再调度执行，最后按原始顺序 append tool/result)。`agent-loop-runtime.js:100-401`。
4. Tool 协议不变量：只要 `assistant/tool_calls` 已落日志，正常、取消、预算停止、调度器异常都会补齐 `tool/result`；进程崩溃后由 `SessionRuntime.open` 补 `outcome=unknown, recovered=true`。`agent-loop-runtime.js:206-212,293-333,335-371,444-477`、`session-runtime.js:133-164`。
5. ToolRuntime 固定 5 类 errorCode：`unknown_tool` / `invalid_arguments` / `timeout` / `cancelled` / `execution_error`。`tool-runtime.js:12-18`。
6. Timeout/cancel 是协作式的：只 abort `AbortSignal` 并等待 `execute()` settle，不强制杀进程；工具若不看 signal 可以一直跑。`tool-runtime.js:40-42,143-186,270-293`。
7. ToolScheduler 只在 `concurrencySafe === true` 时并行；其他工具形成独占 barrier；并行组内并发上限 `maxParallelToolCalls`（默认 4）。`tool-scheduler.js:16-38,54-71`。
8. "完成顺序 ≠ 提交顺序"：scheduler 按 index 回填结果，Loop 再按原始 toolCalls 顺序提交到 Event Log。`tool-scheduler.js:40-52,73-82`、`agent-loop-runtime.js:339-371`。
9. RunController 的所有 stop reason 都是"在执行边界检查"；token 预算基于 provider usage 的累计值；成本未知时 `snapshot().cost = null`，且 maxCost 不生效（fail-open）。`run-controller.js:1-14,80-96,144-155,193-203`。
10. ProgressGuard 默认 `off`；`remind` 只给一次提醒，`guarded` 可 stop（`no_progress`）。检测失败 fail-open。`progress-config.js:3-42`、`agent-loop-runtime.js:82-87,121-126,377-388`。

---

## 1. 一次 Run 的完整时序

### 1.1 入口与排队

- CLI 收到非命令输入后，创建 `AbortController`，调用 `agent.send(text, { signal, onReasoning, onContent, onToolCall, onToolResult })`。`src/plugins/cli.js:225-278`。
- `AgentRuntime.create` 生成的 agent 是薄句柄：`send(input, options) → loop.run(agent,input,options)`。`src/core/agent-runtime.js:31-45`。
- 插件层 `AgentLoopService.run` 直接转发给 `AgentLoopRuntime.run`。`src/plugins/agent-loop.js:31-33`。
- `AgentLoopRuntime.run` 用 `SessionRunCoordinator.run(agent.sessionId, …)` 把同一个 session 的 Run 串成 FIFO；不同 session 可并发。`src/core/agent-loop-runtime.js:58-60`、`session-run-coordinator.js:11-27`。
  - 注意：这个协调器只是**进程内 Promise 队列**，代码注释明确不提供跨进程分布式锁。`session-run-coordinator.js:1-7`。

### 1.2 单次 Run 的准备阶段

`#runOnce`（`agent-loop-runtime.js:62-88`）：

1. 从 options 解构 `signal`、流式回调、`policy`、`now`、`onStop`。`62-75`。
2. 创建 `RunController`：`this.controllerFactory({policy, now})`。`77`。
3. 创建 deadline：`createRunDeadline(controller.policy.maxDurationMs)`，并用 `combineAbortSignals` 把外部 signal 与 deadline signal 合并成 `combinedSignal`。`78-79`、`run-deadline.js:1-22`。
4. 创建 trace：`this.trace?.startRun({sessionId, model})`；`runId = runTrace.runId ?? randomUUID()`。`80-81`。
5. 尝试创建 progress detector：工厂抛错则吞掉，`progressDetector` 保持 undefined（fail-open）。`82-87`。
6. 初始化 `stopReason='internal_error'`、`lastContent=''`。`88-89`。

随后的外框：

- `toolVisibility.beginRun` 失败只忽略。`91-96`。
- **append `user/message`**：`await this.sessions.append(sessionId,'user/message',{content: input, runId})`。`97`。
- 进入 `while(true)` 的 Step 循环。`100`。

### 1.3 每个 Step 的时序

以 `100-401` 为骨架：

1. **Step 准入**：`controller.beforeStep(combinedSignal)`；若 stop，则 `#finishDecision` 并结束。`101-110`。`step` 取自 decision.state.steps（`beforeStep` 内部已 +1）。`112`。
2. 开始 step trace：`runTrace?.startStep()`，`stepId`。`113-114`。
3. **组装 system prompt**：`systemPrompt.assemble({agent,sessionId,step})`。`116-120`。
4. **注入 progress reminder**（如果上一 step 产生且未消费）：`progressDetector.takeReminder()`，`appendProgressReminder(system, reminder)`。`121-126,519-521`。
5. **工具目录快照与可见性选择**：`toolCatalog.snapshot()` → `toolVisibility.select({catalog, agent, sessionId, runId, stepId, step, input})` → `catalogSnapshot.view(visibleNames).schemas()`。`127-137`。
6. **Context 准备**：`contextManager.prepare(sessionId, { ..., system, tools: toolSchemas })`。`138-146`。
7. **Context 压力决策**：`controller.recordContextPressure(preparedContext.metadata.pressure, combinedSignal)`；若 `hard_limit` → stop `context_overflow`，不发 LLM。`147-159`。
8. **LLM 调用**：`stepTrace.startLlm()`；`llm.chat({system,messages,tools,signal:combinedSignal,onReasoning,onContent}, agent.model)`。`163-175`。`finally` 中计算 usage 并 `stepTrace.finishLlm(usage)`。`176-179`。
9. **Usage 记录**：`#estimateUsage(response?.usage, agent.model)` → `controller.recordLlmUsage(usage, combinedSignal)`；取 `toolCalls = response.toolCalls ?? []`；更新 `lastContent`。`181-184`。
10. **无 tool call 分支**：append `assistant/message`（含 content/runId/stepId）。`186-192`。若 `usageDecision.action==='stop'` → `#finishDecision`；否则 `stopReason='completed'`，返回 content。`193-203`。
11. **有 tool call 分支**：**先** append `assistant/tool_calls`（含 content、reasoningContent、toolCalls、runId、stepId）。`206-212`。
12. **批次取消控制**：创建 `batchController`；`toolSignal = combineAbortSignals(combinedSignal,batchController.signal)`。`214-215`。
    - `turnDecision` 记录本批次最终 stop decision；`stopAdmission` 只在无 decision，或新 decision 是 `cancelled`/`time_limit` 时覆盖，保证取消/超时优先。`216-225`。
    - `stopBatch(decision)` 先登记 decision，再 `batchController.abort({stopReason: turnDecision.stopReason})`。`226-231`。
    - 如果 usage 已触发 stop，立即 stopBatch（此时 toolSignal 已 aborted，后续 call 进入 `not_started`）。`233`。
13. **调度执行**：`scheduler.execute(toolCalls,{signal:toolSignal, run})`。`239-292`。
    - run 回调每次只处理一个 call，先检查 `combinedSignal.aborted`（返回 not_started）或已有 `turnDecision`（返回 not_started）；否则 `controller.beforeToolCall` 做工具调用预算准入，stop 时按 `tool_call_limit` 与其它 stop 区分处理。`242-259`。
    - 准入通过后：`startedToolCalls.add(call.id)` → trace → observer → `tools.execute(...)`。`261-271`。
    - 结果落 `recordToolResult`（如果本批次还没有 turnDecision），然后构造 `{state:'settled', result, renderedContent}` 存入 `settledToolRecords`。`274-290`。
14. **调度器异常兜底**：若 `scheduler.execute` 抛错，catch 中扫描当前 run/step 已落盘的 `tool/result` 得到 `answered` 集合；对每个 committed call：已落盘 → skip；有 settled record → 补写真实结果；已 started 但无结果 → `#appendUnknownToolResult`（outcome=unknown）；完全没 started → `#appendSyntheticToolResult(...,'internal_error')`；最后 rethrow。`293-333`。
15. **提交结果**：`for (const [index, call] of toolCalls.entries())`，按**原始顺序**处理：
    - `not_started` → `stepTrace.skipToolCall` + `#appendSyntheticToolResult`；`341-352`。
    - `settled` → `notifyObserver(onToolResult, {...})` + append `tool/result` 真实结果。`355-370`。
16. **再次检查外部/超时 abort**：若 `combinedSignal.aborted`，`stopBatch(controller.beforeToolCall(combinedSignal))`。`373-375`。
17. **进度检测**：若没有 turnDecision 且有 detector，`progressDetector.observeStep({toolCalls, records})` → `controller.recordProgress(progress, combinedSignal)`；若 stop，设 `turnDecision`。整个 try/catch 失败即忽略。`377-388`。
18. **结束本 Step**：若 `turnDecision` 存在，`#finishDecision(...)` 结束 Run；否则进入下一轮 while。`390-398`。`finally` 中 `stepTrace.finish()`。`399-401`。

### 1.4 Run 收尾

- 外层 catch（`403-413`）：
  - 外部 `signal?.aborted` → `stopReason='cancelled'`，抛 `new Error('Agent run cancelled', {cause})`。`404-407`。
  - deadline signal aborted 或 reason.stopReason==='time_limit' → `stopReason='time_limit'`，返回 `lastContent`（不抛）。`408-411`。
  - 其他错误：错误消息含 cancelled → `cancelled`，否则 `internal_error`，并 rethrow。`412-413`。
- 外层 finally（`414-433`）：
  - `toolVisibility.endRun` 失败忽略；`deadline.dispose()`；`controller.snapshot()`。`415-421`。
  - `runTrace.finish(stopReason)`；trace 持久化失败只 warn。`422-423`、`trace-runtime.js:58-69,149-160`。
  - `onStop({stopReason, state: finalState})`；observer 抛错被吞，不能改变 run 结果/原始错误。`424-432`。
- `#finishDecision` 对 `cancelled` 抛错，其他 stop 返回 content。`436-442`。

### 1.5 写进 Event Log 的事件序列（一次 tool-call Run 的典型形态）

`user/message` → `assistant/tool_calls` (第一次) → `tool/result` × N → `assistant/tool_calls` (第二次) → ... → `assistant/message`（最终无 tool call）。
对应代码：`97`、`206-212`、`339-371`、`188-192`。
注意：**tool/result 一定在 assistant/tool_calls 之后**，因为先 append 再调度；这是崩溃恢复能通过"有 call 无 result"识别未知结果的前提。`206-212`、`session-runtime.js:133-164`。

---

## 2. 核心不变量：Tool Call ↔ Tool Result 一一对应

### 2.1 不变量定义与代码事实

- "committed" = `assistant/tool_calls` 已成功写入 Session Event Log。写入点：`agent-loop-runtime.js:206-212`。
- 正常路径：`scheduler.execute` 返回与 toolCalls 等长的 records；Loop 按 index 遍历，每个 call 恰好 append 一条 `tool/result`。`339-371`。
- 取消/预算/准入拒绝路径：未启动的 call 被统一转成 `not_started`，再由 `#appendSyntheticToolResult` 补一条 result，`outcome='not_executed'`、`skipped=true`、`retryable=false`。`341-352`、`444-461`、`tool-scheduler.js:73-82,100-107`。
- 调度器异常路径：catch 中 `answered` 去重，按"已落盘 → 有 settled → started unknown → 完全未启动 synthetic"四类补齐。`293-333`、`463-477`。
- 进程崩溃路径：重新 `open` session 时，`SessionRuntime.#recoverInterruptedToolCalls` 扫描所有 `assistant/tool_calls`，对没有匹配 `tool/result.toolCallId` 的 call 追加 `outcome='unknown'`、`recovered=true`、`retryable=false`、`errorCode=null`；不重放工具。`session-runtime.js:133-164`。
- 幂等性：recovered result 写入后，再次 open 时该 toolCallId 已在 `answered` 集合中，不会重复追加。`134-148`；eval 验证见 `evals/crash-recovery/fixture.js:150-155,178-187`。

### 2.2 各路径对照表

| 路径 | 触发点 | 谁负责补齐 | 结果标记 | 代码位置 |
| --- | --- | --- | --- | --- |
| 正常执行 | 调度器返回 settled | Loop 遍历提交 | 真实 `isError/errorCode/content` | `agent-loop-runtime.js:239-292,339-371` |
| 预算/准入拒绝（未启动） | usage/cost/tool failure stopBatch；tool_call_limit；外部 abort | Scheduler 标 not_started → Loop synthetic | `outcome=not_executed`、`skipped=true`、`budgetStop` | `214-233,242-259,341-352,444-461`、`tool-scheduler.js:73-82` |
| 取消/超时（已启动） | `combinedSignal`/`batchController` abort；ToolRuntime 返回 cancelled/timeout | ToolRuntime 结果 + Loop 提交 | `errorCode=cancelled/timeout` | `tool-runtime.js:143-186,288-301`、`agent-loop-runtime.js:355-370` |
| 调度器异常 | `scheduler.execute` throw | Loop catch：真实/unknown/synthetic | 已启动无结果 `outcome=unknown`；未启动 `not_executed` | `293-333,463-477` |
| 进程崩溃 | assistant/tool_calls 已持久化，tool/result 未持久化 | `SessionRuntime.open` 恢复 | `outcome=unknown`、`recovered=true`、`retryable=false` | `session-runtime.js:133-164` |
| 崩溃发生在半条 result | JSONL torn tail | recovery 截断尾行，再看 call 是否已匹配 | 同上 unknown | `session-recovery.js:44-59`、`session-runtime.js:133-164` |

### 2.3 边界与"未验证/风险"

- **Store 写失败**：若 `sessions.append`（补 result）本身持续失败，catch 里的循环 `await this.sessions.append` 会中断，可能留下未闭合的 call；该路径未被现有测试覆盖。结论：不变量在"Store 可写"前提下成立。`293-333`。
- **同进程不重新 open 的缓存会话**：`SessionRuntime.open` 只在第一次 open 时执行 recovery；如果 session 已在内存缓存中，不会再次扫描。`session-runtime.js:40-55`。因此同进程内极端异常后复用缓存 session，恢复逻辑不会触发（未验证）。
- **toolCallId 全局唯一假设**：正常路径每个 call 按 index 各写一条 result，因此单次 committed 的每个 call 各有一条；但 `SessionRuntime` 恢复用 `toolCallId` 做 Set 匹配，`agent-loop` 的调度器异常兜底也按 `toolCallId` 查已落盘结果。代码不校验模型返回的 call.id 是否唯一。如果同一个 session 里出现重复 id，恢复可能把不同 call 的结果错误匹配。`session-runtime.js:134-138`、`agent-loop-runtime.js:294-304`。结论：不变量依赖 provider 给出的 toolCallId 在 session 内唯一（未在代码中强制）。
- **unknown vs not_executed 的语义**：`unknown` = 已开始执行但结果不可知；`not_executed` = 确定没有执行。二者的 `retryable` 都是 false，但 `unknown` 不应被当成"没发生"。`444-461,463-477`、`session-runtime.js:150-163`。

---

## 3. ToolRuntime

### 3.1 注册与 Ajv

- 注册必须提供 `name` 和 `execute()`；重复 name 抛错。`tool-runtime.js:61-66`。
- 定义先经过 `normalizeDefinition`：校验 metadata 布尔类型、`timeoutMs` 为非负有限数或 null；默认值 `timeoutMs:null, readOnly:false, idempotent:false, concurrencySafe:false, sideEffect:true`；`parameters` 缺省 `{type:'object'}`。`194-223,4-10`。
- Ajv 在注册时编译一次：`new Ajv({allErrors:true, strict:false, coerceTypes:false, removeAdditional:false})`。要点：多错误收集、不做类型强制转换、不静默删除 additionalProperties、strict 关闭。`49-57,68-70`。
- `schemas()` 输出 OpenAI 风格 `{type:'function', function:{name,description,parameters}}`。`89-98`。

### 3.2 execute 顺序与取消语义

`execute(name,args,exec)`（`100-187`）：

1. 记录 startedAt。`101`。
2. tool 不存在 → `unknown_tool`，content `Unknown tool: <name>`。`102-110`。
3. **parent signal 已 abort** → 直接 `cancelled`（在参数校验之前）。`113-121`。
4. Ajv 校验失败 → `invalid_arguments`，content 来自 `formatValidationError`（`instancePath + message`，`;` 连接）。`123-130,264-268`。
5. `createTimeout(definition.timeoutMs)` 生成 timeout signal（`setTimeout` abort reason `{errorCode:'timeout'}`）；与 parent signal 用 `AbortSignal.any` 合并。`132-133,270-286`。
6. 构造 execution context：`{signal, sessionId, runId, stepId, toolCallId, agent}`；没有 signal 时注入一个新建的、未 abort 的 signal。`134-141`。
7. `await definition.execute(args, execution)`。**关键**：timeout/cancel 不 race、不强杀；它等待工具自己 settle。`143-146`。
8. 工具正常返回后再次检查 cancellation：如果 signal 已 abort，即使返回值正常也转成 `cancelled/timeout`。`147-150`。
9. 渲染：`output.render` 存在则 `await render(args, value)`，否则 `[{type:'text',text:toText(value)}]`。`151-153`。
10. 可选 `finalizeContent(execution, result)`；返回非 undefined 则替换 content。`162-165`。
11. 再次检查 cancellation。`166-169`。
12. 成功结果形状：`{value, content, isError:false, errorCode:null, metadata}`。`155-161,170`。
13. 任何 throw 落入 catch：`classifyError` 归一化；content `ToolError: <message>`；metadata 带 timeout/cancelled 标记。`171-183`。
14. `finally` 清理 timeout timer。`184-186`。

### 3.3 5 类 errorCode 与判定优先级

`ERROR_CODES`：`tool-runtime.js:12-18`。

| errorCode | 触发条件 | 代码 |
| --- | --- | --- |
| `unknown_tool` | `#tools.get(name)` 不存在 | `102-110` |
| `invalid_arguments` | Ajv `validate(args)` false | `123-130` |
| `timeout` | signal reason `errorCode==='timeout'`，或工具抛 `error.errorCode==='timeout'` | `288-293,295-300` |
| `cancelled` | parent/tool signal aborted 且不是 timeout；或 `error.name==='AbortError'` | `288-293,295-301` |
| `execution_error` | 其他 throw（包括 render/finalizeContent 抛错） | `295-301` |

`classifyError` 的顺序很重要：先 `cancellationCode(signal)`，再 `error.errorCode==='timeout'`，再 `error.name==='AbortError'`，最后 `execution_error`。因此 **abort 信号优先于工具抛出的错误类型**。`295-301`。

### 3.4 Timeout / Cancel 的协作语义

- 代码注释明确："Timeout and parent cancellation are cooperative: the runtime aborts the execution signal and waits for tool.execute() to settle after cleanup. Forced preemption requires process/worker isolation and is outside V2." `tool-runtime.js:33-42,143-146`。
- 对调用方的现实含义：如果工具完全不看 `execution.signal` 且永不返回，`ToolRuntime.execute` 永不 settle，进而 Run 卡住。文档也承认这一点（`ARCHITECTURE.md:132`）。
- cancel 判定会做两次（execute 返回后、finalizeContent 后），确保"工具在 abort 后仍成功返回"不会伪装成成功。`147-150,166-169`。
- `timeoutMs=0` 是合法值（非负有限数），`setTimeout(0)` 会在下一个 macrotask abort；是否能在 execute 同步体前 abort 取决于事件循环。`200-208,270-279`（未单独验证时序）。

### 3.5 结果渲染

- `renderResult(result) → blocksToText(result.content)`。`189-191`。
- `blocksToText`：非数组 → `toText`；数组则把 `type==='text'` 的 block 取 `text`，其他 block 走 `JSON.stringify(block,null,2)`，过滤空值后用 `\n` 拼接。`20-31`。
- 因此 `tool/result.content` 在正常路径是字符串；但自定义 `output.render` 返回 undefined 等异常形状时，`renderResult` 可能返回 undefined（未在核心工具中使用，未验证生产影响）。`25-31,151-153`。

---
## 4. ToolScheduler

### 4.1 partition 算法：连续并行组 + 独占 barrier

`partition(toolCalls)`（`tool-scheduler.js:16-38`）：

```
parallel = []
for (index, call) of toolCalls:
    if tools.get(call.name)?.concurrencySafe === true:
        parallel.push({index, call})
    else:
        flushParallel()             // 遇到非安全工具，先结束当前并行组
        groups.push({type:'exclusive', calls:[entry]})  // 该工具单独一组
flushParallel()
```

- 只有 `concurrencySafe === true` 进入并行组；默认 false（`tool-runtime.js:215`、`tool-catalog.js:82`），未知工具 `get()` 返回 undefined，也走独占路径。`tool-scheduler.js:28-35`。
- **为什么只有 concurrencySafe 能并行**：`readOnly`/`idempotent` 描述的是副作用与重试安全性，不能推出"可安全并发"；并发还涉及共享可变状态/顺序敏感副作用。所以采用 fail-closed：只有工具作者显式声明 `concurrencySafe=true` 才并行。`tool-runtime.js:4-10,194-217`、`docs/DESIGN_DECISIONS.md:28-33`。
- `maxParallelToolCalls` 限制的是**每个并行组内的 worker 数**，不是整个 Run 的全局并发；默认 4。`tool-scheduler.js:1,8-13,54-71`。
- barrier 语义：独占组会等待前一个并行组全部 settle，执行完再放开后一个组。`40-52`。

### 4.2 execute / 并行 worker

- `execute` 先 `results = new Array(toolCalls.length)`，然后按 group 顺序执行；exclusive 调 `#runEntry`，parallel 调 `#runParallel`。`40-52`。
- `#runParallel`：`workerCount = min(maxParallelToolCalls, entries.length)`；`Promise.all` 启动 worker；共享 `cursor` 同步自增取 entry，Node 单线程保证不会取到重复 index。`54-71`。
- worker 循环开始前检查 `signal?.aborted`，abort 后不再领取新 entry。`58-65`。
- 全部 worker 结束后，把未填的 index 用 `notStarted` 填满，保证 results 数组与 toolCalls 等长。`68-70`。
- `#runEntry` 若 signal 已 abort，直接写 notStarted；否则 `await run(...)`。`73-82`。

### 4.3 提交顺序 vs 完成顺序

- 完成顺序由工具实际耗时决定；`results[index]` 按**原始 index** 回填，因此 completion order ≠ 数组顺序。`43,73-82`。
- Loop 的提交循环是 `for (const [index, call] of toolCalls.entries())`，严格按原始顺序 append `tool/result`。`agent-loop-runtime.js:339-371`。
- 结果：Event Log 顺序稳定为原始 toolCalls 顺序；对于模型和恢复逻辑来说，call 和 result 的顺序可预测。文档也强调这一点：`ARCHITECTURE.md:138-144`、`docs/DESIGN_DECISIONS.md:31`。
- 测试证据：`test/parallel-tool-scheduler.test.js:230-280`（并行取消仍按 `cancel-0..3` 提交）、`593-652`（tool call 预算按原序提交）。

### 4.4 调度器异常时的行为

- Scheduler 本身不捕获 `run()` 抛错；`Promise.all` eager reject，`execute` 把异常抛给 Loop。`54-71`。
- 未启动的 entry 不会被自动补齐（因为 Promise.all 已 reject，后续代码没执行）；补齐由 Loop 的 catch 完成。`agent-loop-runtime.js:293-333`。
- 一个细微点：`Promise.all` 拒绝后，已启动的工具并不一定被 abort（`batchController` 没被 abort），会继续在后台跑；Loop catch 把它们标成 `unknown`（因为当时还没有 settled record）。因此"unknown"是保守但可能过早的判定。`293-333`；测试 `test/parallel-tool-scheduler.test.js:480-548` 明确在断言后才 release 后台工具。文档说"preserves settled results, supplies unknown for started calls without results"基本准确，但"settled"存在竞态窗口。`ARCHITECTURE.md:144`。

---

## 5. RunController：stop reason 与预算语义

### 5.1 12 个 stop reason

`STOP_REASONS`（`run-controller.js:1-14`）：`completed`, `cancelled`, `step_limit`, `tool_call_limit`, `time_limit`, `input_token_limit`, `output_token_limit`, `cost_limit`, `tool_failure_limit`, `context_overflow`, `no_progress`, `internal_error`。

| stopReason | 触发条件 | 代码 |
| --- | --- | --- |
| `completed` | LLM 返回无 tool call，且 usageDecision 不是 stop | `agent-loop-runtime.js:186-203` |
| `cancelled` | 外部 signal aborted（reason 不是 time_limit） | `run-controller.js:215-218`；Loop `403-407` |
| `time_limit` | deadline abort；或 `#durationDecision` 到时间；或 signal reason `time_limit` | `run-controller.js:167-175,215-218`、`run-deadline.js:7-9`、Loop `408-411` |
| `step_limit` | `beforeStep` 中 `maxSteps!==null && steps >= maxSteps`（先检查再自增） | `run-controller.js:72-76` |
| `tool_call_limit` | `beforeToolCall` 中 `maxToolCalls!==null && toolCalls >= maxToolCalls` | `98-114` |
| `input_token_limit` | 累计 inputTokens ≥ maxInputTokens | `177-183` |
| `output_token_limit` | 累计 outputTokens ≥ maxOutputTokens（reasoning 单独计数，不占 output） | `184-190`；`test/run-controller.test.js:15-34` |
| `cost_limit` | `hasUsage && costKnown && cost >= maxCost` | `193-203` |
| `tool_failure_limit` | `isError` 的 settled tool result 累计 ≥ maxToolFailures | `116-122,205-213` |
| `context_overflow` | ContextManager.prepare 后 pressure 仍为 `hard_limit` | `134-142`；`agent-loop-runtime.js:147-159` |
| `no_progress` | ProgressGuard 返回 `action='stop'`，且没有更高优先级限制 | `124-132` |
| `internal_error` | 未归类的异常；调度器异常也是此原因 | Loop `412-413`、`test/parallel-tool-scheduler.test.js:283-318` |

### 5.2 决策优先级（代码事实）

- 每个入口都先 `#externalDecision`：signal aborted → `cancelled`/`time_limit` 最高优先。`run-controller.js:62-64,80-82,98-100,116-118,124-126,134-136,215-218`。
- `beforeStep`：external > duration > token > step。`62-78`。
- `beforeToolCall`：external > duration > token > tool_call。`98-114`。
- `recordLlmUsage`：external > 累加 usage > `#limitDecision`；`#limitDecision` 顺序是 duration > token > cost > tool_failure。`80-96,157-165`。
- `recordToolResult`：external > toolFailures++ > `#limitDecision`（duration/token/cost/tool_failure）。`116-122`。
- `recordProgress`：external > 已有 `#limitDecision` > no_progress。`124-132`。
- `recordContextPressure`：external > duration > hard_limit。`134-142`。
- 结论：时间和取消优先于 token/cost/failure；input 优先于 output；已有硬限制优先于 progress stop。

### 5.3 计数与检查语义

- `beforeStep` 是"先检查、后自增"：`maxSteps=0` 会立即 `step_limit`；`step` 在第一次 LLM 请求时为 1。`72-77`；`test/run-controller.test.js:86-90`。
- `beforeToolCall` 同样先检查后自增：`maxToolCalls=2` 时允许且只允许 2 个工具真正进入 execute；第 3、4 个得到 synthetic not_executed。`102-114`；`test/parallel-tool-scheduler.test.js:593-652`。
- Token 预算是累计 provider usage，不是 ContextManager 的 request estimate；检查发生在 LLM 返回之后或下一次执行前，因此可能"超一点才停"。`80-96,177-191`、`ARCHITECTURE.md:88`。
- `maxInputTokens=0` 会在第一次 LLM usage 记录后停（因为 `0 >= 0`），不是阻止第一次请求。token 的 `null` 表示禁用该限制。`177-191,241-243`；`test/run-controller.test.js:76-90`。
- Tool failure 统计的是 `recordToolResult` 收到的 settled result 的 `isError`，包括 `execution_error`、`invalid_arguments`、`unknown_tool`、`timeout`、`cancelled`；synthetic not_executed 不会通过这个路径计数。`116-122`、`agent-loop-runtime.js:274-280`。

### 5.4 token / cost 预算的真实语义

- `snapshot()` 里：`cost: this.#hasUsage && this.#costKnown ? this.#cost : null`；始终返回 tokens、toolCalls、steps、toolFailures、elapsedMs。`144-155`。
- `#costKnown` 初始 true；`recordLlmUsage` 中：
  - usage.cost 是有限 number → 在 `#costKnown` 仍为 true 时累加；
  - 否则 `#costKnown = false`。`89-93`。
- `#costDecision` 三个前置条件：`maxCost!==null && #hasUsage && #costKnown`。也就是说，**unknown cost 会让 cost 上限形同禁用**，而不是当作 0 继续累计。`193-203`。
- 为什么 unknown cost 不是 0：
  - 0 是一个"已知的事实"（显式 `cost: 0` 会被 `CostEstimator` 原样保留，`cost-estimator.js:11-13`；测试 `test/run-governance.test.js:39-48`）。
  - 当 pricing/usage 缺失时，实际成本 > 0 的可能性很高；把 unknown 当 0 会让累计值和预算判断变成"看起来在预算内"，掩盖不确定性。
  - 代码选择：`snapshot().cost=null`，cost 报告标为不可用，并且 `maxCost` 不再触发。`README.md:71` 用"unknown cost is not zero"描述了前半句；`ARCHITECTURE.md:88` 说"cost ceiling cannot be guaranteed"。
- 代价/取舍：一旦某个 usage 缺失 cost，`#costKnown` **永久 false**，后续已知 cost 也不会再累加；整个 Run 的 cost 报告变成 null，maxCost 不生效。这是 fail-open 的预算治理选择，不是 exactly-once 成本核算。若要做 fail-closed，需要在 cost 变 unknown 且 maxCost 配置存在时主动 stop（当前 RunController 没做；benchmark 层单独实现了 `unknown_cost`，见 `src/benchmark/benchmark-runner.js:89-93,126-129`）。

---

## 6. ProgressGuard（SemanticProgressDetector）

### 6.1 三档模式与装配

- `PROGRESS_MODES = ['off','remind','guarded']`。`progress-config.js:3`。
- 环境默认 `MINI_DSH_PROGRESS_MODE=off`。`5-9`。
- 默认 soft=3、hard=6；hard 必须 > soft；`remind` 模式把 hard 设为 null（只提醒不停止）。`11-31`。
- `progressDetectorFactory(config)`：off → undefined；remind → hard=null；guarded → hard=config.hardThreshold；每个 Run 都通过 `({runId,sessionId,agent})` 新建 detector，因此 seen sets 是 run-local 的。`34-42`；`src/index.js:42,60`。
- AgentLoop 侧：
  - factory 抛错 → 忽略，progressDetector undefined。`agent-loop-runtime.js:82-87`。
  - `takeReminder()` 抛错 → 忽略；reminder 被追加到 system prompt。`121-126,519-521`。
  - `observeStep` + `recordProgress` 整体 try/catch，任何异常都不影响 run。`377-388`。
  - 这三级构成 fail-open：配置/工厂/提醒/检测任一步失败，都退化为"没有 ProgressGuard"。

### 6.2 normalized call / fingerprint / novelty 算法

`observeStep({records})`（`semantic-progress-detector.js:37-97`）：

1. 过滤可观察记录 `isProgressEvidence(record)`：必须 `state==='settled'`、有 result，且 `errorCode` 不是 `cancelled`/`timeout`。`144-149`。即取消/超时不进入 Progress 统计。
2. 对每条记录生成 observation（`observationFor`，`114-142`）：
   - `projected = progressProjection(record)`：`166-198`。
     - process-like value（对象含 `exitCode` 且含 `stdout`/`stderr`）→ 只取 `{exitCode,stdout,stderr,signal?}`；
     - error result → `{errorCode, value (或 content)}`；
     - value 语义为空但 renderedContent 非空 → 用 renderedContent；
     - 其他 → value。
   - `outcomeClass = classifyOutcome(result,projected)`：`error:<errorCode>` / `process_exit:<exitCode>` / `empty` / `success`。`151-164`。
   - `resultFingerprint = fingerprint(projected)`。
   - `callFingerprint = fingerprint(canonicalize(args))`。
   - `lowInformation = outcomeClass !== 'success' || isMeaningfullyEmpty(projected)`。
   - `resultKey = fingerprint(toolName + '\0' + outcomeClass + '\0' + resultFingerprint)`。`124`。
   - `pairKey = fingerprint(toolName + '\0' + callFingerprint + '\0' + outcomeClass + '\0' + resultFingerprint)`。`125-127`。
   - `isNovelInformativeResult = outcomeClass==='success' && !empty && !seenResults.has(resultKey)`。`135-138`。
   - `isRepeatedPair = seenCallResults.has(pairKey)`。`139`。
   - `isRepeatedLowOutcome = lowInformation && seenResults.has(resultKey)`。`140`。
3. canonicalize 的细节（`222-252`）：
   - string：CRLF→LF，`trimEnd()`；
   - bigint→`${n}n`，symbol→String，function→`'[Function]'`，循环引用→`'[Circular]'`；
   - array 递归；object 按 key 排序，丢弃 `VOLATILE_KEYS`（`durationms/elapsedms/startedat/endedat/timestamp/ts`，大小写不敏感）；
   - 如果某个 key 在传入的 `args` 对象里存在且值等价，则删除该 key（用于剔除结果里重复回显的入参）。`236-249`、`6-13`。
4. fingerprint = `sha256(stableStringify(value))`；`stableStringify` 递归排序 key，undefined→`"[Undefined]"`。`262-275`。
5. novelty 的比较时机：先对整步的所有 observation 判断，再统一把 resultKey/pairKey 加入 seen sets；注释明确"Compare a whole parallel Step against prior Steps before adding any of its observations, so siblings cannot count as repeats of each other."。`44-54`。
6. streak / action：
   - `hasProgress = any isNovelInformativeResult`；`hasNoProgressEvidence = any isRepeatedPair || isRepeatedLowOutcome`。`46-49`。
   - 有 progress → state=progress，reset streak/reminder；有 no-progress evidence → state=no_progress，streak++；否则 neutral（`no_eligible_observations` 或 `first_low_information_outcome`），reset streak/reminder。`56-77`。
   - `hard!==null && streak>=hard` → `action='stop'`；否则 `streak>=soft && !reminderIssuedForStreak` → `action='remind'`，设置 pending 与 issued 标记。`79-94`。
   - `takeReminder()` 消费一次 pending；每个 streak 最多一个 reminder。`99-103`。

### 6.3 阈值的真实含义（容易讲错）

- soft/hard 数的是**连续出现"重复/低信息"evidence 的 Step 数**，不是同一个结果的第几次出现。
- 由于第一次出现的低信息结果既不是 novel informative，也不是 repeated（resultKey 还没进 seen），它会被判为 `neutral` 并清零 streak（reason=`first_low_information_outcome`）。`68-76,114-141`。
- 以完全相同的一次失败/空结果为例，默认 soft=3、hard=6 的实际序列是：
  - 第 1 次：`neutral`，streak=0；
  - 第 2 次：`no_progress`，streak=1；
  - 第 3 次：streak=2；
  - 第 4 次：`remind`，streak=3；
  - 第 7 次：`stop`，streak=6。
  - 我用一个独立脚本验证过该序列（未写入仓库）。
- 中性 step（observation 为空，或第一次出现的新 low-info 结果）会清零 streak；所以"偶尔换了一个也失败的新做法"会把连续重复计数打断。`56-77`。
- 成功但结果指纹完全相同的重复调用也会被判 `isRepeatedPair`，因此"反复读同一个文件得到同样内容"会被视为 no progress。`124-140`。

### 6.4 能力边界

- `classifyOutcome` 只做错误码 / 进程退出码 / 空值判断；`isNovelInformativeResult` 只看指纹是否见过，无法判断结果是否与用户目标相关。`151-164,135-138`。
- 文档明确承认："It cannot determine whether arbitrary code changes advance the user's goal."。`ARCHITECTURE.md:90`。
- 超时/取消被排除，因此重复超时不会触发 no_progress，而是由 tool_failure_limit/time budget 处理。`144-149`。

---

## 7. JsonlSessionStore + Session Runtime + Recovery

### 7.1 SessionRuntime 的 append 协议

- `append(id,type,data)`：
  - 每个 session 一条内存 Promise 队列 `#appendQueues`；
  - 队列任务里构造 `{seq: session.events.length+1, type, data, at}`；
  - **先** `await store.append(id,event)`，**后** `session.events.push(event)`；store 写失败时内存不会前进，从而保持 seq 连续。`session-runtime.js:63-83`。
- `open(id)`：已缓存直接返回；否则 `store.open`，找 `session/start` 还原 meta，拷贝 events，然后执行 `#recoverInterruptedToolCalls`。`40-55`。
- `close/dispose`：等所有 append 队列，再 `store.close/dispose`。`114-126`。

### 7.2 JsonlSessionStore 的文件与队列

- 路径：`<directory>/<uuid>/session.jsonl`；默认 `.data/sessions`。`jsonl-session-store.js:18-20,130-136`。
- `create`：校验 id；`mkdir(directory,{recursive:true})`；`mkdir(sessionDir,{recursive:false})`；用 `flag:'wx'` 创建空文件；内存 `lastSeq=0`。`32-45`。
- `open`：`#waitForWrites(id)` 后 `readJsonlWithRecovery`；`lastSeq=events.length`。`47-64`。
- `append`：
  - 校验 id；进入 `#enqueue`；
  - `expected = record.lastSeq + 1`；`event.seq !== expected` → `SessionCorruptionError`；
  - `await writeFile(file, JSON.stringify(event)+'\n', {flag:'a'})`；
  - 成功后更新 `record.lastSeq` 和内存 map。`66-82`。
- `flush(id)`：`#waitForWrites` 后 `#sync`；`#sync` 以 `'r+'` 打开文件并 `handle.sync()`。`84-92,157-164`。`flush()` 无 id 时对所有内存 session 执行。`91`。
- `close(id)` 会 flush 并删除内存记录；`dispose()` → `close()` → clear queues。`114-128`。
- 文件写入是**逐事件 append**，不是每个事件 fsync；只有在 `flush/close/dispose` 才 sync。`157-163`；文档明确不保证掉电持久化。`ARCHITECTURE.md:166`。
- 不提供多进程锁：两个进程同时 append 同一 session 会各自基于本地 `lastSeq` 写 seq，可能产生重复/乱序。代码注释和文档都承认。`session-run-coordinator.js:1-7`、`ARCHITECTURE.md:18,166`。

### 7.3 seq 校验与恢复

`session-recovery.js`：

- `readJsonlWithRecovery(filePath)`：读整个 buffer，`parseJsonlBuffer({recoverFinalLine:true, truncate})`。`14-20`。
- `readJsonl`（list 用）：同样解析，但 `recoverFinalLine=false`。`22-25`。
- `parseJsonlBuffer`：
  - 按字节扫描 `0x0a`；行内容 `utf8`，去掉尾部 `\r`。`31-35`。
  - 空行：如果不是文件末尾（尾部空行允许）→ `Empty JSONL line` 错误。`36-42`。
  - 解析 JSON；失败时计算 `isFinalLine = atEnd || index+1===buffer.length`。**只有** final line、开启 recover、且 `events.length>0` 才 `truncate(lineStart)` 并返回已解析事件；其他情况抛 `SessionCorruptionError`。`44-59`。
  - 成功解析后 `validateEvent(event, events.length+1, lineStart)`；要求是 non-array object、`seq` 连续整数、`type` 为 string、存在 `data` 属性。任何不满足 → 抛错。`61-86`。
- 恢复语义（实测/已验证）：
  - 有效前缀 + 半条 JSON 尾行 → 截断尾行，返回有效前缀；
  - 只有一条且损坏 → 不恢复（events.length===0），抛错；
  - 中间行损坏 / 尾行是合法 JSON 但 seq 跳号 / shape 错 → 抛错，不静默跳过；
  - 空文件 → 合法，返回 `[]`；
  - 尾部空行（一个换行结束）允许，但中间空行报错。
  - 代码依据：`44-63`；我用独立脚本对上述分支做过验证（未写入仓库）。
- 恢复对 `open` 生效，对 `list` **不生效**：`JsonlSessionStore.list` 调用 `readJsonl`（不带 recovery），因此有 torn tail 的 session 会让 `/sessions` 列表抛错；而 `/resume <id>` 会走 `open` 并截断恢复。`jsonl-session-store.js:94-112`、`session-recovery.js:22-25`。这是一个易被忽略的运维/UX 边界。

### 7.4 崩溃恢复与 tool 协议闭环

- `SessionRuntime.open` 在恢复 event stream 后调用 `#recoverInterruptedToolCalls`。`session-runtime.js:53`。
- 算法：先用所有 `tool/result` 的 `toolCallId` 建 `answered`；再按事件顺序扫描 `assistant/tool_calls` 里的每个 call；没被 answered 的则记录 missing，立即 `answered.add(call.id)`，最后为每个 missing append 一条 `outcome:'unknown'`、`recovered:true`、`retryable:false` 的 result，并沿用原事件的 runId/stepId。`133-164`。
- 不重放工具：只写 result，不调用 `tools.execute`。`150-163`。
- 幂等：第二次 open 时这些 recovered result 已在 answered 中，不会重复追加。`134-148`；`evals/crash-recovery/fixture.js:150-155`。
- 设计动机：外部副作用可能已发生但 result 未落盘，本地日志无法判断成功与否；所以显式记 `unknown`，而不是盲目重试。`docs/DESIGN_DECISIONS.md:42-47`、`ARCHITECTURE.md:174-190`。

### 7.5 一个隐藏缺陷：直接 append 未缓存 session 会死锁（未在生产路径触发）

- 代码：`JsonlSessionStore.append` 在内存 `#sessions` 没有 record 时调用 `#loadRecord(id)`；`#loadRecord` 调 `open(id)`；`open` 里 `await this.#waitForWrites(id)`；而 `#waitForWrites` 等待的是 `this.#queues.get(id)`，此时该值正是 append 自己入队后设置的 `next.catch(()=>{})`。`jsonl-session-store.js:66-82,138-155`。
- 结果：append → loadRecord → open → waitForWrites(自身的 queue tail) 形成自等待。我用独立脚本对 `new JsonlSessionStore(...).append(id,...)`（未先 open/create）验证，1.5s 后仍未返回。
- 生产路径不触发：`SessionRuntime.append` 先 `this.get(id)`，session 未打开会抛错；正常 `create/open` 会填充 store 的 `#sessions`。所以当前 CLI/Agent 路径不受影响，但这是一个接口级潜在缺陷，重构时值得注意。`session-runtime.js:63-75`。
- 状态：已用实验验证会卡死；标注为"生产路径未触发，接口级 latent bug"。

---

## 8. TraceRuntime 与观察者

- `TraceRuntime.startRun` 创建 run trace：`{runId, sessionId, provider, model, startedAt, endedAt, durationMs, stopReason, usage, steps}`；usage 各项初始 null。`trace-runtime.js:30-51`。
- `finish(stopReason)` 只执行一次，`normalizeStopReason` 把非 `STOP_REASONS` 的原因归一为 `internal_error`，然后 `#persist` 写 `<directory>/<runId>.json`；持久化失败只 `warn`，不影响 run。`58-69,149-160,213-215`。
- `startStep` 记录 step 生命周期；`finishLlm` 累加 input/output/reasoning/cache/cost；`startToolCall/skipToolCall/finish` 记录 tool 状态。`72-147,183-211`。
- `agent-loop` 中 trace 是观察者：`stepTrace?.finishLlm` 在 finally；`stepTrace?.finish()` 在 step finally；`runTrace.finish` 在 run finally。trace 与 Session Event Log 分离，Session 仍是事实来源。`agent-loop-runtime.js:163-179,399-400,422-423`、`trace-runtime.js:8-14`。
- `notifyObserver` 用 `Promise.resolve(observer(value)).catch(()=>{})`，同步抛错也 catch；因此 onToolCall/onToolResult 失败不能改变执行或持久事件。`agent-loop-runtime.js:510-517`。
- `onStop` 在 trace finish 之后调用，但失败被吞；它拿到的 state 是 `controller.snapshot()`。`414-432`；`test/run-governance.test.js:278+`。

---

## 9. 文档声称 vs 代码实际（重点）

总体判断：这个项目的文档（README/ARCHITECTURE/DESIGN_DECISIONS）比常见项目克制，主动写了很多边界（cooperative timeout、no distributed exactly-once、no power-loss durability、no OS isolation）。以下差异主要是**措辞引发的过度期待**或**代码与文档的细微缺口**，不是大规模造假。

| # | 文档声称 | 代码实际 | 类型/严重度 |
| --- | --- | --- | --- |
| 1 | `"append-only JSONL history"`（README.md:11）、`"append-only Session Event Log"`（DESIGN_DECISIONS.md:10） | 正常路径是 append；但 `readJsonlWithRecovery` 会对损坏的最后一行执行 `truncate(lineStart)`，即恢复时**物理截断文件**。`session-recovery.js:44-51` | 措辞过度简化：严格说不是"永不改写"的 append-only，而是"正常追加 + torn tail 可截断修复"。ARCHITECTURE.md:172 有承认。 |
| 2 | `"Durable Session"` / `"durable sessions"`（README.md:5,11）、`"durable sessions"`（ARCHITECTURE.md:254） | 每个事件是普通 `writeFile(...,{flag:'a'})`，只在 `flush()/close()/dispose()` 调 `handle.sync()`；不 fsync 每个事件，也无线程/进程锁。`jsonl-session-store.js:76-77,157-163`、`ARCHITECTURE.md:166` | 文档内部已澄清；"durable" 的边界是**进程崩溃可恢复**，不是掉电持久化、也不是多进程一致性。面试引用时应主动限定。 |
| 3 | `"unknown cost is not zero"`（README.md:71）、`"unknown cost stays null, so a cost ceiling cannot be guaranteed"`（ARCHITECTURE.md:88） | 代码不仅"不保证上限"：一旦任意一次 usage 缺 cost，`#costKnown` 永久置 false，后续 **已知** cost 也不再累计，`snapshot().cost=null`，`maxCost` 完全不触发。`run-controller.js:89-93,193-203` | 文档偏保守但不够具体。更准确说法是：unknown cost 使该 Run 的 cost 报告不可用且 cost 上限 fail-open。benchmark 层另有 `unknown_cost` 的 fail-closed 行为（`src/benchmark/benchmark-runner.js:89-93`）。 |
| 4 | `"On scheduler failure, the Loop preserves settled results, supplies unknown for started calls..."`（ARCHITECTURE.md:144） | 大方向正确；但 `Promise.all` eager reject 后，后台仍在跑的工具不会被自动 abort，Loop catch 可能在它们 settle 之前就写成 `unknown`。测试也显示需要手动 release 才能结束后台工具。`agent-loop-runtime.js:293-333`、`test/parallel-tool-scheduler.test.js:480-548` | 细微竞态：unknown 是保守标签，但"settled results"存在一个时间窗口；文档未展开。 |
| 5 | `"every committed Tool Call must eventually have exactly one matching tool/result"`（ARCHITECTURE.md:58） | 在"store 可写 + toolCallId 唯一"前提下成立。代码不校验 call.id 唯一；恢复按 `toolCallId` 全局匹配，重复 id 会误配。`session-runtime.js:133-148`、`agent-loop-runtime.js:294-304` | 隐含假设未在文档中显式写出，属于可被面试官追问的边界。 |
| 6 | `"remind injects a temporary, one-shot strategy reminder"`（ARCHITECTURE.md:90） | "one-shot" 是**每个 no-progress streak 一次**，不是整个 Run 一次；progress/neutral 会重置 `reminderIssuedForStreak`，之后可以再次提醒。`semantic-progress-detector.js:79-94` | 容易理解错，建议表述为"per streak one-shot"。 |
| 7 | /sessions 展示与恢复能力 | `SessionRuntime.list()` 走 `JsonlSessionStore.list()`，而 list 用 `readJsonl`（无恢复）；torn tail 会让 `/sessions` 抛错，而 `/resume` 能恢复。`jsonl-session-store.js:94-112`、`session-recovery.js:22-25` | 文档未声称 list 能恢复；但这会造成"崩溃后 resume 可用、list 先失败"的运维观感。属于边界发现。 |
| 8 | `"budgetStop"` 字段语义 | `#appendSyntheticToolResult` 中 `budgetStop: stopReason !== 'cancelled'`，因此 `internal_error` 导致的未执行 call 也会被标 `budgetStop:true`。`agent-loop-runtime.js:444-460` | 字段命名比实际语义窄；消费方不应把 `budgetStop` 当作"一切由预算导致"的可靠标记。现有测试只对 tool_call_limit 断言 true。 |
| 9 | 文档说 timeout/cancel 是协作式 | 代码完全一致，且比文档更彻底：abort 后即使工具正常返回也会被改写成 cancelled/timeout。`tool-runtime.js:143-150,166-169` | 无差异；这里放在表中是为了提醒：真正的强制抢占需要 worker/process 隔离，代码注释也这么说。`tool-runtime.js:40-42` |

补充：`JsonlSessionStore.append` 未缓存 session 时的自等待死锁（第 7.5 节）没有对应文档声称，属于代码级 latent defect；当前生产路径不触发。

---

## 10. 面试官可能追问的 12 个深度问题 + 代码级答案要点

### Q1. 为什么要把 `assistant/tool_calls` 先落日志，再去执行工具？

要点：
- 这是崩溃恢复的前提：日志里先有 call，才可能在 result 缺失时识别出"已承诺但未闭环"的调用。`agent-loop-runtime.js:206-212`。
- 代价：出现 critical window——assistant/tool_calls 已持久化、外部副作用可能已发生、tool/result 未落盘。恢复只能记 `unknown`、不重试。`ARCHITECTURE.md:174-190`、`session-runtime.js:150-163`。
- 相反如果先执行后记 call，崩溃时副作用已经发生但日志完全不知道，连 unknown 都写不出来。`docs/DESIGN_DECISIONS.md:42-47`。

### Q2. 取消/超时/预算耗尽时，怎么保证每个 committed tool call 都有 result？会不会少？

要点：
- 统一入口：scheduler 返回的 record 要么 settled，要么 not_started；Loop 遍历原始 toolCalls 按 index 补 result。`tool-scheduler.js:68-70,73-82`、`agent-loop-runtime.js:339-371`。
- 未启动 → `#appendSyntheticToolResult`，`outcome=not_executed`、`skipped=true`、`retryable=false`；`errorCode` 对 cancelled/time_limit 是 cancelled，对预算原因是 null。`444-461`。
- 调度器异常 → catch 的 `answered` set 去重，补齐真实结果 / unknown / synthetic。`293-333`。
- 取消造成的已启动工具由 ToolRuntime 归一为 cancelled/timeout；不会丢。`tool-runtime.js:147-150,288-293`。
- 真正的缺口：store 写入失败的极端情况（catch 内 append 再失败），以及同进程不重新 open 的缓存 session。`293-333`、`session-runtime.js:40-55`。

### Q3. Timeout 是怎么实现的？为什么不能强杀？

要点：
- `timeoutMs` → `AbortController` + `setTimeout`，abort reason 带 `errorCode:'timeout'`；与 parent signal `AbortSignal.any`。`tool-runtime.js:270-286`。
- `execute` 只 await 工具 settle，不 race、不 worker.terminate；代码注释明确 forced preemption 需要进程/worker 隔离，V2 不做。`tool-runtime.js:33-42,143-146`。
- 工具忽略 signal 就能继续跑；这是文档承认的限制（`ARCHITECTURE.md:132`）。
- 如果要做强制超时：将工具放进 worker/子进程，主进程在超时后 terminate 并写 timeout result；同时要处理 stdout/副作用半完成的问题。这是可扩展方向，不是当前实现。

### Q4. 为什么只有 concurrencySafe 能并行？readOnly / idempotent 为什么不够？

要点：
- `readOnly` 只说明不写，不等于无共享状态；`idempotent` 只说可重复执行，不等于并发安全。并发风险包括内存缓存、文件句柄、顺序敏感副作用。`tool-runtime.js:4-10`。
- 默认全部 false，未知工具也 false → fail-closed。`tool-runtime.js:194-217`、`tool-scheduler.js:28-35`。
- 工具作者必须对声明负责；框架不做运行时验证。`ARCHITECTURE.md:132`。

### Q5. 并行执行后结果怎么保证顺序？谁负责重排？

要点：
- `ToolScheduler.execute` 预分配 `results` 数组，按原始 index 写入；并行 worker 用共享 cursor 取 entry，完成顺序任意。`tool-scheduler.js:43-82`。
- Loop 最后 `for (const [index,call] of toolCalls.entries())` 按原顺序提交 Event Log。`agent-loop-runtime.js:339-371`。
- 提交顺序稳定，模型下一轮看到的 tool messages 顺序也稳定；但整体耗时会受最慢工具影响（barrier 同理）。`docs/DESIGN_DECISIONS.md:33`。
- 测试证据：`test/parallel-tool-scheduler.test.js:230-280,593-652`。

### Q6. 同一个 session 的两个 send 会并发吗？不同 session 呢？

要点：
- `AgentLoopRuntime.run` 用 `SessionRunCoordinator.run(agent.sessionId, …)`；每个 session 一个 promise 队列，前一个 settle（包括 reject）后下一个才开始，所以同 session 是 FIFO。`agent-loop-runtime.js:58-60`、`session-run-coordinator.js:11-27`。
- 不同 session 用不同 queue，可并发。`session-run-coordinator.js:9,16-20`。
- `previous.catch(()=>{}).then(task)` 保证前一个 run 失败不会毒化队列；tail 也 catch。`16-19`。
- 只覆盖本进程；无跨进程分布式锁。`session-run-coordinator.js:5-7`。

### Q7. RunController 的 stop priority 是什么？如果同时超时和超 token 会怎样？

要点：
- 任何入口先 `#externalDecision`，external 最高。`run-controller.js:62-64,215-218`。
- `#limitDecision` 顺序：duration → token(input 先于 output) → cost → toolFailure。`157-165`。
- `beforeStep` 顺序：external → duration → token → step。`62-78`。
- `beforeToolCall`：external → duration → token → tool_call。`98-114`。
- 所以同时超时/超 token → `time_limit`；同时 input/output 超 → `input_token_limit`；同时 token/cost → token 优先。`test/run-controller.test.js:111-148`。

### Q8. 为什么 unknown cost 要单独处理？为什么不把未知当 0 继续累计？

要点：
- 0 是显式已知值（`cost:0` 被保留）；unknown 是"没有信息"，两者混同会让 `snapshot().cost` 和 maxCost 判断看起来有效。`cost-estimator.js:11-13`、`test/run-governance.test.js:39-48`。
- 代码用 `#costKnown` 永久标记；未知后 cost 报告变 null，`maxCost` 不触发。`run-controller.js:89-93,193-203`。
- 这是 fail-open：宁可让 cost ceiling 不可用，也不伪造一个 0 或部分累计值。`ARCHITECTURE.md:88`。
- 如果面试官问"不是应该 fail-closed 吗"：可以提 benchmark 层在 `maxTotalCost` + 不允许 unknown 时直接 `budgetStopReason='unknown_cost'`（`src/benchmark/benchmark-runner.js:89-93`），说明项目知道两种策略，RunController 当前选的是 fail-open/报告不可用。

### Q9. ProgressGuard 的 fingerprint 怎么避免 key 顺序和 volatile 字段干扰？

要点：
- `canonicalize` 递归处理：对象 key 排序、抛掉 volatile keys、字符串 CRLF/trimEnd、循环/特殊类型统一表示。`semantic-progress-detector.js:222-252,6-13`。
- `stableStringify` 再排序一次并处理 undefined，然后用 sha256。`262-275`。
- 结果对象若回显了入参，`canonicalize(projected, args)` 会删掉与 args 同名的同值字段，避免"参数不同但结果只多了参数回显"被误判为不同信息。`236-249,166-198`。
- 一个可讨论的细节：这个删字段用的是**顶层 args** 递归传入，嵌套对象里同名 key 也可能被删，属于启发式指纹的粗糙处。`236-249`（未单独测试嵌套误删）。

### Q10. 为什么第一次重复失败不会触发 no_progress，而是 neutral 清零？

要点：
- novelty 逻辑：第一次低信息结果 resultKey 还没见过，既不是 novel informative（因为不 success/空），也不是 repeated，于是 state=neutral、streak=0。`68-76,135-141,46-49`。
- 第二次相同结果才 pairKey/resultKey 命中，进入 no_progress，streak=1。`64-67`。
- 阈值 soft=3/hard=6 数的是"连续重复的 Step"；默认效果是第 4 次相同失败提醒、第 7 次停止（含第一次 neutral）。`79-94`。
- 中性 step（换了新做法但也不成功）会清零 streak，属于"宁可漏报，不可误报"的设计，避免把探索性重试直接判死。`56-77`。

### Q11. JSONL 恢复为什么只截断最后一行？interior corruption 为什么不跳过？

要点：
- 截断依据：`isFinalLine = atEnd || index+1===buffer.length`，且 `events.length>0`、`recoverFinalLine=true`。只有文件尾部可能是不完整写入（torn tail），截断后前缀仍保持 seq 连续。`session-recovery.js:44-59`。
- 对中间损坏：无法区分"坏行"是丢字节、乱序还是外部篡改；跳过会让 seq 校验失去意义，可能掩盖协议不一致。所以直接 `SessionCorruptionError`，交由上层决定。`53-58,69-86`。
- 第一行就坏（events.length===0）也不截断，因为无法区分空文件/完全损坏；代码选择 fail。`48-52`。
- 合法 JSON 但 seq 跳号/形状错也失败，不会自动截断。`61-86`。

### Q12. "exactly one result" 是否等于 exactly-once 副作用？多进程/掉电怎么办？

要点：
- 不等价。日志层保证"committed call 恰好一条 result 记录"是**记录层**的 exactly-one；外部副作用可能发生 0 次、1 次或未知次。`docs/DESIGN_DECISIONS.md:10-12`。
- 崩溃窗口：副作用可能已发生、result 未落盘；恢复写 `outcome=unknown, retryable=false`，不重试。`session-runtime.js:150-163`、`ARCHITECTURE.md:174-190`。
- 掉电：append 不是每事件 fsync，`flush/close/dispose` 才 sync；官方测试用 SIGKILL 而不是断电，所以不能据此宣称掉电持久化。`jsonl-session-store.js:76-77,157-163`、`ARCHITECTURE.md:166`。
- 多进程：没有文件锁；`SessionRunCoordinator` 和 store queue 都只是进程内。`session-run-coordinator.js:5-7`、`jsonl-session-store.js:143-155`。
- 如果要 exactly-once：需要外部事务/幂等键/两阶段提交或对账；这是 mini-dsh 明确不承诺的。`ARCHITECTURE.md:190`。

---

## 11. 关键代码索引（便于面试现场翻代码）

- Agent Loop：`src/core/agent-loop-runtime.js:58-60,62-88,97,101-159,163-212,214-233,239-333,335-401,403-433,436-477`
- RunController：`src/core/run-controller.js:1-14,62-78,80-96,98-122,124-142,144-155,157-218,237-259`
- Deadline：`src/core/run-deadline.js:1-22`
- ToolRuntime：`src/core/tool-runtime.js:12-18,44-59,61-79,100-187,189-191,194-223,270-301`
- ToolScheduler：`src/core/tool-scheduler.js:7-38,40-82,85-98,100-107`
- SessionRuntime：`src/core/session-runtime.js:12-55,63-83,95-126,133-164`
- SessionRunCoordinator：`src/core/session-run-coordinator.js:8-37`
- JsonlSessionStore：`src/core/jsonl-session-store.js:12-45,47-92,94-128,138-172`
- Recovery：`src/core/session-recovery.js:14-25,27-67,69-86`
- Progress：`src/core/semantic-progress-detector.js:15-112,114-149,151-198,209-275`、`src/core/progress-config.js:3-42`
- Trace：`src/core/trace-runtime.js:15-69,72-160,183-215`
- Plugins/wiring：`src/plugins/agent-loop.js:9-33,36-46`、`src/core/agent-runtime.js:31-45`、`src/index.js:41-61`

---

## 12. 测试与环境备注

- 已运行并通过的重点测试（本地）：
  - `node --test test/run-controller.test.js test/run-governance.test.js test/parallel-tool-scheduler.test.js test/session-persistence.test.js test/semantic-progress-detector.test.js test/tool-runtime-v2.test.js test/trace.test.js` → 80 pass。
  - `node --test test/fault-injection-eval.test.js test/crash-recovery-eval.test.js test/session-run-coordinator.test.js test/progress-config.test.js test/semantic-progress-integration.test.js` → 31 pass。
- 额外独立验证（未写入仓库）：progress 阈值序列、JSONL 各损坏分支、`JsonlSessionStore.append` 未 open 时的自等待。
- 基线：当前工作区 `cab52c8`，存在未提交的 benchmark 相关改动；本报告分析的是工作区当前源码，不是 README 声称的 baseline `588e764`。

---

*（报告结束。若对某条 file:line 有疑问，优先以源码为准；标注"未验证"处表示尚未构造实验。本文件由 runtime-analyst 通过 task-1 产出，仅写入 interview-prep/research/。）*
