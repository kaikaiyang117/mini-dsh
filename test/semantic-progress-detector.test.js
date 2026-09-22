import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PROGRESS_REMINDER,
    SemanticProgressDetector,
} from '../src/core/semantic-progress-detector.js'

const record = (name, arguments_, value, options = {}) => ({
    state: 'settled',
    call: { name, arguments: arguments_ },
    result: {
        value,
        isError: options.isError ?? false,
        errorCode: options.errorCode ?? null,
    },
})

const observe = (detector, ...records) => detector.observeStep({ toolCalls: [], records })

test('first empty result is neutral and repeated empty result is no-progress evidence', () => {
    const detector = new SemanticProgressDetector()
    assert.deepEqual(observe(detector, record('search', { query: 'a' }, '')), {
        state: 'neutral',
        action: 'continue',
        noProgressStreak: 0,
        reason: 'first_low_information_outcome',
    })
    assert.equal(observe(detector, record('search', { query: 'a' }, '')).state, 'no_progress')
})

test('canonical arguments ignore object key order and exact repeated call/result is detected', () => {
    const detector = new SemanticProgressDetector()
    observe(detector, record('read', { a: 1, b: 2 }, ''))
    const decision = observe(detector, record('read', { b: 2, a: 1 }, ''))
    assert.equal(decision.state, 'no_progress')
})

test('changed arguments with the same empty result are no-progress evidence', () => {
    const detector = new SemanticProgressDetector()
    observe(detector, record('grep', { query: 'Agent' }, ''))
    assert.equal(observe(detector, record('grep', { query: 'agent' }, '')).state, 'no_progress')
})

test('changed arguments with the same error code and result are no-progress evidence', () => {
    const detector = new SemanticProgressDetector()
    observe(
        detector,
        record('search', { query: 'first' }, null, { isError: true, errorCode: 'offline' }),
    )
    assert.equal(
        observe(
            detector,
            record('search', { query: 'second' }, null, { isError: true, errorCode: 'offline' }),
        ).state,
        'no_progress',
    )
})

test('process results ignore echoed command and volatile duration fields', () => {
    const detector = new SemanticProgressDetector()
    observe(
        detector,
        record(
            'bash',
            { command: 'grep Agent src' },
            {
                command: 'grep Agent src',
                cwd: '/workspace',
                durationMs: 10,
                exitCode: 1,
                stdout: '',
                stderr: '',
            },
        ),
    )
    const decision = observe(
        detector,
        record(
            'bash',
            { command: 'grep agent src' },
            {
                command: 'grep agent src',
                cwd: '/workspace',
                durationMs: 99,
                exitCode: 1,
                stdout: '',
                stderr: '',
            },
        ),
    )
    assert.equal(decision.state, 'no_progress')
})

test('same call with a changed informative result counts as progress', () => {
    const detector = new SemanticProgressDetector()
    assert.equal(observe(detector, record('version', {}, 'version 1')).state, 'progress')
    assert.equal(observe(detector, record('version', {}, 'version 2')).state, 'progress')
})

test('new informative results reset the no-progress streak', () => {
    const detector = new SemanticProgressDetector({ softThreshold: 2, hardThreshold: 4 })
    observe(detector, record('grep', { q: 'a' }, ''))
    observe(detector, record('grep', { q: 'a' }, ''))
    assert.equal(detector.snapshot().noProgressStreak, 1)
    assert.equal(observe(detector, record('read', {}, 'useful data')).state, 'progress')
    assert.equal(detector.snapshot().noProgressStreak, 0)
})

test('soft threshold arms one consumable fixed reminder', () => {
    const detector = new SemanticProgressDetector({ softThreshold: 2, hardThreshold: null })
    observe(detector, record('empty', {}, ''))
    observe(detector, record('empty', {}, ''))
    assert.equal(observe(detector, record('empty', {}, '')).action, 'remind')
    assert.equal(detector.takeReminder(), PROGRESS_REMINDER)
    assert.equal(detector.takeReminder(), null)
    assert.equal(observe(detector, record('empty', {}, '')).action, 'continue')
})

test('hard threshold stops and no hard threshold never stops', () => {
    const guarded = new SemanticProgressDetector({ softThreshold: 1, hardThreshold: 3 })
    observe(guarded, record('empty', {}, ''))
    assert.equal(observe(guarded, record('empty', {}, '')).action, 'remind')
    assert.equal(observe(guarded, record('empty', {}, '')).action, 'continue')
    assert.equal(observe(guarded, record('empty', {}, '')).action, 'stop')

    const remind = new SemanticProgressDetector({ softThreshold: 1, hardThreshold: null })
    observe(remind, record('empty', {}, ''))
    for (let index = 0; index < 8; index += 1) {
        assert.notEqual(observe(remind, record('empty', {}, '')).action, 'stop')
    }
})

test('parallel step aggregation gives progress precedence over repeated empty results', () => {
    const detector = new SemanticProgressDetector()
    observe(detector, record('empty', {}, ''))
    const decision = observe(
        detector,
        record('empty', {}, ''),
        record('read', {}, 'new useful content'),
    )
    assert.equal(decision.state, 'progress')
    assert.equal(decision.noProgressStreak, 0)
})

test('parallel repeated empty and repeated error results count as one no-progress Step', () => {
    const detector = new SemanticProgressDetector()
    observe(detector, record('empty', {}, ''))
    observe(detector, record('failed', {}, null, { isError: true, errorCode: 'offline' }))
    const decision = observe(
        detector,
        record('empty', {}, ''),
        record('failed', {}, null, { isError: true, errorCode: 'offline' }),
    )
    assert.equal(decision.state, 'no_progress')
    assert.equal(decision.noProgressStreak, 1)
})

test('parallel first low-information results are neutral', () => {
    const detector = new SemanticProgressDetector()
    assert.equal(
        observe(
            detector,
            record('empty', {}, ''),
            record('failed', {}, null, { isError: true, errorCode: 'offline' }),
        ).state,
        'neutral',
    )
})

test('not-started and cancelled records do not become progress evidence', () => {
    const detector = new SemanticProgressDetector()
    const decision = detector.observeStep({
        records: [
            { state: 'not_started', call: { name: 'tool', arguments: {} } },
            record('tool', {}, null, { isError: true, errorCode: 'cancelled' }),
        ],
    })
    assert.equal(decision.state, 'neutral')
    assert.equal(detector.snapshot().observationCount, 0)
})

test('circular values do not crash detection', () => {
    const value = {}
    value.self = value
    const detector = new SemanticProgressDetector()
    assert.equal(observe(detector, record('odd', {}, value)).state, 'progress')
})

test('invalid threshold configuration fails fast', () => {
    for (const config of [
        { softThreshold: 0 },
        { softThreshold: 1.5 },
        { softThreshold: -1 },
        { softThreshold: 2, hardThreshold: 2 },
        { softThreshold: 2, hardThreshold: 1 },
        { hardThreshold: 1.5 },
    ]) {
        assert.throws(() => new SemanticProgressDetector(config), TypeError)
    }
})
