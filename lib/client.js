/**
 * Browser half of dsh-model-info: inject per-model extra info into the UI.
 *
 * What it shows, for each model the upstream gateway publishes a rate for:
 *   - the gateway's own display multiplier, right-aligned in the /model row
 *     and after the composer model name (`0.29x`, or `免费` when x0.00);
 *   - the tags the payload actually carries (`免费` / `文生图` / `图生图` /
 *     `试用` / `推荐`). Market labels such as `夜间免费` are not published by
 *     the gateway and are deliberately not invented;
 *   - a tooltip with the rate explanation, the description, the context
 *     window and the reasoning efforts (the official picker's detail card,
 *     compressed into a title attribute).
 *
 * DOM discipline (this is the part that used to freeze the model list):
 *   - never observe `class` changes. Only `childList + subtree` plus a narrow
 *     `attributeFilter` (aria-label / aria-checked / aria-expanded);
 *   - never scan the whole document from a mutation callback. Only the added
 *     subtree is inspected, and one full scan runs once at install;
 *   - one rAF-coalesced pass at most; per-node idempotency via WeakMap so an
 *     unchanged row costs a string compare and nothing else;
 *   - nothing is inserted into the composer trigger or the menu rows while the
 *     corresponding `ui.*` switch is off.
 *
 * No build step: plain DOM APIs. No react-dom (not in the module loader's
 * require table). Colors come from the host's --dsw-alias-* tokens so dark
 * theme follows automatically.
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
			// Row badges never wrap and never push the row apart: the menu row
			// keeps ONE line, everything extra lives in the hover title.
			'.dmi-badge{display:inline-flex;align-items:center;flex:none;margin-left:4px;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap;vertical-align:1px;pointer-events:none}',
			'.dmi-row{display:inline-flex;align-items:center;flex-wrap:nowrap;flex:none;min-width:0}',
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

		/** 0.29 -> "0.29x"; already-formatted strings pass through. */
		function rateText(v) {
			if (v == null) return null;
			if (typeof v === "number") return String(v) + "x";
			if (typeof v === "string") return v.replace(/\s*credits\s*$/i, "");
			return null;
		}

		/** Upstream tag ids -> readable labels; unknown tags stay as-is. */
		function tagLabel(tag) {
			if (tag === "text-to-image") return "文生图";
			if (tag === "image-to-image") return "图生图";
			return String(tag);
		}

		// ------------------------------------------------------------------
		// Lookup: keyed by both id and display name, lower-cased, because the
		// composer trigger renders model.name while the catalog also carries id.
		// ------------------------------------------------------------------
		/**
		 * Rebuild both indexes from the WHOLE catalogue. `byName` is rebuilt in
		 * the same pass as `byKey` — never carried over — because a name that
		 * used to be unique (when a model was the only "Hy3") must stop
		 * resolving once a second model publishes the same name. A name key is
		 * kept only while exactly one id in this catalogue owns it.
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
				// Names are NOT unique upstream (Hy3 / hy3-x, Hy4 preview /
				// hy4-preview-x both publish "Hy3" / "Hy4 preview").
				if (m.name) {
					var nk = String(m.name).trim().toLowerCase();
					if (nk) {
						if (owner[nk] && owner[nk] !== rec) dup[nk] = true;
						else owner[nk] = rec;
					}
				}
			}
			for (var k in owner) {
				// An id always wins over a name (the menu row may render either);
				// a name shared by two models resolves to nothing at all.
				if (!idKeys[k] && !dup[k]) next[k] = owner[k];
			}
			byKey = next;
		}

		function lookup(text) {
			if (!text) return null;
			var key = String(text).trim().toLowerCase();
			if (!key) return null;
			if (byKey[key]) return byKey[key];
			// The trigger renders "Model · Effort"; match on the model part.
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
		// Per-node decoration state: WeakMap target -> { sig, nodes }.
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
				// The payload carries no market labels (/v3/config has no such
				// field), so there is nothing else worth a chip; tags, trial,
				// description, context and efforts all go into the hover title.
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

			// Anchor: the trigger badge goes after the label; the row badge sits at
			// the END of its own line — before the trailing check column when that
			// column shares the row, otherwise as the row's last child so it never
			// steals width from the model name or pushes anything to a second line.
			var anchor = target.querySelector(kind === "trigger" ? '[class*="_triggerLabel"]' : '[class*="_modelName"]');
			if (!anchor) return;
			var parent = anchor.parentNode;
			if (!parent) return;
			if (kind === "row") {
				var check = target.querySelector('[class*="_check"]');
				for (var n = 0; n < nodes.length; n++) {
					var node = nodes[n];
					if (check && check.parentNode === parent) parent.insertBefore(node, check);
					else if (parent === target) target.appendChild(node);
					else parent.appendChild(node);
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

		/** Inspect one added subtree only — never the whole document. */
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
				// a DOM we do not own changed shape; skip this node
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
					// the DOM we decorate is host-owned; a shape change must not throw
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
						// aria-label changes on a trigger = the model changed.
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

			// One full pass at install (the composer is already on screen), then
			// only per-subtree work from mutations.
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
