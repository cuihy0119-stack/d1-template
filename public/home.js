tabbar("/");

async function loadHome() {
	const h = await api("/api/home");
	$("#today").textContent = `今日练习（${h.today_count} 题）`;
	if (h.summary) $("#summary").textContent = h.summary.text;
	$("#upmsg").textContent = h.pending_uploads ? `${h.pending_uploads} 张照片等 Claude 处理` : "";
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
	msg.textContent = `上传中… 0/${files.length}`;
	try {
		for (let i = 0; i < files.length; i++) {
			const fd = new FormData();
			fd.append("files", await compress(files[i]));
			await api("/api/uploads", { method: "POST", body: fd });
			msg.textContent = `上传中… ${i + 1}/${files.length}`;
		}
		await loadHome();
		msg.textContent = `已上传 ${files.length} 张。` + msg.textContent;
	} catch (err) {
		msg.textContent = "上传失败：" + err.message;
	}
	e.target.value = "";
};

loadHome();
