import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { SessionRunCoordinator } from '../src/core/session-run-coordinator.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate) {
    for (let attempts = 0; attempts < 100; attempts += 1) {
        if (predicate()) return
        await tick()
    }
    throw new Error('condition did not become true')
}

function deferred() {
    let resolve
    const promise = new Promise((res) => {
        resolve = res
    })
    return { promise, resolve }
}

test('same-session runs are FIFO and the queued run waits for the first', async () => {
    const coordinator = new SessionRunCoordinator()
    const first = deferred()
    const events = []

    const runA = coordinator.run('session-a', async () => {
        events.push('start A')
        await first.promise
        events.push('finish A')
        return 'A'
    })
    const runB = coordinator.run('session-a', async () => {
        events.push('start B')
        events.push('finish B')
        return 'B'
    })

    await waitFor(() => events.length === 1)
    assert.deepEqual(events, ['start A'])
    first.resolve()

    assert.deepEqual(await Promise.all([runA, runB]), ['A', 'B'])
    assert.deepEqual(events, ['start A', 'finish A', 'start B', 'finish B'])
})

test('same-session submissions preserve FIFO order', async () => {
    const coordinator = new SessionRunCoordinator()
    const events = []

    const results = await Promise.all(
        ['A', 'B', 'C'].map((name) =>
            coordinator.run('session-a', async () => {
                events.push(`start ${name}`)
                await tick()
                events.push(`finish ${name}`)
                return name
            }),
        ),
    )

    assert.deepEqual(results, ['A', 'B', 'C'])
    assert.deepEqual(events, ['start A', 'finish A', 'start B', 'finish B', 'start C', 'finish C'])
})

test('different sessions can execute concurrently', async () => {
    const coordinator = new SessionRunCoordinator()
    const first = deferred()
    const events = []

    const runA = coordinator.run('session-a', async () => {
        events.push('start A')
        await first.promise
        events.push('finish A')
    })
    const runB = coordinator.run('session-b', async () => {
        events.push('start B')
        events.push('finish B')
    })

    await waitFor(() => events.includes('finish B'))
    assert.deepEqual(events, ['start A', 'start B', 'finish B'])
    first.resolve()
    await Promise.all([runA, runB])
})

test('a rejected run does not poison the same-session queue', async () => {
    const coordinator = new SessionRunCoordinator()
    const original = new Error('run A failed')
    const runA = coordinator.run('session-a', async () => {
        throw original
    })
    const runB = coordinator.run('session-a', async () => 'B succeeded')

    await assert.rejects(runA, (error) => error === original)
    assert.equal(await runB, 'B succeeded')
})

test('settled session queues are cleaned up without removing a newer queued tail', async () => {
    const coordinator = new SessionRunCoordinator()
    const first = deferred()
    const second = deferred()
    const runA = coordinator.run('session-a', () => first.promise)
    const runB = coordinator.run('session-a', async () => {
        await second.promise
        return 'B'
    })

    assert.equal(coordinator.pendingSessions(), 1)
    first.resolve('A')
    await waitFor(() => coordinator.pendingSessions() === 1)
    second.resolve()
    assert.deepEqual(await Promise.all([runA, runB]), ['A', 'B'])
    assert.equal(coordinator.pendingSessions(), 0)

    await coordinator.run('session-a', async () => 'C')
    assert.equal(coordinator.pendingSessions(), 0)
})

test('AgentLoop serializes same-session sends while preserving intra-run behavior', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    const first = deferred()
    let calls = 0

    const llm = {
        async chat() {
            calls += 1
            if (calls === 1) await first.promise
            return { content: `answer-${calls}`, toolCalls: [] }
        },
    }
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm })
    const agentA = agents.create({ sessionId: session.id, model: 'mock/model', loop })
    const agentB = agents.create({ sessionId: session.id, model: 'mock/model', loop })

    const runA = agentA.send('A')
    await waitFor(() => calls === 1)
    const runB = agentB.send('B')
    await tick()

    assert.equal(calls, 1)
    assert.deepEqual(
        sessions.get(session.id).events.map((event) => event.data.content),
        [undefined, 'A'],
    )

    first.resolve()
    assert.deepEqual(await Promise.all([runA, runB]), ['answer-1', 'answer-2'])
    assert.deepEqual(
        sessions
            .get(session.id)
            .events.filter(
                (event) => event.type === 'user/message' || event.type === 'assistant/message',
            )
            .map((event) => event.data.content),
        ['A', 'answer-1', 'B', 'answer-2'],
    )
})

test('different agents sharing one session are serialized by sessionId', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    const first = deferred()
    let calls = 0
    const llm = {
        async chat() {
            calls += 1
            if (calls === 1) await first.promise
            return { content: `answer-${calls}`, toolCalls: [] }
        },
    }
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm })
    const agentA = agents.create({ sessionId: session.id, model: 'mock/model', loop })
    const agentB = agents.create({ sessionId: session.id, model: 'mock/model', loop })

    const runA = agentA.send('from A')
    await waitFor(() => calls === 1)
    const runB = agentB.send('from B')
    await tick()
    assert.equal(calls, 1)

    first.resolve()
    await Promise.all([runA, runB])
    assert.deepEqual(
        sessions
            .get(session.id)
            .events.filter((event) => event.type === 'user/message')
            .map((event) => event.data.content),
        ['from A', 'from B'],
    )
})

test('different sessions enter the LLM concurrently', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const agents = new AgentRuntime()
    const sessionA = await sessions.create()
    const sessionB = await sessions.create()
    const entered = []
    const release = deferred()
    const llm = {
        async chat() {
            entered.push(true)
            await release.promise
            return { content: 'done', toolCalls: [] }
        },
    }
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm })
    const agentA = agents.create({ sessionId: sessionA.id, model: 'mock/model', loop })
    const agentB = agents.create({ sessionId: sessionB.id, model: 'mock/model', loop })

    const runA = agentA.send('A')
    const runB = agentB.send('B')
    await waitFor(() => entered.length === 2)
    assert.equal(entered.length, 2)

    release.resolve()
    assert.deepEqual(await Promise.all([runA, runB]), ['done', 'done'])
})
