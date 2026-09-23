# mini-dsh 设计决策

[English](./DESIGN_DECISIONS.md) | 中文

本文解释“为什么这样设计”。当前组件和执行流程见 [Architecture](../ARCHITECTURE.zh-CN.md)，测评数据见 [README](../README.zh-CN.md#evaluation)。

## 1. Event Log 是 Source of Truth

- **Problem**：仅保存最终回答或内存消息，无法在中断后区分调用意图、执行结果和未知状态。
- **Decision**：以追加式 Session Event Log 记录事实；已提交的每个 Tool Call 最终恰好配对一个结果。
- **Why**：同一份历史支持审计、投影和恢复；失败与取消也留下可解释的记录。
- **Trade-off**：历史持续增长，写入有成本；结果配对不代表外部副作用 exactly-once。JSONL 也不提供多进程事务。

## 2. Durable History 与 Model Context 分离

- **Problem**：长任务需要完整事实，但模型上下文有限；直接删历史会损害恢复依据。
- **Decision**：模型只读取事件投影。压缩追加 summary、覆盖区间和 lineage，保留所有原始事件。
- **Why**：可以减少请求体，同时重建和检查压缩来源；压缩必须在完整 Tool 协议边界进行。
- **Trade-off**：确定性摘要有损，投影和 lineage 校验增加复杂度；Context 变小不意味着磁盘历史变小。

## 3. Tool Error 尽量成为数据

- **Problem**：工具异常若直接穿透 Loop，已提交调用可能没有结果，模型也无法调整下一步。
- **Decision**：把 unknown tool、invalid arguments、timeout、cancelled、execution error 规范化为 Tool Result。
- **Why**：正常结果和失败结果走相同记录路径，预算策略和后续模型请求可以解释失败。
- **Trade-off**：不能把所有基础设施故障都包装成成功返回；注册和内部编排错误仍可抛出。协作式 timeout 也不等于强制终止。

## 4. 并行只对 concurrencySafe Tool 开放

- **Problem**：并行可以缩短等待，但任意工具可能共享可变状态或产生顺序敏感的副作用。
- **Decision**：显式 `concurrencySafe=true` 才允许并行，其余工具作为 barrier；结果按调用原序提交。
- **Why**：采用保守默认值，在提高独立工具吞吐的同时保持模型协议与历史顺序稳定。
- **Trade-off**：可能错失并行机会，也会等待较慢工具后再提交结果；声明是否真实仍由工具作者负责。

## 5. Tool Visibility 不等于 Authorization

- **Problem**：把所有 Schema 放进请求会增加开销，但隐藏 Schema 很容易被误认为撤销权限。
- **Decision**：Visibility 只控制本次请求的工具描述；授权由工具与 policy 负责。Progressive 通过搜索激活当前 Run 的工具。
- **Why**：Schema 优化可独立测量，不把提示词选择伪装成访问控制；模型还能继续发现已注册工具。
- **Trade-off**：隐藏工具仍可能按名称执行；词法路由会漏匹配，搜索增加 Step，整个 Run 的输入未必最低。

## 6. 副作用结果不确定时不盲目重试

- **Problem**：外部副作用可能已发生，但进程在结果写入前崩溃；本地日志无法判定是否执行成功。
- **Decision**：重新打开会话时补 `outcome=unknown`、`retryable=false`，不自动重放未闭合调用。
- **Why**：不以重复付款、重复写入等风险换取看似自动恢复；明确暴露不确定性。
- **Trade-off**：恢复后的调用者可能需要核查外部状态。mini-dsh 选择“不盲目重试”，不声称分布式 exactly-once。

## 7. MCP Lifecycle 与 Remote Health 分层

- **Problem**：本地插件成功创建，不代表远端此刻可用；把两者合为一个状态会误导恢复策略。
- **Decision**：McpManager 管本地 Fiber 的 connect / disconnect / reload / cleanup；官方客户端管协议、transport、发现、同步和重连。
- **Why**：职责可独立验证，避免重复实现官方客户端；一个 server 的生命周期失败不必拖垮其他 server。
- **Trade-off**：`ACTIVE` 只说明插件激活，需要读取工具结果才能观察具体调用失败；本项目没有远端健康检测结论。

## 8. Evaluation 必须明确测量边界

- **Problem**：Schema 缩小或某个脚本完成，不能直接推出真实模型更强、费用更低或生产更可靠。
- **Decision**：使用明确 variant、fixture、scorer 和版本化报告；分开记录估算与 Provider usage，并注明 synthetic / Mock LLM 条件。
- **Why**：在可重复条件下比较 execution path、resource usage、protocol consistency 和 recovery semantics。
- **Trade-off**：结果只支持 fixture 范围内的结论；Progressive 有额外搜索成本，Managed 组合多个机制，不能单因素归因。

## 9. Scorer 也需要防假阳性

- **Problem**：只检查“最终测试通过”可能放过未修复问题、修改无关文件，或根本没有触发预期故障的运行。
- **Decision**：将成功绑定到证据：初始失败与最终通过、必需读取 / 修改、workspace diff、故障触发、持久事件、协议闭合及恢复后的副作用检查；用破坏这些证据的回归验证 scorer。
- **Why**：对照预期执行路径才能区分真正验证了设计与偶然得到相同结果。
- **Trade-off**：Scorer 与案例契约更紧密，维护成本更高，也不能证明没有覆盖到的行为。

## 10. Sandbox Policy 不等于 OS Isolation

- **Problem**：路径检查和命令 denylist 能减少误操作，却无法限制任意解释器、插件或远端工具的全部行为。
- **Decision**：将当前能力描述为应用层策略与人工确认，清楚区分内置工具检查、Eval fixture 约束和真正的 OS 隔离。
- **Why**：使用者能据实判断执行环境，而不会把一次 policy 放行当成安全证明。
- **Trade-off**：不提供恶意代码隔离，需要强隔离的部署必须另行提供相应环境；继续堆叠 denylist 无法补齐这一保证。
