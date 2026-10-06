import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadCodingCases } from '../benchmarks/coding/loader.js'
import { scoreCodingCase } from '../benchmarks/coding/scorer.js'
import { createCodingBenchmarkV1Suite } from '../benchmarks/coding/suite.js'
import { validateCodingBenchmark } from '../benchmarks/coding/validator.js'
import { copyWorkspace, snapshotWorkspace } from '../benchmarks/coding/workspace.js'
import { BenchmarkRunner } from '../src/benchmark/benchmark-runner.js'
import { isValidEvalCase } from '../src/eval/eval-suite.js'

test('Coding Benchmark V1 has the formal 16-case contract and validates offline', async () => {
    const cases = loadCodingCases()
    assert.equal(cases.length, 16)
    assert.ok(
        cases.every(
            (item) =>
                item.expected.completion === 'stop-reason' &&
                item.expected.stopReason === 'completed',
        ),
    )
    assert.ok(cases.every(isValidEvalCase))
    assert.deepEqual(
        cases.map(({ name }) => name),
        [
            'clamp-boundaries',
            'retry-count-off-by-one',
            'duration-zero-handling',
            'stable-deduplication',
            'config-precedence',
            'cache-invalidation',
            'rename-index-consistency',
            'plugin-disable-state',
            'cache-ttl',
            'pagination-filter',
            'event-once-listener',
            'csv-export',
            'nested-secret-redaction',
            'route-normalization',
            'dependency-order',
            'validation-refactor-regression',
        ],
    )
    const report = await validateCodingBenchmark()
    assert.equal(report.cases.length, 16)
})

async function fixtureFor(spec) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v1-test-'))
    await copyWorkspace(spec.workspaceDir, workspace)
    return {
        workspace,
        initialSnapshot: await snapshotWorkspace(workspace),
        session: { events: [] },
        inspectors: {
            workspace,
            initialSnapshot: await snapshotWorkspace(workspace),
            session: { events: [] },
            baselineValid: true,
        },
    }
}

function passingBash(spec, id = 'call-1') {
    return {
        calls: [
            { id: `${id}-fail`, name: 'bash', arguments: { command: spec.publicTestCommand } },
            { id: `${id}-pass`, name: 'bash', arguments: { command: spec.publicTestCommand } },
        ],
        results: [
            {
                type: 'tool/result',
                data: {
                    toolCallId: `${id}-fail`,
                    name: 'bash',
                    isError: false,
                    content: JSON.stringify({ command: spec.publicTestCommand, exitCode: 1 }),
                },
            },
            {
                type: 'tool/result',
                data: {
                    toolCallId: `${id}-pass`,
                    name: 'bash',
                    isError: false,
                    content: JSON.stringify({ command: spec.publicTestCommand, exitCode: 0 }),
                },
            },
        ],
    }
}

function attachAgentEvents(fixture, events) {
    fixture.inspectors.session.events = [
        { type: 'assistant/tool_calls', data: { toolCalls: events.calls } },
        ...events.results,
    ]
}

test('Coding Benchmark V1 passes through BenchmarkRunner, EvalRunner, AgentLoop, Tools, and scorer', async () => {
    const actions = [
        ['read_file', { path: 'calculator.js' }],
        ['bash', { command: 'env -u NODE_TEST_CONTEXT node --test test.js' }],
        [
            'edit_file',
            {
                path: 'calculator.js',
                oldText: 'Math.min(min, Math.max(max, value))',
                newText: 'Math.max(min, Math.min(max, value))',
            },
        ],
        ['bash', { command: 'env -u NODE_TEST_CONTEXT node --test test.js' }],
    ]
    const registerProvider = async (root) => {
        let index = 0
        root.llm.register(
            'fake',
            {
                models: ['v1'],
                async chat() {
                    const action = actions[index++]
                    return {
                        content: action ? '' : 'The boundary fix is complete.',
                        toolCalls: action
                            ? [{ id: `v1-${index}`, name: action[0], arguments: action[1] }]
                            : [],
                        usage: {
                            inputTokens: 10,
                            outputTokens: 3,
                            reasoningTokens: 0,
                            cost: 0.001,
                        },
                    }
                },
            },
            { defaultModel: 'v1' },
        )
    }
    const suite = createCodingBenchmarkV1Suite({ registerProvider, pricing: {} })
    const report = await new BenchmarkRunner({
        suite,
        config: {
            model: 'fake/v1',
            repetitions: 1,
            variants: ['minimal'],
            selectedCases: ['clamp-boundaries'],
            maxTotalCost: null,
            allowUnknownCost: false,
        },
    }).run()
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0].success, true)
    assert.equal(report.results[0].scoreDetails.publicTestsPassed, true)
    assert.equal(report.results[0].scoreDetails.hiddenTestsPassed, true)
    assert.equal(report.results[0].scoreDetails.protocolComplete, true)
})

test('synchronous scorer rejects hidden failure, extra files, test tampering or deletion, and broken Tool protocols', async () => {
    const spec = loadCodingCases()[0]
    const fixture = await fixtureFor(spec)
    await spec.reference.apply({ workspace: fixture.workspace })
    const events = passingBash(spec)
    attachAgentEvents(fixture, events)
    assert.equal(
        scoreCodingCase({ trace: { stopReason: 'completed' }, fixture, evalCase: spec }) instanceof
            Promise,
        false,
    )
    const referenceScore = scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture,
        evalCase: spec,
    })
    assert.equal(referenceScore.success, true)
    spec.verifier = () => ({ passed: false, reason: 'intentional hidden failure' })
    assert.equal(
        scoreCodingCase({ trace: { stopReason: 'completed' }, fixture, evalCase: spec }).success,
        false,
    )
    spec.verifier = loadCodingCases()[0].verifier
    await fs.writeFile(path.join(fixture.workspace, 'unrelated.js'), '')
    let score = scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture,
        evalCase: spec,
    })
    assert.equal(score.success, false)
    assert.deepEqual(score.details.unexpectedCreatedFiles, ['unrelated.js'])
    assert.equal(score.details.publicTestsPassed, true)
    assert.equal(score.details.hiddenTestsPassed, true)

    await fs.rm(path.join(fixture.workspace, 'unrelated.js'))
    await fs.writeFile(
        path.join(fixture.workspace, 'test.js'),
        "import test from 'node:test'; test('tampered', () => {})\n",
    )
    score = scoreCodingCase({ trace: { stopReason: 'completed' }, fixture, evalCase: spec })
    assert.equal(score.details.publicTestsPassed, true)
    assert.equal(score.details.hiddenTestsPassed, true)
    assert.equal(score.success, false)
    await fs.writeFile(
        path.join(fixture.workspace, 'test.js'),
        fixture.inspectors.initialSnapshot['test.js'],
    )
    await fs.rm(path.join(fixture.workspace, 'test.js'))
    score = scoreCodingCase({ trace: { stopReason: 'completed' }, fixture, evalCase: spec })
    assert.equal(score.details.publicTestsPassed, false)
    assert.equal(score.success, false)

    await fs.rm(fixture.workspace, { recursive: true, force: true })

    const hFixture = await fixtureFor(loadCodingCases()[0])
    await fs.writeFile(
        path.join(hFixture.workspace, 'calculator.js'),
        `export function clamp(value, min, max) { if (value < min) return min; if (value > max) return max; return value }\n`,
    )
    attachAgentEvents(hFixture, passingBash(spec))
    const alternative = scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture: hFixture,
        evalCase: loadCodingCases()[0],
    })
    assert.equal(alternative.details.hiddenTestsPassed, true)
    assert.equal(alternative.success, true)
    await fs.rm(hFixture.workspace, { recursive: true, force: true })

    const protocolFixture = await fixtureFor(loadCodingCases()[0])
    await loadCodingCases()[0].reference.apply({ workspace: protocolFixture.workspace })
    const protocol = passingBash(spec)
    attachAgentEvents(protocolFixture, {
        ...protocol,
        results: [...protocol.results, ...protocol.results],
    })
    score = scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture: protocolFixture,
        evalCase: loadCodingCases()[0],
    })
    assert.equal(score.details.protocolComplete, false)
    attachAgentEvents(protocolFixture, { ...protocol, results: [] })
    score = scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture: protocolFixture,
        evalCase: loadCodingCases()[0],
    })
    assert.equal(score.details.protocolComplete, false)
    await fs.rm(protocolFixture.workspace, { recursive: true, force: true })
})
