import { spawn } from 'node:child_process'

export const name = 'mini-tool-bash'
export const inject = ['tools', 'sandbox']

export function apply(ctx, config = {}) {
    const workspace = ctx.sandbox.workspace
    const timeoutMs = Number(config.timeoutMs ?? 30_000)
    const maxOutput = Number(config.maxOutput ?? 32_000)

    ctx.effect(
        () =>
            ctx.tools.register({
                name: 'bash',
                description:
                    'Run a bash command in the current workspace. Use it for time, git, builds, tests, and local environment info. Dangerous commands are blocked by the sandbox and execution requires user approval.',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        command: { type: 'string', description: 'Bash command to run' },
                    },
                    required: ['command'],
                },
                timeoutMs,
                readOnly: false,
                idempotent: false,
                concurrencySafe: false,
                sideEffect: true,
                output: {
                    schema: { type: 'object' },
                    render(_args, value) {
                        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
                    },
                },
                async execute({ command }, exec) {
                    if (typeof command !== 'string' || !command.trim())
                        throw new Error('command is required')
                    ctx.sandbox.assertCommand(command)
                    await ctx.sandbox.approve({
                        tool: 'bash',
                        kind: 'bash',
                        summary: `bash: ${command}`,
                        command,
                    })
                    return runBash(command, {
                        workspace,
                        maxOutput,
                        signal: exec.signal,
                    })
                },
            }),
        'tool: bash',
    )
}

function runBash(command, { workspace, maxOutput, signal }) {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = spawn('bash', ['-lc', command], {
            cwd: workspace,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let killTimer = null

        const append = (current, chunk) => (current + chunk.toString()).slice(-maxOutput)
        child.stdout.on('data', (chunk) => {
            stdout = append(stdout, chunk)
        })
        child.stderr.on('data', (chunk) => {
            stderr = append(stderr, chunk)
        })

        const onAbort = () => {
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })

        child.on('error', (error) => {
            clearTimeout(killTimer)
            signal?.removeEventListener('abort', onAbort)
            reject(error)
        })

        child.on('close', (code, sig) => {
            clearTimeout(killTimer)
            signal?.removeEventListener('abort', onAbort)
            resolve({
                command,
                cwd: workspace,
                exitCode: code,
                signal: sig,
                durationMs: Date.now() - started,
                stdout,
                stderr,
            })
        })
    })
}
