// 作图板：方格常驻、格点吸附、几何/函数作图。图形坐标以「格」为单位，原点在画板中心附近的格点。
// 计算板也用它（new Board({ calc: true })）：只留手写类工具 + 算式自动出得数，横线纸。
// 物理光学/力学板（new Board({ phys: true })）：力、光线、法线、平面镜、透镜，自动算入射角/反射角。
// 交卷时 describe() 生成文字描述 + 几何信息，配一张 600px 小图一起发给 Claude（准确且省用量）。

const TOOLS = [
	["seg", "／线段", "拖动画线段，两端吸附格点"],
	["line", "⟷直线", "拖出两点，自动延长到边缘"],
	["ray", "↗射线", "从端点拖向方向，延长到边缘"],
	["circle", "◯圆", "从圆心拖到圆上一点"],
	["poly", "△多边形", "依次点顶点，点回起点或按「完成」"],
	["curve", "∿曲线", "依次点经过的点，按「完成」连成平滑曲线"],
	["point", "⊙标点", "点一下放点：起名并自动标坐标，如 A(1,-4)"],
	["text", "T文字", "点一下，在那里打字"],
	["perp", "⊥垂线", "先点一个点，再点一条线"],
	["para", "∥平行线", "先点一条线，再点一个点"],
	["pen", "✏️画笔", "自由手绘"],
	["calc", "＝算式", "点一下写算式出得数；方程、方程组（逗号隔开）、不等式自动解"],
	["erase", "⌫橡皮", "点或划过删除"],
	["force", "➚力", "从作用点拖向力的方向，松手起名（F、G、F浮…）"],
	["light", "⇢光线", "沿光的传播方向拖动，中间自动画箭头"],
	["normal", "┆法线", "拖动画法线（自动虚线）"],
	["mirror", "▨平面镜", "拖动画镜面：从左往右拖斜线在下方，反着拖换一面"],
	["lens", "⇕凸透镜", "拖动画凸透镜（一般竖着拖）"],
	["lens2", "⇳凹透镜", "拖动画凹透镜"],
];
const CALC_TOOLS = ["pen", "calc", "text", "erase"];
const PHYS_TOOLS = ["force", "light", "normal", "mirror", "lens", "lens2", "seg", "perp", "point", "text", "pen", "erase"];
const SEGS = ["seg", "force", "light", "normal", "mirror", "lens", "lens2"]; // 按线段参与命中、垂线、交点
const PHYS_NAME = { force: "力", light: "光线", normal: "法线", mirror: "平面镜", lens: "凸透镜", lens2: "凹透镜" };
const COLORS = ["#111111", "#d64545", "#2f6fed"];
const CELL = 24; // 格距

// ---------- 函数解析：+ - * / ^ ( ) | |、隐式乘法、sqrt sin cos tan abs ln log、pi e ----------
function compileFn(src) {
	const s = src.replace(/\s+/g, "").replace(/^y=/i, "").replace(/（/g, "(").replace(/）/g, ")").replace(/×/g, "*")
		.replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/²/g, "^2").replace(/³/g, "^3").replace(/√(\d+\.?\d*|[a-z]|π)/gi, "√($1)").replace(/√/g, "sqrt").replace(/π/g, "pi");
	const t = s.match(/\d+\.?\d*|\.\d+|[a-z]+|[-+*/^()|]/gi);
	if (!t || t.join("") !== s) throw new Error("看不懂这个式子");
	const FN = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, ln: Math.log, log: Math.log10 };
	let i = 0;
	const need = (c, msg) => { if (t[i++] !== c) throw new Error(msg); };
	const sum = () => { let f = prod(); while (t[i] === "+" || t[i] === "-") { const a = f, b = (t[i++] === "+" ? 1 : -1), g = prod(); f = (x) => a(x) + b * g(x); } return f; };
	const prod = () => {
		let f = neg();
		while (t[i] === "*" || t[i] === "/" || (t[i] && /^[\d.a-z(]/i.test(t[i]))) {
			const div = t[i] === "/"; if (t[i] === "*" || div) i++;
			const a = f, g = neg(); f = div ? (x) => a(x) / g(x) : (x) => a(x) * g(x);
		}
		return f;
	};
	const neg = () => { if (t[i] === "-") { i++; const g = neg(); return (x) => -g(x); } if (t[i] === "+") { i++; return neg(); } return pow(); };
	const pow = () => { const b = atom(); if (t[i] !== "^") return b; i++; const e = neg(); return (x) => Math.pow(b(x), e(x)); };
	const atom = () => {
		const w = (t[i++] || "").toLowerCase();
		if (!w) throw new Error("式子不完整");
		if (/^[\d.]/.test(w)) { const v = +w; return () => v; }
		if (w === "(") { const f = sum(); need(")", "括号不配对"); return f; }
		if (w === "|") { const f = sum(); need("|", "绝对值不配对"); return (x) => Math.abs(f(x)); }
		if (w === "x") return (x) => x;
		if (w === "pi" || w === "e") { const v = w === "e" ? Math.E : Math.PI; return () => v; }
		if (!FN[w]) throw new Error("不认识：" + w);
		need("(", w + " 后面要加括号"); const f = sum(); need(")", "括号不配对");
		return (x) => FN[w](f(x));
	};
	const f = sum();
	if (i < t.length) throw new Error("多余的：" + t.slice(i).join(""));
	return f;
}

// ---------- 算式出得数：分数、根式化简（初中范围），方程在 [-100,100] 内找根 ----------
function nice(v) {
	if (!Number.isFinite(v)) return "无意义";
	const r = (n, d) => Math.abs(v * d - n) < 1e-9 * Math.max(1, Math.abs(v * d));
	const n0 = Math.round(v);
	if (r(n0, 1)) return String(n0);
	for (let d = 2; d <= 1000; d++) { const n = Math.round(v * d); if (r(n, d)) return `${n}/${d}`; }
	for (const b of [2, 3, 5, 6, 7, 10, 11, 13, 14, 15]) for (let d = 1; d <= 12; d++) { // a√b/d
		const a = Math.round((v * d) / Math.sqrt(b));
		if (a && Math.abs((a * Math.sqrt(b)) / d - v) < 1e-9) return `${a === 1 ? "" : a === -1 ? "-" : a}√${b}${d > 1 ? "/" + d : ""}`;
	}
	return String(+v.toPrecision(6));
}
// 方程为主：一元方程（含二次，附判别式）、二元一次方程组（逗号隔开）、一元一次不等式；没有未知数就直接算
function calcText(s) {
	s = s.trim();
	try {
		const memo = new Map(), fy = (src, y) => { const k = src + "|" + y; if (!memo.has(k)) memo.set(k, compileFn(src.replace(/y/gi, `(${y})`))); return memo.get(k); }; // y 代成数再按 x 算；编译结果缓存
		const G = (eq) => { const [L, R] = eq.split("="); return (x, y = 0) => fy(L, y)(x) - fy(R, y)(x); };
		const lin = (g) => { const c = g(0, 0), a = g(1, 0) - c, b = g(0, 1) - c; return Math.abs(g(2, 3) - (2 * a + 3 * b + c)) < 1e-9 ? [a, b, c] : null; };
		const eqs = s.split(/[;；,，]/).filter((e) => e.trim());
		if (/y/i.test(s) && eqs.length !== 2) return s; // 如 y=2x+1 是函数式，不解
		if (eqs.length === 2 && /y/i.test(s)) { // 二元一次方程组：克拉默法则
			const [p, q] = eqs.map((e) => lin(G(e)));
			if (!p || !q) return `${s} → 只会解二元一次方程组`;
			const D = p[0] * q[1] - q[0] * p[1];
			return `${s} → ${Math.abs(D) < 1e-12 ? "无解或有无数组解" : `x=${nice((p[1] * q[2] - q[1] * p[2]) / D)}，y=${nice((p[2] * q[0] - p[0] * q[2]) / D)}`}`;
		}
		const iq = s.match(/^([^<>≤≥]*)(>=|<=|≥|≤|>|<)([^<>≤≥]*)$/);
		if (iq && /x/i.test(s)) { // 一元一次不等式：系数为负要变号
			const L = lin(G(iq[1] + "=" + iq[3]));
			if (!L) return `${s} → 只会解一元一次不等式`;
			const [a, , c] = L, op = { ">=": "≥", "<=": "≤" }[iq[2]] ?? iq[2], flip = { ">": "<", "<": ">", "≥": "≤", "≤": "≥" };
			if (Math.abs(a) < 1e-12) return `${s} → ${({ ">": c > 0, "<": c < 0, "≥": c >= 0, "≤": c <= 0 })[op] ? "任意数" : "无解"}`;
			return `${s} → x${a > 0 ? op : flip[op]}${nice(-c / a)}`;
		}
		const [L, R, extra] = s.split("=");
		if (extra !== undefined) return s;
		if (R === undefined || !R.trim()) return `${L.replace(/=$/, "")} = ${nice(compileFn(L)(0))}`;
		if (!/x/i.test(s)) return s;
		const g = G(s), f = (x) => g(x), roots = [];
		for (let x = -100, p = NaN, a = f(x); x < 100; x += 0.01) { // 扫描变号再二分；不变号的重根看 |f| 的极小值
			const b = f(x + 0.01);
			if (Math.abs(a) <= Math.abs(p) && Math.abs(a) <= Math.abs(b) && a * b >= 0) {
				let lo = x - 0.01, hi = x + 0.01;
				for (let i = 0; i < 60; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; Math.abs(f(m1)) < Math.abs(f(m2)) ? (hi = m2) : (lo = m1); }
				if (Math.abs(f(lo)) < 1e-8) roots.push(lo);
			} else if (a * b < 0 && Number.isFinite(a) && Number.isFinite(b)) {
				let lo = x, hi = x + 0.01;
				for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; f(lo) * f(m) <= 0 ? (hi = m) : (lo = m); }
				if (Math.abs(f(lo)) < 1e-6) roots.push(lo);
			}
			p = a; a = b;
		}
		const c = f(0), a2 = (f(1) + f(-1)) / 2 - c, b2 = (f(1) - f(-1)) / 2; // 二次方程附判别式
		const quad = Math.abs(a2) > 1e-12 && [2, 3, -4].every((x) => Math.abs(f(x) - (a2 * x * x + b2 * x + c)) < 1e-9);
		const out = [...new Set(roots.map(nice))];
		return `${s} → ${out.length ? out.map((v) => "x=" + v).join("，") : "无实数解"}${quad ? `（Δ=${nice(b2 * b2 - 4 * a2 * c)}）` : ""}`;
	} catch { return s; }
}

// ---------- 几何（单位：格） ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
function proj(p, a, b, kind) { // 点到线段/射线/直线上最近点
	const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
	let k = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L;
	if (kind === "seg") k = Math.min(1, Math.max(0, k));
	if (kind === "ray") k = Math.max(0, k);
	return lerp(a, b, k);
}
const num = (v) => String(Math.round(v * 10) / 10 || 0);
const xy = (p) => `(${num(p[0])},${num(p[1])})`;
const edges = (o) => (o.t === "poly" ? o.pts.map((q, i) => [q, o.pts[(i + 1) % o.pts.length], "seg"]) : ["line", "ray"].includes(o.t) ? [[o.a, o.b, o.t]] : SEGS.includes(o.t) ? [[o.a, o.b, "seg"]] : []);

class Board {
	constructor({ axes = false, calc = false, phys = false } = {}) {
		Object.assign(this, { axes, calc, phys, objs: [], hist: [], fut: [], tool: calc ? "pen" : phys ? "force" : "seg", color: COLORS[0], width: 2, dash: false, snap: true, big: false, fns: new Map() });
		const only = (ks) => ks.map((k) => TOOLS.find((t) => t[0] === k));
		this.tools = calc ? only(CALC_TOOLS) : phys ? only(PHYS_TOOLS) : TOOLS.filter(([k]) => k !== "calc" && !PHYS_NAME[k]);
		this.cv = el("canvas");
		this.wrap = el("div", { className: "bwrap" }, this.cv);
		this.bar1 = el("div", { className: "btools" });
		this.bar2 = el("div", { className: "btools" });
		this.hint = el("div", { className: "bhint" });
		// 工具区放进 slot：往下滑到画板时，做题页把它变成底部悬浮的「工具岛」（slot 留住原高度，版面不跳）
		this.slot = el("div", { className: "slot" }, el("div", { className: "dock" }, this.bar1, this.bar2, this.hint));
		this.el = el("div", { className: "board" }, this.slot, this.wrap);
		this.ctx = this.cv.getContext("2d");
		this.bind();
		this.build();
		new ResizeObserver(() => this.resize()).observe(this.wrap);
		document.fonts?.ready.then(() => this.draw()); // 文楷字体到了再画一遍
	}
	isEmpty() { return !this.objs.length; }
	hasPen() { return this.objs.some((o) => o.t === "pen"); }

	// ---------- 坐标 ----------
	resize() {
		const W = this.wrap.clientWidth, H = this.wrap.clientHeight, dpr = DPR();
		if (!W || !H) return;
		Object.assign(this, { W, H, ox: Math.round(W / 2 / CELL) * CELL, oy: Math.round(H / 2 / CELL) * CELL });
		this.cv.width = W * dpr; this.cv.height = H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}
	px(q) { return [this.ox + q[0] * CELL, this.oy - q[1] * CELL]; }
	at(e) { // 返回 [吸附后的点, 原始点]
		const r = this.cv.getBoundingClientRect();
		const raw = [(e.clientX - r.left - this.ox) / CELL, (this.oy - (e.clientY - r.top)) / CELL];
		return [this.snap && this.tool !== "pen" ? raw.map(Math.round) : raw, raw];
	}

	// ---------- 历史 ----------
	change(fn) { this.hist.push(JSON.stringify(this.objs)); this.fut = []; fn(); this.draw(); }
	sty() { return { c: this.color, w: this.width, d: this.dash }; }
	add(o) { this.change(() => this.objs.push({ ...this.sty(), ...o })); }
	step(from, to) { if (this.pend) return this.reset(); if (!from.length) return; to.push(JSON.stringify(this.objs)); this.objs = JSON.parse(from.pop()); this.draw(); }
	reset() { this.pend = null; this.build(); this.draw(); }

	// ---------- 交互：拖动类按住拖；点选类抬手时才落点（可边按边调整位置） ----------
	bind() {
		const cv = this.cv;
		guardCanvas(cv); // 先挂：防选中/放大、防多指和手掌误触
		cv.addEventListener("abortstroke", () => { this.drag = this.tap = null; this.rub = false; this.draw(); }); // 误触：这一笔作废
		cv.addEventListener("pointerdown", (e) => {
			if (!e.isPrimary) return;
			cv.setPointerCapture(e.pointerId);
			const [p, raw] = this.at(e), t = this.tool;
			if (t === "erase") { this.rub = true; return this.rubAt(raw); }
			if (t === "pen") this.drag = { t, pts: [raw] };
			else if (["line", "ray", "circle", ...SEGS].includes(t)) this.drag = { t, a: p, b: p };
			else this.tap = [p, raw];
			this.draw();
		});
		cv.addEventListener("pointermove", (e) => {
			const [p, raw] = this.at(e);
			if (this.rub) return this.rubAt(raw);
			if (this.drag?.t === "pen") { // 手写：取齐浏览器合并掉的中间点（快写也顺），太近的点不要（去抖）
				const pts = this.drag.pts;
				for (const ev of e.getCoalescedEvents?.() || [e]) { const r = this.at(ev)[1]; if (dist(r, pts[pts.length - 1]) > 0.04) pts.push(r); }
			} else if (this.drag) this.drag.b = p;
			else if (this.tap) this.tap = [p, raw];
			else this.hover = e.pointerType === "mouse" ? p : null;
			this.draw();
		});
		const up = () => {
			const d = this.drag, tp = this.tap;
			this.drag = this.tap = null; this.rub = false;
			if (d?.t === "force" && dist(d.a, d.b) > 0.01) { // 力：松手起名
				const used = new Set(this.objs.map((o) => o.name));
				this.ask(d.b, ["F", "G", "F1", "F2", "f", "F浮", "F支"].find((n) => !used.has(n)) || "F", (name) => this.add({ ...d, name }));
			} else if (d && (d.t === "pen" ? d.pts.length > 1 : dist(d.a, d.b) > 0.01)) this.add(d);
			else if (tp) this.act(...tp);
			else this.draw();
		};
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointercancel", up);
		cv.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
	}

	rubAt(raw) { const i = this.hit(raw); if (i >= 0) this.change(() => this.objs.splice(i, 1)); }
	act(p, raw) {
		const t = this.tool, pd = this.pend;
		if (t === "poly" || t === "curve") {
			if (pd && t === "poly" && pd.pts.length > 2 && dist(p, pd.pts[0]) < 0.4) return this.finish();
			pd ? pd.pts.push(p) : ((this.pend = { pts: [p] }), this.build());
		} else if (t === "point") {
			// 起名 + 坐标一起标；点在已有的点上就是改名
			const i = this.objs.findIndex((o) => o.t === "pt" && dist(o.p, p) < 0.01);
			const used = new Set(this.objs.map((o) => o.name));
			const def = i >= 0 ? this.objs[i].name : [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((c) => !used.has(c)) || "";
			this.ask(p, def, (name) => (i >= 0 ? this.change(() => (this.objs[i].name = name)) : this.add({ t: "pt", p, name })));
		} else if (t === "text") this.ask(p, "", (s) => s && this.add({ t: "text", p, s }));
		else if (t === "calc") this.ask(p, "", (s) => s && this.add({ t: "text", p, s: calcText(s) }));
		else if (t === "perp") {
			if (!pd) { this.pend = { p }; this.build(); return this.draw(); }
			const L = this.lineAt(raw);
			if (!L) return alert("请点在一条线上");
			const F = proj(pd.p, L[0], L[1], "line");
			this.pend = null; this.build();
			if (dist(pd.p, F) < 0.01) return alert("点在线上，换一个点");
			const u = [L[1][0] - L[0][0], L[1][1] - L[0][1]], v = [pd.p[0] - F[0], pd.p[1] - F[1]], lu = Math.hypot(...u), lv = Math.hypot(...v);
			this.change(() => this.objs.push(
				{ ...this.sty(), t: "seg", a: pd.p, b: F },
				{ ...this.sty(), d: false, t: "ra", at: F, u: [u[0] / lu, u[1] / lu], v: [v[0] / lv, v[1] / lv] }));
		} else if (t === "para") {
			if (!pd) { const L = this.lineAt(raw); if (!L) return alert("先点在一条线上"); this.pend = { dir: [L[1][0] - L[0][0], L[1][1] - L[0][1]] }; return this.build(); }
			this.pend = null; this.build();
			this.add({ t: "line", a: p, b: [p[0] + pd.dir[0], p[1] + pd.dir[1]] });
		}
		this.draw();
	}
	finish() { const pd = this.pend; this.pend = null; this.build(); pd?.pts.length > 1 ? this.add({ t: this.tool, pts: pd.pts }) : this.draw(); }

	// 在画板上直接打字
	ask(p, def, done) {
		this.wrap.querySelector("input")?.blur();
		const [x, y] = this.px(p);
		const inp = el("input", { type: "text", value: def, className: "btext", style: `left:${Math.min(x, this.W - 120)}px;top:${Math.max(0, y - 30)}px` });
		let ok = true;
		const close = () => { if (!inp.isConnected) return; const v = inp.value.trim(); inp.remove(); if (ok) done(v); else this.draw(); };
		inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { ok = false; inp.blur(); } };
		inp.onblur = close;
		this.wrap.append(inp);
		setTimeout(() => { inp.focus(); inp.select(); });
	}

	plot() {
		const s = prompt("函数解析式，例如：\ny = x^2 - 2x - 3\ny = 2x + 1\ny = 6/x\ny = sqrt(x)", "y = ");
		if (!s || !s.replace(/^\s*y\s*=/i, "").trim()) return;
		try { compileFn(s); } catch (err) { return alert(err.message); }
		if (!this.axes) { this.axes = true; this.build(); }
		this.add({ t: "fn", expr: "y = " + s.replace(/^\s*y\s*=\s*/i, "").trim() });
	}
	fn(expr) { if (!this.fns.has(expr)) { try { this.fns.set(expr, compileFn(expr)); } catch { this.fns.set(expr, null); } } return this.fns.get(expr); }

	// ---------- 命中 ----------
	hit(p) {
		let best = -1, bd = 0.5;
		this.objs.forEach((o, i) => { const d = this.distTo(o, p); if (d < bd) { bd = d; best = i; } });
		return best;
	}
	distTo(o, p) {
		const E = edges(o);
		if (E.length) return Math.min(...E.map(([a, b, k]) => dist(p, proj(p, a, b, k))));
		if (o.t === "circle") return Math.abs(dist(p, o.a) - dist(o.a, o.b));
		if (o.pts) return Math.min(...o.pts.map((q, i) => dist(p, i ? proj(p, o.pts[i - 1], q, "seg") : q)));
		if (o.t === "fn") { const y = this.fn(o.expr)?.(p[0]); return Number.isFinite(y) ? Math.abs(y - p[1]) : 9; }
		return dist(p, o.p || o.at);
	}
	lineAt(p) {
		let best = null, bd = 0.6;
		for (const o of this.objs) for (const [a, b, k] of edges(o)) { const d = dist(p, proj(p, a, b, k)); if (d < bd) { bd = d; best = [a, b]; } }
		return best;
	}

	// ---------- 绘制 ----------
	draw() { // 每帧最多重绘一次，拖动更跟手
		if (this.W && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(this.ctx, true); });
	}
	paint(c, live) {
		const { W, H, ox, oy } = this;
		c.fillStyle = "#fff"; c.fillRect(0, 0, W, H);
		c.lineWidth = 1; c.strokeStyle = "#e3e6ec"; c.setLineDash([]);
		c.beginPath();
		if (!this.calc) for (let x = ox % CELL; x <= W; x += CELL) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); } // 计算板只画横线
		for (let y = oy % CELL; y <= H; y += CELL) { c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); }
		c.stroke();
		if (this.axes) this.paintAxes(c);
		const style = this.sty();
		const list = [...this.objs];
		if (live && this.drag) list.push({ ...style, ...this.drag });
		if (live && this.pend?.pts) list.push({ ...style, t: this.tool === "poly" ? "open" : "curve", pts: this.tap ? [...this.pend.pts, this.tap[0]] : this.pend.pts });
		for (const o of list) this.obj(c, o);
		if (!live) return;
		for (const q of this.pend?.pts || (this.pend?.p ? [this.pend.p] : [])) this.dot(c, this.px(q), 3.5, "#d64545");
		const cur = this.drag && this.drag.t !== "pen" ? this.drag.b : this.tap ? this.tap[0] : this.hover;
		if (this.drag?.a) this.ring(c, this.px(this.drag.a));
		if (cur) this.guide(c, cur);
	}
	ring(c, [x, y]) { c.setLineDash([]); c.strokeStyle = "#2f6fed"; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke(); this.dot(c, [x, y], 2.5, "#2f6fed"); }
	// 当前落点：十字辅助线 + 手指上方的坐标气泡
	guide(c, q) {
		const [x, y] = this.px(q), { W, H } = this;
		c.save();
		c.strokeStyle = "rgba(47,111,237,.45)"; c.lineWidth = 1; c.setLineDash([4, 4]);
		c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
		this.ring(c, [x, y]);
		const s = xy(q);
		c.font = "bold 14px sans-serif";
		const w = c.measureText(s).width + 14, bx = Math.min(Math.max(x - w / 2, 2), W - w - 2), by = y - 64 < 2 ? y + 30 : y - 64;
		c.fillStyle = "#2f6fed"; c.beginPath(); c.roundRect ? c.roundRect(bx, by, w, 24, 12) : c.rect(bx, by, w, 24); c.fill(); // 老浏览器没有 roundRect
		c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(s, bx + w / 2, by + 12);
		c.restore();
	}
	paintAxes(c) {
		const { W, H, ox, oy } = this;
		c.strokeStyle = c.fillStyle = "#333"; c.lineWidth = 1.2; c.setLineDash([]);
		this.arrowLine(c, [0, oy + 0.5], [W - 2, oy + 0.5], false, true);
		this.arrowLine(c, [ox + 0.5, H], [ox + 0.5, 2], false, true);
		c.font = "11px sans-serif"; c.textAlign = "center"; c.textBaseline = "top";
		for (let x = ox % CELL; x < W - 12; x += CELL) if (Math.abs(x - ox) > 1) c.fillText(num((x - ox) / CELL), x, oy + 3);
		c.textAlign = "right"; c.textBaseline = "middle";
		for (let y = oy % CELL; y < H; y += CELL) if (Math.abs(y - oy) > 1 && y > 12) c.fillText(num((oy - y) / CELL), ox - 4, y);
		c.font = "italic 14px serif";
		c.fillText("O", ox - 4, oy + 10);
		c.fillText("x", W - 4, oy - 11);
		c.textAlign = "left"; c.fillText("y", ox + 7, 9);
	}
	arrowLine(c, a, b, head0, head1) {
		c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
		if (head0) this.head(c, a, b);
		if (head1) this.head(c, b, a);
	}
	head(c, tip, from) { // 箭头：尖在 tip，从 from 方向来
		const k = Math.atan2(tip[1] - from[1], tip[0] - from[0]), s = 7 + c.lineWidth;
		c.save(); c.setLineDash([]); c.beginPath(); c.moveTo(...tip);
		c.lineTo(tip[0] - s * Math.cos(k - 0.4), tip[1] - s * Math.sin(k - 0.4));
		c.lineTo(tip[0] - s * Math.cos(k + 0.4), tip[1] - s * Math.sin(k + 0.4));
		c.closePath(); c.fill(); c.restore();
	}
	clip(a, b, ray) { // 直线/射线裁到画板边缘（像素）
		const d = [b[0] - a[0], b[1] - a[1]], m = 3;
		let k0 = ray ? 0 : -Infinity, k1 = Infinity;
		for (const j of [0, 1]) {
			const lo = m, hi = (j ? this.H : this.W) - m;
			if (!d[j]) { if (a[j] < lo || a[j] > hi) return null; continue; }
			const ka = (lo - a[j]) / d[j], kb = (hi - a[j]) / d[j];
			k0 = Math.max(k0, Math.min(ka, kb)); k1 = Math.min(k1, Math.max(ka, kb));
		}
		return k0 < k1 ? [lerp(a, b, k0), lerp(a, b, k1)] : null;
	}
	obj(c, o) {
		const P = (q) => this.px(q);
		c.strokeStyle = c.fillStyle = o.c || "#111";
		c.lineWidth = o.w || 2; c.lineCap = c.lineJoin = "round";
		c.setLineDash(o.d ? [7, 6] : []);
		const path = (pts, close) => { c.beginPath(); pts.map(P).forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); if (close) c.closePath(); c.stroke(); };
		const label = (q, s, font = "italic 15px serif") => {
			c.font = font; c.textAlign = "left"; c.textBaseline = "bottom";
			c.save(); c.strokeStyle = "#fff"; c.lineWidth = 4; c.setLineDash([]); c.strokeText(s, q[0] + 6, q[1] - 4); c.restore();
			c.fillText(s, q[0] + 6, q[1] - 4);
		};
		switch (o.t) {
			case "seg": path([o.a, o.b]); break;
			case "force": { const A = P(o.a), B = P(o.b); this.arrowLine(c, A, B, false, true); this.dot(c, A, 3.5); if (o.name) label(B, o.name); break; }
			case "light": { const A = P(o.a), B = P(o.b); path([o.a, o.b]); this.head(c, lerp(A, B, 0.55), A); break; }
			case "normal": c.setLineDash([6, 5]); path([o.a, o.b]); break;
			case "mirror": { const A = P(o.a), B = P(o.b), L = dist(A, B), u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], n = [-u[1], u[0]];
				path([o.a, o.b]); c.lineWidth = 1.2; c.beginPath();
				for (let k = 4; k < L; k += 8) { const q = lerp(A, B, k / L); c.moveTo(...q); c.lineTo(q[0] + (n[0] - u[0]) * 6, q[1] + (n[1] - u[1]) * 6); }
				c.stroke(); break; }
			case "lens": case "lens2": { const A = P(o.a), B = P(o.b), L = dist(A, B), u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
				path([o.a, o.b]);
				if (o.t === "lens") { this.head(c, A, B); this.head(c, B, A); } // 凸：两端箭头朝外
				else { this.head(c, A, [A[0] - u[0] * 9, A[1] - u[1] * 9]); this.head(c, B, [B[0] + u[0] * 9, B[1] + u[1] * 9]); } // 凹：朝里
				break; }
			case "open": path(o.pts); break;
			case "poly": path(o.pts, true); break;
			case "line": case "ray": { const s = this.clip(P(o.a), P(o.b), o.t === "ray"); if (s) this.arrowLine(c, s[0], s[1], o.t === "line", true); break; }
			case "circle": { const q = P(o.a); c.beginPath(); c.arc(q[0], q[1], dist(o.a, o.b) * CELL, 0, 7); c.stroke(); this.dot(c, q, 2); break; }
			case "pen": case "curve": {
				const q = o.pts.map(P);
				c.beginPath(); c.moveTo(...q[0]);
				for (let i = 0; i < q.length - 1; i++) { // Catmull-Rom 平滑
					const p0 = q[i - 1] || q[i], p1 = q[i], p2 = q[i + 1], p3 = q[i + 2] || p2;
					c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, ...p2);
				}
				c.stroke(); break;
			}
			case "pt": { const q = P(o.p); this.dot(c, q, 3.5); label(q, (o.name || "") + xy(o.p), o.name ? "italic 15px serif" : "13px sans-serif"); break; }
			case "text": { const q = P(o.p); c.font = "17px 'LXGW WenKai Screen', serif"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(o.s, ...q); break; }
			case "ra": { const k = 0.45, a = o.at; path([[a[0] + o.u[0] * k, a[1] + o.u[1] * k], [a[0] + (o.u[0] + o.v[0]) * k, a[1] + (o.u[1] + o.v[1]) * k], [a[0] + o.v[0] * k, a[1] + o.v[1] * k]]); break; }
			case "fn": {
				const f = this.fn(o.expr); if (!f) break;
				let last = null, end = null;
				c.beginPath();
				for (let x = 0; x <= this.W; x++) {
					const y = this.oy - f((x - this.ox) / CELL) * CELL;
					if (!Number.isFinite(y) || Math.abs(y) > this.H * 4 || (last !== null && Math.abs(y - last) > this.H)) { last = null; continue; }
					last === null ? c.moveTo(x, y) : c.lineTo(x, y);
					last = y;
					if (y > 16 && y < this.H - 6) end = [x, y];
				}
				c.stroke();
				if (end) { c.font = "13px serif"; c.textAlign = "right"; c.textBaseline = "bottom"; c.fillText(o.expr, Math.min(end[0], this.W - 4), end[1] - 4); }
			}
		}
		c.setLineDash([]);
	}
	dot(c, [x, y], r, color) { if (color) c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }

	// ---------- 工具栏 ----------
	build() {
		const B = (text, on, onclick, cls = "") => el("button", { type: "button", className: cls + (on ? " on" : ""), textContent: text, onclick });
		const pick = (k) => () => { this.tool = k; this.pend = null; this.build(); this.draw(); };
		this.bar1.replaceChildren(...this.tools.map(([k, name]) => B(name, this.tool === k, pick(k))), this.calc || this.phys ? "" : B("𝑓函数", false, () => this.plot()));
		this.bar2.replaceChildren(
			...COLORS.map((col) => Object.assign(B("", col === this.color, () => { this.color = col; this.build(); }, "dot"), { style: `background:${col}` })),
			B(this.width > 2 ? "粗" : "细", false, () => { this.width = this.width > 2 ? 2 : 4; this.build(); }),
			...(this.calc ? [] : [
				B("虚线", this.dash, () => { this.dash = !this.dash; this.build(); }),
				B("吸附格点", this.snap, () => { this.snap = !this.snap; this.build(); }),
				this.phys ? "" : B("坐标轴", this.axes, () => { this.axes = !this.axes; this.build(); this.draw(); })]),
			B("清空", false, () => this.objs.length && confirm("清空画板？") && this.change(() => (this.objs = []))),
			B(this.big ? "缩小" : "放大", false, () => { this.big = !this.big; this.el.classList.toggle("big", this.big); this.build(); }),
			...(this.extra?.() || []));
		const tip = this.pend?.p ? "已选点，再点一条线" : this.pend?.dir ? "已选线，再点一个点" : TOOLS.find(([k]) => k === this.tool)[2];
		this.hint.replaceChildren(el("span", { textContent: tip }));
		if (this.pend?.pts) this.hint.append(B("完成", true, () => this.finish()), B("取消", false, () => this.reset()));
		// 撤销 / 重做：放在画板正上方，醒目又不挡画布
		const fab = (t, title, f) => el("button", { type: "button", className: "fab", textContent: t, title, onclick: f });
		this.hint.append(fab("↶", "撤销", () => this.step(this.hist, this.fut)), fab("↷", "重做", () => this.step(this.fut, this.hist)));
	}

	// ---------- 交卷 ----------
	// 文字描述（坐标单位=格），Claude 据此批改，基本不用看图
	// 文字描述 + 代码算好的几何信息（方程、截距、交点、点在哪条线上），Claude 直接核对，不用自己推算
	describe() {
		const col = { "#d64545": "红", "#2f6fed": "蓝" }, n2 = (v) => String(Math.round(v * 100) / 100 || 0), p2 = (q) => `(${n2(q[0])},${n2(q[1])})`;
		const eq = (a, b) => {
			if (Math.abs(a[0] - b[0]) < 1e-9) return `x=${n2(a[0])}`;
			const k = (b[1] - a[1]) / (b[0] - a[0]), m = a[1] - k * a[0];
			const kx = Math.abs(k) < 1e-9 ? "" : `${k === 1 ? "" : k === -1 ? "-" : n2(k)}x`;
			return `y=${kx}${Math.abs(m) < 1e-9 ? (kx ? "" : "0") : (m > 0 && kx ? "+" : "") + n2(m)}`;
		};
		const on = (L, q) => dist(q, proj(q, L.a, L.b, L.k)) < 1e-6; // 点在线段/射线/直线范围内
		const cross = (L1, L2) => { // 两线交点
			const d1 = [L1.b[0] - L1.a[0], L1.b[1] - L1.a[1]], d2 = [L2.b[0] - L2.a[0], L2.b[1] - L2.a[1]], den = d1[0] * d2[1] - d1[1] * d2[0];
			if (Math.abs(den) < 1e-9) return null;
			const k = ((L2.a[0] - L1.a[0]) * d2[1] - (L2.a[1] - L1.a[1]) * d2[0]) / den, q = lerp(L1.a, L1.b, k);
			return on(L1, q) && on(L2, q) ? q : null;
		};
		const lines = [], parts = [], items = this.objs.filter((o) => o.t !== "pen");
		items.forEach((o, i) => {
			const id = `[${i + 1}]`, pre = (o.d ? "虚" : "") + (col[o.c] || "");
			let d = "";
			if (PHYS_NAME[o.t]) {
				d = o.t === "force" ? `${pre}力${o.name || ""} 作用点${xy(o.a)} 指向${xy(o.b)} 长${n2(dist(o.a, o.b))}格` : `${pre}${PHYS_NAME[o.t]}${xy(o.a)}${o.t === "light" ? "→" : ""}${xy(o.b)}`;
				if (o.t === "light") { // 光线一端落在镜面上：算与法线的夹角（入射角/反射角）
					for (const m of items) if (m.t === "mirror") for (const [end, other, nm] of [[o.b, o.a, "入射角"], [o.a, o.b, "反射角"]]) {
						if (dist(end, proj(end, m.a, m.b, "seg")) > 1e-6) continue;
						const v = [other[0] - end[0], other[1] - end[1]], mv = [m.b[0] - m.a[0], m.b[1] - m.a[1]];
						const cos = Math.abs(v[0] * mv[0] + v[1] * mv[1]) / Math.hypot(...v) / Math.hypot(...mv);
						d += ` ${nm}≈${Math.round(90 - (Math.acos(Math.min(1, cos)) * 180) / Math.PI)}°`;
					}
				}
			} else if (["seg", "line", "ray"].includes(o.t)) {
				const L = { a: o.a, b: o.b, k: o.t, id };
				lines.push(L);
				const name = { seg: `线段${xy(o.a)}${xy(o.b)}`, line: `直线过${xy(o.a)}${xy(o.b)}`, ray: `射线${xy(o.a)}→${xy(o.b)}` }[o.t];
				const ix = [[0, 1], [1, 0]].map(([ax, ay]) => cross(L, { a: [0, 0], b: [ax, ay], k: "line" })).filter(Boolean);
				d = `${pre}${name} ${eq(o.a, o.b)}` + (this.axes && ix.length ? ` 交轴${ix.map(p2).join("")}` : "");
			} else if (o.t === "circle") d = `${pre}圆 心${xy(o.a)} 半径${n2(dist(o.a, o.b))}`;
			else if (o.t === "poly") d = `${pre}多边形${o.pts.map(xy).join("")}`;
			else if (o.t === "curve") d = `${pre}曲线过${o.pts.map(xy).join("")}`;
			else if (o.t === "fn") d = `函数 ${o.expr}`;
			else if (o.t === "ra") d = `直角@${xy(o.at)}`;
			else if (o.t === "text") d = `文字「${o.s}」` + (this.calc ? "" : `@${xy(o.p)}`);
			else {
				const hosts = items.filter((h) => h !== o && !["pt", "text", "ra"].includes(h.t) && this.distTo(h, o.p) < 0.05).map((h) => `[${items.indexOf(h) + 1}]`);
				d = `点${o.name || ""}${xy(o.p)}${hosts.length ? "在" + hosts.join("") + "上" : ""}`;
			}
			parts.push(id + d);
		});
		for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
			const q = cross(lines[i], lines[j]);
			if (q) parts.push(`${lines[i].id}∩${lines[j].id}=${p2(q)}`);
		}
		const pens = this.objs.length - items.length;
		if (pens) parts.push(`手绘${pens}笔`);
		return (this.axes ? "坐标轴；" : "") + parts.join("；");
	}
	toFile(full) { return snapshot(this, full); }
}

// 画板导出。full=true：整板高清图（2 倍、JPEG 0.92），只给自己看结果；
// 否则是发给 Claude 批改的小图：只裁出画了东西的区域，最长边 ≤512px、JPEG 0.7（用量按像素算≈宽×高/750 token，裁掉空白省一半以上）。
function snapshot(b, hd) {
	const W = Math.round(b.W), H = Math.round(b.H), full = document.createElement("canvas");
	if (hd) {
		full.width = W * 2; full.height = H * 2;
		const c = full.getContext("2d"); c.scale(2, 2); b.paint(c, false);
		return new Promise((res) => full.toBlob((bb) => res(new File([bb], "board.jpg", { type: "image/jpeg" })), "image/jpeg", 0.92));
	}
	full.width = W; full.height = H;
	const fc = full.getContext("2d");
	b.paint(fc, false);
	// 找「墨迹」：深色或彩色像素（浅色格线、纸色不算）
	const d = fc.getImageData(0, 0, W, H).data;
	let x0 = W, y0 = H, x1 = -1, y1 = -1;
	for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
		const i = (y * W + x) * 4, r = d[i], g = d[i + 1], bl = d[i + 2];
		if (r + g + bl < 540 || Math.max(r, g, bl) - Math.min(r, g, bl) > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
	}
	if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
	const m = 14; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W, x1 + m); y1 = Math.min(H, y1 + m);
	const cw = x1 - x0, ch = y1 - y0, s = Math.min(2, 512 / Math.max(cw, ch)), out = document.createElement("canvas");
	out.width = Math.round(cw * s); out.height = Math.round(ch * s);
	const c = out.getContext("2d");
	c.drawImage(full, x0, y0, cw, ch, 0, 0, out.width, out.height);
	return new Promise((res) => out.toBlob((bb) => res(new File([bb], "board.jpg", { type: "image/jpeg" })), "image/jpeg", 0.7));
}
