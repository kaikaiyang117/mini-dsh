import { createHash } from 'node:crypto'

export const PROGRESS_REMINDER =
    '[Harness progress notice]\n\nRecent tool steps have repeated an unsuccessful or unchanged pattern without producing new information. Change strategy instead of repeating the same approach. Try a different source, tool, or query, or conclude if the task cannot progress.'

const VOLATILE_KEYS = new Set([
    'durationms',
    'elapsedms',
    'startedat',
    'endedat',
    'timestamp',
    'ts',
])

export class SemanticProgressDetector {
    #softThreshold
    #hardThreshold
    #seenResults = new Set()
    #seenCallResults = new Set()
    #noProgressStreak = 0
    #reminderPending = false
    #reminderIssuedForStreak = false
    #observationCount = 0

    constructor({ softThreshold = 3, hardThreshold = 6 } = {}) {
        positiveInteger(softThreshold, 'softThreshold')
        if (hardThreshold !== null) {
            positiveInteger(hardThreshold, 'hardThreshold')
            if (hardThreshold <= softThreshold) {
                throw new TypeError('hardThreshold must be greater than softThreshold')
            }
        }
        this.#softThreshold = softThreshold
        this.#hardThreshold = hardThreshold
    }

    observeStep({ records = [] } = {}) {
        const observations = records
            .filter(isProgressEvidence)
            .map((record) => observationFor(record, this.#seenResults, this.#seenCallResults))
            .filter(Boolean)
        this.#observationCount += observations.length

        // Compare a whole parallel Step against prior Steps before adding any
        // of its observations, so siblings cannot count as repeats of each other.
        const hasProgress = observations.some((item) => item.isNovelInformativeResult)
        const hasNoProgressEvidence = observations.some(
            (item) => item.isRepeatedPair || item.isRepeatedLowOutcome,
        )

        for (const item of observations) {
            this.#seenResults.add(item.resultKey)
            this.#seenCallResults.add(item.pairKey)
        }

        let state
        let reason
        if (hasProgress) {
            state = 'progress'
            reason = 'new_informative_result'
            this.#noProgressStreak = 0
            this.#reminderPending = false
            this.#reminderIssuedForStreak = false
        } else if (hasNoProgressEvidence) {
            state = 'no_progress'
            reason = 'repeated_low_information_outcome'
            this.#noProgressStreak += 1
        } else {
            state = 'neutral'
            reason =
                observations.length === 0
                    ? 'no_eligible_observations'
                    : 'first_low_information_outcome'
            this.#noProgressStreak = 0
            this.#reminderPending = false
            this.#reminderIssuedForStreak = false
        }

        let action = 'continue'
        if (
            state === 'no_progress' &&
            this.#hardThreshold !== null &&
            this.#noProgressStreak >= this.#hardThreshold
        ) {
            action = 'stop'
        } else if (
            state === 'no_progress' &&
            this.#noProgressStreak >= this.#softThreshold &&
            !this.#reminderIssuedForStreak
        ) {
            action = 'remind'
            this.#reminderPending = true
            this.#reminderIssuedForStreak = true
        }

        return { state, action, noProgressStreak: this.#noProgressStreak, reason }
    }

    takeReminder() {
        if (!this.#reminderPending) return null
        this.#reminderPending = false
        return PROGRESS_REMINDER
    }

    snapshot() {
        return {
            noProgressStreak: this.#noProgressStreak,
            observationCount: this.#observationCount,
            reminderPending: this.#reminderPending,
        }
    }
}

function observationFor(record, seenResults, seenCallResults) {
    const toolName = record.call?.name
    if (typeof toolName !== 'string') return null
    const args = record.call.arguments
    const result = record.result
    const projected = progressProjection(record)
    const outcomeClass = classifyOutcome(result, projected)
    const resultFingerprint = fingerprint(projected)
    const callFingerprint = fingerprint(canonicalize(args))
    const lowInformation = outcomeClass !== 'success' || isMeaningfullyEmpty(projected)
    const resultKey = fingerprint(`${toolName}\0${outcomeClass}\0${resultFingerprint}`)
    const pairKey = fingerprint(
        `${toolName}\0${callFingerprint}\0${outcomeClass}\0${resultFingerprint}`,
    )
    return {
        toolName,
        callFingerprint,
        outcomeClass,
        resultFingerprint,
        resultKey,
        pairKey,
        isNovelInformativeResult:
            outcomeClass === 'success' &&
            !isMeaningfullyEmpty(projected) &&
            !seenResults.has(resultKey),
        isRepeatedPair: seenCallResults.has(pairKey),
        isRepeatedLowOutcome: lowInformation && seenResults.has(resultKey),
    }
}

function isProgressEvidence(record) {
    if (record?.state !== 'settled' || !record.result) return false
    if (record.result.errorCode === 'cancelled' || record.result.errorCode === 'timeout')
        return false
    return true
}

function classifyOutcome(result, projected) {
    if (result?.isError) return `error:${result.errorCode ?? 'unknown'}`
    const value = result?.value
    if (isProcessLike(value) && value.exitCode !== 0) return `process_exit:${value.exitCode}`
    if (
        isProcessLike(value) &&
        !(typeof value.stdout === 'string' && value.stdout.trim()) &&
        !(typeof value.stderr === 'string' && value.stderr.trim())
    ) {
        return 'empty'
    }
    if (isMeaningfullyEmpty(projected)) return 'empty'
    return 'success'
}

function progressProjection(record) {
    const result = record.result
    const args = record.call?.arguments
    const value = result?.value
    if (isProcessLike(value)) {
        return canonicalize(
            {
                exitCode: value.exitCode,
                stdout: value.stdout,
                stderr: value.stderr,
                ...(value.signal == null ? {} : { signal: value.signal }),
            },
            args,
        )
    }
    if (result?.isError) {
        return canonicalize(
            {
                errorCode: result.errorCode ?? 'unknown',
                value: value ?? result.content,
            },
            args,
        )
    }
    if (
        isMeaningfullyEmpty(value) &&
        typeof record.renderedContent === 'string' &&
        !isMeaningfullyEmpty(record.renderedContent)
    ) {
        return canonicalize(record.renderedContent, args)
    }
    return canonicalize(value, args)
}

function isProcessLike(value) {
    return Boolean(
        value &&
            typeof value === 'object' &&
            Object.hasOwn(value, 'exitCode') &&
            (Object.hasOwn(value, 'stdout') || Object.hasOwn(value, 'stderr')),
    )
}

function isMeaningfullyEmpty(value, seen = new Set()) {
    if (value === null || value === undefined || value === '') return true
    if (typeof value === 'string') return value.trim() === ''
    if (typeof value === 'number' || typeof value === 'boolean') return false
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value))
        return value.length === 0 || value.every((item) => isMeaningfullyEmpty(item, seen))
    const values = Object.values(value)
    return values.length === 0 || values.every((item) => isMeaningfullyEmpty(item, seen))
}

function canonicalize(value, args, seen = new Set()) {
    if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trimEnd()
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'symbol') return String(value)
    if (typeof value === 'function') return '[Function]'
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) {
        const normalized = value.map((item) => canonicalize(item, args, seen))
        seen.delete(value)
        return normalized
    }

    const normalizedArgs = args && typeof args === 'object' ? args : null
    const entries = []
    for (const key of Object.keys(value).sort()) {
        if (VOLATILE_KEYS.has(key.toLowerCase())) continue
        const item = value[key]
        if (
            normalizedArgs &&
            Object.hasOwn(normalizedArgs, key) &&
            equivalent(item, normalizedArgs[key])
        ) {
            continue
        }
        entries.push([key, canonicalize(item, args, seen)])
    }
    seen.delete(value)
    return Object.fromEntries(entries)
}

function equivalent(left, right) {
    try {
        return stableStringify(canonicalize(left)) === stableStringify(canonicalize(right))
    } catch {
        return left === right
    }
}

function fingerprint(value) {
    const serialized = stableStringify(value)
    return createHash('sha256').update(serialized).digest('hex')
}

function stableStringify(value) {
    if (value === undefined) return '"[Undefined]"'
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`
}

function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`)
    }
}
