// 错题本规则：做错 → 进错题本，明天重做；重做做对 → 发过给 Claude 的隐藏（30 天后删），没发过的留在错题本等打包发送
/** 今天的日期（北京时间）YYYY-MM-DD */
export function today(): string {
	return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

const setStatus = (db: D1Database, id: number, status: "active" | "mastered" | "done") =>
	db.prepare("UPDATE questions SET status = ?, status_at = CASE WHEN ? = 'active' THEN NULL ELSE datetime('now') END WHERE id = ?").bind(status, status, id).run();

/** 一次作答有结果后：更新错题本和题目状态。 */
export async function updateQueue(db: D1Database, questionId: number, correct: boolean) {
	if (!correct) {
		await db
			.prepare("INSERT INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0) ON CONFLICT(question_id) DO UPDATE SET next_date = excluded.next_date, stage = 0")
			.bind(questionId, addDays(today(), 1))
			.run();
		await setStatus(db, questionId, "active");
		return;
	}
	const q = await db.prepare("SELECT q.source, q.sent_at, EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) wrong FROM questions q WHERE q.id = ?").bind(questionId).first<{ source: string; sent_at: string | null; wrong: number }>();
	if (!q) return;
	await db.prepare("DELETE FROM review_queue WHERE question_id = ?").bind(questionId).run(); // 做对了就不用再重做
	if (!q.wrong) return setStatus(db, questionId, "done"); // 一次就做对：隐藏，30 天后删
	if (q.sent_at) await setStatus(db, questionId, "mastered"); // 错题重做对、且已发给 Claude：隐藏
	// 没发过：留在错题本（显示「重做已对」），等打包发给 Claude 后再隐藏
}

/** 手动：删除题目（作答记录保留，待批改的一并删掉）/ 标为已掌握 */
export async function removeQuestion(db: D1Database, id: number) {
	await db.batch([
		db.prepare("DELETE FROM review_queue WHERE question_id = ?").bind(id),
		db.prepare("DELETE FROM marks WHERE question_id = ?").bind(id),
		db.prepare("DELETE FROM attempts WHERE question_id = ? AND status = '待批改'").bind(id),
		db.prepare("DELETE FROM questions WHERE id = ?").bind(id),
	]);
}
export async function masterQuestion(db: D1Database, id: number) {
	await db.prepare("DELETE FROM review_queue WHERE question_id = ?").bind(id).run();
	await setStatus(db, id, "mastered");
}

/** 每日清理（Cron）：精简题库和照片，作答记录永久保留供统计 */
export async function dailyCleanup(db: D1Database) {
	await db.prepare("DELETE FROM marks WHERE created_at < datetime('now','-1 day')").run(); // 标记的题 24 小时过期
	const delKeys = async (keys: string[]) => {
		for (let i = 0; i < keys.length; i += 50) {
			const part = keys.slice(i, i + 50);
			await db.prepare(`DELETE FROM photos WHERE key IN (${part.map(() => "?").join(",")})`).bind(...part).run();
		}
	};
	// 1. 已掌握 / 已做对的同类题 超过 30 天：删题（attempts 保留）
	await db.batch([
		db.prepare("DELETE FROM review_queue WHERE question_id IN (SELECT id FROM questions WHERE status != 'active')"),
		db.prepare("DELETE FROM questions WHERE status IN ('mastered','done') AND status_at < datetime('now','-30 days')"),
	]);
	// 2. 已批改作答的照片超过 30 天：删照片，photo_key 置空
	const old = (await db.prepare("SELECT id, photo_key FROM attempts WHERE status = '已判' AND photo_key IS NOT NULL AND created_at < datetime('now','-30 days') LIMIT 500").all<{ id: number; photo_key: string }>()).results;
	await delKeys(old.flatMap((a) => a.photo_key.split(",")));
	for (const a of old) await db.prepare("UPDATE attempts SET photo_key = NULL WHERE id = ?").bind(a.id).run();
	// 3. 已处理的上传照片超过 14 天：删照片和记录
	const ups = (await db.prepare("SELECT id, r2_key FROM uploads WHERE status = '已处理' AND created_at < datetime('now','-14 days') LIMIT 500").all<{ id: number; r2_key: string }>()).results;
	await delKeys(ups.map((u) => u.r2_key));
	for (const u of ups) await db.prepare("DELETE FROM uploads WHERE id = ?").bind(u.id).run();
	// 4. 总结只留最近 30 条
	await db.prepare("DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY id DESC LIMIT 30)").run();
}
