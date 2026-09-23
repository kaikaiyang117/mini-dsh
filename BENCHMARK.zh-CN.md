# 真实模型 Benchmark 基础设施（B0）

[English](./BENCHMARK.md) | 中文

B0 只包含一个 `bugfix-single-file` Coding Smoke Case，用于验证真实 Provider、隔离重复执行、成本保护和报告流程。它**不是正式 Coding Benchmark V1**，不支持据此声称真实模型成功率或比较模型能力。

## 架构

```text
CLI / BenchmarkConfig
  → BenchmarkRunner（case → variant → repetition，串行）
  → 现有 EvalRunner（每个样本执行一个 case × variant）
  → 独立 Fixture / 生产 AgentLoopRuntime / LlmRuntime
  → 真实 Provider Adapter
  → 现有 Scorer 接口 / EvalResult
  → Benchmark 样本记录 / 聚合 / JSON 报告
```

BenchmarkRunner 仅编排矩阵和实验级预算。它复用 EvalCase、EvalRunner、Trace、RecordingTokenMeter、ToolRuntime 与 AgentLoop，没有复制 Agent Runner 或 Tool 协议。Synthetic Eval 报告不增加时间戳；Benchmark 报告有 `startedAt` / `finishedAt`，两者都保留自己的复现语义。

`minimal` 使用全部可用工具 Schema，不启用 context window 或进展检测；`full` 使用词法工具选择、ContextManager 压力 / 压缩以及可选的确定性进展检测。这两个配置用于验证编排能切换 Harness 变体，B0 不做单因素消融或性能结论。

## 使用

先检查计划，不需要 API Key，也不会调用模型：

```bash
pnpm benchmark:coding -- --dry-run --model deepseek/deepseek-v4-pro --repeat 3
```

真实运行需要 `DEEPSEEK_API_KEY`，通过现有 DeepSeek Plugin 注册到 `ctx.llm`，Agent 再由 LlmRuntime 选择 `provider/model`。默认模型优先读取 `MINI_DSH_MODEL`，否则使用 Runtime 的默认 `deepseek/deepseek-v4-pro`。

```bash
pnpm benchmark:coding -- --model deepseek/deepseek-v4-pro --repeat 3 \
  --variants minimal,full --case bugfix-single-file \
  --output .benchmark/coding.json
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--model provider/model` | 选择已注册模型 |
| `--variant NAME`（可重复）、`--variants A,B` | 过滤变体；默认 `minimal,full` |
| `--case NAME`（可重复）、`--cases A,B` | 过滤 Case；默认全部 |
| `--repeat N` | 每个 Case × Variant 重复 N 次；默认 1 |
| `--output PATH` | JSON 报告位置；默认 `.benchmark/coding.json` |
| `--max-total-cost NUMBER` | 实验总成本的下一样本接纳门槛 |
| `--allow-unknown-cost` | 显式允许费用未知时继续运行；此时总成本上限无法完整执行 |
| `--dry-run` | 只列出计划，不创建工作区、不调用模型 |

控制台输出每个变体的成功数、样本数、平均步数 / Tool Calls、输入 Token、估算输入、费用和耗时，并给出机器可读报告路径。`.benchmark/` 被 Git 忽略；它与 deterministic synthetic Eval 的 `.eval/` 分开。

## 样本与重复

执行顺序固定为 **case → variant → repetition**，不并发。每个 repetition 都创建新的临时 workspace、Session、Agent 和 Trace。`runId` 是独立的 Benchmark 样本 ID；`agentRunId` 是对应 Harness Trace ID，不替代样本 ID。

Fixture 只写入 `calculator.js` 和 `calculator.test.js`。模型需要搜索、读取、在修改前运行失败测试、修改目标文件、再运行通过的测试。Scorer 检查测试前后结果、目标文件 diff、额外文件、读取 / 搜索和 Tool Call / Result 配对。Bash 只允许执行 `env -u NODE_TEST_CONTEXT node --test calculator.test.js`，编辑只允许目标文件；case 不安装依赖、不访问网络，测试只用 Node 内置模块。

Benchmark 自动批准仅限自己创建的临时工作区中的工具操作，结束后删除该工作区。这是应用层策略，**不是 OS sandbox**；不要将这个模式直接用于不受信任的代码或其他工作区。

## 报告与成本语义

顶层 JSON 包含 `schemaVersion: 1`、`benchmark` 名称 / 版本、`invocation` 模型与矩阵、`environment` 中的 Git commit / Node / 平台 / 架构、时间、`results[]` 原始样本与 `summary`。非 Git 目录时 commit 可为 `null`。

每条样本记录 `runId`、`agentRunId`、case / variant / repetition、provider / model、success / stopReason、steps / toolCalls / toolErrors、请求数、Provider input / output / reasoning tokens 与 cost、Harness 估算输入 / Schema tokens / 可见工具数、Run duration、受限的评分证据和错误。`toolErrors` 来源于 Session 的 `tool/result.isError`，耗时是整个 Agent Run。报告不复制完整 Prompt、Event Log 或 `reasoningContent`；执行历史仍按当前 Session 语义保存。

`summary.variants` 按变体聚合样本数、成功数 / 成功率、平均步数 / Tool Calls / Tool Errors / 请求数、Provider tokens、Harness 估算、每请求可见工具数、耗时及已知费用。顶层另有 `plannedRuns`、`startedRuns`、`completedRuns`、`skippedRuns`、`budgetStopped`、`budgetStopReason`。原始样本可用于重新聚合。

DeepSeek Adapter 当前提供 token usage，但 `cost` 为 `null`。若配置 `MINI_DSH_PRICING_JSON`，现有 CostEstimator 可按已知 input / output usage 计算费用，例如：

```dotenv
MINI_DSH_PRICING_JSON={"deepseek/deepseek-v4-pro":{"inputPer1k":0.001,"outputPer1k":0.002}}
```

该数字**只是配置格式示例，不代表当前价格**；运行前自行填写适用价格。`cost=null` 表示未知，不能当成 0。`costAvailability` 为 `available`、`partial` 或 `unavailable`，`totalKnownCost` 仅累加已知样本。设置 `--max-total-cost` 时，DeepSeek 没有定价配置会在启动前失败；若运行后仍出现未知费用，Benchmark 停止接纳后续样本并以非零状态退出。只有显式 `--allow-unknown-cost` 才继续。

总预算在**下一个样本开始前**检查 `totalKnownCost >= maxTotalCost`。它不强杀当前 Agent Run，单个样本可能使最终已知费用超过门槛；RunController 的单次 Run 限制与此独立。

普通 `pnpm test` 使用 fake adapter，不发送真实 API 请求；`pnpm benchmark:coding` 不纳入普通 CI。现有 `eval:*` 仍是 Mock LLM 驱动的 deterministic synthetic evaluation，不能与这里的真实模型样本混写或直接比较成功率。
