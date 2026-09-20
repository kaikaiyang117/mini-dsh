export function createRunDeadline(maxDurationMs) {
    if (maxDurationMs === null) {
        return { signal: null, dispose() {} }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
        controller.abort({ stopReason: 'time_limit' })
    }, maxDurationMs)
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer)
        },
    }
}

export function combineAbortSignals(externalSignal, deadlineSignal) {
    if (!externalSignal) return deadlineSignal
    if (!deadlineSignal) return externalSignal
    return AbortSignal.any([externalSignal, deadlineSignal])
}
