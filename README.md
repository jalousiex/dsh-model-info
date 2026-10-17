# dsh-model-info

Per-model metadata overlay for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): shows each CodeBuddy model's **upstream credit multiplier** (`0.29x`) and the tags the gateway actually publishes (`免费` / `文生图` / `图生图` / `试用` / `推荐`), right in the composer trigger and the `/model` dropdown rows.

## Why this plugin exists

The upstream CodeBuddy gateway publishes a per-model rate on `GET {baseURL}/v3/config`:

```json
{ "id": "deepseek-v4-pro", "credits": "x0.51 credits", ... }
```

`dsh-tap` fetches that same endpoint but **discards `credits`** when it projects the catalogue — so the multiplier exists upstream yet never reaches the UI. This plugin fetches it again and surfaces it.

## What is shown (and what is not)

**Every field below is read from that one live payload.** Nothing is merged from a local client bundle any more, so no description or context window can be a leftover from an older catalogue. The UI keeps **one line per model row**; everything except the single `免费`/rate badge goes into the hover tooltip.

| UI | Source field on `/v3/config` |
| --- | --- |
| row rate `0.29x` / trigger badge | `models[].credits` (verified against the official CodeBuddy list, one-to-one) |
| `免费` | `credits == x0.00` — the one hard mapping upstream is confirmed for |
| tooltip 描述 | `models[].descriptionZh` (falls back to `descriptionEn`) |
| tooltip 上下文 | `models[].maxAllowedSize` → `maxInputTokens` |
| tooltip 思考档 | `models[].reasoning.supportedEfforts` (older single `reasoning.effort` tolerated) |
| tooltip 标签 `文生图` / `图生图` / `推荐` / `试用 N 天` | `models[].tags`, `agents[].modelTags` containing `craft`, `productFeaturesConfig.ModelTrialBanner` |

Measured on 2026-10-17: the payload carries 33 models and 11 of them publish `descriptionZh` directly (including `deepseek-v4-pro`). The local official VS Code extension's `product.json` carries a frozen list of 15 ids — only 4 still served upstream, only 3 with descriptions — so it was **removed** as a source (`readOfficialCatalog()` is gone).

**Not shown, deliberately: `限时免费` / `独家限免` / `夜间免费` / `夜间折扣` / `订阅优先`.**

Verified again after removing the local merge: no field of `/v3/config` carries them (union of model fields:
`credits,id,name,tags,iconUrl,descriptionZh,descriptionEn,maxAllowedSize,maxInputTokens,maxOutputTokens,
reasoning{effort,summary,supportedEfforts,defaultEffort,canDisableThinking},relatedModels,supportsImages,
supportsToolCall,vendor,temperature,…`), the official extension's `out/` bundle (191 files) contains none of those
strings, and the only other config route the extension calls (`/v3/config/llm_data`) requires a `featureName`
that the extension only ever sends for SQL-table sampling — not model metadata. Inventing a label from
`credits` (e.g. "credits < 1 ⇒ 折扣") would be a made-up rule, so it is not implemented. If an endpoint that
does publish them shows up, add an adapter here.

## 倍率 semantics — read this before trusting the number

`credits` is the gateway's own **display** ratio.

- ✅ `x0.00` ⟺ **zero billing** — the one hard mapping upstream is confirmed for.
- ⚠️ It is **not** a linear price. Measured `credit / 1k tokens` does not track it
  (e.g. `x0.51` does not mean "half the cost of `x1.00`").

So the plugin shows the raw rate with a tooltip stating it is a display rate, and never
renders "costs N× as much".

## Credentials — no dependency on any single plugin

The host half probes these stores, in order, and remembers the first one that answers:

1. `~/.dsh/codebuddy-plugin-auth.json` → `auth.accessToken` (OAuth bearer)
2. `~/.dsh/codebuddy-plugin.json` → `apiKeys[activeApiKey]` (bearer + `x-api-key`)
3. `~/.dsh/codebuddy-auth.json` → `auth.accessToken` (legacy)

A rejected candidate (HTTP 401/403, non-zero `code`) is skipped; when none works the route
reports `available: false` and the UI simply shows no badges. The credential never leaves
the host process — routes only serve derived numbers.

`baseURL` resolves from the plugin config, then dsh-tap's saved `baseURL` (1.5s probe),
then `https://copilot.tencent.com`.

## Routes

- `GET /dsh-model-info/models` — `{ available, cached, stale, source, baseURL, fetchedAt, ui:{trigger,menu}, health:{...}, models:[{id,name,credits,rate,free,tags,craft,trial,descriptionZh,contextWindow,efforts}] }`
  - `?refresh=1` forces a refetch (config `allowRefresh`).
  - A cached snapshot is served **immediately** (stale-while-revalidate); the client never waits on a cold gateway.
- `GET /dsh-model-info/health` — fetch latency / last error / cache age / credential source (no secrets).
- `POST /dsh-model-info/diag` — client diagnostic reports → `~/.dsh/.cache/dsh-model-info-client.json` (ring, 60 entries / 64KB).

Every upstream request carries `AbortSignal.timeout(requestTimeoutMs)`; a hung gateway can
never leave the route pending (the GUI's RPC shares the origin and HTTP/1.1 has six
connections).

## DOM discipline (the freeze fix)

The old client observed `class` changes across `document.body` and re-scanned the whole
document from every mutation, inserting nodes inside the model menu. That is what froze the
model list. Now:

- observer = `childList + subtree` + `attributeFilter: ["aria-label","aria-checked","aria-expanded"]` — **never `class`**;
- mutation callbacks inspect only the added subtree; one full scan runs once at install;
- one rAF-coalesced pass; per-node idempotency via `WeakMap`;
- badges are `pointer-events:none` + `aria-hidden`; the row keeps exactly **one** badge (`免费` or the rate) placed at the end of the row — before the check column when they share a line, otherwise as the row's last child — so the row never wraps and the model name never loses width;
- `ui.trigger=false` / `ui.menu=false` turns each area off (config, host-provided).

## Config

| key | default | meaning |
| --- | --- | --- |
| `baseURL` | `https://copilot.tencent.com` | gateway origin |
| `cacheMs` | `300000` | upstream cache lifetime |
| `requestTimeoutMs` | `8000` | hard deadline per upstream request |
| `allowRefresh` | `true` | permit `?refresh=1` |
| `uiTrigger` | `true` | badge next to the composer model name |
| `uiMenu` | `true` | one rate/`免费` badge + hover detail inside `/model` rows |
| `diagnostics` | `true` | accept client diagnostic reports |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs        # parseCredits / normalizeModel / client internals / DOM-discipline asserts
```

## License

MIT
