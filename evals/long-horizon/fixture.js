import { readdirSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { DeterministicToolVisibility } from '../../src/core/deterministic-tool-visibility.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { SemanticProgressDetector } from '../../src/core/semantic-progress-detector.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { TokenMeter } from '../../src/core/token-meter.js'
import { ToolCatalog } from '../../src/core/tool-catalog.js'
import { AllToolsVisibility } from '../../src/core/tool-visibility.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'
import * as sandboxPlugin from '../../src/plugins/sandbox.js'
import * as systemPromptPlugin from '../../src/plugins/system-prompt.js'
import * as toolsPlugin from '../../src/plugins/tools.js'
import * as bashPlugin from '../../src/tools/bash.js'
import * as filesPlugin from '../../src/tools/files.js'

const EXPECTED_PATCHES = Object.freeze({
    clampBefore: 'return Math.min(min, Math.max(max, value))',
    clampAfter: 'return Math.max(min, Math.min(max, value))',
    retryBefore: 'const retries = 1',
    retryAfter: 'const retries = DEFAULT_RETRIES',
})
const MODEL = 'long-horizon-mock/deterministic'
const TEST_COMMAND = 'node --test --test-reporter=./test/eval-reporter.js'
const MAX_VISIBLE_TOOLS = 8
const POLICY = Object.freeze({ maxSteps: 16, maxToolCalls: 24 })

export async function createLongHorizonFixture({ evalCase, variant, limits = {} }) {
    if (!['baseline', 'managed'].includes(variant)) {
        throw new TypeError(`unsupported long-horizon variant: ${variant}`)
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-long-horizon-'))
    const initialFiles = createWorkspaceFiles(evalCase)
    const root = new Context()
    let sessions
    try {
        await writeWorkspace(workspace, initialFiles)
        await root.plugin(systemPromptPlugin)
        await root.plugin(toolsPlugin)
        await root.plugin(sandboxPlugin, { workspace, autoApprove: true })
        await root.plugin(bashPlugin, { timeoutMs: 10_000, maxOutput: 12_000 })
        await root.plugin(filesPlugin)
        normalizeBashRendering(root.tools)

        const systemPrompt = root.systemPrompt
        systemPrompt.section({
            name: 'long-horizon-eval',
            order: 20,
            text: [
                'Long-Horizon Eval: deterministic synthetic coding workflow.',
                'Work only in the current temporary workspace. Do not access the network, HOME, or paths outside the workspace.',
                'Use search and file tools to understand code; use exact edits, then run the repository tests.',
                'Only finish after the current model-visible tool results show the final test command exited with code 0.',
            ].join('\n'),
        })

        sessions = new SessionRuntime()
        const session = await sessions.create({ source: 'long-horizon-eval' })
        const agents = new AgentRuntime()
        const llm = new LlmRuntime()
        const trace = new CapturingTraceRuntime()
        const requestMeter = new RecordingTokenMeter()
        const contextManager = new ContextManager({
            sessions,
            tokenMeter: new TokenMeter(),
            policy:
                variant === 'baseline'
                    ? { maxContextTokens: null }
                    : { maxContextTokens: 9000, reservedOutputTokens: 500, compactAtRatio: 0.65 },
        })
        const toolCatalog = new ToolCatalog({ tools: root.tools })
        const requests = []
        const decisions = []
        const progressDetectors = []

        root.tools.register({
            name: 'finish_task',
            description: 'Finish the task after repository tests pass.',
            parameters: { type: 'object' },
            readOnly: true,
            idempotent: true,
            concurrencySafe: true,
            sideEffect: false,
            async execute() {
                return { completed: true }
            },
        })
        registerRoutingDecoys(root.tools)

        llm.register(
            'long-horizon-mock',
            {
                models: ['deterministic'],
                async chat(request) {
                    requestMeter.estimateRequest(request)
                    requests.push({
                        system: request.system,
                        messages: structuredClone(request.messages),
                        tools: structuredClone(request.tools),
                    })
                    const response = decideFromModelRequest(request, requests.length)
                    decisions.push(response)
                    return response
                },
            },
            { defaultModel: 'deterministic' },
        )

        const loop = new AgentLoopRuntime({
            sessions,
            systemPrompt,
            tools: root.tools,
            llm,
            trace,
            contextManager,
            policy: { ...POLICY, ...limits },
            toolCatalog,
            toolVisibility:
                variant === 'baseline'
                    ? new AllToolsVisibility()
                    : new DeterministicToolVisibility({
                          maxVisibleTools: MAX_VISIBLE_TOOLS,
                          alwaysVisible: ['finish_task'],
                          noMatchFallback: 'all',
                      }),
            progressDetectorFactory:
                variant === 'managed'
                    ? () => {
                          const detector = new SemanticProgressDetector({
                              softThreshold: 2,
                              hardThreshold: 5,
                          })
                          progressDetectors.push(detector)
                          return detector
                      }
                    : undefined,
        })
        const agent = agents.create({ sessionId: session.id, model: MODEL, loop })

        return {
            agent,
            trace,
            recordingTokenMeter: requestMeter,
            inspectors: {
                workspace,
                initialFiles,
                requests,
                decisions,
                sessions,
                session,
                root,
                contextManager,
                progressDetectors,
                variant,
            },
            async dispose() {
                try {
                    try {
                        await sessions.dispose()
                    } finally {
                        await root.fiber.dispose()
                    }
                } finally {
                    await fs.rm(workspace, { recursive: true, force: true })
                }
            },
        }
    } catch (error) {
        try {
            try {
                await sessions?.dispose()
            } finally {
                await root.fiber.dispose()
            }
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
        throw error
    }
}

export function scoreLongHorizon({ trace, evalCase, fixture }) {
    const { session, workspace, initialFiles, variant, requests } = fixture.inspectors
    const events = session.events
    const toolCalls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls.map((call) => ({ call, event })))
    const results = events.filter((event) => event.type === 'tool/result')
    const resultByCallId = new Map(results.map((result) => [result.data.toolCallId, result]))
    const callsWithResults = toolCalls.map(({ call }) => ({
        call,
        result: resultByCallId.get(call.id),
    }))
    const protocolComplete = callsWithResults.every(({ result }) => Boolean(result))
    const toolFailures = results.filter((event) => event.data.isError).length
    const filesRead = [
        ...new Set(
            toolCalls
                .filter(({ call }) => call.name === 'read_file')
                .map(({ call }) => call.arguments.path),
        ),
    ].sort()
    const filesModified = [
        ...new Set(
            results
                .filter(
                    (event) =>
                        !event.data.isError &&
                        ['edit_file', 'write_file'].includes(event.data.name),
                )
                .map((event) => {
                    const entry = toolCalls.find(({ call }) => call.id === event.data.toolCallId)
                    return entry?.call.arguments.path
                })
                .filter(Boolean),
        ),
    ].sort()
    const testRuns = results
        .filter((event) => event.data.name === 'bash')
        .map((event) => parseBashResult(event.data.content))
        .filter((value) => value?.command === TEST_COMMAND)
    const finalTestsPassed = testRuns.at(-1)?.exitCode === 0
    const compactionCount = events.filter((event) => event.type === 'context/compaction').length
    const progressStops = trace.stopReason === 'no_progress' ? 1 : 0
    const reminderCount = requests.filter((request) =>
        request.system.includes('[Harness progress notice]'),
    ).length

    const finalFiles = Object.fromEntries(
        Object.keys(initialFiles).map((relativePath) => [
            relativePath,
            readFileSync(path.join(workspace, relativePath), 'utf8'),
        ]),
    )
    const targetContents = finalFiles[evalCase.targetFile] ?? ''
    const targetCorrect =
        evalCase.task === 'cross-file-change'
            ? targetContents.includes(EXPECTED_PATCHES.retryAfter) &&
              !targetContents.includes(EXPECTED_PATCHES.retryBefore)
            : targetContents.includes(EXPECTED_PATCHES.clampAfter) &&
              !targetContents.includes(EXPECTED_PATCHES.clampBefore)
    const requiredReadsSatisfied = evalCase.requiredReadFiles.every((file) =>
        filesRead.includes(file),
    )
    const requiredModificationsSatisfied = evalCase.modifiedFiles.every((file) =>
        filesModified.includes(file),
    )
    const noForbiddenFileChanges = evalCase.unchangedFiles.every(
        (file) => finalFiles[file] === initialFiles[file],
    )
    const noWorkspaceExternalWrites = toolCalls
        .filter(({ call }) => ['edit_file', 'write_file'].includes(call.name))
        .every(({ call }) => isWorkspaceRelativePath(call.arguments.path))
    const bashStayedInWorkspace = results
        .filter((event) => event.data.name === 'bash')
        .map((event) => parseBashResult(event.data.content))
        .every((result) => result?.cwd === workspace)
    const workspaceFilesOnly =
        JSON.stringify(listWorkspaceFiles(workspace).sort()) ===
        JSON.stringify(Object.keys(initialFiles).sort())
    const searchQueries = toolCalls
        .filter(({ call }) => call.name === 'grep')
        .map(({ call }) => call.arguments.query)
    const scoreDetails = {
        filesRead,
        filesModified,
        testRuns: testRuns.length,
        toolFailures,
        compactionCount,
        progressStops,
        reminderCount,
        finalTestsPassed,
        protocolComplete,
        targetCorrect,
        requiredReadsSatisfied,
        requiredModificationsSatisfied,
        noForbiddenFileChanges,
        workspaceFilesOnly,
        noWorkspaceExternalWrites,
        bashStayedInWorkspace,
        bashCommandsSafe: results
            .filter((event) => event.data.name === 'bash')
            .map((event) => parseBashResult(event.data.content)?.command)
            .every((command) => command === TEST_COMMAND),
        modelRequestCount: requests.length,
        visibleToolCounts: requests.map((request) => request.tools.length),
        searchQueries,
        toolSequence: toolCalls.map(({ call }) => call.name),
        variant,
    }
    const success =
        trace.stopReason === 'completed' &&
        trace.steps.some((step) =>
            step.toolCalls.some(
                (call) => call.name === 'finish_task' && call.status === 'completed',
            ),
        ) &&
        targetCorrect &&
        finalTestsPassed &&
        requiredReadsSatisfied &&
        requiredModificationsSatisfied &&
        noForbiddenFileChanges &&
        workspaceFilesOnly &&
        noWorkspaceExternalWrites &&
        bashStayedInWorkspace &&
        scoreDetails.bashCommandsSafe &&
        protocolComplete

    return { success, details: scoreDetails }
}

function decideFromModelRequest(request, requestNumber) {
    const events = transcriptToolEvents(request.messages)
    const promptText = request.messages.map((message) => message.content ?? '').join('\n')
    const task = promptText.match(/TASK::([a-z-]+)/)?.[1]
    const hasTool = (name) => request.tools.some((schema) => schema.function?.name === name)
    const choose = (name, args = {}) => {
        if (!hasTool(name))
            return { content: `Waiting for ${name} to be available.`, toolCalls: [] }
        return {
            content: 'Inspecting the repository and verifying the requested change.',
            toolCalls: [
                {
                    id: `long-horizon-${requestNumber}-${name}`,
                    name,
                    arguments: args,
                },
            ],
        }
    }
    const chooseParallel = (items) => ({
        content: 'Reading the related source files together.',
        toolCalls: items.map(([name, args], index) => ({
            id: `long-horizon-${requestNumber}-${name}-${index}`,
            name,
            arguments: args,
        })),
    })
    const used = (name) => events.filter((event) => event.name === name)
    const last = events.at(-1)
    const grepEvents = used('grep')
    const grepQueries = grepEvents.map((event) => event.arguments.query)

    if (used('finish_task').length > 0) {
        return { content: 'The verified repository task is complete.', toolCalls: [] }
    }

    if (events.length === 0) return choose('glob', { pattern: 'src/' })

    if (task === 'failed-first-search' && !grepQueries.includes('function clamp')) {
        if (!grepQueries.includes('MISSING_CLAMP_SYMBOL')) {
            return choose('grep', { query: 'MISSING_CLAMP_SYMBOL' })
        }
        return choose('grep', { query: 'function clamp' })
    }

    const searchQuery =
        task === 'cross-file-change'
            ? 'DEFAULT_RETRIES'
            : task === 'large-context-fix'
              ? 'CLAMP_POLICY_MIN_FIRST'
              : 'function clamp'
    if (!grepQueries.includes(searchQuery)) return choose('grep', { query: searchQuery })

    const successfulReads = used('read_file').filter(
        (event) => event.result && !event.result.startsWith('ToolError:'),
    )
    const readPaths = new Set(successfulReads.map((event) => event.arguments.path))
    if (task === 'cross-file-change') {
        const missing = ['src/config.js', 'src/runner.js'].filter((file) => !readPaths.has(file))
        if (missing.length > 0) {
            return chooseParallel(missing.map((file) => ['read_file', { path: file }]))
        }
    } else if (task === 'large-context-fix') {
        const missing = ['src/legacy-catalog.js', 'src/calculator.js'].filter(
            (file) => !readPaths.has(file),
        )
        if (missing.length > 0) {
            return chooseParallel(missing.map((file) => ['read_file', { path: file }]))
        }
    } else if (!readPaths.has('src/calculator.js')) {
        return choose('read_file', { path: 'src/calculator.js' })
    }

    const bashEvents = used('bash')
    if (bashEvents.length === 0) return choose('bash', { command: TEST_COMMAND })

    const edits = used('edit_file')
    const latestEdit = edits.at(-1)
    if (task === 'failed-edit-recovery' && latestEdit?.result?.startsWith('ToolError:')) {
        if (last?.name !== 'read_file' || last.result?.startsWith('ToolError:')) {
            return choose('read_file', { path: 'src/calculator.js' })
        }
        if (last.name === 'read_file') {
            return patchFromTranscript(request.messages, choose)
        }
    }

    if (!latestEdit || latestEdit.result?.startsWith('ToolError:')) {
        return patchFromTranscript(request.messages, choose)
    }
    if (last?.name === 'edit_file' || (last?.name === 'read_file' && last !== latestEdit)) {
        if (last.name === 'edit_file') {
            return choose('read_file', {
                path: task === 'cross-file-change' ? 'src/runner.js' : 'src/calculator.js',
            })
        }
    }
    if (last?.name === 'read_file' && edits.length > 0) {
        return choose('bash', { command: TEST_COMMAND })
    }

    const lastBash = bashEvents.at(-1)
    if (lastBash && parseBashResult(lastBash.result)?.exitCode === 0) {
        return choose('finish_task')
    }
    if (last?.name === 'bash') return patchFromTranscript(request.messages, choose)

    return choose('bash', { command: TEST_COMMAND })
}

function patchFromTranscript(messages, choose) {
    const events = transcriptToolEvents(messages)
    const read = events.findLast(
        (event) =>
            event.name === 'read_file' &&
            event.result &&
            !event.result.startsWith('ToolError:') &&
            (event.arguments.path === 'src/calculator.js' ||
                event.arguments.path === 'src/runner.js'),
    )
    if (!read) {
        const task = messages
            .map((message) => message.content ?? '')
            .join('\n')
            .match(/TASK::([a-z-]+)/)?.[1]
        return choose('read_file', {
            path: task === 'cross-file-change' ? 'src/runner.js' : 'src/calculator.js',
        })
    }

    const isRetry = read.arguments.path === 'src/runner.js'
    const before = isRetry ? EXPECTED_PATCHES.retryBefore : EXPECTED_PATCHES.clampBefore
    const after = isRetry ? EXPECTED_PATCHES.retryAfter : EXPECTED_PATCHES.clampAfter
    if (!read.result.includes(before)) {
        return {
            content: 'The current source does not contain the expected old text.',
            toolCalls: [],
        }
    }
    const task = messages.map((message) => message.content ?? '').join('\n')
    const forceMismatch =
        task.includes('TASK::failed-edit-recovery') &&
        !events.some((event) => event.name === 'edit_file')
    return choose('edit_file', {
        path: read.arguments.path,
        oldText: forceMismatch ? `${before} // stale` : before,
        newText: after,
    })
}

function transcriptToolEvents(messages) {
    const events = []
    const pending = []
    let summaryResultEvent = null
    for (const message of messages) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            summaryResultEvent = null
            for (const toolCall of message.tool_calls) {
                const fn = toolCall.function ?? {}
                let arguments_ = {}
                try {
                    arguments_ =
                        typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
                } catch {}
                const event = {
                    id: toolCall.id,
                    name: fn.name,
                    arguments: arguments_,
                    result: null,
                }
                events.push(event)
                pending.push(event)
            }
        }
        if (message.role === 'tool') {
            summaryResultEvent = null
            const event = pending.findLast((item) => item.id === message.tool_call_id)
            if (event) event.result = String(message.content ?? '')
        }
        if (message.role === 'assistant' && typeof message.content === 'string') {
            for (const line of message.content.split(/\r?\n/)) {
                const call = line.match(/^- call ([\w-]+) (\{.*\})$/)
                if (call) {
                    summaryResultEvent = null
                    let arguments_ = {}
                    try {
                        arguments_ = JSON.parse(call[2])
                    } catch {}
                    const event = { id: null, name: call[1], arguments: arguments_, result: null }
                    events.push(event)
                    pending.push(event)
                }
                const result = line.match(/^- result ([\w-]+): (.*)$/)
                if (result) {
                    const event = pending.find(
                        (item) => item.name === result[1] && item.result === null,
                    )
                    if (event) {
                        event.result = result[2]
                        summaryResultEvent = event
                    }
                    continue
                }
                if (
                    /^Tool activity:|^Recent assistant text:|^Previous compacted context:/.test(
                        line,
                    )
                ) {
                    summaryResultEvent = null
                    continue
                }
                if (summaryResultEvent) {
                    summaryResultEvent.result += `\n${line}`
                }
            }
        }
    }
    return events
}

function createWorkspaceFiles(evalCase) {
    const calculator = [
        'export function clamp(value, min, max) {',
        evalCase.task === 'cross-file-change'
            ? '    return Math.max(min, Math.min(max, value))'
            : `    ${EXPECTED_PATCHES.clampBefore}`,
        '}',
        '',
    ].join('\n')
    const runner = [
        "import { DEFAULT_RETRIES } from './config.js'",
        '',
        'export function retryLimit() {',
        `    ${evalCase.task === 'cross-file-change' ? EXPECTED_PATCHES.retryBefore : EXPECTED_PATCHES.retryAfter}`,
        '    return retries',
        '}',
        '',
    ].join('\n')
    const files = {
        'package.json': JSON.stringify(
            {
                name: 'temporary-coding-eval',
                private: true,
                type: 'module',
                scripts: { test: 'node --test test/*.test.js' },
            },
            null,
            2,
        ),
        'src/calculator.js': calculator,
        'src/config.js': 'export const DEFAULT_RETRIES = 3\n',
        'src/runner.js': runner,
        'src/utils.js': 'export function identity(value) { return value }\n',
        'src/unrelated.js': 'export const unrelatedSentinel = "unchanged"\n',
        'test/calculator.test.js': [
            "import test from 'node:test'",
            "import assert from 'node:assert/strict'",
            "import { clamp } from '../src/calculator.js'",
            '',
            "test('clamp preserves the lower and upper bounds', () => {",
            '    assert.equal(clamp(-2, 0, 10), 0)',
            '    assert.equal(clamp(12, 0, 10), 10)',
            '    assert.equal(clamp(4, 0, 10), 4)',
            '})',
            '',
        ].join('\n'),
        'test/runner.test.js': [
            "import test from 'node:test'",
            "import assert from 'node:assert/strict'",
            "import { retryLimit } from '../src/runner.js'",
            '',
            "test('runner uses the configured retry count', () => {",
            '    assert.equal(retryLimit(), 3)',
            '})',
            '',
        ].join('\n'),
        'test/eval-reporter.js': [
            'export default async function* evalReporter(source) {',
            '    for await (const event of source) {',
            "        if (event.type !== 'test:summary') continue",
            '        const { tests, passed, failed } = event.data.counts',
            '        yield "tests=" + tests + "; passed=" + passed + "; failed=" + failed + "\\n"',
            '    }',
            '}',
            '',
        ].join('\n'),
    }
    if (evalCase.task === 'large-context-fix') {
        files['src/legacy-catalog.js'] = makeLargeLegacyCatalog()
    }
    return files
}

function makeLargeLegacyCatalog() {
    const notes = Array.from(
        { length: 130 },
        (_, index) =>
            `  'legacy compatibility note ${String(index).padStart(3, '0')} preserves historical parser and calculator behavior for older workspace clients',`,
    )
    notes.push(
        "  'CLAMP_POLICY_MIN_FIRST: clamp must preserve the lower bound before applying the upper bound',",
    )
    return `export const LEGACY_COMPATIBILITY_NOTES = [\n${notes.join('\n')}\n]\n`
}

async function writeWorkspace(workspace, files) {
    for (const [relativePath, contents] of Object.entries(files)) {
        const target = path.join(workspace, relativePath)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, contents, 'utf8')
    }
}

function registerRoutingDecoys(tools) {
    for (let index = 0; index < 18; index += 1) {
        const suffix = String(index).padStart(2, '0')
        tools.register({
            name: `archive_metadata_${suffix}`,
            description: `Inspect archival provenance metadata for frozen release artifact ${suffix}.`,
            parameters: {
                type: 'object',
                properties: {
                    artifactId: {
                        type: 'string',
                        description: 'Frozen release artifact identifier',
                    },
                },
            },
            readOnly: true,
            idempotent: true,
            concurrencySafe: true,
            sideEffect: false,
            async execute() {
                return { available: false }
            },
        })
    }
}

function normalizeBashRendering(tools) {
    const bash = tools.get('bash')
    const render = bash.output.render
    // Keep volatile subprocess timing out of model-visible estimates; Trace keeps real duration.
    bash.output = {
        ...bash.output,
        render(args, value) {
            return render(args, { ...value, durationMs: 0 })
        },
    }
}

function parseBashResult(content) {
    try {
        const value = JSON.parse(content)
        return value && typeof value === 'object' ? value : null
    } catch {
        return null
    }
}

function isWorkspaceRelativePath(value) {
    return (
        typeof value === 'string' &&
        !path.isAbsolute(value) &&
        !value.split(/[\\/]+/).includes('..')
    )
}

function listWorkspaceFiles(root, directory = root, files = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) listWorkspaceFiles(root, fullPath, files)
        else files.push(path.relative(root, fullPath))
    }
    return files
}
