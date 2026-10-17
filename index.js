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
 * 营销标签（`限时免费` / `夜间免费` / `订阅优先` …）在我们探测过的所有
 * X-Product 头（CLI/CodeBuddy/IDE/WorkBuddy/CodeBuddyDesktop）的 /v3/config 里都不存在，
 * 本机官方客户端包中也没有；**我们不编造它们**。
 * 只输出载荷真的携带的字段（`tags`、试用横幅、`craft` agent 模型集合）。
 */


import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const ROUTE = '/dsh-model-info/models'
const HEALTH_ROUTE = '/dsh-model-info/health'
const DIAG_ROUTE = '/dsh-model-info/diag'

/**
 * /v3/config 门禁校验的 UA。实际只验证 `CodeBuddy/x.y` 子串；
 * `CLI/unknown` 前缀只是社区惯例，保留它是为了与 dsh-tap 的请求形态一致。

 */
const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'
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

export function apply(ctx, config = {}) {
  const baseURL = (typeof config.baseURL === 'string' && config.baseURL.trim()) || DEFAULT_BASE
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 300000
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 8000
  const allowRefresh = config.allowRefresh !== false
  const diagnostics = config.diagnostics !== false

  const state = {
    cache: { at: 0, models: null },
    inFlight: null,
    credKind: null,
    credAt: 0,
    lastError: null,
    lastFetchMs: null,
  }

  const ui = () => ({ trigger: config.uiTrigger !== false, menu: config.uiMenu !== false })

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
          const res = await fetch(`${baseURL}/v3/config`, {
            headers: {
              Accept: 'application/json',
              'User-Agent': USER_AGENT,
              // X-Product 按 dsh-tap 的头部说明属社区惯例；保留以保持一致。
              'X-Product': 'SaaS',
              ...cred.headers,
            },
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!res.ok) {
            state.lastError = `upstream-http-${res.status}`
            continue
          }
          const body = await res.json()
          if (body?.code !== 0) {
            state.lastError = `upstream-${body?.code}`
            continue
          }
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
          return { models, source: cred.kind }
        } catch (error) {
          state.lastError = String(error?.message ?? error)
        }
      }
      return null
    } finally {
      state.lastFetchMs = Date.now() - started
    }
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
      health: { lastFetchMs: state.lastFetchMs, lastError: state.lastError },
      models: state.cache.models ?? [],
      ...extra,
    }
  }

  function startRefresh() {
    if (state.inFlight) return state.inFlight
    state.inFlight = fetchUpstream()
      .then((result) => {
        if (result) state.cache = { at: Date.now(), models: result.models }
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
        health: { lastFetchMs: state.lastFetchMs, lastError: state.lastError },
        models: [],
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
