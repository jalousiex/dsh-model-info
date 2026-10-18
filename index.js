/**
 * dsh-model-info —— 宿主半（host half）。
 *
 * 职责：暴露 CodeBuddy 网关**发布了但 dsh-tap 丢掉**的每模型元信息：
 * `credits` 倍率（如 "0.29x"）、由它推导出的「是否计费」标志，
 * 以及描述 / 上下文窗口 / 思考档 / 标签 / 试用横幅 / `craft` 推荐集合。
 *
 * 展示的所有字段都来自**同一个实时响应**：
 * `descriptionZh`、`maxAllowedSize`（上下文）、`reasoning.supportedEfforts`、
 * `tags`、`productFeaturesConfig.ModelTrialBanner`、`agents[].modelTags`。
 *
 * 本机官方 VS Code 扩展的 `product.json` 曾作为补充被合并，**现在完全不读**。
 * 实测依据：那份文件是一份冻结目录，15 个 id 里只有 4 个仍在上游列表中、
 * 只有 3 个带描述；而 /v3/config 在 33 个模型上带了 11 条描述。
 * 上游既更新又更全，故作为唯一来源 —— 这里的内容不会因客户端版本而陈旧。
 *
 * 为什么必须有宿主半：倍率位于
 *   GET {baseURL}/v3/config
 * 该接口需要凭据（OAuth bearer 或 api key）以及能过网关 12403 校验的 UA。
 * 浏览器半无法直接调用 —— 凭据绝不离开本进程，而从 harness 页面发起跨域请求
 * 还需要网关并不发送的 CORS 头。所以由宿主半抓取、缓存，并以 loopback 路由服务客户端。
 *
 * 凭据探测是**刻意多源**的（不硬依赖任何单一插件的存储）：
 *   1. ~/.dsh/codebuddy-plugin-auth.json   {auth:{accessToken}}    （OAuth）
 *   2. ~/.dsh/codebuddy-plugin.json        {apiKeys,activeApiKey}  （api key）
 *   3. ~/.dsh/codebuddy-auth.json          {auth:{accessToken}}    （旧格式）
 * 第一个以 code===0 应答 /v3/config 的候选获胜并被记住；被拒的候选跳过。
 * 任何凭据都不经路由暴露 —— 只输出推导后的每模型数字。
 *
 * 硬规则（踩坑换来的）：
 *   · 每次上游请求都带 AbortSignal.timeout；网关挂住绝不让路由挂起
 *     （GUI 的 RPC 同源，且 HTTP/1.1 只有 6 条连接）。
 *   · 过期缓存立即返回、后台刷新；客户端绝不等一个冷启动的网关。
 *
 * 诚实约束（详见 README）：`credits` 是网关自己的**展示**倍率，
 * **不是线性价格** —— 实测 credit/1k tokens 并不随它线性变化。
 * 上游唯一被验证过的硬映射是 x0.00 <=> 不计费。
 * 因此我们同时给出原始字符串、解析后的数字和 `free` 布尔值，
 * 但绝不宣称「贵 N 倍」。
 *
 * ## 促销标签（`限时免费` / `夜间免费` / `夜间折扣` / `独家限免` / `订阅优先`）
 *
 * 早期结论是"网关不发布它们"，**该结论已被推翻**：`/v3/config` 的载荷**按
 * `User-Agent` 里的产品名分发行情**——同一个 token、同一个 URL，UA 不同，
 * `data` 的键集合与模型条数都不同（2026-10-17 实测）：
 *
 * | UA | models | data 键 |
 * |---|---|---|
 * | `CLI/unknown CodeBuddy/2.136.0`（dsh-tap 同款） | 33 | 只有 agents/models/productFeatures* |
 * | `CodeBuddyIDE/4.12.0`（官方 IDE 扩展） | 22 | 多出 `modelPromotions` / `modelTiers` / `featureToggles` … |
 * | `WorkBuddy/5.7.2 CLI/2.156.0` | 60 | 同样的 `modelPromotions` / `modelTiers` |
 *
 * 所以本插件发**两次** `/v3/config`：
 *   1. **目录请求**用 dsh-tap 同款 UA —— 必须如此，否则拿到的模型集合与
 *      宿主里真正可选的模型对不上（`hy4-preview-x` 这类条目在不同视图里
 *      时有时无，且只有 CLI 视图与 llm-pi-ai 的清单同源）；
 *   2. **活动请求**用 `CodeBuddyIDE/…` UA —— 只为取 `modelPromotions` 与
 *      `modelTiers`，**不参与**模型集合。
 * 活动请求失败时静默降级（目录照常出徽标，促销为空），绝不因此让路由失败。
 *
 * `modelPromotions[]` 的形状（实测，逐字段照抄，不臆造）：
 *   { id, kind:'discount', enabled, priority, modelIds[],
 *     badge:{ color, label, labelEn, shortLabel, display:'activeOnly'|'always', icon },
 *     hover:{ textZh, textEn, action:{ labelZh, type } },
 *     discount:{ discountedCredits:'0.50x'|'0x', displayMode, factor },
 *     schedule:{ timezone:'Asia/Shanghai', validFrom, validUntil,
 *                daily:[{ start:'23:00', end:'7:50' }] } }
 * 「夜间」不是独立字段——它就是 `schedule.daily` 的每日时段窗口 + `timezone`。
 * `modelTiers` 给出「订阅优先」这类按用户等级生效的徽标。
 * 二者都是**服务端下发**的：我们只做时段判定与择优（priority 高者胜），
 * 标签文案一个字都不自己编。
 */


import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const ROUTE = '/dsh-model-info/models'
const HEALTH_ROUTE = '/dsh-model-info/health'
const DIAG_ROUTE = '/dsh-model-info/diag'

/**
 * 目录请求的 UA。/v3/config 的 UA 门是子串匹配 `/codebuddy\/[^a-z\s]*\./i`；
 * 与 dsh-tap（providers/codebuddy/headers.js）保持同款是刻意的——
 * 网关按 UA 分发行情，换个 UA 拿到的就不是同一个模型集合。
 */
const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'
/**
 * 活动请求的 UA（官方 IDE 扩展同款）。只有带这个产品名的响应才携带
 * `modelPromotions` / `modelTiers`；**绝不**用它取模型集合——它会多出
 * `hy4-preview-ctrl` / `hy3-b` / `codewise-*` 等宿主里并不存在的条目。
 */
const PROMO_USER_AGENT = 'CodeBuddyIDE/4.12.0'
const DEFAULT_BASE = 'https://copilot.tencent.com'
/** 凭据选择的记忆时长；失败即丢弃。 */
const CRED_TTL_MS = 10 * 60 * 1000
/** 客户端诊断环形缓冲：文件要小（且 .cache 已被排除同步）。 */
const DIAG_MAX = 60
const DIAG_MAX_BYTES = 64 * 1024

export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE),
  /** 单次上游 /v3/config 读取的缓存存活时长，毫秒。 */
  cacheMs: z.number().step(1000).min(0).default(300000),
  /** 单次上游请求的硬性超时（绝不能省）。 */
  requestTimeoutMs: z.number().step(500).min(1000).default(8000),
  /** 允许调用方用 ?refresh=1 强制重新抓取上游。 */
  allowRefresh: z.boolean().default(true),
  /** 是否在输入框旁的模型名后渲染徽标。 */
  uiTrigger: z.boolean().default(true),
  /** 是否在 /model 下拉行内渲染倍率与标签。 */
  uiMenu: z.boolean().default(true),
  /** 是否额外发一次 IDE-UA 请求去取 `modelPromotions` / `modelTiers`。 */
  promotions: z.boolean().default(true),
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

/** 按顺序从已知的 CodeBuddy 存储处收集候选凭据。 */
export async function detectCredentials(home = dshHome()) {
  const out = []
  const oauth = await readJson(join(home, 'codebuddy-plugin-auth.json'))
  const token = oauth?.auth?.accessToken
  if (typeof token === 'string' && token.length > 0) {
    out.push({ kind: 'oauth', headers: { Authorization: `Bearer ${token}` } })
  }

  const cfg = await readJson(join(home, 'codebuddy-plugin.json'))
  if (cfg) {
    const keys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : []
    const active = keys.find((k) => k && k.name === cfg.activeApiKey)
    const key = active?.key || keys[0]?.key || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : '')
    if (typeof key === 'string' && key.length > 0) {
      out.push({ kind: 'api-key', headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } })
    }
  }

  const legacy = await readJson(join(home, 'codebuddy-auth.json'))
  const legacyToken = legacy?.auth?.accessToken
  if (typeof legacyToken === 'string' && legacyToken.length > 0) {
    out.push({ kind: 'oauth-legacy', headers: { Authorization: `Bearer ${legacyToken}` } })
  }
  return out
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
  const baseURL = (typeof config.baseURL === 'string' && config.baseURL.trim()) || DEFAULT_BASE
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 300000
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 8000
  const allowRefresh = config.allowRefresh !== false
  const diagnostics = config.diagnostics !== false
  const usePromotions = config.promotions !== false

  const state = {
    cache: { at: 0, models: null, promotions: [] },
    inFlight: null,
    credKind: null,
    credAt: 0,
    lastError: null,
    lastFetchMs: null,
    /** 上一次活动视图（promotions）抓取的结果，供 /health 观察。 */
    promoError: null,
  }

  const ui = () => ({ trigger: config.uiTrigger !== false, menu: config.uiMenu !== false })

  /** 一次 /v3/config；超时与凭据都在这里，调用方只管解析。 */
  async function fetchConfig(cred, userAgent) {
    const res = await fetch(`${baseURL}/v3/config`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent,
        // X-Product 按 dsh-tap 的头部说明属社区惯例；保留以保持一致。
        'X-Product': 'SaaS',
        ...cred.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`upstream-http-${res.status}`)
    const body = await res.json()
    if (body?.code !== 0) throw new Error(`upstream-${body?.code}`)
    return body
  }

  async function fetchUpstream() {
    const started = Date.now()
    try {
      let creds = await detectCredentials()
      if (creds.length === 0) {
        state.lastError = 'no-credential'
        return null
      }
      // 优先用上次成功的凭据；超过 CRED_TTL 后重新探测。
      if (state.credKind && Date.now() - state.credAt < CRED_TTL_MS) {
        creds = [...creds].sort((a) => (a.kind === state.credKind ? -1 : 0))
      }
      for (const cred of creds) {
        try {
          const body = await fetchConfig(cred, USER_AGENT)
          const agents = Array.isArray(body.data?.agents) ? body.data.agents : []
          const craftSet = new Set(
            agents
              .filter((a) => Array.isArray(a?.modelTags) && a.modelTags.includes('craft'))
              .flatMap((a) => (Array.isArray(a.models) ? a.models : [])),
          )
          const trial = body.data?.productFeaturesConfig?.ModelTrialBanner?.banners?.[0] ?? null
          const models = (Array.isArray(body.data?.models) ? body.data.models : [])
            .filter((m) => typeof m?.id === 'string')
            .map((m) => normalizeModel(m, trial, craftSet))
          state.credKind = cred.kind
          state.credAt = Date.now()
          state.lastError = null
          // 活动视图是**增强**，不是依赖：失败只留 promoError，目录照常返回。
          const promotions = await fetchPromotions(cred)
          return { models, source: cred.kind, promotions }
        } catch (error) {
          state.lastError = String(error?.message ?? error)
        }
      }
      return null
    } finally {
      state.lastFetchMs = Date.now() - started
    }
  }

  /**
   * 第二次请求：换 IDE 产品名的 UA，只为取 `modelPromotions` / `modelTiers`。
   * 该视图的模型集合与宿主可选清单不同源（多出 -ctrl/-b/codewise-* 等），
   * 所以**绝不**用它替换目录。失败一律静默降级为空数组。
   */
  async function fetchPromotions(cred) {
    if (!usePromotions) return []
    try {
      const body = await fetchConfig(cred, PROMO_USER_AGENT)
      const list = collectPromotions(body.data)
      state.promoError = null
      return list
    } catch (error) {
      state.promoError = String(error?.message ?? error)
      // 保留上一次成功的活动数据（如果有），避免一次抖动抹掉徽标。
      return Array.isArray(state.cache.promotions) ? state.cache.promotions : []
    }
  }

  /**
   * 缓存里的 `active` 是抓取那一刻算的，而夜间窗口的边界是 23:00 / 8:00 ——
   * 5 分钟缓存足以跨过边界。所以**每次读取都按当前时刻重算**这一位，
   * 其余字段（文案、倍率、时段定义）沿用缓存，一次都不多打上游。
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
      source: state.credKind,
      baseURL,
      fetchedAt: state.cache.at,
      ui: ui(),
      health: {
        lastFetchMs: state.lastFetchMs,
        lastError: state.lastError,
        promoError: state.promoError,
      },
      models: state.cache.models ?? [],
      promotions: livePromotions(),
      ...extra,
    }
  }

  function startRefresh() {
    if (state.inFlight) return state.inFlight
    state.inFlight = fetchUpstream()
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
   * 有缓存就立即返回缓存快照（后台刷新）；否则进行一次有界的上游尝试。
   * 绝不等一个挂住的网关：每次 fetch 都带超时。
  
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
        source: state.credKind,
        baseURL,
        fetchedAt: 0,
        ui: ui(),
        health: {
          lastFetchMs: state.lastFetchMs,
          lastError: state.lastError,
          promoError: state.promoError,
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
          promoError: state.promoError,
          promotions: state.cache.promotions?.length ?? 0,
          source: state.credKind,
          baseURL,
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
