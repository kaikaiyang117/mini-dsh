import { spawnSync } from 'node:child_process'
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
import { copyWorkspace, snapshotWorkspace } from './workspace.js'

export async function createCodingCaseFixture({
    evalCase,
    variant,
    model,
    limits = {},
    registerProvider = (root) => root.plugin(deepseekPlugin),
    pricing = pricingFromEnv(process.env.MINI_DSH_PRICING_JSON),
}) {
    const spec = evalCase
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-coding-v1-'))
    const root = new Context()
    let sessions
    try {
        await copyWorkspace(spec.workspaceDir, workspace)
        const initialSnapshot = await snapshotWorkspace(workspace)
        const baselineRun = spawnSync('bash', ['-lc', spec.publicTestCommand], {
            cwd: workspace,
            encoding: 'utf8',
            env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        })
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
                `Work only inside the benchmark workspace.`,
                `Task: ${spec.prompt}`,
                `The only allowed bash command is: ${spec.publicTestCommand}`,
                `Run the public tests before and after your change.`,
                `Only modify files allowed by the task.`,
            ].join('\n'),
        })
        sessions = new SessionRuntime()
        const session = await sessions.create({ source: 'coding-benchmark' })
        const tools = restrictCodingTools(root.tools, spec)
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
            policy: { maxSteps: 20, maxToolCalls: 32, maxDurationMs: 120_000, ...limits },
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
        const baselineValid =
            spec.baselineMode === 'passing-tests'
                ? baselineRun.status === 0
                : baselineRun.status !== 0
        return {
            agent,
            trace,
            recordingTokenMeter: requestMeter,
            inspectors: { workspace, session, initialSnapshot, caseSpec: spec, baselineValid },
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

function restrictCodingTools(runtime, spec) {
    const allowed = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'])
    const blocked = (message) => ({
        value: null,
        content: [{ type: 'text', text: `ToolError: ${message}` }],
        isError: true,
        errorCode: 'execution_error',
    })
    const allowedFiles = new Set([...spec.allowedModifiedFiles, ...spec.allowedCreatedFiles])
    const validPath = (input) =>
        typeof input === 'string' && !input.includes('..') && allowedFiles.has(input)
    return {
        get: (name) => (allowed.has(name) ? runtime.get(name) : undefined),
        list: () => runtime.list().filter(({ name }) => allowed.has(name)),
        schemas: () => runtime.schemas().filter((schema) => allowed.has(schema.function.name)),
        renderResult: (result) => runtime.renderResult(result),
        execute(name, args, exec) {
            if (!allowed.has(name)) return Promise.resolve(blocked('tool unavailable in benchmark'))
            if (name === 'bash' && args?.command !== spec.publicTestCommand)
                return Promise.resolve(blocked(`only ${spec.publicTestCommand} is allowed`))
            if ((name === 'edit_file' || name === 'write_file') && !validPath(args?.path))
                return Promise.resolve(blocked('file is outside allowed policy'))
            return runtime.execute(name, args, exec)
        },
    }
}
