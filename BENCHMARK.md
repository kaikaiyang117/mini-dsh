# Coding Benchmark V1

English | [中文](./BENCHMARK.zh-CN.md)

B1 contains 16 formal local Coding cases: four single-file bugfixes, four cross-file bugfixes, four features, and four repository-understanding / refactor / long-context tasks. The earlier `coding-smoke` case remains an infrastructure smoke test; it is separate from the formal `coding-benchmark` suite. Reports are reproducibility artifacts and do not support model rankings or success-rate claims.

Each loaded case is converted to the existing EvalCase contract with `expected: { completion: 'stop-reason', stopReason: 'completed' }`. The Coding scorer is synchronous to match EvalRunner. It records a failing public-test run before edits and a passing run afterward for failing-baseline cases; the passing-baseline refactor case must show a passing run. It then independently runs public tests, a synchronous hidden behavioral verifier, recursive workspace policy checks, and Tool Call / Result protocol checks.

The four categories stay balanced at four cases each. Cases 05–08 require tracing config sources, repository/cache/service interaction, a repository/store/name index, or plugin registry state and runner instance caching. Cases 13–16 include 5–12 relevant implementation files across request logging, shared route handling, dependency graph loading, and validation/import flows. Hidden verifiers execute the resulting modules against extra cases; only the explicit validation refactor case also checks source structure.

Validate all case baselines, reference solutions, public tests, hidden verifiers, and workspace policies without a network or model call:

```bash
pnpm benchmark:coding:validate
```

## Architecture

```text
CLI / BenchmarkConfig
  → BenchmarkRunner (case → variant → repetition, sequential)
  → existing EvalRunner (one case × variant per sample)
  → fresh Fixture / production AgentLoopRuntime / LlmRuntime
  → real Provider Adapter
  → existing Scorer interface / EvalResult
  → Benchmark sample / aggregation / JSON report
```

BenchmarkRunner only orchestrates the matrix and experiment-wide admission budget. It reuses EvalCase, EvalRunner, Trace, RecordingTokenMeter, ToolRuntime, and AgentLoop without duplicating the Agent Runner or Tool protocol. Synthetic Eval reports remain timestamp-free; Benchmark reports record `startedAt` and `finishedAt` under a different reproducibility contract.

`minimal` exposes all available tool schemas without a context window or progress detector. `full` uses lexical tool selection, ContextManager pressure / compaction, and deterministic progress detection. B0 uses these configurations to prove variant switching, not to make an ablation or performance claim.

## CLI

Inspect the plan without an API key or model call:

```bash
pnpm benchmark:coding -- --dry-run --model deepseek/deepseek-v4-pro --repeat 3
```

A real run needs `DEEPSEEK_API_KEY`. The existing DeepSeek plugin registers on `ctx.llm`, and LlmRuntime selects the requested `provider/model`. The default comes from `MINI_DSH_MODEL`, falling back to the Runtime default `deepseek/deepseek-v4-pro`.

```bash
pnpm benchmark:coding -- --model deepseek/deepseek-v4-pro --repeat 3 \
  --variants minimal,full --case clamp-boundaries \
  --output .benchmark/coding.json
```

| Option | Effect |
| --- | --- |
| `--model provider/model` | Select a registered model |
| `--variant NAME` (repeatable), `--variants A,B` | Filter variants; default `minimal,full` |
| `--case NAME` (repeatable), `--cases A,B` | Filter cases; default all |
| `--repeat N` | Repeat each Case × Variant N times; default 1 |
| `--output PATH` | JSON output; default `.benchmark/coding.json` |
| `--max-total-cost NUMBER` | Admission threshold for the whole experiment |
| `--allow-unknown-cost` | Explicitly proceed when cost is unknown; the total ceiling then cannot be fully enforced |
| `--dry-run` | Print the plan without creating workspaces or calling a model |

The console shows each variant's successes, samples, average steps / Tool Calls, input tokens, estimated input, cost, and duration, followed by the machine-readable report path. Git ignores `.benchmark/`, separately from `.eval/` for deterministic synthetic Eval.

Dry-run planning is offline: `--variants full --repeat 3` plans 48 samples, while `--variants minimal,full --repeat 3` plans 96.

## Samples and Repetitions

Execution order is **case → variant → repetition**, without parallel runs. Every repetition creates a new temporary workspace, Session, Agent, and Trace. `runId` identifies the Benchmark sample; `agentRunId` identifies its Harness Trace.

Each formal case has a public workspace, public test command, explicit file policy, and hidden verifier/reference assets kept outside the agent workspace. The generic scorer independently reruns public tests, checks recursive workspace diffs and Tool Call / Result pairing, and invokes the hidden verifier. The fixture uses the production Cordis / AgentLoop / Session / Trace stack with a real provider plugin; validation itself never calls a provider.

Automatic approval applies only to Benchmark-created temporary workspaces, which are removed afterward. This is application-level policy, **not OS isolation**. Do not use this mode directly for untrusted code or other workspaces.

## Report and Cost Semantics

Top-level JSON includes `schemaVersion: 1`, Benchmark name / version, invocation model / matrix, Git commit / Node / platform / architecture, timestamps, raw `results[]`, and `summary`. The commit can be `null` outside a Git repository.

Each sample records its Benchmark and Agent Run IDs, case / variant / repetition, provider / model, success / stop reason, steps / Tool Calls / Tool Errors, request count, Provider input / output / reasoning tokens and cost, Harness estimated input / schema tokens / visible tool count, whole-Run duration, bounded score evidence, and error. `toolErrors` counts Session `tool/result.isError` events. The report excludes full Prompts, Event Logs, and `reasoningContent`; ordinary Session history retains its existing behavior.

`summary.variants` aggregates samples, successes / success rate, average steps / Tool Calls / Tool Errors / requests, Provider tokens, Harness estimates, visible tools per request, duration, and known cost. Top-level counts include `plannedRuns`, `startedRuns`, `completedRuns`, `skippedRuns`, `budgetStopped`, and `budgetStopReason`. Raw samples remain available for recomputation.

The DeepSeek adapter currently returns token usage with `cost=null`. Existing CostEstimator can calculate cost from known input / output usage when `MINI_DSH_PRICING_JSON` is configured, for example:

```dotenv
MINI_DSH_PRICING_JSON={"deepseek/deepseek-v4-pro":{"inputPer1k":0.001,"outputPer1k":0.002}}
```

Those numbers illustrate the format; **they are not a current price quote**. Supply appropriate pricing before a run. `cost=null` means unknown, never zero. `costAvailability` is `available`, `partial`, or `unavailable`, while `totalKnownCost` sums known samples only. With `--max-total-cost`, missing DeepSeek pricing fails before startup. An unknown cost discovered during a run stops subsequent admissions and exits nonzero. Only explicit `--allow-unknown-cost` proceeds.

Before each next sample, the global budget checks `totalKnownCost >= maxTotalCost`. It does not kill an in-flight Agent Run, so one completed sample can put total cost above the ceiling. RunController's individual Run limits remain separate.

Ordinary `pnpm test` includes a fake-provider V1 sample through BenchmarkRunner, EvalRunner, production AgentLoop, ToolRuntime, workspace, and scorer; it never calls a real API. CI also runs the offline 16-case validator. `pnpm benchmark:coding` real-model runs are not part of normal CI. Existing `eval:*` suites are Mock LLM deterministic synthetic evaluation and should not be mixed with real-model samples or used for direct success-rate comparisons.
