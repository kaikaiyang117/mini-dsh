import {
    findLatestValidCompaction,
    findProtocolSafeBoundaries,
    isModelContextEvent,
    latestResetSeq,
    projectSessionEvents,
} from './context-projector.js'

const HEADROOM_RATIO = 0.75

export class ContextCompactionPlanner {
    constructor({ tokenMeter, compactor } = {}) {
        if (!tokenMeter || typeof tokenMeter.estimateRequest !== 'function') {
            throw new TypeError('ContextCompactionPlanner requires tokenMeter.estimateRequest()')
        }
        if (!compactor || typeof compactor.compact !== 'function') {
            throw new TypeError('ContextCompactionPlanner requires compactor.compact()')
        }
        this.tokenMeter = tokenMeter
        this.compactor = compactor
    }

    plan({ events, projection, context = {} }) {
        const pressure = projection.metadata.pressure
        if (pressure.state !== 'soft_limit' && pressure.state !== 'hard_limit') return null

        const resetSeq = latestResetSeq(events)
        const previous = findLatestValidCompaction(events, resetSeq)
        const previousThroughSeq = previous?.data.shadowedThroughSeq ?? resetSeq
        const latestRaw = events.findLast(
            (event) => event.seq > previousThroughSeq && isModelContextEvent(event),
        )
        if (!latestRaw) return null

        const boundaries = findProtocolSafeBoundaries(events, {
            afterSeq: previousThroughSeq,
            beforeSeq: latestRaw.seq,
            resetSeq,
        })
        if (boundaries.length === 0) return null

        const targetTokens = Math.floor(pressure.softLimitTokens * HEADROOM_RATIO)
        let best = null
        for (const shadowedThroughSeq of boundaries) {
            const compactedEvents = events.filter(
                (event) => event.seq > previousThroughSeq && event.seq <= shadowedThroughSeq,
            )
            const compacted = this.compactor.compact({
                events: compactedEvents,
                previousSummary: previous?.data.summary ?? null,
                context,
                targetTokens,
            })
            const firstShadowed = events.find(
                (event) =>
                    event.seq > resetSeq &&
                    event.seq <= shadowedThroughSeq &&
                    isModelContextEvent(event),
            )
            const data = {
                shadowedFromSeq: previous?.data.shadowedFromSeq ?? firstShadowed.seq,
                shadowedThroughSeq,
                summary: compacted.summary,
                strategy: compacted.strategy,
                model: compacted.model,
                previousCompactionSeq: previous?.seq ?? null,
                runId: context.runId ?? null,
                stepId: context.stepId ?? null,
                beforeTokens: projection.metadata.tokenEstimate.tokens,
                afterTokens: null,
            }
            const virtualEvent = {
                seq: (events.at(-1)?.seq ?? 0) + 1,
                type: 'context/compaction',
                data,
            }
            const messages = projectSessionEvents([...events, virtualEvent])
            const tokenEstimate = this.tokenMeter.estimateRequest({
                model: context.model,
                system: context.system,
                messages,
                tools: context.tools,
            })
            data.afterTokens = tokenEstimate.tokens
            const candidate = { data, tokenEstimate }

            if (!best || tokenEstimate.tokens < best.tokenEstimate.tokens) best = candidate
            if (tokenEstimate.tokens <= targetTokens) return candidate
        }

        return best?.tokenEstimate.tokens < projection.metadata.tokenEstimate.tokens ? best : null
    }
}
