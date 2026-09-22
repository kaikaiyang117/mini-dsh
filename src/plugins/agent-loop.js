import { Service } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../core/agent-loop-runtime.js'

/**
 * Wraps AgentLoopRuntime as a Cordis Service so other plugins can
 * access it via ctx.agentLoop. inject waits until sessions, systemPrompt,
 * tools, and llm are ready before constructing the loop.
 */
class AgentLoopService extends Service {
    static inject = ['sessions', 'systemPrompt', 'tools', 'llm']

    constructor(ctx, config = {}) {
        super(ctx, 'agentLoop')
        this.runtime = new AgentLoopRuntime({
            sessions: ctx.sessions,
            systemPrompt: ctx.systemPrompt,
            tools: ctx.tools,
            llm: ctx.llm,
            trace: ctx.reflect.get('traceRuntime', false),
            policy: config.policy,
            costEstimator: config.costEstimator,
            maxParallelToolCalls: config.maxParallelToolCalls,
            toolCatalog: config.toolCatalog,
            toolVisibility: config.toolVisibility,
            progressDetectorFactory: config.progressDetectorFactory,
            tokenMeter: config.tokenMeter,
            contextPolicy: config.contextPolicy,
        })
    }

    run(agent, input, options) {
        return this.runtime.run(agent, input, options)
    }
}

export const name = 'mini-agent-loop'
export const inject = ['sessions', 'systemPrompt', 'tools', 'llm']

export function apply(ctx, config = {}) {
    ctx.plugin(
        class ConfiguredAgentLoopService extends AgentLoopService {
            constructor(serviceContext) {
                super(serviceContext, config)
            }
        },
    )
}
