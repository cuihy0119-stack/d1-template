import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mountAuthorize } from "./authorize";
import { passcodeOk } from "./auth";
import { mcpHandler } from "./mcp";
import { judge } from "./judge";
import { loginPage } from "./login";
import { today, updateQueue } from "./review";

type Q = {
	id: number;
	subject: string;
	topic: string | null;
	category: string | null;
	board: string | null;
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

app.use("*", async (c, next) => {
	if (new URL(c.req.url).pathname === "/style.css") return next(); // 登录页要用
	if (c.env.PASSCODE && (await getSignedCookie(c, c.env.PASSCODE, COOKIE)) === "ok") return next();
	const p = new URL(c.req.url).pathname;
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
	board: q.board,
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
			`SELECT * FROM questions q WHERE q.source = '同类题'
			 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY q.id`,
		)
		.all<Q>();
	return [...due.results, ...fresh.results];
}

// 按科目自由练：没做过的 + 做错还没掌握的；都做完了就整科重练
async function subjectQuestions(db: D1Database, subject: string): Promise<Q[]> {
	const { results } = await db
		.prepare(
			`SELECT q.* FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE q.subject = ?
			   AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改')
			   AND (r.question_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id))
			 ORDER BY (r.question_id IS NOT NULL), q.id LIMIT 50`,
		)
		.bind(subject)
		.all<Q>();
	if (results.length) return results;
	return (await db.prepare("SELECT * FROM questions WHERE subject = ? ORDER BY id LIMIT 50").bind(subject).all<Q>()).results;
}

// ---------- 首页 ----------
app.get("/api/home", async (c) => {
	const db = c.env.DB;
	const [qs, summary, pending, wrong, subjects] = await Promise.all([
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
				 GROUP BY q.subject ORDER BY q.subject`,
			)
			.bind(today())
			.all(),
	]);
	return c.json({
		today_count: qs.length,
		summary,
		pending_uploads: pending?.n ?? 0,
		queue_count: wrong?.n ?? 0,
		subjects: subjects.results,
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
	return c.json({ key: await savePhoto(c.env, f, form.get("kind") === "board" ? "boards" : "attempts") });
});

app.get("/photo/*", async (c) => {
	const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/photo/".length));
	const row = await c.env.DB.prepare("SELECT content_type, data FROM photos WHERE key = ?")
		.bind(key)
		.first<{ content_type: string; data: string }>();
	if (!row) return c.notFound();
	return new Response(Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0)), {
		headers: { "content-type": row.content_type, "cache-control": "private, max-age=86400" },
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

type Item = { question_id: number; answer: string | string[]; photo_keys?: string[]; time_spent_sec?: number };

app.post("/api/submit", async (c) => {
	const { items } = await c.req.json<{ items: Item[] }>();
	if (!Array.isArray(items) || !items.length) return c.json({ error: "没有作答" }, 400);
	const db = c.env.DB;
	const attemptIds: number[] = [];
	for (const it of items) {
		const q = await db.prepare("SELECT * FROM questions WHERE id = ?").bind(it.question_id).first<Q>();
		if (!q) continue;
		const ans = Array.isArray(it.answer) ? [...it.answer].sort().join("") : String(it.answer ?? "");
		const photo = (it.photo_keys ?? []).filter((k) => /^(attempts|boards)\/[\w.-]+$/.test(k)).join(",") || null;
		const secs = Math.max(0, Math.min(Math.round(Number(it.time_spent_sec) || 0), 86400));
		let res;
		if (q.type === "short") {
			res = await db
				.prepare(
					"INSERT INTO attempts (question_id, answer_text, photo_key, status, time_spent_sec) VALUES (?, ?, ?, '待批改', ?)",
				)
				.bind(q.id, ans, photo, secs)
				.run();
		} else {
			const ok = judge(q.type, parse<string[]>(q.answer, []), it.answer);
			res = await db
				.prepare(
					"INSERT INTO attempts (question_id, answer_text, is_correct, score, status, time_spent_sec) VALUES (?, ?, ?, ?, '已判', ?)",
				)
				.bind(q.id, ans, ok ? 1 : 0, ok ? 100 : 0, secs)
				.run();
			await updateQueue(db, q.id, ok);
		}
		attemptIds.push(res.meta.last_row_id);
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
			        q.id question_id, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation
			 FROM attempts a JOIN questions q ON q.id = a.question_id
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
const WRONG_SQL = "EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0)";

async function listQuestions(db: D1Database, onlyWrong: boolean) {
	const { results } = await db
		.prepare(
			`SELECT q.id, q.subject, q.category, q.topic, q.type, q.stem, q.source, r.next_date, r.stage,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) tries,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) wrongs,
			        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id AND a.status = '待批改') pending
			 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 ${onlyWrong ? "WHERE " + WRONG_SQL : ""}
			 ORDER BY q.subject, q.category, q.topic, q.id`,
		)
		.all();
	return { items: results, today: today() };
}

app.get("/api/bank", async (c) => c.json(await listQuestions(c.env.DB, false)));
app.get("/api/wrong", async (c) => c.json(await listQuestions(c.env.DB, true)));

// 单题详情：答案、解析、历史作答（只有用户自己能看）
app.get("/api/question/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const q = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<Q>();
	if (!q) return c.notFound();
	const { results } = await c.env.DB
		.prepare(
			`SELECT id, answer_text, photo_key, is_correct, score, comment, error_reason, status, created_at
			 FROM attempts WHERE question_id = ? ORDER BY id DESC LIMIT 10`,
		)
		.bind(id)
		.all<Record<string, any>>();
	return c.json({
		...clientQ(q),
		answer: parse<string[]>(q.answer, []),
		explanation: q.explanation,
		attempts: results.map((r) => ({ ...r, photos: r.photo_key ? String(r.photo_key).split(",") : [], photo_key: undefined })),
	});
});

// 其余请求：已登录后交给静态页面
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

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
} satisfies ExportedHandler<Env>;
