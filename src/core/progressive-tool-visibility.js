export class ProgressiveToolVisibility {
    constructor({ baseVisibility, activationStore, searchToolName = 'tool_search' } = {}) {
        if (!baseVisibility || typeof baseVisibility.select !== 'function') {
            throw new TypeError('ProgressiveToolVisibility requires baseVisibility.select()')
        }
        if (!activationStore || typeof activationStore.names !== 'function') {
            throw new TypeError('ProgressiveToolVisibility requires activationStore.names()')
        }
        this.baseVisibility = baseVisibility
        this.activationStore = activationStore
        this.searchToolName = searchToolName
    }

    async select(request) {
        const currentNames = new Set(request.catalog.map((tool) => tool.name))
        const selected = await this.baseVisibility.select(request)
        const visible = new Set(selected.filter((name) => currentNames.has(name)))

        if (currentNames.has(this.searchToolName)) visible.add(this.searchToolName)
        for (const name of this.activationStore.names(request.runId)) {
            if (currentNames.has(name)) visible.add(name)
        }
        return [...visible]
    }

    beginRun({ runId }) {
        this.activationStore.clear(runId)
    }

    endRun({ runId }) {
        this.activationStore.clear(runId)
    }
}
