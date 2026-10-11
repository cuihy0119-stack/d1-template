// 公共小工具
async function api(url, opts) {
	const write = opts?.method && opts.method !== "GET";
	if (write) dropCache(); // 改了数据（交题、删题、标记…）：本页缓存作废
	const r = await fetch(url, opts);
	if (write) dropCache(); // 请求期间别处可能又缓存了旧数据：完成后再清一次
	if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
	return r.json();
}
const $ = (s) => document.querySelector(s);
// 接口结果在本标签页缓存 ttl 毫秒：刷新页面、来回切换都不重复请求（一改数据就清掉）
async function cachedApi(url, ttl) {
	try { const c = JSON.parse(sessionStorage.getItem("c:" + url) || "null"); if (c && Date.now() - c.at < ttl) return c.d; } catch {}
	const d = await api(url);
	try { sessionStorage.setItem("c:" + url, JSON.stringify({ at: Date.now(), d })); } catch {}
	return d;
}
// 后台任务：每 3 秒问一次状态，直到 done() 为真或超过 max 毫秒（结果已存库，超时后刷新也能看到）
async function pollUntil(url, done, max = 240000) {
	for (const end = Date.now() + max; ;) {
		const s = await api(url);
		if (done(s)) return s;
		if (Date.now() > end) return null;
		await new Promise((r) => setTimeout(r, 3000));
	}
}
function dropCache() { try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("c:")) sessionStorage.removeItem(k); } catch {} }
// 第一次打开时测一下帧率（页面加载完再测，取中位数，避免把加载时的忙碌误判成卡）：明显掉帧就记住用精简模式
try {
	if (!localStorage.perf2) addEventListener("load", () => setTimeout(() => {
		const d = [];
		let last = 0;
		const f = (t) => {
			if (last) d.push(t - last);
			last = t;
			if (d.length < 30) return requestAnimationFrame(f);
			d.sort((a, b) => a - b);
			localStorage.perf2 = d[15] > 40 ? "lite" : "full"; // 低电量模式锁 30 帧（33ms）不算卡
			if (localStorage.perf2 === "lite") document.documentElement.classList.add("lite");
		};
		requestAnimationFrame(f);
	}, 800));
} catch {}
// 画布清晰度：按屏幕真实倍率（iPhone 3 倍），低配设备 2 倍
const DPR = () => Math.min(devicePixelRatio || 1, document.documentElement.classList.contains("lite") ? 2 : 3);
function el(tag, props = {}, ...kids) {
	const e = Object.assign(document.createElement(tag), props);
	for (const k of kids) e.append(k);
	return e;
}
// 文字用 textContent 写入，再让 KaTeX 渲染 $...$ 公式（含 \ce{} 化学式）
function math(root) {
	if (!window.renderMathInElement && document.readyState === "loading") return addEventListener("DOMContentLoaded", () => math(root), { once: true }); // KaTeX 是 defer 加载的
	if (window.renderMathInElement) renderMathInElement(root, {
		delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
		throwOnError: false,
	});
}
// 手机拍的照片压缩（错题照片最长边 1280px 方便识别题目；作答照片 1024px 省用量）
function compress(file, max = 1280) {
	return new Promise((resolve) => {
		if (!file.type.startsWith("image/")) return resolve(file);
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => {
			const s = Math.min(1, max / Math.max(img.width, img.height));
			const c = document.createElement("canvas");
			c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
			c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
			URL.revokeObjectURL(url);
			c.toBlob((b) => { c.width = c.height = 0; resolve(b ? new File([b], "photo.jpg", { type: "image/jpeg" }) : file); }, "image/jpeg", 0.85);
		};
		img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
		img.src = url;
	});
}

// 底部导航
function tabbar(active) {
	document.body.classList.add("has-tabs");
	// 线条平面图标（不用 emoji）：首页 = 房子，题库 = 书架，错题本 = 带叉的笔记本
	const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
	const tabs = [
		["/", "首页", ico('<path d="M3 11.2L12 3.8l9 7.4"/><path d="M5.5 9.6V20h13V9.6"/><path d="M10 20v-5.6h4V20"/>')],
		["/bank", "题库", ico('<path d="M4 4.5h4v15H4z"/><path d="M10 4.5h4v15h-4z"/><path d="M15.4 6.3l3.7-.9 3 13.2-3.7.9z"/>')],
		["/wrong", "错题本", ico('<path d="M5 3.5h12.5A1.5 1.5 0 0119 5v14a1.5 1.5 0 01-1.5 1.5H5z"/><path d="M9 3.5v17"/><path d="M12.4 9.2l3.2 3.2m0-3.2l-3.2 3.2"/>')],
	];
	const nav = el("nav", { className: "tabbar" });
	for (const [href, name, icon] of tabs) {
		nav.append(el("a", { href, className: href === active ? "on" : "" }, el("b", { innerHTML: icon }), name));
	}
	try { if (sessionStorage.getItem("seen")) document.documentElement.classList.add("seen"); else sessionStorage.setItem("seen", "1"); } catch {} // 底栏只在第一次浮入
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
	grade: "用练习本：批改待批改的作答，写评语",
	inbox: "用练习本：处理收件箱的照片，整理成错题并出同类题",
	marked: "用练习本：解析我标记的题",
	exams: "用练习本：把我临近的考试（名称和日期）写到首页倒计时",
};
// iPhone/iPad：同页打开链接，系统会直接拉起 Claude App（通用链接）；App 不一定读得到预填内容，所以同时把指令复制好，进去粘贴即可
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const askClaude = (text, label) =>
	el("a", { className: "btn", href: "https://claude.ai/new?q=" + encodeURIComponent(text), textContent: label, style: "text-decoration:none;margin-top:10px",
		...(IOS ? {} : { target: "_blank", rel: "noopener" }),
		onclick: () => { dropCache(); navigator.clipboard?.writeText(text).then(() => toast("指令已复制，在 Claude 里粘贴发送即可"), () => {}); } });
function toast(msg) {
	const t = el("div", { className: "toast", textContent: msg });
	document.body.append(t);
	setTimeout(() => t.remove(), 2600);
}

// 画布手势封装：不触发浏览器的选中、双击放大、长按菜单、放大镜；用 Apple Pencil 时忽略手掌碰到的触摸
function guardCanvas(cv) {
	const stop = (e) => e.cancelable && e.preventDefault();
	for (const ev of ["touchstart", "touchmove", "touchend", "dblclick", "contextmenu", "selectstart", "gesturestart"]) cv.addEventListener(ev, stop, { passive: false });
	let pen = 0;
	const palm = (e) => {
		if (e.pointerType === "pen") pen = Date.now();
		else if (e.pointerType === "touch" && Date.now() - pen < 2000) e.stopImmediatePropagation(); // 刚用过笔：手指/手掌的触摸不算
	};
	for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) cv.addEventListener(ev, palm);
}

// 作答里的「[作图] …」「[电路] …」是给 Claude 的描述，自己看时换成提示；[计算] 步骤是公式，照常显示
function plain(t) {
	let hid = false;
	t = (t || "").replace(/\n?\[(作图|电路)\][^\n]*/g, () => ((hid = true), ""));
	return (t + (hid ? " （见画板图）" : "")).trim();
}

// 错题 → Notion 同考点笔记：后端按考点名搜 Notion 页面标题，找到才显示按钮（没连 Notion 或没这篇笔记就不出现）
const noteMemo = {};
function noteLink(subject, topic, cls = "btn small") {
	const a = el("a", { className: cls, hidden: true, target: "_blank", rel: "noopener", style: "text-decoration:none;margin-top:8px" });
	if (topic) (noteMemo[subject + "/" + topic] = noteMemo[subject + "/" + topic] || api("/api/notion?subject=" + encodeURIComponent(subject || "") + "&topic=" + encodeURIComponent(topic)).catch(() => null)).then((r) => { if (r?.note) { a.href = r.note.url; a.textContent = "Notion 笔记：" + r.note.title; a.hidden = false; } });
	return a;
}
// 推送时间：库里是 UTC，显示北京时间「10-10 10:35」
const when = (t) => (t ? new Date(t.replace(" ", "T") + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-") : "");
// 删题（做题记录保留）
const delQuestion = async (id) => confirm("删除这道题？（做题记录会保留）") && (await api(`/api/question/${id}/delete`, { method: "POST" }), true);
