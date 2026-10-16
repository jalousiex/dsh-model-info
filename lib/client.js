/**
 * Browser half of dsh-model-info: inject per-model extra info into the UI.
 *
 * What it shows, for each model the upstream gateway publishes a rate for:
 *   - a `x0.51` multiplier badge (the gateway's own display rate), and
 *   - a `免费` badge when the rate is exactly x0.00 — the one mapping the
 *     upstream is actually verified for (zero billing).
 *
 * Honesty rule baked into the labels: the multiplier is presented as
 * 「倍率」, with a title tooltip stating it is the gateway's display rate and
 * not a linear price. We never render "costs N times as much".
 *
 * Injection technique: CSS-module class names are hashed per build
 * (`wq12jW_triggerLabel`), but the readable token survives as a suffix, so we
 * match `[class*="_triggerLabel"]` — the same technique dsh-mobile and
 * dsh-tap-quota use for the sidebar. A MutationObserver handles re-mounts and
 * the model menu opening.
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
		var MARK = "data-dsh-model-info";
		var REFRESH_MS = 300000; // 5 min; host cache is 5 min too

		var CSS_TEXT = [
			".dmi-badge{display:inline-flex;align-items:center;gap:0;flex:none;margin-left:4px;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap;vertical-align:1px}",
			".dmi-rate{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.16));color:var(--dsw-alias-label-caption,gray)}",
			".dmi-free{background:var(--dsw-alias-state-success-primary,#2a9d4a);color:#fff}",
			".dmi-menu{margin-left:auto;padding-left:6px}",
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

		/** "x0.51 credits" -> "x0.51"; already-numeric input passes through. */
		function fmtRate(v) {
			if (v == null) return null;
			if (typeof v === "number") return "x" + String(v);
			if (typeof v === "string") return v.replace(/\s*credits\s*$/i, "");
			return null;
		}

		// ------------------------------------------------------------------
		// Lookup: keyed by both id and display name, lower-cased, because the
		// composer trigger renders model.name while the catalog also carries id.
		// ------------------------------------------------------------------
		var byKey = Object.create(null);

		function indexModels(models) {
			var next = Object.create(null);
			for (var i = 0; i < models.length; i++) {
				var m = models[i];
				if (!m) continue;
				var rate = fmtRate(m.credits != null ? m.credits : m.multiplier);
				var rec = { rate: rate, free: m.free === true, name: m.name };
				if (m.id) next[String(m.id).toLowerCase()] = rec;
				if (m.name) next[String(m.name).toLowerCase()] = rec;
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

		// ------------------------------------------------------------------
		// Badge placement
		// ------------------------------------------------------------------
		function badgeFor(rec, inMenu) {
			var span = document.createElement("span");
			span.setAttribute(MARK, "");
			span.className = "dmi-badge" + (inMenu ? " dmi-menu" : "");
			if (rec.free) {
				span.className += " dmi-free";
				span.textContent = "免费";
				span.title = "上游倍率 x0.00 —— 不计 credits（上游唯一验证过的硬映射）";
				return span;
			}
			if (rec.rate) {
				span.className += " dmi-rate";
				span.textContent = rec.rate;
				span.title = "上游展示倍率（网关 credits 字段）。注意：它是相对展示口径，与实际消耗不成线性，不能当单价用。";
				return span;
			}
			return null;
		}

		/**
		 * Refresh one label element's badge. Idempotent: reuses an existing
		 * badge node and only rewrites it when the content changed.
		 */
		function decorate(el, inMenu) {
			if (!el || el.getAttribute(MARK + "-host") === "1") return;
			var rec = lookup(el.textContent);
			var existing = el.parentNode ? el.parentNode.querySelector(":scope > span[" + MARK + "]") : null;
			if (!rec) {
				if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
				return;
			}
			var want = rec.free ? "免费" : rec.rate;
			if (existing && existing.getAttribute("data-dmi-v") === want) return;
			if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
			var badge = badgeFor(rec, inMenu);
			if (!badge) return;
			badge.setAttribute("data-dmi-v", want);
			if (el.nextSibling) el.parentNode.insertBefore(badge, el.nextSibling);
			else el.parentNode.appendChild(badge);
		}

		function sweep() {
			if (typeof document === "undefined") return;
			try {
				var triggers = document.querySelectorAll('[class*="_triggerLabel"]');
				for (var i = 0; i < triggers.length; i++) decorate(triggers[i], false);
				var options = document.querySelectorAll('[class*="_modelOption"]');
				for (var j = 0; j < options.length; j++) decorate(options[j], true);
			} catch (e) {
				/* a DOM we do not own changed shape; skip this sweep */
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
						if (!d || !d.available || !Array.isArray(d.models)) return false;
						indexModels(d.models);
						return true;
					});
				})
				.catch(function () {
					return false;
				});
		}

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var observer = null;
			var timer = null;

			function refresh() {
				fetchModels().then(function () {
					sweep();
				});
			}

			refresh();
			timer = setInterval(refresh, REFRESH_MS);

			observer = new MutationObserver(function () {
				sweep();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class"],
			});

			return function dispose() {
				if (timer) clearInterval(timer);
				if (observer) observer.disconnect();
				try {
					var badges = document.querySelectorAll("span[" + MARK + "]");
					for (var i = 0; i < badges.length; i++) {
						if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
					}
				} catch (e) {}
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
		return module.exports;
	},
});
