# dsh-model-info

Per-model metadata overlay for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): a **hover card**
with each model's extra metadata (context window, max tokens, reasoning efforts, image support,
promotion tags) in the composer trigger and the `/model` dropdown rows.

本插件只做**悬浮信息**。行内的倍率与促销标签由 `dsh-workbuddy-trae-qoder-connect`（下称 connect）
拼进 `model.name` 提供（`Hy4 preview · x0.29 · 夜间免费`），所以本插件默认**不再重复挂徽标**
（`badges: false`）。

## 数据源（不自己打上游、不持有凭据）

全部复用 connect 已经落地的文件 / 路由：

| 供应商 | 数据源 | 提取的字段 |
| --- | --- | --- |
| WorkBuddy CN | `~/.dsh/.workbuddy{n}-catalog.json` → `entries[*].models[]` | id / name / contextWindow / maxTokens / supportsImages / reasoning.supportedEfforts / billing{credits,badges,free} |
| Trae CN | `~/.dsh/trae-cn/models.json` → `models[]` | id / name / contextWindow / maxTokens / supportsImages / reasoningByGroup / rate(number) |
| Qoder CN | `GET /plugins/dsh-qoder-connect/status`（loopback） | id / name / rate / free / contextWindow / isReasoning |

单个供应商失败不影响其他：`/health` 的 `sources` 逐个报 `ok` / `count` / `error`。

归一化后的统一 shape：

```js
{ id, key: '<provider>::<id>', name, provider, rate(number|null), free(bool),
  credits('x0.29'|null), badges(string[]), contextWindow, maxTokens,
  supportsImages(bool), efforts(string[]), promotions: [] }
```

`credits` 是供应商自己的**展示**倍率，**不是线性价格**；唯一硬映射是 `x0.00` ⇔ 不计费。

## 跨供应商不串组

同名模型可能同时存在于多个供应商（内置 DeepSeek 与 Trae 都有 `deepseek-v4-pro`）。宿主写在行上的
`data-model-id` **两家完全一样**，只按 id 解析会把一个分组的上下文/思考档贴到另一个分组的行上。

解析顺序：

1. 行上有 `data-model-id` 时**只认 id**，先按「行所属分组标题 → provider」精确查
   （`WorkBuddy 1` → `workbuddy1`、`Trae` → `trae`…），命中 `provider::id` 即用；
2. 该 provider 下没有这个 id（或分组认不出）时，才退回全局 `byKey[id]`；
3. 行上有 id 但目录里整份都没有它 → **放弃**，绝不退回按名字解析。

没有 id 的老形状（触发器）才退回文本：先剥掉别的插件拼进名字的后缀（` · x0.29 · 夜间免费`），
按剥后的模型名解析；只有整份目录里该名字唯一时才认。

## 悬浮卡里有什么

描述（若上游给）→ 消耗速度（折扣时按 `displayMode:'strikethrough'` 划掉原价）→ 折扣 → 试用 →
思考强度 → 上下文窗口 → 图片 → 能力 / 标签 → 促销标签 chip。

促销标签在 CN 版 WorkBuddy 只以 `billing.badges` 存在、没有时段/折扣明细，所以 `promotions`
统一为空数组，徽标行直接列 `badges`。

## 热区只在模型名上

热区挂整行 / 整个触发器时，鼠标想去点别的模型会先被弹卡挡住。现在只挂名字元素本身，并加
`width:fit-content + max-width:100%` 把宽度收到文字那么宽（长名省略号照旧，行高与「整行可点」不变）。
**不能加 `flex:none`**：触发器靠 `flex-shrink` 收缩才能出省略号。

没徽标时**仍要留热区**：图片模型可能什么徽标都没有，但悬浮卡里还有上下文、思考档。

## DOM 纪律

- observer = `childList + subtree` + `attributeFilter: ["aria-label","aria-checked","aria-expanded"]`，**绝不 observe `class`**；
- mutation 回调只看新增子树；整页扫描只在安装、10 分钟刷新、促销时段翻转时各跑一次；
- 一次 rAF 合帧；按节点用 `WeakMap` 幂等；
- 悬浮卡是**一个**全局节点，事件委托（`mouseover`/`mouseout`），内容一律 `textContent`；
- 徽标 `pointer-events:none`；热区 = 名字元素，徽标插在它后面、不进热区。

## 路由

- `GET /dsh-model-info/models` — `{ available, sources, ui, health, models[], promotions[] }`
  - `?refresh=1` 强制重新读（config `allowRefresh`）
  - 有缓存立即返回、后台刷新（stale-while-revalidate）
- `GET /dsh-model-info/health` — 缓存年龄 / 各供应商状态 / 最近错误
- `POST /dsh-model-info/diag` — 客户端诊断上报 → `~/.dsh/.cache/dsh-model-info-client.json`（环形 60 条 / 64KB）

## Config

| key | default | meaning |
| --- | --- | --- |
| `cacheMs` | `300000` | 缓存存活时长 |
| `requestTimeoutMs` | `8000` | 单次 loopback 请求超时 |
| `allowRefresh` | `true` | 允许 `?refresh=1` |
| `uiTrigger` | `true` | 输入框触发器旁挂热区 |
| `uiMenu` | `true` | `/model` 行内挂热区 |
| `badges` | `false` | 是否额外渲染行内徽标（connect 已提供，默认关） |
| `diagnostics` | `true` | 接收客户端诊断 |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs        # 123 assertions
```

## License

MIT
