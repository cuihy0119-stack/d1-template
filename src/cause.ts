// 错题整理（后端统一做，Claude 和网页用同一套）：错因 + 一题一行的完整错题记录。
// Claude 批改过的题用它给的错因；网站自动判的选择/填空，按作答推断错因。

type Row = {
	id: number; no?: number | null; subject: string; topic?: string | null; type: string; stem: string; options?: string | null; answer: string;
	explanation?: string | null; answer_text?: string | null; error_reason?: string | null; comment?: string | null;
	time_spent_sec?: number | null; is_correct?: number | null; status?: string | null;
};

const arr = (s?: string | null): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const num = (s: string) => { // 只认纯数字或分数（Workers 里不能用 eval）
	const m = s.replace(/^[a-zA-Z]=/, "").trim().match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+))?$/);
	return m ? +m[1] / (m[2] ? +m[2] : 1) : NaN;
};
/** 学生自己写的答案（去掉画板描述） */
export const mine = (r: Row) => String(r.answer_text ?? "").replace(/\n?\[(作图|电路|计算)\][\s\S]*$/, "").trim();

export function cause(r: Row): string {
	if (r.error_reason) return r.error_reason;
	const a = mine(r), ok = arr(r.answer);
	if (!a) return "不会做（没作答）";
	if (r.type === "multi") {
		const want = new Set(ok.join("").toUpperCase()), got = new Set(a.toUpperCase());
		const miss = [...want].filter((x) => !got.has(x)), extra = [...got].filter((x) => !want.has(x));
		return [miss.length && "漏选 " + miss.join(""), extra.length && "多选 " + extra.join("")].filter(Boolean).join("，") || "概念不清";
	}
	if (r.type === "single") return (r.time_spent_sec ?? 99) < 8 ? "审题失误（作答过快）" : "概念不清（选了干扰项）";
	if (r.type === "fill") {
		const u = num(a), k = num(ok[0] ?? "");
		if (!Number.isNaN(u) && !Number.isNaN(k)) return u === -k ? "计算错误（符号错）" : Math.abs(u - k) < 1e-9 * Math.max(1, Math.abs(k)) ? "表述不规范" : "计算错误";
		return (r.time_spent_sec ?? 99) < 8 ? "审题失误（作答过快）" : "概念不清";
	}
	return r.comment ? "见评语" : "待批改";
}

/** 一题一行：题干、选项、错答、正确答案、错因、解析、评语都给全 */
export function wrongLine(r: Row): string {
	const opts = arr(r.options);
	return [
		`${r.subject}${r.no ?? ""}${r.topic ? "（" + r.topic + "）" : ""}：${r.stem}`,
		opts.length ? `选项：${opts.join(" ")}` : "",
		`错答：${mine(r) || "（空）"}`,
		`正确：${arr(r.answer).join(" / ")}`,
		`错因：${cause(r)}`,
		r.explanation ? `解析：${r.explanation}` : "",
		r.comment ? `评语：${r.comment}` : "",
	].filter(Boolean).join("｜");
}
