/**
 * dsh-model-info —— 浏览器半。
 *
 * 职责：把每模型的额外信息注入 UI。对每个上游网关给出倍率的模型，展示：
 *   · 网关自己的展示倍率，在 /model 行内右对齐，并在输入框的模型名后显示
 *     （`0.29x`，或 x0.00 时显示 `免费`）；
 *   · 载荷真的携带的标签（`免费` / `文生图` / `图生图` / `试用` / `推荐`）。
 *     诸如 `夜间免费` 这类营销标签网关并未发布，**刻意不编造**；
 *   · 一个 tooltip，含倍率说明、描述、上下文窗口与思考档
 *     （相当于官方选择器的详情卡，压进一个 title 属性里）。
 *
 * DOM 纪律（这部分正是以前把模型列表卡死的原因）：
 *   · 绝不 observe `class` 变化。只用 `childList + subtree` 加窄
 *     `attributeFilter`（aria-label / aria-checked / aria-expanded）；
 *   · 绝不在 mutation 回调里扫描整个文档。只看新增子树，
 *     整页扫描只在安装时跑一次；
 *   · 最多一次 rAF 合帧；按节点用 WeakMap 幂等 —— 未变动的行
 *     只花一次字符串比较，别的什么都不做；
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
		var REFRESH_MS = 600000; // 10 min; the host cache is 5 min

		var CSS_TEXT = [
			// 行内徽标绝不换行、绝不把行撑开：菜单行保持一行，
			// 其余信息全部放进悬浮提示。
			'.dmi-badge{display:inline-flex;align-items:center;flex:none;margin-left:4px;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap;vertical-align:1px;pointer-events:none}',
			'.dmi-rate{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16));color:var(--dsw-alias-label-caption,gray)}',
			'.dmi-menu-rate{margin-left:auto;padding-left:6px;background:0 0;color:var(--dsw-alias-label-caption,gray);font-weight:500}',
			'.dmi-free{background:var(--dsw-alias-state-success-primary,#2a9d4a);color:#fff}',
			'.dmi-trial{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16));color:var(--dsw-alias-label-caption,gray)}',
			'.dmi-tag{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16));color:var(--dsw-alias-label-caption,gray)}',
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
		var ui = { trigger: true, menu: true };

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
		}

		function lookup(text) {
			if (!text) return null;
			var key = String(text).trim().toLowerCase();
			if (!key) return null;
			if (byKey[key]) return byKey[key];
			// 触发器渲染的是 "Model · Effort"；只匹配其中的模型部分。
			var head = key.split("·")[0].trim();
			return byKey[head] || null;
		}

		function fmtContext(n) {
			if (!n) return null;
			if (n >= 1000000) return String(Math.round(n / 100000) / 10) + "M";
			if (n >= 1000) return String(Math.round(n / 1000)) + "K";
			return String(n);
		}

		function tooltip(rec) {
			var parts = [];
			if (rec.free) parts.push("上游倍率 x0.00 —— 不计 credits（上游唯一验证过的硬映射）");
			else if (rec.rate) parts.push("上游展示倍率 " + rec.rate + "（网关 credits 字段；相对展示口径，与实际消耗不成线性，不能当单价用）");
			var labels = [];
			if (rec.free) labels.push("免费");
			for (var i = 0; i < rec.tags.length; i++) labels.push(tagLabel(rec.tags[i]));
			if (rec.craft) labels.push("推荐");
			if (rec.trial) labels.push("试用 " + rec.trial + " 天");
			if (labels.length) parts.push("标签 " + labels.join(" / "));
			if (rec.description) parts.push(rec.description);
			var ctx = fmtContext(rec.context);
			if (ctx) parts.push("上下文 " + ctx);
			if (rec.efforts.length) parts.push("思考档 " + rec.efforts.join(" / "));
			if (rec.vision) parts.push("支持图片输入");
			return parts.join("\n");
		}

		// ------------------------------------------------------------------
		// 按节点的装饰状态：WeakMap target -> { sig, nodes }。
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

		function removeNodes(entry) {
			if (!entry || !entry.nodes) return;
			for (var i = 0; i < entry.nodes.length; i++) {
				var n = entry.nodes[i];
				if (n && n.parentNode) n.parentNode.removeChild(n);
			}
		}

		function applyTo(target, kind, rec) {
			if (!target || !target.parentNode) return;
			var sig;
			var nodes = [];
			if (kind === "trigger") {
				sig = rec.free ? "F" : rec.rate || "-";
				if (rec.free || rec.rate) {
					var b = makeBadge(rec.free ? "dmi-free" : "dmi-rate", rec.free ? "免费" : rec.rate);
					b.title = tooltip(rec);
					nodes.push(b);
				}
			} else {
				// ONE line only: `免费` OR the rate, never both, and no tag chips.
				// 载荷里没有营销标签（/v3/config 没有这类字段），
				// 所以没有别的值得做成 chip；标签、试用、
				// 描述、上下文与思考档全部放进悬浮提示。
				var head = rec.free ? { cls: "dmi-free", text: "免费" } : rec.rate ? { cls: "dmi-rate", text: rec.rate } : null;
				sig = head ? head.text : "-";
				var tip = tooltip(rec);
				if (head) {
					var h = makeBadge(head.cls, head.text);
					h.title = tip;
					nodes.push(h);
				}
				if (!nodes.length) return;
			}

			var prev = decorated.get(target);
			if (prev && prev.sig === sig) {
				var alive = prev.nodes.length > 0;
				for (var k = 0; k < prev.nodes.length; k++) {
					if (!prev.nodes[k].parentNode) { alive = false; break; }
				}
				if (alive) return;
			}
			removeNodes(prev);

			// 锚点：触发器徽标放在标签之后；行内徽标放在**行容器**末尾（勾选列之前）——
			// 宿主的 _optionCopy 是纵向列（名字 + 描述），插进去必然换行并被拉伸，
			// 所以绝不能插到 _modelName 的父节点里。
			var anchor = target.querySelector(kind === "trigger" ? '[class*="_triggerLabel"]' : '[class*="_modelName"]');
			if (!anchor) return;
			var parent = anchor.parentNode;
			if (!parent) return;
			if (kind === "row") {
				var check = target.querySelector('[class*="_check"]');
				for (var n = 0; n < nodes.length; n++) {
					var node = nodes[n];
					node.style.marginLeft = "auto";
					if (check && check.parentNode === target) target.insertBefore(node, check);
					else target.appendChild(node);
					stats.inserts++;
				}
			} else {
				for (var m = 0; m < nodes.length; m++) {
					parent.insertBefore(nodes[m], anchor.nextSibling);
					stats.inserts++;
				}
			}
			decorated.set(target, { sig: sig, nodes: nodes });
		}

		function decorateTrigger(labelOrButton) {
			if (!ui.trigger) return;
			var button = labelOrButton;
			if (button && button.matches && button.matches('[class*="_triggerLabel"]')) button = button.parentElement;
			if (!button || !button.querySelector) return;
			var label = button.querySelector('[class*="_triggerLabel"]');
			if (!label) return;
			var rec = lookup(label.textContent);
			if (!rec) return;
			applyTo(button, "trigger", rec);
		}

		function decorateRow(option) {
			if (!ui.menu || !option || !option.querySelector) return;
			var nameEl = option.querySelector('[class*="_modelName"]');
			if (!nameEl) return;
			var rec = lookup(nameEl.textContent);
			if (!rec) return;
			applyTo(option, "row", rec);
		}

		/** 只检查一个新增子树 —— 绝不扫描整个文档。 */
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
							return false;
						}
						indexModels(d.models);
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
			var observer = null;

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

			// 安装时做一次整页扫描（此时输入框已渲染），之后
			// mutation 只触发按子树的工作。
			fetchModels().then(function () {
				sweepAll();
				report({ event: "install" });
			});

			timer = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				fetchModels().then(function (ok) {
					if (ok) sweepAll();
				});
			}, REFRESH_MS);

			observer = new MutationObserver(onMutations);
			observe();

			return function dispose() {
				if (timer) clearInterval(timer);
				if (raf) {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
					else clearTimeout(raf);
				}
				if (observer) observer.disconnect();
				try {
					var badges = document.querySelectorAll("span[" + MARK + "]");
					for (var i = 0; i < badges.length; i++) {
						if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
					}
				} catch (e) {}
				decorated = new WeakMap();
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
			lookup: lookup,
			tooltip: tooltip,
			fmtContext: fmtContext,
		};
		return module.exports;
	},
});
