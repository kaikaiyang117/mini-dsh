import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as agents from '../src/plugins/agents.js'
import * as externalPlugins from '../src/plugins/external-plugins.js'
import * as llm from '../src/plugins/llm.js'
import * as runtimeContext from '../src/plugins/runtime-context.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as sessions from '../src/plugins/sessions.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as trace from '../src/plugins/trace.js'
import * as bash from '../src/tools/bash.js'
import * as files from '../src/tools/files.js'

function runCli(directory, commands) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['src/index.js'], {
            cwd: path.resolve('.'),
            env: {
                ...process.env,
                MINI_DSH_SESSION_DIR: directory,
                MINI_DSH_MODEL: 'deepseek/deepseek-v4-pro',
                DEEPSEEK_API_KEY: '',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGTERM')
            reject(new Error(`CLI integration test timed out\n${stdout}${stderr}`))
        }, 15_000)

        child.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.once('error', (error) => {
            clearTimeout(timer)
            if (!settled) {
                settled = true
                reject(error)
            }
        })
        child.once('close', (code) => {
            clearTimeout(timer)
            if (settled) return
            settled = true
            if (code !== 0) reject(new Error(`CLI exited with ${code}\n${stdout}${stderr}`))
            else resolve(stdout + stderr)
        })

        ;(async () => {
            const startedAt = Date.now()
            while (!stdout.includes('User > ')) {
                if (Date.now() - startedAt > 10_000) {
                    throw new Error(`CLI prompt did not appear\n${stdout}${stderr}`)
                }
                await new Promise((resolveReady) => setTimeout(resolveReady, 100))
            }
            for (const command of commands) {
                child.stdin.write(`${command}\n`)
                await new Promise((resolveReady) => setTimeout(resolveReady, 400))
            }
        })().catch(reject)
    })
}

/**
 * Boots the same plugin stack as src/index.js (minus the CLI) on a real
 * Cordis Context and verifies the wiring, not just the runtimes in isolation.
 * A mock provider stands in for DeepSeek so no network or API key is needed.
 */
test('the whole plugin stack boots on Cordis and runs a full model -> tool -> model turn', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-smoke-'))
    const traceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-smoke-'))
    const root = new Context()

    try {
        await root.plugin(sessions)
        await root.plugin(systemPrompt)
        await root.plugin(tools)
        await root.plugin(llm)
        await root.plugin(trace, { directory: traceDirectory })
        await root.plugin(agents)
        await root.plugin(agentLoop)
        await root.plugin(runtimeContext, { workspace })
        await root.plugin(sandbox, { workspace, autoApprove: true })
        await root.plugin(bash, { workspace })
        await root.plugin(files, { workspace })

        // Services were registered by plugins, not constructed by hand.
        assert.ok(root.sessions)
        assert.ok(root.systemPrompt)
        assert.ok(root.tools)
        assert.ok(root.llm)
        assert.ok(root.agents)
        assert.ok(root.agentLoop)
        assert.ok(root.traceRuntime)
        assert.ok(root.sandbox)

        // ctx.effect-based registrations from runtime-context/sandbox/tools all ran.
        const toolNames = root.tools
            .list()
            .map((tool) => tool.name)
            .sort()
        assert.deepEqual(toolNames, [
            'bash',
            'edit_file',
            'glob',
            'grep',
            'read_file',
            'write_file',
        ])

        const prompt = await root.systemPrompt.assemble({ step: 0 })
        assert.match(prompt, /You are a general-purpose agent/)
        assert.match(prompt, /## Runtime Context/)
        assert.match(prompt, /## Sandbox/)
        assert.match(prompt, new RegExp(workspace))

        let calls = 0
        root.llm.register(
            'mock',
            {
                models: ['smoke'],
                async chat({ system, messages, tools: schemas }) {
                    calls += 1
                    if (calls === 1) {
                        // Tool schemas reach the provider through the loop's ctx.tools.schemas().
                        assert.ok(schemas.some((tool) => tool.function?.name === 'bash'))
                        assert.ok(system.includes('Runtime Context'))
                        return {
                            toolCalls: [{ id: 't1', name: 'bash', arguments: { command: 'pwd' } }],
                        }
                    }
                    const toolMessage = messages.at(-1)
                    assert.equal(toolMessage.role, 'tool')
                    assert.match(toolMessage.content, /mini-dsh-smoke/)
                    return { content: 'done', toolCalls: [] }
                },
            },
            { defaultModel: 'smoke' },
        )

        assert.equal(root.llm.defaultSelection(), 'mock/smoke')
        assert.deepEqual(root.llm.models(), ['mock/smoke'])

        const session = await root.sessions.create({ source: 'smoke' })
        const agent = root.agents.create({
            name: 'smoke',
            sessionId: session.id,
            model: 'mock/smoke',
            loop: root.agentLoop,
        })

        const answer = await agent.send('print the working directory')
        assert.equal(answer, 'done')
        assert.equal(calls, 2)

        const traceFiles = await fs.readdir(traceDirectory)
        assert.equal(traceFiles.length, 1)
        const runTrace = JSON.parse(
            await fs.readFile(path.join(traceDirectory, traceFiles[0]), 'utf8'),
        )
        assert.equal(runTrace.sessionId, session.id)
        assert.equal(runTrace.stopReason, 'completed')
        assert.equal(runTrace.steps.length, 2)
        assert.equal(runTrace.steps[0].toolCalls[0].toolCallId, 't1')

        const types = root.sessions.get(session.id).events.map((event) => event.type)
        assert.deepEqual(types, [
            'session/start',
            'user/message',
            'assistant/tool_calls',
            'tool/result',
            'assistant/message',
        ])
    } finally {
        await root.fiber.dispose()
        await fs.rm(workspace, { recursive: true, force: true })
        await fs.rm(traceDirectory, { recursive: true, force: true })
    }
})

test('external plugin loader tolerates an optional failure and enforces a required one', async () => {
    const root = new Context()
    const originalLog = console.log
    const originalError = console.error
    const entries = [{ package: 'mini-dsh-definitely-not-installed', required: false }]

    console.log = () => {}
    console.error = () => {}
    try {
        // Optional entry: the host keeps booting and only logs a failure.
        await root.plugin(externalPlugins, { entries })

        // Required entry: apply() rethrows and the plugin load fails loudly.
        // ctx.plugin() returns a Fiber (not a Promise), so await it first.
        await assert.rejects(async () => {
            await root.plugin(externalPlugins, {
                entries: [{ ...entries[0], required: true }],
            })
        })
    } finally {
        console.log = originalLog
        console.error = originalError
        await root.fiber.dispose()
    }
})

test('AgentLoop remains usable when the optional trace plugin is not loaded', async () => {
    const root = new Context()

    try {
        await root.plugin(sessions)
        await root.plugin(systemPrompt)
        await root.plugin(tools)
        await root.plugin(llm)
        await root.plugin(agents)
        await root.plugin(agentLoop)

        assert.ok(root.agentLoop)
        root.llm.register(
            'mock',
            {
                models: ['no-trace'],
                async chat() {
                    return { content: 'ok', toolCalls: [] }
                },
            },
            { defaultModel: 'no-trace' },
        )
        const session = await root.sessions.create()
        const agent = root.agents.create({
            sessionId: session.id,
            model: 'mock/no-trace',
            loop: root.agentLoop,
        })

        assert.equal(await agent.send('without trace'), 'ok')
        assert.match(session.events[1].data.runId, /^[0-9a-f-]{36}$/)
    } finally {
        await root.fiber.dispose()
    }
})

test('CLI can create, list, and resume durable sessions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-cli-session-'))
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[4-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi

    try {
        const firstOutput = await runCli(directory, ['/sessions', '/new', '/sessions', '/exit'])
        const firstIds = [...new Set(firstOutput.match(uuidPattern) ?? [])]
        assert.equal(firstIds.length, 1, firstOutput)
        assert.match(firstOutput, /New session:/)
        assert.equal((await fs.readdir(directory)).length, 1)
        const sessionFile = path.join(directory, firstIds[0], 'session.jsonl')
        const beforeResume = await fs.readFile(sessionFile)

        const resumedOutput = await runCli(directory, [
            `/resume ${firstIds[0]}`,
            '/sessions',
            '/exit',
        ])
        assert.match(resumedOutput, new RegExp(`Resumed session: ${firstIds[0]}`))
        assert.match(resumedOutput, new RegExp(firstIds[0]))
        assert.equal((await fs.readdir(directory)).length, 1)
        assert.deepEqual(await fs.readFile(sessionFile), beforeResume)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})
