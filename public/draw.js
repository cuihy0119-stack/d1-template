// 画板：手指/笔写写画画，完成后返回一张图片（File）
function openDraw() {
	return new Promise((resolve) => {
		const COLORS = ["#111111", "#d64545", "#2f6fed"];
		let color = COLORS[0], width = 3, erase = false, grid = false, strokes = [], cur = null;

		const wrap = el("div", { className: "wrap" });
		const cv = el("canvas");
		wrap.append(cv);
		const ctx = cv.getContext("2d");
		const tools = el("div", { className: "tools" });
		const root = el("div", { className: "draw" }, tools, wrap);

		function size() {
			const r = wrap.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
			cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			redraw();
		}
		function drawGrid(c, w, h) {
			c.strokeStyle = "#e3e6ec"; c.lineWidth = 1; c.beginPath();
			for (let x = 0; x <= w; x += 24) { c.moveTo(x, 0); c.lineTo(x, h); }
			for (let y = 0; y <= h; y += 24) { c.moveTo(0, y); c.lineTo(w, y); }
			c.stroke();
		}
		function paint(c, w, h) {
			c.fillStyle = "#fff"; c.fillRect(0, 0, w, h);
			if (grid) drawGrid(c, w, h);
			c.lineCap = "round"; c.lineJoin = "round";
			for (const s of strokes) {
				c.strokeStyle = s.erase ? "#fff" : s.color; c.lineWidth = s.erase ? s.width * 4 : s.width;
				c.beginPath();
				s.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				if (s.pts.length === 1) c.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
				c.stroke();
			}
		}
		function redraw() { const r = wrap.getBoundingClientRect(); paint(ctx, r.width, r.height); }

		const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
		cv.addEventListener("pointerdown", (e) => {
			cv.setPointerCapture(e.pointerId);
			cur = { color, width, erase, pts: [pos(e)] }; strokes.push(cur); redraw();
		});
		cv.addEventListener("pointermove", (e) => { if (cur) { cur.pts.push(pos(e)); redraw(); } });
		const end = () => { cur = null; };
		cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);

		function btn(text, onclick, on) { return el("button", { type: "button", textContent: text, onclick, className: on ? "on" : "" }); }
		function buildTools() {
			tools.replaceChildren();
			for (const c of COLORS) tools.append(el("button", { type: "button", className: "dot" + (!erase && c === color ? " on" : ""), style: `background:${c}`, onclick: () => { color = c; erase = false; buildTools(); } }));
			tools.append(
				btn("橡皮", () => { erase = !erase; buildTools(); }, erase),
				btn(width > 3 ? "粗" : "细", () => { width = width > 3 ? 3 : 6; buildTools(); }),
				btn("方格", () => { grid = !grid; buildTools(); redraw(); }, grid),
				btn("撤销", () => { strokes.pop(); redraw(); }),
				btn("清空", () => { if (!strokes.length || confirm("清空画板？")) { strokes = []; redraw(); } }),
				el("span", { className: "grow" }),
				btn("取消", () => close(null)),
				el("button", { type: "button", textContent: "完成", className: "on", onclick: finish }));
		}
		function finish() {
			if (!strokes.length) return close(null);
			const r = wrap.getBoundingClientRect(), s = Math.min(1, 1600 / Math.max(r.width, r.height)) * Math.min(window.devicePixelRatio || 1, 2);
			const out = document.createElement("canvas");
			out.width = Math.round(r.width * s); out.height = Math.round(r.height * s);
			const c = out.getContext("2d"); c.scale(s, s); paint(c, r.width, r.height);
			out.toBlob((b) => close(b ? new File([b], "draw.jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.85);
		}
		function close(v) { window.removeEventListener("resize", size); root.remove(); document.body.style.overflow = ""; resolve(v); }

		document.body.append(root);
		document.body.style.overflow = "hidden";
		buildTools(); size();
		window.addEventListener("resize", size);
	});
}
