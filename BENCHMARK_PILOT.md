# Coding Benchmark V1 Pilot

> This Pilot calibrates the Dataset and Harness. It is not a final model-performance report. It has no control group, repeated experiment, or ablation, so it cannot support a claim that mini-dsh improved success rate.

## Experiment Purpose

Run all 16 formal Coding Benchmark V1 cases against one real model, inspect Case, Scorer, Harness, and Provider validity, and determine whether the B2 entry gate is satisfied.

## Environment

| Item | Value |
| --- | --- |
| Pilot code commit | `eef65f2fd0a6756e64f3ec382d9ffc79dc6177f0` |
| Base commit | `c9b830c228bbf333111403e8b3362ab81c4c94c4` |
| Model | `deepseek/deepseek-v4-pro` |
| Variant | `full` |
| Repeat | 1 |
| Formal cases | 16 planned / 16 completed |
| Node / platform | `v22.21.1` / `darwin arm64` |
| Time | 2026-10-06 16:14:59–16:24:15 UTC |
| Cost | unavailable; no reliable pricing was configured, so `--allow-unknown-cost` was used and no amount was fabricated |

Preflight: `pnpm test` passed 288/288, `pnpm check`, `pnpm lint`, and `pnpm benchmark:coding:validate` passed with 16/16 cases. Dry-run confirmed `full`, repeat 1, and 16 planned runs without contacting the model. All seven existing `eval:*` suites passed; they are offline synthetic evaluations and are not part of this Pilot.

Canary: `clamp-boundaries`, `config-precedence`, and `nested-secret-redaction` passed the initial behavioral and protocol checks. Audit found that scorer details for the latter two were truncated when full Tool output exceeded the report bound. This Benchmark reporting defect was fixed and regression-tested before the Pilot commit. In a non-official recheck of those two cases, nested redaction succeeded; config precedence was correctly classified as `agent_failure` because the model ran only passing tests and did not observe the pre-change failure. Rechecks are excluded from the formal Pilot; the initial `.benchmark/pilot-canary.json` remains unchanged.

## Case Matrix

`steps/calls/errors` are steps, Tool calls, and Tool errors; `input/output` are provider token counts; `estimated` and `schema` are estimated input and Tool Schema tokens; `pub/hidden/protocol` and `observed fail/pass` use Y/N; `unexpected` lists unexpected file modifications. The complete raw fields are in `.benchmark/pilot-v1.json`. This table excludes Prompts, reasoning, and full Event Logs.

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

All 16/16 runs completed; 6 succeeded (37.5%, descriptive only). Mean steps 7.06, Tool calls 8.56, Tool errors 1.69, requests 7.06, input tokens 12890.63, output tokens 2333.56, estimated input tokens 16113.13, Tool Schema tokens 2883.94, and duration 31646.38 ms. Cost is unavailable. No sample was skipped and no budget stop occurred.

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

Agent failures are valid task outcomes: all five passed public and hidden tests, changed the expected file, and passed workspace and Tool protocol checks, but the Agent did not observe a failing pre-change test. The Scorer correctly rejected these under the Case contract requiring tests before and after the change. This is not a Scorer false negative.

## Case Findings

All 16 workspaces had valid baselines, complete Tool call/result protocols, and no unexpected modified files. All six scored successes changed an expected source file and passed public and hidden verification. Five Agent failures also produced behavior accepted by both test layers but lacked observed failing-test evidence. The remaining five runs stopped with `internal_error`; their test and verifier results remain in the Case Matrix and raw report.

Hard Case review: nested redaction changed the intended shared implementation and passed both verifiers but missed the failing baseline run; route normalization changed the expected file and passed verification before a Provider request error; dependency order changed the expected file but did not record a passing test before the same error; validation refactor failed the hidden structural verifier. These results do not show that the Hard Cases are unsolvable or that the Verifier is wrong.

Tag observations are descriptive only: `long-context` had 0/4 successes, `state-consistency` 0/4, `search-heavy` 1/4, and `multi-file` 1/8. Harness failures overlap these tags, so they cannot support a causal conclusion. No B2 comparison or inference was made.

## Benchmark Issues Found

The initial Canary exposed a reporting-size defect: full shell stdout/stderr could exceed EvalRunner's scorer-detail bound and leave audit fields empty. The scorer now retains only command, exit code, signal, and duration for Agent test runs. A large-output regression test passes. This fix is in commit `eef65f2`; it changes reporting evidence only, not Prompts, Cases, limits, Scoring rules, workspace policy, or Variant behavior. No unresolved Benchmark issue or Scorer false positive/negative was found in the official 16 samples. No Case or Prompt was adjusted.

## Harness Issues Found

Five samples (`cache-invalidation`, `plugin-disable-state`, `route-normalization`, `dependency-order`, `validation-refactor-regression`) ended with the same DeepSeek HTTP 400: `The reasoning_content in the thinking mode must be passed back to the API.` The report shows complete local Tool protocols for all five, and the API error is the recorded terminal cause. DeepSeek's [Thinking Mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/) requires prior `reasoning_content` to be preserved in later requests whenever tools are supplied; omission produces this 400 error.

Minimal reproduction: enable DeepSeek thinking mode, send a tool-enabled chat request that returns `reasoning_content`, execute its tool call, then send another request with the projected conversation history. The current model adapter stores reasoning text on assistant tool-call events and the context projector re-emits it when present; the 400 indicates at least one required prior reasoning field was missing from the actual request. The Pilot JSON intentionally excludes full Event Logs, so it cannot identify whether the loss came from compacted history or a response with absent reasoning text. A separate runtime investigation should capture only presence/absence and message-sequence metadata, then add a deterministic regression test. This is an unresolved production Harness/Provider-integration issue; do not patch it in the Pilot branch.

The model endpoint was reachable and returned structured 400 responses, so these are classified as `harness_failure`, not Provider availability failures. No `tool/result` protocol violation was observed. Handle a runtime fix on a separate `fix/runtime-...` branch before rerunning affected Cases.

## Limits

No sample reached `maxSteps=20`, `maxToolCalls=32`, or `maxDurationMs=120000`; the maximum observed was 10 steps, 18 Tool calls, and 72749 ms. Keep the limits unchanged. Failed Runs stopped on the API protocol error, not a budget limit.

## Limitations

This was one model, one Variant, one repetition, and a descriptive calibration run. Cost is unavailable. The five Harness failures prevent treating the success count as a stable estimate. No control group or ablation was run. The raw, unedited report is `.benchmark/pilot-v1.json`; it contains no reasoning content, full Prompt, or full Event Log.

## Decision for B2

**READY_FOR_B2 = false.** The blocker is an unresolved DeepSeek thinking-mode `reasoning_content` preservation defect affecting five Cases. The 16-case Dataset and Scorer otherwise validated; keep every Case and current limit unchanged. Resolve the runtime issue separately, then rerun affected Cases for calibration before approving B2.
