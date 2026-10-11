// Max 助手（悬浮球 + 灵动岛）。不拖慢网站：页面空闲时才放出悬浮球，第一次点开才搭聊天窗口；动画只用 transform/opacity。
// 悬浮球可上下拖动（位置会记住）；点一下展开成顶部的灵动岛窗口。Max 能读当前页面内容，随时总结分析。
// 其它脚本：Max.open(ctx, 问题) 带上下文提问；Max.setCtx(ctx) 换上下文；Max.tip(文字) 在灵动岛上短暂提示（本地算的，不花额度）。
// ctx：{ q: 正在做的题 } { a: 已交的作答 } { explain: 作答id（一键讲解，有缓存）} { marked: true（解析标记的题）}
const Max = (() => {
	const KEY = "max_chat", POS = "max_y";
	const store = (k, v) => { try { v === undefined ? (v = sessionStorage[k]) : (sessionStorage[k] = v); } catch {} return v; };
	let hist = [], ctx = {}, busy = false, ui = null, ball = null, tipT = 0, pendingTip = "";
	try { hist = JSON.parse(store(KEY) || "[]"); } catch {}
	const keep = () => store(KEY, JSON.stringify(hist.slice(-12)));
	// Claude 风格的橙色放射状标志
	const LOGO = `<svg viewBox="-12 -12 24 24" width="26" height="26" aria-hidden="true"><g stroke="#D97757" stroke-width="2.3" stroke-linecap="round">${
		[10, 7.6, 9.4, 7.2, 10, 8, 9.2, 7.4, 10, 7.8, 9.6, 7.3].map((r, i) => { const a = (i * 30 + (i % 3) * 4) * Math.PI / 180; return `<line x1="${(Math.cos(a) * 2.2).toFixed(2)}" y1="${(Math.sin(a) * 2.2).toFixed(2)}" x2="${(Math.cos(a) * r).toFixed(2)}" y2="${(Math.sin(a) * r).toFixed(2)}"/>`; }).join("")}</g></svg>`;

	// ---------- 悬浮球（空闲时创建） ----------
	function makeBall() {
		ball = el("button", { type: "button", className: "maxball", title: "Max 助手", innerHTML: LOGO });
		let y = 0; try { y = Number(localStorage.getItem(POS)) || 0; } catch {}
		if (y) ball.style.top = Math.min(Math.max(y, 60), innerHeight - 120) + "px";
		let sy = 0, oy = 0, moved = false;
		ball.addEventListener("pointerdown", (e) => { sy = e.clientY; oy = ball.getBoundingClientRect().top; moved = false; ball.setPointerCapture(e.pointerId); });
		ball.addEventListener("pointermove", (e) => {
			if (!ball.hasPointerCapture(e.pointerId)) return;
			const d = e.clientY - sy;
			if (Math.abs(d) > 6) moved = true;
			if (moved) ball.style.top = Math.min(Math.max(oy + d, 60), innerHeight - 120) + "px";
		});
		ball.addEventListener("pointerup", () => { if (moved) { try { localStorage.setItem(POS, parseInt(ball.style.top)); } catch {} } else open(); });
		document.body.append(ball);
		if (pendingTip) tip(pendingTip);
	}
	(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(makeBall);

	// ---------- 灵动岛（第一次用到才搭） ----------
	function build() {
		if (ui) return ui;
		const log = el("div", { className: "mlog" });
		const input = el("textarea", { rows: 1, placeholder: "问 Max…", enterKeyHint: "send" });
		const sendB = el("button", { type: "button", className: "msend", textContent: "↑", title: "发送" });
		const chips = el("div", { className: "mchips" });
		const pill = el("div", { className: "mpill" }, el("span", { className: "mlogo", innerHTML: LOGO }), el("span", { className: "mtip" }));
		const body = el("div", { className: "mbody" },
			el("div", { className: "mhead" }, el("span", { className: "mlogo", innerHTML: LOGO }), el("b", { textContent: "Max" }), el("span", { className: "msub", textContent: "能看到当前页面 · 难题找 Claude" }),
				el("button", { type: "button", textContent: "清空", onclick: () => { hist = []; keep(); log.replaceChildren(); hello(); } }),
				el("button", { type: "button", textContent: "收起", onclick: () => close() })),
			log, chips, el("div", { className: "min" }, input, sendB));
		const island = el("section", { className: "island" }, pill, body);
		pill.onclick = () => open();
		sendB.onclick = () => send();
		input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
		input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
		document.addEventListener("pointerdown", (e) => { if (island.classList.contains("open") && !island.contains(e.target) && e.target !== ball && !ball?.contains(e.target)) close(); }, { passive: true });
		document.body.append(island);
		return (ui = { island, log, input, sendB, chips, tipEl: pill.querySelector(".mtip") });
	}

	// 回答排版：转义后只认 **加粗**、动作按钮，公式交给 KaTeX
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	function paint(div, text, final) {
		let h = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s*/gm, "");
		h = h.replace(/\[\[练[:：]([^\]]+)\]\]/g, (_, t) => `<a class="mgo" href="${/今日|今天/.test(t) ? "/quiz" : "/quiz?topic=" + encodeURIComponent(t.trim())}">📝 练：${t.trim()}</a>`)
			.replace(/\[\[去[:：]\s*(\/[\w/]*)\]\]/g, (_, p) => `<a class="mgo" href="${p}">→ ${({ "/": "首页", "/wrong": "错题本", "/bank": "题库" })[p] || p}</a>`)
			.replace(/\[\[整理错题\]\]/g, `<button type="button" class="mgo" data-act="org">🗂 让 Max 整理错题本</button>`);
		div.innerHTML = h;
		if (final) math(div);
	}
	function bubble(role, text) {
		const d = el("div", { className: "mb " + role });
		paint(d, text, true);
		ui.log.append(d);
		ui.log.scrollTop = ui.log.scrollHeight;
		return d;
	}
	function hello() {
		if (!hist.length) bubble("assistant", ctx.q ? "我是 Max。卡住了问我要提示（不会直接给答案）。" : "我是 Max，管错题本的助手。可以让我总结这页、整理错题、安排今天先做什么，或者讲一道做错的题。");
	}
	function quick() { // 按页面给几个常用问题
		const list = ctx.q ? ["给我一点提示", "这题考什么？"] : ctx.a ? ["讲讲这道题", "类似的易错点？"]
			: location.pathname === "/wrong" ? ["总结这页的错题", "整理错题本", "最该先补哪块？"]
			: ["总结这页", "今天先做什么？", "我的薄弱点？"];
		ui.chips.replaceChildren(...list.map((t) => el("button", { type: "button", textContent: t, onclick: () => (t === "整理错题本" ? orgNow() : send(t)) })));
	}
	function open(c, text) {
		build();
		if (c) ctx = c;
		ui.island.classList.add("open");
		ball?.classList.add("hide");
		if (!ui.log.childElementCount) { hist.forEach((m) => bubble(m.role, m.content)); hello(); }
		quick();
		ui.log.scrollTop = ui.log.scrollHeight;
		if (text) send(text, c || {});
	}
	function close() {
		ui?.island.classList.remove("open");
		ball?.classList.remove("hide");
	}
	/** 在灵动岛上短暂提示一句（本地生成，不花额度） */
	function tip(text) {
		if (!text) return;
		if (!ball) return void (pendingTip = text); // 页面还在加载：等悬浮球出来再说
		build();
		if (ui.island.classList.contains("open")) return;
		ui.tipEl.textContent = text;
		ui.island.classList.add("peek");
		clearTimeout(tipT);
		tipT = setTimeout(() => ui.island.classList.remove("peek"), 3800);
	}
	// 当前页面内容：Max 的「眼睛」（只取主区域文字，最多 1500 字）
	const page = () => ({ path: location.pathname, title: document.title, text: (document.querySelector("main")?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 1500) });

	async function orgNow() {
		const out = bubble("assistant thinking", "正在整理错题本…");
		try {
			const r = await api("/api/max/organize", { method: "POST" });
			out.classList.remove("thinking");
			paint(out, r.done ? `整理好 ${r.done} 道错题（错因 + 一句话诊断）${r.left ? `，还剩 ${r.left} 道，再点一次继续` : "，全部整理完了"}。` : "错题本都整理过了 👍", true);
			if (location.pathname === "/wrong") window.dispatchEvent(new Event("max:changed"));
		} catch (e) { out.classList.remove("thinking"); paint(out, "⚠ " + e.message, true); }
	}

	async function send(text = ui.input.value.trim(), extra = {}) {
		if (!text || busy) return;
		busy = true; ui.sendB.disabled = true; ui.input.value = ""; ui.input.style.height = "";
		hist.push({ role: "user", content: text });
		bubble("user", text);
		const out = bubble("assistant thinking", "Max 正在想…");
		let all = "";
		try {
			const one = extra.explain || extra.marked; // 一键讲解只发这一句：命中缓存不花额度
			const r = await fetch("/api/max/chat", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: one ? hist.slice(-1) : hist.slice(-6), ctx: { ...ctx, ...extra, page: one ? undefined : page() } }) });
			if (r.status === 401) return void (location.href = "/login");
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
			out.classList.remove("thinking");
			if (r.body?.getReader) { // 边生成边显示（每帧最多画一次）
				const rd = r.body.getReader(), dec = new TextDecoder();
				let raf = 0;
				for (;;) {
					const { done, value } = await rd.read();
					if (done) break;
					all += dec.decode(value, { stream: true });
					if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(out, all, false); ui.log.scrollTop = ui.log.scrollHeight; });
				}
			} else all = await r.text();
			all = all.trim() || "（Max 没说话，换个问法试试）";
			paint(out, all, true);
			hist.push({ role: "assistant", content: all });
			keep();
		} catch (e) {
			out.classList.remove("thinking");
			paint(out, "⚠ " + e.message, true);
			hist.pop(); // 失败的问题不留在上下文里
		} finally {
			busy = false; ui.sendB.disabled = false;
			ui.log.scrollTop = ui.log.scrollHeight;
		}
	}
	document.addEventListener("click", (e) => { if (e.target.closest?.(".mgo[data-act=org]")) orgNow(); });

	return {
		setCtx(c) { ctx = c || {}; if (ui?.island.classList.contains("open")) quick(); },
		open,
		tip,
	};
})();
