// 后台任务队列：慢的模型活不在网页/Claude 的请求里做。
// 平台在请求结束后只给 30 秒收尾（waitUntil），模型慢就被切断、结果写不进库；所以任务先存进 jobs 表，
// 请求里先试跑一次（快就直接好了），没跑完的由每分钟的定时任务接着做（定时任务可以长时间运行）。
import { brief, classifyJob, folderSummary, gradeJob, organize, pregrade, refine, unorganized, wrongSummary } from "./max";

// ms：这次最多还能跑多久（批改按它分批停；其它任务一次调用就完）。返回 true = 没做完，再排一轮
const RUN: Record<string, (env: Env, arg: string, ms: number) => Promise<unknown>> = {
	grade: (env, _, ms) => gradeJob(env, ms), // 交卷后 Max 批改
	pregrade: (env, arg) => pregrade(env, JSON.parse(arg)), // 交给 Claude 的题：Max 先写初评
	organize: async (env) => { if ((await unorganized(env.DB)) >= 5) await organize(env, 10); }, // 新错题攒够 5 道才分析一次（一次批量，省额度）
	brief: (env) => brief(env, true), // 首页建议
	wsum: (env) => wrongSummary(env, true), // 错题总结
	refine: (env, arg) => refine(env, JSON.parse(arg)), // Claude 推新题后 Max 复核
	fsum: (env) => folderSummary(env), // 错题文件夹总结（Claude 来取时让 Max 先写好）
	classify: (env) => classifyJob(env), // 整理分类
};

/** 排一个任务；同一个任务已经在排队/在跑就不重复 */
export async function enqueue(env: Env, kind: string, arg = ""): Promise<void> {
	const db = env.DB;
	const dup = await db.prepare("SELECT 1 x FROM jobs WHERE status IN ('queued', 'running') AND kind = ? AND arg = ? AND (status = 'queued' OR started > datetime('now', '-10 minutes')) LIMIT 1").bind(kind, arg).first();
	if (!dup) await db.prepare("INSERT INTO jobs (kind, arg) VALUES (?, ?)").bind(kind, arg).run();
}

/** 排任务并马上在本次请求里试跑（请求结束后 30 秒内能跑完就跑完，否则留给定时任务） */
export async function enqueueNow(env: Env, ctx: ExecutionContext | undefined, kind: string, arg = ""): Promise<void> {
	await enqueue(env, kind, arg);
	ctx?.waitUntil(runJobs(env, "req").catch(() => {}));
}

/** 取排队的任务来做；上次在请求里跑到一半被切断的（45 秒没完）、定时任务跑崩的（10 分钟没完）也捡起来重做，最多 3 次。
 * 请求里只有 30 秒：15 秒后不再接新任务；定时任务每分钟都会来，4 分钟后也收手，别和下一轮叠太多 */
export async function runJobs(env: Env, runner: "req" | "cron" = "cron"): Promise<void> {
	const db = env.DB, end = Date.now() + (runner === "req" ? 15000 : 240000);
	while (Date.now() < end) {
		const j = await db.prepare(`UPDATE jobs SET status = 'running', runner = ?, started = datetime('now'), tries = tries + 1
			WHERE id = (SELECT id FROM jobs WHERE status IN ('queued', 'running') AND tries < 3 AND (status = 'queued'
				OR (runner = 'req' AND started < datetime('now', '-45 seconds')) OR started < datetime('now', '-10 minutes')) ORDER BY id LIMIT 1)
			RETURNING id, kind, arg`).bind(runner).first<{ id: number; kind: string; arg: string }>();
		if (!j) return;
		try {
			const run = RUN[j.kind];
			if (!run) throw new Error("未知任务 " + j.kind);
			const again = await run(env, j.arg, Math.max(5000, end - Date.now()));
			await db.prepare("UPDATE jobs SET status = 'done', msg = NULL WHERE id = ?").bind(j.id).run();
			if (again === true) await enqueue(env, j.kind, j.arg);
		} catch (e) {
			await db.prepare("UPDATE jobs SET status = 'failed', msg = ? WHERE id = ?").bind(String(e).slice(0, 120), j.id).run();
		}
	}
}
