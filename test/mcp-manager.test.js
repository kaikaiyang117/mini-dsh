import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { MCP_STATES, McpManager } from '../src/core/mcp-manager.js'
import * as mcpPlugin from '../src/plugins/mcp.js'
import * as toolsPlugin from '../src/plugins/tools.js'

const fakePlugin = pathToFileURL(path.resolve('test/fixtures/fake-mcp-plugin.js')).href
const failingPlugin = pathToFileURL(path.resolve('test/fixtures/failing-mcp-plugin.js')).href

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function activatorHarness() {
    const calls = []
    const manager = new McpManager({
        activate: async (definition) => {
            calls.push(`activate:${definition.name}`)
            return {
                dispose: async () => {
                    calls.push(`dispose:${definition.name}`)
                },
            }
        },
    })
    return { manager, calls }
}

test('register, list, and get expose lifecycle metadata without secrets', async () => {
    const { manager } = activatorHarness()
    manager.register({
        name: 'context7',
        autoStart: true,
        config: {
            serverName: 'context7',
            headers: { Authorization: 'Bearer secret-token' },
            apiKey: 'another-secret',
            url: 'https://example.test/mcp',
            backupUrl: 'https://example.test/mcp?token=query-secret',
        },
    })

    const status = manager.get('context7')
    assert.equal(status.state, MCP_STATES.DISCONNECTED)
    assert.equal(status.autoStart, true)
    assert.equal(status.config.headers.Authorization, '[REDACTED]')
    assert.equal(status.config.apiKey, '[REDACTED]')
    assert.match(status.config.backupUrl, /token=%5BREDACTED%5D|token=\[REDACTED\]/)
    assert.doesNotMatch(JSON.stringify(manager.list()), /secret-token|another-secret|query-secret/)

    const unsafeManager = new McpManager({
        activate: async () => {
            throw new Error('request failed: Authorization: Bearer leaked-token')
        },
    })
    unsafeManager.register({ name: 'unsafe' })
    await assert.rejects(() => unsafeManager.connect('unsafe'))
    assert.doesNotMatch(unsafeManager.get('unsafe').lastError.message, /leaked-token/)
})

test('duplicate server names are rejected', () => {
    const { manager } = activatorHarness()
    manager.register({ name: 'context7' })
    assert.throws(() => manager.register({ name: 'context7' }), /duplicate MCP server name/)
})

test('connect transitions to ACTIVE and is idempotent', async () => {
    const { manager, calls } = activatorHarness()
    manager.register({ name: 'context7' })

    assert.equal((await manager.connect('context7')).state, MCP_STATES.ACTIVE)
    assert.equal((await manager.connect('context7')).state, MCP_STATES.ACTIVE)
    assert.deepEqual(calls, ['activate:context7'])
})

test('CONNECTING is observable while plugin activation is pending', async () => {
    let release
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const manager = new McpManager({
        activate: async () => {
            await gate
            return { dispose() {} }
        },
    })
    manager.register({ name: 'context7' })
    const connecting = manager.connect('context7')
    await delay(0)
    assert.equal(manager.get('context7').state, MCP_STATES.CONNECTING)
    release()
    assert.equal((await connecting).state, MCP_STATES.ACTIVE)
})

test('connect queued behind disconnect respects lifecycle FIFO even while state is ACTIVE', async () => {
    let disposeStarted
    const disposing = new Promise((resolve) => {
        disposeStarted = resolve
    })
    let releaseDispose
    const disposeGate = new Promise((resolve) => {
        releaseDispose = resolve
    })
    let activations = 0
    const manager = new McpManager({
        activate: async () => {
            activations += 1
            return {
                dispose: async () => {
                    disposeStarted()
                    await disposeGate
                },
            }
        },
    })
    manager.register({ name: 'context7' })
    await manager.connect('context7')

    const disconnecting = manager.disconnect('context7')
    await disposing
    const reconnecting = manager.connect('context7')
    assert.equal(activations, 1)
    releaseDispose()
    await Promise.all([disconnecting, reconnecting])
    assert.equal(activations, 2)
    assert.equal(manager.get('context7').state, MCP_STATES.ACTIVE)
})

test('activation failure records FAILED and a later connect retries', async () => {
    let attempts = 0
    const manager = new McpManager({
        activate: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('server unavailable')
            return { dispose() {} }
        },
    })
    manager.register({ name: 'context7' })

    await assert.rejects(() => manager.connect('context7'), /server unavailable/)
    assert.equal(manager.get('context7').state, MCP_STATES.FAILED)
    assert.equal(manager.get('context7').lastError.message, 'server unavailable')
    assert.equal((await manager.connect('context7')).state, MCP_STATES.ACTIVE)
    assert.equal(attempts, 2)
})

test('disconnect disposes an active fiber once', async () => {
    const { manager, calls } = activatorHarness()
    manager.register({ name: 'context7' })
    await manager.connect('context7')
    await manager.disconnect('context7')
    await manager.disconnect('context7')

    assert.equal(manager.get('context7').state, MCP_STATES.DISCONNECTED)
    assert.deepEqual(calls, ['activate:context7', 'dispose:context7'])
})

test('reload disposes the old fiber before activating the new one', async () => {
    const { manager, calls } = activatorHarness()
    manager.register({ name: 'context7' })
    await manager.connect('context7')
    await manager.reload('context7')

    assert.equal(manager.get('context7').state, MCP_STATES.ACTIVE)
    assert.deepEqual(calls, ['activate:context7', 'dispose:context7', 'activate:context7'])
})

test('same-server lifecycle operations are serialized', async () => {
    const events = []
    const manager = new McpManager({
        activate: async () => {
            events.push('activate:start')
            await delay(10)
            events.push('activate:end')
            return {
                dispose: async () => {
                    events.push('dispose:start')
                    await delay(10)
                    events.push('dispose:end')
                },
            }
        },
    })
    manager.register({ name: 'context7' })

    await Promise.all([manager.connect('context7'), manager.disconnect('context7')])
    assert.deepEqual(events, ['activate:start', 'activate:end', 'dispose:start', 'dispose:end'])
})

test('different servers can run lifecycle operations concurrently', async () => {
    const active = new Set()
    let overlapped = false
    const manager = new McpManager({
        activate: async (definition) => {
            active.add(definition.name)
            if (active.size === 2) overlapped = true
            await delay(10)
            active.delete(definition.name)
            return { dispose() {} }
        },
    })
    manager.register({ name: 'github' })
    manager.register({ name: 'context7' })

    await Promise.all([manager.connect('github'), manager.connect('context7')])
    assert.equal(overlapped, true)
})

test('one failed server does not poison another server', async () => {
    const manager = new McpManager({
        activate: async (definition) => {
            if (definition.name === 'broken') throw new Error('broken server')
            return { dispose() {} }
        },
    })
    manager.register({ name: 'broken' })
    manager.register({ name: 'healthy' })

    const results = await Promise.allSettled([
        manager.connect('broken'),
        manager.connect('healthy'),
    ])
    assert.equal(results[0].status, 'rejected')
    assert.equal(results[1].value.state, MCP_STATES.ACTIVE)
})

test('auto-start failure is recorded without preventing other servers from starting', async () => {
    const manager = new McpManager({
        activate: async (definition) => {
            if (definition.name === 'offline') throw new Error('remote unavailable')
            return { dispose() {} }
        },
    })
    manager.register({ name: 'offline', autoStart: true })
    manager.register({ name: 'local-docs', autoStart: true })

    const statuses = await manager.startAuto()
    assert.deepEqual(
        statuses.map((status) => status.state),
        [MCP_STATES.FAILED, MCP_STATES.ACTIVE],
    )
    assert.equal(manager.get('offline').lastError.message, 'remote unavailable')
})

test('dispose cleans up all active fibers', async () => {
    const { manager, calls } = activatorHarness()
    manager.register({ name: 'github' })
    manager.register({ name: 'context7' })
    await Promise.all([manager.connect('github'), manager.connect('context7')])
    await manager.dispose()

    assert.deepEqual(
        calls.sort(),
        ['activate:context7', 'activate:github', 'dispose:context7', 'dispose:github'].sort(),
    )
    assert.deepEqual(manager.list(), [])
})

test('Cordis adapter owns fake MCP tool lifecycle', async () => {
    const root = new Context()
    try {
        await root.plugin(toolsPlugin)
        await root.plugin(mcpPlugin, {
            servers: [{ name: 'fake', package: fakePlugin }],
        })

        assert.equal(root.mcp.get('fake').state, MCP_STATES.DISCONNECTED)
        await root.mcp.connect('fake')
        assert.ok(root.tools.get('mcp__fake__echo'))

        await root.mcp.disconnect('fake')
        assert.equal(root.tools.get('mcp__fake__echo'), undefined)
    } finally {
        await root.fiber.dispose()
    }
})

test('Cordis adapter disposes a partially activated plugin on startup failure', async () => {
    const root = new Context()
    try {
        await root.plugin(toolsPlugin)
        await root.plugin(mcpPlugin, {
            servers: [{ name: 'broken', package: failingPlugin }],
        })

        assert.equal(root.mcp.get('broken').state, MCP_STATES.DISCONNECTED)
        await assert.rejects(() => root.mcp.connect('broken'), /activation failed/)
        assert.equal(root.mcp.get('broken').state, MCP_STATES.FAILED)
        assert.equal(root.tools.get('mcp__broken__partial'), undefined)
    } finally {
        await root.fiber.dispose()
    }
})

test('Context7 is configured only through the managed MCP config', async () => {
    const { default: managed } = await import('../mcp.config.js')
    const { default: external } = await import('../plugins.config.js')
    assert.deepEqual(
        managed.map((entry) => entry.name),
        ['context7'],
    )
    assert.equal(managed[0].config.failOnStartupError, true)
    assert.equal(
        external.some((entry) => entry.config?.serverName === 'context7'),
        false,
    )
})
