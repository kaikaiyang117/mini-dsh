import { verifyBehavior } from '../../behavior-verifier.js'
export function verify({ workspace }) { return verifyBehavior({ workspace, script: `import assert from 'node:assert/strict'; import { toCsv } from './csv.js'; assert.equal(toCsv([{ a: 'line1\\nline2', b: 'plain' }]), 'a,b\\n"line1\\nline2",plain'); assert.equal(toCsv([{ a: 'x"y' }]), 'a\\n"x""y"')` }) }
