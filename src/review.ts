// 复习间隔（天）：做对后按 1、2、4、7、15 推进，做错退回第 1 天
const INTERVALS = [1, 2, 4, 7, 15];

/** 今天的日期（北京时间）YYYY-MM-DD */
export function today(): string {
	return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** 一次作答有结果后，更新该题的复习队列。 */
export async function updateQueue(db: D1Database, questionId: number, correct: boolean) {
	const row = await db
		.prepare("SELECT stage FROM review_queue WHERE question_id = ?")
		.bind(questionId)
		.first<{ stage: number }>();
	const t = today();
	if (!correct) {
		await db
			.prepare(
				"INSERT INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0) " +
					"ON CONFLICT(question_id) DO UPDATE SET next_date = excluded.next_date, stage = 0",
			)
			.bind(questionId, addDays(t, INTERVALS[0]))
			.run();
		return;
	}
	if (!row) return; // 一次做对且不在队列：不用复习
	const next = row.stage + 1;
	if (next >= INTERVALS.length) {
		await db.prepare("DELETE FROM review_queue WHERE question_id = ?").bind(questionId).run(); // 掌握
	} else {
		await db
			.prepare("UPDATE review_queue SET stage = ?, next_date = ? WHERE question_id = ?")
			.bind(next, addDays(t, INTERVALS[next]), questionId)
			.run();
	}
}
