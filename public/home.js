tabbar("/");

// 日期 + 每天一句古训（文艺一点）
const LINES = ["学而不思则罔，思而不学则殆", "不积跬步，无以至千里", "博观而约取，厚积而薄发", "业精于勤，荒于嬉", "纸上得来终觉浅，绝知此事要躬行",
	"温故而知新，可以为师矣", "千淘万漉虽辛苦，吹尽狂沙始到金", "路漫漫其修远兮，吾将上下而求索", "问渠那得清如许，为有源头活水来", "宝剑锋从磨砺出，梅花香自苦寒来"];
const now = new Date();
$("#date").textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" }) + " · " + LINES[Math.floor(now / 864e5) % LINES.length];

// 坚持打卡 + 考试倒计时
// 数字从 0 滚到目标值（只在第一次显示时；精简模式/减少动态时直接显示）
let counted = false;
const calm = () => document.documentElement.classList.contains("lite") || matchMedia("(prefers-reduced-motion: reduce)").matches;
function countUp(b, n) {
	if (counted || calm() || !(n > 0)) return void (b.textContent = n);
	const t0 = performance.now(), f = (t) => { const k = Math.min(1, (t - t0) / 700); b.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); };
	b.textContent = 0; requestAnimationFrame(f);
}
function renderHero(h) {
	const chip = (n, label) => { const b = el("b"); countUp(b, n); return el("div", { className: "stat" }, b, el("span", { textContent: label })); };
	$("#stats").replaceChildren(chip(h.streak, h.done_today ? "连续练习天数" : "连续天数 · 今天还没练"), chip(h.today_count, "今日待练"), chip(h.right7, "近 7 天做对"));
	counted = true;
	const box = $("#exams");
	if (!h.exams.length) return box.replaceChildren(askClaude(CLAUDE_ASK.exams, "📅 让 Claude 写上临近的考试，首页倒计时"));
	box.replaceChildren(...h.exams.slice(0, 3).map((e, i) => {
		const d = Math.round((Date.parse(e.date) - Date.parse(h.today)) / 864e5);
		return el("div", { className: "exam" + (i ? "" : " first") },
			el("div", { className: "en", textContent: "距离 " + e.name }),
			el("div", { className: "ed" }, d ? el("b", { textContent: d }) : el("b", { textContent: "今天" }), d ? " 天" : ""),
			el("div", { className: "mute", textContent: e.date.slice(5).replace("-", " 月 ") + " 日" + (d <= 7 && d ? " · 冲刺！" : "") }));
	}));
}

let uploading = false, lastHome = "", waitBrief = 0;

async function loadHome() {
	if (uploading) return;
	const h = await cachedApi("/api/home?brief=1", 60000), sig = JSON.stringify(h); // 1 分钟内刷新直接用缓存，不发请求
	if (h.brief) { showBrief(h.brief); if (h.brief.thinking && waitBrief++ < 8) setTimeout(() => { dropCache(); refresh(); }, 15000); } // Max 还在后台想：过一会儿再看（最多等 2 分钟，之后交给定时任务，下次打开再看）
	if (sig === lastHome) return; // 没变化就不重画（每 30 秒检查一次）
	lastHome = sig;
	renderHero(h);
	Max.tip(h.today_count ? `今天还有 ${h.today_count} 题要练` + (h.pending_grades ? `，${h.pending_grades} 题等 Claude 批改` : "") : "今天的题都练完了 🎉");
	$("#today").textContent = `今日练习（${h.today_count} 题）`;
	$("#upmsg").textContent = h.pending_uploads ? `${h.pending_uploads} 张照片等 Claude 处理` : "";
	const ask = $("#ask");
	ask.replaceChildren();
	if (h.pending_grades) ask.append(askClaude(CLAUDE_ASK.grade, `让 Claude 批改（${h.pending_grades} 题待批改）`));
	if (h.pending_uploads) ask.append(askClaude(CLAUDE_ASK.inbox, `让 Claude 处理照片（${h.pending_uploads} 张）`));
	if (h.marked) ask.append(
		el("button", { type: "button", className: "btn", style: "margin-top:10px", textContent: `🤖 让 Max 解析标记的题（${h.marked} 题）`, onclick: () => Max.open({ marked: true }, "解析我标记的题") }),
		askClaude(CLAUDE_ASK.marked, `让 Claude 解析标记的题（${h.marked} 题）`));
	const rec = $("#recent");
	if (!h.recent.length) rec.replaceChildren("还没有题");
	else rec.replaceChildren(...h.recent.map((q) => el("div", { className: "recent" },
		el("a", { href: "/quiz?ids=" + q.id },
			el("div", {}, el("span", { className: "tag", textContent: q.subject }), el("span", { className: "tag", textContent: q.tag }), el("span", { className: "time", textContent: "🕒 " + when(q.created_at) })),
			el("div", { className: "stem", textContent: q.stem })),
		el("button", { type: "button", className: "del", textContent: "🗑 删除", onclick: async () => (await delQuestion(q.id)) && loadHome() }))));
	math(rec);
	const box = $("#subjects");
	box.replaceChildren();
	if (!h.subjects.length) box.append(el("p", { className: "mute", textContent: "还没有题，拍照上传错题或让 Claude 出题" }));
	for (const s of h.subjects) {
		box.append(el("a", { className: "subj", href: "/quiz?subject=" + encodeURIComponent(s.subject) },
			el("b", { textContent: s.subject }),
			el("div", { className: "mute", textContent: s.undone ? `${s.undone} 题未做` : `共 ${s.total} 题` })));
	}
}

$("#pick").onchange = async (e) => {
	const files = [...e.target.files];
	if (!files.length) return;
	const msg = $("#upmsg");
	uploading = true;
	msg.textContent = `上传中… 0/${files.length}`;
	try {
		for (let i = 0; i < files.length; i++) {
			const fd = new FormData();
			fd.append("files", await compress(files[i]));
			await api("/api/uploads", { method: "POST", body: fd });
			msg.textContent = `上传中… ${i + 1}/${files.length}`;
		}
		uploading = false;
		await loadHome().catch(() => {}); // 照片已经传上去了：刷新首页失败不算上传失败
		msg.textContent = `已上传 ${files.length} 张。` + msg.textContent;
	} catch (err) {
		uploading = false;
		msg.textContent = "上传失败：" + err.message;
	}
	e.target.value = "";
};

// Max：今天先做什么 + 薄弱点 + 考前冲刺（服务器按天缓存，做题有变化才重算，不怎么花额度）
let lastBrief = "";
// 手动「重新看看」才让 Max 重想（服务器 10 分钟内最多一次）；平时的建议跟着首页数据一起来，一天只想一次
async function rethink() {
	const b = await api("/api/max/brief?force=1").catch(() => null);
	if (b) { dropCache(); showBrief(b); }
}
function showBrief(b) {
	const box = $("#maxcard");
	if (!b || JSON.stringify(b) === lastBrief) return;
	lastBrief = JSON.stringify(b);
	const go = (ids, label) => (ids.length ? el("a", { className: "btn primary small", href: "/quiz?ids=" + ids.join(","), textContent: label }) : "");
	box.replaceChildren(
		el("h2", {}, "🤖 Max 的建议", el("span", { className: "maxtag", textContent: b.budget >= 85 ? "今日额度快用完" : "" })),
		el("p", { textContent: b.say || "" }),
		b.soon.length && b.sprint ? el("p", {}, el("b", { textContent: `⏳ ${b.soon[0].name} 冲刺：` }), b.sprint) : "",
		b.topics.length ? el("div", { className: "weak mute" }, "薄弱点：", ...b.topics.map((w) => el("span", { className: "tag", textContent: `${w.subject}·${w.topic} 错${w.wrong}/${w.n}` }))) : "",
		b.weakTip ? el("p", { className: "mute", textContent: b.weakTip }) : "",
		el("div", { className: "row" },
			go(b.order, `按 Max 推荐做（${b.order.length} 题）`),
			go(b.weakIds, b.soon.length ? `冲刺薄弱点（${b.weakIds.length} 题）` : `练薄弱点（${b.weakIds.length} 题）`),
			el("button", { type: "button", className: "btn small", textContent: "问 Max", onclick: () => Max.open({}) }),
			el("button", { type: "button", className: "btn small", textContent: "↻", title: "让 Max 重新看看", onclick: rethink })));
	box.hidden = false;
	math(box);
}

// 读不到首页数据（断网、服务器出错）：第一次就失败时在页面上说一声，之后的自动刷新失败不打扰
const refresh = () => loadHome().catch((e) => { if (!lastHome) $("#recent").textContent = "加载失败：" + e.message + "（切回页面会自动重试）"; });
addEventListener("max:changed", () => { lastHome = ""; refresh(); }); // Max 清理了题库：首页重新读
refresh();
autoRefresh(refresh, 120000); // 页面开着时 2 分钟看一次（Claude 推了新题会更新）；有缓存时不发请求
