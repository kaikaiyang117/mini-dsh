# mini-dsh

[English](./README.md) | 中文

基于 [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis)，按 DSH 概念手写的最小运行时。

这是一个**用于学习 DSH 核心设计**的最小项目，不追求做成完整 DSH 产品。

目标只保留五件事：

1. Cordis Context / Plugin / Service
2. Session Event Log -> deriveMessages()
3. Tool Registry -> register / schemas / execute
4. LLM Provider Adapter
5. Agent Loop -> model -> tool -> model -> answer

另外保留了 Bash/File 工具和官方 `@deepseek-ai/dsh-mcp-client` + Context7，用来验证“Everything is a Plugin”。Context7 是可选的：连不上时 CLI 照样启动，只是没有那些 MCP 工具。

## 演示

![mini-dsh CLI](./images/demo.png)

## 环境

- Node.js `>= 20.18.1`
- pnpm `11.22.0`（见 `package.json` 的 `packageManager`）

## 运行

```bash
pnpm install
cp .env.example .env
# 填写 DEEPSEEK_API_KEY
pnpm start
```

`.env.example` 里写的是 `deepseek/deepseek-v4-flash`；如果完全没有 `MINI_DSH_MODEL`（例如没复制 `.env`），入口回退到 `deepseek/deepseek-v4-pro`（`src/index.js:41`）。

可选：填写 `CONTEXT7_API_KEY`。远端首次连接失败不会导致客户端 Fiber 启动失败；CLI 仍会启动，后续重连由官方客户端管理。`ACTIVE` 只表示 Fiber 已激活，不代表远端健康。

Context7 连上之后的路径：

```text
@deepseek-ai/dsh-mcp-client
  -> https://mcp.context7.com/mcp
  -> ctx.tools.register(...)
  -> mcp__context7__resolve-library-id
  -> mcp__context7__query-docs
```

Managed MCP 生命周期：

```text
McpManager
  -> @deepseek-ai/dsh-mcp-client
  -> 远程 MCP Server
```

Mini-DSH 只管理 MCP Plugin Instance 生命周期，并提供 `DISCONNECTED`、`CONNECTING`、`ACTIVE`、`FAILED` 四种状态。MCP 协议传输、发现、Tool 同步和重连继续由官方 `dsh-mcp-client` 负责。`ACTIVE` 只表示客户端 Plugin Fiber 已成功激活，不代表远端 transport 当前一定健康。

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

写文件和 Bash 执行前会问 `[Y/n]`。Agent 跑起来后按 **Esc** 取消当前轮（方向键不会误取消）。

## Agent Loop 的治理与 Context

核心执行形状仍然是 model -> tool -> model，但现在每个 Agent Run 都由独立的 `RunController` 和 `ContextManager` 管理：

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

当前 Runtime 已包含：

- 每个 Run 独立的 step、Tool Call、duration、input/output token、estimated cost 和 Tool failure 限制；单项限制使用 `null` 关闭；
- Run deadline，以及 LLM / Tool 的 cooperative cancellation；
- 基于 Event Log 的 Context Projection、Token Pressure 和确定性持久 Compaction；
- append-only JSONL Session persistence、resume、replay 和 interrupted-tool recovery；
- 只对显式标记 `concurrencySafe` 的 Tool 做有界并行；
- 同一 Session 内 Agent Run FIFO 串行，不同 Session 可以并发。
- 可选的 Run-scoped 确定性 no-progress 检测、临时策略提醒和显式启用的 hard stop。

`ToolCatalog` 为当前已注册 Tool 提供 metadata snapshot。每个 Step 的可见策略由 `AllToolsVisibility`、`DeterministicToolVisibility` 或 `ProgressiveToolVisibility` 选择：

```text
Registered Tools -> Tool Catalog -> Per-Step Visibility -> Model Request
```

配置示例（均为默认值）：

```dotenv
MINI_DSH_TOOL_ROUTING=all
MINI_DSH_MAX_VISIBLE_TOOLS=12
MINI_DSH_MAX_ACTIVATED_TOOLS=24
```

`MINI_DSH_TOOL_ROUTING=all` 暴露全部已注册 Tool。`MINI_DSH_TOOL_ROUTING=deterministic` 使用词法 Top-K 路由；大 Catalog 无匹配时回退到全部 Tool，以保持兼容。`MINI_DSH_TOOL_ROUTING=progressive` 固定暴露 `tool_search`，基础路由在无匹配时只返回 pinned Tools；不超过 Top-K 的小 Catalog 仍全量可见。搜索使用相同词法排序检索当前完整 Tool Catalog，只返回精简名称/描述，并将命中 Tool 激活到当前 Run 的后续 Step。这让模型可以在不同 Step 间调整搜索 query。达到激活上限时结果会列出未激活的命中；每个 Step 都读取新 Catalog snapshot，Run 结束会清除激活状态。匹配仅基于 ASCII 词元，不具备跨语言语义、同义词或语义相似度理解。`/tools` 继续展示已注册 Tool；Visibility 不是授权机制，被隐藏的 Tool 仍可通过 Tool Runtime 执行。Progressive Search 不会惰性连接 MCP Server，只发现已经注册的 Tool。

Semantic Progress Detection V1 是可选的确定性启发式规则，结合规范化 Tool Call、结果类别、结果指纹和结果新颖度，检测重复且没有新信息的执行。默认 `off`；`remind` 注入固定的临时策略提醒；`guarded` 还会以 `no_progress` 停止 Run。它不是 LLM 语义裁判、embedding 相似度、完整目标状态推理或 workspace 语义 diff。Workspace 变化和目标进展仍是未来可探索的信号。Sandbox 仍然是应用层路径/命令 Policy 加人工确认，不是内核级隔离。

```dotenv
MINI_DSH_PROGRESS_MODE=off
MINI_DSH_PROGRESS_SOFT_STEPS=3
MINI_DSH_PROGRESS_HARD_STEPS=6
```

`MINI_DSH_PROGRESS_SOFT_STEPS` 在 `remind` 和 `guarded` 模式生效。`MINI_DSH_PROGRESS_HARD_STEPS` 只在 `guarded` 模式参与运行时决策；`off` 不创建 Detector。所有模式都会校验显式设置的阈值。

## Evaluation

### Harness Evaluation

当前确定性 `tool-routing` 和 `progress` suites 共用 JavaScript EvalCase / EvalSuite contract、runner 和带版本号的 JSON 报告。EvalCase 包含 `name`、`prompt`、`expected`，以及可选的 `limits`、`metadata`、`scorer`；Suite 定义有序字符串 variant 和 fixture factory。Fixture 至少提供 `agent`、`trace`、`recordingTokenMeter`，还可提供 `dispose`、`inspectors`、`metadata`。Scorer 接收具名对象参数，并返回成功状态和可选的、有界 JSON details。

Report 带有 `schemaVersion: 1`、Suite metadata、有序 variant 汇总和稳定的单 case 结果。结果保留 stop reason、duration、steps、Tool calls、request 与可见 Tool 数、schema 与估算输入指标、provider usage / cost availability，以及 target-tool 结果。Provider usage（`inputTokens`、`outputTokens`、`reasoningTokens`、`cost`）与 Harness 估算（`estimatedInputTokens`、`toolSchemaTokens`）保持分离。

每个结果固定保留这些字段：`suiteName`、`caseName`、`variant`、`success`、`error`、`stopReason`、`durationMs`、`steps`、`toolCalls`、`requestCount`、`inputTokens`、`outputTokens`、`reasoningTokens`、`cost`、`visibleToolCount`、`visibleToolCountByStep`、`maxVisibleToolCount`、`toolSchemaTokens`、`toolSchemaTokensByStep`、`estimatedInputTokens`、`estimatedInputTokensByStep`、`targetToolCalled`、`targetToolSucceeded` 和有界 `scoreDetails`。

运行 `pnpm eval:tool-routing`、`pnpm eval:progress`、`pnpm eval:context-pressure` 和 `pnpm eval:long-horizon`，报告分别写入 `.eval/tool-routing.json`、`.eval/progress.json`、`.eval/context-pressure.json` 和 `.eval/long-horizon.json`。Long-Horizon 是在一次性本地仓库中运行的 deterministic synthetic coding workflow，使用 Mock LLM 比较 baseline 与 managed Harness；它不是 SWE-bench、HumanEval 或真实模型 Coding Benchmark。Context Pressure suite 在 1,900 token context window（预留 200 output tokens）下比较 full history、有限窗口但不 compaction、以及 deterministic compaction。这些离线 Mock Eval 用于测试 Harness policy 和 runtime behavior，不是生产模型排行榜或真实 Coding Benchmark。

生产 `SandboxRuntime` 目前是应用层 policy gate，不是操作系统级隔离。

## 给新手：从零手写

不要直接读完整仓库。先扫一遍 **[ARCHITECTURE.md](./ARCHITECTURE.md)** 建立整体概念图，再新建空项目，按 **[LEARNING.md](./LEARNING.md)** 的里程碑自己写一遍。

如果想按照原作者的真实开发历史理解“为什么先做这一层、下一层如何演进”，可以直接看 **[SOURCE_STUDY_ROADMAP.zh-CN.md](./SOURCE_STUDY_ROADMAP.zh-CN.md)**。这份路线按 27 个主线 commit 组织源码阅读、实验和面试自测。

如果已经理解当前最小 Harness，并准备继续把它扩展成自己的 Agent Runtime，请按 **[DEVELOPMENT_ROADMAP.zh-CN.md](./DEVELOPMENT_ROADMAP.zh-CN.md)** 推进。该路线以当前代码为基线，对照成熟 DSH 的生产能力，分阶段实现 Session Persistence、Run Controller、Tool Runtime V2、Parallel Tool Calls、Context Compaction、MCP 生命周期，并进一步完成 Progressive Tool Disclosure、Semantic Progress Detection、Agent Evaluation 与 Fault Injection。

## 推荐阅读顺序

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
src/core/agent-loop-runtime.js   ← 最核心
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
test/core.test.js   ← 行为文档：每个 runtime 都有对应示例
```

## 最重要的心智模型

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

Agent Loop 不知道 Context7，也不知道 Bash 是什么；它只知道 `ctx.tools`。Agent 只是一个薄封装：sessionId + model + loop（`src/core/agent-runtime.js`）。

这就是这个项目最值得学习的部分。

## 测试

```bash
pnpm test
pnpm check
```

测试里包含一个 Agent 连续执行 20 次工具调用后才结束的案例，用来证明 Agent Loop 已经不再有原来的 12-step 正常上限。

学AI上[LINUX DO](https://linux.do)
