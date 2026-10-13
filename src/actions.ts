// Max 的网站动作：学生让 Max 做事（清空标记、清空错题文件夹、设考试…）时，Max 给一个 [[做:动作]] 按钮。
// 点了先 dry=1 数一数、弹确认，确认后才真做。作答记录是统计数据，不删；整站清空不做（要删题用「清理题库」按科目/考点）。
import { cleanBank, describeClean, organize, startClassify, unorganized, MaxErr } from "./max";
import { wrongSql } from "./live";
import { today } from "./review";

type Res = { msg: string; n: number; empty?: boolean; done?: boolean };
const count = async (db: D1Database, sql: string) => Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
// 删题要连带清掉复习队列、标记、待批改的作答（作答记录本身保留）
const delQuestions = (sub: string) => [
	`DELETE FROM review_queue WHERE question_id IN (${sub})`,
	`DELETE FROM marks WHERE question_id IN (${sub})`,
	`DELETE FROM attempts WHERE status = '待批改' AND question_id IN (${sub})`,
	`DELETE FROM questions WHERE id IN (${sub})`,
];

/** 题号（如「数学3,物理12」）→ 题目 id；对不上的题号原样返回给学生看 */
async function byNo(db: D1Database, list: string) {
	const ids: number[] = [], names: string[] = [], miss: string[] = [];
	for (const t of list.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20)) {
		const m = t.match(/^(\D+?)(\d+)$/);
		const r = m ? await db.prepare("SELECT id, subject || '·' || substr(stem, 1, 16) n FROM questions WHERE subject = ? AND no = ? ORDER BY id DESC LIMIT 1").bind(m[1], Number(m[2])).first<{ id: number; n: string }>() : null;
		if (r) { ids.push(r.id); names.push(r.n); } else miss.push(t);
	}
	if (!ids.length) throw new MaxErr("没找到这些题号：" + (miss.join("、") || list));
	return { ids, names: names.join("、") + (miss.length ? `（没找到：${miss.join("、")}）` : "") };
}

export async function runAction(env: Env, ctx: ExecutionContext, name: string, arg: string, dry: boolean): Promise<Res> {
	const db = env.DB;
	// 清空类：dry 时报数量并提醒；真做时执行 run
	const clear = (n: number, what: string, note: string, run: () => Promise<unknown>): Res | Promise<Res> => {
		if (!n) return { msg: `${what}已经是空的`, n, empty: true };
		if (dry) return { msg: `清空${what}：共 ${n} 项。${note}清空后不能恢复（作答记录会保留）。`, n };
		return run().then(() => ({ msg: `已清空${what}（${n} 项）`, n, done: true }));
	};
	const sql = (...stmts: string[]) => db.batch(stmts.map((s) => db.prepare(s)));

	switch (name) {
		case "清空标记":
			return clear(await count(db, "SELECT COUNT(*) n FROM marks"), "标记的题", "", () => sql("DELETE FROM marks"));
		case "清空错题本": {
			const sub = `SELECT q.id FROM questions q WHERE q.status = 'active' AND ${wrongSql()}`;
			return clear(await count(db, `SELECT COUNT(*) n FROM (${sub})`), "错题本（复习中的错题）", "这些题会从题库删掉。", () => sql(...delQuestions(sub)));
		}
		case "清空错题文件夹": {
			const sub = "SELECT id FROM questions WHERE status = 'mastered'";
			return clear(await count(db, `SELECT COUNT(*) n FROM (${sub})`), "错题文件夹", "清空后 Claude 就取不到这些题了（没取过的也会删）；每天凌晨 2:30 也会自动清空。", () => sql(...delQuestions(sub), "DELETE FROM meta WHERE k IN ('folder_sum', 'folder_seen')"));
		}
		case "清空照片收件箱":
			return clear(await count(db, "SELECT COUNT(*) n FROM uploads"), "照片收件箱", "没处理的照片也会删。", () => sql("DELETE FROM photos WHERE key IN (SELECT r2_key FROM uploads)", "DELETE FROM uploads"));
		case "清空总结":
			return clear(await count(db, "SELECT COUNT(*) n FROM summaries"), "总结", "", () => sql("DELETE FROM summaries"));
		case "整理错题": {
			const n = await unorganized(db);
			if (!n) return { msg: "错题都整理过了", n, empty: true };
			if (dry) return { msg: `让 Max 整理 ${Math.min(n, 10)} 道错题（用 Cloudflare 额度，每次最多 10 道）`, n };
			const done = await organize(env, 10);
			return { msg: `整理好 ${done} 道错题`, n: done, done: true };
		}
		case "整理分类":
			if (dry) return { msg: "让 Max 重新整理分类（用额度，会合并同义考点、归章节）", n: 0 };
			await startClassify(env, ctx);
			return { msg: "已在后台整理分类，稍后刷新题库看结果", n: 0, done: true };
		case "清理题库": { // 按「科目/考点」删（可加 |未做 或 |已做）；先数、确认才删
			const { n, sample } = await cleanBank(db, arg, !dry);
			if (!n) return { msg: "题库里没有符合的题", n, empty: true };
			if (dry) return { msg: `删除题库里 ${n} 道题（${describeClean(arg)}）？例如：${sample.join("；") || "无"}。做题记录会保留，删了不能恢复。`, n };
			return { msg: `已删除 ${n} 道题`, n, done: true };
		}
		case "设考试": {
			const [en, ed] = arg.split("|").map((x) => x.trim());
			if (!en || !/^\d{4}-\d{2}-\d{2}$/.test(ed ?? "")) throw new MaxErr("考试要写「名称|日期」，日期如 2026-10-20");
			if (dry) return { msg: `设考试：${en} ${ed}（首页倒计时）`, n: 1 };
			const row = await db.prepare("SELECT v FROM meta WHERE k = 'exams'").first<{ v: string }>();
			let list: { name: string; date: string }[] = [];
			try { list = JSON.parse(row?.v ?? "[]"); } catch {}
			list = [...list.filter((e) => e.name !== en), { name: en, date: ed }];
			await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('exams', ?)").bind(JSON.stringify(list)).run();
			return { msg: `已设考试：${en} ${ed}`, n: 1, done: true };
		}
		case "放回复习": { // 题号列表 → 今天重新做（回到第 1 档）
			const { ids, names } = await byNo(db, arg);
			if (dry) return { msg: `把 ${names} 放回复习，今天就做（重新从第 1 档开始）`, n: ids.length };
			await db.batch(ids.flatMap((id) => [
				db.prepare("INSERT INTO review_queue (question_id, next_date, stage) VALUES (?1, ?2, 0) ON CONFLICT(question_id) DO UPDATE SET next_date = ?2, stage = 0").bind(id, today()),
				db.prepare("UPDATE questions SET status = 'active', status_at = NULL WHERE id = ?").bind(id),
			]));
			return { msg: `已放回复习：${names}`, n: ids.length, done: true };
		}
		case "改复习日期": { // 题号列表|YYYY-MM-DD（档位不变）
			const [list, date] = arg.split("|").map((x) => x.trim());
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new MaxErr("要写「题号|日期」，日期如 2026-10-20");
			const { ids, names } = await byNo(db, list ?? "");
			if (dry) return { msg: `把 ${names} 的复习日期改到 ${date}`, n: ids.length };
			await db.batch(ids.flatMap((id) => [
				db.prepare("INSERT INTO review_queue (question_id, next_date, stage) VALUES (?1, ?2, 0) ON CONFLICT(question_id) DO UPDATE SET next_date = ?2").bind(id, date),
				db.prepare("UPDATE questions SET status = 'active', status_at = NULL WHERE id = ?").bind(id),
			]));
			return { msg: `已改复习日期到 ${date}：${names}`, n: ids.length, done: true };
		}
		case "标记题目": { // 题号列表 → 加进「标记的题」（24 小时）
			const { ids, names } = await byNo(db, arg);
			if (dry) return { msg: `标记 ${names}（24 小时内可以让 Max/Claude 解析）`, n: ids.length };
			await db.batch(ids.map((id) => db.prepare("INSERT INTO marks (question_id) VALUES (?) ON CONFLICT(question_id) DO NOTHING").bind(id)));
			return { msg: `已标记：${names}`, n: ids.length, done: true };
		}
	}
	throw new MaxErr("Max 还不会做这个动作");
}
