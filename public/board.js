// 作图板：方格常驻、格点吸附、几何/函数作图。图形坐标以「格」为单位，原点在画板中心附近的格点。
// 交卷时 describe() 生成文字描述发给 Claude（省用量）；只有手绘笔迹才需要附图。

const TOOLS = [
	["seg", "／线段", "拖动画线段，两端吸附格点"],
	["line", "⟷直线", "拖出两点，自动延长到边缘"],
	["ray", "↗射线", "从端点拖向方向，延长到边缘"],
	["circle", "◯圆", "从圆心拖到圆上一点"],
	["poly", "△多边形", "依次点顶点，点回起点或按「完成」"],
	["curve", "∿曲线", "依次点经过的点，按「完成」连成平滑曲线"],
	["mark", "⊙标点", "点一下标出坐标"],
	["point", "•点", "点一下放点并起名"],
	["text", "T文字", "点一下，在那里打字"],
	["perp", "⊥垂线", "先点一个点，再点一条线"],
	["para", "∥平行线", "先点一条线，再点一个点"],
	["pen", "✏️画笔", "自由手绘"],
	["erase", "⌫橡皮", "点一下删除一个图形"],
];
const COLORS = ["#111111", "#d64545", "#2f6fed"];
const CELL = 24, LIFT = 30; // 格距；触屏时预览点抬高 30px

// ---------- 函数解析：+ - * / ^ ( ) | |、隐式乘法、sqrt sin cos tan abs ln log、pi e ----------
function compileFn(src) {
	const s = src.replace(/\s+/g, "").replace(/^y=/i, "").replace(/（/g, "(").replace(/）/g, ")").replace(/×/g, "*")
		.replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, "sqrt").replace(/π/g, "pi");
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
const edges = (o) => (o.t === "poly" ? o.pts.map((q, i) => [q, o.pts[(i + 1) % o.pts.length], "seg"]) : ["seg", "line", "ray"].includes(o.t) ? [[o.a, o.b, o.t]] : []);

class Board {
	constructor({ axes = false } = {}) {
		Object.assign(this, { axes, objs: [], hist: [], fut: [], tool: "seg", color: COLORS[0], width: 2, dash: false, snap: true, big: false, fns: new Map() });
		this.cv = el("canvas");
		this.wrap = el("div", { className: "bwrap" }, this.cv);
		this.bar1 = el("div", { className: "btools" });
		this.bar2 = el("div", { className: "btools" });
		this.hint = el("div", { className: "bhint" });
		this.el = el("div", { className: "board" }, this.bar1, this.bar2, this.hint, this.wrap);
		this.ctx = this.cv.getContext("2d");
		this.bind();
		this.build();
		new ResizeObserver(() => this.resize()).observe(this.wrap);
	}
	isEmpty() { return !this.objs.length; }
	hasPen() { return this.objs.some((o) => o.t === "pen"); }

	// ---------- 坐标 ----------
	resize() {
		const W = this.wrap.clientWidth, H = this.wrap.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
		if (!W || !H) return;
		Object.assign(this, { W, H, ox: Math.round(W / 2 / CELL) * CELL, oy: Math.round(H / 2 / CELL) * CELL });
		this.cv.width = W * dpr; this.cv.height = H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}
	px(q) { return [this.ox + q[0] * CELL, this.oy - q[1] * CELL]; }
	at(e) { // 返回 [吸附后的点, 原始点]
		const r = this.cv.getBoundingClientRect(), lift = e.pointerType === "touch" && this.tool !== "pen" ? LIFT : 0;
		const raw = [(e.clientX - r.left - this.ox) / CELL, (this.oy - (e.clientY - r.top - lift)) / CELL];
		return [this.snap && this.tool !== "pen" ? raw.map(Math.round) : raw, raw];
	}

	// ---------- 历史 ----------
	change(fn) { this.hist.push(JSON.stringify(this.objs)); this.fut = []; fn(); this.draw(); }
	add(o) { this.change(() => this.objs.push({ c: this.color, w: this.width, d: this.dash, ...o })); }
	step(from, to) { if (this.pend) return this.reset(); if (!from.length) return; to.push(JSON.stringify(this.objs)); this.objs = JSON.parse(from.pop()); this.draw(); }
	reset() { this.pend = null; this.build(); this.draw(); }

	// ---------- 交互：拖动类按住拖；点选类抬手时才落点（可边按边调整位置） ----------
	bind() {
		const cv = this.cv;
		cv.addEventListener("pointerdown", (e) => {
			if (!e.isPrimary) return;
			cv.setPointerCapture(e.pointerId);
			const [p, raw] = this.at(e), t = this.tool;
			if (t === "erase") { const i = this.hit(raw); if (i >= 0) this.change(() => this.objs.splice(i, 1)); return; }
			if (t === "pen") this.drag = { t, pts: [raw] };
			else if (["seg", "line", "ray", "circle"].includes(t)) this.drag = { t, a: p, b: p };
			else this.tap = [p, raw];
			this.draw();
		});
		cv.addEventListener("pointermove", (e) => {
			const [p, raw] = this.at(e);
			if (this.drag) this.drag.t === "pen" ? this.drag.pts.push(raw) : (this.drag.b = p);
			else if (this.tap) this.tap = [p, raw];
			else this.hover = e.pointerType === "mouse" ? p : null;
			this.draw();
		});
		const up = () => {
			const d = this.drag, tp = this.tap;
			this.drag = this.tap = null;
			if (d && (d.t === "pen" ? d.pts.length > 1 : dist(d.a, d.b) > 0.01)) this.add(d);
			else if (tp) this.act(...tp);
			else this.draw();
		};
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointercancel", up);
		cv.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
	}

	act(p, raw) {
		const t = this.tool, pd = this.pend;
		if (t === "poly" || t === "curve") {
			if (pd && t === "poly" && pd.pts.length > 2 && dist(p, pd.pts[0]) < 0.4) return this.finish();
			pd ? pd.pts.push(p) : ((this.pend = { pts: [p] }), this.build());
		} else if (t === "mark") this.add({ t: "mk", p });
		else if (t === "point") {
			const used = new Set(this.objs.map((o) => o.name));
			this.ask(p, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((c) => !used.has(c)) || "", (name) => this.add({ t: "pt", p, name }));
		} else if (t === "text") this.ask(p, "", (s) => s && this.add({ t: "text", p, s }));
		else if (t === "perp") {
			if (!pd) { this.pend = { p }; this.build(); return this.draw(); }
			const L = this.lineAt(raw);
			if (!L) return alert("请点在一条线上");
			const F = proj(pd.p, L[0], L[1], "line");
			this.pend = null; this.build();
			if (dist(pd.p, F) < 0.01) return alert("点在线上，换一个点");
			const u = [L[1][0] - L[0][0], L[1][1] - L[0][1]], v = [pd.p[0] - F[0], pd.p[1] - F[1]], lu = Math.hypot(...u), lv = Math.hypot(...v);
			this.change(() => this.objs.push(
				{ c: this.color, w: this.width, d: this.dash, t: "seg", a: pd.p, b: F },
				{ c: this.color, w: this.width, t: "ra", at: F, u: [u[0] / lu, u[1] / lu], v: [v[0] / lv, v[1] / lv] }));
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
	draw() { if (this.W) this.paint(this.ctx, true); }
	paint(c, live) {
		const { W, H, ox, oy } = this;
		c.fillStyle = "#fff"; c.fillRect(0, 0, W, H);
		c.lineWidth = 1; c.strokeStyle = "#e3e6ec"; c.setLineDash([]);
		c.beginPath();
		for (let x = ox % CELL; x <= W; x += CELL) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); }
		for (let y = oy % CELL; y <= H; y += CELL) { c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); }
		c.stroke();
		if (this.axes) this.paintAxes(c);
		const style = { c: this.color, w: this.width, d: this.dash };
		const list = [...this.objs];
		if (live && this.drag) list.push({ ...style, ...this.drag });
		if (live && this.pend?.pts) list.push({ ...style, t: this.tool === "poly" ? "open" : "curve", pts: this.tap ? [...this.pend.pts, this.tap[0]] : this.pend.pts });
		for (const o of list) this.obj(c, o);
		if (!live) return;
		for (const q of this.pend?.pts || (this.pend?.p ? [this.pend.p] : [])) this.dot(c, this.px(q), 3.5, "#d64545");
		const sp = this.drag && this.drag.t !== "pen" ? [this.drag.a, this.drag.b] : this.tap ? [this.tap[0]] : this.hover ? [this.hover] : [];
		for (const q of sp) { // 吸附预览点
			const [x, y] = this.px(q);
			c.setLineDash([]); c.strokeStyle = "#2f6fed"; c.lineWidth = 1.5;
			c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke();
			this.dot(c, [x, y], 2.5, "#2f6fed");
		}
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
		const head = (tip, from) => {
			const k = Math.atan2(tip[1] - from[1], tip[0] - from[0]), s = 7 + c.lineWidth;
			c.save(); c.setLineDash([]); c.beginPath(); c.moveTo(...tip);
			c.lineTo(tip[0] - s * Math.cos(k - 0.4), tip[1] - s * Math.sin(k - 0.4));
			c.lineTo(tip[0] - s * Math.cos(k + 0.4), tip[1] - s * Math.sin(k + 0.4));
			c.closePath(); c.fill(); c.restore();
		};
		if (head0) head(a, b);
		if (head1) head(b, a);
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
		const label = (q, s, font = "italic 15px serif") => { c.font = font; c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(s, q[0] + 5, q[1] - 3); };
		switch (o.t) {
			case "seg": path([o.a, o.b]); break;
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
			case "pt": { const q = P(o.p); this.dot(c, q, 3.5); if (o.name) label(q, o.name); break; }
			case "mk": { const q = P(o.p); this.dot(c, q, 3.5); label(q, xy(o.p), "13px sans-serif"); break; }
			case "text": { const q = P(o.p); c.font = "16px sans-serif"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(o.s, ...q); break; }
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
		this.bar1.replaceChildren(...TOOLS.map(([k, name]) => B(name, this.tool === k, pick(k))), B("𝑓函数", false, () => this.plot()));
		this.bar2.replaceChildren(
			...COLORS.map((col) => Object.assign(B("", col === this.color, () => { this.color = col; this.build(); }, "dot"), { style: `background:${col}` })),
			B(this.width > 2 ? "粗" : "细", false, () => { this.width = this.width > 2 ? 2 : 4; this.build(); }),
			B("虚线", this.dash, () => { this.dash = !this.dash; this.build(); }),
			B("吸附格点", this.snap, () => { this.snap = !this.snap; this.build(); }),
			B("坐标轴", this.axes, () => { this.axes = !this.axes; this.build(); this.draw(); }),
			B("↶撤销", false, () => this.step(this.hist, this.fut)),
			B("↷重做", false, () => this.step(this.fut, this.hist)),
			B("清空", false, () => this.objs.length && confirm("清空画板？") && this.change(() => (this.objs = []))),
			B(this.big ? "缩小" : "放大", false, () => { this.big = !this.big; this.el.classList.toggle("big", this.big); this.build(); }));
		const tip = this.pend?.p ? "已选点，再点一条线" : this.pend?.dir ? "已选线，再点一个点" : TOOLS.find(([k]) => k === this.tool)[2];
		this.hint.replaceChildren(el("span", { textContent: tip }));
		if (this.pend?.pts) this.hint.append(B("完成", true, () => this.finish()), B("取消", false, () => this.reset()));
	}

	// ---------- 交卷 ----------
	// 文字描述（坐标单位=格），Claude 据此批改，基本不用看图
	describe() {
		const col = { "#d64545": "红", "#2f6fed": "蓝" };
		const pens = this.objs.filter((o) => o.t === "pen").length;
		const parts = this.objs.filter((o) => o.t !== "pen").map((o) => {
			const pre = (o.d ? "虚" : "") + (col[o.c] || "");
			switch (o.t) {
				case "seg": return `${pre}线段${xy(o.a)}${xy(o.b)}`;
				case "line": return `${pre}直线过${xy(o.a)}${xy(o.b)}`;
				case "ray": return `${pre}射线${xy(o.a)}→${xy(o.b)}`;
				case "circle": return `${pre}圆 心${xy(o.a)} 半径${num(dist(o.a, o.b))}`;
				case "poly": return `${pre}多边形${o.pts.map(xy).join("")}`;
				case "curve": return `${pre}曲线过${o.pts.map(xy).join("")}`;
				case "pt": return `点${o.name}${xy(o.p)}`;
				case "mk": return `标点${xy(o.p)}`;
				case "text": return `文字「${o.s}」@${xy(o.p)}`;
				case "ra": return `直角@${xy(o.at)}`;
				case "fn": return `函数 ${o.expr}`;
			}
		});
		if (pens) parts.push(`手绘${pens}笔（见图）`);
		return (this.axes ? "坐标轴；" : "") + parts.join("；");
	}
	toFile() {
		this.draw(); // 先重绘一遍，确保导出清楚
		const s = Math.min(2, 1000 / Math.max(this.W, this.H)), out = document.createElement("canvas");
		out.width = Math.round(this.W * s); out.height = Math.round(this.H * s);
		const c = out.getContext("2d"); c.scale(s, s);
		this.paint(c, false);
		return new Promise((res) => out.toBlob((b) => res(new File([b], "board.jpg", { type: "image/jpeg" })), "image/jpeg", 0.85));
	}
}
