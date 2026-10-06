import { spawnSync } from 'node:child_process'

export function verifyBehavior({ workspace, script }) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    })
    return {
        passed: run.status === 0,
        reason: String(run.stderr || run.stdout || `exit ${run.status}`).slice(0, 500),
    }
}
