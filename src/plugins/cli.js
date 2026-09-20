import readline from 'node:readline'

export const name = 'mini-cli'
export const inject = ['sessions', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'llm', 'sandbox']

/**
 * Thinnest UI layer. Session switching is a command-level concern; session
 * event semantics and persistence remain in the injected services.
 */
export function apply(ctx, config = {}) {
    let session = null
    let agent = null
    const initialModel = config.model ?? process.env.MINI_DSH_MODEL ?? ctx.llm.defaultSelection()

    ctx.effect(() => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        })
        let running = false
        let abort = null
        let closed = false

        const createAgent = (currentSession) => {
            session = currentSession
            agent = ctx.agents.create({
                name: 'cli-agent',
                sessionId: session.id,
                model: initialModel,
                loop: ctx.agentLoop,
            })
        }

        const ready = (async () => {
            createAgent(await ctx.sessions.create({ source: 'cli' }))
            console.log('\nmini-dsh: a learning runtime for DSH')
            console.log(
                'commands: /tools /history /sessions /resume <session-id> /new /prompt /models /model [provider/model] /reset /exit\n',
            )
            console.log(`model: ${agent.model}`)
            console.log(`sandbox workspace: ${ctx.sandbox.workspace}`)
            console.log('Writes and bash execution ask [Y/n] first. Press Esc to cancel a run.\n')
        })()

        const onStdinData = (chunk) => {
            if (!running || !abort || abort.signal.aborted) return
            const bytes = Buffer.from(chunk)
            if (bytes.length === 1 && bytes[0] === 0x1b) abort.abort()
        }
        process.stdin.on('data', onStdinData)

        const disposeApprover = ctx.sandbox.setApprover((request) => {
            const wasRunning = running
            running = false
            return askApproval(rl, request).finally(() => {
                running = wasRunning
            })
        })

        const ask = () => {
            if (!closed && !running) rl.question('User > ', handle)
        }

        const handle = async (input) => {
            await ready
            const text = input.trim()
            if (!text) return ask()

            if (text === '/exit') {
                closed = true
                rl.close()
                await ctx.root.fiber.dispose()
                return
            }

            if (text === '/new') {
                await ctx.sessions.close(session.id)
                createAgent(await ctx.sessions.create({ source: 'cli' }))
                console.log(`New session: ${session.id}\n`)
                return ask()
            }

            if (text === '/sessions') {
                const sessions = await ctx.sessions.list()
                console.log(
                    sessions
                        .map((item) => item.id + (item.id === session.id ? ' *' : ''))
                        .join('\n') || '(no sessions)',
                )
                console.log()
                return ask()
            }

            if (text.startsWith('/resume ')) {
                const id = text.slice('/resume '.length).trim()
                try {
                    const resumed = await ctx.sessions.open(id)
                    createAgent(resumed)
                    console.log(`Resumed session: ${session.id}\n`)
                } catch (error) {
                    console.error(`[SessionError] ${error?.message ?? error}\n`)
                }
                return ask()
            }

            if (text === '/reset') {
                await ctx.sessions.clear(session.id)
                console.log('Session reset.\n')
                return ask()
            }

            if (text === '/tools') {
                const lines = ctx.tools.list().map((tool) => {
                    const firstLine = String(tool.description ?? '')
                        .trim()
                        .split('\n')[0]
                    return `- ${tool.name}: ${firstLine}`
                })
                console.log(lines.join('\n') || '(no tools)')
                console.log()
                return ask()
            }

            if (text === '/models') {
                console.log(ctx.llm.models().join('\n') || '(no models)')
                console.log()
                return ask()
            }

            if (text === '/model') {
                console.log(`model: ${agent.model}\n`)
                return ask()
            }

            if (text.startsWith('/model ')) {
                const selection = text.slice('/model '.length).trim()
                if (!ctx.llm.has(selection)) {
                    console.log(`unknown model: ${selection}`)
                    console.log('available models:')
                    console.log(ctx.llm.models().join('\n') || '(no models)')
                    console.log()
                    return ask()
                }
                agent.model = selection
                console.log(`switched model: ${agent.model}\n`)
                return ask()
            }

            if (text === '/history') {
                console.log(JSON.stringify(ctx.sessions.get(session.id).events, null, 2))
                console.log()
                return ask()
            }

            if (text === '/prompt') {
                console.log(
                    await ctx.systemPrompt.assemble({
                        agent,
                        sessionId: session.id,
                        step: 0,
                    }),
                )
                console.log()
                return ask()
            }

            running = true
            abort = new AbortController()
            let inThinking = false
            let inContent = false

            try {
                await agent.send(text, {
                    signal: abort.signal,
                    onReasoning(chunk) {
                        if (!inThinking) {
                            inThinking = true
                            process.stdout.write('\n\x1b[90m[Thinking]\n')
                        }
                        process.stdout.write(`\x1b[90m${chunk}\x1b[0m`)
                    },
                    onContent(chunk) {
                        if (inThinking) {
                            inThinking = false
                            process.stdout.write('\n\n')
                        }
                        if (!inContent) {
                            inContent = true
                            process.stdout.write('\nAgent > ')
                        }
                        process.stdout.write(chunk)
                    },
                    onToolCall(call) {
                        if (inThinking) {
                            inThinking = false
                            process.stdout.write('\n')
                        }
                        inContent = false
                        process.stdout.write(
                            '\n\x1b[36m[Tool Call: ' +
                                call.name +
                                ']\x1b[0m ' +
                                JSON.stringify(call.arguments ?? {}) +
                                '\n',
                        )
                    },
                    onToolResult(res) {
                        const preview = String(res.renderedContent || '').slice(0, 300)
                        const truncated = (res.renderedContent || '').length > 300 ? '...' : ''
                        process.stdout.write(
                            '\x1b[32m[Tool Result: ' +
                                res.name +
                                ']\x1b[0m ' +
                                preview +
                                truncated +
                                '\n',
                        )
                    },
                })

                if (inThinking) process.stdout.write('\n')
                process.stdout.write('\n\n')
            } catch (error) {
                if (inThinking || inContent) process.stdout.write('\n')
                if (abort.signal.aborted) console.error('\n[cancelled]\n')
                else console.error(`\n[AgentError] ${error?.message ?? error}\n`)
            } finally {
                running = false
                abort = null
                ask()
            }
        }

        rl.on('close', () => {
            if (!ctx.root.fiber.isDisposed) process.exitCode = 0
        })

        ready.then(ask)
        return () => {
            closed = true
            process.stdin.off('data', onStdinData)
            abort?.abort()
            disposeApprover()
            rl.close()
        }
    }, 'interactive cli')
}

function askApproval(rl, request) {
    return new Promise((resolve) => {
        const summary = request.summary ?? request.tool ?? 'this operation'
        process.stdout.write(`\n\x1b[33m[Approval]\x1b[0m ${summary}\n`)
        rl.question('Allow this? [Y/n] ', (answer) => {
            const text = String(answer ?? '')
                .trim()
                .toLowerCase()
            const approved = text === '' || text === 'y' || text === 'yes'
            if (!approved) process.stdout.write('\x1b[31mrejected.\x1b[0m\n')
            resolve(approved)
        })
    })
}
