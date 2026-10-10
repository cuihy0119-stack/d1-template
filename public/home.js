tabbar("/");

// 日期 + 每天一句古训（文艺一点）
const LINES = ["学而不思则罔，思而不学则殆", "不积跬步，无以至千里", "博观而约取，厚积而薄发", "业精于勤，荒于嬉", "纸上得来终觉浅，绝知此事要躬行",
	"温故而知新，可以为师矣", "千淘万漉虽辛苦，吹尽狂沙始到金", "路漫漫其修远兮，吾将上下而求索", "问渠那得清如许，为有源头活水来", "宝剑锋从磨砺出，梅花香自苦寒来"];
const now = new Date();
$("#date").textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" }) + " · " + LINES[Math.floor(now / 864e5) % LINES.length];

let uploading = false, lastHome = "";

async function loadHome() {
	if (uploading) return;
	const h = await api("/api/home"), sig = JSON.stringify(h);
	if (sig === lastHome) return; // 没变化就不重画（每 30 秒检查一次）
	lastHome = sig;
	$("#today").textContent = `今日练习（${h.today_count} 题）`;
	if (h.summary) $("#summary").textContent = h.summary.text;
	$("#upmsg").textContent = h.pending_uploads ? `${h.pending_uploads} 张照片等 Claude 处理` : "";
	const ask = $("#ask");
	ask.replaceChildren();
	if (h.pending_grades) ask.append(askClaude(CLAUDE_ASK.grade, `让 Claude 批改（${h.pending_grades} 题待批改）`));
	if (h.pending_uploads) ask.append(askClaude(CLAUDE_ASK.inbox, `让 Claude 处理照片（${h.pending_uploads} 张）`));
	if (h.marked) ask.append(askClaude(CLAUDE_ASK.marked, `让 Claude 解析标记的题（${h.marked} 题）`));
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
		await loadHome();
		msg.textContent = `已上传 ${files.length} 张。` + msg.textContent;
	} catch (err) {
		uploading = false;
		msg.textContent = "上传失败：" + err.message;
	}
	e.target.value = "";
};

loadHome();
autoRefresh(loadHome, 30000); // Claude 推了新题、写了总结，首页自动更新
