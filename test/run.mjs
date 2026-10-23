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
vm.runInContext(
  hostSource +
    '\n;globalThis.__host = { parseCredits, parseRateText, normalizeModel, parseClock, zonedNow, scheduleActive, normalizePromotion, collectPromotions, indexPromotions };',
  hostCtx,
)
const {
  parseCredits,
  parseRateText,
  normalizeModel,
  parseClock,
  zonedNow,
  scheduleActive,
  normalizePromotion,
  collectPromotions,
  indexPromotions,
} = hostCtx.__host

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

console.log('parseRateText（各供应商展示写法不统一）:')
check('Qoder 的 0.5×', parseRateText('0.5×'), 0.5)
check('0.2x', parseRateText('0.2x'), 0.2)
check('x0.29 credits', parseRateText('x0.29 credits'), 0.29)
check('裸数字串', parseRateText('0.36'), 0.36)
check('数字输入', parseRateText(0.2), 0.2)
check('空串', parseRateText(''), null)
check('null', parseRateText(null), null)
check('garbage', parseRateText('garbage'), null)

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

// ── 促销 / 档位（`data.modelPromotions` / `data.modelTiers`）──────────────
// 全部字段由服务端下发；这里锁的是"解析 + 时段判定 + 择优"三件事。
console.log('parseClock:')
check('23:00', parseClock('23:00'), 23 * 60)
check('7:50', parseClock('7:50'), 7 * 60 + 50)
check('bare hour', parseClock('8'), 8 * 60)
check('garbage', parseClock('soon'), null)
check('out of range', parseClock('25:00'), null)

console.log('zonedNow:')
const shanghai = zonedNow('Asia/Shanghai', new Date('2026-10-17T15:04:00Z')) // 23:04 CST
check('isoDay is 1..7', shanghai.isoDay >= 1 && shanghai.isoDay <= 7, true)
check('UTC+8 hour', shanghai.hour, 23)

console.log('scheduleActive:')
// 每日窗口不可跨零点：23:00 → 7:50（跨）
const nightWindow = { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] }
check('23:30 在夜间窗口内', scheduleActive(nightWindow, { minutes: 23 * 60 + 30 }), true)
check('03:00 在夜间窗口内（跨零点）', scheduleActive(nightWindow, { minutes: 3 * 60 }), true)
check('12:00 不在窗口内', scheduleActive(nightWindow, { minutes: 12 * 60 }), false)
check('07:50 是区间右端（不含）', scheduleActive(nightWindow, { minutes: 7 * 60 + 50 }), false)
// 白天窗口：7:50 → 23:00（不跨）
const dayWindow = { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] }
check('12:00 在白天窗口内', scheduleActive(dayWindow, { minutes: 12 * 60 }), true)
check('03:00 不在白天窗口内', scheduleActive(dayWindow, { minutes: 3 * 60 }), false)
// 绝对时间窗
const expired = { timezone: 'Asia/Shanghai', validUntil: '2026-01-01T00:00:00+08:00' }
check('已过 validUntil', scheduleActive(expired, { minutes: 12 * 60 }), false)
check('无 daily = 全天', scheduleActive({ timezone: 'Asia/Shanghai' }, { minutes: 3 * 60 }), true)

console.log('normalizePromotion:')
const nightPromo = normalizePromotion(
  {
    id: 'hy4-night',
    kind: 'discount',
    enabled: true,
    priority: 50,
    modelIds: ['hy4-preview', 'hy4-preview-x'],
    badge: { color: '#1E90FF', label: '夜间免费', display: 'activeOnly' },
    hover: { textZh: '每晚 23:00—次日 8:00 享免费额度。' },
    discount: { discountedCredits: '0.00x', factor: 0 },
    schedule: nightWindow,
  },
  'discount',
)
check('夜间免费 factor 解析', nightPromo.factor, 0)
check('夜间免费 activeOnly', nightPromo.activeOnly, true)
check('夜间免费 此刻生效', nightPromo.active, true)
check('夜间免费 标签', nightPromo.label, '夜间免费')
check('夜间免费 文案', nightPromo.hover, '每晚 23:00—次日 8:00 享免费额度。')
check('无 id/modelIds 丢弃', normalizePromotion({ label: 'x' }, 'tier'), null)
check('enabled:false 仍归一化（索引层才丢）', normalizePromotion({ id: 'a', modelIds: ['m'], enabled: false }, 'tier').enabled, false)

console.log('collectPromotions / indexPromotions:')
const collected = collectPromotions({
  modelPromotions: [
    { id: 'low', priority: 10, modelIds: ['glm-5.2'], badge: { label: '低优先' } },
    { id: 'high', priority: 100, modelIds: ['glm-5.2'], badge: { label: '高优先' } },
    { id: 'off', priority: 999, modelIds: ['glm-5.1'], badge: { label: '禁用' }, enabled: false },
  ],
  modelTiers: { id: 'tier', priority: 20, modelIds: ['kimi-k2.8-preview'], badge: { label: '订阅优先' } },
})
ok('促销 + 档位都收进来', collected.length === 4)
const idx = indexPromotions(collected)
ok('priority 高者胜', idx['glm-5.2'].id === 'high')
ok('enabled:false 不进索引', idx['glm-5.1'] === undefined)
ok('modelTiers 单对象形态也能解析', idx['kimi-k2.8-preview'].label === '订阅优先')
ok(
  'activeOnly 且未生效时不占位',
  indexPromotions([
    { id: 'p', priority: 1, modelIds: ['m'], badge: { label: '夜间免费', display: 'activeOnly' }, schedule: dayWindow },
  ])['m'] === undefined,
)

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
ok('tooltip has efforts', tip.includes('思考强度：high'))

console.log('client promotions:')
const night = { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '8:00' }] }
const day = { timezone: 'Asia/Shanghai', daily: [{ start: '8:00', end: '23:00' }] }
check('parseClock 23:00', client.parseClock('23:00'), 23 * 60)
check('parseClock 8', client.parseClock('8'), 8 * 60)
check('parseClock junk', client.parseClock('later'), null)
check('scheduleActive 跨零点 03:00', client.scheduleActive(night, 3 * 60), true)
check('scheduleActive 跨零点 12:00', client.scheduleActive(night, 12 * 60), false)
check('scheduleActive 白天 12:00', client.scheduleActive(day, 12 * 60), true)

client.indexModels([
  { id: 'hy4-preview', name: 'Hy4 preview', rate: 0.29, free: false },
  { id: 'hy3', name: 'Hy3', rate: 0, free: true },
])
// schedule 只给 timezone（无 daily）= 全天生效，这样断言不依赖跑测试的时刻。
client.indexPromotions([
  {
    id: 'hy4-night',
    priority: 50,
    modelIds: ['hy4-preview'],
    badge: { color: '#1E90FF', label: '夜间免费', shortLabel: '免费' },
    hover: { textZh: '每晚 23:00—次日 8:00 享免费额度。' },
    discount: { discountedCredits: '0.00x', factor: 0 },
    schedule: { timezone: 'Asia/Shanghai' },
  },
])
const hy4 = client.lookup('hy4-preview')
ok('促销按 id 挂到模型上', hy4 && hy4.promo && hy4.promo.id === 'hy4-night')
ok('无促销的模型不带 promo', client.lookup('hy3').promo === null)
// 生效倍率：促销生效时用它自己的 factor（这就是"夜间免费"的落点）
const effOn = client.effectiveRate({ free: false, rate: 0.29, promo: { active: true, factor: 0, displayMode: 'replace' } })
check('促销生效 -> 倍率取 factor', effOn.value, 0)
check('促销生效 -> 记下原价', effOn.base, 0.29)
const effOff = client.effectiveRate({ free: false, rate: 0.29, promo: { active: false, factor: 0 } })
check('促销未生效 -> 用目录倍率', effOff.value, 0.29)
check('无促销 -> 用目录倍率', client.effectiveRate({ free: false, rate: 0.29 }).value, 0.29)
check('x0.00 -> 0', client.effectiveRate({ free: true, rate: 0 }).value, 0)
ok('纯文本 tip 带促销文案', client.tooltip(hy4).includes('每晚 23:00'))

// ── 悬浮卡里要列全活动 ──────────────────────────────────────────────────
// 服务端会把同一活动拆成两条：夜间那条带 factor、白天的常驻预告位不带。
// 行内只放一条，但悬浮卡必须把**全部**活动（含未生效的折扣价）列出来。
console.log('client activities:')
client.indexModels([
  { id: 'glm-5.2', name: 'GLM-5.2', rate: 0.79, free: false },
  { id: 'no-promo', name: 'No Promo', rate: 0.5, free: false },
])
client.indexPromotions([
  {
    id: 'night',
    priority: 100,
    modelIds: ['glm-5.2'],
    badge: { color: '#1E90FF', label: '夜间折扣', shortLabel: '折扣' },
    hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省' },
    // 宿主已把 discount.factor 拍平成顶层 factor（见 index.js normalizePromotion）。
    factor: 0.5,
    displayMode: 'strikethrough',
    schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
  },
  {
    id: 'daytime-badge',
    priority: 50,
    modelIds: ['glm-5.2'],
    badge: { color: '#1E90FF', label: '夜间折扣', shortLabel: '折扣' },
    hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] },
  },
])
const glm = client.lookup('glm-5.2')
// 活动一生效一不生效，取决于跑测试的时刻；两条的**并集**始终只有一条。
ok('同一活动只算一条', glm.activities.length === 1)
ok('保留带 factor 的那条', glm.activities[0].factor === 0.5)
ok('无促销的模型没有活动', client.lookup('no-promo').activities.length === 0)
// 时段摘要：跨零点标「次日」，只给 timezone（无 daily）时不编造时段。
check('跨零点窗口', client.scheduleSummary({ timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] }), '每天 23:00–07:50（次日）')
// 上游把一条夜间规则拆成两段时，必须合并回一段（否则是「起点次日 23:00–23:59、00:00–07:50」的噪音）。
check('跨零点两段合并成一段', client.scheduleSummary({ timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '23:59' }, { start: '0:00', end: '7:50' }] }), '每天 23:00–07:50（次日）')
check('白天窗口', client.scheduleSummary({ timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] }), '每天 07:50–23:00')
check('无 daily = 不写时段', client.scheduleSummary({ timezone: 'Asia/Shanghai' }), null)
// 整天窗口不能写成冗长的「00:00–23:59」，但也要让用户看到「不限时段」。
check('整天窗口写「全天」', client.scheduleSummary({ timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '23:59' }] }), '全天')
check('带截止日', client.scheduleSummary({ timezone: 'Asia/Shanghai', daily: [{ start: '8:00', end: '23:00' }], validUntil: '2026-11-01T00:00:00+08:00' }), '每天 08:00–23:00，11月1日 结束')
ok('纯文本 tip 列出活动', client.tooltip(glm).includes('每晚 23:00'))
ok('纯文本 tip 带消耗速度', client.tooltip(glm).includes('0.79x'))

console.log('client provider scoping:')
// 两个分组常有同名条目（DeepSeek 账号 与 CodeBuddy 都有 DeepSeek-V4-Pro），
// 名字一样却是不同条目 —— 一个分组的倍率绝不能贴到另一个分组的同名行上。
// `data-model-id` 是宿主写下的权威 id，只有它能区分两者。
client.indexModels([
  { id: 'v4pro-account', name: 'DeepSeek-V4-Pro', rate: 0.51, free: false },
  { id: 'v4pro-codebuddy', name: 'DeepSeek-V4-Pro', rate: 1.25, free: false },
  { id: 'uniq', name: 'Only-One', rate: 0.2, free: false },
])
const byId = (id) => ({ getAttribute: (name) => (name === 'data-model-id' ? id : null) })
ok('按 data-model-id 取各自的倍率', client.lookup('DeepSeek-V4-Pro', byId('v4pro-account')).rate === '0.51x')
ok('同名另一条取它自己的倍率', client.lookup('DeepSeek-V4-Pro', byId('v4pro-codebuddy')).rate === '1.25x')
// 行上有权威 id 但目录里没有它：**放弃**，绝不退回按名字解析 ——
// 否则别的分组的同名模型会被串上本插件的详情。
ok('id 查不到时不退回文本（防跨分组串组）', client.lookup('Only-One', byId('nope')) === null)
ok('同名且 id 查不到时不乱挂', client.lookup('DeepSeek-V4-Pro', byId('nope')) === null)
ok('没有 host 时按文本解析（老形状）', client.lookup('Only-One').rate === '0.2x')
// 宿主/其它插件会把倍率与标签拼进显示名，退回文本解析时要剥掉。
ok('剥掉拼进名字的后缀再解析', client.lookup('Only-One · x0.2 · 夜间免费')?.rate === '0.2x')

console.log('client model id extraction:')
// 宿主把 data-model-id 写在**行内的名字元素**上，行容器自身没有。
// 只读 host.getAttribute 会永远拿不到 id，于是退回按名字解析 → 跨组串。
const rowWithId = (id) => ({
  getAttribute: () => null, // 行容器自身没有 data-model-id
  querySelector: (sel) => (sel === '[data-model-id]' ? { getAttribute: () => id } : null),
})
ok('从行容器内部取到 data-model-id', client.modelIdOf(rowWithId('uniq')) === 'uniq')
ok('行内取到 id 时按 id 解析', client.lookup('Only-One', rowWithId('uniq'))?.rate === '0.2x')
ok('行容器无 id 子元素时返回 null', client.modelIdOf({ getAttribute: () => null, querySelector: () => null }) === null)

console.log('client cross-provider scoping:')
// 同一个 model id 在两个供应商下并存（内置 DeepSeek 与 Trae 都有
// deepseek-v4-pro）。宿主给行写的 data-model-id 相同，只有**分组标题**
// 能区分它们 —— 否则一个分组的上下文/思考档会被贴到另一个分组的行上。
client.indexModels([
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek', rate: 0.51 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'trae', rate: 1.25, contextWindow: 1000000 },
])
// 造一个能回答 closest([role="group"]) 的行，组标题为 "Trae"。
const inGroup = (groupId, groupLabel) => ({
  getAttribute: (name) => (name === 'data-model-id' ? groupId : null),
  closest: (sel) => (sel === '[role="group"]'
    ? { getAttribute: () => null, children: [{ textContent: groupLabel }] }
    : null),
})
ok('分组 Trae 取 Trae 的倍率', client.lookup('DeepSeek-V4-Pro', inGroup('deepseek-v4-pro', 'Trae'))?.rate === '1.25x')
// 分组认不出时退回全局 id（后注册者胜），不抛错。
ok('分组认不出时仍能解析', client.lookup('DeepSeek-V4-Pro', byId('deepseek-v4-pro')) !== null)

console.log('client pinned row:')
// 实测：宿主给 Auto 那一行**不写** data-model-id（诊断里是 row:miss:null|Auto），
// 它也不在我们的目录里。置顶判断只看 id 会漏掉它，所以名字优先。
const fakeRow = (name, id) => ({
  tagName: 'BUTTON',
  querySelector: (sel) => {
    if (sel === '[class*="_modelName"]') return { textContent: name }
    if (sel === '[data-model-id]') return id === undefined ? null : { getAttribute: () => id }
    return null
  },
})
ok('Auto 行被认作置顶（无 data-model-id）', client.isPinnedRow(fakeRow('Auto')) === true)
ok('大小写不敏感', client.isPinnedRow(fakeRow('auto')) === true)
ok('按 id 也认', client.isPinnedRow(fakeRow('别的名字', 'auto')) === true)
ok('其它行不置顶', client.isPinnedRow(fakeRow('DeepSeek-V4-Pro', 'deepseek-v4-pro')) === false)

console.log('client lookup fallback:')
// 宿主会在名字后面追加自己的标记（如 "DeepSeek-V4.1-Flash 1017"），
// 整串既不是 id 也不是目录里的名字 —— 否则这一行就完全没有额外信息。
client.indexModels([
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', rate: 0.11, free: false },
  { id: 'hy4-preview', name: 'Hy4 preview', rate: 0.29, free: false },
])
ok('名字 + 宿主标记也能命中', client.lookup('DeepSeek-V4.1-Flash 1017').id === 'deepseek-v4.1-flash')
ok('名字后接中文标记也能命中', client.lookup('DeepSeek-V4.1-Flash 推荐').id === 'deepseek-v4.1-flash')
ok('不会被另一个模型名的前缀带走', client.lookup('Hy4 preview 1017').id === 'hy4-preview')
ok('无关文本不命中', client.lookup('随便什么') === null)

console.log('client hot zone:')
// 没有徽标可挂时（图片模型上游不给 credits）热区也必须留着 —— 悬浮卡里还有
// 描述 / 上下文 / 思考档，不能因为没徽标就让「详细提示」整个消失。
// 摘掉宿主原生 title 之后，热区是唯一的悬浮入口，这就是它消失的原因。
ok('没有徽标也建热区', /if \(!nodes\.length\)[\s\S]{0,400}?hot\.setAttribute\(ANCHOR, ""\)/.test(clientSource))
ok('没有徽标时清掉的只是徽标，不是热区', !/if \(!nodes\.length\)[\s\S]{0,300}?clearHot\(hot\)/.test(clientSource))
// onOver 拿到的是 [ANCHOR] 元素（= 热区 = 名字元素），不是行容器。
// 只把 rec 存在行容器上，showTipFor(anchor) 就永远查不到 —— 悬浮卡彻底不弹。
ok('按热区元素也能取到 rec（悬浮卡入口）', /decorated\.set\(hot,\s*\{/.test(clientSource))
// 摘原生 title 必须在**确认能找到热区元素之后**：否则一行既没有原生提示、
// 也没有自绘卡，表现为「有些模型只有原生 tip / 什么都不弹」。
const applyToBody = clientSource.slice(
  clientSource.indexOf('function applyTo('),
  clientSource.indexOf('function decorateTrigger('),
)
ok('找不到热区元素时不摘原生 title', (() => {
  const anchorAt = applyToBody.indexOf('nameElementOf(target)')
  const titleAt = applyToBody.indexOf('removeAttribute("title")')
  return anchorAt >= 0 && titleAt >= 0 && anchorAt < titleAt
})())
// 行里没有 `_modelName` 时（不同 provider 的行结构可能不同）要能退回
// `[data-model-id]`，否则那一行既不摘 title 也不建热区。
ok('名字元素找不到时退回 data-model-id', /function nameElementOf\(option\)[\s\S]{0,400}querySelector\("\[data-model-id\]"\)/.test(clientSource))
ok('点击/按下时收起悬浮卡（不挡切换入口）', /addEventListener\("mousedown", onPress, true\)/.test(clientSource))
ok('悬停时兜底补挂热区（宿主重渲染后仍能弹）', /function recoverHot\(target\)/.test(clientSource))
// 卡默认出现在锚点**右侧**，不能落在鼠标正下方盖住下一行。
ok('悬浮卡放锚点右侧（不在鼠标正下方）', /r\.right \+ gap \+ w <= vw - pad/.test(clientSource))
ok('右侧放不下时退到左侧', /r\.left - gap - w >= pad/.test(clientSource))
// 两侧都放不下时也不能压在锚点行上（否则看着像「卡在鼠标下面」）。
ok('与锚点横向重叠时改上下错开', /overlapsHorizontally/.test(clientSource) && /r\.bottom \+ gap/.test(clientSource))
// 促销原文紧跟描述（官方排法），不在卡片底部重复一次。
ok('促销原文紧跟描述', /actNote\.textContent = noteParts\.join/.test(clientSource))
ok('活动价不在底部重复原文', !/tip\.appendChild\(promoBox\(/.test(clientSource))
// Trae 的闲时折扣只有 factor + 时段、没有原文 —— 不能因为没有原文整条丢掉。
ok('无原文但有折扣/时段的活动也渲染', /typeof act\.factor === "number"\) noteParts\.push/.test(clientSource))
// 带 days 的窗口必须按星期分组处理，否则会被拼成假跨零点。
ok('窗口按星期分组', /byDays\[key\]/.test(clientSource))
// 只有「恰好两段且晚→晨」才推断为上游拆分的跨零点规则。
ok('只在两段时合并跨零点', /local\.length === 2/.test(clientSource))
// 观感对齐 WorkBuddy：固定宽度卡片 + 标题行内联促销徽标 + 分隔线。
ok('卡片固定宽度（对齐 WorkBuddy 观感）', /\.dmi-tip\{[^}]*width:330px/.test(clientSource))
ok('标题行内联促销徽标', /title\.appendChild\(headChip\)/.test(clientSource))
ok('字段区有分隔线', /\.dmi-tip-grid\{[^}]*border-top:1px solid/.test(clientSource))
// 配色对齐：卡片走主题令牌（深色自动跟随）、可展开项用品牌色、上游动作文案用链接色。
// 卡片底色取 bg-layer-1：深色主题下 bg-layer-2 偏亮，卡片会「浮起来」显脏。
ok('卡片底色更深一档（bg-layer-1）', /\.dmi-tip\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(clientSource))
ok('卡片边框用 l2 档', /\.dmi-tip\{[^}]*border:1px solid var\(--dsw-alias-border-l2/.test(clientSource))
// 促销徽标必须是「同色相药丸」：半透明底 + 细描边，不能是整块实色。
ok('徽标用 color-mix 派生半透明底', /color-mix\(in srgb, " \+ color \+ " 22%/.test(clientSource))
ok('徽标有同色描边', /border = "1px solid color-mix\(in srgb, " \+ color/.test(clientSource))
ok('不用整块实色背景', !/style\.backgroundColor = (p|act|promo|headPromo)\.color/.test(clientSource))
ok('可展开字段用品牌色', /\.dmi-tip-v\.dmi-tip-expandable\{[^}]*alias-brand-primary/.test(clientSource))
ok('上游动作文案用链接色', /\.dmi-tip-link\{[^}]*alias-brand-primary/.test(clientSource))
ok('可展开项带箭头', /dmi-tip-arrow/.test(clientSource))
// 只使用 Theme 目录里真实存在的令牌（否则会静默退回兜底色）。
ok('不使用不存在的主题令牌', !/--dsw-alias-state-business-primary/.test(clientSource))

console.log('client static discipline:')
ok('自绘悬浮卡（不用原生 title 排版）', /\.dmi-tip\{/.test(clientSource) && !/rec\.tip\s*=\s*tooltip/.test(clientSource))
// 宿主的原生 title 就是「模型名」，留着会和自绘卡叠成两个提示 —— 必须摘掉。
ok('摘掉宿主的原生 title，不出现两个提示', /savedTitles\.set\(target, target\.getAttribute\("title"\)\)/.test(clientSource) && /removeAttribute\("title"\)/.test(clientSource))
ok('卸载时把原生 title 还回去', /titled\[k\]\.setAttribute\("title", saved\)/.test(clientSource))
// 热区挂整行 = 挡住模型选择入口；现在只挂名字。
ok('热区只挂名字，不挂整行', /hot\.setAttribute\(ANCHOR, ""\)/.test(clientSource) && !/target\.setAttribute\(ANCHOR, ""\)/.test(clientSource))
ok('热区宽度收到文字那么宽，不撑满整行', /\.dmi-hot\{[^}]*width:fit-content/.test(clientSource))
ok('徽标插在热区后面，不进热区', /parent\.insertBefore\(nodes\[m\], hot\.nextSibling\)/.test(clientSource))
// 消耗速度那一行原来是 DocumentFragment，被当字符串渲染成 [object …]。
ok('消耗速度接受 Fragment（不再 [object DocumentFragment]）', /if \(valueNode && valueNode\.nodeType\) v\.appendChild\(valueNode\)/.test(clientSource))
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
ok('促销徽标文案截断，不撑开行', /text\.length > 6/.test(clientSource))
ok('上游字符串一律 textContent，不拼 HTML', !/innerHTML\s*=/.test(clientSource))
ok('悬浮卡用事件委托，不给每行挂监听', /addEventListener\("mouseover", onOver/.test(clientSource))
ok('促销边界对账只在状态翻转时重扫', /if \(!promotionsChanged\(\)\) return/.test(clientSource))
// 徽标与文案一律取自上游；本文件里出现的中文营销词只能是注释或测试夹具。
const clientCode = clientSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
ok('不硬编码任何营销文案', !/限时免费|夜间免费|独家限免|订阅优先/.test(clientCode))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
