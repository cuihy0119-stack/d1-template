// Max：网站常驻助手。右下角（做题页在右上角）的 M 按钮点开聊天；别的脚本用 Max.open(ctx, 问题) 带上下文提问。
// ctx：{ q: 正在做的题 } { a: 已交的作答 } { explain: 作答id（一键讲解，有缓存）} { marked: true（解析标记的题）}
const Max = (() => {
	const KEY = "max_chat";
	let hist = [], ctx = {}, busy = false;
	try { hist = JSON.parse(sessionStorage[KEY] || "[]"); } catch {}
	const keep = () => { try { sessionStorage[KEY] = JSON.stringify(hist.slice(-12)); } catch {} };

	const fab = el("button", { type: "button", className: "maxfab", title: "Max 助手", textContent: "M" });
	const log = el("div", { className: "maxlog" });
	const input = el("textarea", { rows: 1, placeholder: "问 Max…", enterKeyHint: "send" });
	const chips = el("div", { className: "maxchips" });
	const send_ = el("button", { type: "button", className: "btn primary small", textContent: "发送" });
	const panel = el("section", { className: "maxpan", hidden: true },
		el("div", { className: "maxhead" }, el("b", { textContent: "Max" }), el("span", { className: "mute", textContent: "网站助手 · 免费模型，难题找 Claude" }),
			el("button", { type: "button", textContent: "清空", onclick: () => { hist = []; keep(); log.replaceChildren(); hello(); } }),
			el("button", { type: "button", textContent: "×", title: "收起", onclick: () => show(false) })),
		log, chips, el("div", { className: "maxin" }, input, send_));
	document.body.append(fab, panel);

	// 回答排版：转义后只认 **加粗** 和 [[练:科目/考点]] 按钮，公式交给 KaTeX
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	function paint(div, text, final) {
		let h = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s*/gm, "");
		h = h.replace(/\[\[练[:：]([^\]]+)\]\]/g, (_, t) => {
			const href = /今日|今天/.test(t) ? "/quiz" : "/quiz?topic=" + encodeURIComponent(t.trim());
			return `<a class="btn small maxgo" href="${href}">📝 练：${t.trim()}</a>`;
		});
		div.innerHTML = h;
		if (final) math(div);
	}
	function bubble(role, text) {
		const d = el("div", { className: "mb " + role });
		paint(d, text, true);
		log.append(d);
		log.scrollTop = log.scrollHeight;
		return d;
	}
	function hello() {
		if (!hist.length) bubble("assistant", ctx.q ? "我是 Max。卡住了可以问我要提示（不会直接给答案）。" : "我是 Max，网站的学习助手。可以问我今天先做什么、某个考点怎么学，或者讲一道做错的题。");
	}
	function quick() { // 按当前页面给几个常用问题
		const list = ctx.q ? ["给我一点提示", "这题考什么知识点？"] : ctx.a ? ["讲讲这道题", "还有什么类似的易错点？"] : ["今天先做什么？", "我的薄弱点是什么？", "怎么复习效率高？"];
		chips.replaceChildren(...list.map((t) => el("button", { type: "button", className: "chip", textContent: t, onclick: () => send(t) })));
	}
	function show(on = panel.hidden) {
		panel.hidden = !on;
		fab.classList.toggle("on", on);
		if (on) { if (!log.childElementCount) { hist.forEach((m) => bubble(m.role, m.content)); hello(); } quick(); log.scrollTop = log.scrollHeight; }
	}
	fab.onclick = () => show();

	async function send(text = input.value.trim(), extra = {}) {
		if (!text || busy) return;
		busy = true; send_.disabled = true; input.value = "";
		hist.push({ role: "user", content: text });
		bubble("user", text);
		const out = bubble("assistant thinking", "Max 正在想…");
		let all = "";
		try {
			const r = await fetch("/api/max/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: extra.explain || extra.marked ? hist.slice(-1) : hist.slice(-6), ctx: { ...ctx, ...extra } }) }); // 一键讲解只发这一句：命中缓存不花额度
			if (r.status === 401) return (location.href = "/login");
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
			out.classList.remove("thinking");
			if (r.body?.getReader) { // 边生成边显示
				const rd = r.body.getReader(), dec = new TextDecoder();
				for (;;) {
					const { done, value } = await rd.read();
					if (done) break;
					all += dec.decode(value, { stream: true });
					paint(out, all, false);
					log.scrollTop = log.scrollHeight;
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
			busy = false; send_.disabled = false;
			log.scrollTop = log.scrollHeight;
		}
	}
	send_.onclick = () => send();
	input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

	return {
		/** 换页面上下文（做题页切题时调用） */
		setCtx(c) { ctx = c || {}; if (!panel.hidden) quick(); },
		/** 打开并（可选）直接提问；一键讲解/解析的问题带上 ctx，服务器会用缓存 */
		open(c, text) { if (c) ctx = c; show(true); if (text) send(text, c || {}); },
	};
})();
