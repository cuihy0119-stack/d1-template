// 公共小工具
async function api(url, opts) {
	const r = await fetch(url, opts);
	if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
	return r.json();
}
const $ = (s) => document.querySelector(s);
// 第一次打开时测一下帧率：明显掉帧就记住用精简模式（关模糊和进场动画），以后打开直接流畅
try {
	if (!localStorage.perf) {
		let n = 0, t0 = 0;
		const f = (t) => { if (!t0) t0 = t; if (++n < 40) return requestAnimationFrame(f);
			localStorage.perf = (t - t0) / 39 > 22 ? "lite" : "full";
			if (localStorage.perf === "lite") document.documentElement.classList.add("lite"); };
		requestAnimationFrame(f);
	}
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
// iPhone/iPad：同页打开链接，系统会直接拉起 Claude App（通用链接）；App 不一定读得到预填内容，所以同时把指令复制好，进去粘贴即可
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const askClaude = (text, label) =>
	el("a", { className: "btn", href: "https://claude.ai/new?q=" + encodeURIComponent(text), textContent: label, style: "text-decoration:none;margin-top:10px",
		...(IOS ? {} : { target: "_blank", rel: "noopener" }),
		onclick: () => { navigator.clipboard?.writeText(text).then(() => toast("指令已复制，在 Claude 里粘贴发送即可"), () => {}); } });
function toast(msg) {
	const t = el("div", { className: "toast", textContent: msg });
	document.body.append(t);
	setTimeout(() => t.remove(), 2600);
}

// 画布手势封装（几种画板共用），减少误触：
// 1. 不触发浏览器的选中、双击放大、长按菜单、放大镜
// 2. 拒绝多点触控：一笔没画完，第二个触点一律不算；两指几乎同时落下（多半是手掌/误碰），前一笔也作废
// 3. 接触面积很大的触摸（手掌、手侧）直接忽略
// 4. 用过 Apple Pencil 后进入「笔写模式」：画板只认笔，手指在画板上滑动就是滚动页面
function guardCanvas(cv) {
	let pencil = false, cur = null, t0 = 0;
	const prevent = (e) => e.cancelable && e.preventDefault();
	// 笔写模式下手指要能滚动页面，只拦笔的触摸；否则全部拦下
	const touch = (e) => { if (!pencil || [...e.touches, ...e.changedTouches].some((t) => t.touchType === "stylus")) prevent(e); };
	for (const ev of ["touchstart", "touchmove", "touchend"]) cv.addEventListener(ev, touch, { passive: false });
	for (const ev of ["dblclick", "contextmenu", "selectstart", "gesturestart"]) cv.addEventListener(ev, prevent, { passive: false });
	const filter = (e) => {
		if (e.pointerType === "pen" && !pencil) { pencil = true; cv.style.touchAction = "pan-y"; }
		const bad = e.pointerType === "touch" && (pencil || Math.max(e.width || 0, e.height || 0) > 44);
		if (e.type === "pointerdown") {
			if (bad) return e.stopImmediatePropagation();
			if (cur !== null) { // 已经有一笔在画
				e.stopImmediatePropagation();
				if (e.pointerType === "touch" && Date.now() - t0 < 150) cv.dispatchEvent(new Event("abortstroke"));
				return;
			}
			cur = e.pointerId; t0 = Date.now();
			return;
		}
		if (cur === null) { if (e.pointerType !== "mouse") e.stopImmediatePropagation(); return; } // 鼠标悬停照常显示十字
		if (e.pointerId !== cur) return e.stopImmediatePropagation();
		if (e.type !== "pointermove") cur = null;
	};
	for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) cv.addEventListener(ev, filter);
}

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
