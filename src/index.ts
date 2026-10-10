import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mountAuthorize } from "./authorize";
import { passcodeOk } from "./auth";
import { mcpHandler } from "./mcp";
import { judge } from "./judge";
import { pick } from "./tags";
import { cause } from "./cause";
import { loginPage } from "./login";
import { addDays, dailyCleanup, masterQuestion, removeQuestion, today, updateQueue } from "./review";

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
	options: string | null;
	answer: string;
	explanation: string | null;
	source: string;
};

const COOKIE = "session";
const app = new Hono<{ Bindings: Env }>();
app.onError((e, c) => c.json({ error: e.message }, 500));

// ---------- 登录 ----------
app.get("/login", (c) => c.html(loginPage()));
app.post("/login", async (c) => {
	if (!c.env.PASSCODE) return c.html(loginPage("服务器还没设置 PASSCODE"), 500);
	const form = await c.req.parseBody();
	if (!(await passcodeOk(String(form.passcode ?? ""), c.env.PASSCODE))) {
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
	if (p === "/style.css" || p.startsWith("/fonts/")) return next(); // 登录页要用的样式和字体
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
const clientQ = (q: Q) => ({
	id: q.id,
	subject: q.subject,
	category: q.category,
	topic: q.topic,
	type: q.type,
	stem: q.stem,
	options: parse<string[]>(q.options, []),
	...pick({ ...q, opts: !!q.options }), // tag、board：旧题按题干补判
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
			 WHERE r.next_date <= ?
			   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改')
			 ORDER BY r.next_date, q.id`,
		)
		.bind(today())
		.all<Q>();
	const fresh = await db
		.prepare(
			`SELECT * FROM questions q WHERE q.source = '同类题' AND q.status = 'active'
			 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY q.id`,
		)
		.all<Q>();
	const seen = new Set(due.results.map((q) => q.id)); // 放回复习的新题可能两边都有，去重
	return [...due.results, ...fresh.results.filter((q) => !seen.has(q.id))];
}

// 按科目自由练：没做过的 + 做错还没掌握的（已掌握/已做对的不再出现）
async function subjectQuestions(db: D1Database, subject: string): Promise<Q[]> {
	const { results } = await db
		.prepare(
			`SELECT q.* FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE q.subject = ? AND q.status = 'active'
			   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改')
			   AND (r.question_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id))
			 ORDER BY (r.question_id IS NOT NULL), q.id LIMIT 50`,
		)
		.bind(subject)
		.all<Q>();
	return results;
}

// ---------- 首页 ----------
app.get("/api/home", async (c) => {
	const db = c.env.DB;
	const [qs, summary, pending, wrong, subjects, ungraded, marked, recent, exams, days_, right7] = await Promise.all([
		todayQuestions(db),
		db.prepare("SELECT text, created_at FROM summaries ORDER BY id DESC LIMIT 1").first(),
		db.prepare("SELECT COUNT(*) n FROM uploads WHERE status = '待处理'").first<{ n: number }>(),
		db.prepare("SELECT COUNT(*) n FROM review_queue").first<{ n: number }>(),
		db
			.prepare(
				`SELECT q.subject, COUNT(*) total,
				        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) THEN 1 ELSE 0 END) undone,
				        SUM(CASE WHEN r.next_date <= ? THEN 1 ELSE 0 END) due
				 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
				 WHERE q.status = 'active' GROUP BY q.subject ORDER BY q.subject`,
			)
			.bind(today())
			.all(),
		db.prepare(`SELECT COUNT(*) n FROM attempts a WHERE a.status = '待批改' OR (a.is_correct = 0 AND a.comment IS NULL AND a.id = (SELECT MAX(id) FROM attempts WHERE question_id = a.question_id))`).first<{ n: number }>(), // 待批改 + 错题待讲解
		db.prepare("SELECT COUNT(*) n FROM marks WHERE attempt_id IS NOT NULL AND created_at > datetime('now','-1 day')").first<{ n: number }>(),
		db.prepare("SELECT id, subject, type, tag, board, stem, options, created_at FROM questions WHERE status = 'active' ORDER BY id DESC LIMIT 8").all<any>(),
		db.prepare("SELECT v FROM meta WHERE k = 'exams'").first<{ v: string }>(),
		// 打卡：按北京时间统计每天有没有做题，近 7 天做对多少
		db.prepare("SELECT DISTINCT date(created_at, '+8 hours') d FROM attempts ORDER BY d DESC LIMIT 400").all<{ d: string }>(),
		db.prepare("SELECT COUNT(*) n FROM attempts WHERE is_correct = 1 AND created_at > datetime('now', '-7 days')").first<{ n: number }>(),
	]);
	const days = new Set(days_.results.map((r) => r.d));
	let streak = 0;
	for (let d = days.has(today()) ? today() : addDays(today(), -1); days.has(d); d = addDays(d, -1)) streak++; // 今天还没做不算断
	return c.json({
		today_count: qs.length,
		summary,
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
		recent: recent.results.map((q) => ({ id: q.id, subject: q.subject, tag: pick({ ...q, opts: !!q.options }).tag, stem: q.stem.slice(0, 60), created_at: q.created_at })),
	});
});

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
	const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/photo/".length));
	const row = await c.env.DB.prepare("SELECT content_type, data FROM photos WHERE key = ?")
		.bind(key)
		.first<{ content_type: string; data: string }>();
	if (!row) return c.notFound();
	return new Response(Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0)), {
		headers: { "content-type": row.content_type, "cache-control": "private, max-age=31536000, immutable" }, // 文件名随机，内容不会变
	});
});

// ---------- 做题 ----------
app.get("/api/practice", async (c) => {
	const ids = idsParam(c.req.query("ids"));
	const subject = c.req.query("subject");
	if (subject) return c.json((await subjectQuestions(c.env.DB, subject)).map(clientQ));
	if (!ids.length) return c.json((await todayQuestions(c.env.DB)).map(clientQ));
	const { results } = await c.env.DB
		.prepare(`SELECT * FROM questions WHERE id IN (${inList(ids)})`)
		.bind(...ids)
		.all<Q>();
	const order = new Map(ids.map((id, i) => [id, i]));
	return c.json(results.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(clientQ));
});

type Item = { question_id: number; answer: string | string[]; photo_keys?: string[]; time_spent_sec?: number; work?: string; attempt_id?: number };

app.post("/api/submit", async (c) => {
	const { items } = await c.req.json<{ items: Item[] }>();
	if (!Array.isArray(items) || !items.length) return c.json({ error: "没有作答" }, 400);
	const db = c.env.DB;
	const attemptIds: number[] = [];
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
		// 判分：选择、填空网站直接判（Claude 出题时已给答案）；简答（作图、写过程）交给 Claude
		const ok = q.type === "short" ? null : judge(q.type, parse<string[]>(q.answer, []), it.answer) ? 1 : 0;
		const status = ok == null ? "待批改" : "已判";
		let id = old?.id;
		if (old) {
			await db
				.prepare("UPDATE attempts SET answer_text = ?, photo_key = COALESCE(?, photo_key), is_correct = ?, score = ?, comment = NULL, error_reason = NULL, status = ?, time_spent_sec = ? WHERE id = ?")
				.bind(text, photo, ok, ok == null ? null : ok * 100, status, secs, old.id)
				.run();
		} else {
			id = (await db
				.prepare("INSERT INTO attempts (question_id, subject, topic, answer_text, photo_key, is_correct, score, status, time_spent_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.bind(q.id, q.subject, q.topic, text, photo, ok, ok == null ? null : ok * 100, status, secs)
				.run()).meta.last_row_id;
		}
		if (ok != null && ok !== old?.is_correct) await updateQueue(db, q.id, !!ok);
		attemptIds.push(id!);
		await db.prepare("UPDATE marks SET attempt_id = ? WHERE question_id = ?").bind(id!, q.id).run(); // 标记过的题：交卷后进临时文件夹
	}
	return c.json({ attempt_ids: attemptIds });
});

// 结果页（也用于稍后刷新查看批改）
app.get("/api/attempts", async (c) => {
	const ids = idsParam(c.req.query("ids"));
	if (!ids.length) return c.json([]);
	const { results } = await c.env.DB
		.prepare(
			`SELECT a.id, a.answer_text, a.photo_key, a.is_correct, a.score, a.comment, a.error_reason, a.status,
			        a.question_id, a.subject, COALESCE(q.topic, a.topic) topic, q.type, EXISTS (SELECT 1 FROM marks m WHERE m.question_id = a.question_id) marked, COALESCE(q.stem, '（题目已删除）') stem, q.options, q.answer, q.explanation
			 FROM attempts a LEFT JOIN questions q ON q.id = a.question_id
			 WHERE a.id IN (${inList(ids)}) ORDER BY a.id`,
		)
		.bind(...ids)
		.all<Record<string, any>>();
	return c.json(
		results.map((r) => ({
			...r,
			options: parse<string[]>(r.options, []),
			answer: parse<string[]>(r.answer, []),
			photos: r.photo_key ? String(r.photo_key).split(",") : [],
			photo_key: undefined,
		})),
	);
});

// ---------- 题库 / 错题本 ----------
const WRONG_SQL = {
	active: "q.status = 'active' AND EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0)",
	mastered: "q.status = 'mastered'",
};

async function listQuestions(db: D1Database, wrong?: keyof typeof WRONG_SQL) {
	const { results } = await db
		.prepare(
			`SELECT q.id, q.subject, q.category, q.topic, q.type, q.stem, q.source, q.created_at, r.next_date, r.stage,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) tries,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) wrongs,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改') pending,
			        (SELECT is_correct FROM attempts a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1) last
			 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 ${wrong ? "WHERE " + WRONG_SQL[wrong] : ""}
			 ORDER BY q.subject, q.category, q.topic, q.id`,
		)
		.all();
	return { items: results, today: today() };
}

app.get("/api/bank", async (c) => c.json(await listQuestions(c.env.DB)));
app.get("/api/wrong", async (c) => c.json(await listQuestions(c.env.DB, c.req.query("tab") === "mastered" ? "mastered" : "active")));
// 标记 / 取消标记（临时文件夹，24 小时过期）
app.post("/api/mark", async (c) => {
	const { question_id, on } = await c.req.json<{ question_id: number; on: boolean }>();
	const db = c.env.DB;
	await (on
		? db.prepare("INSERT OR REPLACE INTO marks (question_id) VALUES (?)").bind(question_id)
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
		answer: parse<string[]>(q.answer, []),
		explanation: q.explanation,
		attempts: results.map((r) => ({ ...r, error_reason: r.is_correct === 0 ? cause({ ...q, ...r, id: q.id }) : r.error_reason, photos: r.photo_key ? String(r.photo_key).split(",") : [], photo_key: undefined })),
	});
});

// 其余请求：已登录后交给静态页面
app.all("*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw), r = new Response(res.body, res);
	// 字体、KaTeX、MathLive 不会变：缓存一年；页面和脚本每次向服务器确认（没变只回 304，很快），改版后马上用上
	r.headers.set("Cache-Control", /^\/(fonts|katex|mathlive)\//.test(new URL(c.req.url).pathname) ? "public, max-age=31536000, immutable" : "no-cache");
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
	fetch: (req, env, ctx) => providerFor(new URL(req.url).origin).fetch(req, env, ctx),
	scheduled: (_e, env, ctx) => ctx.waitUntil(dailyCleanup(env.DB)), // 每日清理
} satisfies ExportedHandler<Env>;
