let subject = "";
let shown = [];
const TYPE = { single: "单选", multi: "多选", fill: "填空", short: "简答" };

async function loadHome() {
	const h = await api("/api/home");
	$("#today").textContent = `今日练习（${h.today_count} 题）`;
	if (h.summary) $("#summary").textContent = h.summary.text;
	$("#upmsg").textContent = h.pending_uploads ? `${h.pending_uploads} 张照片等 Claude 处理` : "";
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

async function loadWrong() {
	const d = await api("/api/wrong" + (subject ? "?subject=" + encodeURIComponent(subject) : ""));
	const chips = $("#chips");
	chips.replaceChildren();
	for (const s of ["", ...d.subjects]) {
		chips.append(el("button", {
			className: "chip" + (s === subject ? " on" : ""),
			textContent: s || "全部",
			onclick: () => { subject = s; loadWrong(); },
		}));
	}
	shown = d.items.map((i) => i.id);
	$("#redoall").classList.toggle("hide", !shown.length);
	const list = $("#list");
	list.replaceChildren();
	if (!d.items.length) list.append(el("p", { className: "mute", textContent: "暂无错题" }));
	for (const it of d.items) {
		const status = it.next_date ? `下次 ${it.next_date}` : "已掌握";
		list.append(el("div", { className: "wrong-item" },
			el("div", {},
				el("span", { className: "tag", textContent: it.subject }),
				el("span", { className: "tag", textContent: TYPE[it.type] || it.type }),
				el("span", { className: "mute", textContent: status }),
				el("div", { textContent: it.stem.length > 60 ? it.stem.slice(0, 60) + "…" : it.stem })),
			el("a", { className: "btn small", href: "/quiz?ids=" + it.id, textContent: "重做", style: "text-decoration:none" })));
	}
	math(list);
}

$("#wrongbtn").onclick = () => {
	$("#wrong").classList.toggle("hide");
	if (!$("#wrong").classList.contains("hide")) loadWrong();
};
$("#redoall").onclick = () => { location.href = "/quiz?ids=" + shown.join(","); };
window.addEventListener("load", () => math($("#list")));
loadHome();
