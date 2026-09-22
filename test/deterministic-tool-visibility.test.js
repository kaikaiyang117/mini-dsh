import assert from 'node:assert/strict'
import test from 'node:test'
import { DeterministicToolVisibility } from '../src/core/deterministic-tool-visibility.js'
import { toolVisibilityFromEnv } from '../src/core/tool-visibility-config.js'

function tool(name, { description = '', properties = {} } = {}) {
    return {
        name,
        description,
        parameters: { type: 'object', properties },
    }
}

test('small catalogs bypass routing and return every Tool', () => {
    const catalog = [tool('one'), tool('two')]
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 2 })
    assert.deepEqual(visibility.select({ catalog, input: 'no match' }), ['one', 'two'])
})

test('exact tool-name token match outranks unrelated candidates', () => {
    const catalog = [
        tool('read_file'),
        tool('file_metadata', { description: 'Read metadata from a file' }),
        ...Array.from({ length: 4 }, (_, i) => tool(`unrelated_${i}`)),
    ]
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    assert.deepEqual(visibility.select({ catalog, input: 'read file' }), ['read_file'])
})

test('description overlap contributes a deterministic positive score', () => {
    const catalog = [
        tool('alpha', { description: 'Search customer invoices by month' }),
        tool('beta', { description: 'Read local project files' }),
        tool('gamma'),
    ]
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    assert.deepEqual(visibility.select({ catalog, input: 'invoices' }), ['alpha'])
})

test('JSON Schema property-name overlap contributes a lower positive score', () => {
    const catalog = [
        tool('alpha', { properties: { checksum: { type: 'string' } } }),
        tool('beta'),
        tool('gamma'),
    ]
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    assert.deepEqual(visibility.select({ catalog, input: 'checksum' }), ['alpha'])
})

test('Top-K uses deterministic score ordering with registration-order tie breaks', () => {
    const catalog = Array.from({ length: 20 }, (_, i) =>
        tool(`tool_${i}`, { description: 'search records' }),
    )
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 5 })
    const expected = ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']

    assert.deepEqual(visibility.select({ catalog, input: 'records' }), expected)
    assert.deepEqual(visibility.select({ catalog, input: 'records' }), expected)
    assert.ok(visibility.select({ catalog, input: 'records' }).length <= 5)
})

test('no positive lexical match safely falls back to all registered Tools', () => {
    const catalog = [tool('read_file', { description: 'Read a file' }), tool('run_query')]
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    assert.deepEqual(visibility.select({ catalog, input: '查找天气' }), ['read_file', 'run_query'])
    assert.deepEqual(visibility.select({ catalog, input: 'unrelated term' }), [
        'read_file',
        'run_query',
    ])
})

test('empty input falls back to all and an empty catalog stays empty', () => {
    const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    const catalog = [tool('alpha'), tool('beta')]
    assert.deepEqual(visibility.select({ catalog, input: '' }), ['alpha', 'beta'])
    assert.deepEqual(visibility.select({ catalog: [], input: 'alpha' }), [])
})

test('always-visible Tools are extra pinned slots and unknown names are ignored', () => {
    const catalog = [
        tool('search_docs', { description: 'Search documentation' }),
        tool('core_status'),
        tool('other'),
    ]
    const visibility = new DeterministicToolVisibility({
        maxVisibleTools: 1,
        alwaysVisible: ['core_status', 'optional_missing'],
    })

    assert.deepEqual(visibility.select({ catalog, input: 'documentation' }), [
        'search_docs',
        'core_status',
    ])
    assert.deepEqual(visibility.select({ catalog, input: 'core status' }), ['core_status'])
})

test('invalid routing limits and visibility environment values fail fast', () => {
    assert.throws(() => new DeterministicToolVisibility({ maxVisibleTools: 0 }), /positive integer/)
    assert.throws(
        () => new DeterministicToolVisibility({ maxVisibleTools: 1.5 }),
        /positive integer/,
    )
    assert.throws(() => toolVisibilityFromEnv({ MINI_DSH_TOOL_ROUTING: 'bm25' }), /must be/)
    assert.throws(
        () =>
            toolVisibilityFromEnv({
                MINI_DSH_TOOL_ROUTING: 'deterministic',
                MINI_DSH_MAX_VISIBLE_TOOLS: '2.5',
            }),
        /positive integer/,
    )
    assert.throws(
        () => toolVisibilityFromEnv({ MINI_DSH_MAX_VISIBLE_TOOLS: '0' }),
        /positive integer/,
    )
})

test('production visibility defaults to all and enables deterministic routing explicitly', () => {
    const all = toolVisibilityFromEnv({})
    const deterministic = toolVisibilityFromEnv({
        MINI_DSH_TOOL_ROUTING: 'deterministic',
        MINI_DSH_MAX_VISIBLE_TOOLS: '7',
    })

    assert.equal(all.constructor.name, 'AllToolsVisibility')
    assert.equal(deterministic.constructor.name, 'DeterministicToolVisibility')
    assert.equal(deterministic.maxVisibleTools, 7)
})
