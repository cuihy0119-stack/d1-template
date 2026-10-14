// 题库 / 错题本：简洁列表（学科标签 + 题目 + 状态）
const MODE = document.body.dataset.mode;
let data = { items: [], today: "" };
let tab = "active"; // 错题本：active 复习中 / mastered 错题文件夹（重做做对的，Max 整理好，Claude 来取）
let subject = new URLSearchParams(location.search).get("subject") || "", cat = ""; // cat：章节（选了科目后再细分）
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
	if (q.due && q.due > data.today) return [`${+q.due.slice(5, 7)}月${+q.due.slice(8, 10)}日做`, "wait"]; // 排到以后做的题
	return !q.tries ? ["未做", "new"] : q.last === 1 ? ["{check}做对", "ok"] : ["{x}做错", "due"]; // 显示最近一次的结果，不再笼统写「已做」
}

function render() {
	if (MODE === "wrong") {
		$("#tabs").replaceChildren(...[["active", "复习中"], ["mastered", "{folder}错题文件夹"]].map(([k, name]) =>
			el("button", { className: "tab" + (tab === k ? " on" : ""), textContent: name, onclick: () => { tab = k; load(); } })));
	}
	const subjects = [...new Set(data.items.map((q) => q.subject))];
	if (subject && !subjects.includes(subject)) subject = "";
	const chips = $("#chips");
	chips.replaceChildren();
	for (const s of ["", ...subjects]) {
		chips.append(el("button", { className: "chip" + (s === subject ? " on" : ""), textContent: s || "全部", onclick: () => { subject = s; cat = ""; render(); } }));
	}
	// 选了科目：再按章节分（Max 整理分类后会更整齐）
	const cats = subject ? [...new Set(data.items.filter((q) => q.subject === subject).map((q) => q.category || "未分章节"))] : [];
	if (cat && !cats.includes(cat)) cat = "";
	if (cats.length > 1) chips.append(el("div", { className: "chips2" }, ...["", ...cats].map((c) =>
		el("button", { className: "chip small" + (c === cat ? " on" : ""), textContent: c || "全部章节", onclick: () => { cat = c; render(); } }))));

	const shown = data.items.filter((q) => (!subject || q.subject === subject) && (!cat || (q.category || "未分章节") === cat));
	const todo = shown.filter((q) => (MODE === "wrong" ? tab === "active" && !q.pending : !q.tries && !(q.due && q.due > data.today)));
	const top = $("#redo");
	top.replaceChildren();
	if (MODE === "wrong" && tab === "mastered") {
		top.append(el("p", { className: "mute", textContent: `重做做对的错题先放这里：${data.items.length} 道。Max 会整理好总结，Claude 每天来取，做后续（讲评、归档、出巩固题）。每天凌晨 2:30 自动清空` }));
		if (data.folder) top.append(el("div", { className: "card maxcard" }, el("h2", {}, icon("max"), maxWord(), " 的整理"), el("p", { textContent: data.folder, style: "white-space:pre-wrap" })));
	}
	if (MODE === "bank") top.append(el("button", { type: "button", className: "btn small", style: "margin-bottom:10px", textContent: "{folder}让 Max 整理分类（合并同义考点、归章节）", onclick: async (e) => {
		const b = e.currentTarget, old = b.textContent;
		b.disabled = true; b.textContent = "Max 整理中…";
		try {
			await api("/api/max/classify", { method: "POST" }); // 后台整理，这里只等它的结果
			const s = await pollUntil("/api/max/classify", (x) => x.status !== "running");
			if (!s) toast("还在整理，稍后刷新页面看看");
			else if (s.status === "error") toast(s.msg);
			else { toast(s.n ? `整理好 ${s.n} 个考点` : "没有新考点，不用整理"); dropCache(); load(); } // 清缓存：不然 60 秒内读到的还是整理前的
		} catch (err) { toast(err.message); }
		finally { b.disabled = false; b.textContent = old; }
	} }));
	if (todo.length) {
		const href = MODE === "bank" && subject && !cat ? "/quiz?subject=" + encodeURIComponent(subject) : quizHref(todo.map((q) => q.id).slice(0, 50));
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
	const del = el("button", { type: "button", className: "del", textContent: "{trash}删除", onclick: async (e) => { e.stopPropagation(); if (await delQuestion(q.id)) load(); } });
	const item = el("div", { className: "item" },
		el("div", { className: "body" },
			el("span", { className: "tag", textContent: subject ? q.category || q.subject : q.subject }),
			q.tag ? el("span", { className: "tag ty", textContent: q.tag }) : "",
			q.topic ? el("span", { className: "tag tp", textContent: q.topic }) : "",
			el("span", { className: "time", textContent: "{clock}" + when(q.created_at) }),
			el("div", { className: "stem", textContent: short(q.stem) }),
			MODE === "wrong" ? el("div", { className: "why" },
				el("span", { className: "mx", textContent: q.max_reason ? "错因：" + q.max_reason : "错因：Max 待分析" })) : ""),
		el("div", { className: "side" }, el("span", { className: "st " + cls, textContent: label }), del));
	if (MODE === "bank") {
		item.onclick = () => (location.href = quizHref([q.id]));
		return item;
	}
	// 错题本：点开看错答、答案、解析
	const detail = el("div", { className: "detail hide" });
	item.onclick = async () => {
		detail.classList.toggle("hide");
		if (detail.dataset.loaded || detail.dataset.loading) return;
		detail.dataset.loading = "1"; // 连点两下别重复加载、重复追加内容
		let d;
		try { d = await api("/api/question/" + q.id); } catch (e) { detail.classList.add("hide"); return toast("加载失败：" + e.message); } finally { delete detail.dataset.loading; }
		detail.dataset.loaded = "1"; // 加载成功才记，失败了再点还能重试
		item.querySelector(".stem").textContent = d.stem;
		if (d.fig && typeof Fig !== "undefined") detail.append(Fig.view(d.fig, "small"));
		if (d.options.length) detail.append(el("div", { className: "mute", textContent: d.options.join("\n"), style: "white-space:pre-wrap" }));
		const wrong = d.attempts.find((a) => a.is_correct === 0);
		if (wrong && !/作图|函数|电路|光路|受力|证明/.test(d.tag || "")) detail.append(el("button", { type: "button", className: "btn small", textContent: "{max}问 Max 这题", style: "margin:6px 0", onclick: () => Max.open({ explain: wrong.id }, "讲讲这道题") }));
		if (wrong) {
			detail.append(el("div", { className: "ans bad", textContent: "你的答案：" + (plain(wrong.answer_text) || "（空）") + (wrong.error_reason ? `（${wrong.error_reason}）` : "") }));
			if (wrong.comment) detail.append(el("div", { className: "ans", textContent: "评语：" + wrong.comment }));
		}
		detail.append(el("div", { className: "ans", textContent: "正确答案：" + d.answer.join(" / ") }));
		if (d.topic) detail.append(noteLink(d.subject, d.topic));
		if (d.explanation) detail.append(el("div", { className: "ans", textContent: "解析：" + d.explanation }));
		const act = (path) => async () => { await api(`/api/question/${q.id}/${path}`, { method: "POST" }); load(); };
		detail.append(el("div", { className: "row", style: "margin-top:8px" },
			tab === "active" ? el("a", { className: "btn", href: quizHref([q.id]), textContent: "重做", style: "text-decoration:none" }) : "",
			// 标为已掌握前先做一道 Max 出的变式题，做对才标（作图类 Max 出不了，直接标）
			tab === "active" ? (/作图|函数|电路|光路|受力|证明/.test(d.tag || "") ? el("button", { className: "btn", textContent: "标为已掌握", onclick: act("master") })
				: el("a", { className: "btn", style: "text-decoration:none", href: `/quiz?topic=${encodeURIComponent(d.subject + "/" + (d.topic || "综合"))}&n=1&like=${q.id}&master=${q.id}`, textContent: "标为已掌握（先做道变式）" })) : "",
			el("button", { className: "btn", textContent: "删除", style: "color:var(--bad)", onclick: async () => (await delQuestion(q.id)) && load() })));
		math(item.parentElement);
	};
	return el("div", { className: "wrapitem" }, item, detail);
}

// 错题本顶部：错因统计（脚本归类 vs Max 归类）+ Max 总结 + 一键整理
let lastSum = "", waitSum = 0;
async function loadSum() {
	if (MODE !== "wrong") return; // 题库页没有错因卡片
	if (tab !== "active") { lastSum = ""; return $("#maxsum").replaceChildren(); }
	const s = await cachedApi("/api/max/wrongsum", 120000).catch(() => null);
	if (s?.thinking && waitSum++ < 8) setTimeout(() => { dropCache(); loadSum(); }, 15000); // Max 后台重写总结中：过一会儿再看（最多等 2 分钟）
	if (!s || !s.total) return $("#maxsum").replaceChildren();
	if (JSON.stringify(s) === lastSum) return; // 没变不重画、不再弹提示
	lastSum = JSON.stringify(s);
	// 错因只列最多的 3 类，其余合并成一句（Max 给每道题的错因写得很细，全列出来太长）
	const bars = (m) => {
		const all = Object.entries(m).filter(([k]) => k !== "待分析").sort((a, b) => b[1] - a[1]), top = all.slice(0, 3), rest = all.slice(3);
		return el("div", { className: "bars" }, ...top.map(([k, n]) =>
			el("div", {}, el("span", { textContent: k }), el("i", { style: `width:${Math.round((n / s.total) * 100)}%` }), el("b", { textContent: n }))),
			rest.length ? el("p", { className: "mute", textContent: `另有 ${rest.length} 类，各 1-${rest[0][1]} 道` }) : "");
	};
	const org = !s.todo ? "" : el("button", { type: "button", className: "btn small", textContent: `{folder}让 Max 整理（${s.todo} 道没整理）`, onclick: async () => {
		const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 150000);
		org.disabled = true; org.textContent = "整理中…";
		try { await api("/api/max/organize", { method: "POST", signal: ctl.signal }); load(); }
		catch (e) { toast(ctl.signal.aborted ? "Max 整理太久了，稍后再点一次" : e.message); }
		finally { clearTimeout(t); org.disabled = false; lab(org, "{folder}让 Max 整理"); }
	} });
	$("#maxsum").replaceChildren(el("div", { className: "card maxcard" },
		el("h2", { textContent: `错因分析（${s.total} 道错题）` }),
		s.summary ? el("p", { textContent: "{max}" + s.summary }) : "",
		Object.keys(s.max).length ? el("div", { className: "why2" }, el("div", {}, el("b", { textContent: "Max 看题分析的错因" }), bars(s.max))) : "",
		el("div", { className: "row" }, org,
			s.stale ? el("button", { type: "button", className: "btn small", textContent: "↻ 让 Max 重新总结", onclick: async (e) => { e.target.disabled = true; await api("/api/max/wrongsum?force=1").catch(() => {}); dropCache(); load(); } }) : "",
			el("button", { type: "button", className: "btn small", textContent: "问 Max", onclick: () => Max.open({}, "总结这页的错题，最该先补哪块？") }))));
	const top = Object.entries(s.max).filter(([k]) => k !== "待分析").sort((a, b) => b[1] - a[1])[0];
	Max.tip(`错题 ${s.total} 道` + (top ? `，最多的错因：${top[0]}` : s.todo ? `，Max 正在分析错因` : ""));
}
addEventListener("max:changed", () => load());

let loadSeq = 0, lastSig = "";
function load() {
	loadSum();
	const my = ++loadSeq, url = MODE === "wrong" ? "/api/wrong?tab=" + tab : "/api/bank";
	cachedApi(url, 60000).then((d) => {
		if (my !== loadSeq) return; // 快速切标签：只用最后一次
		const sig = url + JSON.stringify(d);
		if (sig === lastSig) return; // 数据没变就不重画（不收起正在看的题）
		lastSig = sig; data = d; render();
	}).catch((e) => { if (my === loadSeq && !lastSig) toast("加载失败：" + e.message); }); // 还没显示过东西才提示（切回页面的自动刷新失败不打扰）
}
load();
autoRefresh(load); // 切回页面时更新（数据没变不重画，展开的题不会收起）
