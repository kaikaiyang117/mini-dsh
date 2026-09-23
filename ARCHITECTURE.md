# mini-dsh Architecture

English | [中文（主要展示版本）](./ARCHITECTURE.zh-CN.md)

This document describes the current implementation. See [README](./README.md) for the overview and results, and [Design Decisions](./docs/DESIGN_DECISIONS.md) for rationale.

## 1. System Boundaries

`Agent = Model + Harness`. The model generates content and Tool Calls; the Harness executes them, records facts, builds context, decides whether to continue, and verifies those behaviors.

| Implemented in this repository | Provided by dependencies |
| --- | --- |
| Agent / Loop, Session / Store, RunController | `@deepseek-ai/cordis`: Context, Plugin, Service, Fiber lifecycle |
| Tool Runtime / Scheduler, Visibility / Search | Ajv: JSON Schema compilation and validation |
| Context Projection / Compaction, Progress Guard, Trace / Eval | `@deepseek-ai/dsh-mcp-client`: MCP protocol, transport, remote discovery, tool synchronization, and reconnect |
| McpManager, application-level Sandbox, DeepSeek Provider Adapter | Model service: reasoning, generation, and usage when available |

mini-dsh manages local execution and plugin instances. It does not implement remote MCP health detection, cross-process Session locks, or OS isolation.

## 2. Runtime Layers

The [entry point](./src/index.js) exposes independent `src/core` runtimes as Cordis services through `src/plugins`, then mounts the provider, Bash / Files, MCP, and CLI.

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

[AgentRuntime](./src/core/agent-runtime.js) is a thin `sessionId + model + loop` handle; `send()` delegates to the Loop. The Loop uses the common Tool Runtime without identifying Bash, Files, or Context7. System prompts and temporary progress reminders are assembled for requests; they do not replace Session facts.

## 3. Event Log

[SessionRuntime](./src/core/session-runtime.js) owns event semantics; the Store only persists records. An event has `{ seq, type, data, at }`, with contiguous sequence numbers within a session. Run / Step identifiers are included in applicable event data.

| Event | Recorded facts |
| --- | --- |
| `session/start` | Initial session metadata |
| `user/message` | User input |
| `assistant/message` | Assistant text when there are no Tool Calls |
| `assistant/tool_calls` | Calls, accompanying text, and provider-returned `reasoningContent` |
| `tool/result` | `toolCallId`, tool name, rendered result, error information, and applicable recovery / skip markers |
| `context/compaction` | Summary, covered range, strategy, before/after token estimates, and `previousCompactionSeq` |
| `session/reset` | Start of a new context view; earlier events remain |

Reasoning persistence covers `reasoningContent` returned on tool-calling turns, not all internal reasoning or every streaming fragment.

**Protocol invariant: every committed Tool Call must eventually have exactly one matching `tool/result`.** Cancellation or budget exhaustion cannot simply discard a recorded call. Unexecuted calls receive `outcome=not_executed`; started calls with unknown results receive `outcome=unknown`. This invariant describes valid Loop-produced and recovered histories, not universal protocol validation of arbitrary external records by the Store.

## 4. Agent Loop

A Run in [AgentLoopRuntime](./src/core/agent-loop-runtime.js):

1. Enqueue through SessionRunCoordinator; create a RunController, deadline, Trace, and optional progress detector; append `user/message`.
2. Check `beforeStep()`, assemble the system prompt, take a fresh ToolCatalog snapshot, and select visible schemas.
3. Prepare messages through ContextManager. If the prepared request still reaches the hard limit, stop with `context_overflow` without sending it.
4. Call the LLM and record usage. With no Tool Calls, append `assistant/message` and finish according to the budget decision or normal completion.
5. Otherwise append `assistant/tool_calls` before scheduling execution. Even if usage has exhausted a budget, committed calls still need matching results.
6. Append `tool/result` in original call order, observe progress, then stop or start the next step.
7. Clear Run activation state and the deadline, finish the Trace, and notify stop observers.

Runs for the same Session are FIFO within this Loop's coordinator; different Sessions can run concurrently. Cancellation, exceptions, and scheduler failure still attempt to close the Tool protocol. Observer callback failures must not replace execution outcomes. Unrecoverable LLM / orchestration errors may propagate to the caller while recording the stop reason.

## 5. Run Controller

[RunController](./src/core/run-controller.js) owns **whether to continue**; the Loop owns **how to execute**. The controller neither executes tools nor stores durable facts. Counters are per Run; `null` disables an individual limit.

| Input / limit | Stop reason |
| --- | --- |
| Normal final response | `completed` |
| External cancellation / duration deadline | `cancelled` / `time_limit` |
| Step / tool call limit | `step_limit` / `tool_call_limit` |
| Cumulative input / output usage | `input_token_limit` / `output_token_limit` |
| Available cumulative cost / tool failures | `cost_limit` / `tool_failure_limit` |
| Prepared context still too large / guarded lack of progress | `context_overflow` / `no_progress` |
| Internal or orchestration error | `internal_error` |

Cumulative token budgets use LLM usage, not ContextManager request estimates. CostEstimator uses provider cost or configured pricing; unknown cost stays `null`, so a cost ceiling cannot be guaranteed without that information. Checks occur at execution boundaries, rather than precisely truncating an individual LLM response.

[SemanticProgressDetector](./src/core/semantic-progress-detector.js) is a deterministic per-Run heuristic using normalized calls, result categories, fingerprints, and novelty. `off` creates no detector; `remind` injects a temporary, one-shot strategy reminder; `guarded` can also request `no_progress`. Detection failures are fail-open. It cannot determine whether arbitrary code changes advance the user's goal.

## 6. Context Manager

[ContextManager](./src/core/context-manager.js) is not a Session Store. **The Durable Event Log holds facts; Model Context is a reconstructible projection.**

```text
Durable Event Log
  ↓ Context Projection (reset + valid compaction lineage)
  ↓ Compaction (plan when needed; append context/compaction)
Model Messages + System Prompt + Visible Tool Schemas
  ↓
LLM Request
```

`project()` is pure. `prepare()` is the explicit persistence boundary for appending a compaction event, followed by reprojection. Compaction never modifies existing Event Log entries. Recovery reconstructs the view from original events and compaction lineage.

[TokenMeter](./src/core/token-meter.js) estimates system, messages, and tools from the UTF-8 size of stable serialized text, reporting `exact=false` and `method=heuristic-v1`. It is not a provider tokenizer or billing source.

- **Hard limit**: `maxContextTokens - reservedOutputTokens`; reaching it produces `hard_limit`.
- **Soft limit**: available input budget multiplied by `compactAtRatio`, triggering compaction early.
- **Reserved output tokens**: room left in the input budget, not an enforced model maximum-output parameter.
- Without a configured window, pressure is `disabled`. When the CLI enables a window without an explicit output reservation, it reserves 4,096 tokens. Small windows require an explicitly smaller reservation.

The [Planner](./src/core/context-compaction-planner.js) selects boundaries where all Tool Call / Result pairs are closed and retains the latest raw message. It targets additional headroom; if that is unattainable, it accepts only a candidate that reduces estimated input. With no safe boundary it does not compact. The controller stops if the prepared context still overflows.

The [Compactor](./src/core/context-compactor.js) creates a bounded deterministic note containing portions of the goal, previous summary, assistant text, and tool activity. It is not an LLM summarizer and loses detail. The [Projector](./src/core/context-projector.js) validates ranges, protocol boundaries, and the `previousCompactionSeq` chain, then combines the latest valid summary with subsequent raw events. Summaries enter as assistant messages labeled as historical context, without promoting tool text to system instructions.

## 7. Tool Runtime

[ToolRuntime](./src/core/tool-runtime.js) unifies registration, schema exposure, execution, and rendering. It compiles an Ajv validator at registration and validates arguments before execution without type coercion.

| Definition field | Meaning / default |
| --- | --- |
| `name`, `description`, `parameters` | Tool identity, description, JSON Schema |
| `execute(args, exec)`, optional `output.render` | Execution and rendering hooks |
| `timeoutMs` | Tool timeout; defaults to `null` |
| `readOnly`, `idempotent`, `concurrencySafe` | Explicit declarations; all default to `false` |
| `sideEffect` | Side-effect declaration; defaults to `true` |

Execution context carries `signal`, Session / Run / Step / Tool Call identifiers, and agent. Results normalize `isError`, `errorCode`, content, and execution metadata. Unknown tools, invalid arguments, timeouts, cancellation, and execution / rendering exceptions map to `unknown_tool`, `invalid_arguments`, `timeout`, `cancelled`, and `execution_error`. Invalid registration still throws.

Timeout and cancellation cooperate through AbortSignal and wait for cleanup and settlement. A tool ignoring the signal can keep running. Metadata declarations are not safety proofs, and `idempotent` does not enable automatic retries.

## 8. Parallel Scheduler

[ToolScheduler](./src/core/tool-scheduler.js) partitions a batch into consecutive parallel groups and exclusive barriers, preserving call order. Only `concurrencySafe === true` admits a tool to a parallel group; undeclared and unknown tools take the exclusive path. `maxParallelToolCalls` bounds a group. A barrier waits for the preceding group, runs alone, then releases the following group.

```text
Calls:     safe A, safe B | write C | safe D, safe E
Execution: A and B       → C alone → D and E
Commit:    result A, result B, result C, result D, result E
```

**Completion order ≠ Event Log commit order.** Scheduler returns records indexed by original position; the Loop commits results in that order. Calls not started after admission stops receive `not_executed`. On scheduler failure, the Loop preserves settled results, supplies `unknown` for started calls without results, and reports the error. Parallelism and cancellation cannot omit terminal records for committed calls.

## 9. Tool Visibility

[ToolCatalog](./src/core/tool-catalog.js) snapshots metadata for currently registered tools at each Step. Visibility only selects schemas for the next request.

| Mode | Selection behavior |
| --- | --- |
| All | Every registered tool |
| Deterministic | All tools for small catalogs; lexical Top-K plus pinned tools for large catalogs; all-tools fallback on no match |
| Progressive | Base lexical selection keeps only pinned tools on no match, then adds `tool_search` and this Run's activation set |

[Ranking](./src/core/tool-ranking.js) uses lowercase ASCII letter / digit tokens across names, descriptions, and schema property names. Scores determine order; ties retain catalog order. There is no cross-language semantics, synonym understanding, or embedding similarity. Top-K is not a strict cap on the final schema count: pinned tools, search, activation, and compatibility fallbacks can expand it.

[`tool_search`](./src/tools/tool-search.js) queries the full current registered catalog, returns compact names / descriptions, and activates matches. Matches beyond the activation limit are marked unactivated. Each subsequent Step takes a fresh snapshot, so removed tools are not exposed. Activation is isolated per Run and cleared at its start and end. Search does not lazily connect MCP servers.

**Tool Visibility ≠ Authorization.** Hidden tools can still be executed by name through Tool Runtime. Tools and their policies must implement access control. `/tools` displays registered tools, not the current visible subset.

## 10. Session Persistence

[SessionStore](./src/core/session-store.js) abstracts create, open, append, list, flush, close, and dispose. Memory supports in-memory execution; JSONL supports persistence. The CLI defaults to `.data/sessions/<id>/session.jsonl`.

SessionRuntime serializes appends per session and updates the in-memory event array **only after the Store write succeeds**. The [JSONL Store](./src/core/jsonl-session-store.js) validates Session IDs and sequence numbers and queues writes. Append writes to the file; `flush()` performs file sync, and close / dispose flush. It does not fsync every event or lock out other processes. Process-crash experiments therefore do not establish power-loss durability.

`/resume` reopens the event stream and closes interrupted calls; `/reset` appends an event that changes the projection start without deleting history. SessionRunCoordinator queues Runs, while Store queues writes. Neither provides distributed coordination.

## 11. Crash Recovery

[JSONL recovery](./src/core/session-recovery.js) reads by byte offsets and validates contiguous sequence numbers. It can truncate a final line that fails JSON parsing only when earlier valid events exist. Interior corruption, invalid event shapes, and sequence gaps fail instead of being silently skipped.

The critical failure window:

```text
assistant/tool_calls persisted
  ↓
external side effect occurs
  ↓
tool/result not yet durable
  ↓ process crash
reopen JSONL → actual outcome cannot be known
  ↓
append tool/result: outcome=unknown, recovered=true, retryable=false
```

Recovery finds calls with no matching results and appends records without executing tools again. Reopening again does not duplicate existing results. Absence of a result is not evidence that execution never started.

**mini-dsh deliberately chooses “no blind retry under uncertain side effects” instead of claiming distributed exactly-once.** Exactly one matching result record and exactly one external side effect are different guarantees.

## 12. MCP Lifecycle

```text
McpManager (this repository: plugin instance lifecycle)
  ↓
@deepseek-ai/dsh-mcp-client (official: protocol / transport / reconnect)
  ↕
MCP Server
  ↓ discovery and synchronization through the client
ctx.tools.register() → ToolRuntime → AgentLoop
```

[McpManager](./src/core/mcp-manager.js) serializes connect / disconnect / reload per server while keeping servers independent. Reload cleans up before activation. The [plugin bridge](./src/plugins/mcp.js) attempts disposal of a partially created Fiber on activation failure. Failed disconnect cleanup retains the Fiber for retry. Manager disposal uses all-settled cleanup across servers and can be retried after failure.

`DISCONNECTED`, `CONNECTING`, `ACTIVE`, and `FAILED` describe the local plugin lifecycle. **`ACTIVE ≠ remote endpoint healthy`.** An initial remote connection failure need not fail the official client's Fiber activation. Protocol connections, remote discovery, tool synchronization, and remote reconnect stay with the official client.

Schemas already sent to the model can become stale before execution. A call to an unregistered tool returns `unknown_tool`; the next Step uses a fresh catalog. Fake plugins in MCP Failure verify these local contracts, not live network availability.

## 13. Evaluation

```text
EvalCase → EvalSuite → Fixture → Agent Harness
                                   ↓
                                 Scorer
                                   ↓
                              EvalResult → Reporter
```

[EvalCase / EvalSuite](./src/eval/eval-suite.js) define prompt, expected behavior, optional limits / metadata / scorer, variants, and a fixture factory. The [Runner](./src/eval/eval-runner.js) executes cases. A Fixture provides at least agent, trace, and recordingTokenMeter, with optional inspectors and dispose. Scorers receive named arguments and return success plus bounded details. Fixture, scorer, or cleanup errors produce failed results.

The [Reporter](./src/eval/eval-reporter.js) produces tables and `schemaVersion: 1` JSON with per-case results and variant aggregates. Provider input / output / reasoning usage and cost carry separate availability indicators and are `null` when absent. Harness `estimatedInputTokens` and `toolSchemaTokens` are not billed usage.

The framework grew around distinct measurement questions while retaining that contract:

| Layer | Suite / command | Question tested |
| --- | --- | --- |
| Policy | `pnpm eval:tool-routing`, `pnpm eval:progress` | Schema exposure, discovery cost, repetition reminders / stops, avoidance of false stops |
| Context | `pnpm eval:context-pressure` | Safe compaction, goal / recent-context preservation, overflow, unchanged history |
| Workflow | `pnpm eval:long-horizon` | Real file / test path: search → read → test → edit → retest → finish |
| Fault | `pnpm eval:fault-injection` | Fault evidence, stop reasons, closed Tool protocol |
| Crash | `pnpm eval:crash-recovery` | Child-process SIGKILL, JSONL reopening, tail repair, unknown side effects without retry |
| Lifecycle | `pnpm eval:mcp-failure` | Fake MCP plugin activation, isolation, removal, reload, and cleanup retry |

These are deterministic synthetic evaluations. Workflow uses real temporary repositories but Mock LLM decisions. Crash uses real child processes without simulating power loss. MCP uses local fake plugins rather than remote chaos testing. The framework measures **execution paths, resource usage, protocol consistency, and recovery semantics**, beyond final answers.

Scorers must resist false positives. Workflow checks initially failing / finally passing tests, required reads and modifications, forbidden files, and workspace boundaries. Crash checks actual termination, durable records, and side-effect evidence. MCP checks events, tool registrations, and lifecycle evidence; an expected stop reason alone is insufficient. Regressions live in [test](./test).

README numbers come from local reports at baseline `588e764`, rerun on 2026-09-23. Reports are generated at `.eval/<suite>.json` and are not committed. Measurement definitions:

- Tool Routing: `variants.*.avgVisibleTools`, `avgToolSchemaTokensPerRequest`, and `avgEstimatedInputTokens`.
- Context: peak is the maximum of all actual-request `estimatedInputTokensByStep`; mean input uses `avgEstimatedInputTokens`; compactions sum each case's `scoreDetails.compactionCount`. A successful Constrained score means expected overflow, not task completion.
- Long-Horizon: `avgVisibleTools` and `totalEstimatedInputTokens`. Local raw totals were **194,553** for baseline and **98,657** for managed, rounded to about 195,000 / 99,000 in README. Environment text, including test output and temporary paths, affects estimates; these are snapshots, not platform-independent constants.
- Reductions use `1 - managed / baseline` (compacted / full-history for Context). Long-Horizon changes routing, progress, and compaction together; it is not a single-factor ablation.

## 14. Sandbox

[SandboxRuntime](./src/core/sandbox-runtime.js) is an application-level policy gate. Built-in file tools use [resolveInside](./src/utils/path.js) for lexical and realpath containment checks against workspace escapes and static symlink escapes. Bash has a command denylist; file writes and Bash execution require CLI approval.

These checks are not OS isolation, a general safe Shell parser, or a boundary against hostile code. Secondary interpreters, filesystem changes after inspection, and plugins accessing resources themselves are not fully constrained. Remote MCP execution is not isolated by these policies. An Eval fixture's controlled execution environment must not be presented as production Sandbox isolation.

## 15. Current Limits

Compaction, Run budgets, parallel scheduling, durable sessions, MCP lifecycle, and offline Eval are implemented. This is no longer the early model → tool learning skeleton.

Remaining limits are explicit: local single-process coordination; cooperative cancellation; lossy deterministic summaries; ASCII lexical routing; heuristic progress detection; budgets dependent on available usage / pricing; application-level Sandbox; separate MCP lifecycle and remote health; and no blind retry for unknown outcomes. The project provides neither a complete DSH product, distributed transaction guarantees, nor real-model performance conclusions.
