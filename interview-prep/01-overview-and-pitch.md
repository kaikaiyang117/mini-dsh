# 01 · 项目总览与介绍话术（mini-dsh）

> 目标：让你在任何面试场景下，都能用 30 秒 / 3 分钟 / 10 分钟三个粒度准确、有层次地介绍 mini-dsh，并且话术与仓库真实代码、真实数据一致，经得起追问。

---

## 一、先想清楚：这个项目到底是什么

**一句话定位：**

> mini-dsh 是一个从零手写的、插件化的轻量级 **Coding Agent Harness**。它不训练模型，而是把"模型负责推理与生成，Harness 负责执行、状态、约束与评测"这条边界工程化，重点解决长程任务中的**可靠执行、上下文治理、工具调度与可复现评测**。

**三句话版本：**

1. 模型本身只会"想"和"写"，但真实 Agent 还需要安全地执行工具、跨进程保存状态、在有限上下文里做长任务、并发调度工具、处理崩溃与故障——这些都在 Harness 层。
2. 我参考 DeepSeek Harness（DSH）的分层思想，用 Cordis 插件体系把 Session、LLM、Tool、Agent Loop、Context、MCP 拆成可替换服务，自主实现了核心 Harness 逻辑。
3. 最终产出的不是一个 demo，而是一套边界清晰、故障语义明确、并且有 7 个确定性评测 Suite 支撑的运行时；仓库有 61 个 commit、分 11 个阶段 + Coding Benchmark V1 独立演进。

**一个必须内化的核心公式：**

```
Coding Agent = Model（推理与生成） + Harness（执行、状态、约束、评测）
```

面试时反复用这个公式做"归因"：凡是模型能力的问题，不要揽到项目上；凡是工程可靠性问题，才是本项目的主场。

---

## 二、为什么需要 Harness：面试开场的问题清单

介绍项目时，最好的切入不是"我做了哪几个模块"，而是"我发现了哪些真实工程问题"。下面这 7 个问题，每一个都对应仓库里一个真实模块，建议背熟：

| # | 真实问题 | 对应能力 | 一句话方案 |
|---|---------|---------|-----------|
| 1 | 进程重启后，会话、已执行的工具调用全丢 | Durable Session | append-only JSONL Event Log + Resume + 中断轮次恢复 |
| 2 | 模型一次返回多个工具调用，并发执行后结果乱序、异常导致调用无结果 | Tool Runtime / Scheduler | Schema 校验 + 错误数据化 + 有界并行 + 按原始顺序提交结果 |
| 3 | 长任务上下文无限增长，早晚撑爆窗口 | Context Management | 权威日志与模型上下文分离，按协议安全边界做确定性压缩 |
| 4 | MCP / 工具数量一多，每轮都把全部 schema 塞给模型，又贵又噪声大 | Progressive Tool Disclosure | 词法路由 Top-K + `tool_search` 按 Run 动态激活 |
| 5 | Agent 陷入重复无效调用，空烧 token 甚至死循环 | Progress Guard | 规范化调用 + 结果类别 + 指纹 + 新颖度的确定性启发式 |
| 6 | 崩溃时"副作用已发生但结果未落盘"，盲目重试会重复写/重复扣款 | Recovery Semantics | 记录 `outcome=unknown, retryable=false`，拒绝盲目重试 |
| 7 | 改了优化但无法证明有效，也无法回归 | Reproducible Eval | Mock LLM 驱动的 7 个确定性 Suite + 防假阳性 Scorer |

> 面试技巧：先抛问题，再说方案。这能让面试官觉得你是"被问题驱动"的工程师，而不是"背 API 的调用者"。

---
## 三、简历写法（直接可用）

### 版本 A：精简版（4 条 bullet，适合一页简历）

**Mini-dsh — 基于插件化架构的轻量级 Coding Agent Harness** ｜ 个人项目
*Node.js · DeepSeek API · Cordis 插件体系 · MCP · JSONL · JSON Schema*

- **插件化 Harness 架构**：基于 Cordis `Context / Plugin / Service` 将 Session、LLM、Tool、Agent Loop、Context、MCP 解耦为可替换服务；以 append-only Session Event Log 为唯一事实源，派生模型消息与运行状态，解决核心逻辑强耦合、难以独立演进和测试的问题。
- **持久会话与长任务治理**：自主实现 append-only JSONL Session Store、跨进程 Resume/Replay、撕裂尾部与中断 Tool Call 恢复；引入 Run Controller 对 Step、Tool Call、Token、Cost、时长与工具失败次数做统一预算与 Stop Reason 管理。
- **上下文与 Tool / MCP 治理**：以 Token-aware Compaction 解耦"权威 Event Log"与"模型可见 Context"，按不可切断 Tool Call/Result 对的边界压缩旧历史；重构 Tool Runtime（Schema 校验、超时/取消、错误数据化、有界并行调度），并实现 Managed MCP 生命周期与 **Progressive Tool Disclosure**（词法 Top-K + `tool_search` 按 Run 激活）。
- **可观测与可复现评测**：构建 `Session → Run → Step → Tool Call` 级 Trace；搭建 Mock LLM 驱动的确定性 Eval 框架，覆盖 Tool Routing、Progress、Context Pressure、Long-Horizon、Fault Injection、Crash Recovery、MCP Failure 共 7 个 Suite。在合成评测中，Progressive 路由将平均每次请求可见工具从 19 降到 1.93、Schema token 从 9,268 降到 199.6；Compacted 模式将峰值请求输入降低约 72%。

> 数字使用约束：所有百分比必须标注"**确定性合成评测（Mock LLM）**"，不要说成"真实模型上降低 XX%"。仓库里的 Coding Benchmark V1 有 16 个本地 case 与真实 provider 接线，但还没有可引用的真实模型报告，不足以支撑模型能力结论。

### 版本 B：一句话版（用于自我介绍 / 简历项目名旁注）

> 从零实现了一个插件化 Coding Agent Harness，覆盖持久会话与崩溃恢复、Run 级预算治理、上下文压缩、工具运行时与有界并行、MCP 生命周期、渐进式工具发现与确定性评测框架。

### 版本 C：英文版（供英文简历/外企面试）

**mini-dsh — a plugin-based lightweight Coding Agent Harness** (Node.js, Cordis, MCP, JSONL, JSON Schema)

- Built a plugin-composed harness that separates LLM, session, tool, context, and agent-loop concerns, using an append-only Session Event Log as the single source of truth for projection and recovery.
- Implemented durable JSONL sessions with cross-process resume, torn-tail recovery, and interrupted tool-call closure; added a per-run Run Controller governing steps, tool calls, tokens, cost, duration, and tool failures with explicit stop reasons.
- Decoupled durable history from model context via token-aware compaction at protocol-safe boundaries; rebuilt the tool runtime with JSON-Schema validation, cooperative timeout/cancellation, normalized error-as-data, and bounded parallel scheduling; managed MCP lifecycles with **progressive tool disclosure** (lexical top-K + run-scoped `tool_search`).
- Shipped a deterministic, Mock-LLM-driven evaluation framework with 7 suites (tool routing, progress, context pressure, long-horizon, fault injection, crash recovery, MCP failure); in synthetic evals, progressive routing cut visible tools per request from 19 to 1.93 and schema tokens from 9,268 to 199.6, while compaction reduced peak input by ~72%.

---
## 四、60 秒电梯介绍（逐字稿）

> "我用 Node.js 从零写了一个轻量级的 Coding Agent Harness，叫 mini-dsh。
>
> 背景是：现在大家都在做 Agent，但真正难的不是调模型 API，而是模型之外的工程问题——比如进程崩了会话怎么恢复、一次返回多个工具调用怎么安全并发、长任务上下文怎么压缩、工具一多 schema 开销怎么控制、优化完怎么证明真的有效。
>
> 我的做法是参考 DeepSeek Harness 的分层思想，用 Cordis 插件体系把 Session、LLM、Tool、Context、Agent Loop 做成可替换服务，核心不变量是：**所有事实进 append-only 的 Session Event Log，模型看到的是这份日志的可重建投影**。
>
> 在这个基础上我实现了持久会话与崩溃恢复、Run 级预算治理、按协议安全边界的上下文压缩、支持有界并行的 Tool Runtime、MCP 生命周期管理，以及两个我个人重点做的机制：Progressive Tool Disclosure 和确定性 Progress Guard。
>
> 最后我搭了一套 Mock LLM 驱动的确定性评测框架，7 个 Suite 全绿，其中渐进式工具发现把平均每请求可见工具从 19 降到 1.93、schema token 降了约 98%；压缩把峰值输入降了约 72%。项目分 11 个阶段、61 个 commit 演进。"

要点：**问题 → 边界 → 不变量 → 关键机制 → 量化结果**。全程不吹"我的模型很强"，只讲工程。

---

## 五、3 分钟标准介绍（逐字稿，可按面试方向调整）

> **① 定位（20s）**
> "mini-dsh 是一个从零实现的插件化 Coding Agent Harness，定位不是又一个聊天机器人，而是把 Coding Agent 里'模型之外'的运行时工程问题系统性地做出来。核心公式是 Coding Agent = Model + Harness。"
>
> **② 核心不变量（30s）**
> "整个系统围绕一个不变量设计：**每一条已提交的 Tool Call，最终必须有且仅有一条匹配的 Tool Result**。为了实现它，我把 append-only 的 Session Event Log 作为唯一事实源，模型消息、上下文、Trace 都是这份日志的派生投影；压缩只追加一条 compaction 记录、不删历史，恢复时从原始事件重建视图。"
>
> **③ 关键模块（60s）**
> "在执行层，Tool Runtime 做 JSON Schema 校验、把 unknown_tool / invalid_arguments / timeout / cancelled / execution_error 统一归一化成 Tool Result，超时和取消通过 AbortSignal 协作；Tool Scheduler 只让显式声明 `concurrencySafe` 的工具并行，其余作为 barrier，而且**完成顺序 ≠ 提交顺序**，结果永远按模型原始调用顺序落日志。
>
> 在状态层，Run Controller 把 step、tool call、token、cost、时长、工具失败次数做成独立预算和 Stop Reason；Progress Guard 用规范化调用 + 结果类别 + 指纹 + 新颖度检测重复无效执行。
>
> 在上下文层，Context Manager 把硬限制算成 `上下文窗口 − 预留输出`，软限制提前触发压缩；Compaction Planner 只在不会切断 Tool Call/Result 对的边界下压，并且压缩本身是确定性摘要，不引入 LLM 二次调用。"
>
> **④ 我个人重点（40s）**
> "在工具发现上我做了 Progressive Tool Disclosure：默认只给模型 base tools + `tool_search`，模型需要时搜索并激活，激活是按 Run 隔离、Run 结束清理的。它把每请求可见工具从 19 降到 1.93。这里有个诚实的结论——虽然 schema 开销大幅下降，但整个 Run 的累计输入反而比纯 Top-K 路由高，因为多了一次搜索请求；所以它不是无脑更优，而是一个可测量的 trade-off。"
>
> **⑤ 评测与边界（30s）**
> "最后我搭了确定性 Eval 框架，用 Mock LLM 覆盖工具路由、进度、上下文压力、长程编码、故障注入、崩溃恢复、MCP 失败 7 个 Suite，Scorer 会检查'测试是否先失败后通过、是否真的发生故障、Tool 协议是否闭合'等证据来防止假阳性。
>
> 边界我很清楚：这是合成评测，不是 SWE-bench，也不能证明真实模型成功率；JSONL 不提供跨进程 exactly-once；沙箱是应用层策略，不是 OS 隔离；MCP 用的是官方 client，我管的是本地生命周期。这些边界我在 README 里都写明了。"

---
## 六、STAR 结构（行为面试 / 项目深挖都能用）

- **S（背景）**：在学习和复现 DeepSeek Harness 时，我发现"LLM API + while 循环调工具"这种写法，一旦拉到长任务就会暴露一连串问题：状态丢失、工具结果乱序/丢失、上下文爆炸、崩溃后无法判断副作用是否发生、优化不可度量。
- **T（目标）**：从零实现一个**可解释、可测试、可恢复**的轻量 Coding Agent Harness，把长程执行的核心工程问题做成边界清晰、可替换、可验证的模块，而不是堆功能。
- **A（行动）**：
  1. 先固定 baseline 和个人贡献边界（上游 snapshot 与后续独立 commit 分离）；
  2. 按 Phase 递进：Trace → Session Persistence/Resume → Run Controller → Tool Runtime V2 → Parallel Tool Calls → Context/Compaction → Managed MCP → Tool Catalog/Routing → Progressive Tool Search → Progress Guard → Eval Framework；
  3. 每个模块坚持"先定义契约和不变量，再实现，最后用评测/测试锁定行为"，并专门设计了 fault injection / crash recovery / MCP failure 三类可靠性评测；
  4. 对每个优化都做 baseline 对照，并主动记录不能外推的边界。
- **R（结果）**：7 个确定性 Eval Suite 全绿（含 11 个故障注入用例、5 个崩溃恢复用例、9 个 MCP 生命周期用例）；Long-Horizon Suite 中 managed 模式把工具暴露从 25 降到 9（-64%）、累计估算输入从约 19.5 万降到约 9.9 万（-49%）；Context Pressure Suite 中压缩把峰值请求输入降低约 72%；项目分 11 个 Phase、61 个 commit 演进，`pnpm test / check / lint` 与 CI 全通过。
- **反思（一定要准备）**：如果重做，我会优先把 TokenMeter 换成真实 tokenizer 做校准、把 lexical routing 升级为可评测的 embedding/混合检索、并补一个真实模型的多 case benchmark 来验证合成评测结论能否迁移。

> STAR 的"反思"部分是高级信号：既展示诚实，也展示你知道下一步该做什么。

---

## 七、白板讲解：一条主线 + 三层结构

面试官说"你画一下架构"时，**不要一上来画全部方框**，按下面的顺序边画边讲：

```
第 1 层：入口与编排
  User/CLI → AgentRuntime → AgentLoopRuntime
                              ├── RunController（是否继续）
                              └── ContextManager（看到什么）

第 2 层：执行与状态
  AgentLoop
    ├── ToolCatalog → ToolVisibility（可见哪些 schema）
    ├── ToolScheduler → ToolRuntime（怎么执行、怎么并发）
    ├── LlmRuntime → Provider Adapter（调模型）
    └── SemanticProgressDetector（是否在空转）
  SessionRuntime → SessionStore（Memory / JSONL）
                    └── Event Log（唯一事实源）→ Projection/Compaction/Recovery

第 3 层：治理与验证
  TraceRuntime（可观测）
  Eval Framework + 7 Suites（可复现验证）
  SandboxRuntime（应用层策略）
  McpManager（本地生命周期）→ 官方 MCP Client
```

讲解口诀：

> **"一条事实源（Event Log），两个分离（Durable History vs Model Context；可信数据 vs 派生数据），三个边界（可见性≠授权、生命周期≠远端健康、应用层策略≠OS 隔离）。"**

这句话能把整个架构串起来，面试官会立刻记住。

---

## 八、面试官的第一反应与应对

| 面试官可能的反应 | 你的应对 |
|---|---|
| "这不就是 ReAct / function calling 循环吗？" | 认同循环本身是标准范式，然后指出价值在循环之外的 Harness：协议不变量、持久化恢复、并发提交顺序、预算与停止语义、上下文压缩边界、评测方法论。 |
| "这些 DeepSeek Harness / LangChain 不是都有吗？" | "对，持久化、压缩、并行工具这些是成熟 Harness 的通用设计，我在 README 里明确写成'参考成熟设计后自主实现的简化版本'；我重点做的是 Progressive Tool Disclosure、Run Controller 的停止语义、Progress Guard 和评测框架，这些是我自己的扩展。" |
| "有真实模型的效果数据吗？" | 诚实回答：目前只有确定性合成评测 + 一个基础设施 smoke case + 16 个本地 Coding Benchmark V1 case，但还没有可引用的真实模型报告，不足以支撑成功率/排名结论；并说明为什么合成评测对验证 Harness 行为是合适的（可控、可复现、能构造故障），以及下一步怎么补真实 benchmark。 |
| "用了多少现成框架？" | 明确区分：Cordis 提供插件/服务/生命周期，官方 MCP client 提供协议与传输，Ajv 提供 schema 校验；Agent Loop、Session、Run Controller、Tool Runtime/Scheduler、Context、Visibility、Progress、Eval 都是本仓库实现。 |
| "这个项目是不是 AI 生成的？" | 不要辩解，直接展示掌控力：打开一个核心文件讲关键行、讲你踩过的坑、讲一个失败的设计和重构、现场改一个小需求。详见 `03-risks-and-boundaries.md`。 |
| "你最大的技术难点是什么？" | 选"协议不变量在所有退出路径上的闭合"（正常/取消/预算耗尽/调度器异常/崩溃），讲清楚每条路径怎么补记录；这是最能体现工程深度的点。 |

---

## 九、自我介绍模板（把项目嵌进 1 分钟个人介绍）

> "面试官好，我是 XX，主要方向是 Agent 应用与后端工程。
>
> 我最近完整地从零实现了一个 Coding Agent Harness。最开始我是想搞清楚：为什么很多 Agent demo 能跑通，但一到长任务就不稳定。做完之后我的结论是——**难点基本不在模型，而在 Harness 的可靠性和可观测性**。
>
> 所以我的项目重点做了三件事：第一，用 append-only Event Log 做唯一事实源，让会话可恢复、压缩不丢历史、每个 Tool Call 都有确定的结局；第二，把工具执行做成有 Schema 校验、错误数据化、有界并行、可取消的运行时，并保证提交顺序稳定；第三，搭了一套确定性评测框架，用故障注入和崩溃恢复去证明这些可靠性不是嘴上说说。
>
> 我个人的两个亮点是渐进式工具发现和进度守卫，也做了 baseline 对照，包括主动暴露它的 trade-off。"

---

## 十、必须记住的数字卡片（面试前 5 分钟速览）

| 指标 | 数值 | 出处 / 边界 |
|---|---|---|
| 仓库规模 | 61 commit / 11 Phase；其中 52 commit 为本人提交 | `git log`；上游 snapshot 之后独立演进 |
| Tool Routing 可见工具 | All 19 → Deterministic 5 → Progressive 1.93（每请求均值） | `.eval/tool-routing.json`，5 个 case，Mock LLM |
| Tool Routing Schema token | All 9,268 → Det. 336 → Prog. 199.6（每请求均值） | 同上 |
| Tool Routing 累计输入/run | All 18,650.8 → Det. 786.8 → Prog. 1,016.2 | Progressive 因多一次搜索请求，整 Run 反而不如 Deterministic |
| Context Pressure 峰值/请求 | Full 5,697 → Compacted 1,578（约 -72%） | `.eval/context-pressure.json`，1,900 窗口/200 预留 |
| Context Pressure 累计/run | Full 20,884 → Compacted 9,040（约 -57%） | 同上；Constrained 模式全部 context_overflow |
| Compaction 次数 | Compacted 模式 suite 共 17 次 | 同上 |
| Long-Horizon 工具暴露 | baseline 25 → managed 9（-64%） | `.eval/long-horizon.json`，5 case，Mock LLM |
| Long-Horizon 累计估算输入 | baseline 194,553 → managed 98,657（约 -49%） | managed = Routing + Progress + Compaction 组合，不可单因素归因 |
| 可靠性用例 | fault-injection 11/11、crash-recovery 5/5、mcp-failure 9/9 | `.eval/*.json` |
| 真实模型数据 | Coding Benchmark V1：16 个本地 case + 真实 provider 接线；无可引用的真实模型报告，**不构成能力结论** | `BENCHMARK.md` |
| 代码/测试规模 | src 约 6,900 行 / test 约 9,300 行 / eval 约 3,700 行；32 个测试文件、7 个 Eval Suite | 测试代码量大于源码，体现工程严谨性与回归意识 |

> 面试时数字只报有出处的；说不出出处的数字，宁可不报。
