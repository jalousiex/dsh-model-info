# dsh-model-info

Per-model metadata overlay for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): shows each CodeBuddy model's **upstream credit multiplier** (`0.29x`) and the tags the gateway actually publishes (`免费` / `文生图` / `图生图` / `试用` / `推荐`), right in the composer trigger and the `/model` dropdown rows — plus the gateway's own **promotion badges** (`夜间免费` / `限时免费` / `夜间折扣` / `独家限免` / `订阅优先`), which come from `modelPromotions` / `modelTiers` and are **never invented locally**. Every extra field is shown in a self-drawn hover card.

## Why this plugin exists

The upstream CodeBuddy gateway publishes a per-model rate on `GET {baseURL}/v3/config`:

```json
{ "id": "deepseek-v4-pro", "credits": "x0.51 credits", ... }
```

`dsh-tap` fetches that same endpoint but **discards `credits`** when it projects the catalogue — so the multiplier exists upstream yet never reaches the UI. This plugin fetches it again and surfaces it.

## What is shown (and what is not)

**Every field below is read from that live payload.** Nothing is merged from a local client bundle any more, so no description or context window can be a leftover from an older catalogue. The UI keeps **one line per model row**; everything except the compact badges goes into the hover card.

| UI | Source field on `/v3/config` |
| --- | --- |
| row rate `0.29x` / trigger badge | `models[].credits` (verified against the official CodeBuddy list, one-to-one) |
| `免费` | `credits == x0.00` — the one hard mapping upstream is confirmed for |
| hover 描述 | `models[].descriptionZh` (falls back to `descriptionEn`) |
| hover 上下文 | `models[].maxAllowedSize` → `maxInputTokens` |
| hover 思考档 | `models[].reasoning.supportedEfforts` (older single `reasoning.effort` tolerated) |
| hover 标签 `文生图` / `图生图` / `推荐` / `试用 N 天` | `models[].tags`, `agents[].modelTags` containing `craft`, `productFeaturesConfig.ModelTrialBanner` |
| **促销徽标** `夜间免费` / `限时免费` / `夜间折扣` / `独家限免` / `错峰使用` | **`data.modelPromotions[]`** — `badge.label` / `badge.color`, active only inside `schedule.daily` |
| **档位徽标** `订阅优先` | **`data.modelTiers`** (object or array; both observed) |
| **折扣后的倍率** | `modelPromotions[].discount.factor` / `.discountedCredits`，原价按 `displayMode:'strikethrough'` 划线 |

Measured on 2026-10-17: the payload carries 33 models and 11 of them publish `descriptionZh` directly (including `deepseek-v4-pro`). The local official VS Code extension's `product.json` carries a frozen list of 15 ids — only 4 still served upstream, only 3 with descriptions — so it was **removed** as a source (`readOfficialCatalog()` is gone).

## Promotions: the gateway **distributes `/v3/config` by User-Agent**

An earlier revision of this README claimed the gateway never publishes `限时免费` / `夜间免费` /
`夜间折扣` / `订阅优先`. **That was wrong, and the reason is worth writing down:** `/v3/config`
returns a *different payload* depending on the product name in the `User-Agent`. Same token, same URL:

| `User-Agent` | `models` | carries `modelPromotions`? |
| --- | --- | --- |
| `CLI/unknown CodeBuddy/2.136.0` (dsh-tap's) | 33 | ❌ — `data` has only `agents`, `models`, `productFeatures*` |
| `CodeBuddyIDE/4.12.0` (official VS Code extension) | 22 | ✅ |
| `WorkBuddy/5.7.2 CLI/2.156.0` | 60 | ✅ |

So the plugin makes **two** requests:

1. **catalog** with the dsh-tap UA — mandatory. The other views contain ids the host cannot actually
   serve (`hy4-preview-ctrl`, `hy3-b`, `codewise-*`, …), so using them would desync from `llm-pi-ai`.
2. **promotions** with `CodeBuddyIDE/…` — only for `modelPromotions` / `modelTiers`; it never
   contributes models. A failure here is silent (`health.promoError`), the badges simply go away.

`modelPromotions[]` as observed live (nothing here is invented):

```json
{ "id": "hy4-night-discount-daytime-badge-202609", "kind": "discount", "enabled": true,
  "priority": 100, "modelIds": ["hy4-preview"],
  "badge":  { "color": "#1E90FF", "label": "夜间免费", "display": "activeOnly" },
  "hover":  { "textZh": "9月11日–10月31日，每晚 23:00—次日 8:00 享免费额度。" },
  "discount": { "discountedCredits": "0.00x", "factor": 0 },
  "schedule": { "timezone": "Asia/Shanghai", "validUntil": "2026-11-01T00:00:00+08:00",
                "daily": [{ "start": "23:00", "end": "8:00" }] } }
```

"夜间" is not a field of its own — it is `schedule.daily` (a `[start, end)` window that may cross
midnight) plus `schedule.timezone`. The plugin only parses those windows and picks the highest
`priority`; the label text, colour and hover copy are served as-is. `badge.display: "activeOnly"`
means "show only while the window is open"; everything else stays as a dim outline.

Because `active` depends on the clock, it is **recomputed on every read** (a 5-minute cache easily
straddles 23:00), and the browser half re-sweeps once a minute *only* when a promotion actually flips.

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

- `GET /dsh-model-info/models` — `{ available, cached, stale, source, baseURL, fetchedAt, ui:{trigger,menu}, health:{...}, models:[{id,name,credits,rate,free,tags,craft,trial,descriptionZh,contextWindow,efforts}], promotions:[{id,kind,priority,enabled,modelIds,label,shortLabel,color,activeOnly,hover,factor,schedule,active}] }`
  - `?refresh=1` forces a refetch (config `allowRefresh`).
  - A cached snapshot is served **immediately** (stale-while-revalidate); the client never waits on a cold gateway.
- `GET /dsh-model-info/health` — fetch latency / last error / cache age / credential source (no secrets).
- `POST /dsh-model-info/diag` — client diagnostic reports → `~/.dsh/.cache/dsh-model-info-client.json` (ring, 60 entries / 64KB).

Every upstream request carries `AbortSignal.timeout(requestTimeoutMs)`; a hung gateway can
never leave the route pending (the GUI's RPC shares the origin and HTTP/1.1 has six
connections).

## 悬浮卡里有什么（以及为什么不再有原生 `title`）

宿主自己在模型行与输入框触发器上都放了 `title="模型名"`。留着它，鼠标停在模型上
不动就会**先弹一个原生提示**，再叠上我们的自绘卡 —— 这就是「两个提示重复」的来源。
所以装饰一行时先摘掉宿主的 `title`（记住原值，卸载时原样还回去）。

自绘卡的字段顺序：描述 → **消耗速度**（折扣时按上游 `displayMode:'strikethrough'`
划掉原价）→ **折扣**（活动未生效时把「折扣后 0.5x / 原价 0.79x」单列一行 —— 行内
徽标只是预告，看不出价）→ 试用 → 思考强度 → 上下文 → 图片 → 能力 / 标签，最后是
**每条活动各一个框**：徽标文案 + 生效时段 + 上游原说明。

时段由 `schedule.daily` 拼出（`每天 23:00–07:50（次日）`）：跨零点标「次日」，
`00:00–23:59` 这种整天窗口不啰嗦地写「每天」，有 `validFrom/validUntil` 时补起止日。
上游文案一个字都不改写。

同一个活动服务端常发**两条**：夜间那条带 `discount.factor`，白天的常驻预告位
（`activeOnly:false`、不带 factor）不给价。行内按 priority 只留一条，悬浮卡也只列
一条（带 factor 的那条），否则「夜间折扣」会重复出现两遍。

## 热区只在模型名上

热区原来挂在整个行容器 / 整个触发器上 —— 鼠标想去点别的模型，先被弹卡挡住。
现在只挂名字元素本身：名字容器默认是撑满整行的 flex 项（或整段标签），直接用它当
热区还是整行，所以给它加一个 `width:fit-content` 的类把宽度收到文字那么宽
（`max-width:100%` 保住长名的省略号截断）。行高与「整行可点」都不变，徽标插在它
后面、不进热区。

两个踩过的坑，都写在这一行 CSS 上：

- **不能加 `flex:none`**：触发器标签靠 `flex-shrink` 收缩才能出省略号，加了它触发器
  会被撑破。
- **没徽标时也必须留热区**：图片模型上游不给 `credits`，一个徽标都没有。之前「没徽标
  就不建热区」，再叠加摘掉宿主原生 `title`，悬浮入口就整个没了 —— 这就是「详细提示
  消失」的直接原因。热区现在只取决于「这个模型认不认得出来」，与有没有徽标无关。

## 同名条目按 `data-model-id` 区分，不按名字

`DeepSeek 账号` 与 `CodeBuddy` 两个分组里都有 `DeepSeek-V4-Pro`：显示名一样，却是
不同条目、倍率也不同。只按名字解析会把一个分组的倍率贴到另一个分组的行上。

所以解析顺序是：先取宿主写在行上的 `data-model-id`（权威），取不到才退回文本；退回
文本时，只有当这个显示名在**整份目录里只出现一次**才认 —— 重名一律放弃，宁可这一行
没有额外信息，也不串组。

## 模型顺序：只把 `auto` 钉到分组首位

模型顺序是**宿主目录的顺序**（`orderModelProviders` 只排分组，`rankByName` 在查询
为空时原样返回），插件没有上游接口可改。所以插件侧只做一件事：把
`data-model-id="auto"`（或显示名 `Auto`）那一行搬到**它自己分组的第一行**，其余行的
相对顺序一个都不动，卸载时按记下的原位置放回去。目录里没有 `auto` 时完全不动 DOM。

## DOM discipline (the freeze fix)

The old client observed `class` changes across `document.body` and re-scanned the whole
document from every mutation, inserting nodes inside the model menu. That is what froze the
model list. Now:

- observer = `childList + subtree` + `attributeFilter: ["aria-label","aria-checked","aria-expanded"]` — **never `class`**;
- mutation callbacks inspect only the added subtree; a full scan runs at install, on the 10-minute
  refresh, and only when a promotion window actually flips (checked once a minute);
- one rAF-coalesced pass; per-node idempotency via `WeakMap` keyed on a signature that includes the
  promotion id and its active bit, so a 23:00 flip repaints the row by itself;
- badges are `pointer-events:none` + `aria-hidden`; the row holds at most two compact badges
  (promotion, then `免费`/rate), each capped at 6 characters, placed at the end of the row — before
  the check column when they share a line — so the row never wraps and the model name keeps its width;
- the hover card is **one** global node filled with `textContent` (upstream strings are untrusted),
  driven by delegated `mouseover`/`mouseout` — no per-row listeners, no `innerHTML` anywhere;
- `ui.trigger=false` / `ui.menu=false` turns each area off (config, host-provided).

Mounting and lookup details that bite:

- a badge goes on the **row container** (`[class*="_modelOption"]`), never inside `_optionCopy` —
  that one is the vertical name+description column, so anything inserted there wraps and stretches;
- lookup is **by `data-model-id` first** (the shell writes it on every row): provider groups repeat
  display names (`DeepSeek-V4-Pro` exists under both `DeepSeek 账号` and `CodeBuddy`), so a name
  alone never resolves a model; falling back to text, only a display name that occurs **once in the
  whole catalogue** resolves, and the one extra case is a name followed by the shell's own marker
  (the `1017` release badge renders `DeepSeek-V4.1-Flash 1017`), matched by unique name prefix —
  otherwise that row would carry no extra information at all;
- one row = one line: at most two compact in-row badges (`免费` or rate, each ≤6 chars), and the rest
  (描述 / 上下文 / 思考档 / 标签 / 试用 / 活动说明) lives in the hover card, not in the row —
  and not in the shell's native `title` either, which is removed while a row is decorated.

## Config

| key | default | meaning |
| --- | --- | --- |
| `baseURL` | `https://copilot.tencent.com` | gateway origin |
| `cacheMs` | `300000` | upstream cache lifetime |
| `requestTimeoutMs` | `8000` | hard deadline per upstream request |
| `allowRefresh` | `true` | permit `?refresh=1` |
| `uiTrigger` | `true` | badge next to the composer model name |
| `uiMenu` | `true` | promotion + rate/`免费` badges and a hover card inside `/model` rows |
| `promotions` | `true` | make the second (IDE-UA) request for `modelPromotions` / `modelTiers` |
| `diagnostics` | `true` | accept client diagnostic reports |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs        # parseCredits / normalizeModel / client internals / DOM-discipline asserts
```

## License

MIT
