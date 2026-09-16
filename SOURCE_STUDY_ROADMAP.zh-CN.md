# mini-dsh 源码学习路线：按 Commit 演进读懂一个 Agent Harness

> 这份文档不是“从零手写 mini-dsh”的重复教程。
>
> 仓库已有的 [`LEARNING.zh-CN.md`](./LEARNING.zh-CN.md) 更适合按里程碑重新实现一遍；本文则沿着原作者真实的 commit 演进顺序，回答三个问题：**项目为什么先做这一层、这一层解决什么问题、下一层为什么自然出现。**
>
> 目标不是记住代码，而是最终能够独立解释并重写这条链路：
>
> ```text
> User
>   ↓
> Agent
>   ↓
> AgentLoop
>   ↓
> Session Event Log + System Prompt + Tool Schemas
>   ↓
> LLM
>   ├─ 无 tool_calls → answer
>   └─ 有 tool_calls → ToolRuntime → tool/result → 再回 LLM
> ```

---

## 0. 学习目标

学完本路线后，至少应该能不看源码回答这些问题：

1. 为什么 `mini-dsh` 先实现 Session，而不是先接 DeepSeek API？
2. 为什么 Session 保存的是 Event Log，而不是直接维护 `messages[]`？
3. `ToolRuntime` 为什么要先于 Bash/File/MCP 工具出现？
4. 为什么 Agent Loop 完全不需要知道 DeepSeek、Bash、Context7 分别是什么？
5. `AgentRuntime` 与 `AgentLoopRuntime` 的职责为什么要分开？
6. 为什么 MCP 可以直接进入现有 Agent Loop，而不需要 `if (mcp)` 分支？
7. 为什么流式 Tool Call 需要单独处理 `name` 和 `arguments` 的 delta？
8. 为什么用户按 Esc 取消一次多工具调用，可能破坏整个 Session？
9. 为什么只用 `path.resolve()` 仍然挡不住 workspace 内部软链接逃逸？
10. 为什么项目中的命令黑名单不能被称为真正的安全沙箱？
11. Unit Test 全绿为什么仍然可能 `pnpm start` 就炸？
12. 如果把这个学习版继续升级成真正可用于 Coding Agent 的 Runtime，下一步最值得补哪些子系统？

如果这些问题能完整讲清楚，这个项目才算真正学到了。

---

# 1. 先准备：你的仓库是快照，原始 Commit 历史在上游

当前仓库保存的是上游项目当前源码快照；本文分析的 commit 来自原始仓库：

```text
https://github.com/huangjunsen0406/mini-dsh
```

建议本地 clone 自己的仓库后，加一个 `upstream`：

```bash
git clone https://github.com/kaikaiyang117/mini-dsh.git
cd mini-dsh

git remote add upstream https://github.com/huangjunsen0406/mini-dsh.git
git fetch upstream
```

以后阅读某个 commit，最常用的命令只有这些：

```bash
# 查看提交说明 + diff
git show <commit>

# 只看改了哪些文件
git show --stat <commit>

# 查看某个 commit 时某个文件的完整内容
git show <commit>:src/core/session-runtime.js

# 比较一个 commit 与父提交
git diff <commit>^ <commit>

# 临时切到历史版本运行
git switch --detach <commit>

# 回到自己的主分支
git switch main
```

不要一上来就读最终版本全部源码。这个项目最适合从根 commit 开始顺着演化读。

---

# 2. 整体时间线：27 个主线 Commit

| 序号 | Commit | 类型 | 核心变化 | 建议 |
|---:|---|---|---|---|
| 1 | `16b40e0` | chore | Cordis 最小宿主 | 精读 |
| 2 | `1d942a0` | feat | Session Event Log + deriveMessages | **必读** |
| 3 | `efd4eda` | feat | SessionRuntime → `ctx.sessions` | 精读 |
| 4 | `5cca4a1` | feat | ToolRuntime + OpenAI tool schemas | **必读** |
| 5 | `d99f009` | feat | SystemPromptRuntime + LlmRuntime | **必读** |
| 6 | `d9ad4ec` | feat | Tool / Prompt 暴露为 Cordis Service | 精读 |
| 7 | `f63a96f` | feat | AgentRuntime + AgentLoopRuntime | **必读** |
| 8 | `232c8d8` | feat | `ctx.agents` + `ctx.agentLoop` | 精读 |
| 9 | `30d80f7` | chore | 代码格式整理 | 快速扫 |
| 10 | `f5aa6d3` | feat | DeepSeek Streaming Adapter | **必读** |
| 11 | `e8143b6` | feat | CLI + Runtime Context | 精读 |
| 12 | `9e5202f` | test | `/reset` 保持 Session ID | 精读 |
| 13 | `7f025ec` | feat | External Plugin Loader + MCP | **必读** |
| 14 | `28d9c83` | feat | Application-level Sandbox | **必读** |
| 15 | `4a660d2` | feat | Bash / File Tools | 精读 |
| 16 | `c50675d` | feat | Human Approval `[Y/n]` | 精读 |
| 17 | `e432938` | chore | `pnpm check` | 快速扫 |
| 18 | `0d31444` | feat | Esc + AbortController | 精读 |
| 19 | `bfee788` | fix | MCP 故障隔离 | 精读 |
| 20 | `4c1500f` | docs | 中英文架构/学习文档 | 快速扫 |
| 21 | `2e5a17f` | docs | CLI 截图 | 跳读 |
| 22 | `ef3eeba` | style | Biome 统一格式 | 快速扫 |
| 23 | `7c3ca7a` | fix | Cancel 时保持 Tool Call/Result 一致性 | **重点精读** |
| 24 | `bf81e95` | fix | 防 Symlink Workspace Escape | **重点精读** |
| 25 | `f377770` | test | 真实 Cordis Integration Test | **重点精读** |
| 26 | `ad21109` | docs | 修正文档中的安全模型/测试 | 精读 |
| 27 | `26afb01` | chore | MIT License | 快速扫 |

完整演进可以压缩成：

```text
Cordis Host
  ↓
Session Event Log
  ↓
Tool Runtime
  ↓
Prompt Runtime + LLM Runtime
  ↓
Agent Runtime + Agent Loop
  ↓
DeepSeek Streaming Adapter
  ↓
CLI + Runtime Context
  ↓
MCP Plugin Loader
  ↓
Sandbox Policy
  ↓
Bash / File Tools
  ↓
Human Approval
  ↓
Cancellation
  ↓
Failure Isolation
  ↓
State Consistency Fix
  ↓
Filesystem Security Fix
  ↓
Integration Test
```

---

# 3. 阶段一：先搭宿主，不写 Agent

## Commit 1：`16b40e0` — scaffold minimal DSH runtime demo

原始提交：

```text
https://github.com/huangjunsen0406/mini-dsh/commit/16b40e01bc04bbceaba1578646467cc177c00091
```

### 这一阶段解决什么

项目刚开始只有：

```text
package.json
src/index.js
README.md
README.zh-CN.md
.gitignore
```

`src/index.js` 本质只有：

```js
const ctx = new Context()

await ctx.plugin({
    name: 'hello',
    apply(ctx) {
        console.log('plugin loaded')
    },
})
```

这一步不是在实现 Agent，而是在确认一个更基础的问题：

> 后续所有 Agent 能力是否都可以作为插件挂到同一个 Context 上？

作者从一开始就没有选择一个大而全的 `Agent` 类，而是先建立：

```text
Context = 能力容器
Plugin  = 能力安装单元
Service = 对其他插件暴露的稳定接口
```

最终才会自然长成：

```text
ctx.sessions
ctx.systemPrompt
ctx.tools
ctx.llm
ctx.agents
ctx.agentLoop
ctx.sandbox
```

### 必看文件

```text
src/index.js
package.json
```

### 你需要理解

不要把 Cordis 理解成“Agent 框架本身”。在这个项目里，它主要承担：

- 依赖注入
- 插件生命周期
- Service 暴露
- effect/disposer 管理

真正的 Agent Runtime 逻辑后面全部在 `src/core/`。

### 自己做一个实验

新建一个最小插件：

```js
await ctx.plugin({
    name: 'demo',
    apply(ctx) {
        ctx.demo = { value: 1 }
    },
})
```

思考：如果以后 `ctx.tools`、`ctx.llm`、`ctx.sessions` 都这样挂进去，Agent Loop 是否可以只依赖接口而不依赖实现？

### 学完标准

能够解释：

> mini-dsh 的核心不是“DeepSeek API 调用代码”，而是围绕 Cordis Context 组织的一组 Runtime/Plugin。

---

# 4. 阶段二：先设计 Agent 的“事实”，再设计模型调用

## Commit 2：`1d942a0` — Session Event Log

原始提交：

```text
https://github.com/huangjunsen0406/mini-dsh/commit/1d942a0f691316d26b3e98cd89bb3d7258233681
```

这是整个仓库最重要的提交之一。

### 设计选择

普通聊天 Demo 很容易写成：

```js
messages.push({ role: 'user', content: input })
messages.push({ role: 'assistant', content: answer })
```

mini-dsh 没这么做，而是：

```text
SessionEvent[] = 事实
messages       = 给 LLM 的投影视图
```

事件类型：

```text
session/start
user/message
assistant/message
assistant/tool_calls
tool/result
```

之后由：

```js
deriveMessages(sessionId)
```

投影成 OpenAI-compatible messages。

### 为什么这是更好的设计

因为 Agent 历史并不只有“用户说了什么、模型回答什么”。还有：

```text
模型思考/Reasoning
Tool Call
Tool Result
取消
错误
未来可能加入的 Compaction / Checkpoint / Budget 事件
```

如果直接把 Chat API 的 `messages[]` 当数据库，业务状态和模型输入会耦合在一起。

Event Log 则让两者分开：

```text
真实状态
   ↓ project
LLM Context
```

这已经接近 Event Sourcing 的思路。

### 必看文件

```text
src/core/session-runtime.js
test/core.test.js
```

### 重点追踪一条 Tool Call

Event Log：

```text
user/message
assistant/tool_calls
  - id: t1
  - name: bash
  - arguments: {...}
tool/result
  - toolCallId: t1
```

投影后：

```text
user
assistant(tool_calls=[t1])
tool(tool_call_id=t1)
```

必须理解 `tool_call.id` 和 `tool_call_id` 的对应关系。

### 为什么 `reasoning_content` 也要进 Event Log

DeepSeek thinking + tool call 的下一轮请求可能需要把上一轮 reasoning 一起恢复。

因此：

```text
assistant/tool_calls
```

不能只保存 `toolCalls`，还保存：

```text
reasoningContent
```

然后 `deriveMessages()` 恢复为：

```js
reasoning_content
```

### 必做实验

在测试里加入：

```text
user/message
assistant/tool_calls
assistant/message
```

自己打印：

```js
console.dir(sessions.get(id).events, { depth: null })
console.dir(sessions.deriveMessages(id), { depth: null })
```

对比“事实”和“投影”。

### 面试自测

- Event Log 与直接保存 messages 有什么区别？
- 为什么 Tool Call 和 Tool Result 必须成对？
- 如果未来加入 Compaction，你应该压缩 Event Log 还是只改变投影？

建议答案：**完整 Event Log 更适合保留为 durable truth；模型上下文可以是受预算限制的 projection。**

---

## Commit 3：`efd4eda` — SessionRuntime → Cordis Service

```text
https://github.com/huangjunsen0406/mini-dsh/commit/efd4edaae2ee738e1073faef5e2204b10589c7f2
```

### 这一步真正做了什么

把：

```text
SessionRuntime
```

包装成：

```text
ctx.sessions
```

这时项目开始稳定形成两层：

```text
src/core/
    纯逻辑，可直接 new，可单测

src/plugins/
    Cordis Adapter，只负责把 runtime 暴露到 ctx.xxx
```

这条边界后面必须一直记住。

### 阅读重点

比较：

```text
src/core/session-runtime.js
src/plugins/sessions.js
```

观察 Plugin 本身有多薄。

### 学完标准

能解释：

> 为什么测试优先直接 new Runtime，而不是每个单测都启动整个 Cordis Context。

---

# 5. 阶段三：先定义 Tool 协议，再写具体 Tool

## Commit 4：`5cca4a1` — ToolRuntime

```text
https://github.com/huangjunsen0406/mini-dsh/commit/5cca4a1285e65bec56b1d8810ea9f5d5c8ca009a
```

这是第二个必须精读的抽象。

### ToolRuntime 的职责

核心 API：

```text
register(definition)
get(name)
list()
schemas()
execute(name, args, execContext)
renderResult(result)
```

ToolRuntime 此时并不知道：

```text
Bash
read_file
MCP
GitHub
Database
```

它只定义统一 Tool Contract。

### 为什么先写 ToolRuntime

错误顺序通常是：

```text
先写 bash()
先写 readFile()
先写 MCP client
最后才想如何统一
```

正确顺序是：

```text
Tool Contract
    ↓
Tool Registry
    ↓
Tool Execution
    ↓
具体工具只是插件
```

这使得后续 Agent Loop 永远只调用：

```js
this.tools.execute(call.name, call.arguments, context)
```

### OpenAI Function Schema

需要重点读 `schemas()`：

Runtime 中的工具定义会投影成：

```json
{
  "type": "function",
  "function": {
    "name": "...",
    "description": "...",
    "parameters": {}
  }
}
```

于是：

```text
同一个 Tool Definition
    ├─ 给 Agent Runtime 执行
    └─ 给 LLM 生成 schema
```

### 为什么 `execute()` 不轻易把异常抛出 Agent Loop

工具失败也是模型需要看到的“观察结果”。

因此 Tool Runtime 尽量统一成：

```js
{
    value,
    content,
    isError
}
```

这样模型可以在下一轮决定：

```text
工具失败
  ↓
换参数 / 换工具 / 向用户解释
```

而不是整个 Runtime 一遇到工具错误就崩掉。

### 为什么 register 返回 disposer

```js
const dispose = tools.register(tool)
```

卸载插件时：

```js
dispose()
```

工具马上消失。

这给后面 MCP 动态接入留下了生命周期接口。

### 必做实验

自己注册三个工具：

```text
echo
add
always_fail
```

观察：

```text
schemas()
execute()
renderResult()
dispose()
```

分别返回什么。

### 面试自测

- Tool Registry 和普通函数 Map 的差别是什么？
- 为什么工具错误通常应该转换成 observation，而不是直接使 Agent Run 失败？
- 如果工具有副作用，Runtime 还需要哪些 metadata？

后一个问题是你后续扩展项目的切入点：

```text
readOnly
idempotent
sideEffect
permission
retryable
```

---

# 6. 阶段四：把 Prompt 和 Model Provider 从 Agent 中拆出去

## Commit 5：`d99f009` — System Prompt + LLM Runtime

```text
https://github.com/huangjunsen0406/mini-dsh/commit/d99f009564129d4f1002cb7a701d06c16abc5fad
```

### SystemPromptRuntime

不是写死一整段：

```js
const system = `You are ...`
```

而是让不同插件注册 Prompt Fragment：

```text
section
context
```

然后：

```text
assemble()
```

按顺序组合。

这很重要，因为系统提示词并不是只有 Agent Persona。

最终可能来自：

```text
Agent Identity
Sandbox Policy
Runtime Environment
Memory
Project Instructions
Tool Guidance
```

这些最好由不同模块贡献，而不是所有逻辑都去修改同一个字符串。

### 为什么每一步都重新 assemble

后面的 Agent Loop 每轮都会重新：

```js
systemPrompt.assemble(...)
```

因为其中有动态信息：

```text
当前时间
workspace
cwd
环境状态
```

### LlmRuntime

这是 Provider Registry，不是 DeepSeek Client。

结构：

```text
                LlmRuntime
                    │
       ┌────────────┼────────────┐
       ↓            ↓            ↓
   DeepSeek       Mock        Future Provider
```

统一选择字符串：

```text
provider/model
```

例如：

```text
deepseek/deepseek-v4-pro
mock/demo
```

### 最重要的设计结论

Agent Loop 后面只认识：

```js
llm.chat(...)
```

完全不知道：

```text
API URL
Authorization Header
SSE
Provider-specific request body
```

这就是 Adapter 层的价值。

### 必看文件

```text
src/core/system-prompt-runtime.js
src/core/llm-runtime.js
```

### 必做实验

注册两个 Mock Provider：

```text
mock-a/model-1
mock-b/model-2
```

确认 Agent Runtime 的逻辑不用修改就能切换。

---

## Commit 6：`d9ad4ec` — Tool/Prompt 暴露成 Service

```text
https://github.com/huangjunsen0406/mini-dsh/commit/d9ad4ecde8471fe81e14f6d310d7cc701902ea1d
```

这一提交主要是“接线”。

重点不是代码难度，而是继续观察相同模式：

```text
Runtime
   ↓ thin wrapper
Cordis Service
   ↓
ctx.xxx
```

这时已经有：

```text
ctx.sessions
ctx.tools
ctx.systemPrompt
ctx.llm
```

Agent Loop 所需要的四个依赖终于齐了。

---

# 7. 阶段五：Agent Harness 的心脏出现

## Commit 7：`f63a96f` — Agent Loop

```text
https://github.com/huangjunsen0406/mini-dsh/commit/f63a96fe6a55b6a39ed868464eb927c9b4410b01
```

这是全仓库最应该手抄/重写一次的文件。

### AgentRuntime 与 AgentLoopRuntime 是两回事

`AgentRuntime` 管理 Agent 实例。

Agent 只是一个很薄的句柄：

```text
id
name
sessionId
model
send()
```

核心执行逻辑不在 Agent 里，而在：

```text
AgentLoopRuntime
```

因此：

```text
Agent = configuration + identity + handle
AgentLoop = execution engine
```

### Agent Loop 完整数据流

```text
agent.send(input)
   ↓
append user/message
   ↓
while (true)
   ↓
assemble system prompt
   ↓
deriveMessages(sessionId)
   ↓
tools.schemas()
   ↓
llm.chat(...)
   ↓
response.toolCalls ?
   ├─ No
   │    ↓
   │ assistant/message
   │    ↓
   │ return content
   │
   └─ Yes
        ↓
      assistant/tool_calls
        ↓
      tools.execute()
        ↓
      tool/result
        ↓
      回到 while 顶部
```

### 为什么 Session Event Log 是 Source of Truth

每一轮模型调用之前都：

```js
const messages = this.sessions.deriveMessages(sessionId)
```

所以 Agent Loop 没有维护第二份 history。

这很关键：

```text
唯一事实源 = events
```

否则以后非常容易出现：

```text
Event Log 有一套
messages[] 又有一套
取消/错误时两边不一致
```

### 为什么没有 12-step cap

学习版故意：

```js
while (true)
```

结束条件是模型不再产生 Tool Call。

这能突出最基础的 Agent Loop，但生产版明显还缺：

```text
maxSteps
maxToolCalls
timeout
token budget
cost budget
no-progress detection
```

这些正是后续可以由你自己增强的方向。

### 多 Tool Calls

模型一次可能返回：

```text
t1: read_file
t2: grep
t3: bash
```

当前实现是：

```text
顺序执行全部工具
   ↓
全部写 tool/result
   ↓
再回模型
```

这里要思考一个扩展问题：

> 哪些工具可以并行？

不能简单把全部工具 `Promise.all()`。

例如：

```text
read_file A
read_file B
```

可能安全并行。

但：

```text
write_file A
bash "git commit"
```

可能有依赖和副作用。

### 流式 Callback

Agent Loop 只透传：

```text
onReasoning
onContent
onToolCall
onToolResult
```

这为 CLI/TUI/Web UI 留出接口。

### 必做实验

不用真实 DeepSeek，自己写 Mock LLM：

第一次：

```js
return {
    toolCalls: [{ id: 't1', name: 'clock', arguments: {} }]
}
```

第二次读取最后一条 `tool` message 后：

```js
return { content: 'done', toolCalls: [] }
```

亲自跟踪 Event Log 如何变化。

### 学完标准

你应该能从空文件重新写出一个 60~100 行的最小 Agent Loop，而不是背最终源码。

---

## Commit 8：`232c8d8` — Agent/Loop → Cordis Services

```text
https://github.com/huangjunsen0406/mini-dsh/commit/232c8d81c3ec907216dff937ab82538eb7ad8c98
```

重点看依赖注入：

```text
agentLoop
  inject:
    sessions
    systemPrompt
    tools
    llm
```

这正好对应 Agent Loop 的四个核心依赖。

如果看懂这里，`src/index.js` 后面就只是“组装应用”。

---

## Commit 9：`30d80f7` — 格式调整

没有行为变化。

学习时快速确认：

```bash
git show --stat 30d80f7
```

不必精读。

---

# 8. 阶段六：最后才接真实 DeepSeek

## Commit 10：`f5aa6d3` — DeepSeek Streaming Adapter

```text
https://github.com/huangjunsen0406/mini-dsh/commit/f5aa6d38e03734f65c81dfb45c8b0ea011091d2f
```

注意实现顺序：

```text
Session
Tool Runtime
Prompt Runtime
LLM Runtime
Agent Loop
全部先完成
    ↓
才接 DeepSeek
```

这是值得学习的工程顺序。

如果反过来先把 DeepSeek HTTP API 塞进 Agent 类，后面每做一个抽象都要拆代码。

### DeepSeek Adapter 的职责

只负责 Provider-specific 的事情：

```text
API Key
Base URL
Request Body
Thinking 参数
SSE Streaming
reasoning_content
content
tool_calls delta
```

最终归一化成：

```js
{
    content,
    reasoningContent,
    toolCalls
}
```

Agent Loop 不知道 SSE 的存在。

### SSE Parser 必须理解

重点函数：

```text
parseSSE
accumulateToolCallDelta
finalizeToolCalls
parseToolArguments
```

#### 1. Stream Chunk 不等于完整事件

网络 chunk 可能是：

```text
chunk1: data: {....Hel
chunk2: lo....}\n
```

所以必须维护 buffer。

#### 2. 最后一行可能没有 `\n`

如果 parser 只在读到换行时 flush，最后 token 会丢。

#### 3. Tool Call 本身也是流式增量

例如 function name：

```text
ba
sh
```

最终：

```text
bash
```

arguments 同理：

```text
{"pa
th":"README.md"}
```

所以要累计字符串，最后再 `JSON.parse`。

### 为什么这部分适合面试

因为这不是“会 fetch API”，而是：

```text
Streaming Protocol Parsing
Incremental State Assembly
Partial JSON Handling
Provider Adapter Isolation
```

### 必做实验

不要调用 API，自己构造假的 `ReadableStream` / reader，分别测试：

```text
完整 SSE
跨 chunk SSE
最后没有 \n
[DONE]
拆分 function.name
拆分 arguments
非法 JSON
```

---

# 9. 阶段七：从 Runtime 变成可交互应用

## Commit 11：`e8143b6` — CLI + Runtime Context

```text
https://github.com/huangjunsen0406/mini-dsh/commit/e8143b6f42b32623f27f60831253faddc53272b7
```

### CLI 的正确定位

CLI 只是 UI Adapter。

不要把：

```text
Session
Tool execution
LLM loop
```

写进 CLI。

CLI 主要做：

```text
读取输入
调用 agent.send()
渲染 reasoning/content/tool
处理命令
```

### Runtime Context

`runtime-context.js` 很值得看。

它说明一个 Agent 的“现实世界信息”来自 Harness：

```text
时间
时区
workspace
platform
Node version
hostname
```

而不是模型自己天然知道。

这能帮助建立很重要的 Agent 心智模型：

```text
Model = 推理引擎
Harness = 给模型提供现实上下文和可执行能力
```

### CLI Commands

理解这些命令分别观察哪一层：

```text
/tools     → Tool Registry
/models    → LLM Runtime
/model     → Agent model selection
/history   → Session Event Log
/prompt    → SystemPromptRuntime
/reset     → Session reset semantics
/exit      → UI lifecycle
```

这些命令实际上是很好的调试入口。

---

## Commit 12：`9e5202f` — `/reset` 的语义

```text
https://github.com/huangjunsen0406/mini-dsh/commit/9e5202ff9d43092046a20634cdb1cff63078d84c
```

### 为什么这是一个值得单独测试的行为

错误实现：

```text
/reset
  ↓
delete old session
create new session
```

当前设计：

```text
/reset
  ↓
保留 session.id
清空 events
写新的 session/start(reset=true)
```

于是：

```text
Session Identity ≠ Conversation History
```

这是一种很干净的建模。

### 思考扩展

如果未来 Session 持久化到 SQLite：

```text
clear
```

究竟应该物理删除旧 events，还是追加：

```text
session/reset
```

并在 projection 中按最后一个 reset 截断？

这是很好的架构讨论题。

---

# 10. 阶段八：MCP 是 Tool Provider，不是 Agent Loop 特例

## Commit 13：`7f025ec` — External Plugin Loader + MCP

```text
https://github.com/huangjunsen0406/mini-dsh/commit/7f025ec2d468902ff0dc7eb5543dea6f749a4b1c
```

这是第三个特别值得理解的架构点。

### 链路

```text
Context7 MCP Server
        ↓
@deepseek-ai/dsh-mcp-client
        ↓
ctx.tools.register(...)
        ↓
ToolRuntime
        ↓
AgentLoop
```

### 最关键结论

Agent Loop 没有：

```js
if (tool.type === 'mcp') {
    ...
}
```

因为 MCP 最终也只是：

```text
Tool Definition
```

这就是统一 Tool Contract 的价值。

### External Plugin Loader

阅读：

```text
src/plugins/external-plugins.js
plugins.config.js
```

主要逻辑是：

```text
config
  ↓
dynamic import(package)
  ↓
ctx.plugin(module, config)
```

### 为什么要 await plugin startup

因为如果 CLI 先出现：

```text
User >
```

而 MCP 工具还没注册，用户第一次 `/tools` 看到的就是不完整状态。

这属于插件生命周期/启动顺序问题。

### 面试自测

- MCP 与 Function Calling 有什么关系？
- MCP 为什么在此项目中不会污染 Agent Loop？
- 如果两个 MCP Server 注册同名 Tool 怎么办？
- MCP Server 掉线之后现有 Tool Registry 怎么更新？

后两题就是你后面可以实现的 `MCP Manager`。

---

# 11. 阶段九：Agent 有执行能力后，安全问题才真正出现

## Commit 14：`28d9c83` — Application-level Sandbox

```text
https://github.com/huangjunsen0406/mini-dsh/commit/28d9c831da4abadf7eecf288fad6b20c028263fd
```

这个提交代码不少，但读的时候先不要陷进正则。

先理解三层结构：

```text
1. Path Gate
2. Command Policy
3. Approval
```

### Path Gate

目标：

```text
所有文件操作只能在 workspace 内
```

### Command Policy

拦一些明显危险命令：

```text
rm -rf
sudo / su
shutdown / reboot
mkfs / dd
curl | sh
访问系统路径
未授权外网请求
```

### Approval

危险行为最终必须经过：

```text
approve(request)
```

### 不要误解成真正 Sandbox

这个类自己也明确说明：

```text
不是 kernel isolation
不是 seccomp
不是 container
```

命令策略本质是黑名单。

例如理论上仍可以绕过：

```bash
python3 -c '...'
node -e '...'
echo <base64> | base64 -d | sh
```

因此：

```text
Command denylist = 降低误操作
不是 = 安全隔离边界
```

### 真正值得学的安全分层

```text
Path Allowlist
    ↓
Command Heuristics
    ↓
Human Approval
    ↓
如果需要真正隔离，再进入 Container / bwrap / VM / seccomp
```

---

## Commit 15：`4a660d2` — Bash / File Tools

```text
https://github.com/huangjunsen0406/mini-dsh/commit/4a660d271f233aaecfd8d3a1edc0673abe30eb56
```

终于出现真正的本地工具：

```text
bash
read_file
write_file
edit_file
glob
grep
```

### 阅读时重点不是每个工具实现

重点跟踪注册路径：

```text
files plugin
   ↓
ctx.tools.register(read_file)
ctx.tools.register(write_file)
...
```

然后确认 Agent Loop 仍然没有改。

这证明：

```text
新增 Capability ≠ 修改 Agent Engine
```

### 对 Coding Agent 的意义

最小 Coding Agent 的能力大致就是：

```text
读文件
搜索代码
编辑文件
执行命令
观察结果
继续推理
```

mini-dsh 已经有这个最小闭环。

### 必做实验

把某个 Tool Plugin 注释掉，再 `/tools`。

确认 Tool capability 可以动态消失，而 Agent Loop 本身完全不变。

---

## Commit 16：`c50675d` — Human Approval

```text
https://github.com/huangjunsen0406/mini-dsh/commit/c50675db9edebb8cb02009f1bef7db8ddb883305
```

写文件和 Bash 前加入：

```text
Allow this? [Y/n]
```

### 为什么 Approval 比命令黑名单更重要

黑名单只能猜：

```text
哪些命令看起来危险
```

Approval 则把最终决策交给人。

所以安全链条应该理解为：

```text
Model proposes action
        ↓
Policy pre-check
        ↓
Human approves/rejects
        ↓
Execute
```

这是 Human-in-the-loop Agent 的基本执行模型。

---

# 12. 阶段十：开始补工程体验和可取消性

## Commit 17：`e432938` — Syntax Check

```text
https://github.com/huangjunsen0406/mini-dsh/commit/e432938d9d98f00ceb09e116d5617b32fb73fcc4
```

新增：

```bash
pnpm check
```

运行 `node --check` 检查源码、测试、脚本。

快速理解即可。

---

## Commit 18：`0d31444` — Esc Cancel + AbortController

```text
https://github.com/huangjunsen0406/mini-dsh/commit/0d3144406eb23fbdf1bb30440baf510698ca38e1
```

### Cancellation 传播链

```text
Esc
 ↓
AbortController.abort()
 ↓
signal
 ├─ LLM fetch
 ├─ AgentLoop
 └─ Tool execution
```

### 为什么方向键不能触发取消

终端方向键通常也是 Escape Sequence：

```text
ESC [ A
ESC [ B
```

所以不能“看到 0x1b 就无脑取消”，要区分单独 Esc 与完整按键序列。

### 思考

Cancellation 不是 UI 小功能。

它会立刻引出一个更深的问题：

> 当执行被中断时，Agent 的状态还能否保持一致？

这个坑几天后真的出现了。

---

## Commit 19：`bfee788` — MCP Failure Isolation

```text
https://github.com/huangjunsen0406/mini-dsh/commit/bfee788e0d1cc54f218427288b276023bd014fb8
```

问题：

```text
Context7 TLS reset
    ↓
MCP plugin startup throws
    ↓
整个 CLI 起不来
```

修复：

```text
required: false
failOnStartupError: false
```

于是：

```text
MCP 成功 → 多一组工具
MCP 失败 → 日志报错，但核心 Agent 正常工作
```

### 这是典型的故障域设计

生产 Agent 常有：

```text
Model Provider
MCP Server
Vector DB
Browser
Search API
GitHub
Filesystem
```

不能让每个非核心能力都变成整个 Agent 的单点故障。

### 面试自测

- required plugin 与 optional plugin 如何区分？
- MCP 重连应该由 Agent Loop 管还是 MCP Manager 管？
- 某 MCP 工具已经发给模型 schema，但服务器刚好断线，执行时怎么办？

---

# 13. 阶段十一：先别急着看文档 Commit，先看两个最值钱的 Bug

Commit 20~22 主要是文档、截图和代码风格，可以快速浏览。

真正最值得精读的是 23、24。

---

# 14. 重点 Bug 一：取消导致整个 Session 被“毒死”

## Commit 23：`7c3ca7a`

```text
https://github.com/huangjunsen0406/mini-dsh/commit/7c3ca7a6717cbf1df7a6b188830e707b04d5c4b0
```

提交标题：

```text
fix: record a tool result for every call when a run is cancelled
```

这是全项目最适合面试讲的工程 Bug 之一。

### 场景

模型一次返回两个调用：

```text
t1 = slow()
t2 = slow()
```

Session 已经写入：

```text
assistant/tool_calls [t1, t2]
```

执行完/执行中 `t1` 后，用户按 Esc。

旧实现直接：

```js
throw new Error('Agent run cancelled')
```

于是日志可能变成：

```text
assistant/tool_calls
  - t1
  - t2

tool/result
  - t1

// t2 没有对应 result
```

### 为什么这不只是“少了一条日志”

下一轮 `deriveMessages()` 会投影为：

```text
assistant:
    tool_calls = [t1, t2]

tool:
    tool_call_id = t1
```

Chat Completions 协议要求 Tool Calls 和 Tool Results 对得上。

`t2` 没有结果，因此下一轮请求本身非法。

结果：

```text
一次 Esc
  ↓
破坏 Session protocol invariant
  ↓
后续每一轮都无法继续
```

### 修复思想

取消后不是马上退出，而是：

```text
已经完成的调用 → 正常 result
剩余未执行调用 → synthetic cancelled result
```

例如：

```text
tool/result t2:
ToolError: the run was cancelled before this tool ran
```

等 Event Log 恢复自洽之后才抛 `cancelled`。

### 这里真正值得学的是“不变量”

Agent Runtime 应该有类似：

```text
Invariant:
Every persisted assistant tool_call must eventually have a matching tool/result.
```

这和数据库/分布式日志一致性非常像。

### 必做实验

把这个修复暂时回退，运行对应测试：

```text
Cancelling a multi-tool turn still records a result for every tool_call
```

先看到它红，再恢复修复。

### 面试表达模板

不要只说：

> 我做了 Esc 取消。

更好的讲法：

> Agent 一次模型响应可能包含多个 Tool Calls。最初在 AbortSignal 触发后直接抛异常，会使已经持久化到 Session Event Log 的部分 Tool Call 缺少对应 Tool Result，导致下一轮投影出的 Chat Completion history 不满足协议约束，整个 Session 后续都不可用。后来将“日志一致性”定义为执行不变量：取消时为尚未执行的 Tool Call 写入 synthetic cancelled result，待日志恢复自洽后再结束 Run。

---

# 15. 重点 Bug 二：Workspace 内软链接可以逃逸

## Commit 24：`bf81e95`

```text
https://github.com/huangjunsen0406/mini-dsh/commit/bf81e95936d1b7fe01ea338c498c6d87244665ba
```

### 最初的 Path Gate

逻辑大致是：

```text
workspace=/project
requested=../etc/passwd
 ↓
path.resolve
 ↓
发现不在 /project
 ↓
deny
```

能挡普通：

```text
../
绝对路径
```

但挡不住软链接。

### 攻击/逃逸场景

workspace 内有：

```text
/project/escape -> /etc
```

Agent 请求：

```text
/project/escape/passwd
```

词法路径仍然是：

```text
/project/escape/passwd
```

所以看起来在 workspace 内。

但操作系统真正解析后是：

```text
/etc/passwd
```

### 修复：两阶段 Containment

第一阶段：

```text
Lexical containment
```

用来挡：

```text
../
absolute escape
```

第二阶段：

```text
Filesystem containment
```

使用 `realpath` 解析软链接后再次判断。

### 为什么 root 自己也必须 realpath

macOS 常见：

```text
/tmp -> /private/tmp
```

如果只 realpath target，不 realpath root：

```text
root   = /tmp/work
 target = /private/tmp/work/a
```

反而会误判合法路径越界。

所以必须：

```text
realpath(root)
realpath(target)
```

在同一个规范空间里比较。

### 更难的一点：写入目标不存在

例如：

```text
/project/escape/new-file
```

`new-file` 还没创建，直接 `realpathSync()` 会失败。

因此实现：

```text
不断向父目录回退
 ↓
找到最长已存在前缀
 ↓
realpath(existing prefix)
 ↓
再把缺失路径片段拼回去
```

这才能同时保护：

```text
read existing file
write/create new file
```

### 这是一个非常好的面试安全案例

涉及：

```text
Lexical path resolution
Filesystem canonicalization
Symlink traversal
TOCTOU 的进一步思考
Read/Write path asymmetry
```

### 继续追问自己

即使现在有 `realpath`，是否就完全安全？

不一定。

在检查和真正打开文件之间仍可能有：

```text
TOCTOU race
```

生产级安全隔离更适合：

```text
OS capability
container
mount namespace
openat-style safe traversal
```

不要把这个学习版的路径闸门夸成真正隔离。

---

# 16. 阶段十二：Unit Test 不等于系统真的接对了

## Commit 25：`f377770` — Integration Test

```text
https://github.com/huangjunsen0406/mini-dsh/commit/f37777001c088c0bcdf05314139b6d06c8db67d4
```

### 问题

之前测试大多是：

```js
new SessionRuntime()
new ToolRuntime()
new LlmRuntime()
new AgentLoopRuntime(...)
```

这能证明各模块本身正确。

但证明不了 Cordis Wiring 正确。

例如：

```text
inject 拼错
插件加载顺序错
Service 没注册
ctx.effect 没执行
Tool Plugin 没挂上
```

Unit Test 仍然可能全部通过。

### Integration Test 做了什么

真正：

```js
const root = new Context()
```

然后按照 `src/index.js` 的顺序挂：

```text
sessions
systemPrompt
tools
llm
agents
agentLoop
runtimeContext
sandbox
bash
files
```

只把真正网络 LLM 换成 Mock Provider。

然后执行完整闭环：

```text
User
 ↓
Agent
 ↓
Mock LLM
 ↓
bash pwd
 ↓
Tool Result
 ↓
Mock LLM
 ↓
done
```

并检查 Event Log：

```text
session/start
user/message
assistant/tool_calls
tool/result
assistant/message
```

### 这类测试价值很高

它验证的是：

```text
Architecture Wiring
```

而不是单个函数。

### 以后你扩展项目时必须保留

每加一个核心 Service，例如：

```text
Persistence
ContextManager
Telemetry
RunPolicy
MCPManager
```

都应该有至少一条真实 Context Smoke Test。

---

# 17. Commit 26~27：修正文档认知并完成开源收尾

## `ad21109` — 安全模型/学习文档纠偏

```text
https://github.com/huangjunsen0406/mini-dsh/commit/ad2110963f745bfcf107e8cb12646b957ed69ee4
```

这个 commit 很有价值，因为作者主动修正了两个“教程本身教错”的地方：

1. Command Sandbox 是 denylist，不能被描述成可靠攻击防御。
2. 早期学习文档中的 Agent Loop cancellation 伪代码也会产生未配对 Tool Call。

说明这个项目不仅在修代码，也在修自己的架构认知。

## `26afb01` — MIT License

```text
https://github.com/huangjunsen0406/mini-dsh/commit/26afb013b0aa8a6525d1af7433a44a49bf41caeb
```

最终切换到 MIT License。

你在自己的仓库继续改时，应保留原 LICENSE 与原作者版权声明。

---

# 18. 最终源码应该按什么顺序读

不要按目录字母顺序。

推荐按数据流：

```text
1. src/index.js
       ↓
2. src/plugins/*.js
       ↓
3. src/core/session-runtime.js
       ↓
4. src/core/tool-runtime.js
       ↓
5. src/core/system-prompt-runtime.js
       ↓
6. src/core/llm-runtime.js
       ↓
7. src/core/agent-runtime.js
       ↓
8. src/core/agent-loop-runtime.js
       ↓
9. src/models/deepseek.js
       ↓
10. src/plugins/runtime-context.js
       ↓
11. src/plugins/external-plugins.js
       ↓
12. src/core/sandbox-runtime.js
       ↓
13. src/utils/path.js
       ↓
14. src/tools/files.js
15. src/tools/bash.js
       ↓
16. src/plugins/cli.js
       ↓
17. test/core.test.js
18. test/integration.test.js
```

阅读时始终问：

```text
这个模块提供什么 Contract？
谁调用它？
它依赖谁？
状态保存在哪里？
失败后如何表示？
插件卸载后如何清理？
```

---

# 19. 用“一次真实请求”贯穿所有源码

假设用户输入：

```text
读取 package.json，然后告诉我项目使用什么依赖。
```

你应该能在脑中走完整条路径。

## Step 1：CLI

```text
User input
 ↓
agent.send(input)
```

## Step 2：Agent

Agent 只有：

```text
sessionId
model
loop
```

然后：

```text
loop.run(agent, input)
```

## Step 3：Session

写：

```text
user/message
```

## Step 4：构造模型输入

```text
systemPrompt.assemble()
sessions.deriveMessages()
tools.schemas()
```

## Step 5：LLM Runtime

根据：

```text
deepseek/deepseek-v4-flash
```

路由到 DeepSeek Adapter。

## Step 6：DeepSeek Adapter

Streaming 返回：

```text
Tool Call:
read_file({ path: "package.json" })
```

## Step 7：Agent Loop

先把调用本身记入：

```text
assistant/tool_calls
```

## Step 8：ToolRuntime

找到：

```text
read_file
```

执行。

## Step 9：File Tool / Sandbox

路径先经过：

```text
resolveInside(workspace, "package.json")
```

再读取文件。

## Step 10：Tool Result

写：

```text
tool/result
```

## Step 11：第二轮 LLM

再次：

```text
deriveMessages()
```

这次模型会看到：

```text
user
assistant tool_call
tool result
```

于是最终回答依赖信息。

## Step 12：完成

Agent Loop 发现：

```text
response.toolCalls.length === 0
```

写：

```text
assistant/message
```

然后 return。

如果这条链能完整讲出来，源码主体已经理解了一半以上。

---

# 20. 测试阅读路线

测试不要最后才看。这个仓库很多设计意图实际写在测试里。

建议按下面分组读。

## A. Session Contract

重点：

```text
Event Log → Messages projection
clear() semantics
reasoning_content
```

## B. Tool Contract

重点：

```text
register/dispose
schema
error normalization
render result
```

## C. LLM Runtime

重点：

```text
provider/model selection
provider disposer
model routing
```

## D. Agent Loop

重点：

```text
model → tool → model
20 tool calls
stream callbacks
multi-tool cancellation
```

## E. DeepSeek Streaming

重点：

```text
SSE last line
function name delta
tool arguments JSON
```

## F. Sandbox / Path

重点：

```text
../ escape
absolute escape
..hidden false positive
symlink escape
env expansion
allowHosts
```

## G. Integration

重点：

```text
真实 Cordis Context
插件接线
工具注册
完整 model-tool-model turn
optional/required plugin failure
```

---

# 21. 学源码时建议维护一份自己的 Architecture Notes

每读完一个阶段，自己写四行：

```text
模块：SessionRuntime
职责：保存 Agent 事实事件，并投影 LLM messages
输入：append(type, data)
输出：deriveMessages()
不负责：Persistence / Compaction / Token Budget
```

最后形成：

| 模块 | 核心职责 | 不负责什么 |
|---|---|---|
| SessionRuntime | Event Log / Projection | DB 持久化、压缩 |
| ToolRuntime | Tool Registry / Execution Contract | 具体 Bash/MCP 实现 |
| SystemPromptRuntime | Prompt Fragment 组合 | 模型调用 |
| LlmRuntime | Provider Registry / Routing | HTTP/SSE Provider 细节 |
| AgentRuntime | Agent 实例注册 | 执行循环 |
| AgentLoopRuntime | Model-Tool-Model orchestration | Provider/MCP/CLI 细节 |
| DeepSeek Adapter | Provider-specific streaming | Agent strategy |
| SandboxRuntime | Policy gate / approval | Kernel isolation |
| CLI | 用户交互 | Agent 核心逻辑 |

这张表必须能自己写出来。

---

# 22. 学完后必须能画出的架构图

```text
                           ┌─────────────────────┐
                           │        CLI          │
                           └──────────┬──────────┘
                                      │
                                      ↓
                           ┌─────────────────────┐
                           │        Agent        │
                           │ sessionId / model   │
                           └──────────┬──────────┘
                                      │ send()
                                      ↓
                ┌────────────────────────────────────────┐
                │             AgentLoopRuntime           │
                └──────┬────────────┬────────────┬───────┘
                       │            │            │
                       ↓            ↓            ↓
                 Sessions     SystemPrompt     Tools
                       │                         │
                       │                         ├──────── Bash
                       │                         ├──────── Files
                       │                         └──────── MCP
                       │
                       ↓
                  Event Log
                       │
                       └── deriveMessages()

                               AgentLoop
                                  │
                                  ↓
                              LlmRuntime
                                  │
                                  ↓
                           DeepSeek Adapter
                                  │
                                  ↓
                            Chat Completions
```

还应该能补出工具安全链：

```text
Model Tool Call
      ↓
ToolRuntime
      ↓
Tool Plugin
      ↓
Path/Command Policy
      ↓
Human Approval
      ↓
OS / Filesystem
```

---

# 23. 面试级自测题

不要看答案，先自己说。

## 架构

1. 为什么 `AgentLoopRuntime` 不应该直接 import DeepSeek Adapter？
2. 为什么 Tool、LLM、Session 都做成 Registry/Runtime？
3. Cordis 在这个项目中解决的主要问题是什么？
4. `core/` 和 `plugins/` 为什么分层？
5. `ctx.effect()` / disposer 对动态能力有什么价值？

## Session / Context

6. Event Sourcing 在这个 Agent 中体现在哪里？
7. `messages` 为什么不应该是唯一事实源？
8. Tool Call/Result 为什么必须有 ID 对应关系？
9. 如果 Session 非常长，应该在哪里做 Compaction？
10. 如何做到压缩 Context 但仍保留完整可审计历史？

## Tools

11. 为什么 MCP 工具能无侵入接入？
12. Tool Error 为什么适合作为 observation 返回模型？
13. Tool Call 能否全部并行？
14. 哪些 Tool metadata 可以帮助判断并行和重试？
15. 一个 side-effect Tool 超时后可以直接 retry 吗？为什么？

## LLM / Streaming

16. Provider Adapter 为什么必须与 Agent Loop 解耦？
17. SSE parser 为什么需要 buffer？
18. Tool Call arguments 为什么不能每个 chunk 直接 JSON.parse？
19. 模型流式响应中断时，应该如何定义 Run 状态？

## Reliability

20. 为什么一次 Cancel 会破坏整个 Session？
21. Agent Runtime 有哪些 protocol invariant？
22. MCP 启动失败为什么不应该默认终止整个 Agent？
23. Unit Test 与 Integration Test 分别覆盖什么？

## Security

24. `path.resolve` 为什么挡不住 symlink escape？
25. 为什么 Command denylist 不是 sandbox？
26. Human Approval 是不是绝对安全？它有什么局限？
27. 如果要做真正隔离，Docker/bubblewrap/VM 应该放在哪一层？

---

# 24. 学完原项目后，下一步不要急着加 UI

如果目标是把这个项目继续做成自己的 Agent Runtime 项目，优先补下面四组能力。

## 方向一：Session Persistence + Recovery

当前：

```text
Map() only
process exit → session lost
```

建议增加：

```text
Persistence Interface
├── MemoryStore
├── JSONLStore
└── SQLiteStore
```

重点研究：

```text
Event replay
Crash recovery
Interrupted tool call
Idempotency
Unknown side-effect outcome
```

最自然的接口：

```text
appendEvent()
loadEvents()
listSessions()
recoverRun()
```

## 方向二：Context Management

当前每一轮：

```text
deriveMessages(all events)
```

长会话会不断膨胀。

建议增加：

```text
Token Meter
Context Budget
Compaction
Summary Event
Recent Window
```

关键原则：

```text
Event Log = durable truth
LLM Context = bounded projection
```

## 方向三：Run Policy

当前：

```text
while (true)
```

建议加入：

```text
maxSteps
maxToolCalls
maxDuration
maxInputTokens
maxOutputTokens
maxCost
noProgressThreshold
```

并定义结构化结束原因：

```text
completed
cancelled
timeout
step_limit
token_budget
cost_budget
no_progress
context_overflow
```

## 方向四：Tool/MCP Governance + Observability

Tool Runtime：

```text
JSON Schema validation
per-tool timeout
retry policy
concurrency policy
readOnly / idempotent / sideEffect metadata
permission/capability
```

MCP：

```text
lazy connect
health check
reconnect
backoff
namespace
hot reload
```

Observability：

```text
session_id
run_id
step_id
tool_call_id
LLM latency
TTFT
token usage
cost
tool latency
tool success rate
stop reason
```

这些比先做一个 Web UI 更值得投入。

---

# 25. 推荐的个人学习检查清单

不要按“看完文件”打勾，按“能否解释/重写”打勾。

## 第一层：理解

- [ ] 能解释 Cordis Context / Plugin / Service
- [ ] 能解释 Session Event Log
- [ ] 能解释 `deriveMessages()`
- [ ] 能解释 Tool Registry
- [ ] 能解释 LLM Provider Adapter
- [ ] 能解释 Agent / AgentLoop 的区别
- [ ] 能解释 model → tool → model 闭环
- [ ] 能解释 MCP 为什么不需要 AgentLoop 特判
- [ ] 能解释 Runtime Context 为什么属于 Harness

## 第二层：源码

- [ ] 不看源码能写简化 SessionRuntime
- [ ] 不看源码能写简化 ToolRuntime
- [ ] 不看源码能写简化 LlmRuntime
- [ ] 不看源码能写简化 AgentLoopRuntime
- [ ] 能手写一个 Mock Provider
- [ ] 能手写一个 Mock Tool
- [ ] 能让 Mock Agent 跑通两轮 model-tool-model

## 第三层：工程问题

- [ ] 能解释 SSE chunk/buffer
- [ ] 能解释 Tool Call delta assembly
- [ ] 能解释 AbortSignal 传播
- [ ] 能解释 multi-tool cancel consistency bug
- [ ] 能解释 symlink workspace escape
- [ ] 能解释 optional MCP failure isolation
- [ ] 能解释 integration test 为什么必要

## 第四层：扩展设计

- [ ] 能设计 Session Persistence Interface
- [ ] 能设计 Context Compaction
- [ ] 能设计 Run Policy
- [ ] 能设计 No-Progress Detector
- [ ] 能设计 Tool Metadata / Concurrency Policy
- [ ] 能设计 MCP Lifecycle Manager
- [ ] 能设计 Agent Trace / Metrics

---

# 26. 最后：真正掌握这个项目的标准

不是：

```text
我把源码看完了。
```

也不是：

```text
我能运行 pnpm start。
```

而是你能从下面这个空白问题开始自己推导：

> 我要写一个最小 Coding Agent Runtime，需要哪些核心抽象？

然后自己给出：

```text
Session
    保存事实历史

Tool Runtime
    管工具契约、注册和执行

System Prompt Runtime
    管可组合的上下文

LLM Runtime
    隔离不同模型 Provider

Agent
    保存运行实例配置

Agent Loop
    协调 Model → Tool → Model

Plugin Host
    管能力组合与生命周期
```

接着还能继续指出学习版缺失：

```text
Persistence
Context Budget / Compaction
Run Policy
No-Progress Detection
Robust Tool Governance
MCP Lifecycle
Observability
Evaluation
Real Isolation
```

到这个程度，你就不再只是“看懂 mini-dsh”，而是已经能独立讨论一个 Agent Harness 应该怎样设计。

---

# 附录 A：27 个 Commit 快速索引

```text
16b40e0  chore: scaffold minimal DSH runtime demo
1d942a0  feat: derive chat messages from session event log
efd4eda  feat: expose SessionRuntime as a cordis sessions plugin
5cca4a1  feat: add in-memory ToolRuntime with OpenAI function schemas
d99f009  feat: add system prompt and LLM runtimes with ctx.llm
d9ad4ec  feat: expose tools and system prompt as cordis services
f63a96f  feat: add agent loop that runs model-tool-model turns
232c8d8  feat: expose agents and agent loop as cordis services
30d80f7  chore: indent agent and system-prompt modules
f5aa6d3  feat: add DeepSeek streaming chat adapter
e8143b6  feat: boot an interactive CLI over the cordis host
9e5202f  test: keep session id after clear and drop derived history
7f025ec  feat: load external Cordis plugins from plugins.config.js
28d9c83  feat: add application-level sandbox with path and command gates
4a660d2  feat: register bash and workspace file tools on ctx.tools
c50675d  feat: inject sandbox into the CLI and prompt for write approval
e432938  chore: add a syntax check script for src, test, and scripts
0d31444  feat: cancel an in-flight agent run with Esc
bfee788  fix: keep the CLI up when Context7 MCP is unreachable
4c1500f  docs: add bilingual EN/zh-CN docs for architecture, learning, and README
2e5a17f  docs: add CLI demo screenshot to bilingual READMEs
ef3eeba  style: unify code style with Biome
7c3ca7a  fix: record a tool result for every call when a run is cancelled
bf81e95  fix: block a symlink inside the workspace that points out of it
f377770  test: boot the whole plugin stack on a real Cordis Context
ad21109  docs: front the sandbox with what it cannot block, and inline every test
26afb01  chore: add the MIT license and point package.json at it
```

---

# 附录 B：最小复习路径

如果隔了一段时间回来，不想重新从头看，按这 8 个 commit 恢复记忆：

```text
1d942a0  Session Event Log
    ↓
5cca4a1  Tool Runtime
    ↓
d99f009  Prompt + LLM Runtime
    ↓
f63a96f  Agent Loop
    ↓
f5aa6d3  DeepSeek Streaming
    ↓
7f025ec  MCP Plugin
    ↓
7c3ca7a  Cancel Consistency
    ↓
bf81e95  Symlink Security
```

这 8 个基本覆盖项目最有技术价值的部分。
