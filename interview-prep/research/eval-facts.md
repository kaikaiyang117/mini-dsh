# mini-dsh 评测框架与 README 数据核实（eval-facts）

> 核实对象：`README.md` 的 Evaluation 表格、`.eval/*.json` 7 份真实报告、`src/eval/*.js`、`evals/**`、`test/**`、`BENCHMARK.md`、`src/benchmark/*.js`。
>
> 核实时间：当前工作区。`.eval/` 被 `.gitignore:7` 忽略，报告是本地生成物，JSON 内没有 commit 字段；`evals/` 与 `src/eval/` 相对 `588e764` 没有代码变更，因此报告内容与当前评测套件代码一致，但“baseline=`588e764`”这句话只能由 README 说明，不能从报告自证。

## 0. 一句话结论

README Evaluation 表格里的**所有数值**都能在 `.eval/*.json` 中找到一致结果：Tool Routing 3 行全部精确一致；Context Pressure 的峰值、均值、compaction 次数、失败/完成分布全部一致；Long-Horizon 的 25/9、195,000/99,000（四舍五入）、64%/49% 也一致。真正需要在面试中补充边界的是：这些全是 **Mock LLM + 合成场景**，不是真实模型能力评测；`managed` 是组合变体，不能做单因素归因；`compacted`/`constrained` 的 `success=true` 表示“符合预期停止原因”，不等于任务完成；MCP Failure 报告里有两个 agent 用例的 token/tool 指标为 `null`，不能引用。

## 1. README 声称值 / 实际计算值 / 是否一致

数据来源均写为 JSON 字段路径；README 行号来自 `README.md`。

### 1.1 Tool Routing（README.md:115-121）

| README 声称值 | 实际计算值（报告字段） | 是否一致 |
| --- | --- | --- |
| All: Avg visible tools / request = 19 | `.eval/tool-routing.json#/variants/all/avgVisibleTools` = 19 | ✅ |
| All: Schema tokens / request = 9,268 | `.eval/tool-routing.json#/variants/all/avgToolSchemaTokensPerRequest` = 9268 | ✅ |
| All: Avg estimated input / run = 18,650.8 | `.eval/tool-routing.json#/variants/all/avgEstimatedInputTokens` = 18650.8 | ✅ |
| Deterministic: Avg visible tools / request = 5 | `.eval/tool-routing.json#/variants/deterministic/avgVisibleTools` = 5 | ✅ |
| Deterministic: Schema tokens / request = 336 | `.eval/tool-routing.json#/variants/deterministic/avgToolSchemaTokensPerRequest` = 336 | ✅ |
| Deterministic: Avg estimated input / run = 786.8 | `.eval/tool-routing.json#/variants/deterministic/avgEstimatedInputTokens` = 786.8 | ✅ |
| Progressive: Avg visible tools / request = 1.93 | 实际 `1.933333...`，四舍五入 1.93 | ✅ |
| Progressive: Schema tokens / request = 199.6 | `.eval/tool-routing.json#/variants/progressive/avgToolSchemaTokensPerRequest` = 199.6 | ✅ |
| Progressive: Avg estimated input / run = 1,016.2 | `.eval/tool-routing.json#/variants/progressive/avgEstimatedInputTokens` = 1016.2 | ✅ |
| “All modes pass every case” | 三个 variant 各 `successes=5 / cases=5`；15 个结果全部 `success=true`、`stopReason=completed` | ✅ |

补充实际值：Progressive 的 schema/request 比 All 低 `(9268-199.6)/9268 = 97.85%`，比 Deterministic 低 `(336-199.6)/336 = 40.60%`；但 Progressive 的 estimated input/run 比 Deterministic 高 `(1016.2-786.8)/786.8 = 29.16%`，因为多了一次 `tool_search` 请求。README.md:121 的定性描述正确。

### 1.2 Context Pressure（README.md:125-133）

| README 声称值 | 实际计算值 | 是否一致 |
| --- | --- | --- |
| Constrained / Compacted 使用 1,900 token window + 200 reserved output | `evals/context-pressure/fixture.js:12-16`：`maxContextTokens:1900`、`reservedOutputTokens:200`；`fixture.js:56` 对 full-history 设为 `null` | ✅ |
| full-history: peak estimated input/request = 5,697 | `.eval/context-pressure.json#/results/6/estimatedInputTokensByStep` 的最大值 = 5697（case `tool-protocol-pressure`） | ✅ |
| full-history: avg estimated input/run = 20,884 | `.eval/context-pressure.json#/variants/full-history/avgEstimatedInputTokens` = 20884.333 → 20884 | ✅ |
| full-history: compactions = 0 | `.eval/context-pressure.json#/variants/full-history` 下 3 个结果 `scoreDetails.compactionCount` 均为 0 | ✅ |
| full-history: All completed | 3/3 结果 `stopReason=completed`，`success=true` | ✅ |
| constrained: peak estimated input/request = 1,234 | `.eval/context-pressure.json#/results/1/estimatedInputTokensByStep` 最大值 = 1234 | ✅ |
| constrained: avg estimated input/run = 2,593 | `.eval/context-pressure.json#/variants/constrained/avgEstimatedInputTokens` = 2593.333 → 2593 | ✅ |
| constrained: compactions = 0 | 3 个结果 `scoreDetails.compactionCount` 均为 0 | ✅ |
| constrained: All `context_overflow` | 3/3 结果 `stopReason=context_overflow`；注意 `success=true` 因为预期就是 `context_overflow`，不是任务完成 | ✅（数值一致，语义要解释） |
| compacted: peak estimated input/request = 1,578 | `.eval/context-pressure.json#/results/8/estimatedInputTokensByStep` 最大值 = 1578 | ✅ |
| compacted: avg estimated input/run = 9,040 | `.eval/context-pressure.json#/variants/compacted/avgEstimatedInputTokens` = 9039.667 → 9040 | ✅ |
| compacted: compactions（suite total）= 17 | 9 + 2 + 6 = 17 | ✅ |
| compacted: All completed | 3/3 结果 `stopReason=completed`，`success=true` | ✅ |
| “Compacted reduces peak input by about 72%” | `(5697-1578)/5697 = 72.30%` | ✅ |
| “cumulative estimated input by about 57%” | 按 avg/run：`(20884.333-9039.667)/20884.333 = 56.72%`；按 suite total：`(62653-27119)/62653 = 56.72%` | ✅ |

### 1.3 Long-Horizon（README.md:145-150）

| README 声称值 | 实际计算值 | 是否一致 |
| --- | --- | --- |
| baseline: Avg visible tools / request = 25 | `.eval/long-horizon.json#/variants/baseline/avgVisibleTools` = 25 | ✅ |
| baseline: Estimated input（suite total, approx.）= 195,000 | `.eval/long-horizon.json#/variants/baseline/totalEstimatedInputTokens` = 194553；195,000 是约数 | ✅（approx. 成立） |
| baseline: Completed = 5/5 | `successes=5 / cases=5` | ✅ |
| managed: Avg visible tools / request = 9 | `.eval/long-horizon.json#/variants/managed/avgVisibleTools` = 9 | ✅ |
| managed: Estimated input（suite total, approx.）= 99,000 | `.eval/long-horizon.json#/variants/managed/totalEstimatedInputTokens` = 98657；99,000 是约数 | ✅（approx. 成立） |
| managed: Completed = 5/5 | `successes=5 / cases=5` | ✅ |
| “Tool exposure falls by 64%” | `(25-9)/25 = 64.00%` | ✅ |
| “estimated input by about 49%” | `(194553-98657)/194553 = 49.29%` | ✅ |
| “Managed combines Tool Routing, Progress Guard, and Context Compaction” | 代码确实同时配置三种机制：`evals/long-horizon/fixture.js:117-145`（DeterministicToolVisibility + SemanticProgressDetector + 9000 token ContextManager policy） | ✅（配置一致） |
| “gain cannot be attributed to any single mechanism” | 这句话是对的，而且需要更强提醒：报告显示 Progress Guard 在 5 个用例中一次都没有触发（`reminderCount=0`、`progressStops=0`），Compaction 只在 `large-context-fix` 触发 2 次；因此本报告的 64%/49% 不能归因给 Progress Guard，Compaction 也只在一个用例上有作用 | ✅ / ⚠️ 需要补充 |
| “all these checks included in CI” | `.github/workflows/ci.yml:21-31` 列出了 7 个 `eval:*`；README.md:237-240 属实 | ✅ |

补充 Long-Horizon 逐 case（baseline → managed）：

| Case | baseline estimated input / peak | managed estimated input / peak | managed compaction | 测试退出码 |
| --- | ---: | ---: | ---: | --- |
| targeted-bug-fix | 30065 / 4011 | 16862 / 2544 | 0 | [1, 0] |
| cross-file-change | 30890 / 4141 | 17687 / 2674 | 0 | [1, 0] |
| failed-first-search | 33915 / 4133 | 19245 / 2666 | 0 | [1, 0] |
| failed-edit-recovery | 38394 / 4302 | 22257 / 2835 | 0 | [1, 0] |
| large-context-fix | 61289 / 9200 | 22606 / 6785 | 2 | [1, 0] |

数据路径：`.eval/long-horizon.json#/results[*]`；`compactionCount` 和 `testExitCodes` 在 `scoreDetails` 下。

### 1.4 Reliability / 其他 README 表述（README.md:154-170）

| README 表述 | 实际验证 | 是否一致 |
| --- | --- | --- |
| Fault Injection 覆盖 LLM failure、tool error/timeout、invalid call、unknown tool、parallel cancellation、context overflow、scheduler failure | `evals/fault-injection/cases.js:8-85` 共 11 case；报告 11/11 成功 | ✅ |
| Crash Recovery 覆盖 real process SIGKILL、JSONL reopening、torn tail、unknown outcome | `evals/crash-recovery/process-runner.js:39-41,57-67` 真实 `SIGKILL`；`test/fixtures/crash-worker.js:24-97` 写 JSONL 和 torn tail；报告 5/5 成功 | ✅ |
| MCP Failure 覆盖 activation cleanup、server isolation、disconnect/reload、stale schema、cleanup retry、remote-like tool failure | `evals/mcp-failure/cases.js:1-47` 共 9 case；`evals/mcp-failure/suite.js:42-191` 逐 case 检查；报告 9/9 成功 | ✅ |
| “uses local fake plugins; not remote MCP chaos testing or health detection” | `evals/mcp-failure/fixture.js:15-17` 指向 `test/fixtures/*-mcp-plugin.js`；插件只是本地 Cordis plugin | ✅ |
| “If side effect occurs and crashes before Tool Result is durable, Harness records `outcome=unknown`, `retryable=false`” | `.eval/crash-recovery.json#/results[2]/scoreDetails/recoveredUnknown` = `{recovered:true,retryable:false}`；`evals/crash-recovery/fixture.js:167-177` 断言 | ✅ |
| “no blind retry under uncertain side effects” | `.eval/crash-recovery.json#/results[2]/scoreDetails/sideEffectExecutionCountAfterResume` = 0；`.../noBlindRetry` = true | ✅ |

## 2. 评测框架精读

### 2.1 接口与职责

- **EvalCase**：最小断言单元，由 `name`、`prompt`、`expected` 和可选 `limits/scorer` 组成。`expected.completion` 只支持两种契约：
  - `'target-tool'`（默认）：要求 `targetTool` 被执行且状态为 `completed`；
  - `'stop-reason'`：要求 `trace.stopReason` 等于指定值（可按 variant 映射）。
  校验逻辑：`src/eval/eval-suite.js:89-128`。
- **EvalSuite**：把 `cases + variants + fixtureFactory + scorer + assertions + reporter` 组合成一个可运行套件；构造时校验 suite 身份、case 唯一性、variant 唯一性、factory/scorer/assertions 类型。`src/eval/eval-suite.js:21-72`。
  - `runEvalSuite(suite)` 调 `new EvalRunner(...).run()`，然后执行 `suite.assertions`，最后执行 `suite.assertReport`；断言失败会让 CLI 非零退出。`src/eval/eval-suite.js:74-87`。
- **EvalRunner**：按 `case → variant` 顺序串行执行；每个组合创建新 fixture，调用 `fixture.agent.send(prompt)`，读取 `fixture.trace.latest()`，调用 case 级或 suite 级 scorer；无论成功/失败/异常，只要 fixture 创建成功就调用一次 `dispose()`。核心路径：`src/eval/eval-runner.js:86-103`、`105-218`；fixture 契约校验：`221-229`；dispose 语义：`211-217`。
  - 每个 EvalResult 记录 `success/steps/toolCalls/stopReason/requestCount/visibleToolCount/toolSchemaTokens/estimatedInputTokens/scoreDetails/error`，以及 `visibleToolCountByStep` 等按请求数组。`src/eval/eval-runner.js:175-209`。
- **EvalScorer**：默认 `completionScorer` 分派到 `targetToolScorer` 或 `stopReasonScorer`；`targetToolScorer` 区分“调用过”与“成功执行”，只有 `status === 'completed'` 才 `targetToolSucceeded=true`。`src/eval/eval-scorer.js:15-46`。
- **EvalReporter**：`writeJsonReport()` 写 `schemaVersion:1` 的 JSON；`renderMarkdownTable()` 只负责把 suite reporter 的 headers/rows 渲染为 Markdown。`src/eval/eval-reporter.js:4-22`。
- **EvalMetrics / RecordingTokenMeter**：包装真实 `TokenMeter`，每次 `estimateRequest()` 记录 `visibleToolCount`、`toolSchemaTokens`（只对 `tools` 估算）、`estimatedInputTokens`（system+messages+tools）。`src/eval/eval-metrics.js:3-28`。
  - `summarizeEvalResults()` 生成 variant 汇总；`avgVisibleTools` 是“所有请求 visible tool 数之和 / 所有请求数”，不是“每个 run 的 distinct tool 平均数”。`src/eval/eval-runner.js:169-171` 有注释，`src/eval/eval-metrics.js:55-56` 是加权公式。
  - 未知 provider usage 聚合为 `unavailable`，不会当 0：`src/eval/eval-metrics.js:84-98`；`.eval/*.json` 里所有 suite 的 `inputTokensAvailability/outputTokensAvailability/reasoningTokensAvailability/costAvailability` 都是 `unavailable`。
- **EvalCli**：统一执行 + 写 JSON + 渲染 Markdown；7 个 `scripts/eval-*.js` 只是绑定 suite 与 `.eval/<name>.json`。`src/eval/eval-cli.js:4-19`。

### 2.2 Mock LLM 如何驱动

每个 suite 的 fixture 都注册一个确定性的 `LlmRuntime` provider，没有网络调用：

- Tool Routing：mock 检查当前请求的 `request.tools`。若 target tool 可见且未调用过，就返回 target call；否则若 `tool_search` 可见，就返回带 `evalCase.searchQuery` 的 search call；否则返回空内容。`evals/tool-routing/fixture.js:95-130`。
- Progress：mock 按 `evalCase.scenario`、`request.system` 中是否有 `[Harness progress notice]`、以及请求计数决定工具调用。`evals/progress/fixture.js:85-96,131-173`。
- Context Pressure：mock 读取当前 messages 中是否包含 `GOAL_MARKER_CONTEXT_EVAL`；compacted variant 只有 `compactionCount > 0` 才允许 `finish_task`。`evals/context-pressure/fixture.js:110-171`。
- Long-Horizon：mock 从 prompt 中的 `TASK::...` 和会话 transcript 里解析工具事件，按固定状态机决定下一步 `glob/grep/read_file/bash/edit_file/finish_task`，补丁内容是写死的 `EXPECTED_PATCHES`。`evals/long-horizon/fixture.js:333-441`。
- Fault Injection：mock 按 case 返回固定 tool call；故障由 `FaultInjector` 在指定 point/occurrence 注入，可抛 provider 500、取消挂起请求、改 invalid args、换成 unknown tool、注入 scheduler/context/tool 故障。`evals/fault-injection/fixture.js:87-131`，`evals/fault-injection/fault-injector.js:1-78`。
- Crash Recovery：crash 阶段通常无 LLM；resume 阶段的 mock 只检查 messages 是否包含 durable user message / unknown / APPLIED，据此抛错或返回完成，用于验证恢复出的上下文。`test/fixtures/crash-worker.js:181-239`。
- MCP Failure：9 个 case 中 7 个是 lifecycle/manager 直接操作；2 个 agent case 的 mock 第一轮调用 MCP tool，第二轮检查 model 是否看到了失败文本并返回 fallback。`evals/mcp-failure/fixture.js:150-215`。

### 2.3 Fixture 隔离

- EvalRunner 对每个 `case × variant` 重新调用 `fixtureFactory`，所以每个样本都有新的 Agent/Session/Trace/Context。`src/eval/eval-runner.js:88-92`。
- Long-Horizon 用 `fs.mkdtemp` 创建独立临时仓库，并在 `dispose()` 中 `fs.rm(..., recursive, force)`。`evals/long-horizon/fixture.js:40,164-173`。
- Crash Recovery 用 `mkdtemp` 分别创建 sessions 目录和 external effects 目录；每个 phase 都 fork 新的 Node 子进程，SIGKILL 后重新 `open()` JSONL。`evals/crash-recovery/fixture.js:7-9,14-41`；`evals/crash-recovery/process-runner.js:8-83`。
- MCP Failure 每个 case 新建 `Context` 或独立 `McpManager`，dispose 时卸载 root fiber / manager。`evals/mcp-failure/fixture.js:29-68`。
- `CapturingTraceRuntime` 默认使用 no-op fileSystem，避免 eval 运行到处写 trace 文件；只保存 memory trace。`src/eval/eval-runner.js:9-44`。
- 测试中对生命周期有专门覆盖：`test/eval-framework.test.js:69,180,214,237,261,282,300`（失败隔离、dispose once、异常仍清理、invalid/missing trace 清理）。

### 2.4 Scorer 如何抵抗假阳性

框架级：
- `success = !error && Boolean(score.success)`，并在 dispose 后二次校正 `result.success = result.success && !result.error`；所以 dispose 出错会翻成失败。`src/eval/eval-runner.js:143-217`。
- 需要 trace 存在，scorer 异常会被记录为 error 而不是静默成功。`src/eval/eval-runner.js:143-164`。
- Tool protocol 完整性在多个 suite 里被独立断言为“每个 committed call 恰好一个 result，且无 orphan result”。

各 suite 的关键证据：
- Context Pressure：不仅看 stopReason，还看 `finish_task` 是否真正完成、compaction 次数、`goalPreservedAfterCompaction`、`finishGoalPreservedAfterCompaction`、`summarySafetyPreserved`、`recentContextPreserved`、`protocolComplete`、`protocolBoundarySafe`、`originalEventsPreserved`。`evals/context-pressure/fixture.js:210-319`；suite 断言 `evals/context-pressure/suite.js:50-109`。这能防止“通过丢历史/破坏协议来降低 token”。
- Long-Horizon：检查初始测试失败、最终测试通过、目标文件 diff、required reads、仅允许文件变化、workspace 文件集合不变、无 workspace 外写、bash `cwd` 在 workspace、bash 命令只能是指定命令、protocol complete。`evals/long-horizon/fixture.js:190-331`；suite 断言 `evals/long-horizon/suite.js:53-109`。
- Fault Injection：`stopReason === expected` + `protocolComplete` + `caseInvariant`。caseInvariant 进一步要求故障真的发生（如 sideEffectExecutionCount=1、toolFailures 数、errorCode、cancelled 数、unknown/not_executed 语义）。`evals/fault-injection/fixture.js:198-267,453-549`。
- Crash Recovery：真实进程重启 + JSONL 重新解析；检查 `unknown` 数、`retryable=false`、externalEffectCount、恢复后是否再次执行副作用、torn tail 是否被截断恢复、sequence 连续、protocol 完整、`doubleRestartIdempotent`。`evals/crash-recovery/fixture.js:79-205`。
- MCP Failure：检查状态机、工具注册/清理、`toolLeakCount`、stale schema 是否返回 `unknown_tool`、模型是否看到失败、清理重试次数、最终 manager 是否清空。`evals/mcp-failure/suite.js:42-191`。
- Progress：检查 remind/guarded 是否比 baseline 更早恢复、guarded 是否误杀合法推进、unrecoverable-stall 是否按 variant 停在正确 stop reason、guarded 的 steps/toolCalls/estimatedInputTokens 是否严格更低。`evals/progress/suite.js:35-73`。

## 3. 七个 suite 的实际报告数据

### 3.1 Tool Routing

- 套件：`tool-routing`；variants：`all, deterministic, progressive`；cases：5；样本：15；15/15 成功；stopReason 全部 `completed`。
- 报告实际汇总：

| Variant | cases/success | avgSteps | avgToolCalls | avgVisibleTools | maxVisibleTools | schema tokens/request | total estimated input | avg estimated input/run | total requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 5/5 | 2 | 1 | 19 | 51 | 9268 | 93254 | 18650.8 | 10 |
| deterministic | 5/5 | 2 | 1 | 5 | 21 | 336 | 3934 | 786.8 | 10 |
| progressive | 5/5 | 3 | 2 | 1.9333 | 2 | 199.6 | 5081 | 1016.2 | 15 |

- 测什么：在同一个 case 集下比较 `AllToolsVisibility`、`DeterministicToolVisibility(maxVisibleTools=6)`、`ProgressiveToolVisibility`（先 `tool_search` 再激活 target）三种可见性策略对 schema 开销和输入估算的影响。`evals/tool-routing/suite.js:5-31`，`evals/tool-routing/fixture.js:67-84`。
- 如何断言：所有 variant 必须 5/5；`large-noisy-catalog` 中 Progressive 的 schema tokens 和 estimated input 必须低于 All。`evals/tool-routing/suite.js:33-52`。
- Mock 边界：
  - mock 不是“根据用户 prompt 选工具”，而是检查 target tool 是否可见；`github-issues-cross-language` 虽然 prompt 是中文，但 mock 直接使用 case metadata 里的 `searchQuery='github issues'`，因此**不能证明真实模型具备跨语言检索能力**，只能证明 progressive activation 的链路可用。
  - Progressive 的 search query 也是 fixture 写死的；不能证明模型会构造有效 query。
  - `avgVisibleTools` 是“每次请求的 visible tool 数求和 / 请求数”，不是 distinct tool 数；All 的 `maxVisibleTools=51` 来自 `large-noisy-catalog` 的 50 个无关工具 + target。
- 不能外推：不能在面试中说“Progressive 在所有工具规模下都省 token”；报告只覆盖 0/20/50 个干扰工具、5 个 case。也不能说“Progressive 整体比 Deterministic 省输入”，本报告恰好相反（1016.2 > 786.8）。

### 3.2 Context Pressure

- 套件：`context-pressure`；variants：`full-history, constrained, compacted`；cases：3；样本：9；9/9 成功；stopReason 分布：`completed=6, context_overflow=3`。
- 三个 case：`long-history-pressure`、`recent-context-preservation`、`tool-protocol-pressure`。`evals/context-pressure/cases.js:7-29`。
- 报告实际汇总：

| Variant | cases/success | avgSteps | peak input/request | avg estimated input/run | total estimated input | total requests | compactions | stop reasons |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| full-history | 3/3 | 9.3333 | 5697 | 20884.33 | 62653 | 28 | 0 | completed ×3 |
| constrained | 3/3 | 5 | 1234 | 2593.33 | 7780 | 12 | 0 | context_overflow ×3 |
| compacted | 3/3 | 9.3333 | 1578 | 9039.67 | 27119 | 28 | 17 | completed ×3 |

- 逐 case compaction：`long-history-pressure`=9、`recent-context-preservation`=2、`tool-protocol-pressure`=6；其余 full-history/constrained 的 compaction 均为 0。
- 测什么：验证 ContextManager 的 1900 token window 在 soft/hard pressure 下是否安全地做 compaction；full-history 作为无窗口基线；constrained 用 `NoopCompactionPlanner` 强制溢出；compacted 允许真实 compaction。`evals/context-pressure/fixture.js:56-63,321-325`。
- 如何断言：见 2.4；另外 suite 明确断言 `requestCount === scoreDetails.modelRequestCount`，保证 plan/compaction 的内部估算不会混入“实际模型请求”指标。`evals/context-pressure/suite.js:76-79`；`test/context-pressure-eval.test.js:31-42`。
- Mock 边界：
  - compacted mock 的 `finish_task` 触发条件是“看到 GOAL_MARKER 且 compactionCount>0”；这是设计好的硬编码，不代表真实模型对压缩摘要的理解。
  - `summarySafetyPreserved` 只检查 assistant 文本含指定安全句、system prompt 未混入 user message；`goalPreservedAfterCompaction` 只检查 marker 字符串仍在。**这是结构/字符串级安全，不是语义忠实度评测。**
  - constrained 的 `success=true` 只意味着“按预期溢出且没有假装完成”；README 的 Task outcome 列应理解为契约结果。
- 不能外推：不能把 72%/57% 说成“真实模型长上下文能力提升”；它是 3 个合成 case、每请求 deterministic mock、估算 token。也不能说“压缩永不丢信息”；测试只覆盖指定 marker/协议边界。

### 3.3 Long-Horizon Coding

- 套件：`long-horizon-filesystem`；variants：`baseline, managed`；cases：5；样本：10；10/10 成功；stopReason 全部 `completed`。
- 报告实际汇总：

| Variant | cases/success | avgSteps | avgToolCalls | avgVisibleTools | schema tokens/request | total estimated input | avg estimated input/run | total requests | compactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 5/5 | 9.6 | 9 | 25 | 2358 | 194553 | 38910.6 | 48 | 0 |
| managed | 5/5 | 9.6 | 9 | 9 | 887.625 | 98657 | 19731.4 | 48 | 2 |

- 测什么：用 disposable 临时仓库中的真实 `read_file/grep/glob/edit_file/bash` 工具，跑 `node --test`；工作流是 `search → read → test(fail) → edit → retest(pass) → finish`。`evals/long-horizon/fixture.js:31,40-63,553-635`。
- 如何断言：初次测试失败、最终测试通过、目标 patch 正确、required reads 满足、只修改允许的文件、workspace 文件集合不变、没有越界写入、bash 命令和 `cwd` 受限、protocol complete；`failed-edit-recovery` managed 必须至少有 1 次 tool failure；`large-context-fix` managed 必须 compaction≥1、peak 低于 baseline。`evals/long-horizon/fixture.js:190-331`；`evals/long-horizon/suite.js:53-109`。
- Mock 边界：
  - 不是真实模型写代码；mock 的 patch 来自 `EXPECTED_PATCHES`（`fixture.js:24-29`），状态机是硬编码的。
  - `finalTestsPassed` 读取的是会话里最后一次 `bash` 结果的 `exitCode`，**不是 scorer 独立重跑测试**；真实 workspace 只被用来读文件做 diff/patch 检查。
  - 测试输出和临时目录路径会影响 token 估算，所以 README 用 “approx.”。`evals/long-horizon/fixture.js:672-681` 只把 bash duration 归零，不能消除所有环境文本差异。
  - managed 同时配置 DeterministicToolVisibility、SemanticProgressDetector、ContextManager compaction；报告显示 Progress Guard 在所有 case 都未触发（`reminderCount=0`、`progressStops=0`），compaction 只发生在 `large-context-fix`（2 次）。因此 64%/49% 只能说是 **managed 组合配置** 的结果，不能归因到 Progress Guard，也不能说 Compaction 普遍贡献了 49%。
- 不能外推：不能当作 SWE-bench/真实 coding benchmark/模型能力排行。它证明的是 harness 工具链、文件策略、测试观察、协议完整性的工程闭环。

### 3.4 Progress（README 没有表格，但属于 7 个 suite）

- 套件：`progress`；variants：`baseline, remind, guarded`；cases：6；样本：18；18/18 成功；stopReason 分布：`completed=15, step_limit=2, no_progress=1`。
- 报告实际汇总：

| Variant | cases/success | avgSteps | avgToolCalls | avg estimated input/run | total estimated input | total requests | no-progress stops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 6/6 | 8 | 7.3333 | 6151 | 36906 | 48 | 0 |
| remind | 6/6 | 7.3333 | 6.6667 | 5685.67 | 34114 | 44 | 0 |
| guarded | 6/6 | 4.8333 | 4.1667 | 2382.33 | 14294 | 29 | 1 |

- 关键 case：
  - `exact-repeat-recovery` / `argument-churn-recovery`：baseline 在第 6 次请求才恢复；remind/guarded 在收到 `[Harness progress notice]` 后恢复，步骤更少。`evals/progress/fixture.js:136-150`。
  - `legitimate-refinement` / `state-change` / `mixed-parallel-progress`：guarded 不能误停，报告均 `completed`。
  - `unrecoverable-stall`：baseline/remind 停在 `step_limit`（20 步），guarded 停在 `no_progress`（5 步）；guarded 的 steps/toolCalls/estimatedInputTokens 分别为 5/5/2567，baseline 为 20/20/22297，降幅 75%/75%/88.49%。
- Mock 边界：完全确定性；`success=true` 对 `unrecoverable-stall` 仍成立，因为预期就是 `no_progress`。不能用它证明真实模型的“重复检测准确率”。

### 3.5 Fault Injection

- 套件：`fault-injection-core-runtime`；variant：`default`；cases：11；样本：11；11/11 成功。
- stopReason 分布：`completed=4`、`internal_error=3`、`cancelled=2`、`tool_failure_limit=1`、`context_overflow=1`。
- 实际 case 级证据：

| Case | injected fault | stopReason | 额外断言 |
| --- | --- | --- | --- |
| llm-provider-error | `llm.before_request` → throw_provider_500 | internal_error | providerFailureCode=PROVIDER_500；trace.step=1；requests=1 |
| llm-pending-cancel | `llm.before_request` → wait_for_external_cancel | cancelled | providerTimeoutPolicy=not_implemented；trace.step=1 |
| tool-error-recovery | `tool.execute` → throw_execution_error | completed | 1 次 execution_error；requests=3 |
| tool-error-limit | 2 次 `tool.execute` 失败 | tool_failure_limit | 2 次 execution_error；maxToolFailures=2 |
| tool-timeout | `tool.before_execute` → await_runtime_timeout | completed | errorCode=timeout；trace status=timeout |
| invalid-tool-args | `llm.after_request` → invalid_tool_args | completed | errorCode=invalid_arguments |
| unknown-tool | `llm.after_request` → unknown_tool | completed | errorCode=unknown_tool |
| parallel-cancel | 两个 slow tool barrier_cancel | cancelled | 3 calls/3 results；2 个 cancelled + 1 个 completed |
| context-overflow | `context.before_prepare` → verify_hard_pressure | context_overflow | 1 call/1 result；无 compaction；committed step 完整 |
| post-commit-dispatch-failure | `scheduler.before_batch` → throw_dispatch_error | internal_error | 1 个 synthetic result：outcome=not_executed、skipReason=internal_error |
| side-effect-no-retry | 第 2 次 `llm.before_request` → throw_provider_500 | internal_error | sideEffectExecutionCount=1，不重试 |

数据路径：`.eval/fault-injection.json#/results[*]/scoreDetails`；注入点定义：`evals/fault-injection/fault-injector.js:1-9`。

- 如何抵抗假阳性：`evals/fault-injection/suite.js:42-55` 要求每个 case `success`、stop reason 匹配、protocolComplete、caseInvariant 同时成立；caseInvariant 会检查故障实际发生、tool error code、cancelled result 数量、unknown/not_executed 语义。`evals/fault-injection/fixture.js:453-549`。
- Mock 边界：这是故障注入测试，不是真实 provider 故障演练；`providerTimeoutPolicy=not_implemented`（`fixture.js:465-472`）。不能声称“支持 provider 超时自动重试”。

### 3.6 Crash Recovery

- 套件：`crash-resume-recovery`；variant：`default`；cases：5；样本：5；5/5 成功；stopReason 全部 `completed`。
- 实际 case 级证据：

| Case | recovered unknown | external effect | 恢复后副作用执行 | 关键断言 |
| --- | ---: | ---: | ---: | --- |
| crash-after-user-message | 0 | 0 | 0 | durable user message 仍在 resume 请求中 |
| crash-after-tool-call-commit | 1 | 0 | 0 | unknown 被恢复为 `{recovered:true,retryable:false}` |
| crash-after-side-effect-start | 1 | 1 | 0 | tool call 已 durable、副作用已发生、resume 不重放 |
| crash-after-tool-result-commit | 0 | 1 | 0 | durable result fidelity；再次 reopen 只 1 个 tool/result |
| torn-tool-result-tail | 1 | 0 | 0 | torn tail 被检测并恢复，JSONL 所有行可解析 |

- 机制：`process-runner.js` 在收到 checkpoint 后 `SIGKILL`（`evals/crash-recovery/process-runner.js:39-67`）；`test/fixtures/crash-worker.js:24-97` 写入 JSONL、torn tail；resume 阶段重新 `SessionRuntime.open()`（`test/fixtures/crash-worker.js:181-240`）。
- 如何抵抗假阳性：检查 unknown 数量、`retryable=false`、外部效果计数、恢复后副作用执行次数为 0、sequence 连续、protocol 完整、raw lines 全部 JSON 可解析、`doubleRestartIdempotent`；`evals/crash-recovery/fixture.js:79-205`。
- 边界：报告里 `totalRequestCount=0`、`estimatedInputTokens=0` 只是因为 crash fixture 不采集 LLM 请求，不能解释为“恢复不需要 token”。它也不提供分布式 exactly-once；README.md:166-168 的 “no blind retry under uncertain side effects” 是准确表述。

### 3.7 MCP Failure

- 套件：`mcp-failure-lifecycle`；variant：`default`；cases：9；样本：9；9/9 成功；stopReason 全部 `completed`。
- 实际关键状态：

| Case | 关键实际值 |
| --- | --- |
| activation-failure-cleanup | broken=`FAILED`；registeredToolNames=[]；toolLeakCount=0；errorRedacted=true |
| mixed-server-isolation | broken=`FAILED`、fake=`ACTIVE`；healthyServerUsable=true；brokenToolAbsent=true；leak=0 |
| disconnect-removes-tools | fake=`DISCONNECTED`；staleToolReturnedUnknown=true；toolErrorCode=unknown_tool；leak=0 |
| reload-restores-tools | fake=`ACTIVE`；reloadCreatedNewFiber=true；toolRegistrationCount=1；leak=0 |
| stale-schema-after-disconnect | staleSchemaVisible=true；unknown_tool；modelSawToolFailure=true；protocolComplete=true；leak=0 |
| active-plugin-tool-execution-failure | managerStateAfterToolFailure=`ACTIVE`；toolFailures=1；errorCode=execution_error；modelSawToolFailure=true；leak=0 |
| cleanup-failure-retry | first=`FAILED` → second=`DISCONNECTED`；cleanupRetried=true；registeredToolNames=[] |
| reload-cleanup-failure | first=`FAILED`；activationAttempts=1；reloadCreatedNewFiber=false；oldToolRetained=true |
| manager-dispose-partial-failure | first dispose 后 server-a=DISCONNECTED、server-b=FAILED、仍有 1 个工具；第二次 dispose 后 finalManagerDisposed=true、无工具 |

- 如何抵抗假阳性：`caseSuccess()` 逐 case 检查状态、工具泄漏、stale schema 行为、模型可见错误、清理重试和最终销毁。`evals/mcp-failure/suite.js:108-191`。
- 边界：全是本地 fake plugin（`evals/mcp-failure/fixture.js:15-17`），不是远程 MCP chaos/健康检查；`ACTIVE` 只表示 Cordis plugin fiber 激活成功，不保证远端可用。README.md:170 的说明准确。
- **报告缺陷**：`stale-schema-after-disconnect` 和 `active-plugin-tool-execution-failure` 两个 agent case 的 token/tool 指标是 `null`：`.eval/mcp-failure.json` 中这两个 result 的 `visibleToolCount=null`、`estimatedInputTokensByStep=[null,null]`、summary 的 `avgVisibleTools=null`、`totalEstimatedInputTokens=null`。原因是 `evals/mcp-failure/fixture.js:52-56` 把 `state.result.requests` 原样返回，而 `runAgentCase` push 的是原始 LLM request 对象（`fixture.js:157-165,214`）；EvalRunner 需要 `RecordingTokenMeter` 产生的 `{visibleToolCount, toolSchemaTokens, estimatedInputTokens}` 记录（`src/eval/eval-runner.js:166-203`），`undefined` 经 reduce 变成 `NaN`，JSON 序列化成 `null`。这只影响指标展示，不影响 9/9 的 MCP 契约断言；但面试中不要引用 MCP suite 的 token 数字。

## 4. Coding Benchmark V1 / real-model benchmark boundaries

### 4.1 Current docs and code (HEAD 4b7243c)

- `README.md:215`, `BENCHMARK.md:5`, and `BENCHMARK.zh-CN.md:5` all describe Coding Benchmark V1: 16 local reproducible cases. Quote BENCHMARK.md:5: "B1 contains 16 formal local Coding cases: four single-file bugfixes, four cross-file bugfixes, four features, and four repository-understanding / refactor / long-context tasks. The earlier `coding-smoke` case remains an infrastructure smoke test; it is separate from the formal `coding-benchmark` suite. Reports are reproducibility artifacts and do not support model rankings or success-rate claims."
- `benchmarks/coding/suite.js:18-26` defines `createCodingBenchmarkV1Suite()` with `loadCodingCases()`; `benchmarks/coding/loader.js:19,32-35` loads 16 case specs; `src/benchmark/benchmark-cli.js:2,15` uses V1.
- The earlier one-case `createCodingBenchmarkSuite()` / `bugfix-single-file` smoke suite remains at `benchmarks/coding/suite.js:7-16` and `benchmarks/coding/smoke-case.js:1-11`; it is separate from formal V1.
- `scripts/validate-coding-benchmark.js:5` validates the 16 reference solutions, verifiers, and workspace policies without network/model calls; it does not produce real-model results.
- Boundary: no committed real-model benchmark report exists; docs explicitly say reports are reproducibility artifacts and do not support model rankings or success-rate claims.

### 4.2 metrics 与 cost 语义

- Both V1 and smoke suites reuse `EvalRunner`, so samples contain `success/stopReason/steps/toolCalls/toolErrors/requestCount/inputTokens/outputTokens/reasoningTokens/cost/estimatedInputTokens/toolSchemaTokens/visibleToolCount/durationMs`. `src/benchmark/benchmark-runner.js:62-88`.
- `toolErrors` 来自 Session 的 `tool/result.isError`，不是从 Trace 猜测；`src/benchmark/benchmark-runner.js:36-48`。
- `cost` 语义：
  - DeepSeek adapter 的 `normalizeUsage()` 明确返回 `cost: null`。`src/models/deepseek.js:107-121`。
  - `CostEstimator` 只在调用方提供 pricing 时才估算；`cost=null` 表示 unknown，不是 0。`src/core/cost-estimator.js:5-23,39-65`。
  - `summarizeBenchmark()` 的 `costAvailability` 为 `available/partial/unavailable`，`totalKnownCost` 只累加 known samples；`isKnown` 要求 finite number。`src/benchmark/benchmark-report.js:36-74`。
  - `--max-total-cost` 是**准入预算**：在启动下一个 sample 前检查 `totalKnownCost >= maxTotalCost`；不会终止正在运行的一个 Run，所以一个 sample 可以让实际成本越过 ceiling。`src/benchmark/benchmark-runner.js:29-35,89-94`；BENCHMARK.md:80,82-83。
  - 缺少 DeepSeek pricing 时，`--max-total-cost` 会在启动前失败；运行中发现 `cost=null` 且未 `--allow-unknown-cost`，会停止后续 admission 并以 `budgetStopReason='unknown_cost'` 退出非零。`src/benchmark/benchmark-cli.js:31-42,50-52`；`src/benchmark/benchmark-runner.js:89-94`；BENCHMARK.md:52-53,74,80。
  - `--allow-unknown-cost` 允许继续，但 total ceiling 无法完全执行，这也是文档明确写的边界。`BENCHMARK.md:52-53`；测试 `test/benchmark.test.js:177-211`。
- 为何不能当模型能力排行：
  - Docs state reports do not support model rankings (`BENCHMARK.md:5`); no committed real-model report exists.
  - The 16 V1 cases are deterministic case definitions; `minimal/full` are combined harness configurations and cannot support ablation/ranking.
  - 样本依赖临时 workspace、provider、model、pricing；DeepSeek provider usage 的 `cost` 默认 null，不能直接算“性价比”。
  - `minimal/full` 与 long-horizon 一样是组合配置差异（工具可见性/上下文策略/progress detector），不能做单因素归因。
  - `validate` only proves reference solutions pass all 16 cases; it does not prove model capability.

## 5. 如何向面试官可信地讲评测

> Current worktree note: README.md:215 / BENCHMARK.md:5 / BENCHMARK.zh-CN.md:5 all describe Coding Benchmark V1 (16 cases). No real-model report is committed, so these documents cannot support a model ranking.

1. 先区分三类东西：
   - **Synthetic Eval**：`.eval/*.json`，Mock LLM，确定性脚本，证明 Harness 行为/协议/边界。
   - **Real-model Coding Benchmark**: Coding Benchmark V1 has 16 cases and real-provider wiring; BENCHMARK.md now also describes V1 (HEAD 4b7243c). No real-model report is committed, so it is not a ranking.
   - **Provider usage / billed cost**：`.eval` 全是 `unavailable`；`cost=null` 是 unknown，不是 0。
2. 讲指标时先说测量口径：
   - `estimatedInputTokens` 来自 `TokenMeter` 的 UTF-8 bytes / 3 启发式，不是 provider tokenizer；`src/core/token-meter.js:1-15`。
   - `avgVisibleTools` 是总 tool exposure / 请求数；`visibleToolCount` 是每次请求的工具 schema 数求和，不是 distinct tool。
   - Context Pressure 的 peak/cumulative 只统计真正到达 `llm.chat()` 的请求；planner/internal estimates 不计入。`evals/context-pressure/suite.js:76-79`；`test/context-pressure-eval.test.js:31-42`。
3. 讲结论时必须带“不能外推”：
   - Mock 是硬编码状态机/关键词；不能证明真实模型会选对工具、写对补丁、做语义压缩。
   - Tool Routing 的跨语言 case 是 mock 直接用 metadata 里的英文 query，不能证明跨语言语义。
   - Long-Horizon 的 patch 是硬编码，测试通过来自模型可见 bash 结果而非独立 rerun。
   - Context Pressure 的 summary safety 是字符串/角色级检查，不是语义忠实度。
   - Managed/Full 是组合变体，不能归因单一机制；报告里 Progress Guard 实际未触发。
4. 讲可靠性时强调“证据被断言”：
   - Fault injection 不是只测 stop reason，还测 fault 是否真发生、tool/result 配对、cancelled 数、side effect 计数。
   - Crash recovery 是真 SIGKILL + JSONL reopen，unknown outcome 明确 `retryable=false`，恢复后不重放副作用。
   - MCP Failure 是本地 lifecycle fake，不是远端 MCP chaos。
5. 报告数据先自己复核：
   - `.eval/*.json` 是 gitignored 本地报告，检查 `successes/cases`、stopReason、compactionCount、scoreDetails。
   - 不要引用 MCP suite 两个 null 指标。
   - Do not cite V1 benchmark reports as real-model results unless a real-model report is actually committed.

## 6. 评测相关追问与精确答案要点（12 个）

1. **“你们的 Evaluation 为什么不算 benchmark 排行？”**
   Answer: `.eval` is synthetic Mock LLM data, not a real-model benchmark. Coding Benchmark V1 has 16 local cases and real-provider wiring, but no real-model report is committed; the docs explicitly say reports do not support model rankings or success-rate claims.

2. **“estimated input 和 provider usage 有什么区别？”**
   答：`estimatedInputTokens` 是 `TokenMeter` 对 system+messages+tools 的 bytes/3 估算（`src/core/token-meter.js:9-14`）；provider input tokens 来自 adapter usage，`.eval` 报告全部 `unavailable`。两者不能混用，更不能当计费。

3. **“Context Pressure 的 72%/57% 分别怎么算？”**
   答：peak：`(5697-1578)/5697=72.30%`；cumulative：`(20884.33-9039.67)/20884.33=56.72%`；数据来自 `.eval/context-pressure.json`。注意 constrained 没参与这两个降幅，因为它是 NoopCompactionPlanner 的溢出基线。

4. **“constrained success=true 是不是说明它完成了任务？”**
   答：不是。`success` 只表示匹配预期 stop reason（`context_overflow`），`finishSucceeded=false`；`evals/context-pressure/fixture.js:287-299`。这正是“early termination 不是优化成功”的体现。

5. **“为什么 Progressive schema tokens 更低，但 estimated input 更高？”**
   答：Progressive 首轮只暴露少量 schema，但需要额外一次 `tool_search` 请求；总请求数 15 vs Deterministic 10，所以 avg estimated input/run 1016.2 > 786.8。报告数据 `.eval/tool-routing.json`。

6. **“Tool Routing 的跨语言 case 证明了什么？”**
   答：只证明 `tool_search` + activation 链路能在中文 prompt 的 case 中把 target tool 暴露出来；mock 实际使用 metadata `searchQuery='github issues'`（`evals/tool-routing/fixture.js:114-124`），没有让模型从中文 prompt 生成 query，不能证明真实跨语言语义能力。

7. **“Long-Horizon managed 的收益来自 Progress Guard 吗？”**
   答：不能这么说。managed 同时开启 tool routing、progress detector、context compaction；报告显示 5 个 case 的 `reminderCount=0`、`progressStops=0`，Progress Guard 没触发；compaction 只在 `large-context-fix` 触发 2 次。收益主要来自 deterministic visibility，以及该 case 的 compaction，不能做单因素归因。

8. **“Crash Recovery 的 no blind retry 怎么证明？”**
   答：`crash-after-side-effect-start` 中外部副作用已写 1 次，resume 后 `sideEffectExecutionCountAfterResume=0`，recovered unknown 为 `{recovered:true,retryable:false}`；scorer 还检查 JSONL 可解析、sequence 连续、协议完整。`evals/crash-recovery/fixture.js:140-177,185-198`。

9. **“Fault Injection 和真实故障演练区别是什么？”**
   答：故障由 `FaultInjector` 在 7 个 point 上按 occurrence 确定性注入（`evals/fault-injection/fault-injector.js:1-9`）；mock provider 不是真实网络。它能证明 handler/协议语义，不能证明真实 provider 超时策略，且 `llm-pending-cancel` 明确 `providerTimeoutPolicy='not_implemented'`。

10. **“MCP Failure 能证明远端 MCP 健康吗？”**
    答：不能。`evals/mcp-failure/fixture.js:15-17` 用的是本地 fake plugin；`ACTIVE` 仅代表 Cordis fiber 激活；README.md:170 已说明不是远程 MCP chaos/health detection。

11. **“Is `cost=null` in Coding Benchmark V1 free?”**
    答：不是。`src/models/deepseek.js:120` 返回 `cost:null`；`cost=null` 表示 unknown，不是 0。`CostEstimator` 只有 pricing JSON 才能估算（`src/core/cost-estimator.js:10-17`）；`totalKnownCost` 只累加 known samples。`--max-total-cost` 缺少 pricing 会在启动前失败，运行中发现 unknown 会停止后续 admission。

12. **“为什么 `--max-total-cost` 不能严格保证不超预算？”**
    答：它是每个 sample 前的 admission threshold；检查发生在 sample 启动前，不会终止已开始的 Run，所以一个 sample 可能让总成本超过 ceiling。`src/benchmark/benchmark-runner.js:29-35,89-94`；BENCHMARK.md:82-83；`test/benchmark.test.js:177-189` 用 `cost=0.4, maxTotalCost=0.5` 展示只跑 1 个 sample 且其 cost 已 > 0.5。

## 7. 关键测试策略与覆盖点

- **`test/parallel-tool-scheduler.test.js`**：safe calls 分区与 barrier（:15）、maxParallel 默认 4 与环境校验（:45）、并行完成顺序不改变 Session 顺序/映射/replay（:62）、exclusive 串行 barrier（:117）、worker pool 不超限（:161）、错误/超时隔离（:186）、外部取消下完整协议（:229）、scheduler 失败后 synthetic result/已 settle 结果保留（:283,320）、reverse completion 顺序（:400）、已启动 call unknown 不重试（:448）、run deadline（:550）、tool-call budget 准入（:593）、observer 隔离（:654,690）。
- **`test/run-governance.test.js`**：CostEstimator cache 分区（:13）、边界 unknown 不造 0（:39）、生产 policy 默认/env null（:50）、整数校验（:79）、cost_limit（:93）、deadline abort LLM/tool（:125,151）、external abort 优先（:191）、onStop 回调失败隔离（:220,248）、snapshot（:278）。
- **`test/context-pressure-eval.test.js`**：3 variants/3 cases（:11）、planner estimates 不污染实际请求（:31）、full/constrained/compacted 行为（:44）、1900/200 policy（:62）、peak/cumulative 降低（:70）、marker 保留（:78）、protocol boundary（:103）、summary safety/durable events（:110）、确定性（:126）。
- **`test/context-compaction.test.js`**：normal/disabled 只读（:23）、soft/hard compaction（:40,80）、project 不修改 Event Log（:92）、连续性字段和 tool truncation（:106）、单个/多 tool compaction 边界（:141,165）、not_executed protocol 边界（:185）、非法 compaction 回退（:207,299）、reset/lineage（:231,249,259,280,331）、role safety（:359）、重复 compaction（:431）、重启可复现（:452）、hard 无安全边界直接 overflow（:483,514）。
- **`test/context-manager.test.js`**：projection/parallel order/resume（:15,67,83,109,157,226）。
- **`test/context-policy*.test.js`**：pressure 状态边界、env 配置校验、RunPolicy/ContextPolicy 独立。
- **`test/eval-framework.test.js`**：suite/case 校验（:21,50）、失败隔离（:69）、assertions 使 CLI 失败（:88）、scorer 上下文与 limits（:103）、schema/null usage（:138）、reporter（:156）、dispose 语义与异常路径（:180,214,237,261,282,300）、limit 透传（:318）。
- **`test/eval-runner.test.js`**：variant 顺序（:10,35）、stop-reason/target-tool scorer（:54,89）、失败 case 隔离（:106）、RecordingTokenMeter（:135）、duration 排除 setup/dispose（:167）、真实 Trace（:190）、unknown usage 不为 0（:209）、功能指标确定性（:254）、progressive 跨语言/large catalog（:278）、CapturingTraceRuntime 契约（:356）。
- **`test/fault-injection-eval.test.js`**：FaultInjector 确定性（:20）、protocol helper（:45）、矩阵解析（:53）、provider/cancel、tool recovery/limit、timeout/invalid/unknown、parallel cancellation、context overflow、scheduler/side effect（:86-159）、report 确定性（:159）、fixture 异常仍保留证据（:168）。
- **`test/crash-recovery-eval.test.js`**：真实进程重启矩阵、5 结果、protocol/sequence、unknown/no blind retry、torn tail、result fidelity（:7-41）、report 确定性（:43）。
- **`test/long-horizon-eval.test.js`**：suite 定义/隔离（:18）、两 variant 工作区/协议（:38）、empty search 不误报（:80）、failed edit 恢复（:89）、large context compaction（:103）、确定性（:113）、scorer workspace 检查（:122）、拒绝无关修改（:143）、write 不等于最终 diff（:167）。
- **`test/mcp-failure-eval.test.js`**：9 个 lifecycle/stale/remote-like 断言（:7-48）、report 确定性（:50）。
- **`test/benchmark.test.js`**：repeat 隔离/IDs/workspace 清理（:88）、filters（:123）、dry-run 不触网（:133）、budget 只准入完整 sample 且 unknown 不为 0（:177）、toolErrors 来源（:213）、scorer 拒绝意外文件（:220）、缺 pricing preflight（:240）。

## 8. 证据速查

- README Evaluation：`README.md:107-150`。
- Tool Routing 报告：`.eval/tool-routing.json#/variants`、`#/results`。
- Context Pressure 报告：`.eval/context-pressure.json#/variants`、`#/results`；policy `evals/context-pressure/fixture.js:12-16`。
- Long-Horizon 报告：`.eval/long-horizon.json#/variants`、`#/results`；scorer `evals/long-horizon/fixture.js:190-331`。
- Progress 报告：`.eval/progress.json#/variants`。
- Fault Injection 报告：`.eval/fault-injection.json#/results[*]/scoreDetails`。
- Crash Recovery 报告：`.eval/crash-recovery.json#/results[*]/scoreDetails`。
- MCP Failure 报告：`.eval/mcp-failure.json#/results[*]/scoreDetails`；指标缺陷 `evals/mcp-failure/fixture.js:52-56,150-215`。
- Real-model Benchmark docs: `README.md:215`, `BENCHMARK.md:5`, `BENCHMARK.zh-CN.md:5`; cost/CLI sections `BENCHMARK.md:45-54,62,70-83`.
- Real-model Benchmark code: `src/benchmark/benchmark-runner.js:29-35,62-94,101-130`; `src/benchmark/benchmark-report.js:36-74`; `src/models/deepseek.js:107-121`; `src/core/cost-estimator.js:5-65`.
