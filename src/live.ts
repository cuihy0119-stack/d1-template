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

/** 题还在显示期内（SQL 条件，q 是 questions 的别名） */
export const live = (q = "q") =>
	`(${q}.created_at > datetime('now', '-1 day') OR (${q}.created_at > datetime('now', '-2 days') AND ${wrongSql(q)} AND NOT ${redone(q)}))`;

/** 文件夹里的题不受限，其余要在显示期内 */
export const alive = (q = "q") => `(${q}.status <> 'active' OR ${live(q)})`;
