import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { JsonlSessionStore, validateSessionId } from '../src/core/jsonl-session-store.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { MemorySessionStore } from '../src/core/memory-session-store.js'
import { SessionCorruptionError } from '../src/core/session-recovery.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

async function withDirectory(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mini-dsh-session-'))
    try {
        return await callback(directory)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

function sessionFile(directory, id) {
    return path.join(directory, id, 'session.jsonl')
}

test('MemorySessionStore is a storage-only async backend', async () => {
    const store = new MemorySessionStore()
    const sessions = new SessionRuntime({ store })
    const session = await sessions.create({ source: 'unit' })

    await sessions.append(session.id, 'custom/event', { value: 1 })
    const reopened = await store.open(session.id)

    assert.equal(reopened.events.at(-1).type, 'custom/event')
    assert.equal(reopened.events.at(-1).data.value, 1)
})

test('Jsonl create, restart, resume, list, flush, close and dispose', async () => {
    await withDirectory(async (directory) => {
        const first = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await first.create({ source: 'integration' })
        await first.append(session.id, 'user/message', { content: 'hello' })
        await first.flush(session.id)
        await first.close(session.id)

        const second = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const resumed = await second.open(session.id)
        assert.equal(resumed.id, session.id)
        assert.deepEqual(second.deriveMessages(session.id), [{ role: 'user', content: 'hello' }])
        const listing = await second.list()
        assert.deepEqual(
            listing.map((item) => item.id),
            [session.id],
        )
        assert.equal(listing[0].eventCount, 2)
        assert.ok(listing[0].createdAt)
        assert.ok(listing[0].updatedAt)
        await second.dispose()
    })
})

test('SessionRuntime.list is read-only and does not hydrate or recover sessions', async () => {
    await withDirectory(async (directory) => {
        const first = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await first.create()
        await first.append(session.id, 'assistant/tool_calls', {
            toolCalls: [{ id: 'call-1', name: 'unknown_tool', arguments: {} }],
        })
        await first.dispose()

        const file = sessionFile(directory, session.id)
        const before = await readFile(file)
        const restarted = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })

        const listing = await restarted.list()
        const after = await readFile(file)
        assert.deepEqual(after, before)
        assert.equal(listing[0].eventCount, 2)
        assert.throws(() => restarted.get(session.id), /not open/)
        assert.deepEqual(
            (await readFile(file, 'utf8'))
                .trimEnd()
                .split('\n')
                .map((line) => JSON.parse(line).type),
            ['session/start', 'assistant/tool_calls'],
        )
        await restarted.dispose()
    })
})

test('multiple sessions stay isolated and append writes are serialized per session', async () => {
    await withDirectory(async (directory) => {
        const store = new JsonlSessionStore({ directory })
        const sessions = new SessionRuntime({ store })
        const first = await sessions.create({ name: 'first' })
        const second = await sessions.create({ name: 'second' })

        await Promise.all([
            sessions.append(first.id, 'custom/a', { value: 'a' }),
            sessions.append(first.id, 'custom/b', { value: 'b' }),
        ])
        await sessions.append(second.id, 'custom/only', { value: 'second' })

        assert.deepEqual(
            sessions.get(first.id).events.map((event) => event.seq),
            [1, 2, 3],
        )
        assert.deepEqual(sessions.deriveMessages(second.id), [])
        const secondEvents = await store.open(second.id)
        assert.equal(secondEvents.events.at(-1).data.value, 'second')
        await store.dispose()
    })
})

test('torn final JSONL line is truncated at a Buffer byte offset', async () => {
    await withDirectory(async (directory) => {
        const first = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await first.create({ label: '中文元数据' })
        await first.append(session.id, 'user/message', { content: '你好，持久化' })
        const file = sessionFile(directory, session.id)
        const validPrefix = await readFile(file)
        await appendFile(
            file,
            Buffer.from('{"seq":3,"type":"user/message","data":{"content":"未完', 'utf8'),
        )

        const second = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        await second.open(session.id)

        assert.deepEqual(await readFile(file), validPrefix)
        assert.deepEqual(second.deriveMessages(session.id), [
            { role: 'user', content: '你好，持久化' },
        ])
        await second.dispose()
    })
})

test('middle JSONL corruption throws SessionCorruptionError', async () => {
    await withDirectory(async (directory) => {
        const sessions = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await sessions.create()
        await sessions.append(session.id, 'custom/one', { value: 1 })
        await sessions.append(session.id, 'custom/two', { value: 2 })
        const file = sessionFile(directory, session.id)
        const lines = (await readFile(file, 'utf8')).split('\n')
        lines.splice(1, 0, 'not-json')
        await writeFile(file, lines.join('\n'), 'utf8')

        const restarted = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        await assert.rejects(
            () => restarted.open(session.id),
            (error) => error instanceof SessionCorruptionError,
        )
    })
})

test('JSONL sequence gaps are rejected even when every line is valid JSON', async () => {
    await withDirectory(async (directory) => {
        const sessions = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await sessions.create()
        await sessions.append(session.id, 'custom/one', { value: 1 })
        const file = sessionFile(directory, session.id)
        const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
        const event = JSON.parse(lines.at(-1))
        event.seq = 4
        lines[lines.length - 1] = JSON.stringify(event)
        await writeFile(file, `${lines.join('\n')}\n`, 'utf8')

        const restarted = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        await assert.rejects(
            () => restarted.open(session.id),
            (error) =>
                error instanceof SessionCorruptionError && /sequence gap/i.test(error.message),
        )
    })
})

test('interrupted tool calls recover as unknown results without automatic retry', async () => {
    await withDirectory(async (directory) => {
        const first = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await first.create()
        await first.append(session.id, 'assistant/tool_calls', {
            runId: 'run-1',
            stepId: 'step-1',
            toolCalls: [{ id: 'call-1', name: 'side_effect', arguments: {} }],
        })
        await first.dispose()

        const sessions = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        await sessions.open(session.id)
        const recovered = sessions.get(session.id).events.at(-1)
        assert.equal(recovered.type, 'tool/result')
        assert.equal(recovered.data.outcome, 'unknown')
        assert.equal(recovered.data.retryable, false)
        assert.match(recovered.data.content, /actual outcome is unknown/i)

        const tools = new ToolRuntime()
        let toolCalls = 0
        tools.register({
            name: 'side_effect',
            description: 'side effect',
            parameters: { type: 'object' },
            execute: async () => {
                toolCalls += 1
                return 'must not run'
            },
        })
        const llm = new LlmRuntime()
        let modelCalls = 0
        llm.register(
            'mock',
            {
                models: ['resume'],
                async chat({ messages }) {
                    modelCalls += 1
                    assert.ok(messages.some((message) => message.role === 'tool'))
                    return { content: 'continued', toolCalls: [] }
                },
            },
            { defaultModel: 'resume' },
        )
        const agents = new AgentRuntime()
        const loop = new AgentLoopRuntime({
            sessions,
            systemPrompt: new SystemPromptRuntime(),
            tools,
            llm,
        })
        const agent = agents.create({ sessionId: session.id, model: 'mock/resume', loop })
        assert.equal(await agent.send('continue'), 'continued')
        assert.equal(modelCalls, 1)
        assert.equal(toolCalls, 0)
        await sessions.dispose()
    })
})

test('reset is append-only and projects only events after the last reset', async () => {
    await withDirectory(async (directory) => {
        const first = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        const session = await first.create()
        await first.append(session.id, 'user/message', { content: 'old' })
        await first.reset(session.id)
        await first.append(session.id, 'user/message', { content: 'new' })
        assert.deepEqual(first.deriveMessages(session.id), [{ role: 'user', content: 'new' }])
        assert.equal(first.get(session.id).events[1].data.content, 'old')
        assert.equal(first.get(session.id).events[2].type, 'session/reset')
        await first.dispose()

        const restarted = new SessionRuntime({
            store: new JsonlSessionStore({ directory }),
        })
        await restarted.open(session.id)
        assert.deepEqual(restarted.deriveMessages(session.id), [{ role: 'user', content: 'new' }])
        assert.equal(restarted.get(session.id).events.length, 4)
        await restarted.dispose()
    })
})

test('session ids reject traversal and absolute paths', () => {
    for (const id of ['../escape', '/tmp/escape', 'a/b', '', '.', '..']) {
        assert.throws(() => validateSessionId(id), /unsafe session id/)
    }
})
