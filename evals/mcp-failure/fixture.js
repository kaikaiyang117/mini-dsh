import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { McpManager } from '../../src/core/mcp-manager.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../../src/core/tool-runtime.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'
import * as mcpPlugin from '../../src/plugins/mcp.js'
import * as toolsPlugin from '../../src/plugins/tools.js'

const fakePlugin = pathToFileURL(path.resolve('test/fixtures/fake-mcp-plugin.js')).href
const failingPlugin = pathToFileURL(path.resolve('test/fixtures/failing-mcp-plugin.js')).href
const unstablePlugin = pathToFileURL(path.resolve('test/fixtures/unstable-mcp-plugin.js')).href

export async function createMcpFailureFixture({ evalCase }) {
    const state = {
        serverStates: {},
        activationAttempts: 0,
        disposalAttempts: 0,
        registeredToolNames: [],
        result: null,
    }
    let root = null
    let manager = null
    if (
        [
            'cleanup-failure-retry',
            'reload-cleanup-failure',
            'manager-dispose-partial-failure',
        ].includes(evalCase.name)
    ) {
        manager = createHarnessManager(evalCase.name, state)
    } else {
        root = new Context()
        await root.plugin(toolsPlugin)
        const servers = serverDefinitions(evalCase.name)
        await root.plugin(mcpPlugin, { servers })
        manager = root.mcp
    }

    const fixture = {
        agent: {
            send: async () => {
                state.result = await runCase(evalCase.name, { root, manager, state })
            },
        },
        trace: { latest: () => state.result?.trace ?? { stopReason: 'completed', steps: [] } },
        recordingTokenMeter: {
            get requests() {
                return state.result?.requests ?? []
            },
        },
        inspectors: state,
        async dispose() {
            state.registeredToolNames = listTools(root, manager)
            if (root) await root.fiber.dispose()
            else if (manager) {
                try {
                    await manager.dispose()
                } catch {}
            }
        },
    }
    return fixture
}

function serverDefinitions(name) {
    if (name === 'activation-failure-cleanup') return [{ name: 'broken', package: failingPlugin }]
    if (name === 'mixed-server-isolation')
        return [
            { name: 'broken', package: failingPlugin },
            { name: 'fake', package: fakePlugin },
        ]
    if (name === 'active-plugin-tool-execution-failure')
        return [{ name: 'unstable', package: unstablePlugin }]
    return [{ name: 'fake', package: fakePlugin }]
}

async function runCase(name, { root, manager, state }) {
    if (name === 'activation-failure-cleanup') {
        await assertRejects(() => manager.connect('broken'))
        const status = manager.get('broken')
        state.serverStates.broken = status.state
        state.lastError = status.lastError
        const redactionManager = new McpManager({
            activate: async () => {
                throw new Error('Authorization: Bearer eval-secret-token')
            },
        })
        redactionManager.register({ name: 'redaction-check' })
        await assertRejects(() => redactionManager.connect('redaction-check'))
        state.errorRedacted = !redactionManager
            .get('redaction-check')
            .lastError.message.includes('eval-secret-token')
        state.registeredToolNames = listTools(root)
        return { protocolComplete: true }
    }
    if (name === 'mixed-server-isolation') {
        await assertRejects(() => manager.connect('broken'))
        await manager.connect('fake')
        const result = await root.tools.execute('mcp__fake__echo', {})
        state.serverStates.broken = manager.get('broken').state
        state.serverStates.fake = manager.get('fake').state
        state.healthyServerUsable = !result.isError && result.value === 'fake echo'
        state.registeredToolNames = listTools(root)
        state.brokenToolAbsent = !state.registeredToolNames.includes('mcp__broken__partial')
        return { protocolComplete: true }
    }
    if (name === 'disconnect-removes-tools') {
        await manager.connect('fake')
        const before = await root.tools.execute('mcp__fake__echo', {})
        await manager.disconnect('fake')
        const after = await root.tools.execute('mcp__fake__echo', {})
        state.serverStates.fake = manager.get('fake').state
        state.healthyServerUsable = !before.isError && before.value === 'fake echo'
        state.staleToolReturnedUnknown = after.errorCode === 'unknown_tool'
        state.toolErrorCode = after.errorCode
        state.toolIsError = after.isError
        state.registeredToolNames = listTools(root)
        return { protocolComplete: true }
    }
    if (name === 'reload-restores-tools') {
        await manager.connect('fake')
        const before = root.tools.get('mcp__fake__echo')
        await manager.reload('fake')
        const after = root.tools.get('mcp__fake__echo')
        const result = await root.tools.execute('mcp__fake__echo', {})
        state.serverStates.fake = manager.get('fake').state
        state.reloadCreatedNewFiber = before !== after
        state.healthyServerUsable = !result.isError && result.value === 'fake echo'
        state.registeredToolNames = listTools(root)
        state.toolRegistrationCount = state.registeredToolNames.filter(
            (tool) => tool === 'mcp__fake__echo',
        ).length
        return { protocolComplete: true }
    }
    if (name === 'cleanup-failure-retry') return runCleanupRetry(state, manager)
    if (name === 'reload-cleanup-failure') return runReloadCleanupFailure(state, manager)
    if (name === 'manager-dispose-partial-failure') return runManagerDisposePartial(state, manager)
    if (name === 'stale-schema-after-disconnect') return runAgentCase(state, root, 'stale')
    if (name === 'active-plugin-tool-execution-failure')
        return runAgentCase(state, root, 'unstable')
    throw new Error(`unknown MCP Eval case: ${name}`)
}

async function runAgentCase(state, root, mode) {
    await root.mcp.connect(mode === 'stale' ? 'fake' : 'unstable')
    const sessions = new SessionRuntime()
    const session = await sessions.create()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const trace = new CapturingTraceRuntime()
    const requests = []
    let turn = 0
    llm.register(
        'mcp-eval',
        {
            models: ['deterministic'],
            async chat(request) {
                turn += 1
                requests.push(structuredClone(request))
                if (turn === 1) {
                    if (mode === 'stale') {
                        state.staleSchemaVisible = request.tools.some(
                            (tool) => tool.function.name === 'mcp__fake__echo',
                        )
                        await root.mcp.disconnect('fake')
                    }
                    return {
                        toolCalls: [
                            {
                                id: 'call-1',
                                name: mode === 'stale' ? 'mcp__fake__echo' : 'mcp__unstable__query',
                                arguments: {},
                            },
                        ],
                    }
                }
                const toolMessage = request.messages.find((message) => message.role === 'tool')
                state.toolFailure = toolMessage?.content ?? null
                state.modelSawToolFailure =
                    Boolean(toolMessage) &&
                    String(toolMessage.content).includes(
                        mode === 'stale' ? 'Unknown tool' : 'remote MCP unavailable',
                    )
                return { content: 'fallback completed', toolCalls: [] }
            },
        },
        { defaultModel: 'deterministic' },
    )
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt: new SystemPromptRuntime(),
        tools: root.tools.runtime,
        llm,
        trace,
    })
    const agent = agents.create({ sessionId: session.id, model: 'mcp-eval/deterministic', loop })
    await agent.send('run')
    const events = sessions.get(session.id).events
    const toolResult = events.find((event) => event.type === 'tool/result')
    if (mode === 'stale')
        state.staleToolReturnedUnknown = toolResult?.data?.errorCode === 'unknown_tool'
    state.toolErrorCode = toolResult?.data?.errorCode ?? null
    state.toolIsError = toolResult?.data?.isError ?? false
    state.serverStates[mode === 'stale' ? 'fake' : 'unstable'] = root.mcp.get(
        mode === 'stale' ? 'fake' : 'unstable',
    ).state
    state.registeredToolNames = listTools(root)
    return { trace: trace.latest(), requests, events, protocolComplete: protocolComplete(events) }
}

function createHarnessManager(name, state) {
    const tools = new ToolRuntime()
    const activator = async (definition) => {
        state.activationAttempts += 1
        const toolName = `mcp__${definition.name}__tool`
        const unregister = tools.register({ name: toolName, execute: async () => 'ok' })
        let disposed = false
        return {
            async dispose() {
                state.disposalAttempts += 1
                if (
                    !disposed &&
                    ((name === 'cleanup-failure-retry' && state.disposalAttempts === 1) ||
                        (name === 'reload-cleanup-failure' && state.disposalAttempts === 1) ||
                        (name === 'manager-dispose-partial-failure' &&
                            definition.name === 'server-b' &&
                            state.disposalAttempts === 2))
                ) {
                    throw new Error('cleanup failed')
                }
                disposed = true
                unregister()
            },
        }
    }
    const created = new McpManager({ activate: activator })
    const names = name === 'manager-dispose-partial-failure' ? ['server-a', 'server-b'] : [name]
    for (const server of names) created.register({ name: server })
    state.tools = tools
    return created
}

async function runCleanupRetry(state, manager) {
    await manager.connect('cleanup-failure-retry')
    await assertRejects(() => manager.disconnect('cleanup-failure-retry'))
    state.serverStates.first = manager.get('cleanup-failure-retry').state
    await manager.disconnect('cleanup-failure-retry')
    state.serverStates.second = manager.get('cleanup-failure-retry').state
    state.registeredToolNames = state.tools.list().map((tool) => tool.name)
    state.cleanupRetried = state.disposalAttempts === 2
    return { protocolComplete: true }
}

async function runReloadCleanupFailure(state, manager) {
    await manager.connect('reload-cleanup-failure')
    await assertRejects(() => manager.reload('reload-cleanup-failure'))
    state.serverStates.first = manager.get('reload-cleanup-failure').state
    state.registeredToolNames = state.tools.list().map((tool) => tool.name)
    state.oldToolRetained = state.registeredToolNames.includes('mcp__reload-cleanup-failure__tool')
    state.toolRegistrationCount = state.registeredToolNames.filter(
        (name) => name === 'mcp__reload-cleanup-failure__tool',
    ).length
    state.reloadCreatedNewFiber = state.activationAttempts > 1
    return { protocolComplete: true }
}

async function runManagerDisposePartial(state, manager) {
    await manager.connect('server-a')
    await manager.connect('server-b')
    await assertRejects(() => manager.dispose())
    state.serverStates.afterFirstDispose = Object.fromEntries(
        manager.list().map((item) => [item.name, item.state]),
    )
    state.registeredToolNamesAfterFirstDispose = state.tools.list().map((tool) => tool.name)
    await manager.dispose()
    state.serverStates.afterSecondDispose = Object.fromEntries(
        manager.list().map((item) => [item.name, item.state]),
    )
    state.finalManagerDisposed = manager.list().length === 0
    state.registeredToolNames = state.tools.list().map((tool) => tool.name)
    state.cleanupRetried = state.disposalAttempts === 3
    return { protocolComplete: true }
}

function listTools(root) {
    return root ? root.tools.list().map((tool) => tool.name) : []
}

function protocolComplete(events) {
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    return (
        calls.every(
            (call) => results.filter((event) => event.data.toolCallId === call.id).length === 1,
        ) && results.every((event) => calls.some((call) => call.id === event.data.toolCallId))
    )
}

async function assertRejects(operation) {
    let rejected = false
    try {
        await operation()
    } catch {
        rejected = true
    }
    if (!rejected) throw new Error('expected operation to reject')
}
