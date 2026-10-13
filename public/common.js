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
// 中文输入法正在选字时按的回车不算「确定」（Safari 选字的回车 isComposing 是 false，只能靠 keyCode 229 认出来）
const composing = (e) => e.isComposing || e.keyCode === 229;
// 触感反馈：安卓用 vibrate；iPhone/iPad 的 Safari 不给网页振动，但 iOS 17.4+ 点一下 <input switch> 开关会有一下轻震，借来用（没有的设备静默跳过）
const haptic = (() => {
	let sw;
	const tick = () => { try { sw ||= document.body.appendChild(Object.assign(document.createElement("label"), { innerHTML: '<input type="checkbox" switch>', style: "position:fixed;left:-99px;top:0;opacity:0;pointer-events:none" })); sw.click(); } catch {} };
	return (...gaps) => { // 例：haptic(0, 90, 110)：第 0、90、200 毫秒各一下
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		if (navigator.vibrate) return void navigator.vibrate(gaps.flatMap((g, i) => (i ? [g, 12] : [12])));
		let t = 0; for (const g of gaps) setTimeout(tick, (t += g));
	};
})();
// ---------- 站内图标：全站统一的线条图标（24 格、线宽 1.7、圆头），颜色跟着文字走；Max 自己的标志是放射星（光芒会呼吸，思考时更活跃）----------
const LOGO = `<svg viewBox="-12 -12 24 24" width="32" height="32" aria-hidden="true"><g stroke="#D97757" stroke-width="2.3" stroke-linecap="round">${
	[10, 7.6, 9.4, 7.2, 10, 8, 9.2, 7.4, 10, 7.8, 9.6, 7.3].map((r, i) => {
		const a = ((i * 30 + (i % 3) * 4) * Math.PI) / 180, f = (n) => n.toFixed(2);
		return `<line x1="${f(Math.cos(a) * 2.2)}" y1="${f(Math.sin(a) * 2.2)}" x2="${f(Math.cos(a) * r)}" y2="${f(Math.sin(a) * r)}" style="animation-delay:-${f(((i * 5) % 12) * 0.09)}s"/>`;
	}).join("")}</g></svg>`;
const ICONS = {
	camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
	calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/>',
	book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/>',
	note: '<path d="M5 19l1-4 9.5-9.5a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L9 18z"/><path d="M13.5 7.5l3 3"/>',
	pin: '<path d="M9 4h6l-1 5 3 3v1.5H7V12l3-3z"/><path d="M12 13.5V20"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
	trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10.5 11v5M13.5 11v5"/>',
	clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
	calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
	hourglass: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4.5 8 4.5 8 8.5s-8 4-8 8.5M16 3.5c0 4.5-8 4.5-8 8.5"/>',
	target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12h.01"/>',
	folder: '<path d="M3.5 7a2 2 0 0 1 2-2H10l2 2.5h6.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
	tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><path d="M8 8.5h.01"/>',
	plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
	pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
	eraser: '<path d="M9 19.5h10.5M5 14.5l8-8a1.8 1.8 0 0 1 2.5 0l3 3a1.8 1.8 0 0 1 0 2.5l-6 6H9.5z"/>',
	locate: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
	shapes: '<path d="M4 20l7-14 7 14z"/><circle cx="18" cy="6" r="2.2"/>',
	circuit: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 12h2.5l1.5-3 2 6 1.5-3H17"/>',
	lens: '<path d="M12 3.5c-4 3-4 14 0 17 4-3 4-14 0-17z"/><path d="M3.5 12h17"/>',
	pen: '<path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19z"/>',
	bookmark: '<path d="M7 4h10v16l-5-3.5L7 20z"/>',
	compare: '<path d="M7 4v16M17 4v16M3.5 8L7 4l3.5 4M13.5 16L17 20l3.5-4"/>',
	repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h11l-3-3M20 13v2a3 3 0 0 1-3 3H6l3 3"/>',
	check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
	x: '<path d="M6 6l12 12M18 6L6 18"/>',
	warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5h.01"/>',
	gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M18 6l-1.8 1.8M7.8 16.2L6 18"/>',
};
/** 图标的 HTML 字符串（用在拼 innerHTML 的地方）；max = Max 的放射星标志 */
const ico = (name) => name === "max" ? `<span class="ic mlogo">${LOGO}</span>` : ICONS[name] ? `<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg></span>` : "";
const icon = (name) => { const t = document.createElement("template"); t.innerHTML = ico(name); return t.content.firstChild; };
/** 文字前面可以写 {图标名}：「{trash}删除」→ 图标 + 文字（图标名不认识就原样当文字，不会误伤题目内容） */
function lab(e, s) {
	const m = /^\{(\w+)\}\s*/.exec(s);
	if (m && (m[1] === "max" || ICONS[m[1]])) { e.textContent = s.slice(m[0].length); e.prepend(icon(m[1])); } else e.textContent = s;
	return e;
}
// ---------- 手绘字「颤动」：三张不同噪声的扭曲滤镜，CSS 每 0.14 秒轮换一张（像逐格动画）；全站共用，页面加载时插一次 ----------
const BOIL = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter color-interpolation-filters="sRGB" id="boil0"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="1" seed="2"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter><filter color-interpolation-filters="sRGB" id="boil1"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="1" seed="9"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter><filter color-interpolation-filters="sRGB" id="boil2"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="1" seed="17"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter><filter color-interpolation-filters="sRGB" id="bigboil0"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="1" seed="4"/><feDisplacementMap in="SourceGraphic" scale="6"/></filter><filter color-interpolation-filters="sRGB" id="bigboil1"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="1" seed="13"/><feDisplacementMap in="SourceGraphic" scale="6"/></filter><filter color-interpolation-filters="sRGB" id="bigboil2"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="1" seed="29"/><feDisplacementMap in="SourceGraphic" scale="6"/></filter></svg>';
const boilDefs = () => { if (!document.getElementById("boil0")) document.body.insertAdjacentHTML("beforeend", BOIL); };
document.body ? boilDefs() : addEventListener("DOMContentLoaded", boilDefs, { once: true });
/** Max 的手写字标志（会颤动），用在标题、Max 窗口顶部 */
const maxWord = () => watchHw(el("span", { className: "hw mword", textContent: "Max" }));
// 省电：颤动的字滚出屏幕就暂停（只有看得见的才逐格重画）
const hwSeen = "IntersectionObserver" in window ? new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle("off", !e.isIntersecting); }) : null;
function watchHw(e) { hwSeen?.observe(e); return e; }
addEventListener("DOMContentLoaded", () => document.querySelectorAll(".hw").forEach(watchHw), { once: true });
// ---------- 手绘涂鸦特效（像蜡笔在画面上随手画的爱心、星星、感叹号，逐格颤动地蹦出来再消失）----------
// 只在「值得庆祝 / 要提醒」的瞬间出现，平时页面保持安静；低配和「减少动态」时不画
const DOODLE = {
	heart: "M50 84C22 62 8 44 18 28c9-13 25-10 32 5 7-15 23-18 32-5 10 16-4 34-32 56z",
	spark: "M50 6c3 22 9 33 40 44-31 9-37 20-40 44-4-24-10-35-40-44 30-11 36-22 40-44z",
	excl: "M44 10l14-2-5 56-6 1zM51 76c5 0 7 4 6 8s-7 5-9 1 0-9 3-9z",
	check: "M12 54c8 6 15 14 22 24 14-26 30-46 54-64",
	swirl: "M48 52c-8-6 0-16 8-11 10 6 2 22-10 20-16-3-17-26-2-33 18-9 38 6 33 26",
};
function doodle(kind, x, y, o = {}) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("lite")) return;
	if (!document.getElementById("dz0")) document.body.insertAdjacentHTML("beforeend", `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${[3, 11, 23].map((s, i) =>
		`<filter color-interpolation-filters="sRGB" id="dz${i}"><feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="1" seed="${s}"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter>`).join("")}</svg>`);
	const d = document.createElement("i"), fill = kind !== "check" && kind !== "swirl";
	d.className = "doodle" + (o.stay ? " stay" : "");
	d.style.cssText = `left:${x}px;top:${y}px;--s:${o.size || 40}px;--r:${o.rot ?? (Math.random() - 0.5) * 40}deg;animation-delay:${o.delay || 0}s,0s,${(o.delay || 0) + 1.2}s`;
	d.innerHTML = `<svg viewBox="0 0 100 100"><path d="${DOODLE[kind]}" fill="${fill ? "var(--df)" : "none"}"/></svg>`;
	(o.in || document.body).append(d);
	if (!o.stay) setTimeout(() => d.remove(), 1900 + (o.delay || 0) * 1000);
	return d;
}
/** 在元素周围撒几个涂鸦：kinds 依次轮流用 */
function doodles(anchor, kinds, n = 5) {
	const r = anchor.getBoundingClientRect(), cx = r.left + Math.min(r.width, 260) / 2, cy = r.top + r.height / 2;
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, dist = 60 + Math.random() * 40;
		doodle(kinds[i % kinds.length], cx + Math.cos(a) * dist * 1.4, cy + Math.sin(a) * dist * 0.8, { size: 30 + Math.random() * 22, delay: i * 0.07 });
	}
}
// 画布清晰度：按屏幕真实倍率（iPhone 3 倍），低配设备 2 倍
const DPR = () => Math.min(devicePixelRatio || 1, document.documentElement.classList.contains("lite") ? 2 : 3);
function el(tag, props = {}, ...kids) {
	const e = Object.assign(document.createElement(tag), props);
	if (typeof props.textContent === "string" && props.textContent[0] === "{") lab(e, props.textContent); // 开头的 {图标名}
	for (const k of kids) e.append(k);
	return e;
}
// 文字用 textContent 写入，再让 KaTeX 渲染 $...$ 公式（含 \ce{} 化学式）
// KaTeX 三个脚本是 defer 加载的，DOMContentLoaded 时才保证都执行完（页面解析完、脚本还没下载完的空档里，readyState 已经不是 loading 了，
// 第一次打开、接口先回来时公式会漏渲染；mhchem 也可能还没到，\ce 渲染不出），所以以 DOMContentLoaded 为准
let domReady = document.readyState !== "loading";
if (!domReady) addEventListener("DOMContentLoaded", () => (domReady = true), { once: true });
function math(root) {
	if (!domReady) return addEventListener("DOMContentLoaded", () => math(root), { once: true });
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
