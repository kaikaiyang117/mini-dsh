# mini-dsh

English | [中文](./README.zh-CN.md)

A minimal handwritten runtime following DSH concepts, built on [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis).

This is a **minimal project for learning the core DSH design** — not a full DSH product.

It deliberately keeps five things:

1. Cordis Context / Plugin / Service
2. Session Event Log -> deriveMessages()
3. Tool Registry -> register / schemas / execute
4. LLM Provider Adapter
5. Agent Loop -> model -> tool -> model -> answer

It also keeps the Bash/File tools and the official `@deepseek-ai/dsh-mcp-client` + Context7, to prove "Everything is a Plugin". Context7 is optional: the CLI still starts when it is unreachable — you just don't get those MCP tools.

## Demo

![mini-dsh CLI](./images/demo.png)

## Environment

- Node.js `>= 20.18.1`
- pnpm `11.22.0` (see `packageManager` in `package.json`)

## Run

```bash
pnpm install
cp .env.example .env
# fill in DEEPSEEK_API_KEY
pnpm start
```

`.env.example` sets `deepseek/deepseek-v4-flash`. If `MINI_DSH_MODEL` is absent entirely (e.g. you didn't copy `.env`), the entry falls back to `deepseek/deepseek-v4-pro` (`src/index.js:41`).

Optional: fill in `CONTEXT7_API_KEY`. A remote startup failure does not fail the client Fiber: the CLI starts and the official client manages reconnect. `ACTIVE` only reports Fiber activation, not remote health.

The path once Context7 is connected:

```text
@deepseek-ai/dsh-mcp-client
  -> https://mcp.context7.com/mcp
  -> ctx.tools.register(...)
  -> mcp__context7__resolve-library-id
  -> mcp__context7__query-docs
```

Managed MCP lifecycle:

```text
McpManager
  -> @deepseek-ai/dsh-mcp-client
  -> remote MCP server
```

Mini-DSH manages MCP plugin instances and exposes `DISCONNECTED`, `CONNECTING`, `ACTIVE`, and `FAILED` lifecycle states. The official `dsh-mcp-client` owns MCP transport, discovery, tool synchronization, and reconnect. `ACTIVE` means the client plugin Fiber activated successfully; it does not assert that the remote transport is currently healthy.

## CLI

```text
/tools
/mcp list
/mcp connect <name>
/mcp disconnect <name>
/mcp reload <name>
/models
/model
/model deepseek/deepseek-v4-pro
/model deepseek/deepseek-v4-flash
/history
/prompt
/reset
/exit
```

Writes and bash execution ask `[Y/n]` first. Press **Esc** while the agent is running to cancel the current run (arrow keys won't cancel it).

## Agent Loop governance and context

The core execution shape is still model -> tool -> model, but it is no longer an unbounded learning baseline. Every Agent Run is governed by a per-run `RunController` and a `ContextManager` projection:

```js
while (true) {
  const stepDecision = controller.beforeStep(signal)
  if (stepDecision.action === 'stop') return stepDecision

  const context = await contextManager.prepare(sessionId, request)
  const response = await model(context)

  if (!response.toolCalls?.length) {
    return response.content
  }

  await executeTools(response.toolCalls)
}
```

The runtime now includes:

- per-run limits for steps, tool calls, duration, input/output tokens, estimated cost, and tool failures; `null` disables an individual limit;
- run-level deadlines and cooperative cancellation for LLM and Tool execution;
- Event Log-based Context Projection, token pressure reporting, and deterministic durable compaction;
- append-only JSONL Session persistence with resume, replay, and interrupted-tool recovery;
- bounded parallel execution for explicitly `concurrencySafe` Tools;
- FIFO serialization for Agent Runs within one Session, while different Sessions may execute concurrently.
- optional, Run-scoped deterministic no-progress detection with ephemeral strategy reminders and an opt-in hard stop.

`ToolCatalog` snapshots metadata for currently registered Tools. Per-Step visibility is selected by `AllToolsVisibility`, `DeterministicToolVisibility`, or `ProgressiveToolVisibility`:

```text
Registered Tools -> Tool Catalog -> Per-Step Visibility -> Model Request
```

Configuration (defaults shown):

```dotenv
MINI_DSH_TOOL_ROUTING=all
MINI_DSH_MAX_VISIBLE_TOOLS=12
MINI_DSH_MAX_ACTIVATED_TOOLS=24
```

`MINI_DSH_TOOL_ROUTING=all` exposes every registered Tool. `MINI_DSH_TOOL_ROUTING=deterministic` applies lexical Top-K routing; on large catalogs, no-match and non-ASCII-only queries fall back to all Tools for compatibility. `MINI_DSH_TOOL_ROUTING=progressive` pins `tool_search` alongside a deterministic base that instead returns only pinned Tools on a no-match; catalogs no larger than the configured Top-K still bypass routing. The search uses the same lexical ranking against the full current Tool Catalog, returns compact name/description matches, and activates hits for later Steps in the current Run only. This gives the model a chance to refine its search query between Steps. A reached activation limit is reported in the result; matches are still returned. Each Step takes a fresh catalog snapshot, and Run completion clears activation state. Matching is ASCII-token based: it does not understand cross-language meaning, synonyms, or semantic similarity. `/tools` continues to show registered Tools; visibility is not authorization, and hidden Tools remain executable through the Tool Runtime. Progressive discovery does not lazily connect MCP servers; it discovers only already-registered Tools.

Semantic Progress Detection V1 is an opt-in deterministic heuristic. It combines normalized Tool calls, outcome classes, result fingerprints, and result novelty to detect repeated no-information execution. `off` is the default; `remind` adds a fixed, ephemeral strategy reminder; `guarded` also stops a Run with `no_progress`. This is not an LLM semantic judge, embedding similarity, full goal-state reasoning, or a workspace semantic diff. Workspace changes and goal deltas remain future signals. The sandbox remains an application-level path/command policy with approval, not a kernel isolation boundary.

```dotenv
MINI_DSH_PROGRESS_MODE=off
MINI_DSH_PROGRESS_SOFT_STEPS=3
MINI_DSH_PROGRESS_HARD_STEPS=6
```

`MINI_DSH_PROGRESS_SOFT_STEPS` applies in `remind` and `guarded`. `MINI_DSH_PROGRESS_HARD_STEPS` affects runtime only in `guarded`; `off` creates no detector. Explicit threshold values are validated in every mode.

## Evaluation

### Harness Evaluation

The deterministic `tool-routing` and `progress` suites use a shared JavaScript EvalCase / EvalSuite contract, a common runner, and versioned JSON reports. An EvalCase carries `name`, `prompt`, `expected`, and optional `limits`, `metadata`, and `scorer`; a suite defines its ordered string variants and fixture factory. Fixtures provide `agent`, `trace`, and `recordingTokenMeter`, with optional `dispose`, `inspectors`, and `metadata`. Scorers receive a named context object and return success plus optional bounded JSON details.

Reports have `schemaVersion: 1`, suite metadata, ordered variant summaries, and stable per-case results. Results retain stop reason, duration, steps, Tool calls, request and visible-tool counts, schema and estimated-input metrics, provider usage and cost availability, and target-tool outcome. Provider-reported usage (`inputTokens`, `outputTokens`, `reasoningTokens`, `cost`) remains separate from Harness estimates (`estimatedInputTokens`, `toolSchemaTokens`).

Each result keeps this field set: `suiteName`, `caseName`, `variant`, `success`, `error`, `stopReason`, `durationMs`, `steps`, `toolCalls`, `requestCount`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cost`, `visibleToolCount`, `visibleToolCountByStep`, `maxVisibleToolCount`, `toolSchemaTokens`, `toolSchemaTokensByStep`, `estimatedInputTokens`, `estimatedInputTokensByStep`, `targetToolCalled`, `targetToolSucceeded`, and bounded `scoreDetails`.

Run the suites with `pnpm eval:tool-routing`, `pnpm eval:progress`, `pnpm eval:context-pressure`, `pnpm eval:long-horizon`, `pnpm eval:fault-injection`, `pnpm eval:crash-recovery`, and `pnpm eval:mcp-failure`; reports are written to the matching `.eval/*.json` paths. Long-Horizon is a deterministic synthetic coding workflow over disposable local repositories. It compares baseline and managed Harness settings using a Mock LLM; it is not SWE-bench, HumanEval, or a real-model coding benchmark. The Context Pressure suite compares full history, a constrained no-compaction baseline, and deterministic compaction under a 1,900-token context window with 200 reserved output tokens. Fault Injection uses deterministic in-process failures. Crash / Resume Recovery uses real child processes, durable JSONL reopen, torn final-line repair, and conservative unmatched Tool recovery. MCP Failure tests Harness plugin activation cleanup, server isolation, disconnect/reload lifecycle, stale Tool snapshots, cleanup retry, and remote-like Tool failures with local fake plugins; it is not remote MCP chaos testing or a transport health check. When a non-idempotent side effect may have happened before its Result became durable, the runtime records `unknown` and `retryable=false` and performs no blind retry; this is not distributed exactly-once. These offline mock evaluations test Harness policy and runtime behavior; they are not production model benchmarks.

The production `SandboxRuntime` is an application-level policy gate, not operating-system isolation.

## For beginners: write it from scratch

Do not read the whole repo first. Skim **[ARCHITECTURE.md](./ARCHITECTURE.md)** to build the overall picture, then create a new empty project and write it yourself, milestone by milestone, following **[LEARNING.md](./LEARNING.md)**.

## Recommended reading order

```text
src/index.js
  ↓
src/plugins/sessions.js
src/plugins/system-prompt.js
src/plugins/tools.js
src/plugins/llm.js
src/plugins/agents.js
src/plugins/agent-loop.js
src/plugins/sandbox.js
  ↓
src/core/session-runtime.js
  ↓
src/core/system-prompt-runtime.js
src/plugins/runtime-context.js
  ↓
src/core/tool-runtime.js
  ↓
src/core/llm-runtime.js
  ↓
src/core/agent-runtime.js
  ↓
src/core/agent-loop-runtime.js   ← the core
  ↓
src/plugins/cli.js
  ↓
src/utils/path.js
src/core/sandbox-runtime.js
  ↓
src/models/deepseek.js
  ↓
src/tools/bash.js
src/tools/files.js
  ↓
src/plugins/external-plugins.js
plugins.config.js
  ↓
test/core.test.js   ← behavior docs: one example per runtime
```

## The most important mental model

```text
                                    Cordis Context
                                           │
    ┌────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐
    ▼            ▼            ▼            ▼            ▼            ▼
    sessions     systemPrompt tools        llm          agents       agentLoop
                              │            │                         Agent
                              bash / files DeepSeek
                              │
                              ctx.sandbox
                              path / command / Y/n
                              └── dsh-mcp-client (optional)
                                           │
                                        Context7
```

The Agent Loop knows nothing about Context7 or Bash; it only knows `ctx.tools`. An Agent is just a thin wrapper: sessionId + model + loop (`src/core/agent-runtime.js`).

Runtime invariant: within one process, a Session has at most one active Agent Run. Different Sessions may run concurrently. This is application-level serialization, not a distributed lock; separate mini-dsh processes do not coordinate access to the same Session directory. A queued cancellation is handed to the existing AgentLoop once that Run reaches the front of its Session queue; the coordinator does not add a separate cancellation state machine.

That is the most valuable thing to learn in this project.

## Testing

```bash
pnpm test
pnpm check
```

The tests include a case where an agent finishes only after 20 straight tool calls — proof that the Loop no longer has the old 12-step cap.

Learn AI on [LINUX DO](https://linux.do)
