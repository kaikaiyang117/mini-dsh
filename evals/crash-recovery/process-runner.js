import { fork } from 'node:child_process'
import path from 'node:path'

const worker = path.resolve('test/fixtures/crash-worker.js')

const WATCHDOG_MS = 10_000

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
        let checkpoint = null
        let timer
        const finish = (value) => {
            if (!settled) {
                settled = true
                clearTimeout(timer)
                resolve(value)
            }
        }
        const fail = (error) => {
            if (!settled) {
                settled = true
                clearTimeout(timer)
                reject(error)
            }
        }
        const kill = () => {
            if (!child.killed) child.kill('SIGKILL')
        }
        child.on('message', (message) => {
            if (message?.type === 'checkpoint' && phase === 'crash') {
                checkpoint = message
                kill()
            } else if (message?.type === 'result') {
                finish(message)
            } else if (message?.type === 'error') {
                kill()
                fail(new Error(message.message))
            }
        })
        child.on('error', (error) => {
            kill()
            fail(error)
        })
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
        timer = setTimeout(() => {
            kill()
            fail(new Error(`crash worker watchdog timed out after ${WATCHDOG_MS}ms`))
        }, WATCHDOG_MS)
        child.send({ directory, sessionId, effectsDirectory }, (error) => {
            if (error) {
                kill()
                fail(error)
            }
        })
    })
    return { ...result, output, errorOutput }
}
