// 公共小工具
async function api(url, opts) {
	const r = await fetch(url, opts);
	if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
	return r.json();
}
const $ = (s) => document.querySelector(s);
function el(tag, props = {}, ...kids) {
	const e = Object.assign(document.createElement(tag), props);
	for (const k of kids) e.append(k);
	return e;
}
// 文字用 textContent 写入，再让 KaTeX 渲染 $...$ 公式（含 \ce{} 化学式）
function math(root) {
	if (window.renderMathInElement) renderMathInElement(root, {
		delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
		throwOnError: false,
	});
}
// 手机拍的照片压缩到最长边 1280px，省流量也方便 Claude 读取
function compress(file) {
	return new Promise((resolve) => {
		if (!file.type.startsWith("image/")) return resolve(file);
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => {
			const s = Math.min(1, 1280 / Math.max(img.width, img.height));
			const c = document.createElement("canvas");
			c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
			c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
			URL.revokeObjectURL(url);
			c.toBlob((b) => resolve(b ? new File([b], "photo.jpg", { type: "image/jpeg" }) : file), "image/jpeg", 0.85);
		};
		img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
		img.src = url;
	});
}

// 底部导航
function tabbar(active) {
	document.body.classList.add("has-tabs");
	const tabs = [["/", "首页", "🏠"], ["/bank", "题库", "📚"], ["/wrong", "错题本", "📕"]];
	const nav = el("nav", { className: "tabbar" });
	for (const [href, name, icon] of tabs) {
		nav.append(el("a", { href, className: href === active ? "on" : "" }, el("b", { textContent: icon }), name));
	}
	document.body.append(nav);
	// 支持的浏览器手指按下链接时预取其它页面（只下载，不提前渲染，不占性能），切换更快
	if (HTMLScriptElement.supports?.("speculationrules"))
		document.head.append(Object.assign(document.createElement("script"), { type: "speculationrules", textContent: JSON.stringify({ prefetch: [{ source: "list", urls: tabs.map((t) => t[0]), eagerness: "conservative" }] }) }));
}

// 自动刷新：切回页面、按返回键回来（浏览器缓存的旧页面）时刷新；every>0 时页面可见期间定时刷新
function autoRefresh(fn, every = 0) {
	const run = () => document.visibilityState === "visible" && fn();
	document.addEventListener("visibilitychange", run);
	window.addEventListener("pageshow", (e) => e.persisted && fn());
	if (every) setInterval(run, every);
}

// 一键打开 claude.ai 新对话并预填指令（网站不能主动叫醒 Claude，这是最省事的办法）
const CLAUDE_ASK = {
	grade: "用练习本：批改所有待批改的作答，写评语",
	inbox: "用练习本：处理收件箱的照片，整理成错题并出同类题",
};
const askClaude = (text, label) =>
	el("a", { className: "btn", href: "https://claude.ai/new?q=" + encodeURIComponent(text), target: "_blank", rel: "noopener", textContent: label, style: "text-decoration:none;margin-top:10px" });

// 作答里的「[作图] …」「[电路] …」是给 Claude 的描述，自己看时换成提示；[计算] 步骤是公式，照常显示
function plain(t) {
	let hid = false;
	t = (t || "").replace(/\n?\[(作图|电路)\][^\n]*/g, () => ((hid = true), ""));
	return (t + (hid ? " （见画板图）" : "")).trim();
}

// 推送时间：库里是 UTC，显示北京时间「10-10 10:35」
const when = (t) => (t ? new Date(t.replace(" ", "T") + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-") : "");
// 删题（做题记录保留）
const delQuestion = async (id) => confirm("删除这道题？（做题记录会保留）") && (await api(`/api/question/${id}/delete`, { method: "POST" }), true);
