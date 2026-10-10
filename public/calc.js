// 计算解答板（数学）：一行写一步，用 MathLive 公式输入（分式、根号、上下标像纸上一样所见即所得，参考 MathLive / Desmos 的虚拟键盘），
// 键盘按初中范围定制；下方有横格草稿区（手写）和验算器。交卷时步骤转成 LaTeX 文字发给 Claude，只有手写了才附图（省用量）。

let mathLiveReady;
function loadMathLive() {
	mathLiveReady ??= new Promise((res, rej) => {
		const s = el("script", { src: "/mathlive/mathlive.min.js" });
		s.onload = () => {
			MathfieldElement.fontsDirectory = "/katex/fonts"; // 字体与 KaTeX 同名，共用一份
			MathfieldElement.soundsDirectory = null;
			const K = (latex, extra) => ({ latex, ...extra });
			const nav = ["[left]", "[right]", "[backspace]"];
			mathVirtualKeyboard.layouts = [
				{ label: "123", tooltip: "数字运算", rows: [
					["[7]", "[8]", "[9]", K("\\div"), "[separator-5]", "x", "y", "[(]", "[)]"],
					["[4]", "[5]", "[6]", K("\\times"), "[separator-5]", K("\\frac{#@}{#?}"), K("\\sqrt{#0}"), K("\\sqrt[3]{#0}"), K("\\left|#0\\right|")],
					["[1]", "[2]", "[3]", "[-]", "[separator-5]", K("#@^2"), K("#@^{#?}"), K("#@_{#?}"), K("\\pm")],
					["[0]", "[.]", "[=]", "[+]", "[separator-5]", ...nav, "[hide-keyboard]"],
				] },
				{ label: "∵∴", tooltip: "符号、几何", rows: [
					[K("\\neq"), K("\\approx"), K("<"), K(">"), K("\\le"), K("\\ge"), K("\\pi"), K("{}^\\circ")],
					[K("\\because"), K("\\therefore"), K("\\Rightarrow"), K("\\Leftrightarrow"), K("\\angle"), K("\\triangle"), K("\\perp"), K("\\parallel")],
					[K("\\cong"), K("\\backsim"), K("\\sin"), K("\\cos"), K("\\tan"), K("\\%"), K("x_1"), K("x_2")],
					[K("\\begin{cases}#?\\\\#?\\end{cases}", { label: "方程组" }), K("\\text{解：}", { label: "解：" }), K("\\text{或}", { label: "或" }), ...nav, "[hide-keyboard]"],
				] },
				"alphabetic",
			];
			res();
		};
		s.onerror = () => { mathLiveReady = null; rej(new Error("公式键盘加载失败")); };
		document.head.append(s);
	});
	return mathLiveReady;
}

class CalcBoard {
	constructor() {
		Object.assign(this, { kind: "calc", vals: [""], strokes: [], hist: [], fut: [], color: "#111111", erase: false, big: false });
		this.lines = el("div", { className: "clines" });
		this.check = el("div", { className: "ccheck" });
		this.cv = el("canvas");
		this.wrap = el("div", { className: "cpad" }, this.cv);
		this.bar = el("div", { className: "btools" });
		this.el = el("div", { className: "board calc" },
			el("div", { className: "bhint" }, el("span", { textContent: "一行写一步，回车换下一行；点公式框弹出数学键盘（123 / ∵∴ / abc 切换）" })),
			this.lines,
			el("div", { className: "row", style: "margin:6px 0" }, el("button", { type: "button", className: "btn small", textContent: "＋ 下一步", onclick: () => this.addLine(this.vals.length) })),
			this.check,
			el("div", { className: "bhint" }, el("span", { textContent: "草稿区（手写，交卷会附图）" })), this.bar, this.wrap);
		this.lines.textContent = "公式键盘加载中…";
		this.lines.addEventListener("keydown", (e) => { // 回车 = 下一步
			const i = this.fields?.indexOf(e.target);
			if (e.key === "Enter" && i >= 0) { e.preventDefault(); e.stopPropagation(); this.addLine(i + 1); }
		}, { capture: true });
		loadMathLive().then(() => this.renderLines(), (e) => (this.lines.textContent = e.message));
		this.buildCheck();
		this.buildBar();
		this.bindPad();
		new ResizeObserver(() => this.resize()).observe(this.wrap);
	}
	isEmpty() { this.sync(); return !this.vals.some((v) => v.trim()) && !this.strokes.length; }
	hasPen() { return this.strokes.length > 0; }

	// ---------- 公式行 ----------
	sync() { this.fields?.forEach((mf, i) => (this.vals[i] = mf.value)); } // 以公式框当前内容为准
	renderLines(focus) {
		if (!window.MathfieldElement) return;
		this.fields = this.vals.map((v, i) => {
			const mf = new MathfieldElement();
			mf.value = v;
			mf.addEventListener("input", () => (this.vals[i] = mf.value));
			return mf;
		});
		this.lines.replaceChildren(...this.fields.map((mf, i) => el("div", { className: "cline" },
			el("b", { textContent: i + 1 }), mf,
			el("button", { type: "button", textContent: "×", title: "删掉这一步", onclick: () => this.delLine(i) }))));
		if (focus != null) setTimeout(() => this.fields[focus]?.focus());
	}
	addLine(i) { this.sync(); this.vals.splice(i, 0, ""); this.renderLines(i); }
	delLine(i) {
		this.sync();
		if (this.vals[i].trim() && !confirm("删掉第 " + (i + 1) + " 步？")) return;
		this.vals.splice(i, 1);
		if (!this.vals.length) this.vals.push("");
		this.renderLines();
	}
	mount() { // 题目切换后重新挂到页面上，确保公式框内容还在
		requestAnimationFrame(() => this.fields?.forEach((mf, i) => !mf.value && this.vals[i] && (mf.value = this.vals[i])));
	}

	// ---------- 验算器（用作图板的式子解析，不发给 Claude） ----------
	buildCheck() {
		const out = el("span", { className: "mute" });
		const inp = el("input", { type: "text", placeholder: "验算：如 (3/4-1/6)*12 或 sqrt(48)", oninput: () => {
			const s = inp.value.trim();
			if (!s) return (out.textContent = "");
			try { const v = compileFn(s)(0); out.textContent = Number.isFinite(v) ? "= " + fmt(v) : "无意义"; } catch { out.textContent = "…"; }
		} });
		this.check.replaceChildren(el("span", { textContent: "🧮" }), inp, out);
	}

	// ---------- 草稿区：横格纸手写 ----------
	resize() {
		const W = this.wrap.clientWidth, H = this.wrap.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
		if (!W || !H) return;
		Object.assign(this, { W, H });
		this.cv.width = W * dpr; this.cv.height = H * dpr;
		this.cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}
	at(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
	change(fn) { this.hist.push(JSON.stringify(this.strokes)); this.fut = []; fn(); this.draw(); }
	step(from, to) { if (!from.length) return; to.push(JSON.stringify(this.strokes)); this.strokes = JSON.parse(from.pop()); this.draw(); }
	bindPad() {
		const cv = this.cv;
		const rub = (p) => { const i = this.strokes.findIndex((s) => s.pts.some((q) => dist(p, q) < 12)); if (i >= 0) this.change(() => this.strokes.splice(i, 1)); };
		cv.addEventListener("pointerdown", (e) => {
			if (!e.isPrimary) return;
			cv.setPointerCapture(e.pointerId);
			if (this.erase) { this.rubbing = true; return rub(this.at(e)); }
			this.cur = { c: this.color, pts: [this.at(e)] };
		});
		cv.addEventListener("pointermove", (e) => {
			if (this.rubbing) return rub(this.at(e));
			if (this.cur) { this.cur.pts.push(this.at(e)); this.draw(); }
		});
		const up = () => {
			this.rubbing = false;
			const s = this.cur; this.cur = null;
			if (s) this.change(() => this.strokes.push(s.pts.length > 1 ? s : { ...s, pts: [s.pts[0], [s.pts[0][0] + 0.5, s.pts[0][1]]] }));
		};
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointercancel", up);
	}
	draw() { if (this.W && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(this.cv.getContext("2d")); }); }
	paint(c) {
		const { W, H } = this;
		c.fillStyle = "#fffdf6"; c.fillRect(0, 0, W, H);
		c.strokeStyle = "#dfe6f0"; c.lineWidth = 1; c.beginPath();
		for (let y = 32; y < H; y += 32) { c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); }
		c.stroke();
		c.lineCap = c.lineJoin = "round"; c.lineWidth = 2.2;
		for (const s of this.cur ? [...this.strokes, this.cur] : this.strokes) {
			c.strokeStyle = s.c; c.beginPath();
			s.pts.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q)));
			c.stroke();
		}
	}
	buildBar() {
		const B = (text, on, onclick, cls = "") => el("button", { type: "button", className: cls + (on ? " on" : ""), textContent: text, onclick });
		const fab = (t, title, f) => el("button", { type: "button", className: "fab", textContent: t, title, onclick: f });
		this.bar.replaceChildren(
			...COLORS.map((col) => Object.assign(B("", !this.erase && col === this.color, () => { this.color = col; this.erase = false; this.buildBar(); }, "dot"), { style: `background:${col}` })),
			B("⌫橡皮", this.erase, () => { this.erase = !this.erase; this.buildBar(); }),
			B("清空", false, () => this.strokes.length && confirm("清空草稿？") && this.change(() => (this.strokes = []))),
			B(this.big ? "缩小" : "放大", false, () => { this.big = !this.big; this.el.classList.toggle("big", this.big); this.buildBar(); }),
			fab("↶", "撤销", () => this.step(this.hist, this.fut)), fab("↷", "重做", () => this.step(this.fut, this.hist)));
	}

	// ---------- 交卷 ----------
	describe() {
		this.sync();
		const steps = this.vals.map((v) => v.trim()).filter(Boolean).map((v, i) => `${i + 1}) $${v}$`);
		return (steps.length ? steps.join("\n") : "（无公式步骤）") + (this.hasPen() ? `\n草稿手写${this.strokes.length}笔，见图` : "");
	}
	toFile() {
		const s = Math.min(2, 600 / Math.max(this.W, this.H)), out = document.createElement("canvas");
		out.width = Math.round(this.W * s); out.height = Math.round(this.H * s);
		const c = out.getContext("2d"); c.scale(s, s);
		this.paint(c);
		return new Promise((res) => out.toBlob((b) => res(new File([b], "board.jpg", { type: "image/jpeg" })), "image/jpeg", 0.85));
	}
}

// 小数尽量还原成分数（分母 ≤ 1000），如 0.41666… → 5/12
function fmt(v) {
	const r = Math.round(v * 1e9) / 1e9;
	if (Number.isInteger(r)) return String(r);
	for (let d = 2; d <= 1000; d++) { const n = Math.round(v * d); if (Math.abs(n / d - v) < 1e-9) return `${n}/${d} ≈ ${+v.toFixed(6)}`; }
	return String(+v.toFixed(8));
}
