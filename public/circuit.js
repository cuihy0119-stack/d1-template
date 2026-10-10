// 电路图板（物理，限初中）：元件和导线都吸附格点。参考 PhET「电路实验室」/ Falstad：拖动放元件、拖动连导线、点开关切换通断。
// 交卷时 describe() 用代码算出网表（每个元件两端接在哪个节点）+ 串并联/短路提示，Claude 直接核对，配小图看整体。

const PARTS = { // 键: [按钮, 名称, 默认编号前缀]
	cell: ["🔋电源", "电源", "电源"],
	sw: ["⏻开关", "开关", "S"],
	lamp: ["⊗灯泡", "灯泡", "L"],
	res: ["▭电阻", "定值电阻", "R"],
	rheo: ["⇘滑变", "滑动变阻器", "R′"],
	am: ["Ⓐ电流表", "电流表", "A"],
	vm: ["Ⓥ电压表", "电压表", "V"],
	motor: ["Ⓜ电动机", "电动机", "M"],
	bell: ["◖电铃", "电铃", "电铃"],
	led: ["▷|LED", "发光二极管", "LED"],
};
const CTOOLS = [
	["wire", "〰导线", "从一个格点拖到另一个格点；不在一条线上会自动折成直角"],
	...Object.entries(PARTS).map(([k, [b, n]]) => [k, b, `拖动放${n}（两端吸附格点），点一下默认横放`]),
	["flip", "⇄翻转", "点电源/LED 换正负方向；点开关切换断开/闭合"],
	["name", "✎改名", "点元件改编号，如 L1、R2"],
	["text", "T文字", "点一下写字，如滑片端 a、b"],
	["erase", "⌫橡皮", "点一下删除元件或导线"],
];
const CC = 28; // 格距

class CircuitBoard {
	constructor() {
		Object.assign(this, { kind: "circuit", objs: [], hist: [], fut: [], tool: "wire", big: false });
		this.cv = el("canvas");
		this.wrap = el("div", { className: "bwrap" }, this.cv);
		this.bar1 = el("div", { className: "btools" });
		this.hint = el("div", { className: "bhint" });
		this.el = el("div", { className: "board" }, this.bar1, this.hint, this.wrap);
		this.ctx = this.cv.getContext("2d");
		this.bind();
		this.build();
		new ResizeObserver(() => this.resize()).observe(this.wrap);
	}
	isEmpty() { return !this.objs.length; }

	resize() {
		const W = this.wrap.clientWidth, H = this.wrap.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
		if (!W || !H) return;
		Object.assign(this, { W, H });
		this.cv.width = W * dpr; this.cv.height = H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}
	px(q) { return [CC / 2 + q[0] * CC, CC / 2 + q[1] * CC]; } // 格点坐标（x 向右、y 向下），左上角格点为 (0,0)
	at(e) {
		const r = this.cv.getBoundingClientRect();
		const raw = [(e.clientX - r.left - CC / 2) / CC, (e.clientY - r.top - CC / 2) / CC];
		return [raw.map(Math.round), raw];
	}

	change(fn) { this.hist.push(JSON.stringify(this.objs)); this.fut = []; fn(); this.draw(); }
	step(from, to) { if (!from.length) return; to.push(JSON.stringify(this.objs)); this.objs = JSON.parse(from.pop()); this.draw(); }

	// 元件只能横放或竖放，至少 2 格长
	place(a, b) {
		let d = [b[0] - a[0], b[1] - a[1]];
		if (!d[0] && !d[1]) d = [2, 0];
		const ax = Math.abs(d[0]) >= Math.abs(d[1]) ? 0 : 1, len = Math.max(2, Math.abs(d[ax])) * Math.sign(d[ax] || 1);
		const e = [...a]; e[ax] += len;
		return e;
	}
	route(a, b) { return a[0] === b[0] || a[1] === b[1] ? [a, b] : [a, [b[0], a[1]], b]; } // 导线：先横后竖

	bind() {
		const cv = this.cv;
		cv.addEventListener("pointerdown", (e) => {
			if (!e.isPrimary) return;
			cv.setPointerCapture(e.pointerId);
			const [p, raw] = this.at(e), t = this.tool;
			if (["erase", "flip", "name", "text"].includes(t)) return this.tapAct(p, raw);
			this.drag = { a: p, b: p };
			this.draw();
		});
		cv.addEventListener("pointermove", (e) => {
			const [p] = this.at(e);
			if (this.drag) this.drag.b = p; else this.hover = e.pointerType === "mouse" ? p : null;
			this.draw();
		});
		const up = () => {
			const d = this.drag; this.drag = null;
			if (!d) return this.draw();
			if (this.tool === "wire") { if (dist(d.a, d.b) > 0) this.change(() => this.objs.push({ t: "wire", pts: this.route(d.a, d.b) })); else this.draw(); return; }
			const t = this.tool, used = new Set(this.objs.map((o) => o.name));
			const pre = PARTS[t][2];
			let n = 1, name = /^[A-Z]$/.test(pre) ? pre + 1 : pre; // S1、L1…；电源、R′ 第一个不带号
			while (used.has(name)) name = pre + ++n;
			this.change(() => this.objs.push({ t, a: d.a, b: this.place(d.a, d.b), name, on: false }));
		};
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointercancel", up);
		cv.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
	}
	toggle(i) { this.change(() => (this.objs[i].on = !this.objs[i].on)); }
	tapAct(p, raw) {
		const t = this.tool, i = this.hit(raw), o = this.objs[i];
		if (t === "text") return this.ask(p, "", (s) => s && this.change(() => this.objs.push({ t: "text", p, s })));
		if (i < 0) return;
		if (t === "erase") this.change(() => this.objs.splice(i, 1));
		else if (t === "flip" && o.t === "sw") this.toggle(i);
		else if (t === "flip" && o.a) this.change(() => ([o.a, o.b] = [o.b, o.a]));
		else if (t === "name" && PARTS[o.t]) this.ask(o.a, o.name, (s) => s && this.change(() => (o.name = s)));
	}
	ask(p, def, done) { // 在画板上直接打字（同作图板）
		const [x, y] = this.px(p);
		const inp = el("input", { type: "text", value: def, className: "btext", style: `left:${Math.min(x, this.W - 120)}px;top:${Math.max(0, y - 30)}px` });
		let ok = true;
		const close = () => { if (!inp.isConnected) return; const v = inp.value.trim(); inp.remove(); ok ? done(v) : this.draw(); };
		inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { ok = false; inp.blur(); } };
		inp.onblur = close;
		this.wrap.append(inp);
		setTimeout(() => { inp.focus(); inp.select(); });
	}

	segs(o) { return o.t === "wire" ? o.pts.slice(1).map((q, i) => [o.pts[i], q]) : o.a ? [[o.a, o.b]] : []; }
	hit(p) {
		let best = -1, bd = 0.45;
		this.objs.forEach((o, i) => {
			const d = o.t === "text" ? dist(p, o.p) : Math.min(9, ...this.segs(o).map(([a, b]) => dist(p, proj(p, a, b, "seg"))));
			if (d <= bd) { bd = d; best = i; }
		});
		return best;
	}

	// ---------- 网表：导线连通的格点并成一个节点；导线端点落在另一根导线中间也算连上（T 形接头），单纯交叉不算 ----------
	nets() {
		const par = new Map(), key = (q) => q.join(",");
		const find = (k) => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
		const add = (k) => par.has(k) || par.set(k, k);
		const join = (a, b) => { add(a); add(b); par.set(find(a), find(b)); };
		const wires = this.objs.filter((o) => o.t === "wire"), parts = this.objs.filter((o) => PARTS[o.t]);
		const ends = [...wires.flatMap((w) => [w.pts[0], w.pts.at(-1)]), ...parts.flatMap((o) => [o.a, o.b])];
		ends.forEach((q) => add(key(q)));
		for (const w of wires) for (const [a, b] of this.segs(w)) {
			join(key(a), key(b));
			for (const q of ends) if (dist(q, proj(q, a, b, "seg")) < 1e-9) join(key(q), key(a));
		}
		// 节点编号：按元件出现顺序 1、2、3…
		const id = new Map(), of = (q) => { const r = find(key(q)); if (!id.has(r)) id.set(r, id.size + 1); return id.get(r); };
		const deg = new Map(); // 每个格点连了几根线头，≥3 画连接点
		for (const w of wires) for (const [a, b] of this.segs(w)) for (const q of [a, b]) deg.set(key(q), (deg.get(key(q)) || 0) + 1);
		for (const o of parts) for (const q of [o.a, o.b]) deg.set(key(q), (deg.get(key(q)) || 0) + 1);
		for (const q of ends) for (const w of wires) for (const [a, b] of this.segs(w)) // T 形接头：中间被接上的那根线算 2 个线头
			if (dist(q, a) > 1e-9 && dist(q, b) > 1e-9 && dist(q, proj(q, a, b, "seg")) < 1e-9) deg.set(key(q), (deg.get(key(q)) || 0) + 2);
		return { parts, of, deg };
	}

	describe() {
		const { parts, of } = this.nets();
		const N = parts.map((o) => [of(o.a), of(o.b)]);
		const out = parts.map((o, i) => {
			const [x, y] = N[i], nm = PARTS[o.t][1];
			if (o.t === "cell") return `${o.name}(正极→节点${x}，负极→节点${y})`;
			if (o.t === "led") return `${o.name}${nm}(正→节点${x}，负→节点${y})`;
			return `${o.name}${nm}${o.t === "sw" ? (o.on ? "(闭合)" : "(断开)") : ""}(节点${x}-${y})`;
		});
		const notes = [];
		const same = new Map();
		N.forEach(([x, y], i) => {
			if (x === y) notes.push(`${parts[i].name}两端被导线直接连通（短接）`);
			else { const k = [x, y].sort((m, n) => m - n).join("-"); same.set(k, [...(same.get(k) || []), parts[i].name]); }
		});
		for (const [k, v] of same) if (v.length > 1) notes.push(`${v.join("、")}都接在节点${k}之间（并联）`);
		const cnt = new Map();
		N.flat().forEach((n) => cnt.set(n, (cnt.get(n) || 0) + 1));
		for (const [n, c] of cnt) if (c === 1) notes.push(`节点${n}只接了一个元件（断头）`);
		const texts = this.objs.filter((o) => o.t === "text").map((o) => `文字「${o.s}」`);
		return `电路图：${out.join("；")}` + (notes.length ? `｜提示：${notes.join("；")}` : "") + (texts.length ? `｜${texts.join("")}` : "");
	}

	// ---------- 绘制 ----------
	draw() { if (this.W && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(this.ctx, true); }); }
	paint(c, live) {
		const { W, H } = this;
		c.fillStyle = "#fff"; c.fillRect(0, 0, W, H);
		c.fillStyle = "#cfd5df";
		for (let x = CC / 2; x < W; x += CC) for (let y = CC / 2; y < H; y += CC) c.fillRect(x - 1, y - 1, 2, 2);
		const list = [...this.objs];
		if (live && this.drag) list.push(this.tool === "wire" ? { t: "wire", pts: this.route(this.drag.a, this.drag.b) } : { t: this.tool, a: this.drag.a, b: this.place(this.drag.a, this.drag.b), name: "" });
		for (const o of list) this.obj(c, o);
		// 连接点：三根及以上线头汇合处画实心点
		const { deg } = this.nets();
		c.fillStyle = "#111";
		for (const [k, n] of deg) if (n >= 3) { const [x, y] = this.px(k.split(",").map(Number)); c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.fill(); }
		if (!live) return;
		const cur = this.drag?.b || this.hover;
		if (cur) { const [x, y] = this.px(cur); c.strokeStyle = "#2f6fed"; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke(); }
		if (this.drag) { const [x, y] = this.px(this.drag.a); c.fillStyle = "#2f6fed"; c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill(); }
	}
	obj(c, o) {
		c.strokeStyle = c.fillStyle = "#111"; c.lineWidth = 2; c.lineCap = c.lineJoin = "round"; c.setLineDash([]);
		const line = (...pts) => { c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); c.stroke(); };
		if (o.t === "wire") return line(...o.pts.map((q) => this.px(q)));
		if (o.t === "text") { const [x, y] = this.px(o.p); c.font = "italic 16px serif"; c.textAlign = "left"; c.textBaseline = "middle"; return c.fillText(o.s, x, y); }
		const A = this.px(o.a), B = this.px(o.b), L = dist(A, B), u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], n = [-u[1], u[0]];
		const M = lerp(A, B, 0.5), P = (s, t = 0) => [M[0] + u[0] * s + n[0] * t, M[1] + u[1] * s + n[1] * t]; // s 沿线，t 垂直
		const h = { cell: 4, sw: 18, led: 9, res: 14, rheo: 14 }[o.t] ?? 12, r = 12;
		line(A, P(-h)); line(P(h), B);
		const poly = (...pts) => { c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); c.closePath(); c.fillStyle = "#fff"; c.fill(); c.stroke(); c.fillStyle = "#111"; };
		const circ = (s) => { c.beginPath(); c.arc(...M, r, 0, 7); c.fillStyle = "#fff"; c.fill(); c.stroke(); c.fillStyle = "#111"; if (s) { c.font = "bold 14px sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(s, ...M); } };
		switch (o.t) {
			case "cell": line(P(-4, -13), P(-4, 13)); c.lineWidth = 4; line(P(4, -7), P(4, 7)); c.lineWidth = 2; // 长线=正极（靠 a 端）
				c.font = "12px sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("+", ...P(-12, -12)); break;
			case "sw": c.beginPath(); c.arc(...P(-h), 2.5, 0, 7); c.arc(...P(h), 2.5, 0, 7); c.fill();
				line(P(-h), o.on ? P(h) : P(h - 3, -13)); break;
			case "lamp": circ(); line(P(-8.5, -8.5), P(8.5, 8.5)); line(P(-8.5, 8.5), P(8.5, -8.5)); break;
			case "res": case "rheo": poly(P(-14, -6), P(14, -6), P(14, 6), P(-14, 6));
				if (o.t === "rheo") { line(P(-12, 11), P(12, -13)); line(P(5, -12), P(12, -13), P(11, -6)); } // 斜箭头表示阻值可调
				break;
			case "am": circ("A"); break;
			case "vm": circ("V"); break;
			case "motor": circ("M"); break;
			case "bell": poly(...Array.from({ length: 13 }, (_, i) => P(-12 * Math.cos((i * Math.PI) / 12), -12 * Math.sin((i * Math.PI) / 12)))); break; // 半圆罩
			case "led": poly(P(-h, -8), P(-h, 8), P(h, 0));
				line(P(h, -8), P(h, 8)); line(P(2, -10), P(8, -17)); line(P(7, -9), P(13, -16)); break;
		}
		if (o.name) { c.font = "italic 14px serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#d64545"; c.fillText(o.name, M[0] + (u[0] ? 0 : 24), M[1] + (u[0] ? 24 : 0)); }
	}

	build() {
		const B = (text, on, onclick) => el("button", { type: "button", className: on ? "on" : "", textContent: text, onclick });
		this.bar1.replaceChildren(...CTOOLS.map(([k, name]) => B(name, this.tool === k, () => { this.tool = k; this.build(); })),
			B("清空", false, () => this.objs.length && confirm("清空电路？") && this.change(() => (this.objs = []))),
			B(this.big ? "缩小" : "放大", false, () => { this.big = !this.big; this.el.classList.toggle("big", this.big); this.build(); }));
		this.hint.replaceChildren(el("span", { textContent: CTOOLS.find(([k]) => k === this.tool)[2] }));
		const fab = (t, title, f) => el("button", { type: "button", className: "fab", textContent: t, title, onclick: f });
		this.hint.append(fab("↶", "撤销", () => this.step(this.hist, this.fut)), fab("↷", "重做", () => this.step(this.fut, this.hist)));
	}
	toFile() { return Board.prototype.toFile.call(this); } // 同作图板：600px 小图
}
