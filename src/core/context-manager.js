import { measureContextPressure, normalizeContextPolicy } from './context-policy.js'
import { projectSessionEvents } from './context-projector.js'
import { TokenMeter } from './token-meter.js'

/**
 * Projects the durable Session Event Log into model-visible context.
 * Phase 6.1 intentionally performs no compaction and never mutates events.
 */
export class ContextManager {
    constructor({ sessions, tokenMeter = new TokenMeter(), policy = {} } = {}) {
        if (!sessions || typeof sessions.get !== 'function') {
            throw new TypeError('ContextManager requires sessions.get()')
        }
        if (!tokenMeter || typeof tokenMeter.estimateRequest !== 'function') {
            throw new TypeError('ContextManager requires tokenMeter.estimateRequest()')
        }
        this.sessions = sessions
        this.tokenMeter = tokenMeter
        this.policy = normalizeContextPolicy(policy)
    }

    project(sessionId, context = {}) {
        const events = this.sessions.get(sessionId).events
        const messages = projectSessionEvents(events)
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
                compacted: false,
            },
        }
    }
}
