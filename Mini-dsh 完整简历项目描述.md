Mini-dsh — 基于插件化架构的轻量级 Coding Agent Harness　　　　　　　　　2026.09 - 至今

GitHub：github.com/kaikaiyang117/mini-dsh

项目简介： 参考 DeepSeek Harness 的架构设计，自主实现轻量级 Coding Agent Harness，围绕持久会话、Agent 长任务执行、上下文治理、Tool / MCP 调度与 Agent 评测构建核心能力，并针对大规模工具场景设计 Progressive Tool Disclosure 等运行时优化机制。

技术栈： Node.js · DeepSeek API · Cordis · MCP · JSONL · JSON Schema

项目内容：

插件化 Harness 架构： 基于 Cordis Context / Plugin / Service 将 Session、System Prompt、LLM、Tool 与 Agent Loop 解耦为可替换服务，并以 append-only Session Event Log 作为会话权威历史，通过事件投影派生模型 Messages 与运行状态；解决 Harness 核心模块强耦合、状态多份维护及能力难独立演进的问题。
持久会话与长任务治理： 设计可插拔 SessionStore 持久化层，自主实现 append-only JSONL Session Store、Session Resume / Replay，并针对日志撕裂尾部和异常中断 Turn 进行恢复；同时设计 Run Controller，对 Step、Tool Call、Token、Cost 与执行时长实施统一 Budget 和结构化 Stop Reason，解决进程重启后会话丢失及 Agent 长任务无限执行的问题。
上下文与 Tool / MCP 治理： 基于 Token Pressure 实现 Context Compaction，将较早历史压缩为 Summary 并保留近期原始对话，在不修改完整 Event Log 的情况下控制模型上下文规模；重构 Tool Runtime，引入 JSON Schema 参数校验、Timeout / Cancellation 和基于 Concurrency Safety 的有界并行调度，并在 MCP 生命周期管理之上设计 Progressive Tool Disclosure，按任务动态暴露相关 Tool Schema，解决长会话上下文膨胀、Tool 串行执行效率低及大规模 MCP Tool 带来的 Schema 开销问题。
Agent 可观测与评测： 构建 Session → Run → Step → Tool Call 多级 Trace，记录 Token、Tool Call、Latency、Cost 与 Stop Reason 等执行指标，并实现 Agent Evaluation 与 Fault Injection，对 Context Compaction、Tool Routing、长任务控制及故障恢复进行 Baseline 对照实验；解决 Harness 优化效果依赖主观判断、不同执行策略缺少统一量化依据的问题。