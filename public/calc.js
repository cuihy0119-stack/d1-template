// 计算解答板：横线纸手写板（和作图板同一套：画笔/算式/文字/橡皮/撤销/放大），「＝算式」写完自动出得数、方程自动解；
// 旁边计算器；需要时展开「打字整理步骤」（MathLive 公式输入，初中定制键盘）。
// 交卷：算式结果和步骤都是文字（省用量），只有手写了才附图。

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
		Object.assign(this, { kind: "calc", vals: [""] });
		this.pad = new Board({ calc: true });
		this.panel = this.buildCalc();
		this.pad.extra = () => [el("button", { type: "button", className: this.panel.hidden ? "" : "on", textContent: "🧮计算器",
			onclick: () => { this.panel.hidden = !this.panel.hidden; this.pad.build(); } })];
		this.pad.build();
		this.lines = el("div", { className: "clines", hidden: true });
		this.lines.addEventListener("keydown", (e) => { // 回车 = 下一步
			const i = this.fields?.indexOf(e.target);
			if (e.key === "Enter" && i >= 0) { e.preventDefault(); e.stopPropagation(); this.addLine(i + 1); }
		}, { capture: true });
		const more = el("button", { type: "button", className: "btn small", textContent: "📝 打字整理步骤（Claude 读文字更准更省）", onclick: () => {
			more.remove(); this.lines.hidden = false; this.lines.textContent = "公式键盘加载中…";
			loadMathLive().then(() => this.renderLines(0), (e) => (this.lines.textContent = e.message));
		} });
		this.el = el("div", { className: "calc" }, this.pad.el, this.panel, el("div", { style: "margin-top:8px" }, more), this.lines);
	}
	isEmpty() { this.sync(); return this.pad.isEmpty() && !this.vals.some((v) => v.trim()); }
	hasPen() { return this.pad.hasPen(); }
	toFile() { return this.pad.toFile(); }
	describe() {
		this.sync();
		const steps = this.vals.map((v) => v.trim()).filter(Boolean).map((v, i) => `${i + 1}) $${v}$`);
		return [this.pad.isEmpty() ? "" : "画板：" + this.pad.describe(), steps.length ? "步骤：\n" + steps.join("\n") : ""].filter(Boolean).join("\n");
	}

	// ---------- 计算器：同一套算式规则；可把结果贴到画板 ----------
	buildCalc() {
		const out = el("b"), inp = el("input", { type: "text", placeholder: "如 (3/4-1/6)×12、√48、x²-5x+6=0", oninput: () => show() });
		const show = () => { const v = inp.value.trim(), r = v && calcText(v); out.textContent = !v ? "" : r === v ? "…" : r.slice(v.length); };
		const put = (k) => { inp.value = k === "C" ? "" : k === "⌫" ? inp.value.slice(0, -1) : inp.value + ({ "√": "√(", "x²": "²" }[k] || k); show(); };
		const keys = ["7", "8", "9", "÷", "(", ")", "4", "5", "6", "×", "√", "x²", "1", "2", "3", "−", "π", "^", "0", ".", "x", "+", "=", "⌫"];
		const paste = () => {
			const v = inp.value.trim(), b = this.pad;
			if (!v) return;
			let y = Math.floor(b.oy / CELL) - 1; // 从上往下找第一行空行
			while (y > -b.H / CELL && b.objs.some((o) => o.p && Math.abs(o.p[1] - y) < 1)) y--;
			b.add({ t: "text", p: [Math.ceil(-b.ox / CELL) + 1, y], s: calcText(v) });
		};
		return el("div", { className: "calcpad", hidden: true },
			el("div", { className: "row" }, inp, el("div", { className: "res" }, out)),
			el("div", { className: "keysg" }, ...keys.map((k) => el("button", { type: "button", textContent: k, onclick: () => put(k) })),
				el("button", { type: "button", textContent: "C", onclick: () => put("C") }),
				el("button", { type: "button", className: "wide", textContent: "📌 贴到画板", onclick: paste })));
	}

	// ---------- 打字步骤（MathLive） ----------
	sync() { this.fields?.forEach((mf, i) => (this.vals[i] = mf.value)); } // 以公式框当前内容为准
	renderLines(focus) {
		this.fields = this.vals.map((v, i) => {
			const mf = new MathfieldElement();
			mf.value = v;
			mf.addEventListener("input", () => (this.vals[i] = mf.value));
			return mf;
		});
		this.lines.replaceChildren(...this.fields.map((mf, i) => el("div", { className: "cline" },
			el("b", { textContent: i + 1 }), mf,
			el("button", { type: "button", textContent: "×", title: "删掉这一步", onclick: () => this.delLine(i) }))),
			el("button", { type: "button", className: "btn small", textContent: "＋ 下一步", onclick: () => this.addLine(this.vals.length) }));
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
}
