import { verifyBehavior } from '../../behavior-verifier.js'
export function verify({ workspace, finalSnapshot }) {
    const structure = 'validation/name.js' in finalSnapshot && finalSnapshot['create.js'].includes("from './validation/name.js'") && finalSnapshot['update.js'].includes("from './validation/name.js'") && !finalSnapshot['create.js'].includes("if (!input.name)") && !finalSnapshot['update.js'].includes('if (!next.name)')
    if (!structure) return { passed: false, reason: 'shared validator structure' }
    return verifyBehavior({ workspace, script: `import assert from 'node:assert/strict'; import { create } from './create.js'; import { update } from './update.js'; import { importRecord } from './import.js'; assert.throws(() => create({}), /name required/); assert.throws(() => update({ name: 'old' }, { name: '' }), /name required/); assert.deepEqual(create({ name: 'new', email: 'valid@example.com' }), { name: 'new', email: 'valid@example.com' }); assert.throws(() => update({ name: 'old', email: 'bad' }, { name: 'new' }), /email invalid/); assert.deepEqual(importRecord({ name: 'imported', email: 'ok@example.com' }), { name: 'imported', email: 'ok@example.com' })` })
}
