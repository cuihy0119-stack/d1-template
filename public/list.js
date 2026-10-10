// 题库 / 错题本：简洁列表（学科标签 + 题目 + 状态）
const MODE = document.body.dataset.mode;
let data = { items: [], today: "" };
let tab = "active"; // 错题本：active 复习中 / mastered 已掌握
let subject = new URLSearchParams(location.search).get("subject") || "";
tabbar("/" + MODE);

const quizHref = (ids) => "/quiz?ids=" + ids.join(",") + (MODE === "wrong" ? "&from=wrong" : ""); // 错题重做不需要标记按钮
const short = (s) => (s.length > 70 ? s.slice(0, 70) + "…" : s);

function state(q) {
	if (q.pending) return ["待批改", "wait"];
	if (MODE === "wrong") return tab === "mastered" ? ["已掌握", "ok"] : q.last === 1 ? ["重做已对", "ok"] : ["待重做", "due"];
	return !q.tries ? ["未做", "new"] : q.last === 1 ? ["✓ 做对", "ok"] : ["✗ 做错", "due"]; // 显示最近一次的结果，不再笼统写「已做」
}

function render() {
	if (MODE === "wrong") {
		$("#tabs").replaceChildren(...[["active", "复习中"], ["mastered", "已掌握"]].map(([k, name]) =>
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
	if (todo.length) {
		const href = MODE === "bank" && subject ? "/quiz?subject=" + encodeURIComponent(subject) : quizHref(todo.map((q) => q.id));
		top.append(el("a", { className: "btn primary", href, style: "text-decoration:none",
			textContent: MODE === "wrong" ? `重做错题（${todo.length}）` : `开始练习（${todo.length} 题未做）` }));
	}

	const list = $("#list");
	list.replaceChildren();
	if (!shown.length) list.append(el("p", { className: "mute", textContent: MODE === "wrong" ? "还没有错题，做错的题会自动收进来" : "还没有题" }));
	for (const q of shown) list.append(row(q));
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
			el("div", { className: "stem", textContent: short(q.stem) })),
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
		detail.dataset.loaded = "1";
		const d = await api("/api/question/" + q.id);
		item.querySelector(".stem").textContent = d.stem;
		if (d.options.length) detail.append(el("div", { className: "mute", textContent: d.options.join("\n"), style: "white-space:pre-wrap" }));
		const wrong = d.attempts.find((a) => a.is_correct === 0);
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

function load() { api(MODE === "wrong" ? "/api/wrong?tab=" + tab : "/api/bank").then((d) => { data = d; render(); }); }
load();
autoRefresh(load); // 切回页面时更新（不定时刷新，免得收起正在看的题）
window.addEventListener("load", () => math($("#list")));
