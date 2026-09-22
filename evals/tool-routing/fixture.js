import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { DeterministicToolVisibility } from '../../src/core/deterministic-tool-visibility.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { ProgressiveToolVisibility } from '../../src/core/progressive-tool-visibility.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { ToolActivationStore } from '../../src/core/tool-activation-store.js'
import { ToolCatalog } from '../../src/core/tool-catalog.js'
import { AllToolsVisibility } from '../../src/core/tool-visibility.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'
import * as toolsPlugin from '../../src/plugins/tools.js'
import * as toolSearchPlugin from '../../src/tools/tool-search.js'

const MAX_VISIBLE_TOOLS = 6

export async function createToolRoutingFixture({ evalCase, variant, limits: _limits = {} }) {
    if (!['all', 'deterministic', 'progressive'].includes(variant)) {
        throw new TypeError(`unsupported routing variant: ${variant}`)
    }

    const root = new Context()
    try {
        await root.plugin(toolsPlugin)
        const tools = root.tools
        let targetWasCalled = false
        let searchWasCalled = false
        const llmRequests = []

        tools.register({
            name: evalCase.expected.targetTool,
            description: evalCase.targetDescription,
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    path: { type: 'string' },
                },
            },
            async execute() {
                return { ok: true }
            },
        })

        const payload = 'schema payload '.repeat(
            Math.ceil((evalCase.setup?.schemaPayloadBytes ?? 0) / 15),
        )
        for (let index = 0; index < (evalCase.setup?.irrelevantTools ?? 0); index += 1) {
            tools.register({
                name: `unrelated_tool_${String(index).padStart(2, '0')}`,
                description: `Unrelated catalog capability ${index} ${payload}`,
                parameters: {
                    type: 'object',
                    properties: {
                        payload: { type: 'string', description: payload },
                    },
                },
                async execute() {
                    return 'unrelated'
                },
            })
        }

        const toolCatalog = new ToolCatalog({ tools })
        let toolVisibility
        if (variant === 'all') {
            toolVisibility = new AllToolsVisibility()
        } else if (variant === 'deterministic') {
            toolVisibility = new DeterministicToolVisibility({
                maxVisibleTools: MAX_VISIBLE_TOOLS,
                noMatchFallback: 'all',
            })
        } else {
            const activationStore = new ToolActivationStore()
            const baseVisibility = new DeterministicToolVisibility({
                maxVisibleTools: MAX_VISIBLE_TOOLS,
                noMatchFallback: 'none',
            })
            toolVisibility = new ProgressiveToolVisibility({ baseVisibility, activationStore })
            await root.plugin(toolSearchPlugin, { toolCatalog, activationStore })
        }

        const sessions = new SessionRuntime()
        const session = await sessions.create()
        const systemPrompt = new SystemPromptRuntime()
        const llm = new LlmRuntime()
        const agents = new AgentRuntime()
        const recordingTokenMeter = new RecordingTokenMeter()
        const contextManager = new ContextManager({ sessions, tokenMeter: recordingTokenMeter })
        const trace = new CapturingTraceRuntime()

        llm.register(
            'eval-mock',
            {
                models: ['routing-v0'],
                async chat(request) {
                    llmRequests.push(request)
                    const names = request.tools.map((schema) => schema.function.name)
                    if (!targetWasCalled && names.includes(evalCase.expected.targetTool)) {
                        targetWasCalled = true
                        return {
                            toolCalls: [
                                {
                                    id: 'eval-target-call',
                                    name: evalCase.expected.targetTool,
                                    arguments: {},
                                },
                            ],
                        }
                    }
                    if (!searchWasCalled && names.includes('tool_search')) {
                        searchWasCalled = true
                        return {
                            toolCalls: [
                                {
                                    id: 'eval-search-call',
                                    name: 'tool_search',
                                    arguments: { query: evalCase.searchQuery },
                                },
                            ],
                        }
                    }
                    return { content: 'target unavailable', toolCalls: [] }
                },
            },
            { defaultModel: 'routing-v0' },
        )

        const loop = new AgentLoopRuntime({
            sessions,
            systemPrompt,
            tools,
            llm,
            trace,
            contextManager,
            toolCatalog,
            toolVisibility,
        })
        const agent = agents.create({
            sessionId: session.id,
            model: 'eval-mock/routing-v0',
            loop,
        })

        return {
            agent,
            trace,
            recordingTokenMeter,
            inspectors: { llmRequests },
            async dispose() {
                await root.fiber.dispose()
            },
        }
    } catch (error) {
        await root.fiber.dispose()
        throw error
    }
}
