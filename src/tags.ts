// 题型标签 → [题型, 画板]。标签写法随意（「计算题」「电路图」都认），没给就按题干猜；
// 存题和读题都走 pick()，所以 Claude 用旧工具出的题（只有 board/type）也能拉起正确画板。
export const TAGS = {
	选择: ["single", null], 填空: ["fill", null], 计算: ["short", "calc"], 解答: ["short", "calc"], 证明: ["short", "grid"],
	作图: ["short", "grid"], 函数: ["short", "coord"], 电路: ["short", "circuit"], 光路: ["short", "phys"], 受力: ["short", "phys"], 简答: ["short", null],
} as const;
export type Tag = keyof typeof TAGS;

// 标签同义词（先匹配的优先）
const ALIAS: [RegExp, Tag][] = [
	[/选择|单选|多选/, "选择"], [/填空/, "填空"], [/电路|实物/, "电路"], [/光|镜/, "光路"], [/受力|力的示意|杠杆|力臂|滑轮/, "受力"], [/证明/, "证明"], [/函数|图像/, "函数"],
	[/作图|画图|光路|受力/, "作图"], [/计算|求值|化简|方程/, "计算"], [/解答|应用|综合/, "解答"], [/简答|问答|说明|实验|探究/, "简答"],
];
const DRAW = /画出|作出|画图|作图|连接|设计/;

type In = { subject?: string | null; stem: string; tag?: string | null; board?: string | null; type?: string | null; opts?: boolean };

export function pick(q: In): { tag: Tag; board: string | null } {
	const s = q.stem, board = (t: Tag) => ({ tag: t, board: TAGS[t][1] as string | null });
	if (q.opts || q.type === "single" || q.type === "multi") return board("选择");
	let t = ALIAS.find(([re]) => q.tag && re.test(q.tag))?.[1];
	if (t === "选择") t = undefined; // 没有选项不能是选择题
	if (q.type === "fill") return board("填空"); // 已存的填空题不改题型
	if (!t) {
		if (/电路/.test(s) && DRAW.test(s)) t = "电路";
		else if (/证明|求证/.test(s)) t = "证明";
		else if (DRAW.test(s)) t = /函数|图像|抛物线|坐标/.test(s) ? "函数" : "作图";
		else if (q.board === "coord" || (q.board === "grid" && q.subject !== "物理")) t = q.board === "coord" ? "函数" : "作图";
		else if (/计算|求|解方程|化简|多少/.test(s)) t = "计算";
		else t = q.type === "short" || q.board ? "简答" : "填空";
	}
	if (t === "作图" && q.subject === "物理") t = /电路/.test(s) ? "电路" : /光|镜|影/.test(s) ? "光路" : "受力"; // 物理作图分三类
	return board(t);
}
