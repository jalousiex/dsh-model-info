/**
 * dsh-model-info — host half.
 *
 * Exposes per-model metadata the upstream CodeBuddy gateway publishes but
 * dsh-tap discards: the `credits` multiplier ("x0.51 credits") and, derived
 * from it, a zero-billing flag.
 *
 * Why a host half at all: the multiplier lives on
 *   GET https://copilot.tencent.com/v3/config
 * which requires a credential (OAuth Bearer) and a UA that passes the
 * gateway's 12403 gate. The browser half cannot call it — the credential
 * never leaves this process, and a cross-origin call to copilot.tencent.com
 * from the harness page would need CORS the gateway does not send. So the
 * host half fetches and caches, and serves a loopback route for the client.
 *
 * Credential: read from ~/.dsh/codebuddy-plugin-auth.json — the same OAuth
 * token dsh-tap uses. No credential is exposed over the route; only the
 * derived per-model numbers are.
 *
 * Honesty constraint (see README): `credits` is the gateway's own *display*
 * multiplier. It is NOT a linear price — measured credit/1k tokens does not
 * track it. The one mapping upstream is verified for is x0.00 <=> zero
 * billing. We therefore expose the raw string plus a parsed number plus a
 * `free` boolean, and never claim "costs N times as much".
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const ROUTE = '/dsh-model-info/models'

/**
 * The UA the /v3/config gate checks. Only the `CodeBuddy/x.y` substring is
 * actually validated (case-insensitive, version just needs a dot); the
 * `CLI/unknown` prefix is folklore dsh-tap keeps, and we keep it too so our
 * request looks identical to theirs.
 */
const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'

/** Where dsh-tap keeps the CodeBuddy OAuth credential. */
function authFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'codebuddy-plugin-auth.json')
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export const Config = z.object({
  baseURL: z.string().default('https://copilot.tencent.com'),
  /** Cache lifetime for one upstream /v3/config read, in milliseconds. */
  cacheMs: z.number().step(1000).min(0).default(300000),
  /** Allow the caller to force an upstream refetch via ?refresh=1. */
  allowRefresh: z.boolean().default(true),
})

export const name = 'dsh-model-info'

/**
 * Parse the upstream `credits` display string.
 * "x0.51 credits" -> { multiplier: 0.51, free: false, raw: "x0.51 credits" }
 * "x0.00 credits" -> { multiplier: 0,    free: true,  ... }
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

export function apply(ctx, config = {}) {
  const baseURL = config.baseURL
  const cacheMs = config.cacheMs
  const allowRefresh = config.allowRefresh

  let cache = { at: 0, models: null, error: null }
  let inFlight = null

  /**
   * Read the OAuth token the same way dsh-tap does. Returns null when
   * dsh-tap has not logged in — the route then reports `available: false`
   * instead of failing, so the UI just hides the badges.
   */
  async function readToken() {
    try {
      const raw = await readFile(authFile(), 'utf8')
      const parsed = JSON.parse(raw)
      const token = parsed?.auth?.accessToken
      return typeof token === 'string' && token.length > 0 ? token : null
    } catch {
      return null
    }
  }

  async function fetchUpstream() {
    const token = await readToken()
    if (!token) {
      return { available: false, reason: 'no-credential', models: [] }
    }
    const res = await fetch(`${baseURL}/v3/config`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        // X-Product is folklore per dsh-tap's own header notes; kept for
        // request-shape parity with dsh-tap.
        'X-Product': 'SaaS',
      },
    })
    if (!res.ok) {
      return { available: false, reason: `upstream-http-${res.status}`, models: [] }
    }
    const body = await res.json()
    if (body?.code !== 0) {
      return { available: false, reason: `upstream-${body?.code}`, models: [] }
    }
    const models = (body.data?.models ?? []).map((m) => {
      const parsed = parseCredits(m.credits)
      return {
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        ...(parsed
          ? { multiplier: parsed.multiplier, free: parsed.free, credits: parsed.raw }
          : { multiplier: null, free: false, credits: null }),
      }
    })
    return { available: true, models, fetchedAt: Date.now() }
  }

  /**
   * Serve the cached snapshot, refreshing when stale or forced. A refresh
   * that throws returns the last good snapshot when there is one: a metadata
   * badge must never take the host down.
   */
  async function snapshot(force) {
    const fresh = cache.models !== null && Date.now() - cache.at < cacheMs
    if (!fresh || force) {
      if (inFlight === null) {
        inFlight = fetchUpstream()
          .then((result) => {
            if (result.available) cache = { at: Date.now(), models: result.models, error: null }
            else cache.error = result.reason
            return result
          })
          .finally(() => {
            inFlight = null
          })
      }
      try {
        const result = await inFlight
        if (result.available) return { ...result, cached: false }
      } catch (error) {
        cache.error = String(error?.message ?? error)
      }
      if (cache.models !== null) {
        return { available: true, models: cache.models, fetchedAt: cache.at, cached: true }
      }
      return { available: false, reason: cache.error ?? 'unavailable', models: [] }
    }
    return { available: true, models: cache.models, fetchedAt: cache.at, cached: true }
  }

  // Register the loopback route. `ctx.inject` waits until webServer exists,
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
        const body = JSON.stringify(payload)
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(body)
      },
    })
    // Warm the cache so the first UI paint has data. Failure is non-fatal.
    snapshot(false).catch(() => {})
  })
}
