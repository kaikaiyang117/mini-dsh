import { readdirSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { CostEstimator, pricingFromEnv } from '../../src/core/cost-estimator.js'
import { DeterministicToolVisibility } from '../../src/core/deterministic-tool-visibility.js'
import { SemanticProgressDetector } from '../../src/core/semantic-progress-detector.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { ToolCatalog } from '../../src/core/tool-catalog.js'
import { AllToolsVisibility } from '../../src/core/tool-visibility.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'
import * as deepseekPlugin from '../../src/models/deepseek.js'
import * as llmPlugin from '../../src/plugins/llm.js'
import * as sandboxPlugin from '../../src/plugins/sandbox.js'
import * as systemPromptPlugin from '../../src/plugins/system-prompt.js'
import * as toolsPlugin from '../../src/plugins/tools.js'
import * as bashPlugin from '../../src/tools/bash.js'
import * as filesPlugin from '../../src/tools/files.js'

export const TEST_COMMAND = 'env -u NODE_TEST_CONTEXT node --test calculator.test.js'
const SOURCE = `export function clamp(value, min, max) {
    return Math.min(min, Math.max(max, value))
}
`
const TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { clamp } from './calculator.js'

test('clamp stays within the range', () => {
    assert.equal(clamp(5, 0, 10), 5)
    assert.equal(clamp(-2, 0, 10), 0)
    assert.equal(clamp(12, 0, 10), 10)
})
`
const INITIAL_FILES = Object.freeze({ 'calculator.js': SOURCE, 'calculator.test.js': TEST })

export async function createCodingFixture({
    variant,
    model,
    limits = {},
    registerProvider = (root) => root.plugin(deepseekPlugin),
    pricing = pricingFromEnv(process.env.MINI_DSH_PRICING_JSON),
}) {
    if (!['minimal', 'full'].includes(variant))
        throw new TypeError(`unknown coding variant: ${variant}`)
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-benchmark-'))
    const root = new Context()
    let sessions
    try {
        for (const [name, content] of Object.entries(INITIAL_FILES)) {
            await fs.writeFile(path.join(workspace, name), content, 'utf8')
        }
        await root.plugin(systemPromptPlugin)
        await root.plugin(toolsPlugin)
        await root.plugin(llmPlugin)
        await root.plugin(sandboxPlugin, { workspace, autoApprove: true })
        await root.plugin(bashPlugin, { timeoutMs: 10_000, maxOutput: 8_000 })
        await root.plugin(filesPlugin)
        await registerProvider(root)
        if (!root.llm.has(model)) throw new TypeError(`model is not registered: ${model}`)

        root.systemPrompt.section({
            name: 'benchmark-workspace',
            order: 20,
            text: [
                'Work only inside the benchmark workspace.',
                'Do not access network, HOME or external paths.',
                'Use search and read tools to inspect files. Edit only calculator.js.',
                `The only allowed bash command is: ${TEST_COMMAND}`,
                'Run the tests before and after the fix; finish only after a passing test result.',
            ].join('\n'),
        })

        sessions = new SessionRuntime()
        const session = await sessions.create({ source: 'coding-benchmark' })
        const tools = restrictCodingTools(root.tools)
        const requestMeter = new RecordingTokenMeter()
        const trace = new CapturingTraceRuntime()
        const contextManager = new ContextManager({
            sessions,
            policy:
                variant === 'minimal'
                    ? { maxContextTokens: null }
                    : { maxContextTokens: 9000, reservedOutputTokens: 500, compactAtRatio: 0.65 },
        })
        const loop = new AgentLoopRuntime({
            sessions,
            systemPrompt: root.systemPrompt,
            tools,
            llm: {
                chat(request, selection) {
                    requestMeter.estimateRequest(request)
                    return root.llm.chat(request, selection)
                },
            },
            trace,
            contextManager,
            costEstimator: new CostEstimator({ pricing }),
            policy: { maxSteps: 16, maxToolCalls: 24, maxDurationMs: 120_000, ...limits },
            toolCatalog: new ToolCatalog({ tools }),
            toolVisibility:
                variant === 'minimal'
                    ? new AllToolsVisibility()
                    : new DeterministicToolVisibility({
                          maxVisibleTools: 4,
                          noMatchFallback: 'all',
                      }),
            progressDetectorFactory:
                variant === 'full'
                    ? () => new SemanticProgressDetector({ softThreshold: 2, hardThreshold: 5 })
                    : undefined,
        })
        const agent = new AgentRuntime().create({ sessionId: session.id, model, loop })
        return {
            agent,
            trace,
            recordingTokenMeter: requestMeter,
            inspectors: { workspace, session, initialFiles: INITIAL_FILES },
            async dispose() {
                try {
                    await sessions.dispose()
                } finally {
                    try {
                        await root.fiber.dispose()
                    } finally {
                        await fs.rm(workspace, { recursive: true, force: true })
                    }
                }
            },
        }
    } catch (error) {
        try {
            await sessions?.dispose()
        } finally {
            try {
                await root.fiber.dispose()
            } finally {
                await fs.rm(workspace, { recursive: true, force: true })
            }
        }
        throw error
    }
}

function restrictCodingTools(runtime) {
    const allowed = new Set(['bash', 'read_file', 'edit_file', 'glob', 'grep'])
    const blocked = (message) => ({
        value: null,
        content: [{ type: 'text', text: `ToolError: ${message}` }],
        isError: true,
        errorCode: 'execution_error',
    })
    return {
        get: (name) => (allowed.has(name) ? runtime.get(name) : undefined),
        list: () => runtime.list().filter(({ name }) => allowed.has(name)),
        schemas: () => runtime.schemas().filter((schema) => allowed.has(schema.function.name)),
        renderResult: (result) => runtime.renderResult(result),
        execute(name, args, exec) {
            if (!allowed.has(name)) return Promise.resolve(blocked('tool unavailable in benchmark'))
            if (name === 'bash' && args?.command !== TEST_COMMAND) {
                return Promise.resolve(blocked(`only ${TEST_COMMAND} is allowed`))
            }
            if (name === 'edit_file' && args?.path !== 'calculator.js') {
                return Promise.resolve(blocked('only calculator.js may be edited'))
            }
            return runtime.execute(name, args, exec)
        },
    }
}

export function scoreCodingSmoke({ trace, fixture }) {
    const { workspace, session, initialFiles } = fixture.inspectors
    const calls = session.events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls)
    const results = session.events.filter((event) => event.type === 'tool/result')
    const counts = new Map()
    for (const result of results) {
        const id = result.data.toolCallId
        counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const callIds = new Set(calls.map((call) => call.id))
    const protocolComplete =
        callIds.size === calls.length &&
        results.length === calls.length &&
        results.every((result) => callIds.has(result.data.toolCallId)) &&
        calls.every((call) => counts.get(call.id) === 1)
    const filesRead = [
        ...new Set(
            calls
                .filter(
                    (call) =>
                        call.name === 'read_file' &&
                        results.some(
                            (result) => result.data.toolCallId === call.id && !result.data.isError,
                        ),
                )
                .map((call) => call.arguments.path),
        ),
    ].sort()
    const searchUsed = calls.some(
        (call) =>
            (call.name === 'grep' || call.name === 'glob') &&
            results.some((result) => result.data.toolCallId === call.id && !result.data.isError),
    )
    const finalFiles = Object.fromEntries(
        readdirSync(workspace).map((name) => [
            name,
            readFileSync(path.join(workspace, name), 'utf8'),
        ]),
    )
    const filesModified = [...new Set([...Object.keys(initialFiles), ...Object.keys(finalFiles)])]
        .filter((name) => initialFiles[name] !== finalFiles[name])
        .sort()
    const unexpectedFiles = filesModified.filter((name) => name !== 'calculator.js')
    const bashResults = results
        .filter((event) => event.data.name === 'bash' && !event.data.isError)
        .map((event) => {
            try {
                return JSON.parse(event.data.content)
            } catch {
                return null
            }
        })
        .filter((value) => value?.command === TEST_COMMAND && value.cwd === workspace)
    const firstEdit = session.events.findIndex(
        (event) =>
            event.type === 'tool/result' && event.data.name === 'edit_file' && !event.data.isError,
    )
    const firstTest = session.events.findIndex(
        (event) =>
            event.type === 'tool/result' && event.data.name === 'bash' && !event.data.isError,
    )
    const initialTestsFailed =
        firstTest >= 0 && firstEdit > firstTest && bashResults[0]?.exitCode !== 0
    const finalTestsPassed = bashResults.length >= 2 && bashResults.at(-1)?.exitCode === 0
    const targetCorrect =
        finalFiles['calculator.js']?.includes('return Math.max(min, Math.min(max, value))') &&
        !finalFiles['calculator.js']?.includes('return Math.min(min, Math.max(max, value))')
    const success =
        trace.stopReason === 'completed' &&
        protocolComplete &&
        searchUsed &&
        filesRead.includes('calculator.js') &&
        filesRead.includes('calculator.test.js') &&
        initialTestsFailed &&
        finalTestsPassed &&
        targetCorrect &&
        filesModified.includes('calculator.js') &&
        unexpectedFiles.length === 0
    return {
        success,
        details: {
            filesRead,
            filesModified,
            unexpectedFiles,
            initialTestsFailed,
            finalTestsPassed,
            protocolComplete,
        },
    }
}
