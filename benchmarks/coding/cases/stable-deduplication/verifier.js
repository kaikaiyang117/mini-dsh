import { verifyBehavior } from '../../behavior-verifier.js'
export function verify({ workspace }) { return verifyBehavior({ workspace, script: `import assert from 'node:assert/strict'; import { dedupe } from './dedupe.js'; assert.deepEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2]); assert.deepEqual(dedupe([]), [])` }) }
