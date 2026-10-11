// 临时练习：题库里没有同类题时，让 Max 现场出 10 道以内的题当场练。
// 题不进题库，作答不进错题本和做题记录；答完当场判分，错了只提示一下、可以点「让 Max 分析」；关掉页面就没了。
const Drill = (() => {
	const app = $("#app");
	let topic = "", qs = [], i = 0, right = 0;
	const norm = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ").replace(/\s+/g, "");
	const bare = (s) => norm(s).replace(/^[a-zA-Z]=/, ""); // 「x=2」和「2」算一样
	const judge = (q, mine) => (q.type === "single" ? norm(mine).toUpperCase() === q.answer[0] : !!bare(mine) && q.answer.some((a) => bare(a) === bare(mine)));
	const shown = (q) => (q.type === "single" ? q.answer[0] : q.answer.join(" / "));
	const tmpOf = (q, mine, done) => ({ stem: q.stem, options: q.options, answer: shown(q), mine, exp: q.explanation, done });

	function intro(n) {
		let want = n || 5;
		const chips = el("div", { className: "chips" }, ...[3, 5, 8, 10].map((k) => el("button", { type: "button", className: "chip" + (k === want ? " on" : ""), textContent: k + " 题",
			onclick: (e) => { want = k; for (const b of chips.children) b.classList.toggle("on", b === e.currentTarget); } })));
		app.replaceChildren(el("div", { className: "card" },
			el("h2", { textContent: `题库里还没有「${topic.split("/").pop()}」的同类题` }),
			el("p", { className: "mute", textContent: "让 Max 现场出几道练一练：临时的，不进题库，也不计入错题本。" }),
			chips,
			el("button", { type: "button", className: "btn primary", style: "margin-top:12px", textContent: "让 Max 出题", onclick: () => make(want) })));
	}

	async function make(n) {
		app.replaceChildren(el("p", { className: "mute", textContent: `Max 出题中…（${n} 道，约 10 秒）` }));
		try {
			qs = (await api("/api/max/gen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic, n }) })).questions;
			i = 0; right = 0;
			show();
		} catch (e) {
			app.replaceChildren(el("p", { className: "mute", textContent: "出题失败：" + e.message }), el("button", { type: "button", className: "btn", textContent: "重试", onclick: () => make(n) }));
		}
	}

	function show() {
		const q = qs[i], box = el("div", { className: "card" }), res = el("div"), nav = el("div", { className: "nav" });
		let locked = false;
		Max.setCtx({ tmp: tmpOf(q, "", false) }); // 没交之前 Max 只给提示，不知道答案
		const finish = (mine, btn) => {
			if (locked) return;
			locked = true;
			const ok = judge(q, mine);
			if (ok) right++;
			Max.setCtx({ tmp: tmpOf(q, mine, true) });
			if (q.type === "single") for (const b of box.querySelectorAll(".opt")) { b.disabled = true; b.classList.toggle("ok", ok && b === btn); b.classList.toggle("bad", !ok && b === btn); }
			else for (const x of box.querySelectorAll("input,.fsub")) x.disabled = true;
			res.replaceChildren(ok
				? el("div", { className: "ans", textContent: "✓ 答对了" + (q.explanation ? "：" + q.explanation : "") })
				: el("div", {}, el("div", { className: "ans bad", textContent: "✗ 这题没对，点下面让 Max 帮你分析错在哪" }),
					el("div", { className: "row", style: "margin-top:8px" },
						el("button", { type: "button", className: "btn", textContent: "让 Max 分析", onclick: () => Max.open({ tmp: tmpOf(q, mine, true) }, "这题我做错了，帮我分析错在哪、怎么避免") }),
						noteLink(q.subject, q.topic, "btn"),
						el("button", { type: "button", className: "btn", textContent: "看答案", onclick: (e) => { e.currentTarget.replaceWith(el("div", { className: "ans", textContent: "正确答案：" + shown(q) + (q.explanation ? "　解析：" + q.explanation : "") })); math(res); } }))));
			math(res);
			nav.hidden = false;
		};
		box.append(el("div", { className: "qhead" }, el("span", { className: "tag", textContent: `${q.subject} · ${q.topic}` }), el("span", { style: "flex:1" }), el("span", { className: "tag", textContent: "Max 临时题" })),
			el("p", { className: "stem", textContent: q.stem, style: "white-space:pre-wrap" }));
		if (q.type === "single") {
			for (const o of q.options) {
				const letter = o.trim()[0].toUpperCase();
				box.append(el("button", { className: "opt", value: letter, onclick: (e) => finish(letter, e.currentTarget) },
					el("span", { className: "ol", textContent: letter }), el("span", { textContent: o.replace(/^\s*[A-Za-z][.．、:：]?\s*/, "") })));
			}
		} else {
			const input = el("input", { type: "text", placeholder: "答案", onkeydown: (e) => e.key === "Enter" && !e.isComposing && input.value.trim() && finish(input.value) });
			box.append(input, el("button", { type: "button", className: "btn small fsub", style: "margin-top:8px", textContent: "提交", onclick: () => input.value.trim() && finish(input.value) }));
		}
		box.append(res);
		const last = i === qs.length - 1;
		nav.hidden = true;
		nav.append(el("span", { style: "flex:1" }), el("button", { className: "btn primary", textContent: last ? "看结果" : "下一题", onclick: () => (last ? end() : (i++, show())) }));
		app.replaceChildren(el("div", { className: "qtop" }, el("div", { className: "bar" }, el("i", { style: `width:${((i + 1) / qs.length) * 100}%` })), el("span", { className: "mute", textContent: `${i + 1}/${qs.length}` })), box, nav);
		math(box);
	}

	function end() {
		Max.setCtx({});
		app.replaceChildren(el("div", { className: "card" },
			el("h1", { textContent: `${right} / ${qs.length} 对` }),
			el("p", { className: "mute", textContent: "这是 Max 的临时题，没有记进题库和错题本。" }),
			el("div", { className: "row", style: "margin-top:10px" },
				el("button", { type: "button", className: "btn primary", textContent: "再来一组", onclick: () => make(qs.length) }),
				el("a", { className: "btn", href: "/", textContent: "回首页", style: "text-decoration:none" }))));
	}

	return { start(t, n) { topic = t; n ? make(Math.min(10, n)) : intro(); } };
})();
