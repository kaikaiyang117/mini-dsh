import { access } from 'node:fs/promises'
import { caseSpec as invalidation } from './cases/cache-invalidation/case.js'
import { caseSpec as ttl } from './cases/cache-ttl/case.js'
import { caseSpec as clamp } from './cases/clamp-boundaries/case.js'
import { caseSpec as config } from './cases/config-precedence/case.js'
import { caseSpec as csv } from './cases/csv-export/case.js'
import { caseSpec as order } from './cases/dependency-order/case.js'
import { caseSpec as duration } from './cases/duration-zero-handling/case.js'
import { caseSpec as once } from './cases/event-once-listener/case.js'
import { caseSpec as redact } from './cases/nested-secret-redaction/case.js'
import { caseSpec as pagination } from './cases/pagination-filter/case.js'
import { caseSpec as plugin } from './cases/plugin-disable-state/case.js'
import { caseSpec as rename } from './cases/rename-index-consistency/case.js'
import { caseSpec as retry } from './cases/retry-count-off-by-one/case.js'
import { caseSpec as route } from './cases/route-normalization/case.js'
import { caseSpec as dedupe } from './cases/stable-deduplication/case.js'
import { caseSpec as validation } from './cases/validation-refactor-regression/case.js'
import { snapshotWorkspace } from './workspace.js'

const CASES = [
    clamp,
    retry,
    duration,
    dedupe,
    config,
    invalidation,
    rename,
    plugin,
    ttl,
    pagination,
    once,
    csv,
    redact,
    route,
    order,
    validation,
]
const CATEGORIES = new Set([
    'single-file-bugfix',
    'cross-file-bugfix',
    'feature',
    'repo-understanding-refactor-long-context',
])
const MODES = new Set(['failing-tests', 'passing-tests'])

export function validateCaseSpec(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('case must be an object')
    for (const key of [
        'name',
        'title',
        'category',
        'difficulty',
        'workspaceDir',
        'publicTestCommand',
        'baselineMode',
    ])
        if (typeof spec[key] !== 'string' || !spec[key])
            throw new Error(`invalid case field: ${key}`)
    if (
        !CATEGORIES.has(spec.category) ||
        !['easy', 'medium', 'hard'].includes(spec.difficulty) ||
        !MODES.has(spec.baselineMode)
    )
        throw new Error(`invalid metadata for ${spec.name}`)
    if (
        !Array.isArray(spec.tags) ||
        !Array.isArray(spec.allowedModifiedFiles) ||
        !Array.isArray(spec.allowedCreatedFiles)
    )
        throw new Error(`invalid file policy for ${spec.name}`)
    if (typeof spec.verifier !== 'function' || typeof spec.reference?.apply !== 'function')
        throw new Error(`missing verifier/reference for ${spec.name}`)
    if (spec.verifier.constructor.name === 'AsyncFunction')
        throw new Error(`case verifier must be synchronous: ${spec.name}`)
    if (spec.tags.some((tag) => typeof tag !== 'string' || !tag))
        throw new Error(`invalid tags for ${spec.name}`)
    return spec
}

export function loadCodingCases() {
    const names = new Set()
    return CASES.map((spec) => {
        validateCaseSpec(spec)
        if (names.has(spec.name)) throw new Error(`duplicate case: ${spec.name}`)
        names.add(spec.name)
        return {
            ...spec,
            expected: { completion: 'stop-reason', stopReason: 'completed' },
            workspaceDir: decodeURIComponent(spec.workspaceDir),
        }
    })
}

export async function assertNoHiddenAssets(spec) {
    const names = Object.keys(await snapshotWorkspace(spec.workspaceDir))
    if (names.some((name) => /verifier|reference|hidden|solution/i.test(name)))
        throw new Error(`hidden asset leaked into workspace: ${spec.name}`)
    await access(spec.workspaceDir)
}
