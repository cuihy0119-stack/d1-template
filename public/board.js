// 作图板：方格纸常驻 + 坐标系 + 几何作图工具（参考 GeoGebra、几何画板的常用工具）
// 图形坐标一律用「格」为单位，原点在画板中心附近的格点上。

const BOARD_TOOLS = [
	["pen", "✏️ 画笔", "按住拖动，自由画"],
	["seg", "／ 线段", "按住从起点拖到终点（吸附格点）"],
	["line", "⟷ 直线", "拖出两点，两端无限延长"],
	["ray", "↗ 射线", "从端点拖向方向"],
	["circle", "◯ 圆", "从圆心拖到圆上一点"],
	["rect", "▭ 矩形", "拖动对角两点"],
	["poly", "△ 多边形", "依次点顶点，点回第一个点或按「完成」闭合"],
	["curve", "∿ 曲线", "依次点曲线经过的点，按「完成」生成平滑曲线"],
	["point", "• 点", "点一下放一个点，并起名字"],
	["text", "T 文字", "点一下输入文字"],
	["perp", "⊥ 垂线", "先点一个点，再点一条线：画垂线段和垂足"],
	["para", "∥ 平行线", "先点一条线，再点一个点：过该点作平行线"],
	["erase", "⌫ 橡皮", "点一下删除一个图形"],
];
const BOARD_COLORS = ["#111111", "#d64545", "#2f6fed"];

// ---------- 函数解析：支持 + - * / ^ ( ) | |、隐式乘法、sqrt sin cos tan abs ln log、pi ----------
function compileFn(src) {
	const s = src
		.replace(/\s+/g, "")
		.replace(/^y=/i, "")
		.replace(/[（]/g, "(").replace(/[）]/g, ")")
		.replace(/×/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-")
		.replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, "sqrt").replace(/π/g, "pi");
	const toks = s.match(/\d+\.?\d*|\.\d+|[a-z]+|[-+*/^()|]/gi);
	if (!toks || toks.join("") !== s) throw new Error("看不懂这个式子");
	const FN = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, ln: Math.log, log: Math.log10 };
	let i = 0;
	const peek = () => toks[i], next = () => toks[i++];
	const startsAtom = (t) => t !== undefined && (/^[\d.]/.test(t) || /^[a-z]/i.test(t) || t === "(");
	function expr() {
		let f = term();
		while (peek() === "+" || peek() === "-") {
			const op = next(), a = f, b = term();
			f = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
		}
		return f;
	}
	function term() {
		let f = unary();
		while (peek() === "*" || peek() === "/" || startsAtom(peek())) {
			const op = peek() === "*" || peek() === "/" ? next() : "*";
			const a = f, b = unary();
			f = op === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
		}
		return f;
	}
	function unary() {
		if (peek() === "-") { next(); const a = unary(); return (x) => -a(x); }
		if (peek() === "+") { next(); return unary(); }
		return power();
	}
	function power() {
		const base = atom();
		if (peek() === "^") { next(); const e = unary(); return (x) => Math.pow(base(x), e(x)); }
		return base;
	}
	function atom() {
		const t = next();
		if (t === undefined) throw new Error("式子不完整");
		if (/^[\d.]/.test(t)) { const v = parseFloat(t); return () => v; }
		if (t === "(") { const f = expr(); if (next() !== ")") throw new Error("括号不配对"); return f; }
		if (t === "|") { const f = expr(); if (next() !== "|") throw new Error("绝对值符号不配对"); return (x) => Math.abs(f(x)); }
		const w = t.toLowerCase();
		if (w === "x") return (x) => x;
		if (w === "pi") return () => Math.PI;
		if (w === "e") return () => Math.E;
		if (FN[w]) {
			if (next() !== "(") throw new Error(w + " 后面要加括号");
			const f = expr();
			if (next() !== ")") throw new Error("括号不配对");
			return (x) => FN[w](f(x));
		}
		// 连写的字母，如 xx、2pix
		throw new Error("不认识：" + t);
	}
	const f = expr();
	if (i < toks.length) throw new Error("多余的：" + toks.slice(i).join(""));
	return f;
}

// ---------- 几何小工具（单位：格） ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function distSeg(p, a, b, kind = "seg") {
	const d = sub(b, a), L = d[0] * d[0] + d[1] * d[1];
	if (!L) return dist(p, a);
	let t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L;
	if (kind === "seg") t = Math.max(0, Math.min(1, t));
	if (kind === "ray") t = Math.max(0, t);
	return dist(p, [a[0] + t * d[0], a[1] + t * d[1]]);
}
function foot(p, a, b) {
	const d = sub(b, a), L = d[0] * d[0] + d[1] * d[1];
	const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L;
	return [a[0] + t * d[0], a[1] + t * d[1]];
}
function rectPts(a, b) { return [a, [b[0], a[1]], b, [a[0], b[1]]]; }

class Board {
	constructor({ axes = false } = {}) {
		this.cell = 24;
		this.axes = axes;
		this.objs = [];
		this.hist = [];
		this.redoStack = [];
		this.tool = "seg";
		this.color = BOARD_COLORS[0];
		this.width = 2;
		this.dash = false;
		this.snap = true;
		this.big = false;
		this.pending = null; // 多步工具进行中
		this.drag = null; // 拖动预览
		this.cursor = null;
		this.fns = new Map(); // 解析式 -> 函数

		this.tools = el("div", { className: "btools" });
		this.styles = el("div", { className: "btools" });
		this.hint = el("div", { className: "bhint" });
		this.cv = el("canvas");
		this.wrap = el("div", { className: "bwrap" }, this.cv);
		this.el = el("div", { className: "board" }, this.tools, this.styles, this.hint, this.wrap);
		this.ctx = this.cv.getContext("2d");
		this.bind();
		this.build();
		new ResizeObserver(() => this.resize()).observe(this.wrap);
	}

	isEmpty() { return this.objs.length === 0; }

	// ---------- 尺寸与坐标 ----------
	resize() {
		const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
		if (!W || !H) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.cv.width = Math.round(W * dpr);
		this.cv.height = Math.round(H * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.W = W; this.H = H;
		this.draw();
	}
	origin(W, H) { return [Math.round(W / 2 / this.cell) * this.cell, Math.round(H / 2 / this.cell) * this.cell]; }
	unitAt(e, snap) {
		const r = this.cv.getBoundingClientRect();
		const [ox, oy] = this.origin(this.W, this.H);
		let p = [(e.clientX - r.left - ox) / this.cell, (oy - (e.clientY - r.top)) / this.cell];
		if (snap) p = [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2].map((v) => (Math.abs(v - Math.round(v)) < 0.25 ? Math.round(v) : v));
		return p;
	}

	// ---------- 历史 ----------
	commit(change) {
		this.hist.push(JSON.stringify(this.objs));
		this.redoStack = [];
		change();
		this.draw();
	}
	undo() {
		if (this.pending) { this.pending = null; this.build(); return this.draw(); }
		if (!this.hist.length) return;
		this.redoStack.push(JSON.stringify(this.objs));
		this.objs = JSON.parse(this.hist.pop());
		this.draw();
	}
	redo() {
		if (!this.redoStack.length) return;
		this.hist.push(JSON.stringify(this.objs));
		this.objs = JSON.parse(this.redoStack.pop());
		this.draw();
	}
	style() { return { c: this.color, w: this.width, d: this.dash }; }
	add(o) { this.commit(() => this.objs.push({ ...this.style(), ...o })); }

	// ---------- 交互 ----------
	bind() {
		const cv = this.cv;
		cv.addEventListener("pointerdown", (e) => {
			if (!e.isPrimary) return;
			cv.setPointerCapture(e.pointerId);
			this.down(e);
		});
		cv.addEventListener("pointermove", (e) => {
			if (!e.isPrimary) return;
			if (this.drag) {
				if (this.drag.t === "pen") this.drag.pts.push(this.unitAt(e, false));
				else this.drag.b = this.unitAt(e, this.snap);
				this.draw();
			} else if (this.pending) {
				this.cursor = this.unitAt(e, this.snap);
				this.draw();
			}
		});
		const up = () => {
			const d = this.drag;
			this.drag = null;
			if (!d) return;
			if (d.t === "pen" ? d.pts.length > 1 : dist(d.a, d.b) > 0.01) this.add(d);
			else this.draw();
		};
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointercancel", up);
	}

	down(e) {
		const t = this.tool;
		const p = this.unitAt(e, this.snap && t !== "pen");
		if (t === "pen") { this.drag = { t, pts: [p] }; return; }
		if (["seg", "line", "ray", "circle", "rect"].includes(t)) { this.drag = { t, a: p, b: p }; return; }
		if (t === "poly" || t === "curve") {
			if (!this.pending) { this.pending = { t, pts: [p] }; this.build(); }
			else if (t === "poly" && this.pending.pts.length >= 3 && dist(p, this.pending.pts[0]) < 0.4) return this.finish();
			else this.pending.pts.push(p);
			this.cursor = p;
			return this.draw();
		}
		if (t === "point") {
			const used = new Set(this.objs.filter((o) => o.t === "pt").map((o) => o.name));
			const def = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((c) => !used.has(c)) || "";
			const name = prompt("点的名字（可留空）", def);
			if (name !== null) this.add({ t: "pt", p, name: name.trim() });
			return;
		}
		if (t === "text") {
			const s = prompt("输入文字");
			if (s && s.trim()) this.add({ t: "text", p, s: s.trim() });
			return;
		}
		if (t === "erase") {
			const i = this.nearest(this.unitAt(e, false));
			if (i >= 0) this.commit(() => this.objs.splice(i, 1));
			return;
		}
		if (t === "perp") {
			if (!this.pending) { this.pending = { t, p }; this.build(); return this.draw(); }
			const L = this.nearestLine(this.unitAt(e, false));
			if (!L) return alert("请点在一条线上");
			const P = this.pending.p, F = foot(P, L[0], L[1]);
			this.pending = null;
			this.build();
			if (dist(P, F) < 0.01) return alert("这个点就在线上，换一个点");
			const u = sub(L[1], L[0]), lu = Math.hypot(...u), v = sub(P, F), lv = Math.hypot(...v);
			this.commit(() => {
				this.objs.push({ ...this.style(), t: "seg", a: P, b: F });
				this.objs.push({ ...this.style(), d: false, t: "ra", at: F, u: [u[0] / lu, u[1] / lu], v: [v[0] / lv, v[1] / lv] });
			});
			return;
		}
		if (t === "para") {
			if (!this.pending) {
				const L = this.nearestLine(this.unitAt(e, false));
				if (!L) return alert("先点在一条线上");
				this.pending = { t, dir: sub(L[1], L[0]) };
				this.build();
				return;
			}
			const d = this.pending.dir;
			this.pending = null;
			this.build();
			this.add({ t: "line", a: p, b: [p[0] + d[0], p[1] + d[1]] });
		}
	}

	finish() {
		const pd = this.pending;
		this.pending = null;
		this.cursor = null;
		this.build();
		if (pd && pd.pts && pd.pts.length >= 2) this.add({ t: pd.t, pts: pd.pts });
		else this.draw();
	}

	plot() {
		const s = prompt("输入函数解析式，例如：\ny = x^2 - 2x - 3\ny = 2x + 1\ny = 6/x\ny = sqrt(x)", "y = ");
		if (!s || !s.replace(/^\s*y\s*=\s*/i, "")) return;
		try {
			compileFn(s);
		} catch (err) {
			return alert(err.message);
		}
		if (!this.axes) { this.axes = true; this.build(); }
		this.add({ t: "fn", expr: s.trim().replace(/^y\s*=\s*/i, "y = ") });
	}

	// 找最近的图形 / 直线类图形（单位：格）
	nearest(p) {
		let best = -1, bd = 0.5;
		this.objs.forEach((o, i) => {
			const d = this.distTo(o, p);
			if (d < bd) { bd = d; best = i; }
		});
		return best;
	}
	distTo(o, p) {
		switch (o.t) {
			case "seg": return distSeg(p, o.a, o.b);
			case "line": return distSeg(p, o.a, o.b, "line");
			case "ray": return distSeg(p, o.a, o.b, "ray");
			case "circle": return Math.abs(dist(p, o.a) - dist(o.a, o.b));
			case "rect": { const r = rectPts(o.a, o.b); return Math.min(...r.map((q, i) => distSeg(p, q, r[(i + 1) % 4]))); }
			case "poly": return Math.min(...o.pts.map((q, i) => distSeg(p, q, o.pts[(i + 1) % o.pts.length])));
			case "curve": case "pen": return Math.min(...o.pts.map((q, i) => (i ? distSeg(p, o.pts[i - 1], q) : dist(p, q))));
			case "pt": return dist(p, o.p);
			case "text": return dist(p, [o.p[0] + 0.3 * o.s.length, o.p[1]]) - 0.3 * o.s.length;
			case "ra": return dist(p, o.at);
			case "fn": { const y = this.fnOf(o.expr)?.(p[0]); return Number.isFinite(y) ? Math.abs(y - p[1]) : 99; }
		}
		return 99;
	}
	nearestLine(p) {
		let best = null, bd = 0.6;
		const consider = (a, b, kind) => { const d = distSeg(p, a, b, kind); if (d < bd) { bd = d; best = [a, b]; } };
		for (const o of this.objs) {
			if (o.t === "seg") consider(o.a, o.b, "seg");
			if (o.t === "line") consider(o.a, o.b, "line");
			if (o.t === "ray") consider(o.a, o.b, "ray");
			if (o.t === "rect") { const r = rectPts(o.a, o.b); r.forEach((q, i) => consider(q, r[(i + 1) % 4], "seg")); }
			if (o.t === "poly") o.pts.forEach((q, i) => consider(q, o.pts[(i + 1) % o.pts.length], "seg"));
		}
		return best;
	}
	fnOf(expr) {
		if (!this.fns.has(expr)) { try { this.fns.set(expr, compileFn(expr)); } catch { this.fns.set(expr, null); } }
		return this.fns.get(expr);
	}

	// ---------- 绘制 ----------
	draw() {
		if (this.W) this.paint(this.ctx, this.W, this.H, true);
	}
	paint(c, W, H, live) {
		const cell = this.cell, [ox, oy] = this.origin(W, H);
		const P = (q) => [ox + q[0] * cell, oy - q[1] * cell];
		c.fillStyle = "#fff";
		c.fillRect(0, 0, W, H);
		// 方格（常驻）
		c.lineWidth = 1;
		c.strokeStyle = "#e6e9ef";
		c.beginPath();
		for (let x = ox % cell; x <= W; x += cell) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); }
		for (let y = oy % cell; y <= H; y += cell) { c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); }
		c.stroke();
		if (this.axes) this.paintAxes(c, W, H, ox, oy);

		const list = [...this.objs];
		if (live && this.drag) list.push({ ...this.style(), ...this.drag });
		if (live && this.pending?.pts) list.push({ ...this.style(), t: this.pending.t === "poly" ? "open" : "curve", pts: this.cursor ? [...this.pending.pts, this.cursor] : this.pending.pts });
		for (const o of list) this.paintObj(c, o, P, W, H, ox, oy);
		if (live && this.pending?.p) this.paintObj(c, { t: "pt", p: this.pending.p, name: "", c: "#d64545" }, P);
		if (live && this.pending?.pts) for (const q of this.pending.pts) this.paintObj(c, { t: "pt", p: q, name: "", c: "#2f6fed" }, P);
	}
	paintAxes(c, W, H, ox, oy) {
		const cell = this.cell;
		c.strokeStyle = "#333";
		c.fillStyle = "#333";
		c.lineWidth = 1.2;
		c.beginPath();
		c.moveTo(0, oy + 0.5); c.lineTo(W, oy + 0.5);
		c.moveTo(ox + 0.5, H); c.lineTo(ox + 0.5, 0);
		c.stroke();
		const arrow = (x, y, dx, dy) => {
			c.beginPath(); c.moveTo(x, y);
			c.lineTo(x - dx * 8 - dy * 4, y - dy * 8 + dx * 4);
			c.lineTo(x - dx * 8 + dy * 4, y - dy * 8 - dx * 4);
			c.closePath(); c.fill();
		};
		arrow(W - 1, oy + 0.5, 1, 0);
		arrow(ox + 0.5, 1, 0, -1);
		c.font = "11px sans-serif";
		c.textAlign = "center";
		c.textBaseline = "top";
		for (let x = ox + cell, n = 1; x < W - 10; x += cell, n++) c.fillText(n, x, oy + 3);
		for (let x = ox - cell, n = -1; x > 4; x -= cell, n--) c.fillText(n, x, oy + 3);
		c.textAlign = "right";
		c.textBaseline = "middle";
		for (let y = oy - cell, n = 1; y > 10; y -= cell, n++) c.fillText(n, ox - 4, y);
		for (let y = oy + cell, n = -1; y < H - 4; y += cell, n--) c.fillText(n, ox - 4, y);
		c.font = "italic 13px serif";
		c.fillText("O", ox - 4, oy + 9);
		c.fillText("x", W - 4, oy - 10);
		c.textAlign = "left";
		c.fillText("y", ox + 6, 8);
	}
	paintObj(c, o, P, W, H) {
		c.strokeStyle = o.c || "#111";
		c.fillStyle = o.c || "#111";
		c.lineWidth = o.w || 2;
		c.lineCap = "round";
		c.lineJoin = "round";
		c.setLineDash(o.d ? [7, 6] : []);
		const far = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		const path = (pts, close) => {
			c.beginPath();
			pts.map(P).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
			if (close) c.closePath();
			c.stroke();
		};
		switch (o.t) {
			case "pen": {
				const pts = o.pts.map(P);
				c.beginPath();
				c.moveTo(...pts[0]);
				for (let i = 1; i < pts.length - 1; i++) {
					const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
					c.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
				}
				c.lineTo(...pts[pts.length - 1]);
				c.stroke();
				break;
			}
			case "seg": path([o.a, o.b]); break;
			case "line": { const L = dist(o.a, o.b) || 1; path([far(o.a, o.b, -200 / L), far(o.a, o.b, 200 / L)]); break; }
			case "ray": { const L = dist(o.a, o.b) || 1; path([o.a, far(o.a, o.b, 200 / L)]); this.dot(c, P(o.a)); break; }
			case "rect": path(rectPts(o.a, o.b), true); break;
			case "poly": path(o.pts, true); break;
			case "open": path(o.pts, false); break;
			case "circle": {
				const [x, y] = P(o.a);
				c.beginPath(); c.arc(x, y, dist(o.a, o.b) * this.cell, 0, Math.PI * 2); c.stroke();
				this.dot(c, [x, y], 2);
				break;
			}
			case "curve": {
				const pts = o.pts.map(P);
				c.beginPath();
				c.moveTo(...pts[0]);
				for (let i = 0; i < pts.length - 1; i++) {
					const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
					c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
				}
				c.stroke();
				break;
			}
			case "pt": {
				const [x, y] = P(o.p);
				this.dot(c, [x, y], 3.5);
				if (o.name) { c.font = "italic 15px serif"; c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(o.name, x + 5, y - 3); }
				break;
			}
			case "text": {
				const [x, y] = P(o.p);
				c.font = "16px sans-serif"; c.textAlign = "left"; c.textBaseline = "middle";
				c.fillText(o.s, x, y);
				break;
			}
			case "ra": { // 直角符号
				const k = 0.45, a = o.at, u = o.u, v = o.v;
				path([[a[0] + u[0] * k, a[1] + u[1] * k], [a[0] + (u[0] + v[0]) * k, a[1] + (u[1] + v[1]) * k], [a[0] + v[0] * k, a[1] + v[1] * k]]);
				break;
			}
			case "fn": {
				const f = this.fnOf(o.expr);
				if (!f) break;
				const [ox, oy] = [P([0, 0])[0], P([0, 0])[1]];
				c.beginPath();
				let pen = false, last = null, lastPt = null;
				for (let px = 0; px <= W; px += 1) {
					const y = f((px - ox) / this.cell);
					const py = oy - y * this.cell;
					if (!Number.isFinite(py) || Math.abs(py) > H * 4 || (last !== null && Math.abs(py - last) > H)) { pen = false; last = null; continue; }
					pen ? c.lineTo(px, py) : c.moveTo(px, py);
					pen = true; last = py;
					if (py > 14 && py < H - 6) lastPt = [px, py];
				}
				c.stroke();
				if (lastPt) {
					c.font = "13px serif"; c.textAlign = "right"; c.textBaseline = "bottom";
					c.fillText(o.expr, Math.min(lastPt[0], W - 4), lastPt[1] - 4);
				}
				break;
			}
		}
		c.setLineDash([]);
	}
	dot(c, [x, y], r = 2.5) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }

	// ---------- 工具栏 ----------
	build() {
		const B = (text, on, onclick, title) => el("button", { type: "button", className: on ? "on" : "", textContent: text, onclick, title: title || "" });
		this.tools.replaceChildren(
			...BOARD_TOOLS.map(([k, name]) => B(name, this.tool === k, () => { this.tool = k; this.pending = null; this.cursor = null; this.build(); this.draw(); })),
			B("𝑓 函数", false, () => this.plot()));
		this.styles.replaceChildren(
			...BOARD_COLORS.map((c) => el("button", { type: "button", className: "dot" + (c === this.color ? " on" : ""), style: `background:${c}`, onclick: () => { this.color = c; this.build(); } })),
			B(this.width > 2 ? "粗" : "细", false, () => { this.width = this.width > 2 ? 2 : 4; this.build(); }),
			B("虚线", this.dash, () => { this.dash = !this.dash; this.build(); }),
			B("吸附格点", this.snap, () => { this.snap = !this.snap; this.build(); }),
			B("坐标轴", this.axes, () => { this.axes = !this.axes; this.build(); this.draw(); }),
			B("↶ 撤销", false, () => this.undo()),
			B("↷ 重做", false, () => this.redo()),
			B("清空", false, () => { if (this.objs.length && confirm("清空画板？")) this.commit(() => (this.objs = [])); }),
			B(this.big ? "缩小" : "放大", false, () => { this.big = !this.big; this.el.classList.toggle("big", this.big); this.build(); }));
		const tip = BOARD_TOOLS.find(([k]) => k === this.tool)?.[2] || "";
		const stepTip = this.pending?.t === "perp" ? "已选点，现在点一条线" : this.pending?.t === "para" ? "已选线，现在点一个点" : tip;
		this.hint.replaceChildren(el("span", { textContent: stepTip }));
		if (this.pending?.pts) this.hint.append(B("完成", true, () => this.finish()), B("取消", false, () => { this.pending = null; this.cursor = null; this.build(); this.draw(); }));
	}

	// 导出为图片（交卷时上传，Claude 读图批改）
	toFile() {
		const W = this.W, H = this.H, s = Math.min(2, 1600 / Math.max(W, H));
		const out = document.createElement("canvas");
		out.width = Math.round(W * s);
		out.height = Math.round(H * s);
		const c = out.getContext("2d");
		c.scale(s, s);
		this.paint(c, W, H, false);
		return new Promise((res) => out.toBlob((b) => res(new File([b], "board.jpg", { type: "image/jpeg" })), "image/jpeg", 0.9));
	}
}
