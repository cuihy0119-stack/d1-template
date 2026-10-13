import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mountAuthorize } from "./authorize";
import { passcodeOk } from "./auth";
import { mcpHandler } from "./mcp";
import { judge } from "./judge";
import { pick } from "./tags";
import { loginPage } from "./login";
import { chatQuota, edge, flag, guard } from "./security";
import { addDays, clearFolder, dailyCleanup, masterQuestion, removeQuestion, today, updateQueue } from "./review";
import { brief, byMax, chat, classifyState, gen, see, MaxErr, maxDaily, organize, startClassify, status, unorganized, used, wrongSummary } from "./max";
import { live, ready, wrongSql } from "./live";
import { check as kimiCheck, run as kimiRun } from "./kimi";
import { findNote } from "./notion";
import { runAction } from "./actions";
import { enqueue, enqueueNow, runJobs } from "./jobs";

type Q = {
	id: number;
	subject: string;
	topic: string | null;
	category: string | null;
	board: string | null;
	tag: string | null;
	created_at: string;
	type: "single" | "multi" | "fill" | "short";
	stem: string;
	no?: number | null;
	max_reason?: string | null;
	max_note?: string | null;
	options: string | null;
	answer: string;
	explanation: string | null;
	source: string;
	fig?: string | null;
};

const COOKIE = "session";
const app = new Hono<{ Bindings: Env }>();
app.onError((e, c) => c.json({ error: e.message }, 500));
app.use("*", guard); // 安全头、限流、拦扫描器

// 公开文件（不需要登录）：robots.txt、PWA manifest
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n", 200, { "Cache-Control": "public, max-age=86400" }));
app.get("/manifest.webmanifest", async (c) => {
	const r = new Response((await c.env.ASSETS.fetch(c.req.raw)).body);
	r.headers.set("Content-Type", "application/manifest+json; charset=utf-8");
	r.headers.set("Cache-Control", "public, max-age=86400");
	return r;
});

// ---------- 登录 ----------
app.get("/login", (c) => c.html(loginPage()));
app.post("/login", async (c) => {
	if (!c.env.PASSCODE) return c.html(loginPage("服务器还没设置 PASSCODE"), 500);
	const form = await c.req.parseBody();
	if (!(await passcodeOk(String(form.passcode ?? ""), c.env.PASSCODE))) {
		flag(c, "badpass");
		await new Promise((r) => setTimeout(r, 800)); // 错了慢点回，猜口令更难
		return c.html(loginPage("口令不对"), 401);
	}
	await setSignedCookie(c, COOKIE, "ok", c.env.PASSCODE, {
		httpOnly: true,
		secure: new URL(c.req.url).protocol === "https:",
		sameSite: "Lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 90,
	});
	return c.redirect("/");
});

// Claude 连接用的 OAuth 授权页（/mcp、/token、/register 由 OAuthProvider 处理）
mountAuthorize(app);

// 接口数据不缓存，保证每次拿到最新
app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});

app.use("*", async (c, next) => {
	const p = new URL(c.req.url).pathname;
	if (c.env.PASSCODE && (await getSignedCookie(c, c.env.PASSCODE, COOKIE)) === "ok") return next();
	if (p.startsWith("/api/") || p.startsWith("/photo/")) return c.json({ error: "未登录" }, 401);
	return c.redirect("/login");
});

// ---------- 工具 ----------
const parse = <T>(s: string | null, d: T): T => {
	try {
		return s ? JSON.parse(s) : d;
	} catch {
		return d;
	}
};
/** 前端显示的题干前缀：「数学·」（不显示数字题号；no 只是后端内部编码） */
export const label = (q: { subject: string; no?: number | null }) => `${q.subject}·`;
const clientQ = (q: Q) => ({
	id: q.id,
	subject: q.subject,
	category: q.category,
	topic: q.topic,
	type: q.type,
	stem: q.stem, // 做题卡片：科目只显示在左上角标签，题干不重复
	options: parse<string[]>(q.options, []),
	...pick({ ...q, opts: !!q.options }), // tag、board：旧题按题干补判
	fig: parse<any>(q.fig ?? null, null), // 题图（Claude 的画板），网页画出来
	created_at: q.created_at,
});
const inList = (ids: number[]) => ids.map(() => "?").join(",");
const idsParam = (s: string | undefined) =>
	(s ?? "")
		.split(",")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0)
		.slice(0, 100);

const MAX_PHOTO = 1_400_000; // D1 单行上限约 2MB，base64 后会变大

async function savePhoto(env: Env, file: File, prefix: string) {
	if (file.size > MAX_PHOTO) throw new Error("图片太大（需小于 1.4MB）");
	const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
	const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
	const bytes = new Uint8Array(await file.arrayBuffer());
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	await env.DB.prepare("INSERT INTO photos (key, content_type, data) VALUES (?, ?, ?)")
		.bind(key, file.type || "image/jpeg", btoa(bin))
		.run();
	return key;
}

// 今日练习：到期的错题 + 还没做过的新题（有待批改作答的题先不出）
async function todayQuestions(db: D1Database): Promise<Q[]> {
	const due = await db
		.prepare(
			`SELECT q.* FROM questions q JOIN review_queue r ON r.question_id = q.id
			 WHERE r.next_date <= ? AND q.status = 'active' AND ${live()}
			   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改')
			 ORDER BY r.next_date, q.id`,
		)
		.bind(today())
		.all<Q>();
	const fresh = await db
		.prepare(
			`SELECT * FROM questions q WHERE q.source = '同类题' AND q.status = 'active' AND ${live()} AND ${ready()}
			 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY q.id`,
		)
		.bind(today())
		.all<Q>();
	const seen = new Set(due.results.map((q) => q.id)); // 放回复习的新题可能两边都有，去重
	return [...due.results, ...fresh.results.filter((q) => !seen.has(q.id))];
}

// 按科目自由练：没做过的 + 做错还没掌握的（已掌握/已做对的不再出现）
async function subjectQuestions(db: D1Database, subject: string): Promise<Q[]> {
	const { results } = await db
		.prepare(
			`SELECT q.* FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE q.subject = ? AND q.status = 'active' AND ${live()} AND ${ready()}
			   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改')
			   AND (r.question_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id))
			 ORDER BY (r.question_id IS NOT NULL), q.id LIMIT 50`,
		)
		.bind(subject, today())
		.all<Q>();
	return results;
}

// ---------- 首页 ----------
app.get("/api/home", async (c) => {
	if (c.req.query("brief") === "1") { // 首页一次拿全（数据 + Max 建议），少一次请求
		const [h, b] = await Promise.all([homeData(c.env.DB), brief(c.env, false, c.executionCtx).catch(() => null)]);
		return c.json({ ...h, brief: b && { ...b, budget: Math.min(100, Math.round((await used(c.env.DB)) / 98)) } });
	}
	return c.json(await homeData(c.env.DB));
});
async function homeData(db: D1Database) {
	const [qs, pending, wrong, subjects, ungraded, marked, recent, exams, days_, right7] = await Promise.all([
		todayQuestions(db),
		db.prepare("SELECT COUNT(*) n FROM uploads WHERE status = '待处理'").first<{ n: number }>(),
		db.prepare(`SELECT COUNT(*) n FROM review_queue r JOIN questions q ON q.id = r.question_id WHERE q.status = 'active' AND ${live()}`).first<{ n: number }>(),
		db
			.prepare(
				`SELECT q.subject, COUNT(*) total,
				        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) AND ${ready()} THEN 1 ELSE 0 END) undone,
				        SUM(CASE WHEN r.next_date <= ? THEN 1 ELSE 0 END) due
				 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
				 WHERE q.status = 'active' AND ${live()} GROUP BY q.subject ORDER BY q.subject`,
			)
			.bind(today(), today())
			.all(),
		db.prepare("SELECT COUNT(*) n FROM attempts WHERE status = '待批改' AND grader IS NULL").first<{ n: number }>(), // Max 在批的不算
		db.prepare("SELECT COUNT(*) n FROM marks WHERE attempt_id IS NOT NULL AND created_at > datetime('now','-1 day')").first<{ n: number }>(),
		db.prepare(`SELECT id, subject, no, type, tag, board, stem, options, created_at FROM questions q WHERE q.status = 'active' AND ${live()} ORDER BY id DESC LIMIT 8`).all<any>(),
		db.prepare("SELECT v FROM meta WHERE k = 'exams'").first<{ v: string }>(),
		// 打卡：按北京时间统计每天有没有做题，近 7 天做对多少
		db.prepare("SELECT DISTINCT date(created_at, '+8 hours') d FROM attempts ORDER BY d DESC LIMIT 400").all<{ d: string }>(),
		db.prepare("SELECT COUNT(*) n FROM attempts WHERE is_correct = 1 AND created_at > datetime('now', '-7 days')").first<{ n: number }>(),
	]);
	const days = new Set(days_.results.map((r) => r.d));
	let streak = 0;
	for (let d = days.has(today()) ? today() : addDays(today(), -1); days.has(d); d = addDays(d, -1)) streak++; // 今天还没做不算断
	return {
		today_count: qs.length,
		pending_uploads: pending?.n ?? 0,
		pending_grades: ungraded?.n ?? 0,
		queue_count: wrong?.n ?? 0,
		subjects: subjects.results,
		marked: marked?.n ?? 0,
		exams: parse<{ name: string; date: string }[]>(exams?.v ?? null, []).filter((e) => e.date >= today()).sort((a, b) => a.date.localeCompare(b.date)),
		today: today(),
		streak,
		done_today: days.has(today()),
		right7: right7?.n ?? 0,
		recent: recent.results.map((q) => ({ id: q.id, subject: q.subject, tag: pick({ ...q, opts: !!q.options }).tag, stem: (label(q) + q.stem).slice(0, 60), created_at: q.created_at })),
	};
}

app.post("/api/uploads", async (c) => {
	const form = await c.req.formData();
	const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
	if (!files.length) return c.json({ error: "没有文件" }, 400);
	for (const f of files) {
		const key = await savePhoto(c.env, f, "uploads");
		await c.env.DB.prepare("INSERT INTO uploads (r2_key, status) VALUES (?, '待处理')").bind(key).run();
	}
	return c.json({ ok: true, count: files.length });
});

app.post("/api/attempt-photo", async (c) => {
	const form = await c.req.formData();
	const f = form.get("file");
	if (!f || typeof f === "string") return c.json({ error: "没有文件" }, 400);
	// kind=board：作图板导出的图（只有含手绘时才发给 Claude）
	return c.json({ key: await savePhoto(c.env, f, ({ board: "boards", view: "views" } as Record<string, string>)[String(form.get("kind"))] ?? "attempts") }); // boards 发给 Claude；views 只给自己看
});

app.get("/photo/*", async (c) => {
	let key: string;
	try { key = decodeURIComponent(new URL(c.req.url).pathname.slice("/photo/".length)); } catch { return c.notFound(); } // 地址里 % 编码坏了：当作没有，不报 500
	const row = await c.env.DB.prepare("SELECT content_type, data FROM photos WHERE key = ?")
		.bind(key)
		.first<{ content_type: string; data: string }>();
	if (!row) return c.notFound();
	const etag = `"${key}"`; // 文件名随机、内容不变，当作强校验值
	if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" } });
	const bin = atob(row.data), bytes = new Uint8Array(bin.length); // 普通循环解码：比 Uint8Array.from(…, 回调) 快，大图省 CPU
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Response(bytes, {
		headers: { "content-type": row.content_type, "cache-control": "private, max-age=31536000, immutable", etag }, // 文件名随机，内容不会变
	});
});

// ---------- 做题 ----------
app.get("/api/practice", async (c) => {
	const ids = idsParam(c.req.query("ids"));
	const subject = c.req.query("subject");
	if (subject) return c.json((await subjectQuestions(c.env.DB, subject)).map(clientQ));
	const topic = c.req.query("topic"); // Max 推荐的「科目/考点」：错过的优先
	if (topic) {
		const [s, t] = topic.split("/");
		const { results } = await c.env.DB.prepare(
			`SELECT q.* FROM questions q WHERE q.status = 'active' AND ${live()} AND q.subject = ?1 AND (?2 IS NULL OR COALESCE(q.topic, q.category, '未分类') LIKE '%' || ?2 || '%' OR COALESCE(q.tag, '') LIKE '%' || ?2 || '%') AND (q.due IS NULL OR q.due <= ?3)
			 ORDER BY EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) DESC, q.id DESC LIMIT 20`).bind(s, t || null, today()).all<Q>();
		return c.json(results.map(clientQ));
	}
	if (!ids.length) return c.json((await todayQuestions(c.env.DB)).map(clientQ));
	const { results } = await c.env.DB
		.prepare(`SELECT * FROM questions WHERE id IN (${inList(ids)})`)
		.bind(...ids)
		.all<Q>();
	const order = new Map(ids.map((id, i) => [id, i]));
	return c.json(results.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(clientQ));
});

type Item = { question_id: number; answer: string | string[]; photo_keys?: string[]; time_spent_sec?: number; work?: string; attempt_id?: number; hand?: boolean };

app.post("/api/submit", async (c) => {
	const { items } = await c.req.json<{ items: Item[] }>();
	if (!Array.isArray(items) || !items.length) return c.json({ error: "没有作答" }, 400);
	const db = c.env.DB;
	const attemptIds: number[] = [], toMax: { id: number; fallback: number | null }[] = [], toClaude: number[] = [];
	for (const it of items) {
		const q = await db.prepare("SELECT * FROM questions WHERE id = ?").bind(it.question_id).first<Q>();
		if (!q) continue;
		const ans = Array.isArray(it.answer) ? [...it.answer].sort().join("") : String(it.answer ?? "");
		const text = it.work ? (ans ? ans + "\n" : "") + it.work : ans; // 画板过程附在答案后，给 Claude 看
		const photo = (it.photo_keys ?? []).filter((k) => /^(attempts|boards|views)\/[\w.-]+$/.test(k)).join(",") || null;
		const secs = Math.max(0, Math.min(Math.round(Number(it.time_spent_sec) || 0), 86400));
		// 改答案：更新原来那条作答（不新增），简答重新待批改，客观题重新判分
		const old = it.attempt_id
			? await db.prepare("SELECT id, is_correct FROM attempts WHERE id = ? AND question_id = ?").bind(it.attempt_id, q.id).first<{ id: number; is_correct: number | null }>()
			: null;
		// 判分：选择题网站直接判；填空先比对答案，对不上再让 Max 看是不是等价写法；文字解答 Max 批；作图、照片、手写交给 Claude
		const site = q.type === "short" || it.hand ? null : judge(q.type, parse<string[]>(q.answer, []), it.answer) ? 1 : 0;
		const mx = !it.hand && (q.type === "short" || (q.type === "fill" && site === 0 && ans.trim() !== "")) ? byMax(q, it.work ?? "", it.photo_keys ?? [], !!it.hand) : false; // 作图题有画板描述也先给 Max
		const ok = mx ? null : site;
		const status = ok == null ? "待批改" : "已判", grader = mx ? "max" : null;
		let id = old?.id;
		if (old) {
			await db
				.prepare("UPDATE attempts SET answer_text = ?, photo_key = COALESCE(?, photo_key), is_correct = ?, score = ?, comment = NULL, error_reason = NULL, status = ?, time_spent_sec = ?, grader = ?, max_score = NULL, max_comment = NULL, max_sure = NULL WHERE id = ?")
				.bind(text, photo, ok, ok == null ? null : ok * 100, status, secs, grader, old.id)
				.run();
		} else {
			id = (await db
				.prepare("INSERT INTO attempts (question_id, subject, topic, answer_text, photo_key, is_correct, score, status, time_spent_sec, grader) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.bind(q.id, q.subject, q.topic, text, photo, ok, ok == null ? null : ok * 100, status, secs, grader)
				.run()).meta.last_row_id;
		}
		if (ok != null && ok !== old?.is_correct) await updateQueue(db, q.id, !!ok);
		if (old && ok === 0) await db.prepare("UPDATE questions SET max_at = NULL WHERE id = ?").bind(q.id).run(); // 改了答案还是错：让 Max 重新分析错因
		attemptIds.push(id!);
		if (mx) toMax.push({ id: id!, fallback: q.type === "fill" ? site : null });
		else if (ok == null) toClaude.push(id!);
		await db.prepare("UPDATE marks SET attempt_id = ? WHERE question_id = ?").bind(id!, q.id).run(); // 标记过的题：交卷后进临时文件夹
	}
	// 模型活都排进后台队列（见 jobs.ts）：请求里先试跑，被平台切断的由定时任务接着做，不会卡在「批改中」
	if (toMax.length) await enqueueNow(c.env, c.executionCtx, "grade"); // Max 批改，结果页轮询会显示
	if (toClaude.length) await enqueueNow(c.env, c.executionCtx, "pregrade", JSON.stringify(toClaude)); // 交给 Claude 的：Max 先写初评，Claude 看得少
	if (toMax.length || toClaude.length) await enqueue(c.env, "organize"); // 新错题攒够 5 道才让 Max 分析一次（定时任务做）
	if (attemptIds.length) await db.prepare("INSERT INTO meta (k, v) VALUES ('br:dirty', datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(); // 首页建议：下次打开时（距上次 ≥30 分钟）重算
	return c.json({ attempt_ids: attemptIds });
});

// 结果页（也用于稍后刷新查看批改）
app.get("/api/attempts", async (c) => {
	const ids = idsParam(c.req.query("ids"));
	if (!ids.length) return c.json([]);
	const { results } = await c.env.DB
		.prepare(
			`SELECT a.id, a.answer_text, a.photo_key, a.is_correct, a.score, a.comment, a.error_reason, a.status, a.grader, a.max_score, a.max_comment, a.max_sure, q.tag, q.board, q.fig,
			        a.question_id, a.subject, COALESCE(q.topic, a.topic) topic, q.type, EXISTS (SELECT 1 FROM marks m WHERE m.question_id = a.question_id AND m.created_at > datetime('now','-1 day')) marked, EXISTS (SELECT 1 FROM attempts p WHERE p.question_id = a.question_id AND p.id < a.id AND p.status = '已判') prev, COALESCE(q.stem, '（题目已删除）') stem, q.no, q.options, q.answer, q.explanation
			 FROM attempts a LEFT JOIN questions q ON q.id = a.question_id
			 WHERE a.id IN (${inList(ids)}) ORDER BY a.id`,
		)
		.bind(...ids)
		.all<Record<string, any>>();
	// 还有 Max 没批完的（含被切断卡在「批改中」的）：确认批改任务在队列里（已在排/在跑就不重复）
	if (results.some((r) => r.status === "待批改" && (r.grader === "max" || r.grader === "maxing"))) await enqueueNow(c.env, c.executionCtx, "grade");
	return c.json(
		results.map((r) => ({
			...r,
			tag: r.stem ? pick({ ...r, opts: !!r.options } as any).tag : null,
			board: undefined,
			stem: label(r as Q) + r.stem,
			options: parse<string[]>(r.options, []),
			answer: parse<string[]>(r.answer, []),
			fig: parse<any>(r.fig ?? null, null),
			photos: r.photo_key ? String(r.photo_key).split(",") : [],
			photo_key: undefined,
		})),
	);
});

// ---------- 题库 / 错题本 ----------
const WRONG_SQL = {
	active: `q.status = 'active' AND ${live()} AND ${wrongSql()}`,
	mastered: "q.status = 'mastered'", // 错题文件夹
};

async function listQuestions(db: D1Database, wrong?: keyof typeof WRONG_SQL) {
	const { results } = await db
		.prepare(
			`SELECT q.id, q.subject, q.category, q.topic, q.type, q.subject || '·' || q.stem stem, q.source, q.created_at, r.next_date, r.stage,
			        q.max_reason, q.max_note, q.tag, q.due,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) tries,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) wrongs,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改') pending,
			        (SELECT is_correct FROM attempts a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1) last
			 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE ${wrong ? WRONG_SQL[wrong] : `q.status = 'active' AND ${live()} AND NOT ${wrongSql()} AND NOT EXISTS (SELECT 1 FROM attempts ac WHERE ac.question_id = q.id AND ac.is_correct = 1)`}
			 ORDER BY q.subject, q.category, q.topic, q.id`,
		)
		.all();
	return { items: results, today: today() }; // 错因只用 Max 分析的（max_reason + max_note）
}

app.get("/api/bank", async (c) => c.json(await listQuestions(c.env.DB)));
app.get("/api/wrong", async (c) => {
	const env = c.env, tab = c.req.query("tab") === "mastered" ? "mastered" : "active";
	const out: Record<string, unknown> = await listQuestions(env.DB, tab);
	// 看页面不触发 Max（不花额度）：整理在交卷后攒够 5 道、每天凌晨定时、或手动点按钮时才做
	if (tab === "mastered") out.folder = parse<{ text?: string } | null>((await env.DB.prepare("SELECT v FROM meta WHERE k = 'folder_sum'").first<{ v: string }>())?.v ?? null, null)?.text ?? null; // 存坏了也不让整页 500
	return c.json(out);
});
// 标记 / 取消标记（临时文件夹，24 小时过期）
app.post("/api/mark", async (c) => {
	const { question_id, on } = await c.req.json<{ question_id: number; on: boolean }>();
	const db = c.env.DB;
	await (on
		? db.prepare("INSERT INTO marks (question_id) VALUES (?) ON CONFLICT(question_id) DO NOTHING").bind(question_id) // 重复标记不清掉已关联的作答
		: db.prepare("DELETE FROM marks WHERE question_id = ?").bind(question_id)).run();
	return c.json({ ok: true });
});
app.post("/api/question/:id/delete", async (c) => (await removeQuestion(c.env.DB, Number(c.req.param("id"))), c.json({ ok: true })));
app.post("/api/question/:id/master", async (c) => (await masterQuestion(c.env.DB, Number(c.req.param("id"))), c.json({ ok: true })));

// 单题详情：答案、解析、历史作答（只有用户自己能看）
app.get("/api/question/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const q = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<Q>();
	if (!q) return c.notFound();
	const { results } = await c.env.DB
		.prepare(
			`SELECT id, answer_text, photo_key, is_correct, score, comment, error_reason, status, created_at, time_spent_sec
			 FROM attempts WHERE question_id = ? ORDER BY id DESC LIMIT 10`,
		)
		.bind(id)
		.all<Record<string, any>>();
	return c.json({
		...clientQ(q),
		stem: label(q) + q.stem, // 错题本展开：仍是「科目·题干」
		answer: parse<string[]>(q.answer, []),
		explanation: q.explanation,
		attempts: results.map((r) => ({ ...r, error_reason: r.is_correct === 0 ? q.max_reason || r.error_reason : r.error_reason, photos: r.photo_key ? String(r.photo_key).split(",") : [], photo_key: undefined })),
	});
});

// ---------- Max 助手 ----------
app.get("/api/max/brief", async (c) => c.json({ ...(await brief(c.env, c.req.query("force") === "1", c.executionCtx)), budget: Math.min(100, Math.round((await used(c.env.DB)) / 98)) }));
// 换题时网页先取这题的「小卡片」（考点、题型；交卷后才带答案和解析）：问「考什么/答案/解析」网页直接回，不用叫模型、不花额度
app.get("/api/max/prep", async (c) => {
	const db = c.env.DB, qid = Number(c.req.query("q")) || 0, aid = Number(c.req.query("a")) || 0;
	const r = aid
		? await db.prepare("SELECT q.subject, q.stem, q.options, q.topic, q.category, q.tag, q.type, q.answer, q.explanation, a.status FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id = ?").bind(aid).first<any>()
		: qid ? await db.prepare("SELECT subject, stem, options, topic, category, tag, type FROM questions WHERE id = ?").bind(qid).first<any>() : null;
	if (!r) return c.json(null);
	const done = !!aid && r.status === "已判";
	return c.json({ topic: r.topic, category: r.category, tag: pick({ ...r, opts: !!r.options }).tag, done, ans: done ? parse<string[]>(r.answer, []) : undefined, exp: done ? r.explanation || "" : undefined });
});
app.get("/api/max/status", async (c) => c.json(await status(c.env, c.req.query("fresh") === "1")));
app.post("/api/max/kimi", async (c) => c.json(await kimiRun(c.env)));
app.get("/api/max/wrongsum", async (c) => c.json(await wrongSummary(c.env, c.req.query("force") === "1", c.executionCtx)));
app.post("/api/max/organize", async (c) => {
	try { return c.json({ done: await organize(c.env, 10), left: await unorganized(c.env.DB) }); }
	catch (e) { return c.json({ error: e instanceof MaxErr ? e.message : "整理失败：" + (e as Error).message }, 429); }
});
// 手动整理分类：后台进行，网页轮询 GET 看进度（见 startClassify）
app.post("/api/max/classify", async (c) => c.json(await startClassify(c.env, c.executionCtx)));
app.get("/api/max/classify", async (c) => c.json(await classifyState(c.env.DB)));
// 考点 → Notion 笔记链接（没设 NOTION_TOKEN 返回 setup:true，网页就不显示按钮）
app.get("/api/notion", async (c) => {
	try { return c.json(await findNote(c.env, String(c.req.query("subject") ?? ""), String(c.req.query("topic") ?? ""))); }
	catch (e) { return c.json({ note: null, error: (e as Error).message }); }
});
// Max 看图：学生发的照片先转写成文字（前端再把文字连同问题发给 /api/max/chat）
app.post("/api/max/see", async (c) => {
	const b = await c.req.json<{ image?: string; q?: string }>().catch(() => ({}) as { image?: string; q?: string });
	const img = String(b.image ?? "");
	if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(img) || img.length > 3_000_000) return c.json({ error: "图片格式不对或太大" }, 400);
	try { return c.json({ text: await see(c.env, img, String(b.q ?? "").slice(0, 300), () => chatQuota(c.env.DB)) }); }
	catch (e) { return c.json({ error: e instanceof MaxErr ? e.message : "看图失败：" + (e as Error).message }, e instanceof MaxErr ? 429 : 500); }
});
// 现场出题（题库没有同类题时）：临时题不进题库，答案一起发给网页当场判
app.post("/api/max/gen", async (c) => {
	const b = await c.req.json<{ topic?: string; n?: number; like?: number }>().catch(() => ({}) as { topic?: string; n?: number; like?: number });
	try { return c.json({ questions: await gen(c.env, String(b.topic ?? "").slice(0, 40), Number(b.n) || 5, () => chatQuota(c.env.DB), Number(b.like) || undefined) }); }
	catch (e) { return c.json({ error: e instanceof MaxErr ? e.message : "出题失败：" + (e as Error).message }, e instanceof MaxErr ? 429 : 500); }
});
// 清理题库：dry=1 只数一数；否则真删（网页确认后才会调）
// Max 的网站动作：dry=1 只数一数（给确认框用），否则真做
app.post("/api/max/do", async (c) => {
	const b = await c.req.json<{ name?: string; arg?: string; dry?: boolean }>().catch(() => ({}) as { name?: string; arg?: string; dry?: boolean });
	try { return c.json(await runAction(c.env, c.executionCtx, String(b.name ?? "").slice(0, 10), String(b.arg ?? "").slice(0, 80), !!b.dry)); }
	catch (e) { return c.json({ error: e instanceof MaxErr ? e.message : "失败：" + (e as Error).message }, e instanceof MaxErr ? 400 : 500); }
});
app.post("/api/max/chat", async (c) => {
	const body = await c.req.json<{ messages?: unknown; ctx?: any }>().catch(() => ({}) as { messages?: unknown; ctx?: any });
	const ctx = body.ctx && typeof body.ctx === "object" ? body.ctx : {};
	const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m: any) => m && typeof m.content === "string" && m.content.trim())
		.slice(-6).map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 800) }) as { role: "user" | "assistant"; content: string });
	if (!messages.length) return c.json({ error: "说点什么吧" }, 400);
	const pg = ctx.page && typeof ctx.page === "object" ? { path: String(ctx.page.path ?? "").slice(0, 60), title: String(ctx.page.title ?? "").slice(0, 60), text: String(ctx.page.text ?? "").slice(0, 1500) } : undefined;
	const t = ctx.tmp && typeof ctx.tmp === "object" && typeof ctx.tmp.stem === "string" ? ctx.tmp : null; // 临时练习题（不在题库）：网页把题带过来
	const tmp = t ? { stem: t.stem.slice(0, 500), options: (Array.isArray(t.options) ? t.options : []).slice(0, 4).map((o: unknown) => String(o).slice(0, 120)), answer: String(t.answer ?? "").slice(0, 120),
		mine: String(t.mine ?? "").slice(0, 120), exp: String(t.exp ?? "").slice(0, 150), done: !!t.done } : undefined;
	try {
		const r = await chat(c.env, messages, { q: Number(ctx.q) || undefined, a: Number(ctx.a) || undefined, explain: Number(ctx.explain) || undefined, cmp: !!ctx.cmp, marked: !!ctx.marked, web: !!ctx.web, deep: !!ctx.deep, tmp, page: pg,
			len: ["s", "m", "l"].includes(ctx.len) ? ctx.len : "m", pref: ["auto", "ds", "cf"].includes(ctx.pref) ? ctx.pref : "auto" }, () => chatQuota(c.env.DB));
		return new Response(r.cached ?? r.stream!, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-max-engine": r.cached ? "cache" : r.engine ?? "", ...(r.web != null ? { "x-max-web": String(r.web) } : {}) } });
	} catch (e) {
		return c.json({ error: e instanceof MaxErr ? e.message : "Max 出错了：" + (e as Error).message }, e instanceof MaxErr ? 429 : 500);
	}
});

// 其余请求：已登录后交给静态页面
app.all("*", async (c) => {
	if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
	const res = await c.env.ASSETS.fetch(c.req.raw), r = new Response(res.body, res);
	r.headers.set("Cache-Control", "no-cache"); // 页面每次向服务器确认（没变只回 304）；脚本、样式、字体由 Cloudflare 直接发（见 _headers）
	return r;
});

// OAuth 元数据里要写本站网址，所以按请求的 origin 建 provider（自定义域名也能用）
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string) {
	let p = providers.get(origin);
	if (!p) {
		p = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpHandler,
			defaultHandler: { fetch: app.fetch },
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			scopesSupported: ["mcp"],
			requiredScopes: ["mcp"],
			resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
			clientIdMetadataDocumentEnabled: true,
		});
		providers.set(origin, p);
	}
	return p;
}

export default {
	fetch: async (req, env, ctx) => (await edge(req, env)) ?? providerFor(new URL(req.url).origin).fetch(req, env, ctx),
	// 每分钟：做后台任务队列里的活（见 jobs.ts）；北京时间 2:30：清空错题文件夹；3:17：清理 + Max 把当天要用的先想好
	scheduled: (e, env, ctx) => ctx.waitUntil(e.cron === "* * * * *" ? Promise.all([runJobs(env, "cron"), kimiCheck(env), env.DB.prepare("DELETE FROM marks WHERE created_at < datetime('now','-1 day')").run()]) : e.cron === "30 18 * * *" ? clearFolder(env.DB) : dailyCleanup(env.DB).then(() => maxDaily(env))),
} satisfies ExportedHandler<Env>;
