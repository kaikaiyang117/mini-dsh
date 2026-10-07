# mini-dsh 秋招 Agent 开发岗 · 面试准备包

> 本目录是为 mini-dsh 项目准备的**面试全流程材料**。所有技术结论、数字、边界都来自对当前仓库源码与评测报告的逐项核实，并标注了出处。
> 项目基线：61 个 commit（其中 52 个为本人提交），11 个 Phase；7 个确定性合成 Eval Suite + 16 个本地 Coding Benchmark V1 case（尚无真实模型报告）。

## 先看什么（按时间预算）

| 你有多少时间 | 阅读顺序 |
|---|---|
| 30 分钟 | `01-overview-and-pitch.md` 第一/四/五/十节 → `03-risks-and-boundaries.md` 第五节红线 |
| 半天 | `01` 全文 → `02-interview-qa.md` A/C/D/E/G/H/J 组 → `03` 全文 |
| 2-3 天 | 全部 → 按 `03` 第六节计划练 → 深入 `research/` 三份底稿 |

## 文件导航

| 文件 | 用途 | 关键内容 |
|---|---|---|
| `01-overview-and-pitch.md` | **怎么介绍项目** | 定位、简历 bullet（中英）、60 秒/3 分钟逐字稿、STAR、白板讲法、数字卡片 |
| `02-interview-qa.md` | **可能被问什么、怎么答** | A-M 共 13 组、约 80 道题：项目动机、架构、Agent Loop、Tool/并发、Context、工具发现、可靠性/exactly-once、Progress、MCP、评测、Sandbox、Agent 通识、压力题与反问 |
| `03-risks-and-boundaries.md` | **抗压与真实性防守** | 16 条必须主动交代的边界、已知缺陷与修复优先级、"是不是 AI 写的"应对、10 分钟代码导览路线、红线清单、3 天复习计划 |
| `research/runtime-facts.md` | 运行时深挖底稿 | Agent Loop/RunController/Tool/Scheduler/Session/Recovery/Progress 的 file:line 事实 + 12 个追问答点 |
| `research/context-tools-facts.md` | 上下文/工具/MCP/安全深挖底稿 | Context/TokenMeter/Compaction/Visibility/tool_search/MCP/Sandbox 的 file:line 事实 + 14 个追问答点 |
| `research/eval-facts.md` | 评测与数据深挖底稿 | 7 个 suite 真实报告数据、README 数值核实表、Scorer 设计、Benchmark 边界 + 12 个追问答点 |

## 三条底线（任何时候都不要违反）

1. **数字必须带限定**：所有百分比都是"Mock LLM 确定性合成评测"，不是真实模型结论；`cost=null` 是 unknown 不是 0。
2. **边界主动说**：持久化只到进程崩溃级、无分布式 exactly-once、沙箱不是 OS 隔离、MCP 用官方 client、可见性不是授权。
3. **不抢功劳**：持久化/压缩/并行工具是参考成熟 Harness 的通用设计做的简化实现；个人重点是 Progressive Tool Disclosure、Run Controller 停止语义、Progress Guard 与评测框架。

## 30 秒上手：最该背熟的一段

> "mini-dsh 是一个从零手写的插件化轻量级 Coding Agent Harness。核心不变量是：**每条已提交的 Tool Call 最终恰好有一条匹配的 Tool Result**。我用 append-only Event Log 做唯一事实源，在正常、取消、预算、调度器异常、进程崩溃五条路径上闭合这个协议；并实现了上下文压缩、有界并行工具、渐进式工具发现、进度守卫和 7 个确定性评测 Suite。边界我也很清楚：单进程本地恢复、合成评测、应用层 sandbox。"

## 使用提醒

- 本目录只用于面试准备，不修改项目源码。
- `research/` 是"底稿"，语言更技术、信息更密；面试时不要把底稿原文背出来，用 `01`/`02` 的话术。
- 数字卡片与 `research/eval-facts.md` 的核实表是最后一道防线，面试前务必再对一遍。
