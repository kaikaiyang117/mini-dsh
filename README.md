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

Model-visible Tools are selected per Step through `ToolCatalog` and `ToolVisibility`:

```text
Registered Tools -> Tool Catalog -> Per-Step Visibility -> Model Request
```

Default visibility selects all registered Tools. Set `MINI_DSH_TOOL_ROUTING=deterministic` for lexical Top-K routing (`MINI_DSH_MAX_VISIBLE_TOOLS`, default `12`); no-match and non-ASCII-only queries fall back to all Tools. Set `MINI_DSH_TOOL_ROUTING=progressive` to pin `tool_search` alongside that deterministic base. The search uses the same lexical ranking against the full current Tool Catalog, returns compact name/description matches, and activates hits for later Steps in the current Run only (`MINI_DSH_MAX_ACTIVATED_TOOLS`, default `24`). This gives the model a chance to refine its search query between Steps. A reached activation limit is reported in the result; matches are still returned. Each Step takes a fresh catalog snapshot, and Run completion clears activation state. Matching is ASCII-token based: it does not understand cross-language meaning, synonyms, semantic similarity, or intent changes beyond the query the model supplies. `/tools` continues to show registered Tools; visibility is not authorization, and hidden Tools remain executable through the Tool Runtime. Progressive discovery does not lazily connect MCP servers; only already-registered Tools can be found.

Still intentionally outside the current runtime scope are semantic no-progress detection, a steering queue, a full model configuration center, and a TUI/Web UI. The sandbox remains an application-level path/command policy with approval, not a kernel isolation boundary.

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
