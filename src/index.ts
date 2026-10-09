import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { judge } from "./judge";
import { loginPage } from "./login";
import { today, updateQueue } from "./review";

type Q = {
	id: number;
	subject: string;
	topic: string | null;
	type: "single" | "multi" | "fill" | "short";
	stem: string;
	options: string | null;
	answer: string;
	explanation: string | null;
	source: string;
};

const COOKIE = "session";
const app = new Hono<{ Bindings: Env }>();

// ---------- 登录 ----------
async function sha(s: string) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function passcodeOk(input: string, real: string) {
	const [a, b] = await Promise.all([sha(input), sha(real)]);
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
}

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

// /mcp 将在阶段二挂在此处（走 OAuth，不走口令）

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
	topic: q.topic,
	type: q.type,
	stem: q.stem,
	options: parse<string[]>(q.options, []),
});
const inList = (ids: number[]) => ids.map(() => "?").join(",");
const idsParam = (s: string | undefined) =>
	(s ?? "")
		.split(",")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0)
		.slice(0, 100);

async function savePhoto(env: Env, file: File, prefix: string) {
	const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
	const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
	await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
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

// ---------- 首页 ----------
app.get("/api/home", async (c) => {
	const db = c.env.DB;
	const [qs, summary, pending, wrong] = await Promise.all([
		todayQuestions(db),
		db.prepare("SELECT text, created_at FROM summaries ORDER BY id DESC LIMIT 1").first(),
		db.prepare("SELECT COUNT(*) n FROM uploads WHERE status = '待处理'").first<{ n: number }>(),
		db.prepare("SELECT COUNT(*) n FROM review_queue").first<{ n: number }>(),
	]);
	return c.json({
		today_count: qs.length,
		summary,
		pending_uploads: pending?.n ?? 0,
		queue_count: wrong?.n ?? 0,
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
	return c.json({ key: await savePhoto(c.env, f, "attempts") });
});

app.get("/photo/*", async (c) => {
	const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/photo/".length));
	const obj = await c.env.PHOTOS.get(key);
	if (!obj) return c.notFound();
	return new Response(obj.body, {
		headers: {
			"content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
			"cache-control": "private, max-age=86400",
		},
	});
});

// ---------- 做题 ----------
app.get("/api/practice", async (c) => {
	const ids = idsParam(c.req.query("ids"));
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
		const photo = (it.photo_keys ?? []).filter((k) => /^attempts\/[\w.-]+$/.test(k)).join(",") || null;
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
				.bind(q.id, ans, ok ? 1 : 0, ok ? 1 : 0, secs)
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

// ---------- 错题库 ----------
app.get("/api/wrong", async (c) => {
	const subject = c.req.query("subject");
	const { results } = await c.env.DB
		.prepare(
			`SELECT q.id, q.subject, q.topic, q.type, q.stem, r.next_date, r.stage
			 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE (q.source = '原错题' OR r.question_id IS NOT NULL
			        OR EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0))
			   AND (? IS NULL OR q.subject = ?)
			 ORDER BY q.id DESC`,
		)
		.bind(subject ?? null, subject ?? null)
		.all();
	const subjects = await c.env.DB
		.prepare(
			`SELECT DISTINCT q.subject FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
			 WHERE q.source = '原错题' OR r.question_id IS NOT NULL
			    OR EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0)`,
		)
		.all<{ subject: string }>();
	return c.json({ items: results, subjects: subjects.results.map((s) => s.subject) });
});

// 其余请求：已登录后交给静态页面
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
