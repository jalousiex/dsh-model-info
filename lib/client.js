/**
 * dsh-model-info —— 浏览器半。
 *
 * 职责：把每模型的额外信息注入 UI。对每个上游网关给出倍率的模型，展示：
 *   · 网关自己的展示倍率，在 /model 行内右对齐，并在输入框的模型名后显示
 *     （`0.29x`，或 x0.00 / 促销 factor 为 0 时显示 `免费`）；
 *   · 网关下发的促销徽标（`夜间免费` / `限时免费` / `夜间折扣` / `独家限免` /
 *     `订阅优先` …）—— 文案、颜色、时段全部来自 `modelPromotions` /
 *     `modelTiers`，**一个字都不自己编**；
 *   · 一个**自绘**悬浮卡（tip）：倍率（含折扣划线原价）、描述、上下文窗口、
 *     思考强度、标签、试用，以及促销的完整说明文案。
 *     不用原生 `title`：它延迟约 1 秒、样式不可控、且不能排版。
 *
 * 促销的"此刻是否生效"**在客户端按本地时钟重算**（服务端只给
 * `schedule.daily` 的时段窗口 + `timezone`）。缓存里的那个标志是抓取
 * 那一刻算的，5 分钟缓存足以跨过 23:00 边界，所以只把它当初值。
 *
 * DOM 纪律（这部分正是以前把模型列表卡死的原因）：
 *   · 绝不 observe `class` 变化。只用 `childList + subtree` 加窄
 *     `attributeFilter`（aria-label / aria-checked / aria-expanded）；
 *   · 绝不在 mutation 回调里扫描整个文档。只看新增子树，
 *     整页扫描只在安装时、定时刷新时、以及促销时段翻转时各跑一次；
 *   · 最多一次 rAF 合帧；按节点用 WeakMap 幂等 —— 未变动的行
 *     只花一次字符串比较，别的什么都不做；
 *   · 悬浮卡是**一个**全局节点 + 事件委托（mouseover/mouseout），
 *     不给每个行挂监听器；
 *   · 对应 `ui.*` 开关关闭时，绝不往输入框触发器或菜单行里插任何东西。
 *
 * 无构建步骤：纯 DOM API。不使用 react-dom（不在模块加载器的 require 表里）。
 * 颜色取自宿主的 --dsw-alias-* 令牌，因此深色主题自动跟随。
 */


window.__ModuleLoader__.load({
	id: "dsh-model-info",
	factory: function (require) {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var ROUTE = "/dsh-model-info/models";
		var DIAG = "/dsh-model-info/diag";
		var MARK = "data-dsh-model-info";
		var ANCHOR = "data-dsh-model-info-anchor";
		var REFRESH_MS = 600000; // 10 min; the host cache is 5 min
		var BOUNDARY_TICK_MS = 60000; // 促销时段边界的对账粒度
		var TIP_DELAY_MS = 120;

		var CSS_TEXT = [
			// 行内徽标绝不换行、绝不把行撑开：菜单行保持一行，
			// 其余信息全部放进悬浮提示。
			'.dmi-badge{display:inline-flex;align-items:center;flex:none;margin-left:4px;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap;vertical-align:1px;pointer-events:none}',
			'.dmi-rate{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,gray)}',
			'.dmi-menu-rate{margin-left:auto;padding-left:6px;background:0 0;color:var(--dsw-alias-label-secondary,gray);font-weight:500}',
			'.dmi-free{background:var(--dsw-alias-state-success-primary,#2a9d4a);color:#fff}',
			// 促销徽标：命中时段 = 实心（服务端给的颜色）；未命中 = 描边预告。
			'.dmi-promo{font-weight:600}',
			'.dmi-promo-on{color:#fff}',
			'.dmi-promo-off{background:0 0;border:1px solid currentColor;opacity:.72;font-weight:500}',
			'.dmi-strike{text-decoration:line-through;opacity:.6;margin-right:3px;font-weight:500}',
			// 自绘悬浮卡：一个全局节点，pointer-events:none 免得自己抢焦点。
			'.dmi-tip{position:fixed;z-index:2147483000;max-width:320px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#222);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:12px;line-height:1.55;pointer-events:none;opacity:0;transform:translateY(-2px);transition:opacity .12s ease,transform .12s ease}',
			'.dmi-tip[data-open="1"]{opacity:1;transform:none}',
			'.dmi-tip-title{font-size:12.5px;font-weight:600}',
			'.dmi-tip-desc{margin-top:2px;color:var(--dsw-alias-label-secondary,gray)}',
			'.dmi-tip-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 12px;margin-top:6px}',
			'.dmi-tip-k{color:var(--dsw-alias-label-secondary,gray);white-space:nowrap}',
			'.dmi-tip-v{justify-self:end;text-align:right}',
			'.dmi-tip-promo{display:flex;gap:6px;align-items:flex-start;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
			'.dmi-tip-promo-text{color:var(--dsw-alias-label-secondary,gray)}',
			'.dmi-tip-none{color:var(--dsw-alias-label-secondary,gray)}',
			// 悬浮说明的热区：菜单行里 `_optionCopy`（名字的父级）是 `flex:1` 的
			// 纵向列，它会把整行剩余宽度都吃掉，拿它当热区 = 整行都是热区 ——
			// 鼠标想去点别的模型，先被弹卡挡住。这里只把**名字本身**的宽度收到
			// 文字那么宽（不设 flex，保住长名的 ellipsis 截断），行高与
			// 「整行可点」都不变。触发器标签本来就是 flex 项且要参与截断收缩，
			// 不能套这个宽度（会让触发器失去省略能力），所以不挂热区类。
			'.dmi-hot{width:fit-content;width:-webkit-fit-content;max-width:100%}',
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-model-info"]';
			var existing = document.querySelector(tag);
			if (existing) {
				if (existing.textContent !== CSS_TEXT) existing.textContent = CSS_TEXT;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-model-info");
			el.setAttribute("data-plugin-css", "dsh-model-info");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		/** 卸载时连样式一起摘掉；顺序的 CSS 也在其中，所以随后要 healGroup。 */
		function unstylize() {
			if (typeof document === "undefined") return;
			var tag = document.querySelector('style[data-plugin-css="dsh-model-info"]');
			if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
		}

		/** 0.29 -> "0.29x"；已格式化好的字符串原样透传。 */
		function rateText(v) {
			if (v == null) return null;
			if (typeof v === "number") return String(v) + "x";
			if (typeof v === "string") return v.replace(/\s*credits\s*$/i, "");
			return null;
		}

		/** 上游标签 id -> 可读标签；未知标签原样保留。 */
		function tagLabel(tag) {
			if (tag === "text-to-image") return "文生图";
			if (tag === "image-to-image") return "图生图";
			return String(tag);
		}

		/** 取第一个非空字符串并 trim；都没有返回 undefined。 */
		function firstString() {
			for (var i = 0; i < arguments.length; i++) {
				var v = arguments[i];
				if (typeof v === "string" && v.trim()) return v.trim();
			}
			return undefined;
		}

		/**
		 * 徽标文案。宿主从 `badge.label` 拍平成 `label`，但这里也容忍
		 * 直接拿到上游原始嵌套形态（测试夹具与旧缓存都可能如此）。
		 */
		function promoLabel(p) {
			return firstString(p.label, p.badge && p.badge.label, p.badge && p.badge.labelEn);
		}

		function promoShort(p) {
			return firstString(
				p.shortLabel,
				p.badge && p.badge.shortLabel,
				p.badge && p.badge.shortLabelEn,
				promoLabel(p),
			);
		}

		/** `hover` 在宿主侧已拍平成字符串；原始形态是 { textZh, textEn }。 */
		function promoHover(p) {
			if (typeof p.hover === "string") return p.hover.trim() || undefined;
			if (p.hover && typeof p.hover === "object") {
				return firstString(p.hover.textZh, p.hover.textEn);
			}
			return undefined;
		}

		// ------------------------------------------------------------------
		// 促销时段判定：与宿主半同一套规则，只是这里按"渲染时刻"重算。
		// ------------------------------------------------------------------
		/** "23:00" / "7:50" -> 当日分钟数；解析不出返回 null。 */
		function parseClock(text) {
			if (typeof text !== "string") return null;
			var m = text.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
			if (!m) return null;
			var h = Number(m[1]);
			var min = m[2] === undefined ? 0 : Number(m[2]);
			if (!isFinite(h) || !isFinite(min)) return null;
			if (h > 24 || min > 59) return null;
			return h * 60 + min;
		}

		/** 取 timezone 下的当前分钟数；用 Intl 而不是本地 Date（机器 TZ 未必一致）。 */
		function zonedMinutes(timezone) {
			var tz = typeof timezone === "string" && timezone ? timezone : "Asia/Shanghai";
			try {
				var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
				var get = function (type) {
					for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
					return "";
				};
				return (Number(get("hour")) % 24) * 60 + (Number(get("minute")) || 0);
			} catch (e) {
				var d = new Date();
				return d.getHours() * 60 + d.getMinutes();
			}
		}

		/** schedule 此刻是否生效（daily 窗口按 [start,end)，可跨零点）。 */
		function scheduleActive(schedule, minutes) {
			if (!schedule || typeof schedule !== "object") return true;
			var from = schedule.validFrom ? Date.parse(schedule.validFrom) : NaN;
			var until = schedule.validUntil ? Date.parse(schedule.validUntil) : NaN;
			var at = Date.now();
			if (!isNaN(from) && at < from) return false;
			if (!isNaN(until) && at >= until) return false;
			var windows = Array.isArray(schedule.daily) ? schedule.daily : [];
			if (!windows.length) return true;
			var now = typeof minutes === "number" ? minutes : zonedMinutes(schedule.timezone);
			for (var i = 0; i < windows.length; i++) {
				var start = parseClock(windows[i] && windows[i].start);
				var end = parseClock(windows[i] && windows[i].end);
				if (start === null || end === null) continue;
				if (start <= end) {
					if (now >= start && now < end) return true;
				} else if (now >= start || now < end) {
					return true; // 跨零点：23:00 -> 次日 7:50
				}
			}
			return false;
		}

		// ------------------------------------------------------------------
		// 查找：同时以 id 与显示名（小写）为键 —— 因为输入框触发器渲染的是
		// model.name，而目录里同时带着 id。
		// ------------------------------------------------------------------
		/**
		 * 从**整份**目录重建两个索引。`byName` 与 `byKey` 在同一轮里重建、
		 * **绝不沿用上一轮** —— 因为一个曾经唯一的名字（某模型是唯一的 "Hy3"），
		 * 在第二个模型发布同名后必须停止解析。
		 * 只有当一个名字在本轮目录里恰好只被一个 id 拥有时，才保留该名字键。

		 */
		var byKey = Object.create(null);
		/** 只按名字（唯一）建的索引，给「宿主在名字后面追加了标记」的兜底用。 */
		var byName = Object.create(null);
		var promoByModel = Object.create(null);
		/** 每个模型命中的**全部**活动（悬浮卡要列全，行内只放一个）。 */
		var promosByModel = Object.create(null);
		var promoList = [];
		var ui = { trigger: true, menu: true };
		/** 被我们摘掉的宿主原生 title（卸载时原样还回去）。 */
		var savedTitles = new WeakMap();

		function indexModels(models) {
			var next = Object.create(null);
			var idKeys = Object.create(null);
			var owner = Object.create(null);
			var dup = Object.create(null);
			for (var i = 0; i < models.length; i++) {
				var m = models[i];
				if (!m) continue;
				var rec = {
					id: m.id || null,
					name: m.name || null,
					rate: rateText(m.rate != null ? m.rate : m.credits),
					free: m.free === true,
					tags: Array.isArray(m.tags) ? m.tags : [],
					craft: m.craft === true,
					trial: m.trial && typeof m.trial.days === "number" ? m.trial.days : null,
					description: typeof m.descriptionZh === "string" ? m.descriptionZh : null,
					context: typeof m.contextWindow === "number" ? m.contextWindow : null,
					efforts: Array.isArray(m.efforts) ? m.efforts : [],
					vision: m.supportsImages === true,
				};
				if (m.id) {
					var idk = String(m.id).trim().toLowerCase();
					next[idk] = rec;
					idKeys[idk] = true;
				}
				// 上游的名字**不唯一**（Hy3 / hy3-x、Hy4 preview /
				// hy4-preview-x 各自都叫 "Hy3" / "Hy4 preview"）。
				if (m.name) {
					var nk = String(m.name).trim().toLowerCase();
					if (nk) {
						if (owner[nk] && owner[nk] !== rec) dup[nk] = true;
						else owner[nk] = rec;
					}
				}
			}
			for (var k in owner) {
				// id 总是优先于名字（菜单行两种都可能渲染）；
				// 两个模型共用的名字则完全不解析。
				if (!idKeys[k] && !dup[k]) next[k] = owner[k];
			}
			byKey = next;
			byName = Object.create(null);
			for (var uk in owner) {
				if (!dup[uk]) byName[uk] = owner[uk];
			}
			// 长名优先，避免短名抢走长名的前缀。
			nameKeys = Object.keys(byName).sort(function (a, b) {
				return b.length - a.length;
			});
		}

		/**
		 * 促销索引里已有此时段**真正给折扣**（带 factor）的活动时，
		 * 同模型的常驻预告徽标（同名、无 factor、activeOnly:false）就让位 ——
		 * 否则「夜间折扣」会作为两条活动重复出现，而同一条规则里白天的那个
		 * 徽标条目（activeOnly:false、不带折扣）就是它的预告位。
		 * 这里只做「同一活动去重」，不改任何上游文案。
		 */
		function dropShadowed(list) {
			var keep = [];
			for (var i = 0; i < list.length; i++) {
				var p = list[i];
				var shadow = false;
				if (p.active && typeof p.factor !== "number") {
					for (var j = 0; j < list.length && !shadow; j++) {
						var q = list[j];
						if (q === p || !q.active || typeof q.factor !== "number") continue;
						if (q.label === p.label) shadow = true;
					}
				}
				if (!shadow) keep.push(p);
			}
			return keep;
		}

		/**
		 * 促销/档位建索引：enabled=false 丢弃；`display:'activeOnly'` 的
		 * 只在生效时段内占位；多个命中时 priority 高者胜（服务端自己的规则）。
		 */
		function indexPromotions(list) {
			promoList = Array.isArray(list) ? list : [];
			var live = [];
			for (var i = 0; i < promoList.length; i++) {
				var p = promoList[i];
				if (!p || p.enabled === false) continue;
				var active = p.schedule ? scheduleActive(p.schedule) : p.active === true;
				p.active = active; // 回写，供悬浮卡与边界对账复用
				if (p.activeOnly && !active) continue;
				live.push(p);
			}
			var next = Object.create(null);
			// 「夜间折扣」白天那条 activeOnly:false 的同名预告位由夜间那条
			// （带 factor）盖掉：同一活动只留一条，且是有折扣数据的那条。
			live = dropShadowed(live);
			for (var j = 0; j < live.length; j++) {
				var item = live[j];
				var ids = Array.isArray(item.modelIds) ? item.modelIds : [];
				for (var k = 0; k < ids.length; k++) {
					var id = String(ids[k]).trim().toLowerCase();
					if (!id) continue;
					var prev = next[id];
					if (!prev || (item.priority || 0) > (prev.priority || 0)) next[id] = item;
				}
			}
			promoByModel = next;
			promosByModel = Object.create(null);
			for (var m = 0; m < live.length; m++) {
				var q = live[m];
				var mids = Array.isArray(q.modelIds) ? q.modelIds : [];
				for (var n = 0; n < mids.length; n++) {
					var mid = String(mids[n]).trim().toLowerCase();
					if (!mid) continue;
					if (!promosByModel[mid]) promosByModel[mid] = [];
					promosByModel[mid].push(q);
				}
			}
		}

		/**
		 * 促销边界对账：每分钟算一次"有没有谁的生效状态翻了"，
		 * 翻了才重铺索引 + 扫一次。平时一次 DOM 都不碰。
		 */
		function promotionsChanged() {
			var changed = false;
			for (var i = 0; i < promoList.length; i++) {
				var p = promoList[i];
				if (!p || !p.schedule) continue;
				var active = scheduleActive(p.schedule);
				if (active !== p.active) {
					p.active = active;
					changed = true;
				}
			}
			return changed;
		}

		/**
		 * 兜底：行/触发器里读到的文本以某个**唯一**模型名开头时也算命中。
		 * 宿主会在名字后面追加标记（例如 "DeepSeek-V4.1-Flash 1017" 那个发布徽标），
		 * 整串既不是 id 也不是名字，否则这一行就完全没有额外信息。
		 * 有歧义或过短（<3 字符）的前缀不解析，避免乱挂。
		 */
		var nameKeys = [];

		function namePart(key) {
			for (var i = 0; i < nameKeys.length; i++) {
				var nk = nameKeys[i];
				if (nk.length < 3 || key.length <= nk.length) continue;
				if (key.indexOf(nk) !== 0) continue;
				// 名字必须整词结束：后面是空白或非拉丁字符（中文标签等），
				// 不能是 "-x" 这种另一个模型名的一部分。
				var rest = key.charAt(nk.length);
				if (/[\s\u3000-\u9fff\u2013-\u2014·]/.test(rest)) return byName[nk];
			}
			return undefined;
		}

		/**
		 * 按行/触发器解析模型。
		 *
		 * `data-model-id` 是宿主自己写下的**权威** id，优先用它；只有缺它时才
		 * 退回文本（老形状）。按名字解析时必须防「同名跨分组」：DeepSeek 账号
		 * 与 CodeBuddy 两个分组都有 "DeepSeek-V4-Pro"，名字一样却是不同的条目，
		 * 任一条都能命中名字键会把一个分组的倍率贴到另一个分组的行上。
		 * 所以：能拿到 id 就用 id；拿不到 id 时，只有当**整份目录里这个显示名
		 * 只出现一次**才按名字解析（重名一律放弃，宁可这一行没有额外信息）。
		 */
		function lookup(text, host) {
			if (!text) return null;
			var key = String(text).trim().toLowerCase();
			if (!key) return null;
			var id = host && host.getAttribute ? host.getAttribute("data-model-id") : null;
			var rec = null;
			if (id) rec = byKey[String(id).trim().toLowerCase()] || null;
			if (!rec) rec = byKey[key];
			if (!rec) {
				// 触发器渲染的是 "Model · Effort"；只匹配其中的模型部分。
				var head = key.split("·")[0].trim();
				rec = (head && byKey[head]) || namePart(key);
			}
			if (!rec) return null;
			// 促销按 id 挂；id 缺失时退回名字键（重名本就不解析）。
			var idk = rec.id ? String(rec.id).trim().toLowerCase() : key;
			rec.promo = promoByModel[idk] || promoByModel[key] || null;
			// 悬浮卡要列全该模型的全部活动（含未生效的），行内只用 rec.promo。
			rec.activities = activitiesFor(rec);
			return rec;
		}

		function fmtContext(n) {
			if (!n) return null;
			if (n >= 1000000) return String(Math.round(n / 100000) / 10) + "M";
			if (n >= 1000) return String(Math.round(n / 1000)) + "K";
			return String(n);
		}

		/**
		 * 生效倍率：促销命中且给了 factor 就用它（这就是"夜间免费"的落点），
		 * 否则用目录倍率。返回 { value, base, discounted, mode }。
		 */
		function effectiveRate(rec) {
			var p = rec.promo;
			if (p && p.active && typeof p.factor === "number" && p.factor != null) {
				return {
					value: p.factor,
					// 原价按目录倍率；rec.rate 是 "0.29x" 字符串，free 则为 0。
					base: rec.free ? 0 : typeof rec.rate === "number" ? rec.rate : rec.rate == null ? null : parseFloat(rec.rate),
					discounted: true,
					mode: p.displayMode || "replace",
				};
			}
			return { value: rec.free ? 0 : rec.rate, base: null, discounted: false, mode: null };
		}

		/** 目前上游下发的是英文档位 id（low / high / max），原样给出，不编中文。 */
		function effortLabel(effort) {
			return String(effort);
		}

		/**
		 * 纯文本版（aria/兜底用）。自绘悬浮卡另有 buildTip()。
		 * 顺序对齐官方模型面板：描述 → 试用 → 思考强度 → 上下文 → 图片；
		 * 活动说明走 activityLine()。繁忙程度官方有、上游没有数据，不编造。
		 */
		function tooltip(rec) {
			var lines = [];
			if (rec.description) lines.push(rec.description);
			var eff = effectiveRate(rec);
			if (rec.trial) lines.push("试用 " + rec.trial + " 天");
			if (eff.value === 0) lines.push("消耗速度：免费（x0.00）");
			else if (eff.value != null) {
				var line = "消耗速度：" + (typeof eff.value === "number" ? eff.value + "x" : eff.value) + " 倍率";
				if (eff.discounted && eff.base != null) line += "（原价 " + eff.base + "x）";
				lines.push(line);
			}
			var efforts = rec.efforts || [];
			if (efforts.length) lines.push("思考强度：" + efforts.join(" / "));
			var ctx = fmtContext(rec.context);
			if (ctx) lines.push("上下文窗口：" + ctx);
			if (rec.vision) lines.push("图片：支持");
			if (rec.craft) lines.push("标签：推荐");
			var acts = rec.activities || (rec.promo ? [rec.promo] : []);
			for (var i = 0; i < acts.length; i++) lines.push(activityLine(acts[i]));
			return lines.join("\n");
		}

		// ------------------------------------------------------------------
		// 活动说明：徽标文案 + 生效时段 + 说明原文。时段由 `schedule.daily`
		// 拼出（"每天 23:00–次日 8:00"），开放原文一个字都不改写。
		// ------------------------------------------------------------------
		/** "HH:mm" / "H" -> "HH:mm"；解析不出返回 null。 */
		function clockText(text) {
			var m = parseClock(text);
			if (m === null) return null;
			var h = Math.floor(m / 60);
			var min = m % 60;
			return (h < 10 ? "0" : "") + h + ":" + (min < 10 ? "0" : "") + min;
		}

		function fmtDay(iso) {
			var t = Date.parse(iso);
			if (isNaN(t)) return null;
			var d = new Date(t);
			return d.getMonth() + 1 + "月" + d.getDate() + "日";
		}

		// 时长跨零点的一半按「次日」读；12 小时以上按晨间窗口读。
		var NEXT_DAY_MIN = 720;

		/**
		 * 生效时段的紧凑写法。多个窗口列全；跨零点的窗口结束时间标「次日」；
		 * 周一到周五的窗口标「工作日」；有 validFrom/validUntil 时标截止日。
		 * 上游的时段就是字符串，这里只拼不改。
		 */
		function scheduleSummary(schedule) {
			if (!schedule || typeof schedule !== "object") return null;
			var parts = [];
			var windows = Array.isArray(schedule.daily) ? schedule.daily : [];
			var nextDay = false;
			for (var i = 0; i < windows.length; i++) {
				var start = clockText(windows[i] && windows[i].start);
				var end = clockText(windows[i] && windows[i].end);
				if (!start || !end) continue;
				var s = parseClock(start);
				var e = parseClock(end);
				if (s !== null && e !== null && s >= NEXT_DAY_MIN) {
					if (e <= s) {
						end += "（次日）";
						nextDay = true;
					} else {
						parts.push("起点次日 " + start + "–" + end);
						nextDay = true;
						continue;
					}
				}
				parts.push(start + "–" + end);
			}
			// "00:00–23:59" 这种整天窗口按「每天」读。
			if (parts.length === 1 && /^00:00[–-]23:59$/.test(parts[0])) parts = [];
			var text = "";
			if (parts.length) text = "每天 " + parts.join("、");
			var dayCount = Array.isArray(schedule.days) ? schedule.days.length : 0;
			if (dayCount > 0 && dayCount < 7) text = "工作日 " + parts.join("、");
			var until = schedule.validUntil ? fmtDay(schedule.validUntil) : null;
			if (until) text += (text ? "，" : "") + until + " 结束";
			var from = schedule.validFrom ? fmtDay(schedule.validFrom) : null;
			if (from) text += (text ? "，" : "") + from + " 起";
			if (nextDay && text) text += "（时段跨零点）";
			return text || null;
		}

		/** 一条活动摘要（纯文本）：标签 · 状态 · 时段 · 说明原文。 */
		function activityLine(p) {
			var label = promoLabel(p) || "";
			var state = p.active ? "生效中" : "未到时段";
			var when = scheduleSummary(p.schedule) || "";
			var hover = promoHover(p) || "";
			var head = label;
			if (when) head += "（" + when + "）";
			var out = head + " " + state;
			if (hover) out += "：" + hover;
			return out;
		}

		/** 同一活动上报了两条（白天预告位 + 夜间折扣位）时只留一条。 */
		function dedupeActivities(list) {
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var p = list[i];
				var same = false;
				for (var j = 0; j < out.length && !same; j++) {
					if (out[j].label === p.label && promoHover(out[j]) === promoHover(p)) same = true;
				}
				if (!same) out.push(p);
			}
			return out;
		}

		/** 这个模型名下的全部活动（生效中的在前，再按 priority 降序）。 */
		function activitiesFor(rec) {
			var idk = rec.id ? String(rec.id).trim().toLowerCase() : "";
			var list = (idk && promosByModel[idk]) || [];
			var copy = [];
			for (var i = 0; i < list.length; i++) copy.push(list[i]);
			copy = dedupeActivities(copy);
			copy.sort(function (a, b) {
				return Number(b.active) - Number(a.active) || (b.priority || 0) - (a.priority || 0);
			});
			return copy;
		}

		/** 折扣/免费生效中的那条活动；没有返回 null。 */
		function activeDiscount(rec) {
			var list = rec.activities || (rec.promo ? [rec.promo] : []);
			for (var i = 0; i < list.length; i++) {
				if (list[i].active && typeof list[i].factor === "number") return list[i];
			}
			return null;
		}

		// ------------------------------------------------------------------
		// 自绘悬浮卡：一个全局节点，内容用 textContent 填（上游字符串不信任）。
		// ------------------------------------------------------------------
		var tipEl = null;

		function el(tag, cls) {
			var node = document.createElement(tag);
			if (cls) node.className = cls;
			return node;
		}

		function ensureTip() {
			if (tipEl && tipEl.parentNode) return tipEl;
			tipEl = el("div", "dmi-tip");
			tipEl.setAttribute(MARK, "");
			tipEl.setAttribute("role", "tooltip");
			tipEl.setAttribute("aria-hidden", "true");
			document.body.appendChild(tipEl);
			return tipEl;
		}

		function tipRow(grid, key, valueNode) {
			var k = el("div", "dmi-tip-k");
			k.textContent = key;
			var v = el("div", "dmi-tip-v");
			// Element 与 DocumentFragment 都能直接挂；其余一律当字符串。
			if (valueNode && valueNode.nodeType) v.appendChild(valueNode);
			else v.textContent = String(valueNode == null ? "" : valueNode);
			grid.appendChild(k);
			grid.appendChild(v);
		}

		function strikeNode(value, cls) {
			var s = el("s", cls);
			s.textContent = typeof value === "number" ? value + "x" : String(value);
			return s;
		}

		/** 倍率写法：0 -> 免费徽标，其余 "0.5x"。 */
		function rateSpan(value, withFreeStyle) {
			var b = el("span");
			if (value === 0) {
				if (withFreeStyle) {
					b.className = "dmi-free";
					b.style.cssText = "border-radius:3px;padding:0 4px;color:#fff;background:var(--dsw-alias-state-success-primary,#2a9d4a)";
				}
				b.textContent = "免费";
			} else {
				b.textContent = typeof value === "number" ? value + "x" : String(rateText(value));
			}
			return b;
		}

		/** 消耗速度那一行：折扣生效且上游 displayMode=strikethrough 时划掉原价。 */
		function rateValueNode(rec) {
			var eff = effectiveRate(rec);
			var wrap = document.createDocumentFragment();
			if (eff.discounted && eff.base != null && eff.base !== eff.value && eff.mode === "strikethrough") {
				wrap.appendChild(strikeNode(eff.base, "dmi-strike"));
			}
			wrap.appendChild(rateSpan(eff.value, true));
			return wrap;
		}

		/** 折扣那一行：活动没生效时给折扣后的倍率，生效时标「已应用」。 */
		function discountValueNode(p) {
			var wrap = document.createDocumentFragment();
			if (p.active) {
				wrap.appendChild(document.createTextNode("已应用"));
				return wrap;
			}
			var base = rateOfModel(p);
			if (base != null && base !== p.factor) wrap.appendChild(strikeNode(base, "dmi-strike"));
			wrap.appendChild(rateSpan(p.factor, false));
			return wrap;
		}

		/** 当前模型的目录倍率（数字）；没有返回 null。 */
		function rateOfModel(p) {
			var ids = Array.isArray(p.modelIds) ? p.modelIds : [];
			for (var i = 0; i < ids.length; i++) {
				var rec = byKey[String(ids[i]).trim().toLowerCase()];
				if (rec && typeof rec.rate === "number") return rec.rate;
			}
			return null;
		}

		/**
		 * 一条活动的悬浮说明框。活动与折扣信息**只出现一次**：
		 * 徽标文案 + 生效时段 + 折扣后倍率 + 上游原文，集中放在这里，
		 * 而不是右边再单列一行「活动」。
		 */
		function promoBox(p) {
			var box = el("div", "dmi-tip-promo");
			var chip = el("span", "dmi-badge dmi-promo " + (p.active ? "dmi-promo-on" : "dmi-promo-off"));
			chip.style.marginLeft = "0";
			if (p.color) {
				if (p.active) chip.style.backgroundColor = p.color;
				else chip.style.color = p.color;
			}
			chip.textContent = promoShort(p) || "";
			box.appendChild(chip);
			var text = el("div", "dmi-tip-promo-text");
			var lines = [];
			if (typeof p.factor === "number") lines.push(discountText(p));
			var when = scheduleSummary(p.schedule);
			if (when) lines.push(when);
			var hover = promoHover(p);
			if (hover) lines.push(hover);
			if (!lines.length) lines.push(p.active ? "活动生效中" : "未到活动时段");
			for (var i = 0; i < lines.length; i++) {
				if (i) text.appendChild(document.createElement("br"));
				text.appendChild(document.createTextNode(lines[i]));
			}
			box.appendChild(text);
			return box;
		}

		/** "0.5x（原价 0.79x）" / "免费（原价 0.29x）" / 生效中 "已应用"。 */
		function discountText(p) {
			var base = rateOfModel(p);
			var now = p.factor === 0 ? "免费" : p.factor + "x";
			if (p.active) return "折扣已应用：" + now;
			if (base == null || base === p.factor) return "折扣后 " + now;
			return "折扣后 " + now + "（原价 " + base + "x）";
		}

		function buildTip(rec) {
			var tip = ensureTip();
			while (tip.firstChild) tip.removeChild(tip.firstChild);

			var title = el("div", "dmi-tip-title");
			title.textContent = rec.name || rec.id || "";
			tip.appendChild(title);

			if (rec.description) {
				var desc = el("div", "dmi-tip-desc");
				desc.textContent = rec.description;
				tip.appendChild(desc);
			}

			var grid = el("div", "dmi-tip-grid");
			var eff = effectiveRate(rec);
			if (eff.value != null || rec.free) tipRow(grid, "消耗速度", rateValueNode(rec));
			// 尚未生效的折扣单列一行：行内徽标只是预告，真正的折扣倍率放这里，
			// 免得「夜间折扣」看得出标签却看不到价。
			var acts = rec.activities || [];
			var preview = null;
			for (var a = 0; a < acts.length; a++) {
				var cand = acts[a];
				if (!cand.active && typeof cand.factor === "number") {
					if (!preview || (cand.priority || 0) > (preview.priority || 0)) preview = cand;
				}
			}
			if (preview) tipRow(grid, "折扣", discountValueNode(preview));
			if (rec.trial) tipRow(grid, "试用", rec.trial + " 天");
			var efforts = rec.efforts || [];
			if (efforts.length) tipRow(grid, "思考强度", efforts.map(function (e) { return effortLabel(e); }).join(" / "));
			var ctx = fmtContext(rec.context);
			if (ctx) tipRow(grid, "上下文窗口", ctx);
			// 上游只说 supportsImages:true，不区分输入/输出，所以不写「图片输入」。
			if (rec.vision) tipRow(grid, "图片", "支持");
			if (rec.tags && rec.tags.length) {
				var labels = [];
				for (var i = 0; i < rec.tags.length; i++) labels.push(tagLabel(rec.tags[i]));
				tipRow(grid, "能力", labels.join(" / "));
			}
			if (rec.craft) tipRow(grid, "标签", "推荐");
			if (grid.childNodes.length) tip.appendChild(grid);

			for (var j = 0; j < acts.length; j++) tip.appendChild(promoBox(acts[j]));
			return tip;
		}

		function placeTip(tip, anchor) {
			var r = anchor.getBoundingClientRect();
			tip.style.visibility = "hidden";
			tip.setAttribute("data-open", "1");
			var w = tip.offsetWidth;
			var h = tip.offsetHeight;
			var pad = 8;
			var left = r.left;
			if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
			if (left < pad) left = pad;
			var top = r.bottom + 6;
			if (top + h > window.innerHeight - pad) {
				var above = r.top - h - 6;
				top = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad);
			}
			tip.style.left = Math.round(left) + "px";
			tip.style.top = Math.round(top) + "px";
			tip.style.visibility = "visible";
		}

		var tipTimer = 0;
		var tipAnchor = null;

		function hideTip() {
			if (tipTimer) {
				clearTimeout(tipTimer);
				tipTimer = 0;
			}
			tipAnchor = null;
			if (tipEl) tipEl.setAttribute("data-open", "0");
		}

		function showTipFor(anchor) {
			var entry = decorated.get(anchor);
			if (!entry || !entry.rec) return;
			tipAnchor = anchor;
			if (tipTimer) clearTimeout(tipTimer);
			tipTimer = setTimeout(function () {
				tipTimer = 0;
				if (tipAnchor !== anchor || !anchor.isConnected) return;
				var tip = buildTip(entry.rec);
				placeTip(tip, anchor);
			}, TIP_DELAY_MS);
		}

		// ------------------------------------------------------------------
		// 按节点的装饰状态：WeakMap target -> { sig, nodes, rec }。
		// ------------------------------------------------------------------
		var decorated = new WeakMap();
		var stats = { sweeps: 0, inserts: 0, lastMs: 0 };

		function makeBadge(cls, text) {
			var span = document.createElement("span");
			span.setAttribute(MARK, "");
			span.setAttribute("aria-hidden", "true");
			span.className = "dmi-badge " + cls;
			span.textContent = text;
			return span;
		}

		/** 促销徽标：优先短标签（"折扣"），最多 6 字，绝不撑开行。 */
		function makePromoBadge(promo) {
			var text = promoShort(promo);
			if (typeof text !== "string" || !text) return null;
			if (text.length > 6) text = text.slice(0, 6) + "…";
			var b = makeBadge("dmi-promo " + (promo.active ? "dmi-promo-on" : "dmi-promo-off"), text);
			if (promo.color) {
				if (promo.active) b.style.backgroundColor = promo.color;
				else b.style.color = promo.color;
			}
			return b;
		}

		/** 倍率/免费徽标；折扣生效时按上游 displayMode 划原价。 */
		function makeRateBadge(rec, menu) {
			var eff = effectiveRate(rec);
			// 促销 factor 为 0 = 免费（"夜间免费" / "限时免费" 的落点）。
			if (eff.value === 0) return makeBadge("dmi-free", "免费");
			var text = typeof eff.value === "number" ? eff.value + "x" : rateText(eff.value);
			if (!text) return null;
			var b = makeBadge("dmi-rate" + (menu ? " dmi-menu-rate" : ""), text);
			if (eff.discounted && eff.base != null && eff.base !== eff.value && eff.mode === "strikethrough") {
				var s = document.createElement("s");
				s.className = "dmi-strike";
				s.textContent = typeof eff.base === "number" ? eff.base + "x" : String(eff.base);
				b.insertBefore(s, b.firstChild);
			}
			return b;
		}

		function removeNodes(entry) {
			if (!entry || !entry.nodes) return;
			for (var i = 0; i < entry.nodes.length; i++) {
				var n = entry.nodes[i];
				if (n && n.parentNode) n.parentNode.removeChild(n);
			}
		}

		/**
		 * 悬浮说明的热区 = **模型名文字本身**，不是整行。
		 * 热区挂整行时，鼠标想去点别的模型会先被弹卡挡住，这就是「挡住模型
		 * 选择入口」。名字容器（`_modelName`）是撑满整行的 flex 项，直接拿它
		 * 当热区还是整行，所以给它加 `width:fit-content + flex:none`：宽度只
		 * 剩文字（长名截断照旧 —— `max-width:100%` + 祖先自己的 ellipsis），
		 * 行高与「整行可点」都不变。
		 */
		var HOT_CLASS = "dmi-hot";
		var HOT = "data-dsh-model-info-hot";

		/**
		 * 分组内重排：宿主的模型顺序就是上游目录顺序（`rankByName` 在查询为空
		 * 时原样返回，`orderModelProviders` 只排**分组**），目录里 `auto`
		 * 类条目会被压在分组底部。插件只能动 DOM，所以把置顶行搬到自己分组
		 * 的第一行位置（标题之下），**其余行的相对顺序一个都不动**；
		 * 卸载时按记下的原位置放回去。
		 */
		var PIN = "data-dsh-model-info-pin";
		/** 排到分组首位的模型：按 id 判断，缺 id 才退回显示名。只钉这几个。 */
		var PINNED_IDS = ["auto"];
		var PINNED_NAMES = ["auto"];
		/** 被搬动过的行 -> 它原来的下一个兄弟（还原用）。 */
		var pinnedRestore = new WeakMap();

		/** 名字元素（`_modelName`）：行里唯一的那个。 */
		function rowName(row) {
			if (!row || !row.querySelector) return null;
			return row.querySelector('[class*="_modelName"]');
		}

		/** 这条行是否要排到组首。 */
		function isPinnedRow(row) {
			if (!row || !row.querySelector) return false;
			var idEl = row.querySelector("[data-model-id]");
			var id = idEl ? String(idEl.getAttribute("data-model-id") || "").trim().toLowerCase() : "";
			if (id) return PINNED_IDS.indexOf(id) >= 0;
			var name = rowName(row);
			if (!name) return false;
			var key = String(name.textContent || "").trim().toLowerCase();
			return PINNED_NAMES.indexOf(key) >= 0;
		}

		/**
		 * 把置顶行搬到分组的第一行位置。过滤后只剩一行时不动 ——
		 * 那时的顺序就是用户要找的顺序。返回是否搬动过。
		 */
		function reorderGroup(group) {
			if (!group || !group.children) return false;
			var rows = [];
			for (var i = 0; i < group.children.length; i++) {
				var child = group.children[i];
				if (child.tagName === "BUTTON" && child.querySelector && child.querySelector('[class*="_modelName"]')) rows.push(child);
			}
			if (rows.length < 2) return false;
			var pin = -1;
			for (var j = 0; j < rows.length; j++) {
				if (isPinnedRow(rows[j])) {
					pin = j;
					break;
				}
			}
			if (pin < 0 || pin === 0) return false;
			var row = rows[pin];
			if (!pinnedRestore.has(row)) pinnedRestore.set(row, row.nextSibling);
			group.insertBefore(row, rows[0]);
			row.setAttribute(PIN, "");
			return true;
		}

		function reorderAll() {
			reorderGroupList(document.querySelectorAll('[role="group"]'));
		}

		function reorderGroupList(list) {
			for (var i = 0; i < list.length; i++) {
				// 只认包着模型行的分组。
				if (list[i].querySelector && list[i].querySelector('[class*="_modelOption"]')) reorderGroup(list[i]);
			}
		}

		/** 卸载时把搬过的行放回原位置。 */
		function orderRestored() {
			if (typeof document === "undefined") return;
			try {
				var rows = document.querySelectorAll("[" + PIN + "]");
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					row.removeAttribute(PIN);
					var next = pinnedRestore.get(row);
					var parent = row.parentNode;
					if (!parent) continue;
					if (next && next.parentNode === parent) parent.insertBefore(row, next);
				}
			} catch (e) {}
			pinnedRestore = new WeakMap();
		}

		/** 把热区收紧到名字文字上（加类名），返回该元素本身。 */
		function hotHost(anchor) {
			if (anchor.classList) anchor.classList.add(HOT_CLASS);
			anchor.setAttribute(HOT, "");
			return anchor;
		}

		/** 把热区还原（当前模型没有详情时，别留一个空热区挡住点击）。 */
		function clearHot(anchor) {
			if (!anchor || !anchor.classList) return;
			anchor.classList.remove(HOT_CLASS);
			anchor.removeAttribute(HOT);
			anchor.removeAttribute(ANCHOR);
		}

		function applyTo(target, kind, rec) {
			if (!target || !target.parentNode) return;
			var menu = kind === "row";
			// 「模型 → 说明」的入口是宿主自己的原生 title（行与触发器都有），
			// 推的是模型名；我们只推额外信息。若还留着 title，鼠标不动就会先弹
			// 一个原生提示，和自绘卡叠在一起 —— 所以摘掉它（记住原值，卸载时还回去）。
			if (!savedTitles.has(target)) savedTitles.set(target, target.getAttribute("title"));
			if (target.hasAttribute("title")) target.removeAttribute("title");

			var nodes = [];
			// 促销徽标：命中时段才实心；未命中（或预告位）走描边。
			// 行内只放优先级最高的那一条，其余（如「订阅优先」）留在悬浮卡里。
			if (rec.promo) {
				var p = makePromoBadge(rec.promo);
				if (p) nodes.push(p);
			}
			var r = makeRateBadge(rec, menu);
			if (r) nodes.push(r);
			// 签名里带上促销 id 与生效位：时段翻转时行会自己更新。
			var rateSig = rec.free ? "F" : String(effectiveRate(rec).value ?? "-");
			var sig = (rec.promo ? rec.promo.id + (rec.promo.active ? ":on" : ":off") : "-") + "|" + rateSig;
			var anchor = target.querySelector(kind === "trigger" ? '[class*="_triggerLabel"]' : '[class*="_modelName"]');
			if (!anchor) return;
			// 热区 = 名字元素本身，用类名把它的宽度收到文字那么宽（详情见
			// HOT_CLASS 的样式说明）。徽标插在它**后面**，不进热区。
			var hot = hotHost(anchor);

			var prev = decorated.get(target);
			var sigChanged = !prev || prev.sig !== sig || prev.anchor !== anchor || prev.hot !== hot;
			// 没有徽标可挂时（例如图片模型上游没给 credits）**仍然要留热区**：
			// 悬浮卡里还有描述、上下文、思考档这些信息，不能因为没徽标就让它消失。
			if (!nodes.length) {
				if (prev) {
					removeNodes(prev);
					decorated.delete(target);
				}
				if (!sigChanged) {
					prev.rec = rec;
					return;
				}
				hot.setAttribute(ANCHOR, "");
				decorated.set(target, { sig: sig, nodes: [], rec: rec, hot: hot, anchor: anchor });
				return;
			}

			if (!sigChanged) {
				var alive = prev.nodes.length === nodes.length;
				for (var k = 0; alive && k < prev.nodes.length; k++) {
					if (!prev.nodes[k].parentNode) alive = false;
				}
				if (alive) {
					prev.rec = rec; // 悬浮卡内容随最新数据走
					return;
				}
			}
			removeNodes(prev);

			// 徽标位置：行内放在**行容器**末尾（勾选列之前）—— 宿主的
			// _optionCopy 是纵向列（名字 + 描述），插进去必然换行并被拉伸；
			// 触发器放在名字标签之后，与费力程度那一段并列。
			if (menu) {
				var check = target.querySelector('[class*="_check"]');
				for (var n = 0; n < nodes.length; n++) {
					var node = nodes[n];
					node.style.marginLeft = "auto";
					if (check && check.parentNode === target) target.insertBefore(node, check);
					else target.appendChild(node);
					stats.inserts++;
				}
			} else {
				var parent = hot.parentNode || target;
				for (var m = 0; m < nodes.length; m++) {
					parent.insertBefore(nodes[m], hot.nextSibling);
					stats.inserts++;
				}
			}
			// 热区 = 名字元素，不再是整行 / 整个触发器。
			if (prev && prev.hot && prev.hot !== hot) clearHot(prev.hot);
			hot.setAttribute(ANCHOR, "");
			decorated.set(target, { sig: sig, nodes: nodes, rec: rec, hot: hot, anchor: anchor });
		}

		function decorateTrigger(labelOrButton) {
			if (!ui.trigger) return;
			var button = labelOrButton;
			if (button && button.matches && button.matches('[class*="_triggerLabel"]')) button = button.parentElement;
			if (!button || !button.querySelector) return;
			var label = button.querySelector('[class*="_triggerLabel"]');
			if (!label) return;
			// 触发器渲染 "Model · Effort"，所以只取 [data-model-id] 那一段：
			// 别把费力程度也当模型名 —— 否则 "Model · 高" 这种根本查不到。
			var nameEl = label.querySelector("[data-model-id]");
			var rec = lookup((nameEl || label).textContent, button);
			if (!rec) {
				// 当前模型没有详情：摘掉旧徽标与热区，别留一个空热区挡点击。
				var had = decorated.get(button);
				if (had) {
					removeNodes(had);
					if (had.hot) clearHot(had.hot);
					decorated.delete(button);
				}
				return;
			}
			applyTo(button, "trigger", rec);
		}

		function decorateRow(option) {
			if (!ui.menu || !option || !option.querySelector) return;
			var nameEl = option.querySelector('[class*="_modelName"]');
			if (!nameEl) return;
			var rec = lookup(nameEl.textContent, option);
			if (!rec) {
				// 认不出来就别让之前的热区留在这一行上。
				clearHot(nameEl);
				return;
			}
			applyTo(option, "row", rec);
		}

		/**
		 * 只检查一个新增子树 —— 绝不扫描整个文档。
		 * 新增的可能是分组容器本身，所以顺带把新分组里的顺序补排一次。
		 */
		function collect(node) {
			if (!node || node.nodeType !== 1) return;
			try {
				if (node.matches('[class*="_modelOption"]')) decorateRow(node);
				else if (node.matches('[class*="_triggerLabel"]')) decorateTrigger(node);
				else {
					var rows = node.querySelectorAll('[class*="_modelOption"]');
					for (var i = 0; i < rows.length; i++) decorateRow(rows[i]);
					var triggers = node.querySelectorAll('[class*="_triggerLabel"]');
					for (var j = 0; j < triggers.length; j++) decorateTrigger(triggers[j]);
					var groups = node.matches && node.matches('[role="group"]') ? [node] : node.querySelectorAll('[role="group"]');
					reorderGroupList(groups);
				}
			} catch (e) {
				// 非我们所有的 DOM 形状变了；跳过这个节点
			}
		}

		function fetchModels() {
			return fetch(ROUTE, { headers: { accept: "application/json" } })
				.then(function (r) {
					return r.text().then(function (t) {
						var d = null;
						try {
							d = JSON.parse(t);
						} catch (e) {
							d = null;
						}
						if (!d || !Array.isArray(d.models)) return false;
						if (d.ui && typeof d.ui === "object") {
							ui.trigger = d.ui.trigger !== false;
							ui.menu = d.ui.menu !== false;
						}
						if (!d.available) {
							indexModels([]);
							indexPromotions([]);
							return false;
						}
						indexModels(d.models);
						indexPromotions(d.promotions);
						return true;
					});
				})
				.catch(function () {
					return false;
				});
		}

		var diagSeq = 0;
		function report(extra) {
			if (typeof fetch !== "function") return;
			var payload = {
				plugin: "dsh-model-info",
				at: Date.now(),
				ui: { trigger: ui.trigger, menu: ui.menu },
				models: Object.keys(byKey).length,
				promotions: promoList.length,
				stats: { sweeps: stats.sweeps, inserts: stats.inserts, lastMs: Math.round(stats.lastMs) },
				seq: ++diagSeq,
			};
			for (var k in extra || {}) payload[k] = extra[k];
			try {
				fetch(DIAG, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					keepalive: true,
				}).catch(function () {});
			} catch (e) {}
		}

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var raf = 0;
			var timer = null;
			var boundary = null;
			var observer = null;
			var disposed = false;

			function sweepAll() {
				var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
				stats.sweeps++;
				try {
					if (ui.trigger) {
						var triggers = document.querySelectorAll('[class*="_triggerLabel"]');
						for (var i = 0; i < triggers.length; i++) decorateTrigger(triggers[i]);
					}
					if (ui.menu) {
						var options = document.querySelectorAll('[class*="_modelOption"]');
						for (var j = 0; j < options.length; j++) decorateRow(options[j]);
						reorderAll();
					}
				} catch (e) {
					// 被装饰的 DOM 属于宿主；形状变化不允许抛错
				}
				stats.lastMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
			}

			function schedule() {
				if (raf) return;
				var run = function () {
					raf = 0;
					if (typeof document !== "undefined" && document.hidden) return;
					if (observer) observer.disconnect();
					try {
						sweepAll();
					} finally {
						if (observer) observe();
					}
				};
				raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 16);
			}

			function observe() {
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["aria-label", "aria-checked", "aria-expanded"],
				});
			}

			function onMutations(records) {
				var touched = false;
				for (var i = 0; i < records.length; i++) {
					var rec = records[i];
					if (rec.type === "attributes") {
						// 触发器上的 aria-label 变化 = 模型换了。
						var t = rec.target;
						if (t && t.matches && t.matches('[class*="_trigger"]')) {
							decorateTrigger(t);
							touched = true;
						}
						continue;
					}
					for (var j = 0; j < rec.addedNodes.length; j++) {
						collect(rec.addedNodes[j]);
					}
					if (rec.addedNodes.length) touched = true;
				}
				if (touched) schedule();
			}

			// 悬浮卡：事件委托，一个监听器覆盖所有名字热区。
			function onOver(e) {
				if (!e || !e.target || !e.target.closest) return;
				var a = e.target.closest("[" + ANCHOR + "]");
				if (!a) return;
				if (a === tipAnchor) return;
				showTipFor(a);
			}

			function onOut(e) {
				if (!e || !e.target || !e.target.closest) return;
				var a = e.target.closest("[" + ANCHOR + "]");
				if (!a) return;
				var to = e.relatedTarget;
				// 从名字移到它自己的徽标上（徽标在热区外）也算离开。
				if (to && a.contains && a.contains(to)) return;
				hideTip();
			}

			function onKey(e) {
				if (e && e.key === "Escape") hideTip();
			}

			// 安装时做一次整页扫描（此时输入框已渲染），之后
			// mutation 只触发按子树的工作。
			fetchModels().then(function () {
				sweepAll();
				report({ event: "install" });
			});

			timer = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				fetchModels().then(function (ok) {
					// 新快照可能带来/撤掉某一行的详情：先收起旧卡，再重扫。
					hideTip();
					if (ok) sweepAll();
				});
			}, REFRESH_MS);

			// 促销时段边界：状态真的翻了才重铺，平时零 DOM 开销。
			boundary = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				if (!promotionsChanged()) return;
				indexPromotions(promoList);
				hideTip();
				sweepAll();
				report({ event: "promotion-boundary" });
			}, BOUNDARY_TICK_MS);

			observer = new MutationObserver(onMutations);
			observe();
			document.addEventListener("mouseover", onOver, true);
			document.addEventListener("mouseout", onOut, true);
			document.addEventListener("keydown", onKey, true);
			// 滚动/缩放后锚点位置失效：直接收起，下次悬停重新定位。
			window.addEventListener("scroll", hideTip, true);
			window.addEventListener("resize", hideTip, true);

			return function dispose() {
				if (disposed) return;
				disposed = true;
				if (timer) clearInterval(timer);
				if (boundary) clearInterval(boundary);
				if (raf) {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
					else clearTimeout(raf);
				}
				hideTip();
				if (observer) observer.disconnect();
				document.removeEventListener("mouseover", onOver, true);
				document.removeEventListener("mouseout", onOut, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("scroll", hideTip, true);
				window.removeEventListener("resize", hideTip, true);
				try {
					// 先摘徽标，再把热区从名字元素上摘掉（宽度恢复成撑满整行）。
					var badges = document.querySelectorAll("[" + MARK + "]");
					for (var i = 0; i < badges.length; i++) {
						if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
					}
					var hots = document.querySelectorAll("[" + HOT + "]");
					for (var h = 0; h < hots.length; h++) clearHot(hots[h]);
					var anchors = document.querySelectorAll("[" + ANCHOR + "]");
					for (var j = 0; j < anchors.length; j++) anchors[j].removeAttribute(ANCHOR);
					// 宿主原生 title 原样还回去。
					var titled = document.querySelectorAll('[class*="_modelOption"], [class*="_trigger"]');
					for (var k = 0; k < titled.length; k++) {
						if (!savedTitles.has(titled[k])) continue;
						var saved = savedTitles.get(titled[k]);
						if (typeof saved === "string") titled[k].setAttribute("title", saved);
					}
				} catch (e) {}
				unstylize();
				savedTitles = new WeakMap();
				decorated = new WeakMap();
				orderRestored();
			};
		}

		var inject = [];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-model-info: model metadata badges");
		}

		exports.ROUTE = ROUTE;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			rateText: rateText,
			tagLabel: tagLabel,
			indexModels: function (models) {
				indexModels(models);
				return byKey;
			},
			indexPromotions: function (list) {
				indexPromotions(list);
				return promoByModel;
			},
			parseClock: parseClock,
			zonedMinutes: zonedMinutes,
			scheduleActive: scheduleActive,
			effectiveRate: effectiveRate,
			lookup: lookup,
			tooltip: tooltip,
			fmtContext: fmtContext,
			scheduleSummary: scheduleSummary,
			activitiesFor: activitiesFor,
			reorderGroup: reorderGroup,
			isPinnedRow: isPinnedRow,
			ensureStyles: ensureStyles,
		};
		return module.exports;
	},
});
