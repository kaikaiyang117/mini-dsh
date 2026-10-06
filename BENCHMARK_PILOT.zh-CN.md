# Coding Benchmark V1 Pilot

> 本 Pilot 用于校准 Dataset 与 Harness，不是最终模型性能报告。它没有 control group、重复实验或消融，不能据此声称 mini-dsh 提升了成功率。

## 实验目的

使用单一真实模型完成 Coding Benchmark V1 的 16 个正式 Case，检查 Case、Scorer、Harness 与 Provider 的有效性，并判断是否满足进入 B2 的条件。

## 环境

| 项目 | 值 |
| --- | --- |
| Pilot 代码 commit | `eef65f2fd0a6756e64f3ec382d9ffc79dc6177f0` |
| 基线 commit | `c9b830c228bbf333111403e8b3362ab81c4c94c4` |
| 模型 | `deepseek/deepseek-v4-pro` |
| Variant | `full` |
| Repeat | 1 |
| 正式 Case 数 | 16 planned / 16 completed |
| Node / 平台 | `v22.21.1` / `darwin arm64` |
| 时间 | 2026-10-06 16:14:59–16:24:15 UTC |
| Cost | unavailable；未配置可靠 Pricing，使用 `--allow-unknown-cost`，不估造金额 |

Preflight：`pnpm test` 288/288、`pnpm check`、`pnpm lint`、`pnpm benchmark:coding:validate` 16/16 均通过。Dry-run 确认 `full`、repeat 1、16 planned runs，未访问模型。7 个现有 `eval:*` 均通过；它们是离线合成评估，不计入 Pilot。

Canary：`clamp-boundaries`、`config-precedence`、`nested-secret-redaction` 均通过首轮 Canary 的行为与协议检查。审计发现后两项的初始报告审计字段因过长 Tool 输出而被截断；该 Benchmark 报告缺陷已在 Pilot commit 前修复并增加回归测试。两个受影响 Case 的非正式 recheck 中，nested redaction 成功；config precedence 因模型只运行了通过测试、没有观察修复前失败而按 Scorer 契约判为 `agent_failure`。Recheck 不计入正式 Pilot 结果，初始 `.benchmark/pilot-canary.json` 保持原样。

## Case Matrix

表中 `steps/calls/errors` 分别为步骤数、Tool 调用数、Tool 错误数；`input/output` 为 Provider token；`estimated` 与 `schema` 为估算输入和 Tool Schema token；`pub/hidden/protocol` 与 `observed fail/pass` 使用 Y/N；`unexpected` 是额外修改文件。完整原始字段保存在 `.benchmark/pilot-v1.json`，本表不包含 Prompt、Reasoning 或完整 Event Log。

| Case | Category | Difficulty | Result / failureCategory | stopReason | steps/calls/errors | requests | input/output | estimated | schema | duration ms | pub/hidden/protocol | unexpected | observed fail/pass |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| clamp-boundaries | single-file-bugfix | easy | success | completed | 7/7/1 | 7 | 11078/761 | 11617 | 3003 | 17452 | Y/Y/Y | none | Y/Y |
| retry-count-off-by-one | single-file-bugfix | easy | success | completed | 6/8/3 | 6 | 14329/2321 | 16009 | 2574 | 31337 | Y/Y/Y | none | Y/Y |
| duration-zero-handling | single-file-bugfix | easy | success | completed | 5/5/1 | 5 | 7309/529 | 7546 | 2145 | 11229 | Y/Y/Y | none | Y/Y |
| stable-deduplication | single-file-bugfix | easy | agent_failure | completed | 5/4/1 | 5 | 6220/571 | 6369 | 2145 | 11147 | Y/Y/Y | none | N/Y |
| config-precedence | cross-file-bugfix | medium | success | completed | 7/9/1 | 7 | 14125/898 | 15567 | 3213 | 22681 | Y/Y/Y | none | Y/Y |
| cache-invalidation | cross-file-bugfix | medium | harness_failure | internal_error | 8/7/1 | 8 | 12282/2487 | 17685 | 1840 | 36962 | N/N/Y | none | Y/N |
| rename-index-consistency | cross-file-bugfix | medium | agent_failure | completed | 9/8/2 | 9 | 15383/1463 | 16440 | 3861 | 20652 | Y/Y/Y | none | N/Y |
| plugin-disable-state | cross-file-bugfix | medium | harness_failure | internal_error | 7/13/1 | 7 | 13055/4782 | 23079 | 3003 | 54730 | N/N/Y | none | Y/N |
| cache-ttl | feature | medium | agent_failure | completed | 6/6/0 | 6 | 10947/1739 | 12586 | 2574 | 23378 | Y/Y/Y | none | N/Y |
| pagination-filter | feature | medium | agent_failure | completed | 6/7/1 | 6 | 9339/708 | 10047 | 2574 | 11749 | Y/Y/Y | none | N/Y |
| event-once-listener | feature | medium | success | completed | 6/6/0 | 6 | 12767/5745 | 15289 | 2700 | 72749 | Y/Y/Y | none | Y/Y |
| csv-export | feature | medium | success | completed | 7/7/1 | 7 | 15996/2704 | 17526 | 3003 | 35819 | Y/Y/Y | none | Y/Y |
| nested-secret-redaction | repo-understanding-refactor-long-context | hard | agent_failure | completed | 9/13/4 | 9 | 17757/1857 | 21308 | 3861 | 26654 | Y/Y/Y | none | N/Y |
| route-normalization | repo-understanding-refactor-long-context | hard | harness_failure | internal_error | 8/13/1 | 8 | 16335/3754 | 23405 | 3600 | 42670 | Y/Y/Y | none | Y/Y |
| dependency-order | repo-understanding-refactor-long-context | hard | harness_failure | internal_error | 10/18/5 | 10 | 18938/2399 | 26840 | 4290 | 30535 | Y/Y/Y | none | Y/N |
| validation-refactor-regression | repo-understanding-refactor-long-context | hard | harness_failure | internal_error | 7/6/4 | 7 | 10390/4619 | 16497 | 1757 | 56598 | Y/N/Y | none | N/Y |

## Aggregate Result

16/16 runs completed; 6 succeeded (37.5% descriptive result). Mean steps 7.06, Tool calls 8.56, Tool errors 1.69, requests 7.06, input tokens 12890.63, output tokens 2333.56, estimated input tokens 16113.13, Tool Schema tokens 2883.94, duration 31646.38 ms. Cost unavailable. There were no skipped samples or budget stops.

| Difficulty | Cases | Success | Agent failure | Harness failure |
| --- | ---: | ---: | ---: | ---: |
| easy | 4 | 3 | 1 | 0 |
| medium | 8 | 3 | 3 | 2 |
| hard | 4 | 0 | 1 | 3 |

| Category | Cases | Success |
| --- | ---: | ---: |
| single-file-bugfix | 4 | 3 |
| cross-file-bugfix | 4 | 1 |
| feature | 4 | 2 |
| repo-understanding-refactor-long-context | 4 | 0 |

## Failure Classification

| Category | Count | Cases |
| --- | ---: | --- |
| success | 6 | clamp-boundaries, retry-count-off-by-one, duration-zero-handling, config-precedence, event-once-listener, csv-export |
| agent_failure | 5 | stable-deduplication, rename-index-consistency, cache-ttl, pagination-filter, nested-secret-redaction |
| harness_failure | 5 | cache-invalidation, plugin-disable-state, route-normalization, dependency-order, validation-refactor-regression |
| benchmark_failure | 0 | none found in the official Pilot |
| provider_failure | 0 | no availability, timeout, or transport failure observed |
| budget_stop | 0 | no budget stop |

Agent failures are valid task outcomes: in all five, public and hidden tests passed, the expected file was modified, the workspace policy and Tool protocol passed, but the Agent did not observe a failing pre-change test. The Scorer correctly rejected these under the case contract requiring the Agent to run tests before and after the change. This is not a Scorer false negative.

## Case Findings

All 16 workspaces had valid baselines, complete Tool call/result protocols, and no unexpected modified files. All six scored successes changed an expected source file and passed public and hidden verification. Five Agent failures also produced behavior accepted by both test layers, but lacked observed failing-test evidence. The remaining five runs stopped with `internal_error`; their individual test/verifier results are retained in the Case Matrix and raw report.

Hard Case review: nested redaction changed the intended shared implementation and passed both verifiers but missed the failing baseline run; route normalization changed the expected file and passed all verification before a Provider request error; dependency order changed the expected file but did not record a passing test before the same error; validation refactor did not pass the hidden structural verifier. These are not evidence that the Hard Cases are unsolvable or that the Verifier is wrong.

Tag observations are descriptive only: `long-context` had 0/4 successes, `state-consistency` 0/4, `search-heavy` 1/4, and `multi-file` 1/8. Harness failures overlap these tags, so they cannot support a causal conclusion. No B2 comparison or inference is made.

## Benchmark Issues Found

The initial Canary exposed a report-size defect: full shell stdout/stderr could push scorer details past EvalRunner's serialization bound, leaving audit fields empty. The scorer now keeps only command, exit code, signal, and duration for Agent test runs. A large-output regression test passes. This fix is in commit `eef65f2`; it changes reporting evidence only, not Prompts, Cases, limits, Scoring rules, workspace policy, or Variant behavior. No unresolved Benchmark issue or false positive/negative was found in the official 16 samples. No Case or Prompt was adjusted.

## Harness Issues Found

Five samples (`cache-invalidation`, `plugin-disable-state`, `route-normalization`, `dependency-order`, `validation-refactor-regression`) ended with the same DeepSeek HTTP 400: `The reasoning_content in the thinking mode must be passed back to the API.` The report shows complete local Tool protocols for all five, and the API error is the recorded terminal cause. DeepSeek's [Thinking Mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/) requires prior `reasoning_content` to be preserved in subsequent requests whenever tools are supplied; omission produces this 400 error.

Minimal reproduction: enable DeepSeek thinking mode, make a tool-enabled chat request that returns `reasoning_content`, execute its tool call, then send the next request with the projected conversation history. The current model adapter stores reasoning text on assistant tool-call events and the context projector re-emits it when present; the 400 indicates at least one required prior reasoning field was absent from the actual request. The Pilot JSON intentionally excludes full Event Logs, so it cannot identify whether the loss came from a compacted history or a response with absent reasoning text. A separate runtime investigation should capture only presence/absence and message sequence metadata, then add a deterministic regression test. This is an unresolved production Harness/Provider-integration issue; do not patch it in the Pilot branch.

The model endpoint was reachable and did return structured 400 responses, so these are classified as `harness_failure`, not provider availability failures. No `tool/result` protocol violation was observed. A runtime fix should be handled on a separate `fix/runtime-...` branch before rerunning affected Cases.

## Limits

No sample reached `maxSteps=20`, `maxToolCalls=32`, or `maxDurationMs=120000`; the maximum observed was 10 steps, 18 Tool calls, and 72749 ms. Keep the limits unchanged. The failed Runs stopped on the API protocol error, not a budget limit.

## Limitations

This is one model, one Variant, one repetition, and a descriptive calibration run. Cost is unavailable. The five Harness failures prevent treating the observed success count as a stable estimate. No control group or ablation was run. The raw, unedited report is `.benchmark/pilot-v1.json`; it contains no reasoning content, full Prompt, or full Event Log.

## Decision for B2

**READY_FOR_B2 = false.** The blocking item is the unresolved DeepSeek thinking-mode `reasoning_content` preservation defect affecting five Cases. The 16 Case dataset and Scorer otherwise validated; keep all Cases and limits unchanged. Resolve the runtime issue separately, then rerun only affected Cases for calibration before approving B2.
