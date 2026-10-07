# 03 · 风险问题、边界与现场应对

> 面试官判断一个人是否真做过项目，最有效的方式就是打边界。**你主动说出边界，边界就变成加分项；被问出来，就变成减分项。** 本文件把这些点整理成"诚实说法 + 代码依据 + 改进方向"。

---

## 一、必须主动交代的边界（按重要度排序）

### 1. "append-only" 不完全是字面意思
- **诚实说法**：正常路径只追加；但恢复 torn tail 时会对损坏的最后一行做物理截断（`truncate`）。所以准确说法是"正常追加 + 尾部撕裂可截断修复"，不是"任何情况下都永不改写"。
- **代码依据**：`session-recovery.js:44-51`；`ARCHITECTURE.md:172` 也有承认。
- **改进**：改成"追加 + 尾部校验重写"或 WAL 双文件，避免截断。

### 2. "Durable" 只到进程崩溃级
- **诚实说法**：每个事件是 `writeFile(...,{flag:'a'})`，只在 `flush/close/dispose` 时 `sync()`；不每事件 fsync，也无线程/进程锁。所以：不做掉电持久化承诺、不做多进程一致性承诺。
- **代码依据**：`jsonl-session-store.js:76-77,157-163`；崩溃测试用 SIGKILL 而非断电。
- **改进**：关键事件 fsync、单写者/文件锁、必要时 WAL。

### 3. unknown cost 是 fail-open（RunController 与 Benchmark 策略不同）
- **诚实说法**：RunController 里一旦某次 usage 缺 cost，`#costKnown` 永久 false，后续已知 cost 也不再累计，`snapshot().cost=null`，`maxCost` 完全不触发。这是 fail-open：宁可成本上限不可用，也不伪造 0 或部分值。Benchmark 层则是另一种策略——缺 pricing 会在启动前失败，运行中发现 unknown 会停止后续 admission（fail-closed）。
- **代码依据**：`run-controller.js:89-93,193-203`；`benchmark-runner.js:89-93`。
- **改进**：RunController 可加"unknown cost 时显式停 Run"或至少告警，而不是静默失效。

### 4. 调度器异常存在竞态窗口
- **诚实说法**：`Promise.all` eager reject 后，后台仍在跑的工具不会被自动 abort，Loop 可能在它们 settle 之前就把结果标成 `unknown`。大方向（保 settled、补 unknown、补 synthetic）是对的，但"preserves settled results"存在时间窗口。
- **代码依据**：`agent-loop-runtime.js:293-333`；`test/parallel-tool-scheduler.test.js:480-548`。
- **改进**：显式 abort 在跑的工具并等待 settle 宽限期，再决定标 unknown。

### 5. `toolCallId` 唯一性是隐含假设
- **诚实说法**：恢复按 `toolCallId` 全局匹配，但代码**不强制**校验同一 session 内 id 唯一；重复 id 会误配。正常 provider 不会产生重复 id，但这是接口级风险。
- **代码依据**：`session-runtime.js:133-148`；`agent-loop-runtime.js:294-304`。
- **改进**：append 时断言 id 唯一，重复直接报协议错误。

### 6. reminder 的"one-shot"是 per streak
- **诚实说法**：不是整个 Run 只提醒一次；progress/neutral 会重置 `reminderIssuedForStreak`，之后可能再次提醒。准确说法是"每个 no-progress streak 一次"。
- **代码依据**：`semantic-progress-detector.js:79-94`。

### 7. `/sessions` 列表不会做 torn tail 恢复
- **诚实说法**：`list()` 走普通 `readJsonl`（无恢复），`/resume` 才能恢复。所以崩溃后可能出现"resume 可用、list 先抛错"的观感。
- **代码依据**：`jsonl-session-store.js:94-112`；`session-recovery.js:22-25`。
- **改进**：list 对尾部损坏做降级读取，或统一走恢复读取。

### 8. `budgetStop` 字段语义比名字宽
- **诚实说法**：`budgetStop: stopReason !== 'cancelled'`，所以 `internal_error` 导致的未执行 call 也会被标 true。消费方不应把它当"一切由预算导致"的可靠标记。
- **代码依据**：`agent-loop-runtime.js:444-460`。

### 9. Progressive "无匹配只留 pinned" 有条件
- **诚实说法**：只在小 catalog 之外的场景成立；`catalog.length <= maxVisibleTools` 时直接全量，不走 fallback。
- **代码依据**：`deterministic-tool-visibility.js:25`；`test/deterministic-tool-visibility.test.js:18-27`。

### 10. pinned / alwaysVisible 机制存在，但生产 wiring 从未配置
- **诚实说法**：默认空数组，`tool-visibility-config.js` 和 `src/index.js` 都没传；只有测试里手工构造非空 pinned。
- **代码依据**：`deterministic-tool-visibility.js:10`；`tool-visibility-config.js:27-47`。

### 11. 人工审批存在未文档化的旁路
- **诚实说法**：`MINI_DSH_AUTO_APPROVE=1` / `config.autoApprove` 会让 `approve()` 直接通过，但 README 和 `.env.example` 没列这个变量。审批是权限边界，但可被配置旁路。
- **代码依据**：`sandbox-runtime.js:118-120`；`plugins/sandbox.js:16`。

### 12. 网络 allowlist 实际硬编码
- **诚实说法**：`SandboxRuntime` 构造支持 `allowHosts`，但插件只传 workspace 与 autoApprove，因此生产用的是硬编码 `DEFAULT_ALLOW_HOSTS`，不能从配置扩展。
- **代码依据**：`sandbox-runtime.js:80-84`；`plugins/sandbox.js:13-17`。

### 13. TokenMeter 的"保守"未经真实 tokenizer 验证
- **诚实说法**：固定 3 bytes/token 对中文/emoji/代码不可能一致保守；它是 deterministic guard，不是 accuracy guarantee。
- **代码依据**：`token-meter.js:1-22`；`test/token-meter.test.js:66`。

### 14. Sandbox 命令策略可被绕过
- **诚实说法**：`python3 -c` / `node -e` 的引号参数、`base64 | sh`、`/usr/bin/curl` 等路径可绕过启发式。它只能提高事故成本，不是安全边界。
- **代码依据**：`sandbox-runtime.js:360-374,342-343,207-243,264-266`（context-tools 报告 7.5 有实验记录）。

### 15. MCP 脱敏只覆盖 snapshot，不覆盖抛出的 Error
- **诚实说法**：`snapshot.lastError` 会 redact，但 connect/disconnect/reload 会 rethrow 原始 error；程序化调用者可能拿到未脱敏信息。CLI 优先打印脱敏 message。
- **代码依据**：`mcp-manager.js:259-271` vs `173,192,126`。

### 16. latent bug：JsonlSessionStore.append 自等待死锁
- **诚实说法**：store 未 create/open 时直接 append，会 `append → #loadRecord → open → #waitForWrites` 等自己的队列尾，形成自等待。生产路径（SessionRuntime 先 open）不触发，但这是接口级隐患。
- **代码依据**：`jsonl-session-store.js:66-82,138-155`；runtime 报告 7.5 有独立验证脚本结论。
- **改进**：append 前检测未 open 就直接报错，或让 open 幂等不排队。

> 建议：挑其中 3-5 条你最有把握的，"主动交代"。全部倒出来会显得没重点。

---

## 二、已知缺陷与"被追问时的标准回答"

**Q：这些缺陷你会怎么修？优先级是什么？**
建议回答顺序（按"影响 × 修复成本"）：
1. **P0 安全相关**：ToolRuntime 加执行前授权检查（可见性≠授权）、Sandbox 配合 OS 隔离、审批旁路文档化；
2. **P0 正确性**：`toolCallId` 唯一性断言、调度器异常时显式 abort + 宽限 settle；
3. **P1 可观测/一致性**：unknown cost 显式告警或停 Run、list 降级读取、budgetStop 语义修正；
4. **P2 性能/能力**：真实 tokenizer、O(n) 投影优化、词法→混合检索、Lazy MCP。

**Q：既然有这么多缺陷，这个项目还有价值吗？**
"有。这些缺陷不是'写错了'，而是**在给定约束下的显式取舍**：单进程本地恢复、不做分布式 exactly-once、应用层策略而非 OS 隔离。我在文档里主动写明了边界，并用测试锁定了已实现的行为。如果把边界说成能力，才是真问题。"
---

## 三、如何应对"这个项目是不是 AI 生成的？"

**心法**：不辩解、不否认用了 AI、直接进入"可验证的掌控力"。

**三步脚本**：
1. **承认工具、强调决策**："AI 是我用的加速器，但架构不变量、故障路径、评测设计是我自己推敲和取舍的。"
2. **给可验证证据**："`git log` 有 11 个 Phase 的独立 commit，每个 PR 都有测试；文档里的边界也是我主动写的。"
3. **邀请现场验证**："您可以随便挑一个文件，我从设计动机讲到关键行。"

**必须能现场讲清的 3 个片段（背熟）**：
- `agent-loop-runtime.js:206-212`：为什么先 append `assistant/tool_calls` 再执行；
- `agent-loop-runtime.js:293-333`：调度器异常时如何补 unknown / synthetic；
- `tool-scheduler.js:16-38`：为什么连续 concurrencySafe 才成组、其余是 barrier。

**如果被问"某个函数为什么这么写"**：先说"它要保证的不变量是 X"，再说"所以在这里必须 Y"，最后"代价是 Z"。不要背实现细节却讲不出动机。

---

## 四、10 分钟代码导览路线（面试前反复练）

按这个顺序打开文件，每个点 60-90 秒，形成"从主循环到可靠性"的叙事：

| # | 文件 : 行 | 打开后讲什么 |
|---|---|---|
| 1 | `src/core/agent-loop-runtime.js` : 62-100 | Run 的入口：排队、建 RunController/deadline/trace、append user/message |
| 2 | 同文件 : 127-212 | Step 准备：ToolCatalog 快照 → 可见 schema → ContextManager.prepare → LLM → **先落 tool_calls** |
| 3 | 同文件 : 293-371 | 异常与提交：调度器失败如何补 unknown/synthetic；结果如何按原始顺序落日志 |
| 4 | 同文件 : 444-477 | synthetic `not_executed` 与 `unknown` 的字段语义 |
| 5 | `src/core/tool-scheduler.js` : 16-82 | partition：连续并行组 + 独占 barrier；worker cursor；按 index 回填 |
| 6 | `src/core/tool-runtime.js` : 12-18, 100-186, 270-293 | 5 类 errorCode；Ajv 校验；AbortSignal 协作超时 |
| 7 | `src/core/context-projector.js` : 78-104, 117-161 | 协议安全边界（openToolCalls）；压缩 lineage 校验 |
| 8 | `src/core/session-recovery.js` : 44-59 | 只截断 torn tail；中间损坏 fail |
| 9 | `src/core/semantic-progress-detector.js` : 68-94, 222-275 | novelty/streak；canonicalize + sha256 fingerprint |
| 10 | `src/core/mcp-manager.js` : 138-148, 189-221 | per-record Promise 尾链；disconnect 失败保留 fiber 可重试 |

**导览收尾金句**："这条路线从'怎么写好 happy path'走到'异常路径和恢复语义'，也是我认为 Agent 工程真正的难点所在。"

---

## 五、绝对不要说的话（红线）

| 不要说 | 正确说法 |
|---|---|
| "我实现了一个安全沙箱" | "应用层 policy gate + 人工审批，不是 OS 隔离" |
| "我从零实现了 MCP 协议" | "我用官方 MCP client，自己实现本地生命周期管理" |
| "真实模型上输入降低了 72%" | "在 Mock LLM 的确定性合成评测中降低了约 72%" |
| "我的系统保证 exactly-once" | "日志层保证 exactly-one result；外部副作用不承诺 exactly-once" |
| "我实现了分布式持久化" | "单进程本地持久化，进程崩溃可恢复；无跨进程协调" |
| "并行工具、压缩是我原创" | "参考成熟 Harness 的通用设计，自主实现简化版本" |
| "这个项目没有明显缺陷" | 主动列出 3-5 个已知边界与改进方向 |
| "压缩用 LLM 总结效果更好，我懒得做" | "为了确定性/可复现/零额外成本，选择了确定性摘要并承认 lossy" |
| "这个数字大概是……" | 只报有出处的数字；没有就不报 |
| "多 Agent 我也做过" | "我没实现多 Agent，但我的架构可以这样演进……" |

---

## 六、面试前 3 天复习计划

### Day 1：讲清楚（输出导向）
- [ ] 用 60 秒 / 3 分钟各讲一遍项目，**录音回听**，砍掉口头禅和不确定词；
- [ ] 画 3 遍架构图（不看文档），确保能默出"一条事实源、两个分离、三个边界"；
- [ ] 通读 `01-overview-and-pitch.md`，把简历 bullet 改到符合自己语气。

### Day 2：讲深入（代码导向）
- [ ] 按第四节路线，对每个文件**不看稿讲动机 + 关键行 + 取舍**；
- [ ] 重点背 3 个片段：先落 tool_calls、补 unknown、partition；
- [ ] 把 `02-interview-qa.md` 里 C/D/E/G/H/J 组的深挖题，每道用"结论→机制→取舍→证据"四句话说一遍；
- [ ] 读 `research/*.md` 的"文档 vs 代码不一致"章节，挑 5 条主动交代。

### Day 3：抗压（边界导向）
- [ ] 练 `03-risks-and-boundaries.md` 的红线与边界清单，做到被追问时不慌；
- [ ] 准备"是不是 AI 写的""没有真实数据""大厂都做了"三连问的回答；
- [ ] 准备 3 个反问；
- [ ] 最后过一遍数字卡片，确认每个数字都能说出出处和限定条件。

### 常备"四句话"答题模板
```
结论：这个机制解决的是 X 问题。
机制：具体做法是 A → B → C。
取舍：代价是 D，所以它适合 E 场景，不适合 F。
证据：我有 G 这个测试/数据/代码位置可以证明。
```
任何深挖题都可以套这四句话，保证不跑题、不空洞。

---

## 附：三份研究底稿索引（深入复习用）

| 文件 | 内容 | 适合什么场景 |
|---|---|---|
| `research/runtime-facts.md` | Agent Loop / RunController / Tool / Scheduler / Session / Recovery / Progress 的代码级事实 + 12 个追问答点 | 被问执行语义、异常路径、恢复 |
| `research/context-tools-facts.md` | Context / TokenMeter / Compaction / Visibility / tool_search / MCP / Sandbox 的代码级事实 + 14 个追问答点 | 被问上下文、工具发现、MCP、安全 |
| `research/eval-facts.md` | 7 个 suite 的真实报告数据、README 数值核实表、Scorer 设计、Benchmark 边界 + 12 个追问答点 | 被问数据、评测方法、真实 benchmark |
