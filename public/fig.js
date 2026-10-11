// 题图：把 Claude 推题时给的画板描述画出来（和作图板同一套画法，单位=格，y 向上），或显示它给的 SVG。
// 位置打磨：按内容自动裁边（留够标签的边距）、居中、按屏幕缩放（不超过半屏高），点的名字放在背离图形中心的一侧；点一下全屏放大看。
const Fig = (() => {
	const COL = { red: "#d64545", blue: "#2f6fed", green: "#3a8a4f", gray: "#8a8178", black: "#111" };
	const isP = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(+n));
	const num2 = (v) => [+v[0], +v[1]];

	// 描述 → 作图板对象
	function objs(spec) {
		const named = {}, items = [...spec.items];
		for (const [n, p] of Object.entries(spec.P || {})) if (isP(p)) { named[n] = num2(p); if (!items.some((o) => o.t === "pt" && o.n === n)) items.unshift({ t: "pt", p, n }); } // P 里定义的点自动画出来
		for (const o of items) if (o.t === "pt" && o.n && isP(o.p)) named[o.n] = num2(o.p);
		const P = (v) => (typeof v === "string" ? named[v.trim()] : isP(v) ? num2(v) : null);
		const list = (v) => (typeof v === "string" ? ([...v].every((ch) => named[ch]) ? [...v] : v.split(/[,，\s]+/)) : v || []); // pts:"ABC" 或 ["A1","B1"]
		const out = [];
		for (const o of items) {
			const s = { c: COL[o.c] || (/^#[0-9a-f]{3,6}$/i.test(o.c || "") ? o.c : "#111"), w: Math.min(4, +o.w || 2), d: !!o.d };
			const a = P(o.a), b = P(o.b);
			switch (o.t) {
				case "pt": if (isP(o.p)) out.push({ ...s, t: "pt", p: num2(o.p), name: o.n || "", noxy: !(o.xy ?? spec.axes) }); break;
				case "seg": case "line": case "ray": case "force": case "light": case "normal": case "mirror": case "lens": case "lens2":
					if (a && b) out.push({ ...s, t: o.t, a, b, name: o.n }); break;
				case "poly": case "curve": { const pts = list(o.pts).map(P).filter(Boolean); if (pts.length > 1) out.push({ ...s, t: o.t, pts }); break; }
				case "circle": { const c = P(o.o ?? o.a), r = +o.r || (c && b ? Math.hypot(b[0] - c[0], b[1] - c[1]) : 0); if (c && r > 0) out.push({ ...s, t: "circle", a: c, b: [c[0] + r, c[1]], nodot: !o.o }); break; }
				case "fn": if (o.expr) out.push({ ...s, t: "fn", expr: /^\s*y\s*=/i.test(o.expr) ? o.expr : "y = " + o.expr, label: o.n || "" }); break; // 解析式标签只在给了 n 时写（题目常常就是要你求它）
				case "text": if (isP(o.p) && o.s != null) out.push({ ...s, t: "text", p: num2(o.p), s: String(o.s) }); break;
				case "right": { const q = P(o.at); if (q && a && b) { const u = [a[0] - q[0], a[1] - q[1]], v = [b[0] - q[0], b[1] - q[1]], lu = Math.hypot(...u), lv = Math.hypot(...v); if (lu && lv) out.push({ ...s, d: false, w: 1.4, t: "ra", at: q, u: [u[0] / lu, u[1] / lu], v: [v[0] / lv, v[1] / lv] }); } break; }
				case "angle": { const q = P(o.at); if (q && a && b) out.push({ ...s, d: false, t: "angle", at: q, a, b, s: o.s, r: +o.r || 0 }); break; }
			}
		}
		// 点名放在背离图形中心的一侧
		const pts = out.flatMap((o) => (o.p ? [o.p] : o.pts ? o.pts : o.a ? [o.a, o.b || o.a] : []));
		const cx = pts.reduce((m, p) => m + p[0], 0) / (pts.length || 1), cy = pts.reduce((m, p) => m + p[1], 0) / (pts.length || 1);
		for (const o of out) if (o.t === "pt") { const dx = o.p[0] - cx, dy = o.p[1] - cy, l = Math.hypot(dx, dy); o.lp = l > 0.05 ? [dx / l, dy / l] : [0.7, 0.7]; }
		return out;
	}

	// 内容的范围（格），给点名、文字、箭头留边
	function bounds(spec, os, fnF) {
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		const put = (p, m = 0) => { x0 = Math.min(x0, p[0] - m); x1 = Math.max(x1, p[0] + m); y0 = Math.min(y0, p[1] - m); y1 = Math.max(y1, p[1] + m); };
		for (const o of os) {
			if (o.t === "pt") put(o.p, o.name || !o.noxy ? 1 : 0.4);
			else if (o.t === "text") { put(o.p, 0.4); put([o.p[0] + o.s.length * 0.6, o.p[1]]); }
			else if (o.t === "circle") { const r = o.b[0] - o.a[0]; put(o.a, r + 0.3); }
			else if (o.pts) o.pts.forEach((p) => put(p, 0.3));
			else if (o.a) { put(o.a, 0.3); put(o.b, o.name ? 1 : 0.3); }
			else if (o.at) put(o.at, 0.5);
		}
		if (spec.axes) put([0, 0], 1);
		const fns = os.filter((o) => o.t === "fn");
		if (fns.length) {
			const xr = spec.x || [Math.min(isFinite(x0) ? x0 : -5, -5), Math.max(isFinite(x1) ? x1 : 5, 5)], yr = spec.y || [-6, 6];
			for (const o of fns) { const f = fnF(o.expr); if (!f) continue; for (let x = xr[0]; x <= xr[1]; x += 0.1) { const y = f(x); if (Number.isFinite(y) && y >= yr[0] && y <= yr[1]) put([x, y]); } }
			put([xr[0], 0]); put([xr[1], 0]);
		}
		if (spec.x) { x0 = spec.x[0]; x1 = spec.x[1]; }
		if (spec.y) { y0 = spec.y[0]; y1 = spec.y[1]; }
		if (!isFinite(x0)) return null;
		const pad = spec.axes ? 0.8 : 0.5;
		return [Math.floor((x0 - pad) * 2) / 2, Math.ceil((x1 + pad) * 2) / 2, Math.floor((y0 - pad) * 2) / 2, Math.ceil((y1 + pad) * 2) / 2];
	}

	// 画到 canvas：maxW/maxH 是显示区域（CSS 像素），sMax 限制放大倍数（小图别放得太粗）
	function canvas(spec, maxW, maxH, sMax) {
		const b = Object.create(Board.prototype);
		Object.assign(b, { axes: !!spec.axes, calc: false, phys: false, fns: new Map(), nogrid: !(spec.grid ?? spec.axes) });
		const os = objs(spec), bb = bounds(spec, os, (e) => b.fn(e));
		if (!bb) return null;
		const [x0, x1, y0, y1] = bb, W = (x1 - x0) * CELL, H = (y1 - y0) * CELL;
		Object.assign(b, { objs: os, W, H, ox: -x0 * CELL, oy: y1 * CELL });
		const s = Math.max(0.5, Math.min(maxW / W, maxH / H, sMax)), dpr = Math.min(devicePixelRatio || 1, 3) * (sMax > 2 ? 1.5 : 1);
		const cv = el("canvas", { width: Math.round(W * s * dpr), height: Math.round(H * s * dpr) });
		const c = cv.getContext("2d");
		c.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
		b.paint(c, false);
		cv.style.width = Math.round(W * s) + "px";
		cv.dataset.ratio = W / H;
		return cv;
	}
	// 电路图：用电路板同一套元件符号；导线不在一条线上自动折直角，三线交汇自动画连接点
	const PARTS_OK = new Set(["cell", "batt", "sw", "lamp", "res", "rheo", "am", "vm", "motor", "bell", "led", "fuse"]);
	function circuit(spec, maxW, maxH, sMax) {
		if (typeof CircuitBoard === "undefined") return null;
		const P = (v) => (isP(v) ? num2(v) : null), os = [];
		for (const o of spec.items) {
			if (o.t === "wire") {
				const pts = (o.pts || [o.a, o.b]).map(P).filter(Boolean), w = [];
				pts.forEach((q, i) => { if (i && pts[i - 1][0] !== q[0] && pts[i - 1][1] !== q[1]) w.push([q[0], pts[i - 1][1]]); w.push(q); });
				if (w.length > 1) os.push({ t: "wire", pts: w });
			} else if (o.t === "text" && P(o.p)) os.push({ t: "text", p: P(o.p), s: String(o.s ?? "") });
			else if (PARTS_OK.has(o.t) && P(o.a) && P(o.b)) os.push({ t: o.t, a: P(o.a), b: P(o.b), name: o.n || "", on: !!o.on });
		}
		const all = os.flatMap((o) => o.pts || (o.p ? [o.p, [o.p[0] + o.s.length * 0.6, o.p[1]]] : [o.a, o.b]));
		if (!all.length) return null;
		const x0 = Math.min(...all.map((p) => p[0])) - 1, y0 = Math.min(...all.map((p) => p[1])) - 1, x1 = Math.max(...all.map((p) => p[0])) + 1, y1 = Math.max(...all.map((p) => p[1])) + 1;
		const mv = (p) => [p[0] - x0, p[1] - y0], CCc = 28;
		const objs2 = os.map((o) => (o.pts ? { ...o, pts: o.pts.map(mv) } : o.p ? { ...o, p: mv(o.p) } : { ...o, a: mv(o.a), b: mv(o.b) }));
		const W = (x1 - x0) * CCc + CCc, H = (y1 - y0) * CCc + CCc;
		const b = Object.assign(Object.create(CircuitBoard.prototype), { objs: objs2, W, H, check: false, clean: true, stat: {} });
		const s = Math.max(0.5, Math.min(maxW / W, maxH / H, sMax)), dpr = Math.min(devicePixelRatio || 1, 3) * (sMax > 2 ? 1.5 : 1);
		const cv = el("canvas", { width: Math.round(W * s * dpr), height: Math.round(H * s * dpr) }), c = cv.getContext("2d");
		c.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
		b.paint(c, false);
		cv.style.width = Math.round(W * s) + "px";
		cv.dataset.ratio = W / H;
		return cv;
	}
	const draw = (spec, maxW, maxH, sMax) => (spec.circuit ? circuit : canvas)(spec, maxW, maxH, sMax);
	const svgImg = (f) => {
		const svg = /xmlns=/.test(f.svg) ? f.svg : f.svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
		return el("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg), alt: "题图" });
	};

	// 放大：全屏浮层，按屏幕重画一张更大的；点任意处关闭
	function zoom(spec) {
		const pic = spec.svg ? svgImg(spec) : draw(spec, innerWidth - 32, innerHeight * 0.82, 4);
		if (!pic) return;
		if (spec.svg) pic.style.width = Math.min(innerWidth - 32, (spec.w || 480) * 2) + "px";
		const box = el("div", { className: "figzoom", onclick: () => box.remove() }, pic, el("p", { textContent: "点任意处关闭" }));
		document.body.append(box);
	}

	/** 题图元素（spec 为空返回 ""，可直接 append）。where：main 题目卡片 / side 平板左栏和题干浮窗 / small 结果页、错题本 / chat Max 回答里 */
	const memo = new WeakMap(); // 同一道题重绘（点选项、开画板）时复用画好的图，不重画
	function view(spec, where = "main") {
		if (!spec || (!spec.svg && !spec.items?.length)) return "";
		const key = memo.get(spec) || {};
		if (key[where]) return key[where];
		memo.set(spec, key);
		return (key[where] = build(spec, where));
	}
	function build(spec, where) {
		const maxH = where === "small" ? 220 : where === "side" || where === "chat" ? 260 : Math.min(360, innerHeight * 0.46);
		const pic = spec.svg ? svgImg(spec) : draw(spec, where === "side" || where === "chat" ? 320 : 560, maxH, 1.6);
		if (!pic) return "";
		// 宽度三选一取最小：容器宽、画布原本大小、按高度上限反推的宽 → 等比缩放不变形，不占满半屏以上
		if (spec.svg) pic.style.width = `min(100%, ${spec.w || 480}px)`;
		else pic.style.width = `min(100%, ${pic.style.width}, ${maxH * +pic.dataset.ratio}px)`;
		return el("figure", { className: "qfig " + where, title: "点一下放大", onclick: (e) => { e.stopPropagation(); zoom(spec); } }, pic);
	}
	/** 宽容解析模型写的 JSON：去掉代码块记号、单引号、结尾多余逗号、没加引号的键 */
	function parse(s) {
		s = String(s).trim().replace(/^```(json)?|```$/g, "");
		try { return JSON.parse(s); } catch {}
		try { return JSON.parse(s.replace(/'/g, '"').replace(/,\s*([\]}])/g, "$1").replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')); } catch { return null; }
	}
	return { view, parse };
})();
