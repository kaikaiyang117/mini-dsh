import { ContextCompactionPlanner } from './context-compaction-planner.js'
import { DeterministicContextCompactor } from './context-compactor.js'
import { measureContextPressure, normalizeContextPolicy } from './context-policy.js'
import { findLatestValidCompaction, projectSessionEvents } from './context-projector.js'
import { TokenMeter } from './token-meter.js'

/**
 * Projects the durable Session Event Log into model-visible context. project()
 * is pure; prepare() is the explicit persistence boundary for compaction.
 */
export class ContextManager {
    constructor({ sessions, tokenMeter = new TokenMeter(), policy = {}, compactor, planner } = {}) {
        if (!sessions || typeof sessions.get !== 'function') {
            throw new TypeError('ContextManager requires sessions.get()')
        }
        if (!tokenMeter || typeof tokenMeter.estimateRequest !== 'function') {
            throw new TypeError('ContextManager requires tokenMeter.estimateRequest()')
        }
        this.sessions = sessions
        this.tokenMeter = tokenMeter
        this.policy = normalizeContextPolicy(policy)
        this.compactor = compactor ?? new DeterministicContextCompactor()
        this.planner =
            planner ??
            new ContextCompactionPlanner({
                tokenMeter: this.tokenMeter,
                compactor: this.compactor,
            })
    }

    project(sessionId, context = {}) {
        const events = this.sessions.get(sessionId).events
        const messages = projectSessionEvents(events)
        const compaction = findLatestValidCompaction(events)
        const tokenEstimate = this.tokenMeter.estimateRequest({
            model: context.model,
            system: context.system,
            messages,
            tools: context.tools,
        })
        return {
            messages,
            metadata: {
                sourceEventCount: events.length,
                projectedMessageCount: messages.length,
                tokenEstimate,
                pressure: measureContextPressure(tokenEstimate.tokens, this.policy),
                compacted: compaction !== null,
                compaction: compactionMetadata(compaction),
            },
        }
    }

    async prepare(sessionId, context = {}) {
        const projection = this.project(sessionId, context)
        const state = projection.metadata.pressure.state
        if (state !== 'soft_limit' && state !== 'hard_limit') return projection

        const events = this.sessions.get(sessionId).events
        const plan = this.planner.plan({ events, projection, context })
        if (!plan) return projection

        await this.sessions.append(sessionId, 'context/compaction', plan.data)
        return this.project(sessionId, context)
    }
}

function compactionMetadata(event) {
    if (!event) return null
    const data = event.data
    return {
        eventSeq: event.seq,
        shadowedFromSeq: data.shadowedFromSeq,
        shadowedThroughSeq: data.shadowedThroughSeq,
        strategy: data.strategy,
        beforeTokens: data.beforeTokens,
        afterTokens: data.afterTokens,
    }
}
