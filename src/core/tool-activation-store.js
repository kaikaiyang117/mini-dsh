export const DEFAULT_MAX_ACTIVATED_TOOLS = 24

export class ToolActivationStore {
    #activations = new Map()

    constructor({ maxActivatedTools = DEFAULT_MAX_ACTIVATED_TOOLS } = {}) {
        if (!Number.isInteger(maxActivatedTools) || maxActivatedTools <= 0) {
            throw new TypeError('maxActivatedTools must be a positive integer')
        }
        this.maxActivatedTools = maxActivatedTools
        Object.freeze(this)
    }

    activate(runId, names) {
        if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required')
        if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
            throw new TypeError('activation names must be an array of Tool names')
        }

        const activatedNames = this.#activations.get(runId) ?? new Set()
        const activated = []
        const alreadyActivated = []
        const limitReached = []
        for (const name of new Set(names)) {
            if (activatedNames.has(name)) {
                alreadyActivated.push(name)
            } else if (activatedNames.size >= this.maxActivatedTools) {
                limitReached.push(name)
            } else {
                activatedNames.add(name)
                activated.push(name)
            }
        }
        if (activatedNames.size > 0) this.#activations.set(runId, activatedNames)

        return { activated, alreadyActivated, limitReached }
    }

    names(runId) {
        return [...(this.#activations.get(runId) ?? [])]
    }

    clear(runId) {
        this.#activations.delete(runId)
    }
}
