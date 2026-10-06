import assert from 'node:assert/strict'; import test from 'node:test'; import { toCsv } from './csv.js'
test('quotes special cells', () => assert.equal(toCsv([{ name: 'A, "B"' }]), 'name\n"A, ""B"""'))
