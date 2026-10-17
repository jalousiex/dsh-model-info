/**
 * dsh-model-info — host half.
 *
 * Exposes per-model metadata the CodeBuddy gateway publishes but dsh-tap
 * discards: the `credits` multiplier ("0.29x"), and, derived from it, the
 * zero-billing flag; plus the description / context window / reasoning
 * efforts / tags / trial banner / `craft` recommendation set.
 *
 * Everything shown is a field of that one live payload:
 * `descriptionZh`, `maxAllowedSize` (context), `reasoning.supportedEfforts`,
 * `tags`, `productFeaturesConfig.ModelTrialBanner`, `agents[].modelTags`.
 *
 * The local official VS Code extension's `product.json` used to be merged as a
 * supplement and is no longer read at all. Measured: that file carries a frozen
 * catalogue of 15 ids, only 4 of which are still served upstream and only 3
 * with descriptions, while /v3/config carries 11 descriptions over 33 models.
 * Upstream is both newer and more complete, so it is the only source — nothing
 * here can go stale because of a client version.
 *
 * Why a host half at all: the multiplier lives on
 *   GET {baseURL}/v3/config
 * which needs a credential (OAuth bearer or api key) and a UA that passes the
 * gateway's 12403 gate. The browser half cannot call it — the credential never
 * leaves this process, and a cross-origin call from the harness page would
 * need CORS the gateway does not send. So the host half fetches and caches,
 * and serves loopback routes for the client.
 *
 * Credential discovery is intentional and multi-source (no hard dependency on
 * any one plugin's storage):
 *   1. ~/.dsh/codebuddy-plugin-auth.json   {auth:{accessToken}}    (OAuth)
 *   2. ~/.dsh/codebuddy-plugin.json        {apiKeys,activeApiKey}  (api key)
 *   3. ~/.dsh/codebuddy-auth.json          {auth:{accessToken}}    (legacy)
 * The first candidate that answers /v3/config with code===0 wins and is
 * remembered; a rejected candidate is skipped. Nothing here is ever exposed
 * over a route — only the derived per-model numbers are.
 *
 * Hard rules (learned the hard way):
 *   - every upstream fetch carries AbortSignal.timeout; a hung gateway must
 *     never leave the route pending (the GUI's RPC shares the same origin and
 *     HTTP/1.1 has six connections).
 *   - a stale cache is served immediately and refreshed in the background;
 *     the client never waits on a cold gateway.
 *
 * Honesty constraint (see README): `credits` is the gateway's own *display*
 * multiplier. It is NOT a linear price — measured credit/1k tokens does not
 * track it. The one mapping upstream is verified for is x0.00 <=> zero
 * billing. We therefore expose the raw string plus a parsed number plus a
 * `free` boolean, and never claim "costs N times as much".
 *
 * Market tags (`限时免费` / `夜间免费` / `订阅优先` …) are NOT in /v3/config on
 * any product header we probed (CLI/CodeBuddy/IDE/WorkBuddy/CodeBuddyDesktop)
 * and are absent from the local official client bundles; we do not invent
 * them. Only fields the payload actually carries (`tags`, trial banner, the
 * `craft` agent model set) are surfaced.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const ROUTE = '/dsh-model-info/models'
const HEALTH_ROUTE = '/dsh-model-info/health'
const DIAG_ROUTE = '/dsh-model-info/diag'

/**
 * The UA the /v3/config gate checks. Only the `CodeBuddy/x.y` substring is
 * actually validated; the `CLI/unknown` prefix is folklore kept for request
 * shape parity with dsh-tap.
 */
const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'
const DEFAULT_BASE = 'https://copilot.tencent.com'
/** Credential choice is remembered for this long; a failure drops it. */
const CRED_TTL_MS = 10 * 60 * 1000
/** Client diagnostics ring: keep the file small (and .cache is sync-excluded). */
const DIAG_MAX = 60
const DIAG_MAX_BYTES = 64 * 1024

export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE),
  /** Cache lifetime for one upstream /v3/config read, in milliseconds. */
  cacheMs: z.number().step(1000).min(0).default(300000),
  /** Hard deadline for one upstream request (never omit this). */
  requestTimeoutMs: z.number().step(500).min(1000).default(8000),
  /** Allow the caller to force an upstream refetch via ?refresh=1. */
  allowRefresh: z.boolean().default(true),
  /** Render the badge next to the composer model name. */
  uiTrigger: z.boolean().default(true),
  /** Render rate + tags inside the /model dropdown rows. */
  uiMenu: z.boolean().default(true),
  /** Accept client diagnostic reports (browser state we cannot see from here). */
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
 * Parse the upstream `credits` display string.
 * "x0.51 credits" -> { multiplier: 0.51, free: false, raw: "x0.51 credits" }
 * "x0.00 credits" -> { multiplier: 0,    free: true,  ... }
 * "x1.62"         -> { multiplier: 1.62, free: false }   (some models omit the suffix)
 * Returns null when the shape is unrecognised, so a format change degrades
 * to "no data" instead of a wrong number.
 */
export function parseCredits(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.match(/x\s*(-?\d+(?:\.\d+)?)/i)
  if (!m) return null
  const multiplier = Number(m[1])
  if (!Number.isFinite(multiplier)) return null
  return { multiplier, free: multiplier === 0, raw }
}

/** Collect credential candidates from the known CodeBuddy stores, in order. */
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

/** First string among the candidates, trimmed; undefined when none is usable. */
function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** Effort list as published; tolerates the older single-`effort` shape. */
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
 * Normalize one upstream model record.
 *
 * Every field below is read from the /v3/config payload itself — nothing is
 * merged from a local client bundle, so a description or a context window is
 * never a leftover from an older catalogue. Fields the payload does not carry
 * stay undefined/null and the UI simply omits that line.
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
      // Prefer the credential that worked last time; re-probe after CRED_TTL.
      if (state.credKind && Date.now() - state.credAt < CRED_TTL_MS) {
        creds = [...creds].sort((a) => (a.kind === state.credKind ? -1 : 0))
      }
      for (const cred of creds) {
        try {
          const res = await fetch(`${baseURL}/v3/config`, {
            headers: {
              Accept: 'application/json',
              'User-Agent': USER_AGENT,
              // X-Product is folklore per dsh-tap's header notes; kept for parity.
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
   * Serve the cached snapshot immediately when one exists (refreshing in the
   * background); otherwise await one bounded upstream attempt. Never awaits a
   * hung gateway: every fetch carries a timeout.
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

  /** Append one client report to a bounded ring under ~/.dsh/.cache. */
  async function appendDiagnostic(report) {
    try {
      await mkdir(cacheDir(), { recursive: true })
      const file = join(cacheDir(), 'dsh-model-info-client.json')
      let list = []
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (Array.isArray(parsed)) list = parsed
      } catch {
        // first report
      }
      list.push({ receivedAt: Date.now(), ...report })
      if (list.length > DIAG_MAX) list = list.slice(-DIAG_MAX)
      while (list.length > 1 && Buffer.byteLength(JSON.stringify(list)) > DIAG_MAX_BYTES) list.shift()
      await writeFile(file, JSON.stringify(list), 'utf8')
    } catch {
      // diagnostics are best-effort and must never break the data path
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

  // Register the loopback routes. `ctx.inject` waits until webServer exists,
  // so the plugin is safe to load on surfaces without a web server.
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
            // ignore malformed reports
          }
        }
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      },
    })

    // Warm the cache asynchronously; never block boot and never throw.
    void snapshot(false).catch(() => {})
  })
}
