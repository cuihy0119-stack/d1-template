// 题库 / 错题本：简洁列表（学科标签 + 题目 + 状态）
const MODE = document.body.dataset.mode;
let data = { items: [], today: "" };
let subject = new URLSearchParams(location.search).get("subject") || "";
tabbar("/" + MODE);

const quizHref = (ids) => "/quiz?ids=" + ids.join(",");
const short = (s) => (s.length > 70 ? s.slice(0, 70) + "…" : s);

function state(q) {
	if (q.pending) return ["待批改", "wait"];
	if (MODE === "wrong") return q.next_date ? ["待重做", "due"] : ["已掌握", "ok"];
	return q.tries ? ["已做", "ok"] : ["未做", "new"];
}

function render() {
	const subjects = [...new Set(data.items.map((q) => q.subject))];
	if (subject && !subjects.includes(subject)) subject = "";
	const chips = $("#chips");
	chips.replaceChildren();
	for (const s of ["", ...subjects]) {
		chips.append(el("button", { className: "chip" + (s === subject ? " on" : ""), textContent: s || "全部", onclick: () => { subject = s; render(); } }));
	}

	const shown = data.items.filter((q) => !subject || q.subject === subject);
	const todo = shown.filter((q) => (MODE === "wrong" ? q.next_date : !q.tries));
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
	const tag = subject ? q.category || q.subject : q.subject;
	const item = el("div", { className: "item" },
		el("div", { className: "body" },
			el("span", { className: "tag", textContent: tag }),
			el("div", { className: "stem", textContent: short(q.stem) })),
		el("span", { className: "st " + cls, textContent: label }));
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
			detail.append(el("div", { className: "ans bad", textContent: "你的答案：" + ((wrong.answer_text || "").replace(/\n?\[作图\][\s\S]*$/, " （见作图）") || "（空）") + (wrong.error_reason ? `（${wrong.error_reason}）` : "") }));
			if (wrong.comment) detail.append(el("div", { className: "ans", textContent: "评语：" + wrong.comment }));
		}
		detail.append(el("div", { className: "ans", textContent: "正确答案：" + d.answer.join(" / ") }));
		if (d.explanation) detail.append(el("div", { className: "ans", textContent: "解析：" + d.explanation }));
		detail.append(el("a", { className: "btn", href: quizHref([q.id]), textContent: "重做这题", style: "text-decoration:none;margin-top:8px" }));
		math(item.parentElement);
	};
	return el("div", { className: "wrapitem" }, item, detail);
}

api("/api/" + (MODE === "wrong" ? "wrong" : "bank")).then((d) => { data = d; render(); });
window.addEventListener("load", () => math($("#list")));
