import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { MCP_STATES, McpManager } from '../src/core/mcp-manager.js'
import * as externalPlugins from '../src/plugins/external-plugins.js'
import * as llmPlugin from '../src/plugins/llm.js'
import * as mcpPlugin from '../src/plugins/mcp.js'
import * as toolsPlugin from '../src/plugins/tools.js'

const fakePlugin = pathToFileURL(path.resolve('test/fixtures/fake-mcp-plugin.js')).href
const failingPlugin = pathToFileURL(path.resolve('test/fixtures/failing-mcp-plugin.js')).href
const llmDependentPlugin = pathToFileURL(
    path.resolve('test/fixtures/llm-dependent-external-plugin.js'),
).href

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
    assert.deepEqual(Object.keys(status).sort(), [
        'autoStart',
        'lastError',
        'name',
        'package',
        'state',
    ])
    assert.equal('config' in status, false)

    manager.register({
        name: 'sensitive-config',
        config: {
            env: {
                PRIVATE_KEY: 'private-key-value',
                CLIENT_CERT: 'client-certificate-value',
                arbitrary: 'RANDOM_SECRET_VALUE',
            },
        },
    })
    const publicJson = JSON.stringify([manager.get('context7'), ...manager.list()])
    assert.doesNotMatch(
        publicJson,
        /PRIVATE_KEY|CLIENT_CERT|private-key-value|client-certificate-value|RANDOM_SECRET_VALUE/,
    )

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

test('disconnect retries failed disposal and retains the fiber until cleanup succeeds', async () => {
    const { manager, calls } = activatorHarness()
    let disposeAttempts = 0
    const retryManager = new McpManager({
        activate: async () => ({
            dispose: async () => {
                disposeAttempts += 1
                if (disposeAttempts === 1) throw new Error('cleanup failed')
            },
        }),
    })
    retryManager.register({ name: 'context7' })
    await retryManager.connect('context7')
    await assert.rejects(() => retryManager.disconnect('context7'), /cleanup failed/)
    assert.equal(retryManager.get('context7').state, MCP_STATES.FAILED)
    assert.equal(retryManager.get('context7').lastError.message, 'cleanup failed')
    await retryManager.disconnect('context7')
    assert.equal(retryManager.get('context7').state, MCP_STATES.DISCONNECTED)
    assert.equal(retryManager.get('context7').lastError, null)
    assert.equal(disposeAttempts, 2)

    // Keep a separate assertion that successful cleanup remains idempotent.
    manager.register({ name: 'github' })
    await manager.connect('github')
    await manager.disconnect('github')
    await manager.disconnect('github')
    assert.equal(manager.get('github').state, MCP_STATES.DISCONNECTED)
    assert.deepEqual(calls, ['activate:github', 'dispose:github'])
})

test('reload does not activate a new fiber if old disposal fails', async () => {
    let activations = 0
    const manager = new McpManager({
        activate: async () => {
            activations += 1
            return {
                dispose: async () => {
                    throw new Error('cleanup failed')
                },
            }
        },
    })
    manager.register({ name: 'context7' })
    await manager.connect('context7')
    await assert.rejects(() => manager.reload('context7'), /cleanup failed/)
    assert.equal(activations, 1)
    assert.equal(manager.get('context7').state, MCP_STATES.FAILED)
})

test('connect retries old fiber cleanup before activation and does not create an orphan fiber', async () => {
    let activations = 0
    let disposeAttempts = 0
    const manager = new McpManager({
        activate: async () => {
            activations += 1
            return {
                dispose: async () => {
                    disposeAttempts += 1
                    if (disposeAttempts === 1) throw new Error('cleanup failed')
                },
            }
        },
    })
    manager.register({ name: 'context7' })
    await manager.connect('context7')
    await assert.rejects(() => manager.disconnect('context7'), /cleanup failed/)
    await manager.connect('context7')
    assert.equal(activations, 2)
    assert.equal(disposeAttempts, 2)
    assert.equal(manager.get('context7').state, MCP_STATES.ACTIVE)
})

test('unregister blocks new lifecycle operations and waits for active fiber cleanup', async () => {
    let releaseDispose
    const disposeGate = new Promise((resolve) => {
        releaseDispose = resolve
    })
    let disposeCount = 0
    const manager = new McpManager({
        activate: async () => ({
            dispose: async () => {
                disposeCount += 1
                await disposeGate
            },
        }),
    })
    const unregister = manager.register({ name: 'context7' })
    await manager.connect('context7')

    const unregistering = unregister()
    await assert.rejects(() => manager.connect('context7'), /being removed/)
    await assert.rejects(() => manager.disconnect('context7'), /being removed/)
    await assert.rejects(() => manager.reload('context7'), /being removed/)
    releaseDispose()
    await unregistering
    await unregister()
    assert.equal(manager.get('context7'), undefined)
    assert.equal(disposeCount, 1)
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

test('manager dispose rejects on partial cleanup failure and retries retained fibers', async () => {
    let serverADisposals = 0
    let serverBDisposals = 0
    const manager = new McpManager({
        activate: async ({ name }) => ({
            dispose: async () => {
                if (name === 'server-a') {
                    serverADisposals += 1
                    return
                }
                serverBDisposals += 1
                if (serverBDisposals === 1) throw new Error('server-b cleanup failed')
            },
        }),
    })
    manager.register({ name: 'server-a' })
    manager.register({ name: 'server-b' })
    await Promise.all([manager.connect('server-a'), manager.connect('server-b')])

    await assert.rejects(() => manager.dispose(), /server-b cleanup failed/)
    assert.equal(serverADisposals, 1)
    assert.equal(serverBDisposals, 1)
    assert.equal(manager.get('server-a').state, MCP_STATES.DISCONNECTED)
    assert.equal(manager.get('server-b').state, MCP_STATES.FAILED)
    assert.equal(manager.get('server-b').lastError.message, 'server-b cleanup failed')
    assert.equal(manager.list().length, 2)

    await manager.dispose()
    assert.equal(serverADisposals, 1)
    assert.equal(serverBDisposals, 2)
    assert.deepEqual(manager.list(), [])
    assert.throws(() => manager.register({ name: 'too-late' }), /disposing or disposed/)
    await assert.rejects(() => manager.connect('server-b'), /disposing or disposed/)
})

test('concurrent manager dispose calls share one shutdown operation', async () => {
    let releaseDispose
    const disposeGate = new Promise((resolve) => {
        releaseDispose = resolve
    })
    let disposeCount = 0
    const manager = new McpManager({
        activate: async () => ({
            dispose: async () => {
                disposeCount += 1
                await disposeGate
            },
        }),
    })
    manager.register({ name: 'context7' })
    await manager.connect('context7')

    const firstDispose = manager.dispose()
    const secondDispose = manager.dispose()
    assert.equal(disposeCount, 0)
    assert.throws(() => manager.register({ name: 'too-late' }), /disposing or disposed/)
    await assert.rejects(() => manager.connect('context7'), /disposing or disposed/)
    await assert.rejects(() => manager.reload('context7'), /disposing or disposed/)
    await delay(0)
    assert.equal(disposeCount, 1)
    releaseDispose()
    await Promise.all([firstDispose, secondDispose])
    assert.equal(disposeCount, 1)
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
    assert.equal(managed[0].config.failOnStartupError, false)
    assert.equal(
        external.some((entry) => entry.config?.serverName === 'context7'),
        false,
    )
})

test('ordinary external Cordis plugins remain loadable through the generic loader', async () => {
    const root = new Context()
    try {
        await root.plugin(toolsPlugin)
        await root.plugin(externalPlugins, {
            entries: [{ package: fakePlugin }],
        })
        assert.ok(root.tools.get('mcp__fake__echo'))
    } finally {
        await root.fiber.dispose()
    }
})

test('standard startup installs llm before loading external plugins that inject it', async () => {
    const root = new Context()
    try {
        await root.plugin(llmPlugin)
        await root.plugin(externalPlugins, {
            entries: [{ package: llmDependentPlugin }],
        })
        const { activatedWithLlm } = await import(llmDependentPlugin)
        assert.equal(activatedWithLlm, true)

        const entry = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
        assert.ok(
            entry.indexOf('await root.plugin(llm)') <
                entry.indexOf('await root.plugin(externalPlugins'),
        )
        assert.ok(
            entry.indexOf('await root.plugin(files') <
                entry.indexOf('await root.plugin(externalPlugins'),
        )
        assert.ok(
            entry.indexOf('await root.plugin(externalPlugins') <
                entry.indexOf('await root.plugin(cli'),
        )
    } finally {
        await root.fiber.dispose()
    }
})
