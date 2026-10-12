// Kimi 自检：Max 出错/超时时自动记录；同一个模型连续出问题先「熔断」（暂时跳过，不再让学生等超时）；
// 出问题多了，叫 DeepSeek 看日志找原因，只允许它改下面白名单里的几个数字/开关（沙盒）。
// 沙盒边界：只管 Max 的调用参数；不是代码、不碰网站其它部分、数值都有上下限、补丁 24 小时后自动失效。
import { ask } from "./max";

export type Patch = { cfMs?: number; dsMs?: number; waitScale?: number; skip?: Record<string, number> }; // skip: 模型 → 跳到什么时候（毫秒时间戳）
// 白名单：能改什么、范围多大。其余字段一律丢弃。
const LIM = { cfMs: [10000, 40000], dsMs: [10000, 60000], waitScale: [0.8, 2.5] } as const;
const SKIPPABLE = new Set(["@cf/zai-org/glm-4.7-flash", "@cf/qwen/qwen3.8-27b", "ds"]);
const MAX_SKIP = 6 * 3600e3, TTL = 24 * 3600e3, WIN = 30 * 60e3;
type Log = { t: number; m: string; task: string; err: string };

const get = async (db: D1Database, k: string) => (await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first<{ v: string }>())?.v ?? null;
const put = (db: D1Database, k: string, v: string) => db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(k, v).run();
const parse = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clamp = (v: unknown, [lo, hi]: readonly [number, number]) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** 现在生效的补丁（过期的去掉；同一个 Worker 里缓存 20 秒） */
let memo: { at: number; p: Patch } | null = null;
export async function patch(db: D1Database): Promise<Patch> {
	if (memo && Date.now() - memo.at < 20000) return memo.p;
	const raw = parse<Patch & { exp?: number }>(await get(db, "kimi:patch"), {}), now = Date.now();
	const p: Patch = raw.exp && raw.exp < now ? {} : { cfMs: raw.cfMs, dsMs: raw.dsMs, waitScale: raw.waitScale };
	const skip = Object.fromEntries(Object.entries(raw.skip ?? {}).filter(([k, v]) => SKIPPABLE.has(k) && v > now));
	if (Object.keys(skip).length) p.skip = skip;
	memo = { at: now, p };
	return p;
}
const save = async (db: D1Database, p: Patch) => { memo = null; await put(db, "kimi:patch", JSON.stringify({ ...p, exp: Date.now() + TTL })); };

/** 记一次出错/超时；同一个模型 10 分钟内 ≥3 次 → 熔断 30 分钟。额度用完不算故障 */
export async function note(db: D1Database, model: string, task: string, e: unknown) {
	const err = String(e), now = Date.now();
	if (/3036|daily free allocation/i.test(err)) return;
	try {
		const log = parse<Log[]>(await get(db, "kimi:log"), []).filter((x) => now - x.t < WIN * 2);
		log.push({ t: now, m: model, task, err: err.slice(0, 120) });
		await put(db, "kimi:log", JSON.stringify(log.slice(-30)));
		const p = await patch(db);
		if (SKIPPABLE.has(model) && !p.skip?.[model] && log.filter((x) => x.m === model && now - x.t < 10 * 60e3).length >= 3)
			await save(db, { ...p, skip: { ...p.skip, [model]: now + 30 * 60e3 } });
	} catch {}
}

const SYS = `你是 Max 助手的自检员。下面是最近的出错/超时日志和当前补丁。判断原因，只能用补丁调整，不能改代码。
可调字段（超出范围会被截断，其它字段无效）：
cfMs Cloudflare 流式等待毫秒 10000-40000；dsMs DeepSeek 流式等待毫秒 10000-60000；waitScale 一次性回答超时倍数 0.8-2.5；
skip 要暂时跳过的模型 {"@cf/zai-org/glm-4.7-flash":毫秒数,"@cf/qwen/qwen3.8-27b":毫秒数,"ds":毫秒数}（毫秒数=跳过多久，≤21600000）。
原则：超时多 → 适当加大等待或跳过慢的模型；格式不对多 → 跳过那个模型；偶发单次错误 → 不用改（patch 给 {}）。
只输出 JSON：{"cause":"原因≤40字","patch":{}}`;

/** 每分钟定时任务里调用：最近 30 分钟有 ≥3 次故障、且 30 分钟内没自检过，才叫 DeepSeek 看一次（平时一次查询都不花模型额度） */
export async function check(env: Env) {
	const db = env.DB, now = Date.now();
	const log = parse<Log[]>(await get(db, "kimi:log"), []).filter((x) => now - x.t < WIN);
	if (log.length < 3 || now - Number(await get(db, "kimi:last") ?? 0) < WIN) return;
	await put(db, "kimi:last", String(now));
	try {
		const cur = await patch(db);
		const out = await ask(env, [{ role: "system", content: SYS }, { role: "user", content: `当前补丁：${JSON.stringify(cur)}\n日志（${log.length} 条）：\n${log.map((x) => `${Math.round((now - x.t) / 60000)}分钟前｜${x.m}｜${x.task}｜${x.err}`).join("\n")}` }],
			{ max: 300, only: "ds", route: "hard", quiet: true, ok: (t) => /\{[\s\S]*\}/.test(t) });
		const j = JSON.parse(out.match(/\{[\s\S]*\}/)![0]) as { cause?: string; patch?: Patch };
		const r = j.patch ?? {}, next: Patch = { ...cur };
		for (const k of ["cfMs", "dsMs", "waitScale"] as const) { const v = clamp(r[k], LIM[k]); if (v != null) next[k] = v; }
		for (const [m, ms] of Object.entries(r.skip ?? {})) {
			const v = clamp(ms, [0, MAX_SKIP]);
			if (SKIPPABLE.has(m) && v) next.skip = { ...next.skip, [m]: now + v };
		}
		await save(db, next);
		const hist = parse<any[]>(await get(db, "kimi:hist"), []);
		hist.push({ t: now, cause: String(j.cause ?? "").slice(0, 60), patch: next });
		await put(db, "kimi:hist", JSON.stringify(hist.slice(-10)));
	} catch {} // DeepSeek 也不可用：保留熔断即可
}

export async function info(db: D1Database) {
	const [p, last, hist] = await Promise.all([patch(db), get(db, "kimi:last"), get(db, "kimi:hist")]);
	const h = parse<any[]>(hist, []).pop();
	return { patch: p, checkedAt: last ? Number(last) : null, cause: h?.cause ?? null };
}
