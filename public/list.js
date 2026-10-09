// 题库 / 错题本：科目 → 分类 → 考点
const MODE = document.body.dataset.mode;
const TYPE = { single: "单选", multi: "多选", fill: "填空", short: "简答" };
let data = { items: [], today: "" };
let subject = new URLSearchParams(location.search).get("subject") || "";
tabbar("/" + MODE);

function status(q) {
	if (q.pending) return ["待批改", "wait"];
	if (q.next_date) return q.next_date <= data.today ? ["该复习了", "due"] : ["下次 " + q.next_date.slice(5), "go"];
	if (!q.tries) return ["新题", "new"];
	return ["已掌握", "ok"];
}

const group = (arr, f) => arr.reduce((m, x) => ((m[f(x)] ||= []).push(x), m), {});
const quizHref = (ids) => "/quiz?ids=" + ids.join(",");

function render() {
	const subjects = [...new Set(data.items.map((q) => q.subject))];
	if (subject && !subjects.includes(subject)) subject = "";
	const chips = $("#chips");
	chips.replaceChildren(el("button", { className: "chip" + (!subject ? " on" : ""), textContent: `全部 ${data.items.length}`, onclick: () => { subject = ""; render(); } }));
	for (const s of subjects) {
		chips.append(el("button", { className: "chip" + (s === subject ? " on" : ""), textContent: `${s} ${data.items.filter((q) => q.subject === s).length}`, onclick: () => { subject = s; render(); } }));
	}
	const shown = data.items.filter((q) => !subject || q.subject === subject);
	const due = shown.filter((q) => q.next_date && q.next_date <= data.today);
	const redo = $("#redo");
	redo.replaceChildren();
	if (shown.length) redo.append(el("a", { className: "btn small primary", href: quizHref(shown.map((q) => q.id)), textContent: `全部重做（${shown.length}）`, style: "text-decoration:none" }));
	if (due.length) redo.append(el("a", { className: "btn small", href: quizHref(due.map((q) => q.id)), textContent: `只做到期的（${due.length}）`, style: "text-decoration:none" }));

	const list = $("#list");
	list.replaceChildren();
	if (!shown.length) list.append(el("p", { className: "mute", textContent: MODE === "wrong" ? "还没有错题" : "题库是空的" }));
	const bySubject = group(shown, (q) => q.subject);
	for (const [subj, qs] of Object.entries(bySubject)) {
		if (!subject) list.append(el("h2", { textContent: subj, style: "margin:14px 0 8px" }));
		const byCat = group(qs, (q) => q.category || "未分类");
		for (const [cat, items] of Object.entries(byCat)) {
			const d = el("details", { className: "cat", open: true });
			d.append(el("summary", {},
				el("span", { className: "grow", textContent: `${cat}（${items.length}）` }),
				el("a", { className: "btn small", href: quizHref(items.map((q) => q.id)), textContent: "练这组", onclick: (e) => e.stopPropagation(), style: "text-decoration:none" })));
			const byTopic = group(items, (q) => q.topic || "");
			for (const [topic, tq] of Object.entries(byTopic)) {
				if (topic) d.append(el("div", { className: "topic", textContent: "▸ " + topic }));
				for (const q of tq) d.append(row(q));
			}
			list.append(d);
		}
	}
	math(list);
}

function row(q) {
	const [label, cls] = status(q);
	const detail = el("div", { className: "detail hide" });
	const stem = el("div", { className: "stem", textContent: q.stem.length > 80 ? q.stem.slice(0, 80) + "…" : q.stem });
	stem.onclick = async () => {
		detail.classList.toggle("hide");
		if (detail.dataset.loaded) return;
		detail.dataset.loaded = "1";
		await showDetail(q.id, detail, stem, q.stem);
	};
	return el("div", { className: "q" },
		el("div", { className: "meta" },
			el("span", { className: "st " + cls, textContent: label }),
			el("span", { className: "tag", textContent: TYPE[q.type] }),
			q.wrongs ? el("span", { className: "mute", textContent: `错 ${q.wrongs} 次` }) : ""),
		stem, detail,
		el("div", { className: "qbtns" }, el("a", { className: "btn small", href: quizHref([q.id]), textContent: "重做", style: "text-decoration:none" })));
}

async function showDetail(id, box, stemEl, fullStem) {
	const q = await api("/api/question/" + id);
	stemEl.textContent = fullStem;
	if (q.options.length) box.append(el("div", { className: "mute", textContent: q.options.join("\n"), style: "white-space:pre-wrap" }));
	box.append(el("div", { className: "ans", textContent: "答案：" + q.answer.join(" / ") }));
	if (q.explanation) box.append(el("div", { className: "ans", textContent: "解析：" + q.explanation }));
	for (const a of q.attempts) {
		const ok = a.status === "待批改" ? "待批改" : a.is_correct ? "✓" : "✗";
		const t = el("div", { className: "ans", textContent: `${a.created_at.slice(5, 16)} ${ok} 你答：${a.answer_text || "（空）"}` + (a.comment ? `\n评语：${a.comment}` : "") + (a.error_reason ? `（${a.error_reason}）` : ""), style: "white-space:pre-wrap" });
		if (a.photos.length) {
			const th = el("div", { className: "thumbs" });
			for (const k of a.photos) th.append(el("a", { href: "/photo/" + k, target: "_blank" }, el("img", { src: "/photo/" + k })));
			t.append(th);
		}
		box.append(t);
	}
	math(stemEl.parentElement);
}

api("/api/" + (MODE === "wrong" ? "wrong" : "bank")).then((d) => { data = d; render(); });
window.addEventListener("load", () => math($("#list")));
