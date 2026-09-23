# mini-dsh

English | [中文（主要展示版本）](./README.zh-CN.md)

A lightweight, plugin-based **Coding Agent Harness** focused on reliable long-horizon execution, progressive tool discovery, durable sessions, context management, and reproducible evaluation.

Inspired by DeepSeek Harness / DSH, mini-dsh uses Cordis for plugin composition and implements its core Harness logic in this repository. It is neither a complete DSH clone nor a production replacement.

## Key Features

- **Durable Session & Resume**: append-only JSONL history, session reopening, and interrupted Tool Call recovery.
- **Tool Runtime & Parallel Scheduling**: schema validation, consistent error results, and bounded concurrency for explicitly safe tools.
- **Context Management & Compaction**: project factual history into model context and compact at protocol-safe boundaries.
- **Progressive Tool Discovery**: discover tools through `tool_search` and activate them for the current Run.
- **Run Governance**: separate limits for steps, calls, time, tokens, cost, and tool failures.
- **Managed MCP Lifecycle**: connect, disconnect, reload, and clean up MCP plugin instances.
- **Semantic Progress Guard**: optional deterministic repetition detection, reminders, and stopping.
- **Evaluation & Fault Recovery**: measure execution paths, resource use, protocol consistency, and crash recovery semantics.

## Architecture

```text
User / CLI
  ↓
AgentRuntime
  ↓
AgentLoopRuntime
  ├── RunController         Whether to continue
  ├── ContextManager
  │     ├── Context Projection
  │     └── Compaction Planner
  ├── Tool Visibility       All / Deterministic / Progressive
  ├── ToolScheduler
  │     └── ToolRuntime     Bash / Files / MCP Tools
  └── LLM Runtime           Provider Adapter → Model
  ↕
SessionRuntime
  └── SessionStore          Memory / JSONL
```

**Implemented here**: Agent Loop, Session, Run Controller, Tool Runtime / Scheduler, Context Projection / Compaction, Tool Visibility, Progress Guard, MCP lifecycle management, and the Eval framework. **Provided by dependencies**: Context / Plugin / Service from `@deepseek-ai/cordis`, MCP protocol and remote interaction from `@deepseek-ai/dsh-mcp-client`, and JSON Schema validation from Ajv.

## Why mini-dsh

A coding model alone does not maintain long-task state, execute Tool Calls reliably, preserve protocol ordering during concurrency, compress growing context, or recover after a process crash. A usable agent also needs to control schema overhead, detect unproductive repetition, manage MCP lifecycles, and demonstrate that its policies work.

```text
Coding Agent = Model (reasoning and generation) + Harness (execution, state, constraints)
```

mini-dsh turns these engineering concerns into readable, replaceable, testable components. Start with the core designs and Eval tables below, then follow the links into the implementation.

## Core Design

### Durable Sessions

**Durable History ≠ Model Context.** The Event Log records facts; model messages are a projection of that history:

```text
Durable Event Log → Context Projection → Compaction → Model Messages
```

`session/start`, `user/message`, `assistant/message`, `assistant/tool_calls`, `tool/result`, and `context/compaction` capture messages, calls, results, reasoning on tool-calling turns, and compaction lineage. Compaction appends a record and changes the projection; it must not rewrite or delete existing Event Log entries. Recovery uses the Event Log, not a previously compressed prompt.

The central invariant: **each Tool Call committed in `assistant/tool_calls` must eventually have exactly one matching `tool/result`**. Execution, budget stops, cancellation, and recovery aim to close this protocol. A crash can leave calls temporarily open; reopening the session supplies unknown-outcome results.

### Run Governance

AgentLoop owns **how to execute**; RunController owns **whether to continue**. Each Run has independent step, tool call, duration, input/output token, cost, and tool failure limits, plus context overflow and cancellation decisions.

Stop reasons are `completed`, `cancelled`, `step_limit`, `tool_call_limit`, `time_limit`, `input_token_limit`, `output_token_limit`, `cost_limit`, `tool_failure_limit`, `context_overflow`, `no_progress`, and `internal_error`. Token / cost budgets depend on available usage / pricing; unknown cost is not zero.

Progress Guard uses normalized calls, result categories, fingerprints, and novelty to detect repetition. It defaults to `off`; `remind` adds a temporary reminder, while `guarded` can stop with `no_progress`. “Semantic” does not mean an LLM judge or complete reasoning about task progress.

### Context Management

ContextManager is not a Session Store. It maps **Durable History → Model Context**, handling token estimation, pressure states, protocol-safe boundaries, and deterministic compaction.

The input hard limit is the context window minus reserved output tokens; the soft limit triggers compaction earlier. A request still at the hard limit after preparation is stopped. Compaction cannot split Tool Call / Result pairs. The current compactor produces a bounded deterministic continuity note, with no guarantee of preserving all meaning.

### Tool Runtime

A Tool Definition includes JSON Schema (`parameters`), `timeoutMs`, `readOnly`, `idempotent`, `concurrencySafe`, and `sideEffect`. The Runtime validates arguments, renders results, and normalizes failures into Tool Results where possible: `unknown_tool`, `invalid_arguments`, `timeout`, `cancelled`, and `execution_error`.

Only tools with `concurrencySafe=true` may run concurrently; other tools act as barriers. **Completion order differs from Event Log commit order**: results are committed in original Tool Call order. Timeout / cancellation is cooperative: tools must respond to AbortSignal and finish cleanup. It is not forced preemption.

### Tool Discovery

| Mode | What the model sees |
| --- | --- |
| All (default) | Every registered tool schema |
| Deterministic | Lexical Top-K selection |
| Progressive | `tool_search`, base selection, and tools activated for this Run |

Visibility controls schema exposure; **it is not authorization**. Progressive search covers registered tools and does not lazily connect MCP servers. See [Architecture](./ARCHITECTURE.md#9-tool-visibility) for ranking and fallback behavior.

### MCP

```text
McpManager → dsh-mcp-client → MCP Server
                    ↓ discover and synchronize tools
             ctx.tools.register() → ToolRuntime
```

mini-dsh manages MCP plugin lifecycles. MCP protocol, transport, remote reconnect, and remote tool discovery belong to the official `@deepseek-ai/dsh-mcp-client`. `ACTIVE` means the client plugin Fiber activated successfully; **it does not mean the remote endpoint is healthy**.

## Evaluation

The following results come from the existing suites at baseline `588e764`. They are **deterministic synthetic Eval** results using Mock LLMs to exercise the Harness, not production model benchmarks, SWE-bench scores, or model rankings. Tokens are Harness estimates, separate from provider usage and billed cost. See [Architecture](./ARCHITECTURE.md#13-evaluation) for reproduction and measurement definitions.

### Tool Routing

Source: [tool-routing suite](./evals/tool-routing/suite.js), using the same cases for each mode.

| Mode | Avg visible tools / request | Schema tokens / request | Avg estimated input / run |
| --- | ---: | ---: | ---: |
| All | 19 | 9,268 | 18,650.8 |
| Deterministic | 5 | 336 | 786.8 |
| Progressive | 1.93 | 199.6 | 1,016.2 |

All modes pass every case. Progressive reduces schema overhead per request, but adds a Tool Search step. In this suite its whole-run input estimate is higher than Deterministic: discovery has a request cost.

### Context Pressure

Source: [context-pressure suite](./evals/context-pressure/suite.js). Constrained / Compacted use a 1,900-token window with 200 reserved output tokens; Full-history has no window limit.

| Mode | Peak estimated input / request | Avg estimated input / run | Compactions (suite total) | Task outcome |
| --- | ---: | ---: | ---: | --- |
| full-history | 5,697 | 20,884 | 0 | All completed |
| constrained | 1,234 | 2,593 | 0 | All `context_overflow` |
| compacted | 1,578 | 9,040 | 17 | All completed |

Compacted reduces peak input by about **72%** and cumulative estimated input by about **57%** versus Full-history while completing the tasks. Peaks count actual model requests only; Constrained's rejected over-limit requests are excluded. Early termination is not an optimization success.

### Long-Horizon Coding

Source: [long-horizon suite](./evals/long-horizon/suite.js). A Mock LLM drives real file operations and tests in disposable local repositories:

```text
search → read → test (fail) → edit → retest (pass) → finish
```

The scorer checks more than the final file: initially failing tests, finally passing tests, required reads, workspace diffs, unexpected files, and Tool protocol integrity.

| Mode | Avg visible tools / request | Estimated input (suite total, approx.) | Completed |
| --- | ---: | ---: | ---: |
| baseline | 25 | 195,000 | 5/5 |
| managed | 9 | 99,000 | 5/5 |

Tool exposure falls by **64%**, and estimated input by about **49%**. These are rounded local report values; environment text such as test output and temporary paths affects token estimates. Managed combines **Tool Routing, Progress Guard, and Context Compaction**, so the gain cannot be attributed to any single mechanism.

### Reliability

| Suite | Fault coverage | What it verifies |
| --- | --- | --- |
| [Fault Injection](./evals/fault-injection/suite.js) | LLM failure, tool error / timeout, invalid call, unknown tool, parallel cancellation, context overflow, scheduler failure | Stop reasons, evidence the fault occurred, call/result pairing |
| [Crash Recovery](./evals/crash-recovery/suite.js) | Real process SIGKILL, JSONL reopening, torn tail, unknown outcome | Closed protocol after recovery, side-effect evidence, no blind retry |
| [MCP Failure](./evals/mcp-failure/suite.js) | Activation cleanup, server isolation, disconnect/reload, stale schema, cleanup retry, remote-like tool failure | Plugin lifecycle, tool cleanup, failure isolation |

If a side effect occurs and the process crashes before its Tool Result is durable, the Harness cannot know the outcome. Recovery records `outcome=unknown` and `retryable=false`.

**mini-dsh deliberately chooses “no blind retry under uncertain side effects” instead of claiming distributed exactly-once.** MCP Failure uses local fake plugins; it is not remote MCP chaos testing or health detection.

## Quick Start

Requirements from [package.json](./package.json): Node.js `>=20.18.1`, pnpm `11.22.0`.

```bash
pnpm install
cp .env.example .env
# Set DEEPSEEK_API_KEY in .env
pnpm start
```

[.env.example](./.env.example) selects `deepseek/deepseek-v4-flash`. Without `MINI_DSH_MODEL`, the entry point falls back to `deepseek/deepseek-v4-pro`. The CLI stores sessions in `.data/sessions` by default; override with `MINI_DSH_SESSION_DIR`.

Context7 is optional; see [mcp.config.js](./mcp.config.js). You may set `CONTEXT7_API_KEY`. An initial remote connection failure does not prevent the CLI from starting; the official client handles subsequent remote reconnection.

Optional policies (defaults shown; see `.env.example` for other budgets):

```dotenv
MINI_DSH_TOOL_ROUTING=all
MINI_DSH_MAX_VISIBLE_TOOLS=12
MINI_DSH_MAX_ACTIVATED_TOOLS=24
MINI_DSH_MAX_PARALLEL_TOOL_CALLS=4
MINI_DSH_PROGRESS_MODE=off
MINI_DSH_MAX_CONTEXT_TOKENS=null
```

## CLI

| Command / action | Purpose |
| --- | --- |
| `/tools` | List registered tools |
| `/sessions`, `/resume <session-id>`, `/new` | List, resume, or create sessions |
| `/history`, `/reset` | Inspect events; append a reset event to reset the context view |
| `/models`, `/model [provider/model]` | Inspect or switch models |
| `/prompt` | Inspect the system prompt |
| `/mcp list`, `/mcp connect <name>`, `/mcp disconnect <name>`, `/mcp reload <name>` | Manage MCP lifecycle |
| `Esc`, `/exit` | Cancel the current Run; exit the CLI |

File writes and Bash execution request `[Y/n]` approval. See the [CLI screenshot](./images/demo.png).

## Project Boundaries

- A local Harness engineering project, not a complete DSH product or production replacement.
- JSONL supports local session recovery, without cross-process writer coordination or distributed exactly-once guarantees.
- Sandbox means application-level path / command policy and human approval, not OS isolation. It does not isolate remote MCP tools.
- Visibility is not permission. Lexical routing has no cross-language semantic understanding; compaction is lossy and Progress Guard is heuristic.
- Cooperative cancellation cannot forcibly terminate an uncooperative tool; `ACTIVE` is not remote MCP health.
- Synthetic Eval demonstrates behavior under specified conditions, not real-model task success rates.

## Documentation

| Document | Purpose |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Current layers, protocols, and recovery semantics |
| [DESIGN_DECISIONS.md](./docs/DESIGN_DECISIONS.md) | Reasons and trade-offs behind the main choices |
| [LEARNING.md](./LEARNING.md) | Build-from-scratch learning path |
| [SOURCE_STUDY_ROADMAP.zh-CN.md](./SOURCE_STUDY_ROADMAP.zh-CN.md) | Historical source-reading path and exercises (Chinese) |
| [DEVELOPMENT_ROADMAP.zh-CN.md](./DEVELOPMENT_ROADMAP.zh-CN.md) | Evolution plan and historical context (Chinese); architecture and code define current behavior |

## Development

```bash
pnpm test
pnpm check
pnpm lint
pnpm eval:tool-routing
pnpm eval:progress
pnpm eval:context-pressure
pnpm eval:long-horizon
pnpm eval:fault-injection
pnpm eval:crash-recovery
pnpm eval:mcp-failure
```

Eval reports are written to `.eval/*.json`. All these checks are included in [CI](./.github/workflows/ci.yml).
