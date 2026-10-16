# dsh-model-info

Per-model metadata overlay for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): shows each CodeBuddy model's **upstream credit multiplier (0x 倍率)** and a **免费 (zero-billing)** flag, injected next to the model name in the composer and the model menu.

## Why this plugin exists

The upstream CodeBuddy gateway publishes a per-model rate on `GET /v3/config`:

```json
{ "id": "deepseek-v4-pro", "credits": "x0.51 credits", ... }
```

`dsh-tap` fetches that same endpoint but **discards `credits`** when it projects the catalog — so the multiplier exists upstream yet never reaches the UI. This plugin fetches it again and surfaces it.

## 倍率 semantics — read this before trusting the number

`credits` is the gateway's own **display** ratio. Verified properties:

- ✅ `x0.00` ⟺ **zero billing** — the one hard mapping upstream is confirmed for.
- ⚠️ It is **not** a linear price. Measured `credit / 1k tokens` does not track it (e.g. `x0.51` does not mean "half the cost of `x1.00`").

So this plugin shows the raw `x0.51` string with a tooltip stating it is a display rate, and never renders "costs N× as much". Don't repurpose it as a price.

## What "免费" means

`免费` = the model's rate is exactly `x0.00` (i.e. `hy3`, `step-5-preview` at time of writing). It is **not** a time-of-day promotion. There is no night/off-peak concept upstream — see below.

### 夜间免费 — deliberately not implemented

A full search of `dsh-tap` (source + docs) and of the live `/v3/config` response found **no** night / off-peak / free-window / discount field anywhere. Any "夜间免费" badge would therefore be a rule invented by this plugin, not an upstream fact, so it is **not** shipped. The config surface is left open if upstream ever adds one.

## Install

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:/C:/_Dev/ws-dsh/dsh-model-info
```

Then add `"dsh-model-info"` to `dsh.profile.bundles` in `package.json` (or let `4-初始化本机.ps1` do it), and restart DSH.

The bundle's own `cordis.patch.yml` contains the `insert` entry that mounts it.

## Credentials

Reuses the **CodeBuddy OAuth token dsh-tap already stores** at `~/.dsh/codebuddy-plugin-auth.json`. No extra configuration, and the token never leaves the host process — the loopback route only serves derived numbers (`multiplier`, `free`), never the credential.

If dsh-tap is not logged in, the route reports `available: false` and the UI simply shows no badges. Startup is never blocked.

## Route

`GET /dsh-model-info/models` →

```json
{
  "available": true,
  "cached": false,
  "fetchedAt": 1760000000000,
  "models": [
    { "id": "deepseek-v4-pro", "name": "Deepseek-V4-Pro",
      "multiplier": 0.51, "free": false, "credits": "x0.51 credits" }
  ]
}
```

`?refresh=1` forces an upstream refetch. Cached 5 minutes by default (`cacheMs`).

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs        # parseCredits unit tests, no deps
```

## License

MIT
