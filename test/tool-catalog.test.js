import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { DeterministicToolVisibility } from '../src/core/deterministic-tool-visibility.js'
import { ToolCatalog } from '../src/core/tool-catalog.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import * as mcpPlugin from '../src/plugins/mcp.js'
import * as toolsPlugin from '../src/plugins/tools.js'

const fakeMcpPlugin = pathToFileURL(path.resolve('test/fixtures/fake-mcp-plugin.js')).href

function register(tools, name, overrides = {}) {
    return tools.register({
        name,
        description: `${name} description`,
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        execute: async () => name,
        ...overrides,
    })
}

test('catalog snapshots expose immutable metadata without execution functions', () => {
    const tools = new ToolRuntime()
    register(tools, 'tool-a', {
        readOnly: true,
        idempotent: true,
        concurrencySafe: true,
        timeoutMs: 250,
        output: { render() {} },
        finalizeContent() {},
    })
    const snapshot = new ToolCatalog({ tools }).snapshot()
    const [entry] = snapshot.list()

    assert.deepEqual(entry, {
        name: 'tool-a',
        description: 'tool-a description',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        readOnly: true,
        idempotent: true,
        concurrencySafe: true,
        sideEffect: true,
        timeoutMs: 250,
    })
    assert.equal('execute' in entry, false)
    assert.equal('output' in entry, false)
    assert.equal('finalizeContent' in entry, false)
    assert.equal(Object.isFrozen(entry), true)
    assert.equal(Object.isFrozen(entry.parameters.properties.value), true)
    assert.throws(() => {
        entry.parameters.properties.value.type = 'number'
    }, TypeError)
})

test('default full view schemas match ToolRuntime schemas in registry order', () => {
    const tools = new ToolRuntime()
    register(tools, 'tool-a')
    register(tools, 'tool-b')
    const view = new ToolCatalog({ tools }).snapshot().view()

    assert.deepEqual(view.schemas(), tools.schemas())
    assert.deepEqual(view.names(), ['tool-a', 'tool-b'])
    assert.equal(view.has('tool-a'), true)
})

test('subset selection deduplicates names and retains registration order', () => {
    const tools = new ToolRuntime()
    for (const name of ['A', 'B', 'C', 'D']) register(tools, name)
    const view = new ToolCatalog({ tools }).snapshot().view(['D', 'B', 'B'])

    assert.deepEqual(view.names(), ['B', 'D'])
    assert.deepEqual(
        view.schemas().map((schema) => schema.function.name),
        ['B', 'D'],
    )
})

test('empty and unknown selections have explicit semantics', () => {
    const tools = new ToolRuntime()
    register(tools, 'tool-a')
    const snapshot = new ToolCatalog({ tools }).snapshot()
    const empty = snapshot.view([])

    assert.deepEqual(empty.names(), [])
    assert.deepEqual(empty.list(), [])
    assert.deepEqual(empty.schemas(), [])
    assert.throws(() => snapshot.view(['does-not-exist']), /unknown catalog tool: does-not-exist/)
})

test('snapshot remains stable across registration and disposal changes', () => {
    const tools = new ToolRuntime()
    register(tools, 'A')
    register(tools, 'B')
    const catalog = new ToolCatalog({ tools })
    const first = catalog.snapshot()

    const disposeC = register(tools, 'C')
    assert.deepEqual(first.names(), ['A', 'B'])
    const second = catalog.snapshot()
    assert.deepEqual(second.names(), ['A', 'B', 'C'])

    disposeC()
    assert.deepEqual(second.names(), ['A', 'B', 'C'])
    assert.deepEqual(catalog.snapshot().names(), ['A', 'B'])
})

test('new snapshots reflect MCP Tool registration and disposal without changing old snapshots', async () => {
    const root = new Context()
    try {
        await root.plugin(toolsPlugin)
        await root.plugin(mcpPlugin, {
            servers: [{ name: 'fake', package: fakeMcpPlugin }],
        })
        register(root.tools, 'local_alpha')
        register(root.tools, 'local_beta')
        const catalog = new ToolCatalog({ tools: root.tools })
        const visibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
        const beforeConnect = catalog.snapshot()
        assert.deepEqual(beforeConnect.names(), ['local_alpha', 'local_beta'])
        assert.deepEqual(visibility.select({ catalog: beforeConnect.list(), input: 'fake echo' }), [
            'local_alpha',
            'local_beta',
        ])

        await root.mcp.connect('fake')
        const connected = catalog.snapshot()
        assert.deepEqual(connected.names(), ['local_alpha', 'local_beta', 'mcp__fake__echo'])
        assert.deepEqual(visibility.select({ catalog: connected.list(), input: 'fake echo' }), [
            'mcp__fake__echo',
        ])
        assert.deepEqual(beforeConnect.names(), ['local_alpha', 'local_beta'])

        await root.mcp.disconnect('fake')
        const disconnected = catalog.snapshot()
        assert.deepEqual(disconnected.names(), ['local_alpha', 'local_beta'])
        assert.deepEqual(visibility.select({ catalog: disconnected.list(), input: 'fake echo' }), [
            'local_alpha',
            'local_beta',
        ])
        assert.deepEqual(connected.names(), ['local_alpha', 'local_beta', 'mcp__fake__echo'])
    } finally {
        await root.fiber.dispose()
    }
})
