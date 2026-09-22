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

可选：填写 `CONTEXT7_API_KEY`。`mcp.context7.com` 不可达时 Context7 会标记为 `FAILED`，但 CLI 仍会启动。

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

当前仍不在 Runtime 范围内：语义 no-progress detection、steering queue、完整模型配置中心和 TUI/Web UI。Sandbox 仍然是应用层路径/命令 Policy 加人工确认，不是内核级隔离。

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
