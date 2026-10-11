// 题图（Claude 的画板）：推题时 fig 给 JSON 画板描述（单位=格，y 向上，点可起名后按名字引用），或给一段 SVG。
// 网站用作图板同一套画法画出来，自动按内容裁边、居中、缩放。这里只做校验/限长，和给 Max 看的文字描述（Max 看不到图）。
const T = new Set(["pt", "seg", "line", "ray", "circle", "poly", "curve", "fn", "text", "right", "angle", "force", "light", "normal", "mirror", "lens", "lens2"]);

/** 校验并压成 JSON 字符串；不合格返回 null（题照样推，只是没图） */
export function normFig(x: unknown): string | null {
	if (!x) return null;
	let f: any = x;
	if (typeof f === "string") { const s = f.trim(); if (s.startsWith("<svg")) f = { svg: s }; else try { f = JSON.parse(s); } catch { return null; } }
	if (typeof f !== "object") return null;
	if (typeof f.svg === "string") {
		const svg = f.svg.trim();
		return svg.startsWith("<svg") && svg.length <= 30000 && !/<script|on\w+\s*=|javascript:|<foreignObject/i.test(svg) ? JSON.stringify({ svg, w: Number(f.w) || undefined }) : null;
	}
	const items = (Array.isArray(f.items) ? f.items : Array.isArray(f) ? f : []).filter((o: any) => o && T.has(o.t)).slice(0, 150);
	if (!items.length) return null;
	const range = (r: unknown) => (Array.isArray(r) && r.length === 2 && r.every((v) => Number.isFinite(v)) && r[0] < r[1] ? r : undefined);
	const out = JSON.stringify({ axes: !!f.axes, grid: f.grid === undefined ? undefined : !!f.grid, x: range(f.x), y: range(f.y), items });
	return out.length <= 20000 ? out : null;
}

/** 给 Max 的文字版（批改、讲题时附在题干后） */
export function figText(raw?: string | null): string {
	if (!raw) return "";
	try {
		const f = JSON.parse(raw);
		if (f.svg) return "（题目附图，见网页）";
		const p = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? `(${v.join(",")})` : "?");
		const s = (f.items as any[]).map((o) => {
			switch (o.t) {
				case "pt": return `点${o.n ?? ""}${p(o.p)}`;
				case "seg": case "line": case "ray": return `${({ seg: "线段", line: "直线", ray: "射线" } as any)[o.t]}${p(o.a)}${p(o.b)}`;
				case "circle": return `圆心${p(o.o ?? o.a)}${o.r ? "半径" + o.r : ""}`;
				case "poly": return `多边形${(o.pts ?? []).map(p).join("")}`;
				case "fn": return `函数${o.expr}`;
				case "text": return `标注「${o.s}」`;
				case "right": return `直角${p(o.at)}`;
				case "angle": return `角${p(o.at)}${o.s ? "=" + o.s : ""}`;
				case "force": return `力${o.n ?? ""}${p(o.a)}→${p(o.b)}`;
				default: return o.t;
			}
		});
		return `题图：${f.axes ? "坐标系；" : ""}${s.join("；")}`.slice(0, 600);
	} catch { return ""; }
}
