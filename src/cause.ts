// 错题记录（后端统一做，Claude 和 Max 用同一套）：一题一行。错因不用固定模板，全由 Max 看数据自己分析（max_reason/max_note）。

type Row = {
	id: number; no?: number | null; subject: string; topic?: string | null; type: string; stem: string; options?: string | null; answer: string;
	explanation?: string | null; answer_text?: string | null; error_reason?: string | null; comment?: string | null;
	time_spent_sec?: number | null; is_correct?: number | null; status?: string | null; max_reason?: string | null; max_note?: string | null;
};

const arr = (s?: string | null): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
/** 学生自己写的答案（去掉画板描述） */
export const mine = (r: Row) => String(r.answer_text ?? "").replace(/\n?\[(作图|电路|计算)\][\s\S]*$/, "").trim();

/** 一题一行：题干、选项、错答、正确答案、错因（Max 分析的，没有就不写）、解析、评语 */
export function wrongLine(r: Row): string {
	const opts = arr(r.options), why = r.max_reason || r.error_reason;
	return [
		`${r.subject}${r.no ?? ""}${r.topic ? "（" + r.topic + "）" : ""}：${r.stem}`,
		opts.length ? `选项：${opts.join(" ")}` : "",
		`错答：${mine(r) || "（空）"}`,
		`正确：${arr(r.answer).join(" / ")}`,
		why ? `错因：${why}${r.max_note ? "，" + r.max_note : ""}` : "",
		r.time_spent_sec ? `用时${r.time_spent_sec}秒` : "",
		r.explanation ? `解析：${r.explanation}` : "",
		r.comment ? `评语：${r.comment}` : "",
	].filter(Boolean).join("｜");
}
