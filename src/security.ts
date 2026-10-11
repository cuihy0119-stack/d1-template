// 安全与限流（都在内存里判断，不查数据库，不多花用量）：
// - 扫描器常探的路径（.php/.env/wp-admin…）直接 404
// - 登录（网站和 Claude 授权页）每个 IP 每分钟最多 5 次，口令错了再慢一点回，防暴力猜口令
// - 接口每个 IP 每分钟 150 次；Max（AI）每分钟 12 次，每天最多 300 次对话，防被刷额度
// - 所有页面加安全响应头（HTTPS 强制、防嵌入、防类型嗅探、内容安全策略）
import type { Context, Next } from "hono";

const ip = (c: Context) => c.req.header("cf-connecting-ip") || "?";
const SCAN = /\.(php\d?|aspx?|jsp|cgi|env|git|sql|bak|ini|yml|ya?ml)(\/|$)|wp-(admin|login|content|includes)|phpmyadmin|\/\.well-known\/(?!oauth)|\.\.\//i;
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'inline-speculation-rules'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

/** 记一次可疑事件（被限流、口令错）：只在出事时写库，平时不花用量 */
export const flag = (c: Context<{ Bindings: Env }>, kind: string) =>
	c.executionCtx.waitUntil(c.env.DB.prepare("INSERT INTO meta (k, v) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1")
		.bind(`sec:${new Date().toISOString().slice(0, 10)}:${kind}`).run().catch(() => {}));

async function over(rl: RateLimit | undefined, key: string) {
	if (!rl) return false;
	try { return !(await rl.limit({ key })).success; } catch { return false; }
}

export async function guard(c: Context<{ Bindings: Env }>, next: Next) {
	const url = new URL(c.req.url), p = url.pathname, m = c.req.method;
	if (SCAN.test(p)) return c.text("Not Found", 404);
	if (m === "POST" && (p === "/login" || p === "/authorize") && (await over(c.env.RL_LOGIN, "login:" + ip(c)))) {
		flag(c, "login");
		return c.text("尝试太频繁，1 分钟后再试", 429);
	}
	if (p.startsWith("/api/")) {
		if (await over(c.env.RL_API, "api:" + ip(c))) { flag(c, "api"); return c.json({ error: "请求太频繁，稍等一下" }, 429); }
		if (m === "POST" && p.startsWith("/api/max/") && (await over(c.env.RL_AI, "ai:" + ip(c)))) { flag(c, "ai"); return c.json({ error: "问得太快啦，歇一分钟再问 Max" }, 429); }
	}
	await next();
	const h = c.res.headers;
	h.set("X-Content-Type-Options", "nosniff");
	h.set("Referrer-Policy", "strict-origin-when-cross-origin");
	if (url.protocol === "https:") h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	if ((h.get("content-type") || "").includes("text/html")) { h.set("Content-Security-Policy", CSP); h.set("X-Frame-Options", "DENY"); }
}

/** Max 对话每天上限（防 DeepSeek 被刷钱、Cloudflare 额度被刷光） */
export async function chatQuota(db: D1Database) {
	const k = "chat:" + new Date().toISOString().slice(0, 10);
	const n = Number((await db.prepare("INSERT INTO meta (k, v) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").bind(k).first<{ v: string }>())?.v ?? 0);
	return n <= 300;
}
