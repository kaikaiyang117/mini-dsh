const INJECTION_POINTS = new Set([
    'llm.before_request',
    'llm.after_request',
    'tool.before_execute',
    'tool.execute',
    'tool.after_execute',
    'scheduler.before_batch',
    'context.before_prepare',
])

export class FaultInjector {
    #rules
    #occurrences
    #matched = null
    #injections = []

    constructor(plan = []) {
        if (!Array.isArray(plan)) throw new TypeError('FaultInjector plan must be an array')
        this.#rules = plan.map((rule) => {
            if (
                !INJECTION_POINTS.has(rule?.point) ||
                !Number.isInteger(rule.occurrence) ||
                rule.occurrence < 1 ||
                typeof rule.action !== 'string' ||
                !rule.action
            ) {
                throw new TypeError(
                    'FaultInjector rules require point, positive occurrence, action',
                )
            }
            return { ...rule }
        })
        this.#occurrences = this.#rules.map(() => 0)
    }

    shouldFail(point, context = {}) {
        this.#matched = null
        for (const [index, rule] of this.#rules.entries()) {
            if (rule.point !== point || (rule.tool && rule.tool !== context.tool)) continue
            this.#occurrences[index] += 1
            if (this.#occurrences[index] === rule.occurrence) {
                this.#matched = { index, rule, context }
            }
        }
        return this.#matched !== null
    }

    record(point, context = {}) {
        if (!this.#matched || this.#matched.rule.point !== point) {
            throw new Error(`no matched fault to record at ${point}`)
        }
        const { index, rule } = this.#matched
        if (rule.tool && rule.tool !== context.tool) {
            throw new Error(`matched fault tool does not match at ${point}`)
        }
        this.#injections.push({
            point,
            tool: rule.tool ?? context.tool ?? null,
            occurrence: this.#occurrences[index],
            action: rule.action,
        })
        this.#matched = null
    }

    get injectedCount() {
        return this.#injections.length
    }

    get matchedAction() {
        return this.#matched?.rule.action ?? null
    }

    get injections() {
        return structuredClone(this.#injections)
    }
}

export { INJECTION_POINTS }
