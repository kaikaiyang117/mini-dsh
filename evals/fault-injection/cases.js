const fault = (point, action, { tool, occurrence = 1 } = {}) => ({
    point,
    tool,
    occurrence,
    action,
})

export const FAULT_INJECTION_CASES = Object.freeze([
    {
        name: 'llm-provider-error',
        prompt: 'FAULT::llm-provider-error',
        expected: { completion: 'stop-reason', stopReason: 'internal_error' },
        faults: [fault('llm.before_request', 'throw_provider_500')],
    },
    {
        name: 'llm-pending-cancel',
        prompt: 'FAULT::llm-pending-cancel',
        expected: { completion: 'stop-reason', stopReason: 'cancelled' },
        faults: [fault('llm.before_request', 'wait_for_external_cancel')],
    },
    {
        name: 'tool-error-recovery',
        prompt: 'FAULT::tool-error-recovery',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
        faults: [fault('tool.execute', 'throw_execution_error', { tool: 'unstable_tool' })],
    },
    {
        name: 'tool-error-limit',
        prompt: 'FAULT::tool-error-limit',
        expected: { completion: 'stop-reason', stopReason: 'tool_failure_limit' },
        limits: { maxToolFailures: 2 },
        faults: [
            fault('tool.execute', 'throw_execution_error', { tool: 'unstable_tool' }),
            fault('tool.execute', 'throw_execution_error', {
                tool: 'unstable_tool',
                occurrence: 2,
            }),
        ],
    },
    {
        name: 'tool-timeout',
        prompt: 'FAULT::tool-timeout',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
        faults: [fault('tool.before_execute', 'await_runtime_timeout', { tool: 'slow_tool' })],
    },
    {
        name: 'invalid-tool-args',
        prompt: 'FAULT::invalid-tool-args',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
        faults: [fault('llm.after_request', 'invalid_tool_args')],
    },
    {
        name: 'unknown-tool',
        prompt: 'FAULT::unknown-tool',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
        faults: [fault('llm.after_request', 'unknown_tool')],
    },
    {
        name: 'parallel-cancel',
        prompt: 'FAULT::parallel-cancel',
        expected: { completion: 'stop-reason', stopReason: 'cancelled' },
        faults: [
            fault('tool.before_execute', 'barrier_cancel', { tool: 'slow_read_a' }),
            fault('tool.before_execute', 'barrier_cancel', { tool: 'slow_read_b' }),
        ],
    },
    {
        name: 'context-overflow',
        prompt: 'FAULT::context-overflow',
        expected: { completion: 'stop-reason', stopReason: 'context_overflow' },
        contextPolicy: { maxContextTokens: 256 },
        faults: [fault('context.before_prepare', 'verify_hard_pressure', { occurrence: 2 })],
    },
    {
        name: 'post-commit-dispatch-failure',
        prompt: 'FAULT::post-commit-dispatch-failure',
        expected: { completion: 'stop-reason', stopReason: 'internal_error' },
        faults: [fault('scheduler.before_batch', 'throw_dispatch_error')],
    },
    {
        name: 'side-effect-no-retry',
        prompt: 'FAULT::side-effect-no-retry',
        expected: { completion: 'stop-reason', stopReason: 'internal_error' },
        faults: [fault('llm.before_request', 'throw_provider_500', { occurrence: 2 })],
    },
])
