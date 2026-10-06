import { verifyBehavior } from '../../behavior-verifier.js'
export function verify({ workspace }) { return verifyBehavior({ workspace, script: `import assert from 'node:assert/strict'; import { clamp } from './calculator.js'; assert.equal(clamp(-100, -5, 5), -5); assert.equal(clamp(100, -5, 5), 5); assert.equal(clamp(0.25, 0, 1), 0.25); assert.equal(clamp(4, 4, 4), 4)` }) }
