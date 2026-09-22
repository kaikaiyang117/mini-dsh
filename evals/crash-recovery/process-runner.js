import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const worker = path.resolve('test/fixtures/crash-worker.js')

export async function runCrashWorker({ directory, caseName, phase, sessionId, effectsDirectory }) {
    const child = fork(worker, [], {
        env: { ...process.env, CRASH_CASE: caseName, CRASH_PHASE: phase },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    let errorOutput = ''
    child.stdout?.on('data', (chunk) => {
        output += chunk
    })
    child.stderr?.on('data', (chunk) => {
        errorOutput += chunk
    })
    const result = await new Promise((resolve, reject) => {
        let settled = false
        const finish = (value) => {
            if (!settled) {
                settled = true
                resolve(value)
            }
        }
        const fail = (error) => {
            if (!settled) {
                settled = true
                reject(error)
            }
        }
        let checkpoint = null
        child.on('message', (message) => {
            if (message?.type === 'checkpoint' && phase === 'crash') {
                checkpoint = message
                child.kill('SIGKILL')
            } else if (message?.type === 'result') {
                finish(message)
            } else if (message?.type === 'error') {
                fail(new Error(message.message))
            }
        })
        child.on('error', fail)
        child.on('exit', (code, signal) => {
            if (phase === 'crash') {
                if (signal !== 'SIGKILL') {
                    fail(
                        new Error(
                            `crash worker did not terminate with SIGKILL: ${signal ?? code}\n${errorOutput}`,
                        ),
                    )
                } else {
                    finish({ type: 'checkpoint-complete', ...checkpoint, signal, output })
                }
            } else if (code !== 0) {
                fail(new Error(`worker exited ${code ?? signal}\n${errorOutput}`))
            }
        })
        child.send({ directory, sessionId, effectsDirectory })
    })
    return { ...result, output, errorOutput }
}

export function newSessionId() {
    return randomUUID()
}
