const app = $("#app");
const TYPE = { single: "单选", multi: "多选", fill: "填空", short: "简答" };
const CHEM = ["₂", "₃", "₄", "↑", "△", "="];
let qs = [], ans = [], files = [], boards = [], secs = [], done = [], cur = 0, shownAt = 0; // done[i]：已提交的 attempt id

// 画板：题目标签（tag）决定默认画板；简答题还可按科目手动开：数学 计算+几何函数，物理 计算+电路+光学力学，其它 作图
const BOARDS = {
	calc: ["🧮 计算解答板", "[计算]", (q) => new CalcBoard(q.subject)],
	geo: ["📐 几何函数板", "[作图]", (q, axes) => Object.assign(new Board({ axes }), { kind: "geo" })],
	circuit: ["🔌 电路图板", "[电路]", () => new CircuitBoard()],
	phys: ["🔦 光学力学板", "[作图]", () => Object.assign(new Board({ phys: true }), { kind: "phys" })],
};
const kindOf = (b) => (b === "coord" || b === "grid" ? "geo" : b);
const offer = (q) => (q.subject === "数学" ? ["calc", "geo"] : q.subject === "物理" ? ["calc", "circuit", "phys"] : ["geo"]);

async function start() {
	const p = new URLSearchParams(location.search);
	const m = location.hash.match(/^#r=([\d,]+)/);
	if (m) { autoRefresh(() => showResult(m[1])); return showResult(m[1]); }
	qs = await api("/api/practice" + (p.get("ids") ? "?ids=" + p.get("ids") : p.get("subject") ? "?subject=" + encodeURIComponent(p.get("subject")) : ""));
	if (!qs.length) { app.replaceChildren(el("p", { className: "mute", textContent: "今天没有要做的题 🎉" })); return; }
	ans = qs.map((q) => (q.type === "multi" ? [] : ""));
	files = qs.map(() => []);
	boards = qs.map((q) => (q.board ? [BOARDS[kindOf(q.board)][2](q, q.board === "coord")] : []));
	secs = qs.map(() => 0);
	done = qs.map(() => null);
	cur = 0;
	render();
}

function tick() { secs[cur] += Math.round((Date.now() - shownAt) / 1000); shownAt = Date.now(); }

// ---------- 一题一交：离开这题（上/下一题、交卷、退出页面）就提交做过的题，交过的锁定 ----------
const answered = (i) => (Array.isArray(ans[i]) ? ans[i].length : String(ans[i]).trim()) || files[i].length || boards[i].some((b) => !b.isEmpty());
// 画板转成文字发给 Claude（省用量），和答案分开存：选择/填空照样自动判分
const work = (i) => boards[i].filter((b) => !b.isEmpty()).map((b) => BOARDS[b.kind][1] + " " + b.describe()).join("\n");
const item = (i, photo_keys = []) => ({ question_id: qs[i].id, answer: ans[i], work: work(i), photo_keys, time_spent_sec: secs[i] });
async function save(i) {
	if (done[i] || !answered(i)) return;
	if (i === cur) tick();
	done[i] = "…";
	try {
		const photo_keys = [];
		const up = async (f, kind) => {
			const fd = new FormData();
			fd.append("file", kind ? f : await compress(f));
			if (kind) fd.append("kind", kind);
			photo_keys.push((await api("/api/attempt-photo", { method: "POST", body: fd })).key);
		};
		for (const f of files[i]) await up(f);
		for (const b of boards[i]) if (!b.isEmpty() && (b.kind !== "calc" || b.hasPen())) await up(await b.toFile(), "board"); // 计算板只有手写才附图
		done[i] = (await api("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [item(i, photo_keys)] }) })).attempt_ids[0];
	} catch (e) { done[i] = null; throw e; }
}
// 中途退出：用 sendBeacon 把当前题发出去（来不及传图，文字和画板描述都在）
addEventListener("pagehide", () => {
	if (!qs.length || done[cur] || !answered(cur)) return;
	tick(); done[cur] = "…";
	navigator.sendBeacon("/api/submit", new Blob([JSON.stringify({ items: [item(cur)] })], { type: "application/json" }));
});
async function go(i) {
	const btns = [...document.querySelectorAll(".nav .btn")];
	btns.forEach((b) => (b.disabled = true));
	try { await save(cur); } catch (e) { alert("提交失败：" + e.message); return btns.forEach((b) => (b.disabled = false)); }
	tick(); cur = i; render();
}

function render() {
	shownAt = Date.now();
	const q = qs[cur];
	const box = el("div", { className: "card" + (done[cur] ? " locked" : "") });
	box.append(
		el("div", { className: "qhead" }, el("span", { className: "tag", textContent: q.subject }), q.tag ? el("span", { className: "tag", textContent: q.tag }) : "",
			el("span", { className: "time", textContent: "🕒 推送 " + when(q.created_at) }),
			el("button", { type: "button", className: "del", textContent: "🗑 删题", onclick: async () => {
				if (!(await delQuestion(q.id))) return;
				for (const a of [qs, ans, files, boards, secs, done]) a.splice(cur, 1);
				if (!qs.length) return app.replaceChildren(el("p", { className: "mute", textContent: "题都删完了" }));
				cur = Math.min(cur, qs.length - 1); render();
			} })),
		el("p", { textContent: q.stem, style: "white-space:pre-wrap" }));
	if (done[cur]) box.append(el("div", { className: "ans", textContent: "✓ 这题已提交" }));
	for (const b of boards[cur]) {
		const close = () => (b.isEmpty() || confirm("收起画板？画的内容会丢掉")) && ((boards[cur] = boards[cur].filter((x) => x !== b)), render());
		box.append(el("div", { className: "bhead" }, el("b", { textContent: BOARDS[b.kind][0] }), el("button", { type: "button", textContent: "收起 ×", onclick: close })), b.el);
		b.mount?.();
	}

	if (q.type === "single" || q.type === "multi") {
		q.options.forEach((o) => {
			const letter = o.trim()[0].toUpperCase();
			const on = q.type === "multi" ? ans[cur].includes(letter) : ans[cur] === letter;
			box.append(el("button", {
				className: "opt" + (on ? " on" : ""), textContent: o,
				onclick: () => {
					if (q.type === "multi") {
						const a = ans[cur];
						ans[cur] = a.includes(letter) ? a.filter((x) => x !== letter) : [...a, letter];
					} else ans[cur] = letter;
					render();
				},
			}));
		});
	} else if (q.type === "fill") {
		const input = el("input", { type: "text", value: ans[cur], placeholder: "答案", oninput: () => (ans[cur] = input.value) });
		if (q.subject === "化学") {
			const keys = el("div", { className: "keys" });
			for (const k of CHEM) keys.append(el("button", {
				type: "button", textContent: k,
				onclick: () => {
					const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
					input.value = input.value.slice(0, s) + k + input.value.slice(e);
					input.focus(); input.setSelectionRange(s + 1, s + 1);
					ans[cur] = input.value;
				},
			}));
			box.append(keys);
		}
		box.append(input);
	} else {
		const ta = el("textarea", { value: ans[cur], placeholder: "写下作答过程（也可以拍照上传）", oninput: () => (ans[cur] = ta.value) });
		const pick = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true,
			onchange: () => { files[cur].push(...pick.files); render(); } });
		const att = el("div", { className: "att" });
		files[cur].forEach((f, i) => att.append(el("div", {},
			el("img", { src: URL.createObjectURL(f) }),
			el("button", { type: "button", textContent: "×", onclick: () => { files[cur].splice(i, 1); render(); } }))));
		box.append(ta,
			el("div", { className: "row", style: "margin-top:8px" },
				el("label", { className: "btn small", textContent: "📷 拍照上传" }, pick),
				...offer(q).filter((k) => !boards[cur].some((b) => b.kind === k)).map((k) => el("button", { type: "button", className: "btn small", textContent: BOARDS[k][0],
					onclick: () => { boards[cur].push(BOARDS[k][2](q, false)); render(); } }))),
			att);
	}

	const last = cur === qs.length - 1;
	const nav = el("div", { className: "nav" },
		el("button", { className: "btn", textContent: "上一题", disabled: cur === 0, onclick: () => go(cur - 1) }),
		last
			? el("button", { className: "btn primary", id: "submit", textContent: "交卷", onclick: submit })
			: el("button", { className: "btn primary", textContent: "下一题", onclick: () => go(cur + 1) }));

	app.replaceChildren(
		el("div", { className: "mute", textContent: `${cur + 1} / ${qs.length}` }),
		el("div", { className: "bar" }, el("i", { style: `width:${((cur + 1) / qs.length) * 100}%` })),
		box, nav);
	math(box);
}

async function submit() {
	const btn = $("#submit");
	btn.disabled = true; btn.textContent = "提交中…";
	try {
		for (let i = 0; i < qs.length; i++) await save(i); // 前面的题离开时已交，这里补交当前题；没做的题不算
		const ids = done.filter((d) => typeof d === "number");
		if (!ids.length) { btn.disabled = false; btn.textContent = "交卷"; return alert("还没有做任何题"); }
		location.hash = "r=" + ids.join(",");
		location.reload();
	} catch (e) {
		btn.disabled = false; btn.textContent = "交卷";
		alert("提交失败：" + e.message);
	}
}

let poll = 0;
async function showResult(ids) {
	clearInterval(poll);
	const rows = await api("/api/attempts?ids=" + ids);
	// 有待批改的题：每 10 秒查一次，Claude 批完自动显示评语
	if (rows.some((r) => r.status === "待批改")) {
		const last = JSON.stringify(rows);
		poll = setInterval(async () => {
			if (document.visibilityState !== "visible") return;
			if (JSON.stringify(await api("/api/attempts?ids=" + ids)) !== last) showResult(ids);
		}, 10000);
	}
	const objective = rows.filter((r) => r.status === "已判");
	const right = objective.filter((r) => r.is_correct).length;
	const pending = rows.filter((r) => r.status === "待批改").length;
	const wrap = el("div", {});
	wrap.append(el("h1", { textContent: "结果" }),
		el("p", { textContent: `客观题 ${right} / ${objective.length} 对` + (pending ? `，${pending} 题待批改` : "") }));
	for (const r of rows) {
		const badge = r.status === "待批改" ? ["待批改", "wait"] : r.is_correct ? ["✓ 正确", "ok"] : ["✗ 错误", "bad"];
		const card = el("div", { className: "card" },
			el("span", { className: "badge " + badge[1], textContent: badge[0] }),
			el("span", { className: "tag", textContent: " " + r.subject }),
			el("p", { textContent: r.stem, style: "white-space:pre-wrap" }));
		if (r.options.length) card.append(el("div", { className: "mute", textContent: r.options.join("\n"), style: "white-space:pre-wrap" }));
		card.append(el("div", { className: "ans", textContent: "你的答案：" + (plain(r.answer_text) || "（空）") }));
		if (r.photos.length) {
			const t = el("div", { className: "thumbs" });
			for (const k of r.photos) t.append(el("a", { href: "/photo/" + k, target: "_blank" }, el("img", { src: "/photo/" + k })));
			card.append(t);
		}
		card.append(el("div", { className: "ans", textContent: "参考答案：" + r.answer.join(" / ") }));
		if (r.explanation) card.append(el("div", { className: "ans", textContent: "解析：" + r.explanation }));
		if (r.status === "已判" && r.type === "short" || r.comment) {
			card.append(el("div", { className: "ans", textContent: `评语：${r.comment || ""}` + (r.error_reason ? `（${r.error_reason}）` : "") + (r.score != null ? ` 得分 ${r.score}` : "") }));
		}
		wrap.append(card);
	}
	if (pending) wrap.append(askClaude(CLAUDE_ASK.grade, "让 Claude 批改"), el("p", { className: "mute", textContent: "Claude 批完后，评语会自动出现在这里" }));
	wrap.append(el("a", { className: "btn primary", href: "/", textContent: "回首页", style: "text-decoration:none;margin-top:10px" }));
	app.replaceChildren(wrap);
	math(wrap);
}

window.addEventListener("load", start);
