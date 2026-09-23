# mini-dsh Design Decisions

English | [中文](./DESIGN_DECISIONS.zh-CN.md)

This document explains the choices. See [Architecture](../ARCHITECTURE.md) for components and execution flow, and [README](../README.md#evaluation) for measurements.

## 1. The Event Log Is the Source of Truth

- **Problem**: Final answers or in-memory messages cannot distinguish intent, execution results, and unknown outcomes after interruption.
- **Decision**: Record facts in an append-only Session Event Log. Every committed Tool Call must eventually have exactly one matching result.
- **Why**: One history supports auditing, projection, and recovery, including explicit failure and cancellation records.
- **Trade-off**: History grows and writes have a cost. Result pairing does not imply exactly-once external effects, and JSONL does not provide multi-process transactions.

## 2. Separate Durable History from Model Context

- **Problem**: Long tasks need complete facts, but model context is limited. Deleting history would undermine recovery.
- **Decision**: Models read an event projection. Compaction appends a summary, covered range, and lineage while retaining original events.
- **Why**: Requests can shrink without losing the ability to reconstruct and inspect their source. Compaction must respect complete Tool protocol boundaries.
- **Trade-off**: Deterministic summaries are lossy, and projection / lineage validation adds complexity. Smaller context does not mean smaller on-disk history.

## 3. Make Tool Errors Data Where Possible

- **Problem**: Exceptions escaping the Loop can leave committed calls without results and deny the model a chance to adjust.
- **Decision**: Normalize unknown tools, invalid arguments, timeout, cancellation, and execution errors into Tool Results.
- **Why**: Success and failure use the same recording path, allowing policies and subsequent model requests to interpret failures.
- **Trade-off**: Not every infrastructure fault can become an ordinary return value. Registration and internal orchestration errors may still throw; cooperative timeout is not forced termination.

## 4. Parallelize Only Explicitly concurrencySafe Tools

- **Problem**: Parallel execution can reduce waiting, but tools may share mutable state or have order-sensitive side effects.
- **Decision**: Require `concurrencySafe=true` for concurrency; use other tools as barriers and commit results in original call order.
- **Why**: Conservative defaults permit independent work while keeping the model protocol and historical ordering stable.
- **Trade-off**: Some parallelism is missed, and committing results can wait for slower tools. Tool authors remain responsible for truthful declarations.

## 5. Tool Visibility Is Not Authorization

- **Problem**: Sending every schema adds overhead, but hiding schemas can be mistaken for revoking permission.
- **Decision**: Visibility selects descriptions for a request; tools and policies handle authorization. Progressive search activates tools for the current Run.
- **Why**: Schema optimization can be measured independently without presenting prompt selection as access control, while the model can still discover registered tools.
- **Trade-off**: Hidden tools can still be invoked by name. Lexical routing can miss matches, and extra search steps may increase whole-run input.

## 6. No Blind Retry for Uncertain Side Effects

- **Problem**: An external effect may occur before a crash prevents its result from being recorded. The local log cannot establish whether execution succeeded.
- **Decision**: On reopening, append `outcome=unknown` and `retryable=false`; do not automatically replay open calls.
- **Why**: Expose uncertainty instead of risking duplicate payments or writes for the appearance of automatic recovery.
- **Trade-off**: Callers may need to reconcile external state. mini-dsh chooses no blind retry rather than claiming distributed exactly-once.

## 7. Separate MCP Lifecycle from Remote Health

- **Problem**: A successfully created local plugin does not establish current remote availability. Combining them into one state misleads recovery decisions.
- **Decision**: McpManager owns local Fiber connect / disconnect / reload / cleanup. The official client owns protocol, transport, discovery, synchronization, and reconnect.
- **Why**: Responsibilities can be verified independently without duplicating the official client; one server's lifecycle failure need not bring down other servers.
- **Trade-off**: `ACTIVE` only establishes plugin activation. Individual call failures appear in tool results; this project provides no remote-health conclusion.

## 8. Evaluation Needs Explicit Measurement Boundaries

- **Problem**: Fewer schemas or a completed script cannot establish a stronger model, lower actual bills, or production reliability.
- **Decision**: Use explicit variants, fixtures, scorers, and versioned reports; separate estimates from provider usage and identify synthetic / Mock LLM conditions.
- **Why**: This permits reproducible comparison of execution paths, resource usage, protocol consistency, and recovery semantics.
- **Trade-off**: Conclusions stay within fixture scope. Progressive adds search costs, and Managed combines mechanisms, preventing single-factor attribution.

## 9. Scorers Must Resist False Positives

- **Problem**: “Tests passed at the end” can hide an unrepaired problem, unrelated file changes, or a fault that never actually occurred.
- **Decision**: Tie success to evidence: initially failing / finally passing tests, required reads / edits, workspace diffs, fault activation, durable events, protocol closure, and post-recovery side effects. Test scorers by breaking that evidence.
- **Why**: Expected execution paths distinguish exercised designs from coincidentally similar outcomes.
- **Trade-off**: Scorers become more closely coupled to case contracts and cost more to maintain. They cannot prove behavior outside their coverage.

## 10. Sandbox Policy Is Not OS Isolation

- **Problem**: Path checks and command denylists reduce mistakes but cannot constrain all behavior of interpreters, plugins, or remote tools.
- **Decision**: Describe the current system as application-level policy and human approval. Distinguish built-in tool checks, Eval fixture constraints, and actual OS isolation.
- **Why**: Users can judge their execution environment without treating a policy allow decision as proof of safety.
- **Trade-off**: Hostile-code isolation is not provided. Deployments needing it must supply an appropriate environment; additional denylist patterns cannot establish that guarantee.
