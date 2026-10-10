const app = $("#app");
const FROM_WRONG = new URLSearchParams(location.search).get("from") === "wrong";
const CHEM = ["₂", "₃", "₄", "↑", "△", "="];
let qs = [], ans = [], files = [], boards = [], want = [], secs = [], done = [], sig = [], marks = [], cur = 0, shownAt = 0; // done[i]：已提交的 attempt id；sig[i]：提交时的答案，改了再交会更新

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
	boards = qs.map(() => []);
	want = qs.map((q) => q.board); // 默认画板：做到这题时才创建，打开页面更快
	secs = qs.map(() => 0);
	done = qs.map(() => null);
	sig = qs.map(() => "");
	marks = qs.map(() => false);
	cur = 0;
	render("enter");
}
// 从「返回」缓存回到做题页：状态可能已过期（离开时已用 sendBeacon 提交），直接重新加载
addEventListener("pageshow", (e) => e.persisted && !location.hash && location.reload());

function tick() { secs[cur] += Math.round((Date.now() - shownAt) / 1000); shownAt = Date.now(); }

// ---------- 一题一交：离开这题（上/下一题、交卷、退出页面）就提交做过的题；回来改了再离开，会更新那次提交 ----------
// 算不算做了：以答案框为准（选项、填空框、作答框/照片）；作图类画板（几何/电路/光学力学）本身就是答案也算。
// 计算板是草纸：不算作答、不发给 Claude；只有题目要求写过程时，草纸才作为过程一起交。
const needProcess = (q) => q.tag === "解答" || /过程|步骤|写出.{0,4}(解|推理|推导)|说明理由/.test(q.stem);
const sends = (i, b) => !b.isEmpty() && (b.kind !== "calc" || (qs[i].type === "short" && needProcess(qs[i])));
const answered = (i) => (Array.isArray(ans[i]) ? ans[i].length : String(ans[i]).trim()) || (qs[i].type === "short" && (files[i].length || boards[i].some((b) => sends(i, b))));
// 画板转成文字发给 Claude（省用量），和答案分开存：选择/填空照样自动判分
const work = (i) => boards[i].filter((b) => sends(i, b)).map((b) => BOARDS[b.kind][1] + " " + b.describe()).join("\n");
const item = (i, photo_keys = []) => ({ question_id: qs[i].id, answer: ans[i], work: work(i), photo_keys, time_spent_sec: secs[i], attempt_id: typeof done[i] === "number" ? done[i] : undefined });
const sigOf = (i) => JSON.stringify([ans[i], work(i), files[i].length]);
const pending = (i) => answered(i) && done[i] !== "…" && (!done[i] || sigOf(i) !== sig[i]); // 没交过，或交过又改了
async function save(i) {
	if (!pending(i)) return;
	if (i === cur) tick();
	const prev = done[i], s = sigOf(i), it = item(i);
	done[i] = "…";
	try {
		const photo_keys = [];
		const up = async (f, kind) => {
			const fd = new FormData();
			fd.append("file", kind ? f : await compress(f, 1024));
			if (kind) fd.append("kind", kind);
			photo_keys.push((await api("/api/attempt-photo", { method: "POST", body: fd })).key);
		};
		for (const f of files[i]) await up(f);
		// 画板图：动了画笔的、计算板的草纸 → 发给 Claude（kind=board）；其余只存一份自己看（kind=view），Claude 读文字描述就够
		for (const b of boards[i]) {
			if (b.isEmpty()) continue;
			if (b.kind !== "calc" || !b.pad.isEmpty()) await up(await b.toFile(true), "view"); // 高清整图：自己看结果
			if (sends(i, b) && (b.kind === "calc" ? !b.pad.isEmpty() : b.hasPen?.())) await up(await b.toFile(), "board"); // 裁剪压缩小图：只发给 Claude
		}
		done[i] = (await api("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ ...it, photo_keys }] }) })).attempt_ids[0];
		sig[i] = s;
	} catch (e) { done[i] = prev; throw e; }
}
// 中途退出：用 sendBeacon 把当前题发出去（来不及传图，文字和画板描述都在）
addEventListener("pagehide", () => {
	if (!qs.length || !pending(cur)) return;
	tick();
	navigator.sendBeacon("/api/submit", new Blob([JSON.stringify({ items: [item(cur)] })], { type: "application/json" }));
	done[cur] = "…";
});
async function go(i) {
	const btns = [...document.querySelectorAll(".nav .btn")];
	btns.forEach((b) => (b.disabled = true));
	try { await save(cur); } catch (e) { alert("提交失败：" + e.message); return btns.forEach((b) => (b.disabled = false)); }
	tick(); const dir = i > cur ? "fwd" : "back"; cur = i; render(dir);
}

// anim：只在换题时播放进场动画；点选项、加图片等局部更新不重播，避免闪烁
function render(anim) {
	shownAt = Date.now();
	app.className = anim || "";
	const q = qs[cur];
	const box = el("div", { className: "card" });
	box.append(
		// 专注：题头只留科目/题型和两个小图标（标记、删题）
		el("div", { className: "qhead" }, el("span", { className: "tag", textContent: q.subject + (q.tag ? " · " + q.tag : "") }), el("span", { style: "flex:1" }),
			// 标记：放进临时文件夹，交卷后可以让 Claude 解析（24 小时过期）；错题本重做不需要（攒够 20 道会整包发给 Claude）
			FROM_WRONG ? "" : el("button", { type: "button", className: "mark" + (marks[cur] ? " on" : ""), title: "标记：交卷后可让 Claude 解析", textContent: "🔖", onclick: (e) => {
				const on = (marks[cur] = !marks[cur]), b = e.currentTarget;
				b.classList.toggle("on", on);
				api("/api/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question_id: q.id, on }) }).catch(() => {});
			} }),
			el("button", { type: "button", className: "del", title: "删题", textContent: "🗑", onclick: async () => {
				if (!(await delQuestion(q.id))) return;
				for (const a of [qs, ans, files, boards, want, secs, done, sig, marks]) a.splice(cur, 1);
				if (!qs.length) return app.replaceChildren(el("p", { className: "mute", textContent: "题都删完了" }));
				cur = Math.min(cur, qs.length - 1); render();
			} })),
		el("p", { className: "stem", textContent: q.stem, style: "white-space:pre-wrap" }));
	if (typeof done[cur] === "number") box.append(el("div", { className: "ans", textContent: "✓ 已提交，改了答案离开时会自动更新" }));
	if (want[cur]) { boards[cur].push(BOARDS[kindOf(want[cur])][2](q, want[cur] === "coord")); want[cur] = null; }
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
				className: "opt" + (on ? " on" : ""), value: letter,
				onclick: () => { // 只改选中状态，不重绘整题
					if (q.type === "multi") {
						const a = ans[cur];
						ans[cur] = a.includes(letter) ? a.filter((x) => x !== letter) : [...a, letter];
					} else ans[cur] = letter;
					for (const b of box.querySelectorAll(".opt")) b.classList.toggle("on", q.type === "multi" ? ans[cur].includes(b.value) : ans[cur] === b.value);
				},
			}, el("span", { className: "ol", textContent: letter }), el("span", { textContent: o.replace(/^\s*[A-Za-z][.．、:：]?\s*/, "") })));
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
			el("img", { src: (f.url ||= URL.createObjectURL(f)) }), // 同一张图只建一次预览地址
			el("button", { type: "button", textContent: "×", onclick: () => { URL.revokeObjectURL(f.url); files[cur].splice(i, 1); render(); } }))));
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
		el("div", { className: "qtop" }, el("div", { className: "bar" }, el("i", { style: `width:${((cur + 1) / qs.length) * 100}%` })), el("span", { className: "mute", textContent: `${cur + 1}/${qs.length}` })),
		box, nav);
	math(box);
	isle.fill(q);
}

// ---------- 浮岛 ----------
// 平板（宽 ≥744px，iPad 横竖屏）：有画板的题分三栏——左边题干、中间画板、右边工具，常驻不收起。
// 手机：滑到画板时右侧出现一根竖条（题干 / 工具 / 撤销三个图标），点开面板从竖条旁弹出；
//       滑动、落笔、点空白、选完工具自动收回；落笔时竖条变淡。动画只用 transform/opacity。
const isle = (() => {
	const tablet = matchMedia("(min-width:744px)");
	const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const ICON = {
		q: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>'),
		t: svg('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'),
		u: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
	};
	const btn = (k, title) => el("button", { type: "button", className: "rb", title, innerHTML: ICON[k] });
	const qb = btn("q", "题干"), tb = btn("t", "工具"), ub = btn("u", "撤销");
	const rail = el("div", { className: "rail" }, qb, tb, ub), qp = el("div", { className: "pan pq" }), tp = el("div", { className: "pan pt" });
	document.body.append(rail, qp, tp);
	let slot = null, dock = null, y0 = 0, raf = 0;
	const open = (p, b, on) => { p.classList.toggle("open", on); b.classList.toggle("on", on); if (on) y0 = scrollY; };
	const close = () => { if (!tablet.matches) { open(qp, qb, false); open(tp, tb, false); } };
	qb.onclick = () => { const on = !qp.classList.contains("open"); close(); open(qp, qb, on); };
	tb.onclick = () => { const on = !tp.classList.contains("open"); close(); open(tp, tb, on); };
	ub.onclick = () => dock?.querySelector(".fab")?.click(); // 不展开也能撤销
	qp.onclick = close;
	tp.addEventListener("click", (e) => { if (e.target.closest(".btools button") && !tablet.matches) setTimeout(close, 180); }); // 选完工具自动收起
	document.addEventListener("pointerdown", (e) => {
		if (e.target.closest(".rail,.pan")) return;
		if (e.target.tagName === "CANVAS") document.body.classList.add("drawing");
		close();
	}, { passive: true });
	for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => document.body.classList.remove("drawing"), { passive: true });
	// 工具区搬进面板 / 搬回原位（slot 留住原高度，版面不跳；平板上不留高度，画板直接上移）
	const park = (s) => {
		if (s === slot) return;
		if (slot) { slot.append(dock); slot.style.height = ""; }
		slot = s; dock = s?.firstChild || null;
		if (s) { s.style.height = tablet.matches ? "0px" : s.offsetHeight + "px"; tp.append(dock); }
	};
	function update() {
		raf = 0;
		const card = app.querySelector(".card"), stem = card?.querySelector(".stem"), p = (boards[cur] || []).map((b) => b.pad || b)[0];
		if (tablet.matches) { // 平板：有画板就三栏常驻
			document.body.classList.toggle("split", !!p);
			park(p ? p.slot : null);
			open(qp, qb, !!p); open(tp, tb, !!p);
			return rail.classList.remove("show");
		}
		document.body.classList.remove("split");
		const w = p?.wrap.getBoundingClientRect(), live = !!(p && w.top < innerHeight * 0.6 && w.bottom > 160);
		const showT = live && (slot || p.slot).getBoundingClientRect().top < 4;
		park(showT ? p.slot : null);
		rail.classList.toggle("show", live && (showT || stem.getBoundingClientRect().bottom < 0));
		tb.hidden = ub.hidden = !showT;
		if (!rail.classList.contains("show")) close();
		else if (Math.abs(scrollY - y0) > 24) close(); // 一滑动就收起
	}
	addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
	tablet.addEventListener?.("change", () => { park(null); update(); });
	return {
		fill(q) { park(null); close(); qp.replaceChildren(el("span", { className: "tag", textContent: q.tag || q.subject }), el("div", { className: "istem", textContent: q.stem })); math(qp); requestAnimationFrame(update); },
		hide() { park(null); rail.classList.remove("show"); document.body.classList.remove("split"); open(qp, qb, false); open(tp, tb, false); },
	};
})();

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
	isle.hide();
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
			el("span", { className: "tag", textContent: r.subject }), r.topic ? el("span", { className: "tag", textContent: "考点：" + r.topic }) : "", r.marked ? el("span", { className: "tag", textContent: "🔖 已标记" }) : "",
			el("p", { textContent: r.stem, style: "white-space:pre-wrap" }));
		if (r.options.length) card.append(el("div", { className: "mute", textContent: r.options.join("\n"), style: "white-space:pre-wrap" }));
		card.append(el("div", { className: "ans", textContent: "你的答案：" + (plain(r.answer_text) || "（空）") }));
		if (r.photos.length) {
			const t = el("div", { className: "thumbs" });
			for (const k of r.photos.filter((k) => !k.startsWith("boards/") || !r.photos.some((x) => x.startsWith("views/")))) t.append( // 发给 Claude 的小图不重复显示
				el("a", { href: "/photo/" + k, target: "_blank" }, el("img", { src: "/photo/" + k })));
			card.append(t);
		}
		card.append(el("div", { className: "ans", textContent: (r.type === "short" ? "参考答案：" : "正确答案：") + r.answer.join(" / ") }));
		if (r.explanation) card.append(el("div", { className: "ans", textContent: "解析：" + r.explanation }));
		if (r.status === "已判" && r.type === "short" || r.comment) {
			card.append(el("div", { className: "ans", textContent: `评语：${r.comment || ""}` + (r.error_reason ? `（${r.error_reason}）` : "") + (r.score != null ? ` 得分 ${r.score}` : "") }));
		}
		wrap.append(card);
	}
	// 作图/写过程的题交给 Claude 批改；标记的题可以让 Claude 解析
	if (pending) wrap.append(askClaude(CLAUDE_ASK.grade, `让 Claude 批改作图/过程题（${pending} 题）`), el("p", { className: "mute", textContent: "Claude 批完后，评语会自动出现在这里" }));
	if (rows.some((r) => r.marked)) wrap.append(askClaude(CLAUDE_ASK.marked, "让 Claude 解析标记的题"));
	wrap.append(el("a", { className: "btn primary", href: "/", textContent: "回首页", style: "text-decoration:none;margin-top:10px" }));
	app.replaceChildren(wrap);
	math(wrap);
}

window.addEventListener("load", start);
