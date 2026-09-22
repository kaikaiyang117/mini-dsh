import assert from 'node:assert/strict'
import test from 'node:test'
import { progressConfigFromEnv, progressDetectorFactory } from '../src/core/progress-config.js'

test('progress config defaults to off and supports remind and guarded modes', () => {
    assert.deepEqual(progressConfigFromEnv({}), {
        mode: 'off',
        softThreshold: 3,
        hardThreshold: 6,
    })
    assert.deepEqual(progressConfigFromEnv({ MINI_DSH_PROGRESS_MODE: 'remind' }), {
        mode: 'remind',
        softThreshold: 3,
        hardThreshold: null,
    })
    assert.deepEqual(
        progressConfigFromEnv({
            MINI_DSH_PROGRESS_MODE: 'guarded',
            MINI_DSH_PROGRESS_SOFT_STEPS: '2',
            MINI_DSH_PROGRESS_HARD_STEPS: '4',
        }),
        { mode: 'guarded', softThreshold: 2, hardThreshold: 4 },
    )
})

test('off does not create detectors and active modes create one detector per factory call', () => {
    assert.equal(progressDetectorFactory(progressConfigFromEnv({})), undefined)
    const factory = progressDetectorFactory(
        progressConfigFromEnv({ MINI_DSH_PROGRESS_MODE: 'remind' }),
    )
    assert.notEqual(factory(), factory())
})

test('only guarded mode applies a hard stop threshold', () => {
    const repeatedEmpty = {
        state: 'settled',
        call: { name: 'search', arguments: {} },
        result: { value: '', isError: false },
    }
    const remind = progressDetectorFactory(
        progressConfigFromEnv({
            MINI_DSH_PROGRESS_MODE: 'remind',
            MINI_DSH_PROGRESS_SOFT_STEPS: '1',
            MINI_DSH_PROGRESS_HARD_STEPS: '2',
        }),
    )()
    remind.observeStep({ records: [repeatedEmpty] })
    let remindDecision
    for (let index = 0; index < 8; index += 1) {
        remindDecision = remind.observeStep({ records: [repeatedEmpty] })
    }
    assert.notEqual(remindDecision.action, 'stop')

    const guarded = progressDetectorFactory(
        progressConfigFromEnv({
            MINI_DSH_PROGRESS_MODE: 'guarded',
            MINI_DSH_PROGRESS_SOFT_STEPS: '1',
            MINI_DSH_PROGRESS_HARD_STEPS: '2',
        }),
    )()
    guarded.observeStep({ records: [repeatedEmpty] })
    guarded.observeStep({ records: [repeatedEmpty] })
    assert.equal(guarded.observeStep({ records: [repeatedEmpty] }).action, 'stop')
})

test('invalid mode and step thresholds fail fast', () => {
    for (const env of [
        { MINI_DSH_PROGRESS_MODE: 'sometimes' },
        { MINI_DSH_PROGRESS_SOFT_STEPS: '0' },
        { MINI_DSH_PROGRESS_SOFT_STEPS: '-1' },
        { MINI_DSH_PROGRESS_SOFT_STEPS: '1.5' },
        {
            MINI_DSH_PROGRESS_MODE: 'guarded',
            MINI_DSH_PROGRESS_SOFT_STEPS: '3',
            MINI_DSH_PROGRESS_HARD_STEPS: '3',
        },
        {
            MINI_DSH_PROGRESS_MODE: 'guarded',
            MINI_DSH_PROGRESS_SOFT_STEPS: '4',
            MINI_DSH_PROGRESS_HARD_STEPS: '2',
        },
        { MINI_DSH_PROGRESS_MODE: 'guarded', MINI_DSH_PROGRESS_HARD_STEPS: '1.5' },
        { MINI_DSH_PROGRESS_MODE: 'remind', MINI_DSH_PROGRESS_HARD_STEPS: '0' },
        {
            MINI_DSH_PROGRESS_MODE: 'remind',
            MINI_DSH_PROGRESS_SOFT_STEPS: '3',
            MINI_DSH_PROGRESS_HARD_STEPS: '3',
        },
    ]) {
        assert.throws(() => progressConfigFromEnv(env), TypeError)
    }
})
