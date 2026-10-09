const app = $("#app");
const TYPE = { single: "单选", multi: "多选", fill: "填空", short: "简答" };
const CHEM = ["₂", "₃", "₄", "↑", "△", "="];
let qs = [], ans = [], files = [], boards = [], secs = [], cur = 0, shownAt = 0;

async function start() {
	const p = new URLSearchParams(location.search);
	const m = location.hash.match(/^#r=([\d,]+)/);
	if (m) return showResult(m[1]);
	qs = await api("/api/practice" + (p.get("ids") ? "?ids=" + p.get("ids") : p.get("subject") ? "?subject=" + encodeURIComponent(p.get("subject")) : ""));
	if (!qs.length) { app.replaceChildren(el("p", { className: "mute", textContent: "今天没有要做的题 🎉" })); return; }
	ans = qs.map((q) => (q.type === "multi" ? [] : ""));
	files = qs.map(() => []);
	boards = qs.map((q) => (q.board ? new Board({ axes: q.board === "coord" }) : null));
	secs = qs.map(() => 0);
	cur = 0;
	render();
}

function tick() { secs[cur] += Math.round((Date.now() - shownAt) / 1000); shownAt = Date.now(); }
function go(i) { tick(); cur = i; render(); }

function render() {
	shownAt = Date.now();
	const q = qs[cur];
	const box = el("div", { className: "card" });
	box.append(
		el("div", {}, el("span", { className: "tag", textContent: q.subject })),
		el("p", { textContent: q.stem, style: "white-space:pre-wrap" }));
	if (boards[cur]) box.append(boards[cur].el);

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
				boards[cur] ? "" : el("button", { type: "button", className: "btn small", textContent: "📐 打开作图板",
					onclick: () => { boards[cur] = new Board(); render(); } })),
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
	tick();
	const btn = $("#submit");
	btn.disabled = true; btn.textContent = "提交中…";
	try {
		const items = [];
		for (let i = 0; i < qs.length; i++) {
			const photo_keys = [];
			const up = async (f, kind) => {
				const fd = new FormData();
				fd.append("file", kind ? f : await compress(f));
				if (kind) fd.append("kind", kind);
				photo_keys.push((await api("/api/attempt-photo", { method: "POST", body: fd })).key);
			};
			for (const f of files[i]) await up(f);
			let answer = ans[i];
			const b = boards[i];
			if (b && !b.isEmpty()) {
				// 作图转成文字发给 Claude（省用量）；图也存一份，自己看结果时用
				if (typeof answer === "string") answer = (answer ? answer + "\n" : "") + "[作图] " + b.describe();
				await up(await b.toFile(), "board");
			}
			items.push({ question_id: qs[i].id, answer, photo_keys, time_spent_sec: secs[i] });
		}
		const r = await api("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
		location.hash = "r=" + r.attempt_ids.join(",");
		location.reload();
	} catch (e) {
		btn.disabled = false; btn.textContent = "交卷";
		alert("提交失败：" + e.message);
	}
}

async function showResult(ids) {
	const rows = await api("/api/attempts?ids=" + ids);
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
	if (pending) wrap.append(el("button", { className: "btn", textContent: "刷新批改结果", onclick: () => location.reload() }));
	wrap.append(el("a", { className: "btn primary", href: "/", textContent: "回首页", style: "text-decoration:none;margin-top:10px" }));
	app.replaceChildren(wrap);
	math(wrap);
}

window.addEventListener("load", start);

// 作答里的「[作图] …」是给 Claude 的描述，自己看时换成提示
function plain(t) { return (t || "").replace(/\n?\[作图\][\s\S]*$/, " （见作图）").trim(); }
