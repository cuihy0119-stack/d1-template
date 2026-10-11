// 题库 / 错题本：简洁列表（学科标签 + 题目 + 状态）
const MODE = document.body.dataset.mode;
let data = { items: [], today: "" };
let tab = "active"; // 错题本：active 复习中 / mastered 错题文件夹（重做做对的，满 20 道发给 Claude 整理后清掉）
let subject = new URLSearchParams(location.search).get("subject") || "";
tabbar("/" + MODE);

const quizHref = (ids) => "/quiz?ids=" + ids.join(",") + (MODE === "wrong" ? "&from=wrong" : ""); // 错题重做不需要标记按钮
const short = (s) => { // 截断但不切断 $公式$
	if (s.length <= 70) return s;
	let t = s.slice(0, 70);
	if ((t.match(/\$/g) || []).length % 2) t = t.slice(0, t.lastIndexOf("$"));
	return t + "…";
};

function state(q) {
	if (q.pending) return ["待批改", "wait"];
	if (MODE === "wrong") return tab === "mastered" ? ["已改对", "ok"] : q.last === 1 ? ["重做已对", "ok"] : ["待重做", "due"];
	return !q.tries ? ["未做", "new"] : q.last === 1 ? ["✓ 做对", "ok"] : ["✗ 做错", "due"]; // 显示最近一次的结果，不再笼统写「已做」
}

function render() {
	if (MODE === "wrong") {
		$("#tabs").replaceChildren(...[["active", "复习中"], ["mastered", "📁 错题文件夹"]].map(([k, name]) =>
			el("button", { className: "tab" + (tab === k ? " on" : ""), textContent: name, onclick: () => { tab = k; load(); } })));
	}
	const subjects = [...new Set(data.items.map((q) => q.subject))];
	if (subject && !subjects.includes(subject)) subject = "";
	const chips = $("#chips");
	chips.replaceChildren();
	for (const s of ["", ...subjects]) {
		chips.append(el("button", { className: "chip" + (s === subject ? " on" : ""), textContent: s || "全部", onclick: () => { subject = s; render(); } }));
	}

	const shown = data.items.filter((q) => !subject || q.subject === subject);
	const todo = shown.filter((q) => (MODE === "wrong" ? tab === "active" && !q.pending : !q.tries));
	const top = $("#redo");
	top.replaceChildren();
	if (MODE === "wrong" && tab === "mastered") {
		top.append(el("p", { className: "mute", textContent: `重做做对的错题先放这里：${data.items.length}/20。Max 会整理成总结，满 20 道时发给 Claude 做后续（讲评、归档、出巩固题），然后清掉` }));
		if (data.folder) top.append(el("div", { className: "card maxcard" }, el("h2", { textContent: "🤖 Max 的整理" }), el("p", { textContent: data.folder, style: "white-space:pre-wrap" })));
	}
	if (todo.length) {
		const href = MODE === "bank" && subject ? "/quiz?subject=" + encodeURIComponent(subject) : quizHref(todo.map((q) => q.id));
		top.append(el("a", { className: "btn primary", href, style: "text-decoration:none",
			textContent: MODE === "wrong" ? `重做错题（${todo.length}）` : `开始练习（${todo.length} 题未做）` }));
	}

	const list = $("#list");
	list.replaceChildren();
	if (!shown.length) list.append(el("p", { className: "mute", textContent: MODE === "wrong" ? (tab === "mastered" ? "文件夹是空的，错题重做做对后会放进来" : "还没有错题，做错的题会自动收进来") : "还没有题" }));
	shown.forEach((q, i) => { const r = row(q); if (i < 16) r.style.setProperty("--i", i); list.append(r); }); // 前 16 条依次浮现
	math(list);
}

function row(q) {
	const [label, cls] = state(q);
	const del = el("button", { type: "button", className: "del", textContent: "🗑 删除", onclick: async (e) => { e.stopPropagation(); if (await delQuestion(q.id)) load(); } });
	const tag = subject ? q.category || q.subject : q.subject;
	const item = el("div", { className: "item" },
		el("div", { className: "body" },
			el("span", { className: "tag", textContent: tag }),
			el("span", { className: "time", textContent: "🕒 " + when(q.created_at) }),
			el("div", { className: "stem", textContent: short(q.stem) }),
			MODE === "wrong" ? el("div", { className: "why" },
				el("span", { className: "mx", textContent: q.max_reason || q.max_note ? "错因：" + [q.max_reason, q.max_note].filter(Boolean).join("，") : "错因：Max 待分析" })) : ""),
		el("div", { className: "side" }, el("span", { className: "st " + cls, textContent: label }), del));
	if (MODE === "bank") {
		item.onclick = () => (location.href = quizHref([q.id]));
		return item;
	}
	// 错题本：点开看错答、答案、解析
	const detail = el("div", { className: "detail hide" });
	item.onclick = async () => {
		detail.classList.toggle("hide");
		if (detail.dataset.loaded) return;
		const d = await api("/api/question/" + q.id);
		detail.dataset.loaded = "1"; // 加载成功才记，失败了再点还能重试
		item.querySelector(".stem").textContent = d.stem;
		if (d.options.length) detail.append(el("div", { className: "mute", textContent: d.options.join("\n"), style: "white-space:pre-wrap" }));
		const wrong = d.attempts.find((a) => a.is_correct === 0);
		if (wrong && !/作图|函数|电路|光路|受力|证明/.test(d.tag || "")) detail.append(el("button", { type: "button", className: "btn small", textContent: "🤖 问 Max 这题", style: "margin:6px 0", onclick: () => Max.open({ explain: wrong.id }, "讲讲这道题") }));
		if (wrong) {
			detail.append(el("div", { className: "ans bad", textContent: "你的答案：" + (plain(wrong.answer_text) || "（空）") + (wrong.error_reason ? `（${wrong.error_reason}）` : "") }));
			if (wrong.comment) detail.append(el("div", { className: "ans", textContent: "评语：" + wrong.comment }));
		}
		detail.append(el("div", { className: "ans", textContent: "正确答案：" + d.answer.join(" / ") }));
		if (d.explanation) detail.append(el("div", { className: "ans", textContent: "解析：" + d.explanation }));
		const act = (path) => async () => { await api(`/api/question/${q.id}/${path}`, { method: "POST" }); load(); };
		detail.append(el("div", { className: "row", style: "margin-top:8px" },
			tab === "active" ? el("a", { className: "btn", href: quizHref([q.id]), textContent: "重做", style: "text-decoration:none" }) : "",
			tab === "active" ? el("button", { className: "btn", textContent: "标为已掌握", onclick: act("master") }) : "",
			el("button", { className: "btn", textContent: "删除", style: "color:var(--bad)", onclick: async () => (await delQuestion(q.id)) && load() })));
		math(item.parentElement);
	};
	return el("div", { className: "wrapitem" }, item, detail);
}

// 错题本顶部：错因统计（脚本归类 vs Max 归类）+ Max 总结 + 一键整理
async function loadSum() {
	if (MODE !== "wrong") return; // 题库页没有错因卡片
	if (tab !== "active") return $("#maxsum").replaceChildren();
	const s = await api("/api/max/wrongsum").catch(() => null);
	if (!s || !s.total) return $("#maxsum").replaceChildren();
	const bars = (m) => el("div", { className: "bars" }, ...Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
		el("div", {}, el("span", { textContent: k }), el("i", { style: `width:${Math.round((n / s.total) * 100)}%` }), el("b", { textContent: n }))));
	const org = el("button", { type: "button", className: "btn small", textContent: s.todo ? `🗂 让 Max 整理（${s.todo} 道没整理）` : "🗂 Max 已整理完", disabled: !s.todo, onclick: async () => {
		org.disabled = true; org.textContent = "整理中…";
		try { await api("/api/max/organize", { method: "POST" }); load(); } catch (e) { toast(e.message); org.disabled = false; org.textContent = "🗂 让 Max 整理"; }
	} });
	$("#maxsum").replaceChildren(el("div", { className: "card maxcard" },
		el("h2", { textContent: `错因分析（${s.total} 道错题）` }),
		s.summary ? el("p", { textContent: "🤖 " + s.summary }) : "",
		Object.keys(s.max).length ? el("div", { className: "why2" }, el("div", {}, el("b", { textContent: "Max 看题分析的错因" }), bars(s.max))) : "",
		el("div", { className: "row" }, org, el("button", { type: "button", className: "btn small", textContent: "问 Max", onclick: () => Max.open({}, "总结这页的错题，最该先补哪块？") }))));
	const top = Object.entries(s.max).filter(([k]) => k !== "待分析").sort((a, b) => b[1] - a[1])[0];
	Max.tip(`错题 ${s.total} 道` + (top ? `，最多的错因：${top[0]}` : s.todo ? `，Max 正在分析错因` : ""));
}
addEventListener("max:changed", () => load());

function load() {
	loadSum();
	api(MODE === "wrong" ? "/api/wrong?tab=" + tab : "/api/bank").then((d) => { data = d; render(); });
}
load();
autoRefresh(load); // 切回页面时更新（不定时刷新，免得收起正在看的题）
window.addEventListener("load", () => math($("#list")));
