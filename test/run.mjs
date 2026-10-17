/**
 * Standalone checks for dsh-model-info (no deps; runs outside a dsh profile).
 *
 *   node test/run.mjs
 *
 * Two harnesses:
 *   - host half: index.js is evaluated in a vm with the schemastery import
 *     stubbed, so the pure helpers (parseCredits / normalizeModel) run as-is;
 *   - browser half: lib/client.js is evaluated against a fake
 *     window.__ModuleLoader__, then its exports.__internals are exercised.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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
function ok(name, cond) {
  check(name, cond === true, true)
}

// ── host half ────────────────────────────────────────────────────────────
const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
  .replace(
    /^import z from '@deepseek-ai\/schemastery'$/m,
    'const z = new Proxy(function () {}, { get: () => z, apply: () => z })',
  )
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

const hostCtx = { console, process, Buffer, setTimeout, clearTimeout }
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { parseCredits, normalizeModel };', hostCtx)
const { parseCredits, normalizeModel } = hostCtx.__host

console.log('parseCredits:')
check('x0.51 credits', parseCredits('x0.51 credits'), { multiplier: 0.51, free: false, raw: 'x0.51 credits' })
check('x0.00 credits -> free', parseCredits('x0.00 credits'), { multiplier: 0, free: true, raw: 'x0.00 credits' })
check('x2.00 credits', parseCredits('x2.00 credits'), { multiplier: 2, free: false, raw: 'x2.00 credits' })
check('no decimals', parseCredits('x0 credits'), { multiplier: 0, free: true, raw: 'x0 credits' })
check('suffix-less (kimi-k3-2)', parseCredits('x1.62'), { multiplier: 1.62, free: false, raw: 'x1.62' })
check('null', parseCredits(null), null)
check('undefined', parseCredits(undefined), null)
check('garbage', parseCredits('garbage'), null)
check('number input', parseCredits(0.5), null)
check('empty string', parseCredits(''), null)

console.log('normalizeModel:')
const craft = new Set(['hy4-preview'])
const trial = { targetModelId: 'hy4-preview', trialDays: 14 }

// Every field below lives on the /v3/config record itself — no local catalogue
// is merged any more, so this is exactly what the gateway sends.
check(
  'upstream fields only',
  normalizeModel(
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      credits: 'x0.79 credits',
      descriptionZh: '旗舰模型，擅长复杂软件工程与长程 Agent 任务',
      descriptionEn: 'Flagship model',
      maxAllowedSize: 1000000,
      maxInputTokens: 1000000,
      reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
      supportsImages: true,
    },
    null,
    new Set(),
  ),
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    credits: 'x0.79 credits',
    rate: 0.79,
    free: false,
    tags: [],
    craft: false,
    trial: null,
    descriptionZh: '旗舰模型，擅长复杂软件工程与长程 Agent 任务',
    descriptionEn: 'Flagship model',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    supportsImages: true,
  },
)
check(
  'craft + trial from upstream sets',
  normalizeModel({ id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29 credits' }, trial, craft),
  {
    id: 'hy4-preview',
    name: 'Hy4 preview',
    credits: 'x0.29 credits',
    rate: 0.29,
    free: false,
    tags: [],
    craft: true,
    trial: { days: 14 },
    supportsImages: false,
  },
)
check(
  'free model',
  normalizeModel({ id: 'hy3', name: 'Hy3', credits: 'x0.00 credits' }, null, new Set()),
  {
    id: 'hy3',
    name: 'Hy3',
    credits: 'x0.00 credits',
    rate: 0,
    free: true,
    tags: [],
    craft: false,
    trial: null,
    supportsImages: false,
  },
)
check(
  'older single-effort shape still readable',
  normalizeModel({ id: 'x', credits: 'x1.00 credits', reasoning: { effort: 'high' } }, null, new Set()).efforts,
  ['high'],
)
check(
  'context falls back to maxInputTokens',
  normalizeModel({ id: 'x', maxInputTokens: 200000 }, null, new Set()).contextWindow,
  200000,
)
check(
  'image tags pass through',
  normalizeModel({ id: 'hunyuan-image-alpha', credits: '', tags: ['text-to-image'] }, null, new Set()).tags,
  ['text-to-image'],
)
check('unknown credits shape -> no rate', normalizeModel({ id: 'x', credits: 'whatever' }, null, new Set()).rate, null)

// ── browser half ─────────────────────────────────────────────────────────
function loadClient(path) {
  const src = readFileSync(path, 'utf8')
  let def = null
  const ctx = {
    console,
    window: {
      __ModuleLoader__: {
        load(d) {
          def = d
        },
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  if (!def) throw new Error('client did not call __ModuleLoader__.load')
  return def.factory(function () {
    throw new Error('client must not require modules')
  }).__internals
}

const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const client = loadClient(join(root, 'lib', 'client.js'))

console.log('client:')
check('rateText(0.29)', client.rateText(0.29), '0.29x')
check('rateText("x0.51 credits")', client.rateText('x0.51 credits'), 'x0.51')
check('rateText(null)', client.rateText(null), null)
check('tagLabel text-to-image', client.tagLabel('text-to-image'), '文生图')
check('tagLabel unknown', client.tagLabel('audio'), 'audio')
check('fmtContext 960000', client.fmtContext(960000), '960K')
check('fmtContext 1000000', client.fmtContext(1000000), '1M')

client.indexModels([
  {
    id: 'hy4-preview',
    name: 'Hy4 preview',
    rate: 0.29,
    free: false,
    tags: [],
    craft: true,
    trial: { days: 14 },
    descriptionZh: '混元思考模型',
    contextWindow: 960000,
    efforts: ['high'],
  },
  { id: 'hy3', name: 'Hy3', rate: 0, free: true },
  { id: 'hy1', name: 'Hy3', rate: 0.5, free: false },
])
ok('lookup by id', client.lookup('hy4-preview') && client.lookup('hy4-preview').rate === '0.29x')
ok('lookup by name', client.lookup('Hy3') && client.lookup('Hy3').free === true)
ok('lookup "Model · Effort"', client.lookup('Hy4 preview · high') && client.lookup('Hy4 preview · high').craft === true)
ok('lookup miss', client.lookup('nope') === null)
// Upstream publishes duplicate names (Hy3 / hy3-x, Hy4 preview / hy4-preview-x).
// A name shared by two models must not resolve to whichever came last; the row
// then falls back to the id. Note `hy3` also owns the id key "hy3", so that key
// legitimately resolves — the shared NAME "Hy4 preview" is the real probe.
client.indexModels([
  { id: 'hy4-preview', name: 'Hy4 preview', rate: 0.29, free: false },
  { id: 'hy4-preview-x', name: 'Hy4 preview', rate: 0.29, free: false },
  { id: 'hy3', name: 'Hy3', rate: 0, free: true },
  { id: 'hy3-x', name: 'Hy3', rate: 0.05, free: false },
])
ok(
  'duplicate name resolves by id only',
  client.lookup('Hy4 preview') === null &&
    client.lookup('hy4-preview-x').rate === '0.29x' &&
    client.lookup('hy3-x').rate === '0.05x' &&
    client.lookup('hy3').free === true,
)
client.indexModels([
  { id: 'hy4-preview', name: 'Hy4 preview', rate: 0.29, free: false, craft: true, trial: { days: 14 }, descriptionZh: '混元思考模型', contextWindow: 960000, efforts: ['high'] },
  { id: 'hy3', name: 'Hy3', rate: 0, free: true },
])
const tip = client.tooltip(client.lookup('Hy4 preview'))
ok('tooltip has rate', tip.includes('0.29x'))
ok('tooltip has trial', tip.includes('试用 14 天'))
ok('tooltip has description', tip.includes('混元思考模型'))
ok('tooltip has context', tip.includes('960K'))
ok('tooltip has efforts', tip.includes('思考档 high'))

console.log('client static discipline:')
ok('does not observe class', !/attributeFilter:\s*\[\s*["']class["']\s*\]/.test(clientSource))
ok('narrow attributeFilter only', /attributeFilter:\s*\[\s*"aria-label",\s*"aria-checked",\s*"aria-expanded"\s*\]/.test(clientSource))
const onMutationsBody = clientSource.slice(
  clientSource.indexOf('function onMutations'),
  clientSource.indexOf('安装时做一次整页扫描'),
)
ok('mutation callback inspects no whole document', onMutationsBody.length > 0 && !/document\.querySelectorAll/.test(onMutationsBody))
ok('mutation callback decorates only added subtrees', /collect\(rec\.addedNodes\[j\]\)/.test(onMutationsBody))
ok('row badge goes into the option row, not the name cell', /target\.insertBefore\(node, check\)/.test(clientSource) && !/parent\.appendChild\(node\)/.test(clientSource))
ok('row badge right-aligns itself', /node\.style\.marginLeft = "auto"/.test(clientSource))
ok('unused dmi-row wrapper is gone', !/\.dmi-row\{/.test(clientSource))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
