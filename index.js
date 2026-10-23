/**
 * dsh-model-info —— 宿主半（host half）。
 *
 * 职责：聚合各供应商（WorkBuddy / Trae / Qoder）的每模型元信息，统一暴露给
 * 浏览器半的悬浮卡与行内徽标。数据源**全部复用** `dsh-workbuddy-trae-qoder-connect`
 * 已经落地的文件 / 路由，不自己打上游、不持有凭据：
 *
 *   · WorkBuddy（CN）：`~/.dsh/.workbuddy{n}-catalog.json`
 *       entries[<account>].models[] —— 含 id/name/contextWindow/maxTokens/
 *       supportsImages/reasoning/billing{credits,badges,free}
 *   · Trae CN：`~/.dsh/trae-cn/models.json`
 *       models[] —— 含 id/name/contextWindow/maxTokens/supportsImages/
 *       reasoningByGroup/contextWindowByGroup/rate(number)/rateActivity(number)
 *   · Qoder CN：`GET /plugins/dsh-qoder-connect/status`（loopback）
 *       models[] —— 含 id/name/rate/free/contextWindow/isReasoning
 *       （Qoder 目录不落地，只能走状态路由；详细字段以它给的为准）
 *
 * 归一化后的统一 shape（浏览器半只认这一份）：
 *   { id, name, provider, rate(number), free(bool), credits(string|null),
 *     badges(string[]), contextWindow(number|undefined),
 *     maxTokens(number|undefined), supportsImages(bool), efforts(string[]),
 *     promotions: [] }
 *
 * `credits` 是供应商自己的**展示**倍率，**不是线性价格**（实测 credit/1k tokens
 * 不随它线性变化）；唯一硬映射是 x0.00 <=> 不计费。所以同时给原始字符串、
 * 数字和 free 布尔值，绝不宣称「贵 N 倍」。
 *
 * 促销标签（`夜间免费` / `限时免费` 等）在 CN 版 WorkBuddy 里只以 `billing.badges`
 * 形式存在，没有时段/折扣明细；Trae 的活动信息在 `rateActivity` 里，也不足以
 * 构建时段。所以 `promotions` 统一为空数组，行内徽标直接用 `badges`。
 *
 * 硬规则：
 *   · 读磁盘文件用 readFile（不缓存句柄）；打 loopback 路由带 AbortSignal.timeout。
 *   · 过期缓存立即返回、后台刷新；客户端绝不等一个慢的上游。
 *   · 单个供应商失败不影响其他供应商；该供应商的模型从上一轮缓存里继续用。
 */


import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const ROUTE = '/dsh-model-info/models'
const HEALTH_ROUTE = '/dsh-model-info/health'
const DIAG_ROUTE = '/dsh-model-info/diag'

/**
 * loopback 基址。**以 webServer.getOrigin() 为准**——桌面宿主的端口是启动参数
 * （动态的），环境变量未必带；请求进来的 Host 才是同源事实。
 * 拿不到才退回 DSH_PORT / DSH_WEB_URL / 3079。
 */
function loopbackBase(ws) {
  try {
    const origin = ws?.getOrigin?.()
    if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, '')
  } catch { /* 未监听时 getOrigin 会抛，走回退 */ }
  const fromEnv = String(process.env.DSH_PORT ?? '').trim()
  if (fromEnv) return `http://127.0.0.1:${fromEnv}`
  try {
    const u = new URL(String(process.env.DSH_WEB_URL ?? '').trim())
    if (u.protocol === 'http:' && u.port) return `http://127.0.0.1:${u.port}`
  } catch { /* 忽略 */ }
  return 'http://127.0.0.1:3079'
}
/** 客户端诊断环形缓冲：文件要小（且 .cache 已被排除同步）。 */
const DIAG_MAX = 60
const DIAG_MAX_BYTES = 64 * 1024

// ── WorkBuddy / CodeBuddy 上游 ────────────────────────────────────────────
// 网关按 `User-Agent` 里的产品名**分发行情**：同一个 token、同一个 URL，
// UA 不同拿到的模型集合与附加字段都不同（实测 2026-10-19）：
//
//   | UA                                  | models | modelPromotions |
//   |-------------------------------------|--------|-----------------|
//   | `CLI/2.63.2 CodeBuddy/2.63.2`       |  34    |  0              |
//   | `WorkBuddy/5.7.2 CLI/2.156.0`       |  61    |  8              |
//
// 所以本插件发**两次**请求：
//   1. 目录请求用 CLI UA —— 与 connect 注册给宿主的模型集合同源；
//   2. 富信息请求用 App UA —— 只为取 description / promotions / tiers，
//      **不参与**模型集合（它会多出 hy4-preview-ctrl / codewise-* 等死条目）。
const WB_CHAT_BASE = 'https://copilot.tencent.com'
const WB_BILLING_BASE = 'https://www.codebuddy.cn'
/** 目录请求：connect 同款（CLI 形态），保证模型集合一致。 */
const WB_CATALOG_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** 富信息请求：桌面 App 形态，只有它带 modelPromotions / modelTiers。 */
const WB_RICH_UA = 'WorkBuddy/5.7.2 CLI/2.156.0'

export const Config = z.object({
  /** 单次数据源读取的缓存存活时长，毫秒。 */
  cacheMs: z.number().step(1000).min(0).default(300000),
  /** 单次 loopback / 上游请求的硬性超时（绝不能省）。 */
  requestTimeoutMs: z.number().step(500).min(1000).default(8000),
  /** 允许调用方用 ?refresh=1 强制重新读取。 */
  allowRefresh: z.boolean().default(true),
  /** 是否在输入框旁的模型名后挂悬浮热区。 */
  uiTrigger: z.boolean().default(true),
  /** 是否在 /model 下拉行内挂悬浮热区。 */
  uiMenu: z.boolean().default(true),
  /**
   * 是否渲染行内 / 触发器旁徽标。**默认关**：dsh-connect 已把倍率与促销标签
   * 拼进 `model.name`（`Hy4 preview · x0.29 · 夜间免费`），再挂徽标就是重复。
   * 本插件的主职是悬浮卡里的额外信息。
   */
  badges: z.boolean().default(false),
  /**
   * 是否自己向上游要富信息（description / modelPromotions / modelTiers）。
   * 关掉后只有 connect 已落地的字段（上下文、思考档、倍率标签文案）。
   */
  rich: z.boolean().default(true),
  /** 是否接收客户端诊断上报（那是我们在宿主侧看不到的浏览器状态）。 */
  diagnostics: z.boolean().default(true),
  debug: z.boolean().default(false),
})

export const name = 'dsh-model-info'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function cacheDir() {
  return join(dshHome(), '.cache')
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 列出 ~/.dsh 下所有 .workbuddy{n}-catalog.json 文件。 */
async function globWorkBuddyCatalogs(home) {
  try {
    const names = await readdir(home)
    return names
      .filter((n) => /^\.workbuddy\d+-catalog\.json$/.test(n))
      .map((n) => join(home, n))
      .sort()
  } catch {
    return []
  }
}

/**
 * 读某个 WorkBuddy 账号的凭据（connect 写在 `~/.dsh/.workbuddy{n}-auth.json`）。
 * **只读**，凭据不出本进程、不经路由。
 */
async function readWorkBuddyAuth(home, n) {
  const data = await readJson(join(home, `.workbuddy${n}-auth.json`))
  const cred = data?.credential
  const token = firstString(cred?.accessToken)
  if (!token) return null
  const domain = firstString(cred?.domain) || WB_BILLING_BASE
  const uid = firstString(cred?.uid)
  return {
    token,
    domain,
    uid,
    /** global 走 www.workbuddy.ai；CN 走 copilot.tencent.com。 */
    global: /workbuddy\.ai$/i.test(domain),
  }
}

/**
 * 解析上游的 `credits` 展示字符串。
 * "x0.51 credits" -> { multiplier: 0.51, free: false, raw: "x0.51 credits" }
 * "x0.00 credits" -> { multiplier: 0,    free: true,  ... }
 * "x1.62"         -> { multiplier: 1.62, free: false }   (some models omit the suffix)
 * 形状无法识别时返回 null —— 这样上游格式一变，降级为「无数据」，
 * 而不是给出一个错数字。
 */
export function parseCredits(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.match(/x\s*(-?\d+(?:\.\d+)?)/i)
  if (!m) return null
  const multiplier = Number(m[1])
  if (!Number.isFinite(multiplier)) return null
  return { multiplier, free: multiplier === 0, raw }
}

/**
 * 更宽松的倍率解析：除了 `x0.51 credits`，还认 Qoder 那种 `0.5×` / `0.2x` /
 * 纯数字串。各供应商的展示写法不统一，用同一入口收口。
 * 认不出返回 null（宁可不显示，也不给错数字）。
 */
export function parseRateText(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  // 先按带 x 的写法（含 "credits" 后缀）解析。
  const withX = parseCredits(text)
  if (withX) return withX.multiplier
  // 再认 `0.5×` / `0.5x` / `0.5` 这类裸数字。
  const m = text.match(/(-?\d+(?:\.\d+)?)/)
  if (!m) return null
  const value = Number(m[1])
  return Number.isFinite(value) ? value : null
}

/** 取候选中第一个可用字符串并 trim；都不可用则 undefined。 */
function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** 按上游发布的思考档列表；兼容旧的单个 `effort` 形态。 */
function readEfforts(reasoning) {
  if (!reasoning || typeof reasoning !== 'object') return undefined
  if (Array.isArray(reasoning.supportedEfforts)) {
    const list = reasoning.supportedEfforts.filter((e) => typeof e === 'string' && e)
    if (list.length) return list
  }
  if (typeof reasoning.effort === 'string' && reasoning.effort) return [reasoning.effort]
  return undefined
}

/**
 * 归一化一条上游模型记录。
 *
 * 下面每个字段都直接取自 /v3/config 载荷本身 —— 不从本地客户端包里合并任何东西，
 * 因此描述或上下文窗口绝不会是旧目录残留。载荷没有携带的字段
 * 保持 undefined/null，UI 直接省略那一行。

 */
export function normalizeModel(raw, trial, craftSet) {
  const parsed = parseCredits(raw?.credits)
  const contextWindow =
    typeof raw?.maxAllowedSize === 'number'
      ? raw.maxAllowedSize
      : typeof raw?.maxInputTokens === 'number'
        ? raw.maxInputTokens
        : undefined
  return {
    id: raw?.id,
    name: firstString(raw?.name, raw?.id),
    credits: parsed ? parsed.raw : null,
    rate: parsed ? parsed.multiplier : null,
    free: parsed ? parsed.free : false,
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    craft: craftSet?.has?.(raw?.id) === true,
    trial: trial && trial.targetModelId === raw?.id && typeof trial.trialDays === 'number' ? { days: trial.trialDays } : null,
    descriptionZh: firstString(raw?.descriptionZh),
    descriptionEn: firstString(raw?.descriptionEn),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    efforts: readEfforts(raw?.reasoning),
    supportsImages: raw?.supportsImages === true,
  }
}

// ── 促销 / 档位徽标（`data.modelPromotions` / `data.modelTiers`）────────
// 全部字段由服务端下发；这里只做三件事：解析 "H:mm"、判定时段、按 priority 择优。

/** "23:00" / "7:50" / "23" → 当日分钟数；解析不出返回 null。 */
export function parseClock(text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h > 24 || min > 59) return null
  return h * 60 + min
}

/**
 * 取某个 IANA 时区下的「当前时刻的分钟数 + 星期」。
 * 用 Intl 而不是本地 Date：容器/机器的 TZ 未必是用户所在时区，
 * 而 `schedule.timezone` 是服务端给的（实测恒为 Asia/Shanghai）。
 */
export function zonedNow(timezone, at = new Date()) {
  const tz = typeof timezone === 'string' && timezone ? timezone : 'Asia/Shanghai'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(at)
    const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
    const hour = Number(get('hour')) % 24 // '24' 出现在午夜的某些实现里
    const minute = Number(get('minute'))
    const weekday = get('weekday')
    return {
      minutes: hour * 60 + (Number.isFinite(minute) ? minute : 0),
      // 0=周日 … 6=周六 → ISO 1..7
      isoDay: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday) + 1,
      hour,
      minute,
    }
  } catch {
    return { minutes: at.getHours() * 60 + at.getMinutes(), isoDay: at.getDay() + 1, hour: at.getHours(), minute: at.getMinutes() }
  }
}

/**
 * 一条 schedule 此刻是否生效。
 * `daily` 是**每日时段窗口**数组（`[start, end)`，可跨零点如 23:00→7:50）；
 * 缺失 = 全天。validFrom/validUntil 是绝对时间窗（ISO-8601）。
 */
export function scheduleActive(schedule, now = zonedNow(schedule?.timezone)) {
  if (!schedule || typeof schedule !== 'object') return true
  const from = schedule.validFrom ? Date.parse(schedule.validFrom) : NaN
  const until = schedule.validUntil ? Date.parse(schedule.validUntil) : NaN
  const at = Date.now()
  if (Number.isFinite(from) && at < from) return false
  if (Number.isFinite(until) && at >= until) return false
  const windows = Array.isArray(schedule.daily) ? schedule.daily : []
  if (!windows.length) return true
  for (const w of windows) {
    const start = parseClock(w?.start)
    const end = parseClock(w?.end)
    if (start === null || end === null) continue
    if (start <= end) {
      if (now.minutes >= start && now.minutes < end) return true
    } else {
      // 跨零点：23:00 → 次日 7:50
      if (now.minutes >= start || now.minutes < end) return true
    }
  }
  return false
}

/** 归一化一条促销/档位条目；缺 id 或 modelIds 的丢弃。 */
export function normalizePromotion(raw, kind) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : null
  const modelIds = Array.isArray(raw.modelIds)
    ? raw.modelIds.filter((m) => typeof m === 'string' && m)
    : []
  if (!id || !modelIds.length) return null
  const badge = raw.badge && typeof raw.badge === 'object' ? raw.badge : {}
  const hover = raw.hover && typeof raw.hover === 'object' ? raw.hover : {}
  const discount = raw.discount && typeof raw.discount === 'object' ? raw.discount : {}
  // "0.50x" / "0x" / "0.00x" → 0.5 / 0 / 0；没有就用 factor。
  const parsed = parseCredits(String(discount.discountedCredits ?? ''))
  const factor = parsed
    ? parsed.multiplier
    : Number.isFinite(discount.factor) ? discount.factor : null
  return {
    id,
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : kind,
    priority: Number.isFinite(raw.priority) ? raw.priority : 0,
    enabled: raw.enabled !== false,
    modelIds,
    label: firstString(badge.label, badge.labelEn),
    shortLabel: firstString(badge.shortLabel, badge.shortLabelEn, badge.label, badge.labelEn),
    color: typeof badge.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(badge.color) ? badge.color : null,
    /** display:'activeOnly' = 只在时段内显示；缺省/'always' = 常驻。 */
    activeOnly: badge.display === 'activeOnly',
    hover: firstString(hover.textZh, hover.textEn),
    actionLabel: firstString(hover.action?.labelZh, hover.action?.labelEn),
    factor,
    discountedCredits: typeof discount.discountedCredits === 'string' ? discount.discountedCredits : null,
    displayMode: typeof discount.displayMode === 'string' ? discount.displayMode : null,
    schedule: raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : null,
    /** 是否"此刻生效"（时段窗口内）。 */
    active: scheduleActive(raw.schedule),
  }
}

/**
 * 从**活动视图**的载荷里抽出促销与档位表。
 * `modelTiers` 可能是对象（单条）或数组，两种都实测见过。
 */
export function collectPromotions(data) {
  const list = []
  const promotions = Array.isArray(data?.modelPromotions) ? data.modelPromotions : []
  for (const p of promotions) {
    const norm = normalizePromotion(p, 'discount')
    if (norm) list.push(norm)
  }
  const tiers = data?.modelTiers
    ? (Array.isArray(data.modelTiers) ? data.modelTiers : [data.modelTiers])
    : []
  for (const t of tiers) {
    const norm = normalizePromotion(t, 'tier')
    if (norm) list.push(norm)
  }
  return list
}

/** 按模型 id 建索引；多个命中时 priority 高者胜（服务端自己的规则）。 */
export function indexPromotions(list) {
  const byModel = Object.create(null)
  for (const p of list) {
    if (!p.enabled) continue
    // activeOnly 的条目只在生效时段内才占位
    if (p.activeOnly && !p.active) continue
    for (const id of p.modelIds) {
      const prev = byModel[id]
      if (!prev || p.priority > prev.priority) byModel[id] = p
    }
  }
  return byModel
}

export function apply(ctx, config = {}) {
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 300000
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 8000
  const allowRefresh = config.allowRefresh !== false
  const diagnostics = config.diagnostics !== false
  /** 是否自己向上游要 description / promotions / tiers。 */
  const useRich = config.rich !== false

  const state = {
    cache: { at: 0, models: null, promotions: [] },
    inFlight: null,
    lastError: null,
    lastFetchMs: null,
    /** 各供应商的读取状态，供 /health 观察。 */
    sources: {},
  }

  /** webServer 实例（ctx.inject 里赋值）；loopback 请求要用它的真实 origin。 */
  let web = null

  const ui = () => ({
    trigger: config.uiTrigger !== false,
    menu: config.uiMenu !== false,
    badges: config.badges === true,
  })

  // ── 归一化：把各供应商的原始模型记录拍成统一 shape ──────────────────────

  /**
   * WorkBuddy catalog 模型 → 统一 shape。
   *
   * `rich` 是**同一个 id 在富信息视图里的那一行**（App UA 请求的结果），
   * 有就补描述 / 思考档 / 上下文上限；没有就只用 catalog 自带的字段。
   * `promotions` 由调用方按 id 挂（见 attachPromotions）。
   */
  function normWorkBuddy(raw, provider, rich) {
    const parsed = parseCredits(raw?.billing?.credits)
    // 思考档：catalog 的 reasoning 优先，富信息补全（某些行 catalog 只有 defaultEffort）。
    const efforts = readEfforts(raw?.reasoning) || readEfforts(rich?.reasoning) || []
    // 上下文窗口的**默认档**：上游 `contextWindow.defaultLength` 才是
    // 官方客户端显示的那个数（hy4-preview = 300000）。`maxAllowedSize` 是
    // 可选上限（1M），拿它当默认值会让卡片显示 960K/1M，比官方大一档。
    const ctx = typeof raw?.contextWindow === 'number' && raw.contextWindow > 0
      ? raw.contextWindow
      : typeof rich?.contextWindow?.defaultLength === 'number' && rich.contextWindow.defaultLength > 0
        ? rich.contextWindow.defaultLength
        : typeof rich?.maxInputTokens === 'number' && rich.maxInputTokens > 0
          ? rich.maxInputTokens
          : undefined
    // 同一模型的其它可选窗口档（官方「更大上下文」下拉的那几档）。
    const ctxChoices = Array.isArray(rich?.contextWindow?.supportedLengths)
      ? rich.contextWindow.supportedLengths.filter((n) => typeof n === 'number' && n > 0)
      : []
    const maxTokens = typeof raw?.maxTokens === 'number' && raw.maxTokens > 0
      ? raw.maxTokens
      : typeof rich?.maxOutputTokens === 'number' && rich.maxOutputTokens > 0
        ? rich.maxOutputTokens
        : undefined
    return {
      id: raw?.id,
      /** 全局唯一键：`<provider>::<modelId>`。 */
      key: `${provider}::${raw?.id}`,
      name: firstString(raw?.name, raw?.id),
      provider,
      credits: parsed ? parsed.raw.replace(/\s*credits\s*$/i, '') : null,
      rate: parsed ? parsed.multiplier : null,
      free: parsed ? parsed.free : raw?.billing?.free === true,
      badges: Array.isArray(raw?.billing?.badges) ? raw.billing.badges.filter((b) => typeof b === 'string') : [],
      contextWindow: ctx,
      /** 可选的更大窗口档（大于当前值时悬浮卡单列一行）。 */
      maxContextWindow: ctxChoices.length && ctx && Math.max(...ctxChoices) > ctx ? Math.max(...ctxChoices) : undefined,
      maxTokens,
      supportsImages: raw?.supportsImages === true,
      /** 上游显式声明的工具调用能力（只有富信息视图带）。 */
      supportsToolCall: rich?.supportsToolCall === true,
      efforts,
      // 描述只在上游给的时候才有（CN 版多数行有 descriptionZh）。
      description: firstString(rich?.descriptionZh, rich?.descriptionEn),
      promotions: [],
    }
  }

  /**
   * Trae catalog 模型 → 统一 shape。
   * `rate` 通常是数字（0.2），也容忍展示字符串（`0.2×`）。
   * `reasoningByGroup` 是 { group: { support_thinking, options[] } }。
   * `contextWindowByGroup` 是 { group: { dev, max } } —— `max` 就是 Trae 界面里
   * 「更大上下文（Max）」那一档，所以两者都带上，悬浮卡可以并列显示。
   */
  function normTrae(raw, provider) {
    const rate = parseRateText(raw?.rate)
    const efforts = []
    const byGroup = raw?.reasoningByGroup
    if (byGroup && typeof byGroup === 'object') {
      for (const g of Object.values(byGroup)) {
        if (g?.support_thinking === true && Array.isArray(g.options)) {
          for (const e of g.options) if (typeof e === 'string' && !efforts.includes(e)) efforts.push(e)
        }
      }
    }
    // 各 function 的 dev / max 窗口取并集后再取极值。
    let maxWindow
    const cbg = raw?.contextWindowByGroup
    if (cbg && typeof cbg === 'object') {
      for (const g of Object.values(cbg)) {
        if (typeof g?.max === 'number' && g.max > 0 && (maxWindow === undefined || g.max > maxWindow)) maxWindow = g.max
      }
    }
    // 兜底：`raw.features.context_windows.data` 也声明了 dev/max 两档
    // （Trae 界面「更大上下文（Max）」开关对应的就是这里的 max_context）。
    const cw = raw?.raw?.features?.context_windows?.data
    if (cw && typeof cw === 'object') {
      if (typeof cw.max_context === 'number' && cw.max_context > 0 && (maxWindow === undefined || cw.max_context > maxWindow)) {
        maxWindow = cw.max_context
      }
      if (Array.isArray(cw.max_context_list)) {
        for (const v of cw.max_context_list) {
          if (typeof v === 'number' && v > 0 && (maxWindow === undefined || v > maxWindow)) maxWindow = v
        }
      }
    }
    // 图像理解：顶层 supportsImages 与 features.multimodal 都可能声明，
    // 任一为真即为真（Trae 的「图片理解」勾选就是这个）。
    const supportsImages = raw?.supportsImages === true || raw?.raw?.features?.multimodal?.enable === true
    return {
      id: raw?.id,
      /** 全局唯一键：`<provider>::<modelId>`。同名模型跨供应商必须能区分。 */
      key: `${provider}::${raw?.id}`,
      name: firstString(raw?.name, raw?.id),
      provider,
      credits: rate !== null ? `x${rate}` : null,
      rate,
      free: rate === 0,
      badges: [],
      contextWindow: typeof raw?.contextWindow === 'number' && raw.contextWindow > 0 ? raw.contextWindow : undefined,
      // «更大上下文（Max）」那一档：大于默认窗口时才单列。
      maxContextWindow: typeof maxWindow === 'number' && maxWindow > (typeof raw?.contextWindow === 'number' ? raw.contextWindow : 0) ? maxWindow : undefined,
      maxTokens: typeof raw?.maxTokens === 'number' && raw.maxTokens > 0 ? raw.maxTokens : undefined,
      supportsImages,
      efforts,
      description: undefined,
      promotions: traeDiscountOf(raw, provider),
    }
  }

  /**
   * 宽松解析 Trae 的 `weekdays`：实测是**空格分隔的字符串**（`"1 2 3 4 5"`），
   * 也见过数组形态。两种都认，否则时段会整段丢掉。
   */
  function parseWeekdays(value) {
    let parts = []
    if (Array.isArray(value)) parts = value
    else if (typeof value === 'string') parts = value.split(/[\s,]+/)
    else if (typeof value === 'number') parts = [value]
    const out = []
    for (const p of parts) {
      const n = Number(String(p).trim())
      if (Number.isInteger(n) && n >= 1 && n <= 7 && !out.includes(n)) out.push(n)
    }
    out.sort((a, b) => a - b)
    return out
  }

  /**
   * Trae 的活动折扣 → 统一促销条目。
   *
   * Trae 把折扣放在 `raw.features.activity_discount.data`：
   *   current  : { discount_type, before_consumption_rate, consumption_rate, discount }
   *   off_peak : { ..., time_windows: [{ weekdays, start_minute, end_minute }], time_zone }
   *   member   : { before_consumption_rate, after_consumption_rate, discount }
   *
   * 与 WorkBuddy 的两处形状差异：
   *   · 时段是**分钟数 + 星期集合**，不是 "HH:mm" 字符串；
   *   · `weekdays` 实测是空格分隔字符串（`"1 2 3 4 5"`），也容忍数组。
   *
   * `member` 是「会员专享 5 折」那一档：它没有时段（会员恒享），
   * 但折扣率是上游明确给出的，所以单独生成一条不带 schedule 的活动。
   */
  function traeDiscountOf(raw, provider) {
    const d = raw?.raw?.features?.activity_discount
    const cur = d?.data?.current
    if (!cur || d?.enable !== true) return []
    const type = typeof cur.discount_type === 'string' ? cur.discount_type : ''
    // `none` = 当前没有折扣；`subsidy` / `off_peak` 才是真折扣。
    if (!type || type === 'none') return []
    const out = []

    const before = Number.isFinite(cur.before_consumption_rate) ? cur.before_consumption_rate : null
    const after = Number.isFinite(cur.consumption_rate) ? cur.consumption_rate : null
    if (after === null) return []
    const factor = before && before > 0 ? after / before : null
    const windows = Array.isArray(d?.data?.off_peak?.time_windows) ? d.data.off_peak.time_windows : []
    const tz = typeof d?.data?.off_peak?.time_zone === 'string' && d.data.off_peak.time_zone
      ? d.data.off_peak.time_zone
      : 'Asia/Shanghai'
    const daily = []
    for (const w of windows) {
      const start = Number.isFinite(w?.start_minute) ? w.start_minute : null
      const end = Number.isFinite(w?.end_minute) ? w.end_minute : null
      if (start === null || end === null) continue
      const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
      // end_minute = 1440 表示到当天结束（24:00），写成 23:59 更直观。
      const endText = end >= 1440 ? '23:59' : fmt(end)
      const days = parseWeekdays(w?.weekdays)
      const window = { start: fmt(start), end: endText }
      if (days.length > 0 && days.length < 7) window.days = days
      daily.push(window)
    }
    out.push({
      id: `trae-${type}-${raw?.id || 'x'}`,
      kind: 'discount',
      provider,
      priority: 100,
      enabled: true,
      modelIds: [raw?.id].filter((x) => typeof x === 'string'),
      label: type === 'off_peak' ? '闲时折扣' : type === 'subsidy' ? '限时优惠' : '',
      shortLabel: type === 'off_peak' ? '闲时折扣' : '优惠',
      color: null,
      activeOnly: false,
      hover: undefined,
      actionLabel: undefined,
      factor,
      discountedCredits: after !== null ? `x${after}` : null,
      displayMode: 'replace',
      schedule: daily.length ? { timezone: tz, daily } : null,
      active: daily.length ? scheduleActive({ timezone: tz, daily }) : true,
    })

    // 「会员专享 5 折」：`member` 段只给折扣率、没有时段（会员恒享）。
    // Trae 界面把它与闲时折扣分开列，所以这里也单独一条。
    const member = d?.data?.member
    if (member && typeof member === 'object') {
      const mBefore = Number.isFinite(member.before_consumption_rate) ? member.before_consumption_rate : null
      const mAfter = Number.isFinite(member.after_consumption_rate) ? member.after_consumption_rate
        : Number.isFinite(member.consumption_rate) ? member.consumption_rate : null
      if (mAfter !== null && mBefore !== null && mBefore > 0) {
        out.push({
          id: `trae-member-${raw?.id || 'x'}`,
          kind: 'tier',
          provider,
          priority: 90,
          enabled: true,
          modelIds: [raw?.id].filter((x) => typeof x === 'string'),
          label: '会员专享',
          shortLabel: '会员专享',
          color: null,
          activeOnly: false,
          hover: undefined,
          actionLabel: undefined,
          factor: mAfter / mBefore,
          discountedCredits: `x${mAfter}`,
          displayMode: 'replace',
          // 会员价没有时段限制：不写 schedule（渲染时不会伪造时段）。
          schedule: null,
          active: true,
        })
      }
    }
    return out
  }

  /**
   * Qoder status 路由模型 → 统一 shape。
   * `rate` 可能是数字，也可能是展示字符串（`"0.5×"` / `"0.2×"`）——
   * 两种都要认，否则整批 Qoder 模型会「有 id 却没倍率」。
   * `isReasoning` 是布尔，不区分档位（阶段由上游声明，这里不猜）。
   */
  function normQoder(raw, provider) {
    const rate = parseRateText(raw?.rate)
    return {
      id: raw?.id,
      /** 全局唯一键：`<provider>::<modelId>`。 */
      key: `${provider}::${raw?.id}`,
      name: firstString(raw?.name, raw?.id),
      provider,
      credits: rate !== null ? `x${rate}` : null,
      rate,
      free: raw?.free === true || rate === 0,
      badges: [],
      contextWindow: typeof raw?.contextWindow === 'number' && raw.contextWindow > 0 ? raw.contextWindow : undefined,
      maxTokens: undefined,
      supportsImages: false,
      efforts: [],
      description: undefined,
      promotions: qoderDiscountOf(raw, provider),
    }
  }

  /**
   * Qoder 的促销。状态路由目前不透 `promotion`（provide 里有，面板没发），
   * 有就按统一形状收下，没有就空 —— 不猜。
   */
  function qoderDiscountOf(raw, provider) {
    const p = raw?.promotion
    if (!p || typeof p !== 'object') return []
    const norm = normalizePromotion({ ...p, modelIds: p.modelIds || [raw?.id] }, 'discount')
    if (!norm) return []
    return [{ ...norm, provider }]
  }

  // ── 数据源读取 ────────────────────────────────────────────────────────────

  /**
   * 一次 `/v3/config`。`ua` 决定拿到哪一版行情（见 WB_CATALOG_UA / WB_RICH_UA）。
   * 所有请求都带硬超时 —— 网关挂住绝不能把路由拖死。
   */
  async function fetchV3Config(auth, ua) {
    const base = auth.global ? WB_BILLING_BASE : WB_CHAT_BASE
    const headers = {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      'User-Agent': ua,
      // CN 网关要求同源 Origin/Referer（connect 也是这么发的）。
      ...(auth.global ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {
        Origin: WB_BILLING_BASE,
        Referer: `${WB_BILLING_BASE}/`,
      }),
      // connect 在 catalog 请求里也带这几个身份头，缺了可能被判成另一类客户端。
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
      ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
    }
    const res = await fetch(`${base}/v3/config`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`upstream-http-${res.status}`)
    const body = await res.json()
    if (body?.code !== 0) throw new Error(`upstream-${body?.code}`)
    return body?.data && typeof body.data === 'object' ? body.data : null
  }

  /**
   * 取某个 WorkBuddy 账号的**富信息**：description / reasoning / promotions / tiers。
   * 只补元信息，**不参与**模型集合 —— App 视图会多出宿主里并不存在的条目。
   */
  async function fetchWorkBuddyRich(n) {
    const auth = await readWorkBuddyAuth(dshHome(), n)
    if (!auth) throw new Error('no-credential')
    const data = await fetchV3Config(auth, WB_RICH_UA)
    if (!data) throw new Error('empty-payload')
    const byId = Object.create(null)
    for (const m of Array.isArray(data.models) ? data.models : []) {
      if (typeof m?.id === 'string') byId[m.id] = m
    }
    // modelPromotions + modelTiers 都拍成同一套促销结构（复用既有归一化）。
    const promotions = collectPromotions(data)
    return { byId, promotions }
  }

  /** 扫描 ~/.dsh/.workbuddy{n}-catalog.json，归一化所有 workbuddy 账号的模型。 */
  async function readWorkBuddyCatalogs() {
    const home = dshHome()
    const models = []
    const files = await globWorkBuddyCatalogs(home)
    for (const file of files) {
      const data = await readJson(file)
      const entries = data?.entries
      if (!entries || typeof entries !== 'object') continue
      const m = file.match(/\.workbuddy(\d+)-catalog\.json$/)
      const provider = m ? `workbuddy${m[1]}` : 'workbuddy'
      // 富信息与目录**按同一个 provider 的账号号**配对；失败只是少几个字段。
      let rich = null
      if (m && useRich) {
        try {
          rich = await fetchWorkBuddyRich(m[1])
        } catch (error) {
          rich = null
          state.richErrors = { ...(state.richErrors || {}), [provider]: String(error?.message ?? error) }
        }
      }
      for (const accountKey of Object.keys(entries)) {
        const entry = entries[accountKey]
        const list = Array.isArray(entry?.models) ? entry.models : []
        for (const raw of list) {
          if (typeof raw?.id !== 'string') continue
          const rec = normWorkBuddy(raw, provider, rich?.byId?.[raw.id])
          // 促销按 id 挂（与 catalog 的模型集合取交集，绝不引入目录外的模型）。
          if (rich?.promotions?.length) {
            rec.promotions = rich.promotions.filter((p) => Array.isArray(p.modelIds) && p.modelIds.includes(raw.id))
          }
          models.push(rec)
        }
      }
    }
    return models
  }

  /** 读 ~/.dsh/trae-cn/models.json。 */
  async function readTraeCatalog() {
    const data = await readJson(join(dshHome(), 'trae-cn', 'models.json'))
    const list = Array.isArray(data?.models) ? data.models : []
    return list
      .filter((m) => typeof m?.id === 'string')
      .map((m) => normTrae(m, 'trae'))
  }

  /** 打 loopback 的 /plugins/dsh-qoder-connect/status，取 Qoder 模型。 */
  async function fetchQoderStatus() {
    const base = loopbackBase(web)
    const res = await fetch(`${base}/plugins/dsh-qoder-connect/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`qoder-http-${res.status}`)
    const body = await res.json()
    const list = Array.isArray(body?.models) ? body.models : []
    return list
      .filter((m) => typeof m?.id === 'string')
      .map((m) => normQoder(m, 'qoder'))
  }

  /** 汇总所有供应商；单个失败不影响其他。 */
  async function fetchAll() {
    const started = Date.now()
    const models = []
    const sources = {}
    const errors = []

    const tasks = [
      ['workbuddy', readWorkBuddyCatalogs],
      ['trae', readTraeCatalog],
      ['qoder', fetchQoderStatus],
    ]
    for (const [name, fn] of tasks) {
      try {
        const list = await fn()
        models.push(...list)
        sources[name] = { ok: true, count: list.length }
      } catch (error) {
        sources[name] = { ok: false, error: String(error?.message ?? error) }
        errors.push(`${name}:${sources[name].error}`)
      }
    }

    state.sources = sources
    state.lastError = errors.length ? errors.join('; ') : null
    state.lastFetchMs = Date.now() - started
    if (models.length === 0 && errors.length === tasks.length) return null
    // 促销条目同时**摊平**到顶层（客户端按 `provider::id` 建索引），
    // 这样服务端只需发一次；每条都带 modelIds，客户端自己挂。
    const promotions = []
    const seen = new Set()
    for (const m of models) {
      for (const p of m.promotions || []) {
        const sig = `${m.provider}|${p.id}`
        if (seen.has(sig)) continue
        seen.add(sig)
        promotions.push({ ...p, provider: m.provider })
      }
    }
    return { models, promotions }
  }

  /**
   * `active` 是抓取那一刻算的，而夜间窗口的边界是 23:00 / 8:00 ——
   * 缓存足以跨过边界，所以**每次读取都按当前时刻重算**这一位，
   * 其余字段（文案、时段定义）沿用缓存，一次都不多打上游。
   */
  function livePromotions() {
    const list = state.cache.promotions
    if (!Array.isArray(list) || !list.length) return []
    return list.map((p) => {
      const active = p.schedule ? scheduleActive(p.schedule) : p.active
      return active === p.active ? p : { ...p, active }
    })
  }

  function view(extra) {
    return {
      available: state.cache.models !== null,
      cached: true,
      stale: false,
      sources: state.sources,
      fetchedAt: state.cache.at,
      ui: ui(),
      health: {
        lastFetchMs: state.lastFetchMs,
        lastError: state.lastError,
      },
      models: state.cache.models ?? [],
      promotions: livePromotions(),
      ...extra,
    }
  }

  function startRefresh() {
    if (state.inFlight) return state.inFlight
    state.inFlight = fetchAll()
      .then((result) => {
        if (result) {
          state.cache = {
            at: Date.now(),
            models: result.models,
            promotions: Array.isArray(result.promotions) ? result.promotions : [],
          }
        }
        return result
      })
      .catch((error) => {
        state.lastError = String(error?.message ?? error)
        return null
      })
      .finally(() => {
        state.inFlight = null
      })
    return state.inFlight
  }

  /**
   * 有缓存就立即返回缓存快照（后台刷新）；否则进行一次有界的读取。
   * 绝不等一个挂住的上游：每次 fetch 都带超时。
   */
  async function snapshot(force) {
    const fresh = state.cache.models !== null && Date.now() - state.cache.at < cacheMs
    if (fresh && !force) return view({})
    if (state.cache.models !== null) {
      void startRefresh()
      return view({ stale: true })
    }
    await startRefresh()
    if (state.cache.models === null) {
      return {
        available: false,
        cached: false,
        stale: false,
        sources: state.sources,
        fetchedAt: 0,
        ui: ui(),
        health: {
          lastFetchMs: state.lastFetchMs,
          lastError: state.lastError,
        },
        models: [],
        promotions: [],
        reason: state.lastError ?? 'unavailable',
      }
    }
    return view({ fetchedAt: state.cache.at })
  }

  /** 把一条客户端上报追加到 ~/.dsh/.cache 下的有界环形缓冲。 */
  async function appendDiagnostic(report) {
    try {
      await mkdir(cacheDir(), { recursive: true })
      const file = join(cacheDir(), 'dsh-model-info-client.json')
      let list = []
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (Array.isArray(parsed)) list = parsed
      } catch {
        // 首次上报
      }
      list.push({ receivedAt: Date.now(), ...report })
      if (list.length > DIAG_MAX) list = list.slice(-DIAG_MAX)
      while (list.length > 1 && Buffer.byteLength(JSON.stringify(list)) > DIAG_MAX_BYTES) list.shift()
      await writeFile(file, JSON.stringify(list), 'utf8')
    } catch {
      // 诊断是尽力而为，绝不能破坏数据通路
    }
  }

  function readBody(request, limit = DIAG_MAX_BYTES) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          request.destroy()
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', () => resolve(''))
    })
  }

  // 注册 loopback 路由。`ctx.inject` 会等到 webServer 存在，
  // 因此在没有 web 服务器的环境下加载本插件也是安全的。
  ctx.inject(['webServer'], (wsctx) => {
    // 记下真实 webServer：Qoder 状态路由的 loopback 请求要用它的 origin，
    // 而不是猜环境变量（桌面宿主端口是动态的）。
    web = wsctx.webServer
    wsctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const force = allowRefresh && url.searchParams.get('refresh') === '1'
        let payload
        try {
          payload = await snapshot(force)
        } catch (error) {
          payload = { available: false, reason: String(error?.message ?? error), models: [] }
        }
        payload.ui = ui()
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(payload))
      },
    })

    wsctx.webServer.register({
      kind: 'exact',
      path: HEALTH_ROUTE,
      handler: async (_request, response) => {
        const payload = {
          ok: true,
          available: state.cache.models !== null,
          models: state.cache.models?.length ?? 0,
          cacheAgeMs: state.cache.at ? Date.now() - state.cache.at : null,
          lastFetchMs: state.lastFetchMs,
          lastError: state.lastError,
          promotions: state.cache.promotions?.length ?? 0,
          sources: state.sources,
          inFlight: state.inFlight !== null,
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(payload))
      },
    })

    wsctx.webServer.register({
      kind: 'exact',
      path: DIAG_ROUTE,
      handler: async (request, response) => {
        if (diagnostics) {
          try {
            const text = await readBody(request)
            const parsed = text ? JSON.parse(text) : null
            if (parsed && typeof parsed === 'object') await appendDiagnostic(parsed)
          } catch {
            // 忽略格式不正确的上报
          }
        }
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      },
    })

    // 异步预热缓存；绝不阻塞启动，也绝不抛错。
    void snapshot(false).catch(() => {})
  })
}
