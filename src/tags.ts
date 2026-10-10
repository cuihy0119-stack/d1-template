// 题型标签 → [题型, 画板]。标签是唯一依据：存题时存 tag，读题时 pick() 由 tag 定画板（board 列只给旧题兜底）。
// 标签写法随意（「计算题」「电路图」都认）；没给标签就按题干猜。物理作图一律分到 电路/光路/受力，不会落到几何板。
export const TAGS = {
	选择: ["single", null], 填空: ["fill", null], 计算: ["short", "calc"], 解答: ["short", "calc"], 证明: ["short", "grid"],
	作图: ["short", "grid"], 函数: ["short", "coord"], 电路: ["short", "circuit"], 光路: ["short", "phys"], 受力: ["short", "phys"], 简答: ["short", null],
} as const;
export type Tag = keyof typeof TAGS;

// 标签同义词（先匹配的优先）
const ALIAS: [RegExp, Tag][] = [
	[/选择|单选|多选/, "选择"], [/填空/, "填空"], [/电路|实物/, "电路"], [/光|镜|成像/, "光路"], [/受力|力的示意|杠杆|力臂|滑轮|绕线/, "受力"],
	[/证明/, "证明"], [/函数|图像/, "函数"], [/作图|画图/, "作图"], [/计算|求值|化简|方程/, "计算"], [/解答|应用|综合/, "解答"],
	[/简答|问答|说明|实验|探究/, "简答"],
];
const CALC = /计算|求|解方程|解不等式|方程组|化简|多少|取值范围|配方|公式法|因式分解|开平方/;
const DRAW = /画出|作出|画图|作图|画上|标出|连接|连线|设计|完成.{0,4}(光路|电路)|示意图/;
// 物理作图分三类：看题干
const physDraw = (s: string): Tag => (/电路|电流表|电压表|开关|灯泡|电阻/.test(s) ? "电路" : /光|镜|像|影|折射|反射/.test(s) ? "光路" : "受力");

type In = { subject?: string | null; stem: string; tag?: string | null; board?: string | null; type?: string | null; opts?: boolean };

export function pick(q: In): { tag: Tag; board: string | null } {
	const s = q.stem, phys = /物理/.test(q.subject ?? ""), out = (t: Tag) => ({ tag: t, board: TAGS[t][1] as string | null });
	if (q.opts || q.type === "single" || q.type === "multi") return out("选择");
	if (q.type === "fill") return /数学|物理|化学/.test(q.subject ?? "") && CALC.test(s) ? { tag: "计算", board: "calc" } : out("填空"); // 计算类填空：仍自动判分，配草稿计算板
	let t = q.tag ? ALIAS.find(([re]) => re.test(q.tag!))?.[1] : undefined;
	if (t === "选择") t = undefined; // 没有选项不能是选择题
	t ??= /证明|求证/.test(s) ? "证明"
		: DRAW.test(s) ? (phys ? "作图" : /函数|图像|抛物线|坐标/.test(s) ? "函数" : "作图")
		: q.board === "coord" ? "函数"
		: q.board === "grid" && !phys ? "作图"
		: CALC.test(s) ? "计算"
		: q.type === "short" || q.board ? "简答" : "填空";
	if (phys && (t === "作图" || t === "证明" || t === "函数")) t = physDraw(s);
	return out(t);
}
