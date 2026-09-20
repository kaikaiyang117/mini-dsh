import { readFile, truncate } from 'node:fs/promises'

export class SessionCorruptionError extends Error {
    constructor(message, options) {
        super(message, options)
        this.name = 'SessionCorruptionError'
    }
}

/**
 * Reads JSONL by byte offsets. A malformed final fragment is the only case
 * repaired automatically; all corruption before the final byte range fails.
 */
export async function readJsonlWithRecovery(filePath, fileSystem = { readFile, truncate }) {
    const buffer = await fileSystem.readFile(filePath)
    return parseJsonlBuffer(buffer, {
        recoverFinalLine: true,
        truncate: (offset) => fileSystem.truncate(filePath, offset),
    })
}

export async function readJsonl(filePath, fileSystem = { readFile }) {
    const buffer = await fileSystem.readFile(filePath)
    return parseJsonlBuffer(buffer)
}

async function parseJsonlBuffer(buffer, { recoverFinalLine = false, truncate: truncateFile } = {}) {
    const events = []
    let lineStart = 0

    for (let index = 0; index <= buffer.length; index += 1) {
        const atEnd = index === buffer.length
        if (!atEnd && buffer[index] !== 0x0a) continue

        const line = buffer.subarray(lineStart, index).toString('utf8').replace(/\r$/, '')
        const hasBytes = index > lineStart
        if (!hasBytes) {
            if (!atEnd) {
                throw new SessionCorruptionError(`Empty JSONL line at byte ${lineStart}`)
            }
            break
        }

        let event
        try {
            event = JSON.parse(line)
        } catch (cause) {
            const isFinalLine = atEnd || index + 1 === buffer.length
            if (isFinalLine && recoverFinalLine && events.length > 0) {
                await truncateFile(lineStart)
                return events
            }
            throw new SessionCorruptionError(
                'Corrupt JSONL at byte ' +
                    lineStart +
                    '; only a damaged final line may be recovered',
                { cause },
            )
        }

        validateEvent(event, events.length + 1, lineStart)
        events.push(event)
        lineStart = index + 1
    }

    return events
}

function validateEvent(event, expectedSeq, byteOffset) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new SessionCorruptionError(`Invalid event at byte ${byteOffset}`)
    }
    if (!Number.isInteger(event.seq) || event.seq !== expectedSeq) {
        throw new SessionCorruptionError(
            'Session sequence gap at byte ' +
                byteOffset +
                ': expected ' +
                expectedSeq +
                ', got ' +
                event.seq,
        )
    }
    if (typeof event.type !== 'string' || !('data' in event)) {
        throw new SessionCorruptionError(`Invalid event shape at byte ${byteOffset}`)
    }
}
