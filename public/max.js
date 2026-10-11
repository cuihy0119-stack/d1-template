// Max 助手（悬浮球 + 灵动岛）。不拖慢网站：页面空闲时才放出悬浮球，第一次用到才搭窗口；动画只用 transform/opacity。
// 悬浮球可上下拖动（位置会记住）；点一下展开成顶部的灵动岛。Max 能读当前页面文字，随时总结分析。
// 思考/回答时标志的光芒一伸一缩、慢慢转（像老版 Claude 的思考动画）。
// 其它脚本：Max.open(ctx, 问题) 带上下文提问；Max.setCtx(ctx) 换上下文；Max.tip(文字) 在灵动岛上短暂提示（本地算的，不花额度）。
// ctx：{ q: 正在做的题 } { a: 已交的作答 } { explain: 作答id（一键讲解，有缓存）} { marked: true（解析标记的题）}
const Max = (() => {
	const KEY = "max_chat", POS = "max_y", TIMEOUT = 60000;
	const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch {} return null; };
	const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
	let hist = [], ctx = {}, ui = null, ball = null, tipT = 0, pendingTip = "", job = null; // job：正在进行的请求（可停止）
	try { hist = JSON.parse(ss(KEY) || "[]"); if (!Array.isArray(hist)) hist = []; } catch { hist = []; }
	const keep = () => ss(KEY, JSON.stringify(hist.slice(-12)));
	const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));

	// Claude 风格的橙色放射状标志；每根光芒带不同的动画延迟，思考时错落伸缩
	const LOGO = `<svg viewBox="-12 -12 24 24" width="26" height="26" aria-hidden="true"><g stroke="#D97757" stroke-width="2.3" stroke-linecap="round">${
		[10, 7.6, 9.4, 7.2, 10, 8, 9.2, 7.4, 10, 7.8, 9.6, 7.3].map((r, i) => {
			const a = ((i * 30 + (i % 3) * 4) * Math.PI) / 180, f = (n) => n.toFixed(2);
			return `<line x1="${f(Math.cos(a) * 2.2)}" y1="${f(Math.sin(a) * 2.2)}" x2="${f(Math.cos(a) * r)}" y2="${f(Math.sin(a) * r)}" style="animation-delay:-${f(((i * 5) % 12) * 0.09)}s"/>`;
		}).join("")}</g></svg>`;
	const logo = (cls = "") => el("span", { className: "mlogo " + cls, innerHTML: LOGO });
	const setBusy = (on) => { document.body.classList.toggle("max-busy", on); };

	// ---------- 悬浮球 ----------
	const clampY = (y) => Math.min(Math.max(y, 60), innerHeight - 120);
	function makeBall() {
		ball = el("button", { type: "button", className: "maxball", title: "Max 助手" }, logo());
		const y = Number(ls(POS)) || 0;
		if (y) ball.style.top = clampY(y) + "px";
		let sy = 0, oy = 0, moved = false, down = false;
		ball.addEventListener("pointerdown", (e) => { down = true; sy = e.clientY; oy = ball.getBoundingClientRect().top; moved = false; try { ball.setPointerCapture(e.pointerId); } catch {} });
		ball.addEventListener("pointermove", (e) => {
			if (!down) return;
			const d = e.clientY - sy;
			if (!moved && Math.abs(d) > 6) { moved = true; ball.classList.add("drag"); }
			if (moved) ball.style.transform = `translateY(${clampY(oy + d) - oy}px)`; // 拖动只改 transform，不触发重排
		});
		const end = (tap) => {
			if (!down) return;
			down = false;
			if (moved) { // 先落位再恢复动画，免得松手时弹一下
				const t = ball.getBoundingClientRect().top;
				ball.style.transform = ""; ball.style.top = t + "px"; ls(POS, String(Math.round(t)));
				requestAnimationFrame(() => ball.classList.remove("drag"));
			}
			else if (tap) open();
		};
		ball.addEventListener("pointerup", () => end(true));
		ball.addEventListener("pointercancel", () => end(false));
		addEventListener("resize", () => { if (ball.style.top) ball.style.top = clampY(parseFloat(ball.style.top)) + "px"; }, { passive: true });
		document.body.append(ball);
		if (pendingTip) tip(pendingTip);
	}
	idle(makeBall);
	// ⌘K / Ctrl+K 随时呼出或收起 Max（iPad 外接键盘、电脑）
	addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ui?.island.classList.contains("open") ? close() : open(); } });

	// ---------- 灵动岛 ----------
	function build() {
		if (ui) return ui;
		const log = el("div", { className: "mlog" });
		const input = el("textarea", { rows: 1, placeholder: "问 Max…", enterKeyHint: "send", maxLength: 800 });
		const sendB = el("button", { type: "button", className: "msend", textContent: "↑", title: "发送" });
		const chips = el("div", { className: "mchips" });
		const pill = el("div", { className: "mpill" }, logo(), el("span", { className: "mtip" }));
		const body = el("div", { className: "mbody" },
			el("div", { className: "mhead" }, logo(), el("b", { textContent: "Max" }), el("span", { className: "msub", textContent: "能看到当前页面 · 难题找 Claude" }),
				el("button", { type: "button", textContent: "清空", onclick: () => { stop(); hist = []; keep(); log.replaceChildren(); hello(); } }),
				el("button", { type: "button", textContent: "收起", onclick: () => close() })),
			log, chips, el("div", { className: "min" }, input, sendB));
		const island = el("section", { className: "island" }, pill, body);
		pill.onclick = () => open();
		sendB.onclick = () => (job ? stop() : send());
		input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
		input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
		document.addEventListener("pointerdown", (e) => { if (island.classList.contains("open") && !island.contains(e.target) && !ball?.contains(e.target)) close(); }, { passive: true });
		document.addEventListener("keydown", (e) => { if (e.key === "Escape" && island.classList.contains("open")) close(); });
		// 弹出键盘时（iOS）窗口高度跟着可见区域缩，输入框不被挡
		const vv = window.visualViewport;
		vv?.addEventListener("resize", () => { if (island.classList.contains("open")) body.style.maxHeight = Math.max(220, vv.height - 24) + "px"; });
		// 动作按钮：整理错题（事件委托，只挂一次）
		log.addEventListener("click", (e) => { if (e.target.closest(".mgo[data-act=org]")) orgNow(); });
		document.body.append(island);
		const sub = body.querySelector(".msub");
		ui = { island, body, log, input, sendB, chips, tipEl: pill.querySelector(".mtip") };
		ui.status = () => { // 两个引擎的状态：打开窗口时才查，10 分钟内用缓存
			if (ui.statusDone) return;
			ui.statusDone = true;
			const show = (s) => { sub.textContent = `Cloudflare 额度 ${s.cf}% · DeepSeek ${s.ds.on ? "✓" : "未接上（" + s.ds.msg + "）"}${s.sec ? ` · 今天拦截 ${s.sec} 次可疑访问` : ""}`; };
			let st = null; try { st = JSON.parse(ss("max_st") || "null"); } catch {}
			if (st && Date.now() - st.at < 600000) show(st.s);
			else api("/api/max/status").then((s) => { show(s); ss("max_st", JSON.stringify({ at: Date.now(), s })); }).catch(() => {});
		};
		return ui;
	}

	// 回答排版：转义后只认 **加粗**、动作按钮，公式交给 KaTeX
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const PAGES = { "/": "首页", "/wrong": "错题本", "/bank": "题库" };
	function paint(div, text, final) {
		const h = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s*/gm, "")
			.replace(/\[\[练[:：]([^\]]+)\]\]/g, (_, t) => `<a class="mgo" href="${/今日|今天/.test(t) ? "/quiz" : "/quiz?topic=" + encodeURIComponent(t.trim())}">📝 练：${t.trim()}</a>`)
			.replace(/\[\[去[:：]\s*(\/[\w/]*)\]\]/g, (_, p) => (PAGES[p] ? `<a class="mgo" href="${p}">→ ${PAGES[p]}</a>` : ""))
			.replace(/\[\[整理错题\]\]/g, `<button type="button" class="mgo" data-act="org">🗂 让 Max 整理错题本</button>`)
			.replace(/\[\[[^\]]*$/, ""); // 流式输出时半截的 [[…：先不显示
		div.innerHTML = h;
		if (final) try { math(div); } catch {}
	}
	const scroll = () => { ui.log.scrollTop = ui.log.scrollHeight; };
	function bubble(role, text) {
		const d = el("div", { className: "mb " + role });
		paint(d, text, true);
		ui.log.append(d);
		scroll();
		return d;
	}
	function thinking() { // 思考中：一个会动的标志，代替文字
		const d = el("div", { className: "mb assistant thinking" }, logo("big"), el("span", { textContent: "思考中" }));
		ui.log.append(d);
		scroll();
		return d;
	}
	function hello() {
		if (!hist.length) bubble("assistant", ctx.q ? "我是 Max。卡住了问我要提示（不会直接给答案）。" : "我是 Max，管错题本的助手。可以让我总结这页、整理错题、安排今天先做什么，或者讲一道做错的题。");
	}
	function quick() { // 按页面给几个常用问题
		const more = hist.length && hist[hist.length - 1].role === "assistant" ? ["没懂，再讲详细点"] : []; // 「没懂」会交给 DeepSeek
		const list = ctx.q ? [...more, "给我一点提示", "这题考什么？"] : ctx.a ? [...more, "讲讲这道题", "类似的易错点？"]
			: location.pathname === "/wrong" ? [...more, "总结这页的错题", "整理错题本", "最该先补哪块？"]
			: [...more, "总结这页", "今天先做什么？", "我的薄弱点？"];
		ui.chips.replaceChildren(...list.map((t) => el("button", { type: "button", textContent: t, onclick: () => (t === "整理错题本" ? orgNow() : send(t)) })));
	}
	function open(c, text) {
		build();
		if (c) ctx = c;
		ui.island.classList.remove("peek");
		ui.island.classList.add("open");
		ui.status();
		ball?.classList.add("hide");
		if (!ui.log.childElementCount) { hist.forEach((m) => bubble(m.role, m.content)); hello(); }
		quick();
		requestAnimationFrame(scroll);
		if (text) send(text, c || {});
	}
	function close() {
		if (!ui) return;
		ui.island.classList.remove("open");
		ui.body.style.maxHeight = "";
		ui.input.blur();
		ball?.classList.remove("hide");
	}
	/** 在灵动岛上短暂提示一句（本地生成，不花额度） */
	function tip(text) {
		if (!text) return;
		if (!ball) return void (pendingTip = text); // 页面还在加载：等悬浮球出来再说
		pendingTip = "";
		build();
		if (ui.island.classList.contains("open")) return;
		ui.tipEl.textContent = text;
		ui.island.classList.add("peek");
		clearTimeout(tipT);
		tipT = setTimeout(() => ui.island.classList.remove("peek"), 3800);
	}
	// 当前页面内容：Max 的「眼睛」（只取主区域文字，最多 1500 字；只在发问时读一次）
	const page = () => ({ path: location.pathname, title: document.title, text: (document.querySelector("main")?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 1500) });

	function stop() { if (job) job.abort(); }
	function lock(on) {
		ui.sendB.textContent = on ? "■" : "↑";
		ui.sendB.title = on ? "停止" : "发送";
		ui.sendB.classList.toggle("stop", on);
		setBusy(on);
	}

	async function orgNow() {
		if (job) return;
		build();
		const out = thinking();
		lock(true);
		job = new AbortController();
		try {
			const r = await api("/api/max/organize", { method: "POST", signal: job.signal });
			paint(out, r.done ? `整理好 ${r.done} 道错题（错因 + 一句话诊断）${r.left ? `，还剩 ${r.left} 道，再点一次继续` : "，全部整理完了"}。` : "错题本都整理过了 👍", true);
			window.dispatchEvent(new Event("max:changed"));
		} catch (e) { paint(out, e.name === "AbortError" ? "已停止" : "⚠ " + e.message, true); }
		finally { out.classList.remove("thinking"); job = null; lock(false); }
	}

	async function send(text = ui.input.value.trim(), extra = {}) {
		build();
		if (!text || job) return;
		ui.input.value = ""; ui.input.style.height = "";
		hist.push({ role: "user", content: text });
		bubble("user", text);
		const out = thinking();
		let all = "", raf = 0, ok = false, eng = "";
		job = new AbortController();
		const ctl = job, t = setTimeout(() => ctl.abort("timeout"), TIMEOUT); // 一分钟没说完就停，免得卡住
		lock(true);
		try {
			const one = extra.explain || extra.marked; // 一键讲解只发这一句：命中缓存不花额度
			const r = await fetch("/api/max/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
				body: JSON.stringify({ messages: one ? hist.slice(-1) : hist.slice(-6), ctx: { ...ctx, ...extra, page: one ? undefined : page() } }) });
			if (r.status === 401) return void (location.href = "/login");
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "服务器开小差了（" + r.status + "）");
			eng = r.headers.get("x-max-engine") || "";
			const draw = () => { raf = 0; out.classList.remove("thinking"); paint(out, all, false); scroll(); };
			if (r.body?.getReader) { // 边生成边显示（每帧最多画一次）
				const rd = r.body.getReader(), dec = new TextDecoder();
				for (;;) {
					const { done, value } = await rd.read();
					if (done) break;
					all += dec.decode(value, { stream: true });
					if (!raf) raf = requestAnimationFrame(draw);
				}
			} else all = await r.text();
			ok = true;
		} catch (e) {
			const why = ctl.signal.aborted ? (ctl.signal.reason === "timeout" ? "Max 太久没回应，已停止" : "已停止") : /fetch|network|load failed/i.test(e.message) ? "网络断了，检查一下再试" : e.message;
			all = all.trim() ? all + "\n\n⚠ " + why : "⚠ " + why;
		} finally {
			clearTimeout(t);
			cancelAnimationFrame(raf);
			out.classList.remove("thinking");
			all = all.trim() || "（Max 没说话，换个问法试试）";
			paint(out, all, true);
			if (ok) {
				hist.push({ role: "assistant", content: all }); keep();
				const by = { cf: "Cloudflare 回答", ds: "DeepSeek 回答", cache: "之前讲过（没花额度）" }[eng];
				if (by) out.append(el("div", { className: "meng", textContent: by }));
				quick(); // 出现「没懂，再讲详细点」
			}
			else { hist.pop(); out.append(el("button", { type: "button", className: "mgo", textContent: "↻ 重试", onclick: () => send(text, extra) })); } // 失败的问题不留在上下文里
			job = null;
			lock(false);
			scroll();
		}
	}

	return {
		setCtx(c) { ctx = c || {}; if (ui?.island.classList.contains("open")) quick(); },
		open,
		tip,
	};
})();
