/**
 * Standalone checks for the pure logic in dsh-model-info.
 *
 * Run from anywhere with node (no deps):
 *   node test/run.mjs
 *
 * index.js imports @deepseek-ai/schemastery, which only exists inside a dsh
 * profile, so this file re-implements nothing — it imports parseCredits by
 * reading index.js and evaluating just that exported function in a sandbox
 * where the schemastery import is stubbed.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')

// Strip the schemastery import and stub `z` with a chainable no-op that
// records nothing; we only exercise parseCredits, which touches no schema.
// The other imports are dropped too: parseCredits uses none of them, and vm
// (classic script scope) cannot parse `import`.
const stubbed = source
  .replace(/^import z from '@deepseek-ai\/schemastery'$/m, 'const z = new Proxy(() => z, { get: () => z, apply: () => z })')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}

const ctx = { console }
vm.createContext(ctx)
vm.runInContext(stubbed + '\n;globalThis.__parseCredits = parseCredits;', ctx)
const parseCredits = ctx.__parseCredits

console.log('parseCredits:')
check('x0.51 credits', parseCredits('x0.51 credits'), { multiplier: 0.51, free: false, raw: 'x0.51 credits' })
check('x0.00 credits -> free', parseCredits('x0.00 credits'), { multiplier: 0, free: true, raw: 'x0.00 credits' })
check('x2.00 credits', parseCredits('x2.00 credits'), { multiplier: 2, free: false, raw: 'x2.00 credits' })
check('no decimals', parseCredits('x0 credits'), { multiplier: 0, free: true, raw: 'x0 credits' })
check('null', parseCredits(null), null)
check('undefined', parseCredits(undefined), null)
check('garbage', parseCredits('garbage'), null)
check('number input', parseCredits(0.5), null)
check('empty string', parseCredits(''), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
