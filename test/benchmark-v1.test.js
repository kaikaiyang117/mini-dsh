import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadCodingCases } from '../benchmarks/coding/loader.js'
import { scoreCodingCase } from '../benchmarks/coding/scorer.js'
import { validateCodingBenchmark } from '../benchmarks/coding/validator.js'
import { copyWorkspace, snapshotWorkspace } from '../benchmarks/coding/workspace.js'

test('Coding Benchmark V1 has the formal 16-case contract and validates offline', async () => {
    const cases = loadCodingCases()
    assert.equal(cases.length, 16)
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
        calls: [{ id, name: 'bash', arguments: { command: spec.publicTestCommand } }],
        results: [
            {
                type: 'tool/result',
                data: {
                    toolCallId: id,
                    name: 'bash',
                    isError: false,
                    content: JSON.stringify({ command: spec.publicTestCommand, exitCode: 0 }),
                },
            },
        ],
    }
}

test('scorer rejects extra files, hidden-test tampering, and duplicate or missing Results', async () => {
    const spec = loadCodingCases()[0]
    const fixture = await fixtureFor(spec)
    await spec.reference.apply({ workspace: fixture.workspace })
    const events = passingBash(spec)
    fixture.inspectors.session.events = [
        { type: 'assistant/tool_calls', data: { toolCalls: events.calls } },
        ...events.results,
    ]
    await fs.writeFile(path.join(fixture.workspace, 'unrelated.js'), '')
    let score = await scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture,
        evalCase: spec,
    })
    assert.equal(score.success, false)
    assert.deepEqual(score.details.unexpectedCreatedFiles, ['unrelated.js'])
    fixture.inspectors.session.events = [
        { type: 'assistant/tool_calls', data: { toolCalls: [...events.calls, ...events.calls] } },
        ...events.results,
    ]
    score = await scoreCodingCase({ trace: { stopReason: 'completed' }, fixture, evalCase: spec })
    assert.equal(score.details.protocolComplete, false)
    await fs.rm(fixture.workspace, { recursive: true, force: true })

    const tampered = await fixtureFor(spec)
    await fs.writeFile(
        path.join(tampered.workspace, 'test.js'),
        "import test from 'node:test'; test('tampered', () => {})\n",
    )
    const tamperedEvents = passingBash(spec)
    tampered.inspectors.session.events = [
        { type: 'assistant/tool_calls', data: { toolCalls: tamperedEvents.calls } },
        ...tamperedEvents.results,
    ]
    score = await scoreCodingCase({
        trace: { stopReason: 'completed' },
        fixture: tampered,
        evalCase: spec,
    })
    assert.equal(score.details.hiddenTestsPassed, false)
    await fs.rm(tampered.workspace, { recursive: true, force: true })
})
