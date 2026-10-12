// 题库时效（只管 status='active' 的题；重做做对的进错题文件夹 status='mastered'，不受限）：
// 题目超过 24 小时就隐藏，不管做没做、是不是错题；错题（原错题，或做错过）没重做的，加长到 48 小时。
// 隐藏只是不显示、不出题；每日定时再把隐藏超过 30 天的删掉。
/** 错题：原错题，或做错过 */
export const wrongSql = (q = "q") =>
	`(${q}.source = '原错题' OR EXISTS (SELECT 1 FROM attempts aw WHERE aw.question_id = ${q}.id AND aw.is_correct = 0))`;

/** 错题已重做：原错题有任何作答；其它题在第一次做错之后又做过 */
const redone = (q: string) =>
	`EXISTS (SELECT 1 FROM attempts ar WHERE ar.question_id = ${q}.id AND ar.id > CASE WHEN ${q}.source = '原错题' THEN 0
		ELSE COALESCE((SELECT MIN(a1.id) FROM attempts a1 WHERE a1.question_id = ${q}.id AND a1.is_correct = 0), 9e18) END)`;

/** 计时起点：推送时间；排到以后做的题（due = 北京日期）从那天 0 点开始算 */
const since = (q: string) => `MAX(${q}.created_at, COALESCE(datetime(${q}.due, '-8 hours'), ${q}.created_at))`;
/** 排期：已经到了开始做的日子（没排期 = 马上）。today 是北京日期 YYYY-MM-DD 的占位符 ? */
export const ready = (q = "q") => `(${q}.due IS NULL OR ${q}.due <= ?)`;

/** 题还在显示期内（SQL 条件，q 是 questions 的别名） */
export const live = (q = "q") =>
	`(${since(q)} > datetime('now', '-1 day') OR (${since(q)} > datetime('now', '-2 days') AND ${wrongSql(q)} AND NOT ${redone(q)}) OR (EXISTS (SELECT 1 FROM review_queue rq WHERE rq.question_id = ${q}.id) AND ${wrongSql(q)}))`; // 还在间隔复习的错题一直显示（排了期的新题照旧按时隐藏）

/** 文件夹里的题不受限，其余要在显示期内 */
export const alive = (q = "q") => `(${q}.status <> 'active' OR ${live(q)})`;
