import { verifyBehavior } from '../../behavior-verifier.js'
export function verify({ workspace }) { return verifyBehavior({ workspace, script: `import assert from 'node:assert/strict'; import { normalize } from './options.js'; assert.equal(normalize({ duration: 0 }).duration, 0); assert.equal(normalize({ duration: null }).duration, 1000); assert.equal(normalize({}).duration, 1000)` }) }
