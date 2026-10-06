import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertNoHiddenAssets, loadCodingCases } from './loader.js'
import { copyWorkspace, diffWorkspace, snapshotWorkspace } from './workspace.js'

export async function validateCodingBenchmark() {
    const reports = []
    for (const spec of loadCodingCases()) {
        await assertNoHiddenAssets(spec)
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-validate-'))
        try {
            await copyWorkspace(spec.workspaceDir, workspace)
            const initial = await snapshotWorkspace(workspace)
            const baseline = run(spec.publicTestCommand, workspace)
            const baselineValid =
                spec.baselineMode === 'passing-tests'
                    ? baseline.status === 0
                    : baseline.status !== 0
            if (!baselineValid) throw new Error(`${spec.name}: baseline mode mismatch`)
            await spec.reference.apply({ workspace })
            const finalSnapshot = await snapshotWorkspace(workspace)
            const diff = diffWorkspace(initial, finalSnapshot)
            if (
                diff.modifiedFiles.some((file) => !spec.allowedModifiedFiles.includes(file)) ||
                diff.createdFiles.some((file) => !spec.allowedCreatedFiles.includes(file)) ||
                diff.deletedFiles.length
            )
                throw new Error(`${spec.name}: reference violates workspace policy`)
            const publicRun = run(spec.publicTestCommand, workspace)
            if (publicRun.status !== 0)
                throw new Error(`${spec.name}: reference public tests failed`)
            const result = await spec.verifier({
                workspace,
                initialSnapshot: initial,
                finalSnapshot,
            })
            if (!(result === true || result?.passed === true))
                throw new Error(`${spec.name}: reference hidden verifier failed`)
            reports.push({
                name: spec.name,
                baselineValid: true,
                publicTestsPassed: true,
                hiddenTestsPassed: true,
            })
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    }
    return { version: 1, cases: reports }
}

function run(command, cwd) {
    return spawnSync('bash', ['-lc', command], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    })
}
