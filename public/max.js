// Max 助手：悬浮球 + 跟着球展开的液态玻璃窗口。
// 不拖慢网站：页面空闲时才放出悬浮球，第一次用到才搭窗口；位置和动画全用 transform/opacity（不触发重排）。
// 悬浮球：任意拖动，松手自动贴到最近的左/右边（位置会记住）；3 秒不用淡到 20%，一碰就亮。点一下，窗口从球的位置弹开。
// 思考/回答时标志的光芒一伸一缩、慢慢转。Max 能读当前页面文字，随时总结分析。
// 其它脚本：Max.open(ctx, 问题) 带上下文提问；Max.setCtx(ctx) 换上下文；Max.tip(文字) 在球旁边短暂提示（本地算的，不花额度）。
// ctx：{ q: 正在做的题 } { a: 已交的作答 } { explain: 作答id（一键讲解，有缓存）} { marked: true（解析标记的题）} { tmp: 临时练习题（不在题库）}
// 输入框上面两个标签：深度思考（只用 DeepSeek 的思考模型）、联网搜索（先搜网页再回答），点一下开、再点关；状态记在本标签页
const Max = (() => {
	const KEY = "max_chat", POS = "max_pos", IDLE = 3000, M = 10; // M：离屏幕边的距离
	const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch {} return null; };
	const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
	let att = null; // 待发的图片（dataURL，已压缩）
	let hist = [], ctx = {}, base = {}, ui = null, ball = null, peek = null, tipT = 0, idleT = 0, pendingTip = "", job = null; // job：正在进行的请求（可停止）
	try { hist = JSON.parse(ss(KEY) || "[]"); if (!Array.isArray(hist)) hist = []; } catch { hist = []; }
	const keep = () => ss(KEY, JSON.stringify(hist.slice(-12)));
	// 输入框上面的两个开关（深度思考 / 联网搜索）：记在本标签页，关掉浏览器就复位，免得忘了关一直多花额度
	const tg = (() => { try { const t = JSON.parse(ss("max_tg") || "{}"); return { deep: !!t.deep, web: !!t.web }; } catch { return { deep: false, web: false }; } })();
	const line = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
	const TAGS = [
		["deep", "深度思考", "只用 DeepSeek 的思考模型，想得更深、更慢", line('<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 00-3.6 10.8c.6.5 1.1 1.3 1.1 2.1V16h5v-.1c0-.8.5-1.6 1.1-2.1A6 6 0 0012 3z"/>')],
		["web", "联网搜索", "先搜网页再回答（说明来源）", line('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3z"/>')],
	];
	const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
	// 防误触：按下和抬起挪过 8px 的是滑动，不算点击；窗口或气泡刚弹出/收起的 450 毫秒内，抬手后的点击不算数
	// （悬浮球一点，窗口就在手指下弹开，抬手的「穿透点击」会落到刚出现的「今天先做什么？」上，所以要挡住）
	let downX = 0, downY = 0, quietUntil = 0;
	addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; }, { capture: true, passive: true });
	const quiet = () => { quietUntil = Date.now() + 450; };
	const ghost = (e) => e.detail && (Date.now() < quietUntil || Math.hypot(e.clientX - downX, e.clientY - downY) > 8); // detail=0 是键盘触发，照常
	const shield = (root) => root.addEventListener("click", (e) => { if (ghost(e)) { e.stopPropagation(); e.preventDefault(); } }, true);
	// 设置（存在本机）：len 回答长短，pref 优先引擎，fade 悬浮球闲置时的不透明度（1 = 不变淡）
	const prefs = (() => { try { return { len: "m", pref: "auto", fade: 0.2, ...JSON.parse(ls("max_prefs") || "{}") }; } catch { return { len: "m", pref: "auto", fade: 0.2 }; } })();
	const savePrefs = () => { ls("max_prefs", JSON.stringify(prefs)); applyFade(); };
	const applyFade = () => document.documentElement.style.setProperty("--ball-idle", String(prefs.fade));

	// Claude 风格的橙色放射状标志（定义在 common.js 的 LOGO，全站共用，到处都会动）
	const logo = (cls = "") => el("span", { className: "mlogo " + cls, innerHTML: LOGO });
	const setBusy = (on) => { document.body.classList.toggle("max-busy", on); if (!on) wake(); };

	// ---------- 位置 ----------
	// 刘海屏安全区（CSS 变量里读出来）
	const safe = () => { const cs = getComputedStyle(document.documentElement), n = (k) => parseFloat(cs.getPropertyValue(k)) || 0; return { t: n("--sat"), b: n("--sab"), l: n("--sal"), r: n("--sar") }; };
	const size = () => ball.offsetWidth || 58;
	const bottomGap = () => (document.body.classList.contains("has-tabs") ? 96 : 24); // 别挡底栏
	// pos：{ side: "l" | "r", y: 0~1 屏幕高度比例 }；做题页默认在左边（右边有画板工具条）
	let pos = (() => { try { const p = JSON.parse(ls(POS) || "null"); if (p && (p.side === "l" || p.side === "r") && p.y >= 0 && p.y <= 1) return p; } catch {} return { side: "r", y: 1 }; })();
	function xy(p = pos) { // 球左上角坐标
		const s = safe(), w = size(), top = s.t + 60, vv = window.visualViewport;
		const kb = vv ? innerHeight - vv.height - vv.offsetTop : 0; // 软键盘高度（>120 才算弹出）
		if (kb > 120) return { x: p.side === "l" ? s.l + M : innerWidth - s.r - M - w, y: Math.round(Math.max(top, vv.offsetTop + vv.height - w - 10)) }; // 键盘弹出：停在键盘右上方
		const bot = innerHeight - s.b - bottomGap() - w;
		return { x: p.side === "l" ? s.l + M : innerWidth - s.r - M - w, y: Math.round(Math.min(Math.max(p.y * innerHeight, top), Math.max(top, bot))) };
	}
	// 球的当前坐标记在 cur 里（不去量 getBoundingClientRect：按下时球会缩放，量出来会偏几像素）
	const cur = { x: 0, y: 0 };
	const place = (x, y) => { cur.x = x; cur.y = y; ball.style.transform = `translate3d(${x}px,${y}px,0)`; };
	const snap = () => { const p = xy(); place(p.x, p.y); };
	const box = () => { const w = ball ? size() : 58, p = ball ? xy() : { x: innerWidth - 60, y: innerHeight * 0.6 }; return { left: p.x, top: p.y, right: p.x + w, bottom: p.y + w, width: w, height: w }; }; // 球「落定」的位置
	// 闲置变淡：碰一下就亮，3 秒不碰淡下去
	function wake() {
		if (!ball) return;
		ball.classList.remove("idle");
		clearTimeout(idleT);
		if (prefs.fade < 1) idleT = setTimeout(() => { if (!document.body.classList.contains("max-busy")) ball.classList.add("idle"); }, IDLE);
	}

	// ---------- 悬浮球 ----------
	// 拖动：按住时记下手指和球左上角的距离，之后球始终跟着手指走（每帧最多挪一次）；
	// 松手按位置和甩动速度贴到左/右边，竖直方向顺着速度多滑一点；贴边用轻弹的动画
	// 防误触：点球打开（或点外面收起）时球/窗口立刻让开，手机浏览器随后补发的 click 会落到底下的链接上（如底部导航），跳走。吞掉紧接着的那一下 click
	function swallow() {
		const f = (e) => { e.preventDefault(); e.stopPropagation(); };
		document.addEventListener("click", f, true);
		setTimeout(() => document.removeEventListener("click", f, true), 450);
	}
	function makeBall() {
		applyFade();
		ball = el("button", { type: "button", className: "maxball", title: "Max 助手（可拖动）" }, logo());
		ball.style.visibility = "hidden";
		document.body.append(ball);
		snap();
		requestAnimationFrame(() => { ball.style.visibility = ""; });
		let down = false, moved = false, offX = 0, offY = 0, sx = 0, sy = 0, raf = 0, nx = 0, ny = 0, vx = 0, vy = 0, lt = 0, lx = 0, ly = 0;
		const frame = () => { raf = 0; place(nx, ny); };
		ball.addEventListener("pointerdown", (e) => {
			if (e.button > 0) return;
			down = true; moved = false; wake();
			// 球可能还在贴边/回弹的动画里：按住时先停在它「看起来」的位置，再算手指偏移，不然拿到的是动画终点，拖起来手指和球错开
			ball.classList.remove("land"); ball.classList.add("hold");
			try { const m = new DOMMatrixReadOnly(getComputedStyle(ball).transform); if (Number.isFinite(m.m41)) place(m.m41, m.m42); } catch {}
			sx = lx = e.clientX; sy = ly = e.clientY; lt = e.timeStamp; vx = vy = 0;
			offX = e.clientX - cur.x; offY = e.clientY - cur.y; // 手指在球里的位置（用记下的坐标，不受缩放影响）
			ball.classList.add("press");
			try { ball.setPointerCapture(e.pointerId); } catch {}
		});
		ball.addEventListener("pointermove", (e) => {
			if (!down) return;
			if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 6) { moved = true; ball.classList.add("drag"); hidePeek(); }
			if (!moved) return;
			const dt = Math.max(1, e.timeStamp - lt); // 甩动速度（px/ms，平滑一下）
			vx = vx * 0.6 + ((e.clientX - lx) / dt) * 0.4; vy = vy * 0.6 + ((e.clientY - ly) / dt) * 0.4;
			lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
			const w = size();
			nx = Math.min(Math.max(e.clientX - offX, 0), innerWidth - w);
			ny = Math.min(Math.max(e.clientY - offY, 0), innerHeight - w);
			if (!raf) raf = requestAnimationFrame(frame);
		});
		const end = (tap) => {
			if (!down) return;
			down = false;
			ball.classList.remove("press", "hold");
			if (moved) {
				cancelAnimationFrame(raf); raf = 0;
				if (nx || ny) place(nx, ny);
				const w = size(), cx = cur.x + w / 2;
				const side = Math.abs(vx) > 0.6 ? (vx < 0 ? "l" : "r") : cx < innerWidth / 2 ? "l" : "r"; // 快速一甩：往甩的方向贴
				const y = cur.y; // 竖直方向停在松手的地方（以前会顺着速度再滑一段，看起来像偏了）
				pos = { side, y: Math.min(1, Math.max(0, y / innerHeight)) };
				ls(POS, JSON.stringify(pos));
				ball.classList.remove("drag");
				ball.classList.add("land");
				requestAnimationFrame(snap);
				setTimeout(() => ball.classList.remove("land"), 500);
				swallow(); // 拖完松手的位置下面可能是链接
			} else if (tap) { swallow(); open(); }
			wake();
		};
		ball.addEventListener("pointerup", () => end(true));
		ball.addEventListener("pointercancel", () => end(false)); // 系统手势打断：照样落位
		ball.addEventListener("lostpointercapture", () => end(false));
		ball.addEventListener("pointerenter", wake);
		ball.addEventListener("touchmove", (e) => e.cancelable && e.preventDefault(), { passive: false }); // iOS：拖球时页面别跟着滚
		ball.addEventListener("contextmenu", (e) => e.preventDefault()); // 长按不弹菜单
		ball.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }); // 外接键盘也能打开
		let rt = 0;
		const refit = () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(() => { if (!down) snap(); if (ui?.island.classList.contains("open")) layout(); }); };
		addEventListener("resize", refit, { passive: true });
		window.visualViewport?.addEventListener("resize", refit, { passive: true }); // 键盘弹出/收起：球上移到键盘右上方 / 回到原位（右下角）
		addEventListener("orientationchange", refit, { passive: true });
		wake();
		if (pendingTip) tip(pendingTip);
	}
	idle(makeBall);
	// ⌘K / Ctrl+K 随时呼出或收起 Max（iPad 外接键盘、电脑）
	addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") { e.preventDefault(); ui?.island.classList.contains("open") ? close() : open(); } });

	// ---------- 提示小气泡（贴在球旁边） ----------
	function hidePeek() { peek?.classList.remove("on"); }
	function tip(text) {
		if (!text) return;
		if (!ball) return void (pendingTip = text); // 页面还在加载：等悬浮球出来再说
		pendingTip = "";
		if (ui?.island.classList.contains("open")) return;
		if (!peek) { peek = el("div", { className: "mpeek" }, logo(), el("span")); peek.onclick = (e) => { if (!ghost(e)) open(); }; document.body.append(peek); }
		peek.lastChild.textContent = text;
		const b = box(), w = Math.min(peek.offsetWidth || 240, innerWidth - 2 * M - b.width - 8);
		const x = pos.side === "l" ? b.right + 8 : b.left - 8 - w, y = b.top + (b.height - (peek.offsetHeight || 36)) / 2;
		peek.style.transform = `translate3d(${Math.max(M, x)}px,${y}px,0)`;
		peek.classList.add("on");
		wake();
		clearTimeout(tipT);
		tipT = setTimeout(hidePeek, 3800);
	}

	// ---------- 窗口（第一次用到才搭） ----------
	function build() {
		if (ui) return ui;
		const log = el("div", { className: "mlog" });
		const input = el("textarea", { rows: 1, placeholder: "问 Max…", enterKeyHint: "send", maxLength: 800 });
		const sendB = el("button", { type: "button", className: "msend", textContent: "↑", title: "发送" });
		// 发图片：拍照/相册/粘贴，压到 1280px；先给 Max 看图转成文字，再连同问题一起回答
		const pick = el("input", { type: "file", accept: "image/*", hidden: true, onchange: () => { if (pick.files[0]) attach(pick.files[0]); pick.value = ""; } });
		const picB = el("button", { type: "button", className: "mpic", title: "发图片（拍题、作答、笔记）", innerHTML: line('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 15.5l-4.5-4.5L8 19.5"/>'), onclick: () => pick.click() }, pick);
		const attBox = el("div", { className: "matt", hidden: true });
		input.addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/")); if (f) { e.preventDefault(); attach(f); } });
		const chips = el("div", { className: "mchips" });
		const tags = el("div", { className: "mtog" }, ...TAGS.map(([k, name, tip, icon]) => {
			const b = el("button", { type: "button", className: "mtag" + (tg[k] ? " on" : ""), title: tip, innerHTML: icon + `<span>${name}</span>` });
			b.setAttribute("aria-pressed", String(tg[k]));
			b.onclick = () => {
				if (k === "deep" && !tg.deep && ui?.dsOn === false) return toast("深度思考只能用 DeepSeek，现在没接上（看设置页）");
				tg[k] = !tg[k]; ss("max_tg", JSON.stringify(tg));
				b.classList.toggle("on", tg[k]); b.setAttribute("aria-pressed", String(tg[k]));
				input.placeholder = ph();
			};
			return b;
		}));
		const ph = () => (tg.deep && tg.web ? "深度思考 + 联网搜索…" : tg.deep ? "深度思考（DeepSeek）…" : tg.web ? "联网搜索…" : "问 Max…");
		input.placeholder = ph();
		const sub = el("span", { className: "msub", textContent: "能看到当前页面 · 难题找 Claude" });
		const gear = el("button", { type: "button", className: "mgear", title: "用量和设置", innerHTML: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>' });
		const set = el("div", { className: "mset" });
		gear.onclick = () => { const on = !island.classList.contains("setting"); island.classList.toggle("setting", on); gear.classList.toggle("on", on); if (on) settings(set, false); };
		const island = el("section", { className: "island" },
			el("div", { className: "mhead" }, logo(), maxWord(), sub, gear,
				el("button", { type: "button", textContent: "收起", onclick: () => close() })),
			log, chips, tags, attBox, el("div", { className: "min" }, picB, input, sendB), set);
		sendB.onclick = () => (job ? stop() : send());
		input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) { e.preventDefault(); send(); } });
		input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
		document.addEventListener("pointerdown", (e) => { if (island.classList.contains("open") && !island.contains(e.target) && !ball?.contains(e.target)) { swallow(); close(); } }, { passive: true }); // 点外面只收起，不顺带点到底下的按钮
		document.addEventListener("keydown", (e) => { if (e.key === "Escape" && island.classList.contains("open")) close(); });
		// 弹出键盘（iOS）：窗口挪进可见区域、高度跟着缩，输入框不被挡；键盘收起回到球旁边
		const vv = window.visualViewport;
		if (vv) { const fit = () => { if (island.classList.contains("open")) layout(); }; vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
		// 动作按钮：整理错题（事件委托，只挂一次）
		log.addEventListener("click", (e) => { if (e.target.closest(".mgo[data-act=org]")) orgNow(); const d = e.target.closest("button[data-do]"); if (d) act(d); });
		document.body.append(island);
		shield(island); // 窗口里的按钮（快捷问题、标签、发送）都挡住误触
		ui = { island, log, input, sendB, chips, gear, attBox };
		ui.status = () => { // 两个引擎的状态：打开窗口时才查，10 分钟内用缓存
			if (ui.statusDone) return;
			ui.statusDone = true;
			const show = (ui.show = (s) => { ui.dsOn = !!s.ds.on; sub.textContent = `Cloudflare ${s.cfu.pct}% · DeepSeek ${s.ds.on ? (s.ds.pct ?? 0) + "%" : "未接上"} · 看详情`; });
			let st = null; try { st = JSON.parse(ss("max_st") || "null"); } catch {}
			if (st && Date.now() - st.at < 600000) show(st.s);
			else api("/api/max/status").then((s) => { show(s); ss("max_st", JSON.stringify({ at: Date.now(), s })); }).catch(() => {});
		};
		return ui;
	}
	// 窗口贴着球：球在右边就右对齐，在下半屏就往上展开；transform-origin 设在球心，从球里「长」出来
	function layout() {
		const s = safe(), vv = window.visualViewport, vh = vv ? vv.height : innerHeight, vt = vv ? vv.offsetTop : 0;
		const kb = vv && vv.height < innerHeight - 80; // 键盘弹出
		const W = Math.min(innerWidth - 2 * M - s.l - s.r, innerWidth >= 744 ? 420 : 400);
		const H = Math.max(240, Math.min(kb ? vh - 16 : vh * 0.72, kb ? 9999 : 620));
		const b = box(); // 用球落定的位置（球还在弹的时候点开也不会偏）
		let x = pos.side === "l" ? b.left : b.right - W;
		x = Math.min(Math.max(x, s.l + M), innerWidth - s.r - M - W);
		let y = kb ? vt + 8 : b.top + b.height / 2 > innerHeight / 2 ? b.bottom - H : b.top;
		y = Math.min(Math.max(y, vt + s.t + 8), vt + vh - H - 8);
		const st = ui.island.style;
		st.width = W + "px"; st.height = H + "px";
		st.left = x + "px"; st.top = y + "px";
		st.transformOrigin = `${b.left + b.width / 2 - x}px ${b.top + b.height / 2 - y}px`;
	}
// ---------- 设置页（齿轮）：两个引擎今天的用量 + 几个常用开关和工具 ----------
	function settings(box, fresh) {
		const bar = (pct, warn) => el("div", { className: "mbar" + (warn ? " warn" : "") }, el("i", { style: `width:${Math.min(100, pct)}%` }));
		const n = (x) => Number(x).toLocaleString("zh-CN");
		const seg = (label, key, opts) => el("div", { className: "mrow" }, el("span", { textContent: label }),
			el("div", { className: "mseg" }, ...opts.map(([v, t]) => el("button", { type: "button", className: prefs[key] === v ? "on" : "", textContent: t,
				onclick: (e) => { prefs[key] = v; savePrefs(); for (const b of e.currentTarget.parentNode.children) b.classList.toggle("on", b === e.currentTarget); } }))));
		const tool = (t, f) => el("button", { type: "button", className: "mtool", textContent: t, onclick: async (e) => {
			const b = e.currentTarget, old = b.textContent; b.disabled = true; b.textContent = "…";
			try { const m = await f(); if (m) toast(m); } catch (err) { toast(err.message); }
			b.disabled = false; b.textContent = old;
		} });
		const usage = el("div", { className: "musage" }, el("p", { className: "mute", textContent: "正在读取用量…" }));
		box.replaceChildren(
			el("h3", { textContent: "今日用量" }), usage,
			el("h3", { textContent: "设置" }),
			seg("回答长短", "len", [["s", "简洁省额度"], ["m", "标准"], ["l", "详细"]]),
			seg("优先用", "pref", [["auto", "自动"], ["ds", "DeepSeek"], ["cf", "只用 Cloudflare"]]),
			seg("悬浮球闲置", "fade", [[0.2, "淡到 20%"], [0.5, "50%"], [1, "不变淡"]]),
			el("h3", { textContent: "工具" }),
			el("div", { className: "mtools" },
				tool("{folder}整理错题本", async () => { const r = await api("/api/max/organize", { method: "POST" }); window.dispatchEvent(new Event("max:changed")); return r.done ? `整理好 ${r.done} 道` : "都整理过了"; }),
				tool("{tag}整理分类", async () => { // 后台整理：等它的结果（和题库页的按钮一样）
					await api("/api/max/classify", { method: "POST" });
					const s = await pollUntil("/api/max/classify", (x) => x.status !== "running");
					if (!s) return "还在整理，稍后刷新页面看看";
					if (s.status === "error") return s.msg;
					window.dispatchEvent(new Event("max:changed"));
					return s.n ? `整理好 ${s.n} 个考点` : "没有新考点，不用整理";
				}),
				tool("{pulse}Kimi 自检", async () => { const r = await api("/api/max/kimi", { method: "POST" }); box.querySelector(".mkimi")?.remove(); box.querySelector(".mtools").after(el("p", { className: "mute mnote mkimi", style: "white-space:pre-wrap", textContent: "Kimi 自检：" + r.text })); return r.ai ? "发现问题，结果在下面" : "自检完成"; }),
				tool("{plug}检查 DeepSeek", async () => { settings(box, true); return ""; }),
				tool("{locate}悬浮球归位", async () => { pos = { side: "r", y: 1 }; ls(POS, JSON.stringify(pos)); snap(); return "已归位"; }),
				tool("{eraser}清空对话", async () => { stop(); hist = []; keep(); oneOff(); ui.log.replaceChildren(); hello(); quick(); return "对话已清空"; })),
			el("p", { className: "mute mnote", textContent: "Cloudflare 免费额度每天北京时间 8 点重置；用量按模型返回的 token 数折算，和 Cloudflare 后台可能略有出入。DeepSeek 每天最多用 40 万 token（防止多花钱）。" }));
		api("/api/max/status" + (fresh ? "?fresh=1" : "")).then((s) => {
			ss("max_st", JSON.stringify({ at: Date.now(), s }));
			ui.show?.(s); // 顶部小字也跟着更新
			usage.replaceChildren(
				el("div", { className: "mline" }, el("b", { textContent: "Cloudflare（主力）" }), el("span", { textContent: `${s.cfu.pct}%` })),
				bar(s.cfu.pct, s.cfu.pct >= 85),
				el("p", { className: "mute", textContent: `约 ${n(s.cfu.used)} / ${n(s.cfu.cap)} 神经元 · 调用 ${s.cfu.calls} 次${s.cfu.out ? " · 今天额度已用完" : ""}` }),
				el("div", { className: "mline" }, el("b", { textContent: "DeepSeek（备用）" }), el("span", { textContent: s.ds.on ? `${s.ds.pct}%` : "未接上" })),
				bar(s.ds.pct, s.ds.pct >= 85),
				el("p", { className: "mute", textContent: s.ds.on ? `${n(s.ds.used)} / ${n(s.ds.cap)} token · 调用 ${s.ds.calls} 次${s.ds.balance ? " · 余额 " + s.ds.balance : ""}` : `状态：${s.ds.msg}` }),
				el("p", { className: "mute", textContent: `今天和 Max 聊了 ${s.chats.used} / ${s.chats.cap} 次${s.sec ? ` · 拦截可疑访问 ${s.sec} 次` : ""}` }));
		}).catch((e) => usage.replaceChildren(el("p", { className: "mute", textContent: "读取失败：" + e.message })));
	}

	// 回答排版：转义后只认 **加粗**、动作按钮，公式交给 KaTeX
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const PAGES = { "/": "首页", "/wrong": "错题本", "/bank": "题库" };
	// Max 画的图：[[图:{JSON}]] → 用题图画板画出来（和 Claude 推题的画板同一套）。
	// 画图组件（board/circuit/fig.js）平时不加载；回答里一出现「[[图」就提前加载，写完时直接画；同一条回答只画一次
	const FIG = /\[\[图[:：]\s*(\{[\s\S]*?\})\s*\]\]/g;
	// 画图组件按需加载（同一个脚本只加载一次）
	const loaded = {};
	const need = (src, ok) => (ok() ? Promise.resolve() : (loaded[src] = loaded[src] || new Promise((res, rej) => document.head.append(el("script", { src, onload: res, onerror: () => { delete loaded[src]; rej(new Error(src)); } })))));
	const needFig = () => need("/board.js", () => typeof Board !== "undefined").then(() => need("/circuit.js", () => typeof CircuitBoard !== "undefined")).then(() => need("/fig.js", () => typeof Fig !== "undefined"));
	function paint(div, text, final) {
		text = text.replace(/\[\[清理[:：]([^\]]+)\]\]/g, "[[做:清理题库|$1]]"); // 旧历史里的写法
		const figs = [];
		text = text.replace(FIG, (_, j) => `\u0001${figs.push(j) - 1}\u0001`);
		const k = text.search(/\[\[图/); // 还没写完的图
		if (k >= 0) text = text.slice(0, k) + "\u0002";
		if (figs.length || k >= 0) needFig().catch(() => {}); // 提前加载，写完就能马上画
		const h = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s*/gm, "")
			.replace(/\[\[练[:：]([^\]|]+)(?:\|(\d+))?\]\]/g, (_, t, n) => `<a class="mgo" href="${/今日|今天/.test(t) ? "/quiz" : "/quiz?topic=" + encodeURIComponent(t.trim()) + (n ? "&n=" + Math.min(10, +n) : "")}">${ico("note")}练：${t.trim()}</a>`)
			.replace(/\[\[去[:：]\s*(\/[\w/]*)\]\]/g, (_, p) => (PAGES[p] ? `<a class="mgo" href="${p}">→ ${PAGES[p]}</a>` : ""))
			.replace(/\[\[笔记[:：]([^\]]+)\]\]/g, (_, t) => `<a class="mgo" data-note="${t.trim()}" hidden target="_blank" rel="noopener">Notion 笔记</a>`)
			.replace(/\[\[做[:：]\s*([^\]|]+)(?:\|(.*?))?\]\]/g, (_, n, a = "") => `<button type="button" class="mgo" data-do="${n.trim()}" data-arg="${a.trim()}">${ico("check")}${n.trim()}${a.trim() ? "：" + actLabel(n.trim(), a.trim()) : ""}</button>`)
			.replace(/\[\[整理错题\]\]/g, `<button type="button" class="mgo" data-act="org">${ico("folder")}让 Max 整理错题本</button>`)
			.replace(/\[\[[^\]]*$/, "") // 流式输出时半截的 [[…：先不显示
			.replace(/\u0001(\d+)\u0001/g, '<span class="mfigslot" data-i="$1">画图中…</span>').replace(/\u0002/, `<span class="mfigslot">${final ? "（图没写完，换个问法再试）" : "画图中…"}</span>`);
		div.innerHTML = h;
		if (final && figs.length) needFig().then(() => {
			for (const s of div.querySelectorAll(".mfigslot[data-i]")) { const spec = Fig.parse(figs[+s.dataset.i]), f = spec && Fig.view(spec, "chat"); f ? s.replaceWith(f) : (s.textContent = "（这张图没画出来）"); }
			scroll();
		}, () => div.querySelectorAll(".mfigslot").forEach((s) => (s.textContent = "（画图组件没加载上）")));
		if (final) try { math(div); } catch {}
		if (final) for (const a of div.querySelectorAll("a[data-note]")) // 去 Notion 找同考点笔记，找到才显示
			api("/api/notion?subject=" + encodeURIComponent(a.dataset.note.includes("/") ? a.dataset.note.split("/")[0] : "") + "&topic=" + encodeURIComponent(a.dataset.note.split("/").pop())).then((r) => { if (r?.note) { a.href = r.note.url; a.textContent = "Notion 笔记：" + r.note.title; a.hidden = false; } }).catch(() => {});
	}
	const scroll = () => { ui.log.scrollTop = ui.log.scrollHeight; };
	function bubble(role, text) {
		const d = el("div", { className: "mb " + role });
		paint(d, text, true);
		ui.log.append(d);
		scroll();
		return d;
	}
	function thinking(text = "思考中") { // 思考中：一个会动的标志，代替文字
		const d = el("div", { className: "mb assistant thinking" }, logo("big"), el("span", { textContent: text }));
		ui.log.append(d);
		scroll();
		return d;
	}
	function hello() {
		if (!hist.length) bubble("assistant", ctx.q ? "我是 Max。卡住了问我要提示（不会直接给答案）。" : "我是 Max，管错题本的助手。可以让我总结这页、整理错题、安排今天先做什么，或者讲一道做错的题。");
	}
	function quick() { // 按页面给几个常用问题
		const more = hist.length && hist[hist.length - 1].role === "assistant" ? ["没懂，再讲详细点"] : []; // 「没懂」会交给 DeepSeek
		const list = ctx.q ? [...more, "给我一点提示", "这题考什么？"] : ctx.a ? [...more, "讲讲这道题", "类似的易错点？"]
			: location.pathname === "/wrong" ? [...more, "总结这页的错题", "整理错题本", "最该先补哪块？"]
			: [...more, "总结这页", "今天先做什么？", "我的薄弱点？"];
		ui.chips.replaceChildren(...list.map((t) => el("button", { type: "button", textContent: t, onclick: () => (t === "整理错题本" ? orgNow() : send(t)) })));
	}
	function open(c, text) {
		build();
		quiet();
		if (c) { ctx = c; prefetch(c); }
		hidePeek();
		layout();
		ui.island.classList.add("open");
		ui.status();
		ball?.classList.add("hide");
		if (!ui.log.childElementCount) { hist.forEach((m) => bubble(m.role, m.shown ?? m.content)); hello(); }
		quick();
		requestAnimationFrame(scroll);
		if (text) send(text, c || {});
	}
	// 一键讲解用完：留住「刚才那道题」（作答 id），追问「那第二步呢」时 Max 还知道是哪题；解析标记的题用完回到页面本来的上下文
	// 页面自己有「当前这题」（做题页）就回到页面的题，不然会拿刚讲过的旧题顶掉正在做的题
	const oneOff = () => { if (ctx.explain && !(base.q || base.a || base.tmp)) ctx = { ...base, a: ctx.explain }; else if (ctx.explain || ctx.marked) ctx = base; };
	// 当前在看哪道题（换题了就不把上一题的聊天发过去，免得 Max 接着讲上一题）
	const topicKey = (c) => (c.qid ? "q" + c.qid : c.q ? "q" + c.q : c.explain ? "a" + c.explain : c.a ? "a" + c.a : c.tmp ? "t" + String(c.tmp.stem).slice(0, 30) : "");
	function close() { // 窗口缩回球里，球重新出现
		if (!ui) return;
		quiet();
		oneOff();
		if (ball) layout(); // 球可能被拖过：缩回去的方向跟着球
		ui.island.classList.remove("open", "setting");
		ui.gear.classList.remove("on");
		ui.input.blur();
		ball?.classList.remove("hide");
		wake();
	}
	// 当前页面内容：Max 的「眼睛」（只取主区域文字，最多 1500 字；只在发问时读一次）
	const PAGE_RE = /页|这|总结|分析|看看|上面|屏幕|错题|列表|哪/;
	const page = () => ({ path: location.pathname, title: document.title, text: (document.querySelector("main")?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 1500) });

	function stop() { if (job) job.abort(); }
	function lock(on) {
		ui.sendB.textContent = on ? "■" : "↑";
		ui.sendB.title = on ? "停止" : "发送";
		ui.sendB.classList.toggle("stop", on);
		setBusy(on);
	}

	async function orgNow() {
		if (job) return;
		build();
		const out = thinking();
		lock(true);
		job = new AbortController();
		try {
			const r = await api("/api/max/organize", { method: "POST", signal: job.signal });
			paint(out, r.done ? `整理好 ${r.done} 道错题（错因 + 一句话诊断）${r.left ? `，还剩 ${r.left} 道，再点一次继续` : "，全部整理完了"}。` : "错题本都整理过了", true);
			window.dispatchEvent(new Event("max:changed"));
		} catch (e) { paint(out, e.name === "AbortError" ? "已停止" : e.message, true); }
		finally { out.classList.remove("thinking"); job = null; lock(false); }
	}

	// 按钮上的说明：JSON 条件组读成人话，其它参数照原样
	function actLabel(name, arg) {
		const raw = arg.replace(/&quot;/g, '"').replace(/&amp;/g, "&"); // 文本已转义过，先还原再读
		if (!raw.startsWith("{")) return arg.replace(/\|/g, " ");
		try {
			const j = JSON.parse(raw);
			return (j.groups || [j]).map((g) => [g.subject, g.topic, g.tags && "题型" + g.tags.replace(/,/g, "、"), g.pending && "待批改", g.undone && "没做过", g.done && "做过"].filter(Boolean).join("·")).join("；");
		} catch { return "（条件看不懂）"; }
	}
	// Max 给的网站动作（[[做:…]]）：先数一数、弹确认，确认才做；做完刷新题库/错题本/首页
	async function act(b) {
		if (b.disabled) return;
		b.disabled = true;
		const post = (dry) => api("/api/max/do", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: b.dataset.do, arg: b.dataset.arg, dry }) });
		try {
			const r = await post(true);
			if (r.empty) return toast(r.msg);
			if (!confirm(r.msg + "\n确定执行吗？")) return;
			const f = await post(false);
			lab(b, "{check}" + f.msg); b.classList.add("done");
			window.dispatchEvent(new Event("max:changed"));
		} catch (e) { toast(e.message); }
		finally { if (!b.classList.contains("done")) b.disabled = false; }
	}
	// 选好的图片：压缩后显示在输入框上方（可删）
	async function attach(file) {
		build();
		if (!file.type.startsWith("image/")) return toast("只能发图片");
		const f = await compress(file, 1280);
		att = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(f); });
		showAtt();
		ui.input.focus();
	}
	function showAtt() {
		const b = ui.attBox;
		b.hidden = !att;
		b.replaceChildren(...(att ? [el("img", { src: att, alt: "" }), el("span", { textContent: "发送时 Max 会先看图" }), el("button", { type: "button", textContent: "×", title: "不发这张", onclick: () => { att = null; showAtt(); } })] : []));
	}

	// 换题时提前取这题的小卡片（见 /api/max/prep）；问「考什么 / 答案 / 解析」就直接答，不叫模型、不花额度
	let prep = { k: "", v: null, p: null };
	function prefetch(c) {
		const k = topicKey(c), url = c.a ? "/api/max/prep?a=" + c.a : c.q ? "/api/max/prep?q=" + c.q : "";
		if (!url || (prep.k === k && (!c.a || prep.v?.done))) return; // 交了还没批完的：批完再取一次（才有答案）
		prep = { k, v: null, p: api(url).then((v) => { if (prep.k === k) prep.v = v; return v; }).catch(() => null) };
	}
	function local(text, c) { // 能用题目自带信息答的就本地答
		const v = prep.k === topicKey(c) ? prep.v : null;
		if (!v || c.explain || c.marked) return "";
		if (/考什么|考点|知识点|哪一?章|什么题型/.test(text) && v.topic) return `这题考「${v.topic}」${v.category ? `（${v.category}）` : ""}${v.tag ? "，题型：" + v.tag : ""}。`;
		if (v.done && /^(答案|正确答案|看答案|答案是什么|解析|看解析|这题的?解析)[？?。！!]*$/.test(text.trim()) && (v.ans?.length || v.exp))
			return `正确答案：${v.ans.join(" / ")}${v.exp ? "\n\n解析：" + v.exp : ""}`;
		return "";
	}

	async function send(text = ui.input.value.trim(), extra = {}, img = att) {
		build();
		if (!text && !img) return;
		if (job) return void toast("Max 还在回答，等它说完或点 ■ 停止");
		text = text || "看看这张图，帮我讲讲";
		if (img && img === att) { att = null; showAtt(); }
		ui.input.value = ""; ui.input.style.height = "";
		hist.push({ role: "user", content: text, k: topicKey({ ...ctx, ...extra }), ...(img ? { shown: text + "［图片］" } : {}) });
		const ub = bubble("user", text);
		const quickAns = !img && local(text, { ...ctx, ...extra });
		if (quickAns) { // 本地直接答：秒回、不花额度
			const out = bubble("assistant", quickAns);
			out.append(el("div", { className: "meng", textContent: "题目自带信息（没花额度）" }));
			hist.push({ role: "assistant", content: quickAns }); keep(); quick();
			return;
		}
		if (img) ub.prepend(el("img", { className: "mimg", src: img, alt: "", onclick: () => { const z = el("div", { className: "figzoom", onclick: () => z.remove() }, el("img", { src: img, alt: "" })); document.body.append(z); } })); // 点开看大图
		const deep = tg.deep, web = tg.web; // 发出时的开关状态
		const out = thinking(deep ? "深度思考中" : web ? "搜索并思考中" : "思考中");
		let all = "", ok = false, eng = "", webN = null, timedOut = false, last = 0, tm = 0, t = 0;
		job = new AbortController();
		// 超时按「多久没动静」算，不按总时长：正在输出的长回答不会被半路掐断；卡住才停
		const ctl = job, arm = (ms) => { clearTimeout(t); t = setTimeout(() => { timedOut = true; ctl.abort(); }, ms); };
		const FIRST = deep ? 150000 : 60000; // 等第一个字：深度思考要先想很久
		arm(img ? 100000 : FIRST); // 看图最多试两个模型
		lock(true);
		try {
			if (img) { // 先看图：转写成文字放进这句话里（之后追问也带着）
				out.lastChild.textContent = "看图中";
				const s = await fetch("/api/max/see", { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal, body: JSON.stringify({ image: img, q: text }) });
				if (s.status === 401) return void (location.href = "/login");
				const j = await s.json().catch(() => ({}));
				if (!s.ok) throw new Error(j.error || "看图失败（" + s.status + "）");
				hist[hist.length - 1].content = text + "\n【图片内容】" + j.text;
				out.lastChild.textContent = deep ? "深度思考中" : web ? "搜索并思考中" : "思考中";
				arm(FIRST);
			}
			const one = extra.explain || extra.marked; // 一键讲解只发这一句：命中缓存不花额度
			// 只发服务器会用的：旧回答服务器只看开头 300 字，这里先截好，少传
			// 只发「同一道题」的这段对话：往前找到换题的地方就停
			const k = hist[hist.length - 1].k;
			let from = hist.length - 1;
			if (k) while (from > 0 && (hist[from - 1].role === "assistant" ? from - 2 >= 0 && hist[from - 2].k === k : hist[from - 1].k === k)) from--;
			const msgs = (one ? hist.slice(-1) : hist.slice(Math.max(from, hist.length - 6))).map((m) => ({ role: m.role, content: m.role === "assistant" ? m.content.slice(0, 300) : m.content.slice(0, 800) }));
			const r = await fetch("/api/max/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
				body: JSON.stringify({ messages: msgs, ctx: { ...ctx, ...extra, len: prefs.len, pref: prefs.pref, deep, web, page: one || !PAGE_RE.test(text) ? undefined : page() } }) });
			if (r.status === 401) return void (location.href = "/login");
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "服务器开小差了（" + r.status + "）");
			eng = r.headers.get("x-max-engine") || "";
			webN = r.headers.get("x-max-web");
			const draw = () => { // 边生成边显示：最多 80ms 画一次；你往上翻着看时不强行拉到底
				tm = 0; last = Date.now();
				const near = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 60;
				out.classList.remove("thinking"); paint(out, all, false);
				if (near) scroll();
			};
			if (r.body?.getReader) {
				const rd = r.body.getReader(), dec = new TextDecoder();
				for (;;) {
					const { done, value } = await rd.read();
					if (done) break;
					arm(30000); // 输出中途 30 秒没新字：算卡住
					all += dec.decode(value, { stream: true });
					if (!tm) tm = setTimeout(draw, Math.max(0, 80 - (Date.now() - last)));
				}
				all += dec.decode(); // 收尾：别丢最后半个字
			} else all = await r.text();
			ok = true;
		} catch (e) {
			const why = ctl.signal.aborted ? (timedOut ? "Max 太久没回应，已停止" : "已停止") : /fetch|network|load failed/i.test(e.message) ? "网络断了，检查一下再试" : e.message;
			all = all.trim() ? all + "\n\n" + why : why;
		} finally {
			clearTimeout(t); clearTimeout(tm);
			out.classList.remove("thinking");
			all = all.trim() || "（Max 没说话，换个问法试试）";
			paint(out, all, true);
			if (ok) {
				hist.push({ role: "assistant", content: all }); keep();
				const by = { cf: "Cloudflare 回答", ds: deep ? "DeepSeek 深度思考" : "DeepSeek 回答", cache: "之前讲过（没花额度）" }[eng];
				if (by) out.append(el("div", { className: "meng", textContent: by + (webN == null ? "" : webN === "0" ? " · 联网没搜到" : ` · 联网 ${webN} 条`) }));
				quick(); // 出现「没懂，再讲详细点」
			}
			else { // 失败的问题不留在上下文里；重试时把这一问一答撤掉重来，不重复
				hist.pop();
				out.append(el("button", { type: "button", className: "mgo", textContent: "↻ 重试", onclick: () => { if (job) return; ub.remove(); out.remove(); send(text, extra, img); } }));
			}
			job = null;
			lock(false);
			scroll();
		}
	}

	return {
		logo, // 首页标题的小太阳用同一个标志（和思考时一样会动）
		setCtx(c) { ctx = base = c || {}; prefetch(ctx); if (ui?.island.classList.contains("open")) quick(); },
		open,
		tip,
		busy: setBusy, // Max 在后台干活（出题、整理）时让悬浮球也转起来
	};
})();
