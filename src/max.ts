// Max 助手 = 两个模型：
//   总管：Cloudflare Workers AI（免费额度每天 1 万神经元，UTC 0 点重置）→ 默认干所有活
//   备用：DeepSeek API（Worker 运行时密钥 DEEPSEEK_API_KEY）→ 遇到难题直接上；总管额度用完、出错、超时、答得不靠谱时顶上
// 同一件事只由一个模型答（按顺序试，成功就停），不会两边重复花钱；批改有抢占标记，不会重复批。
// 省用量：关掉深度思考、限制输出长度、只发必要字段、能缓存的都缓存；作图/照片/手写题不碰，照旧交给 Claude。
import { today, updateQueue } from "./review";
import { pick } from "./tags";
import { wrongLine } from "./cause";

const CF = ["@cf/qwen/qwen3.8-27b", "@cf/zai-org/glm-4.7-flash"]; // 总管 + 总管忙时的替补
const DAILY = 9800, SOFT = 8500; // Cloudflare 估算神经元：超过 SOFT 只留批改，超过 DAILY 不再用
const DS_DAILY = 400_000; // DeepSeek 每天最多用的 token（防止意外花钱）
const PASS = 80;
const REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"]; // 只是作答表的旧约束；Max 的错因写在题目上，不受限
const DRAW = new Set(["作图", "函数", "电路", "光路", "受力", "证明"]); // 作图题：Max 不批，交给 Claude

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Route = "work" | "hard"; // work=平常（总管优先），hard=难题（备用优先）
export class MaxErr extends Error {}

// ---------- 用量 ----------
const day = () => new Date().toISOString().slice(0, 10);
const neurons = (inTok: number, outTok: number) => Math.ceil((inTok * 0.45 + outTok * 3.2) / 11); // 按单价折算（$0.011/千神经元）
const meter = async (db: D1Database, k: string) => Number((await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k + day()).first<{ v: string }>())?.v ?? 0);
const add = (db: D1Database, k: string, n: number) =>
	db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + ?2").bind(k + day(), Math.round(n)).run();
export const used = (db: D1Database) => meter(db, "max:"); // Cloudflare 神经元
const est = (m: Msg[]) => Math.ceil(m.reduce((n, x) => n + x.content.length, 0) * 1.1); // 中文约 1 字 1 token
const clean = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

type Prov = { name: string; call: (m: Msg[], max: number, stream: boolean) => Promise<any>; bill: (inTok: number, outTok: number) => Promise<unknown> };
/** 按任务排好可用的模型：额度不够的跳过 */
// 超时：模型卡住时不让请求一直挂着（流式只管到开始输出）
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), ms))]);

async function providers(env: Env, route: Route, must = false, only?: string): Promise<Prov[]> {
	const db = env.DB, key = (env as any).DEEPSEEK_API_KEY as string | undefined;
	const [cfUsed, dsUsed] = await Promise.all([used(db), key ? meter(db, "ds:") : Promise.resolve(Infinity)]);
	const cf: Prov[] = cfUsed < (must ? DAILY : SOFT) ? CF.map((model) => ({
		name: "cf",
		call: (messages, max, stream) => within(env.AI.run(model as any, {
			messages, max_completion_tokens: max, temperature: 0.3, stream,
			...(stream ? { stream_options: { include_usage: true } } : {}),
			...(model.includes("qwen") ? { reasoning_effort: "low" } : {}),
		} as any).catch(async (e) => {
			if (/3036|daily free allocation/i.test(String(e))) await add(db, "max:", DAILY); // 真用完了：今天不再试
			throw e;
		}), stream ? 25000 : 40000),
		bill: (i, o) => add(db, "max:", neurons(i, o)),
	})) : [];
	const ds: Prov[] = key && dsUsed < DS_DAILY ? [{
		name: "ds",
		call: async (messages, max, stream) => {
			const ac = new AbortController(), t = setTimeout(() => ac.abort(), stream ? 20000 : 40000);
			const r = await fetch("https://api.deepseek.com/chat/completions", {
				method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, signal: ac.signal,
				body: JSON.stringify({ model: (env as any).DEEPSEEK_MODEL || "deepseek-chat", messages, max_tokens: max, temperature: 0.3, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
			});
			if (!r.ok) { clearTimeout(t); throw new Error(`DeepSeek ${r.status} ${(await r.text()).slice(0, 80)}`); }
			if (stream) { clearTimeout(t); return r.body; } // 开始输出就不再计时
			try { return await r.json(); } finally { clearTimeout(t); }
		},
		bill: (i, o) => add(db, "ds:", i + o),
	}] : [];
	const list = (route === "hard" ? [...ds, ...cf] : [...cf, ...ds]).filter((p) => !only || p.name === only);
	if (!list.length) throw new MaxErr("Max 今天的额度用完了，明天再来" + (key ? "" : "（可以接 DeepSeek 备用）"));
	return list;
}

/** 两个引擎的状态（灵动岛顶部显示；DeepSeek 用一句极短的话试通，结果缓存 12 小时） */
export async function status(env: Env) {
	const db = env.DB, key = (env as any).DEEPSEEK_API_KEY as string | undefined;
	const [cf, ds] = await Promise.all([used(db), meter(db, "ds:")]);
	let dsOk: string | null = key ? await cacheGet(db, "dsping", 12) : "未设置密钥"; // 12 小时试一次密钥
	if (key && !dsOk) {
		try {
			const r = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", signal: AbortSignal.timeout(10000),
				headers: { "content-type": "application/json", authorization: "Bearer " + key },
				body: JSON.stringify({ model: (env as any).DEEPSEEK_MODEL || "deepseek-chat", messages: [{ role: "user", content: "回复ok" }], max_tokens: 3 }) });
			dsOk = r.ok ? "ok" : r.status === 401 ? "密钥不对" : r.status === 402 ? "余额不足" : `出错 ${r.status}`;
		} catch { dsOk = "连不上"; }
		await cachePut(db, "dsping", dsOk);
	}
	const sec = (await db.prepare("SELECT COALESCE(SUM(CAST(v AS INTEGER)), 0) n FROM meta WHERE k LIKE ?").bind(`sec:${day()}:%`).first<{ n: number }>())?.n ?? 0; // 今天拦下的可疑访问
	return { cf: Math.min(100, Math.round((cf / DAILY) * 100)), ds: { on: dsOk === "ok", msg: dsOk, used: ds, cap: DS_DAILY }, sec };
}
export const hasDs = async (env: Env) => !!(env as any).DEEPSEEK_API_KEY && (await meter(env.DB, "ds:")) < DS_DAILY;

/** 一次问答，返回完整文本 */
// 总管超时或额度用完：同一次里别再试总管的替补模型（多半也慢/也没额度），直接换 DeepSeek，免得两边都花
const cfDown = (e: unknown) => /超时|3036|daily free allocation/i.test(String(e));

export async function ask(env: Env, messages: Msg[], o: { max?: number; must?: boolean; route?: Route; only?: "cf" | "ds"; ok?: (t: string) => boolean; engine?: (n: string) => void } = {}): Promise<string> {
	let last: unknown, skipCf = false;
	for (const p of await providers(env, o.route ?? "work", o.must, o.only)) {
		if (skipCf && p.name === "cf") continue;
		try {
			const r: any = await p.call(messages, o.max ?? 500, false);
			const text = clean(String(r?.choices?.[0]?.message?.content ?? r?.response ?? ""));
			await p.bill(r?.usage?.prompt_tokens ?? est(messages), r?.usage?.completion_tokens ?? text.length);
			if (text && (!o.ok || o.ok(text))) { o.engine?.(p.name); return text; } // 答得不像样（如该给 JSON 没给）：换下一个模型
			last = new Error("回答格式不对");
		} catch (e) { last = e; if (p.name === "cf" && cfDown(e)) skipCf = true; }
	}
	throw new MaxErr("Max 暂时连不上，稍后再试" + (last ? `（${String(last).slice(0, 60)}）` : ""));
}

/** 流式问答：边生成边显示；结束后记用量、可选写缓存 */
export async function askStream(env: Env, messages: Msg[], o: { max?: number; route?: Route; done?: (t: string) => Promise<unknown>; engine?: (n: string) => void } = {}): Promise<ReadableStream<Uint8Array>> {
	let src: ReadableStream<Uint8Array> | null = null, used_: Prov | null = null, last: unknown, skipCf = false;
	for (const p of await providers(env, o.route ?? "work")) {
		if (skipCf && p.name === "cf") continue;
		try { src = await p.call(messages, o.max ?? 700, true); used_ = p; break; } catch (e) { last = e; if (p.name === "cf" && cfDown(e)) skipCf = true; }
	}
	if (!src || !used_) throw new MaxErr("Max 暂时连不上，稍后再试" + (last ? `（${String(last).slice(0, 60)}）` : ""));
	o.engine?.(used_.name);
	const p = used_, dec = new TextDecoder(), enc = new TextEncoder();
	let buf = "", all = "", usage: any = null, think = false;
	return src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, ctl) {
			buf += dec.decode(chunk, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop()!;
			for (const l of lines) {
				const d = l.startsWith("data:") ? l.slice(5).trim() : "";
				if (!d || d === "[DONE]") continue;
				try {
					const j = JSON.parse(d);
					if (j.usage) usage = j.usage;
					let t: string = j.choices?.[0]?.delta?.content ?? j.response ?? "";
					if (!t) continue;
					if (t.includes("<think>")) think = true; // 个别模型把思考写在 <think> 里：不显示
					if (think) { if (t.includes("</think>")) { think = false; t = t.split("</think>").pop()!; } else continue; }
					all += t;
					ctl.enqueue(enc.encode(t));
				} catch {}
			}
		},
		async flush() { // 记账/缓存失败不影响已经发出去的回答
			try { await p.bill(usage?.prompt_tokens ?? est(messages), usage?.completion_tokens ?? all.length); } catch {}
			try { if (all && o.done) await o.done(all.trim()); } catch {}
		},
	}));
}

// ---------- 缓存 ----------
export async function cacheGet(db: D1Database, k: string, hours: number) {
	return (await db.prepare(`SELECT v FROM max_cache WHERE k = ? AND at > datetime('now', ?)`).bind(k, `-${hours} hours`).first<{ v: string }>())?.v ?? null;
}
export const cachePut = (db: D1Database, k: string, v: string) =>
	db.prepare("INSERT OR REPLACE INTO max_cache (k, v, at) VALUES (?, ?, datetime('now'))").bind(k, v).run();

const isArr = (t: string) => Array.isArray(json(t)), isObj = (t: string) => { const j = json(t); return !!j && typeof j === "object" && !Array.isArray(j); }; // 格式校验：不对就换模型
const json = <T>(t: string): T | null => {
	const m = t.match(/[[{][\s\S]*[\]}]/);
	try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
};
const arr = (s?: string | null): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

// ---------- 批改：非作图、没照片、没手写的题交给 Max ----------
// 谁来批：普通文字题 → Max；作图题有画板文字描述（方程/交点/网表）→ Max 先批，拿不准交给 Claude；照片、手写、手绘笔迹 → Claude（要看图）
export function byMax(q: { subject: string; stem: string; tag?: string | null; board?: string | null; type: string; options?: string | null }, work: string, photoKeys: string[], hand: boolean): false | "max" | "draw" {
	if (hand || photoKeys.some((k) => !k.startsWith("views/"))) return false;
	const desc = /\[(作图|电路)\]/.test(work);
	if (DRAW.has(pick({ ...q, opts: !!q.options }).tag) || desc) return desc ? "draw" : false;
	return "max";
}
const DRAW_NOTE = "\n作答里的 [作图]/[电路] 是画板的文字描述（坐标单位=格，方程和交点已算好；电路是网表+通电结果），按它批。";
const SURE_DRAW = 0.75; // 作图题 Max 把握低于这个：不定分，交给 Claude

const GRADE_SYS = `给初三作答打分 0-100（≥80 算对），依据参考答案和要点，等价写法算对。
只输出 JSON：{"score":0,"comment":"≤30字","reason":"错因≤6字，对则空","sure":0-1 把握}`;

/** 批改一条作答（先抢占，避免重复批）。失败：填空退回网站判，简答留给 Claude */
export async function grade(env: Env, id: number, fallback: number | null) {
	const db = env.DB;
	if (!(await db.prepare("UPDATE attempts SET grader = 'maxing' WHERE id = ? AND grader = 'max' AND status = '待批改'").bind(id).run()).meta.changes) return;
	const a = await db.prepare(
		`SELECT a.question_id, a.answer_text, q.subject, q.type, q.tag, q.board, q.stem, q.options, q.answer, q.explanation
		 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id = ?`).bind(id).first<any>();
	try {
		if (!a) throw new Error("题目不在了");
		const draw = DRAW.has(pick({ ...a, opts: !!a.options }).tag) || /\[(作图|电路)\]/.test(String(a.answer_text ?? ""));
		const user = [`题（${a.subject}·${a.type === "fill" ? "填空" : "解答"}）：${a.stem}`, a.options ? "选项：" + arr(a.options).join(" ") : "",
			"参考答案：" + arr(a.answer).join(" / "), a.explanation ? "评分要点：" + a.explanation : "", "学生作答：" + (a.answer_text || "（空）")].filter(Boolean).join("\n");
		const msgs: Msg[] = [{ role: "system", content: GRADE_SYS + (draw ? DRAW_NOTE : "") }, { role: "user", content: user }];
		const valid = (t: string) => typeof json<any>(t)?.score === "number";
		let by = "";
		let r = json<{ score: number; comment?: string; reason?: string; sure?: number }>(await ask(env, msgs, { max: 220, must: true, ok: valid, engine: (n) => (by = n) }));
		// 难题：总管拿不准（sure<0.6）或分数在及格线附近 → 交给 DeepSeek 复核一次（已经是 DeepSeek 批的就不再问）
		if (r && draw && (r.sure ?? 0) < SURE_DRAW) { // 作图拿不准：只留初评，交给 Claude（学生在结果页一键转）
			await db.prepare("UPDATE attempts SET max_score = ?, max_comment = ?, max_sure = ?, grader = NULL WHERE id = ?")
				.bind(Math.max(0, Math.min(100, Math.round(r.score))), (r.comment || "").slice(0, 120), r.sure ?? 0, id).run();
			return;
		}
		if (r && !draw && by === "cf" && ((r.sure ?? 1) < 0.6 || Math.abs(r.score - PASS) < 10) && (await hasDs(env)))
			r = json<any>(await ask(env, msgs, { max: 220, must: true, route: "hard", only: "ds", ok: valid }).catch(() => "")) ?? r; // 只问 DeepSeek，不再让总管重复批
		if (!r || typeof r.score !== "number") throw new Error("Max 没给出分数");
		const score = Math.max(0, Math.min(100, Math.round(r.score))), ok = score >= PASS;
		await db.prepare("UPDATE attempts SET score = ?, comment = ?, error_reason = ?, is_correct = ?, status = '已判', grader = 'max' WHERE id = ?")
			.bind(score, (r.comment || "").slice(0, 120) || null, !ok && REASONS.includes(r.reason ?? "") ? r.reason : null, ok ? 1 : 0, id).run();
		await updateQueue(db, a.question_id, ok);
		if (!ok) await db.prepare("UPDATE questions SET max_reason = ?, max_note = ?, max_at = datetime('now') WHERE id = ?")
			.bind((r.reason || "").slice(0, 12) || null, (r.comment || "").slice(0, 60) || null, a.question_id).run(); // 错因随 Max 写，不套模板
	} catch {
		if (fallback != null) { // 填空：Max 不在就按网站的判法
			await db.prepare("UPDATE attempts SET is_correct = ?, score = ?, status = '已判', grader = NULL WHERE id = ?").bind(fallback, fallback * 100, id).run();
			if (a) await updateQueue(db, a.question_id, !!fallback);
		} else await db.prepare("UPDATE attempts SET grader = NULL WHERE id = ?").bind(id).run(); // 交给 Claude
	}
}
/** 批一批（交卷后在后台跑；结果页轮询时也会补批没批完的） */
export async function gradeAll(env: Env, ids: { id: number; fallback: number | null }[]) {
	for (let i = 0; i < ids.length; i += 3) await Promise.all(ids.slice(i, i + 3).map((x) => grade(env, x.id, x.fallback))); // 3 道一起批，交卷后结果出得快
}

// ---------- Claude 推题后：Max 扫一遍，补等价答案/考点/简短解析，发现答案可疑就提醒 ----------
const TAG_LIST = "选择|填空|计算|解答|证明|作图|函数|电路|光路|受力|简答";
const REFINE_SYS = `检查新录入的初三题，每题给：tag 题型（${TAG_LIST}，按作答方式选最准的）；cat 章节≤8字、topic 考点≤8字（已有同义的照抄已有）；alt 填空题的等价答案≤3个；exp 原题无解析才写≤40字；warn 答案有错/缺条件才写≤20字。
只输出 JSON 数组：[{"i":0,"tag":"","cat":"","topic":"","alt":[],"exp":"","warn":""}]`;

export async function refine(env: Env, ids: number[]): Promise<string> {
	if (!ids.length) return "";
	const db = env.DB;
	try {
		const { results: qs } = await db.prepare(`SELECT id, no, subject, type, tag, stem, options, answer, explanation, topic, category FROM questions WHERE id IN (${ids.map(() => "?")})`).bind(...ids).all<any>();
		const subjects = [...new Set(qs.map((q) => q.subject))];
		const { results: tops } = await db.prepare(`SELECT subject, COALESCE(category, '') || '›' || topic topic FROM questions WHERE topic IS NOT NULL AND id NOT IN (${ids.map(() => "?")}) AND subject IN (${subjects.map(() => "?")}) GROUP BY 1, 2 LIMIT 80`).bind(...ids, ...subjects).all<{ subject: string; topic: string }>();
		const list = qs.map((q, i) => `${i}. [${q.subject}·${q.tag || q.type}] ${q.stem.slice(0, 300)}${q.options ? "｜选项：" + arr(q.options).join(" ") : ""}｜答：${arr(q.answer).join(" / ")}｜章节›考点：${q.category || "?"}›${q.topic || "?"}｜解析：${q.explanation ? "有" : "无"}`).join("\n");
		const known = subjects.map((s) => `${s}：${tops.filter((t) => t.subject === s).map((t) => t.topic).join("、") || "无"}`).join("\n");
		const out = json<{ i: number; tag?: string; cat?: string; topic?: string; alt?: string[]; exp?: string; warn?: string }[]>(
			await Promise.race([
				ask(env, [{ role: "system", content: REFINE_SYS }, { role: "user", content: `已有 章节›考点：\n${known}\n\n题目：\n${list}` }], { max: 120 * qs.length + 100, ok: isArr }),
				new Promise<string>((_, rej) => setTimeout(() => rej(new MaxErr("超时")), 25000)),
			]));
		if (!Array.isArray(out)) return "";
		const stmts: D1PreparedStatement[] = [], warns: string[] = [];
		for (const r of out) {
			const q = qs[r.i];
			if (!q) continue;
			const ans = arr(q.answer);
			const alt = q.type === "fill" ? (r.alt ?? []).map(String).filter((x) => x && !ans.includes(x)).slice(0, 3) : [];
			const topic = r.topic && r.topic.length <= 12 ? r.topic : null;
			const exp = !q.explanation && r.exp ? r.exp.slice(0, 120) : null;
			const cat = r.cat && r.cat.length <= 12 ? r.cat : null;
			// 题型标签：Max 看题再定一次（有选项必须是选择，没选项不能是选择；填空/计算等随之改题型）
			const t = r.tag ? pick({ subject: q.subject, stem: q.stem, tag: r.tag, opts: !!q.options }).tag : null;
			const tag = t && t !== q.tag ? t : null;
			// 填空题标成「计算」仍保留填空（网站能直接判、配计算草稿板），不变成要批改的解答题
			const type = tag && !(q.type === "fill" && tag === "计算") ? (tag === "选择" ? (ans.length > 1 ? "multi" : "single") : tag === "填空" ? "fill" : "short") : null;
			if (alt.length || (topic && topic !== q.topic) || exp || (cat && cat !== q.category) || tag)
				stmts.push(db.prepare("UPDATE questions SET answer = ?, topic = COALESCE(?, topic), explanation = COALESCE(explanation, ?), category = COALESCE(?, category), tag = COALESCE(?, tag), type = COALESCE(?, type) WHERE id = ?")
					.bind(JSON.stringify([...ans, ...alt]), topic, exp, cat, tag, type, q.id));
			if (r.warn) warns.push(`${q.subject}${q.no ?? ""}：${r.warn}`);
		}
		if (stmts.length) await db.batch(stmts);
		return `；Max 检查 ${qs.length} 题，优化 ${stmts.length} 题` + (warns.length ? `；⚠ 请核对：${warns.join("；")}` : "");
	} catch (e) {
		return e instanceof MaxErr ? `；Max 没检查（${e.message}）` : "";
	}
}

// ---------- 首页：今天先做什么 + 薄弱点 + 考前冲刺（一次调用，按天缓存，做题有变化且过了 3 小时才重算） ----------
const BRIEF_SYS = `按数据给初三学生排今天的练习。只输出 JSON：
{"say":"≤50字先做什么+为什么","order":[候选题号≤10个按先后],"weak":"≤60字薄弱点和练法","sprint":"≤60字冲刺重点，无考试则空"}`;

export async function brief(env: Env, force = false) {
	const db = env.DB, d = today();
	const [stats, due, fresh, exams] = await Promise.all([
		db.prepare(`SELECT a.subject, COALESCE(q.topic, a.topic, q.category, '未分类') topic, COUNT(*) n, SUM(a.is_correct = 0) wrong
			FROM attempts a LEFT JOIN questions q ON q.id = a.question_id
			WHERE a.status = '已判' AND a.created_at > datetime('now', '-30 days') GROUP BY 1, 2 HAVING wrong > 0 ORDER BY wrong * 1.0 / n DESC, wrong DESC LIMIT 8`).all<{ subject: string; topic: string; n: number; wrong: number }>(),
		db.prepare(`SELECT q.id, q.subject, q.no, COALESCE(q.topic, q.category) topic, substr(q.stem, 1, 40) stem, r.stage FROM questions q JOIN review_queue r ON r.question_id = q.id
			WHERE r.next_date <= ? AND q.status = 'active' ORDER BY r.next_date LIMIT 20`).bind(d).all<any>(),
		db.prepare(`SELECT q.id, q.subject, q.no, COALESCE(q.topic, q.category) topic, substr(q.stem, 1, 40) stem FROM questions q
			WHERE q.status = 'active' AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY q.id DESC LIMIT 20`).all<any>(),
		db.prepare("SELECT v FROM meta WHERE k = 'exams'").first<{ v: string }>(),
	]);
	const weak = stats.results.slice(0, 5);
	const soon = arr(exams?.v).map((e: any) => ({ ...e, days: Math.round((Date.parse(e.date) - Date.parse(d)) / 864e5) })).filter((e: any) => e.days >= 0 && e.days <= 7);
	// 薄弱考点的题（错过的优先），给「练薄弱点」「冲刺」按钮
	const weakIds = weak.length
		? (await db.prepare(`SELECT q.id FROM questions q WHERE q.status = 'active' AND (${weak.map(() => "(q.subject = ? AND COALESCE(q.topic, q.category, '未分类') = ?)").join(" OR ")})
			ORDER BY EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0) DESC, q.id DESC LIMIT 15`).bind(...weak.flatMap((w) => [w.subject, w.topic])).all<{ id: number }>()).results.map((r) => r.id)
		: [];
	const cands = [...due.results.map((q) => ({ ...q, kind: "复习" })), ...fresh.results.map((q) => ({ ...q, kind: "新题" }))];
	const base = { topics: weak, weakIds, soon, cands: cands.length };
	const hit = await db.prepare("SELECT v, at > datetime('now', '-10 minutes') recent FROM max_cache WHERE k = ?").bind("br:" + d).first<{ v: string; recent: number }>();
	const old = hit ? json<any>(hit.v) : null;
	// 一天只让 Max 想一次（每天凌晨定时先想好）；刷新页面只读缓存，已经做掉的题从推荐里去掉（不花额度）。手动「重新看看」10 分钟内最多一次
	// 推荐顺序：Max 排的（去掉已做的）在前，白天新进来的题按复习顺序补到 10 道
	const fill = (order: number[]) => { const left = new Set(cands.map((q) => q.id)), o = order.filter((id) => left.has(id)); for (const q of cands) { if (o.length >= 10) break; if (!o.includes(q.id)) o.push(q.id); } return o; };
	if (old && (!force || hit!.recent)) return { ...base, ...old.r, order: fill(old.r.order), cached: true };
	if (!force && (await cacheGet(db, "brfail", 0.5))) return { ...base, say: "Max 暂时不在，先按复习顺序做", order: fill([]), weakTip: "", sprint: "" }; // 刚失败过：半小时内不重试，免得每次刷新都花额度
	if (!cands.length && !weak.length) return { ...base, say: "题库还空着，拍照上传错题或让 Claude 出题吧", order: [], weakTip: "", sprint: "" };
	try {
		const user = [`今天 ${d}`, soon.length ? `临近考试：${soon.map((e: any) => `${e.name}（${e.days}天后）`).join("、")}` : "近 7 天没有考试",
			`近30天错得多的考点：${weak.map((w) => `${w.subject}/${w.topic} 错${w.wrong}/${w.n}`).join("；") || "无"}`,
			`候选题（题号｜类型｜科目考点｜题干开头）：\n${cands.map((q) => `${q.id}｜${q.kind}${q.stage != null ? "第" + (q.stage + 1) + "轮" : ""}｜${q.subject}/${q.topic || "?"}｜${q.stem}`).join("\n")}`].join("\n");
		const r = json<any>(await ask(env, [{ role: "system", content: BRIEF_SYS }, { role: "user", content: user }], { max: 400, ok: isObj })) ?? {};
		const ok = new Set(cands.map((q) => q.id));
		const out = { say: String(r.say || "").slice(0, 120), order: (Array.isArray(r.order) ? r.order : []).map(Number).filter((x: number) => ok.has(x)).slice(0, 10), weakTip: String(r.weak || "").slice(0, 160), sprint: soon.length ? String(r.sprint || "").slice(0, 160) : "" };
		out.order = fill(out.order);
		await cachePut(db, "br:" + d, JSON.stringify({ r: out }));
		return { ...base, ...out };
	} catch (e) {
		await cachePut(db, "brfail", "1");
		const say = e instanceof MaxErr ? e.message : "Max 暂时不在，先按复习顺序做";
		return { ...base, say, weakTip: "", sprint: "", ...(old?.r ?? {}), order: fill(old?.r?.order ?? []) };
	}
}

// ---------- 聊天 ----------
const CHAT_SYS = `你是 Max，错题练习站的学习助手；学生初三，也学法语。中文、简洁（≤150字），公式 $..$，化学式 $\\ce{..}$。
只依据给的数据（含学生当前页面），不编造。作图/电路/光路/受力/证明题批改归 Claude。
需要网站动作时末尾单独一行：[[练:科目/考点]] [[练:今日]] [[去:/wrong]] [[去:/bank]] [[去:/]] [[整理错题]]`;

type Ctx = { q?: number; a?: number; explain?: number; marked?: boolean; page?: { path?: string; title?: string; text?: string } };

async function context(db: D1Database, ctx: Ctx): Promise<{ text: string; key?: string; hard?: boolean }> {
	if (ctx.marked) {
		const { results } = await db.prepare(
			`SELECT q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation, a.id aid, a.answer_text, a.is_correct, a.status, a.error_reason, a.comment, a.time_spent_sec
			 FROM marks m JOIN questions q ON q.id = m.question_id LEFT JOIN attempts a ON a.id = m.attempt_id
			 WHERE m.attempt_id IS NOT NULL AND m.created_at > datetime('now','-1 day') ORDER BY m.created_at LIMIT 12`).all<any>();
		if (!results.length) return { text: "（没有标记的题，或已过 24 小时）" };
		return { text: "学生标记的题：\n" + results.map((r) => (r.status === "待批改" ? "【待批改】" : r.is_correct ? "【对】" : "【错】") + wrongLine(r)).join("\n"), key: "mk:" + results.map((r) => r.aid + ":" + (r.is_correct ?? "")).join(","), hard: results.length >= 5 };
	}
	const aid = ctx.explain ?? ctx.a;
	if (aid) {
		const r = await db.prepare(
			`SELECT a.id aid, a.answer_text, a.is_correct, a.status, a.error_reason, a.comment, a.score, a.time_spent_sec, q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation
			 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id = ?`).bind(aid).first<any>();
		if (r) return { text: `当前这题（学生已交）：${r.status === "待批改" ? "【待批改】" : r.is_correct ? "【对】" : "【错】"}${wrongLine(r)}`, key: `ex:${r.aid}:${r.is_correct ?? ""}:${r.score ?? ""}`, hard: /数学|物理|化学/.test(r.subject) && (r.type === "short" || String(r.stem).length > 80) };
	}
	if (ctx.q) {
		const q = await db.prepare("SELECT subject, no, stem, options, topic FROM questions WHERE id = ?").bind(ctx.q).first<any>();
		if (q) return { text: `学生正在做这题（还没交，只给提示和思路，不要直接说答案）：${q.subject}${q.no ?? ""}（${q.topic || ""}）：${q.stem}${q.options ? "｜选项：" + arr(q.options).join(" ") : ""}` };
	}
	return { text: "" };
}

/** 题库概况（按科目/考点计数、近 30 天错题），让 Max 能「看到」题库 */
let bankMemo: { at: number; v: string } | null = null; // 同一个 Worker 实例里 3 分钟内复用，聊天开得更快
async function bankIndex(db: D1Database) {
	if (bankMemo && Date.now() - bankMemo.at < 180000) return bankMemo.v;
	const v = await bankIndexRaw(db);
	bankMemo = { at: Date.now(), v };
	return v;
}
async function bankIndexRaw(db: D1Database) {
	const { results } = await db.prepare(
		`SELECT q.subject s, COALESCE(q.topic, q.category, '未分类') t, COUNT(*) n,
		        SUM(EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0)) w,
		        SUM(q.id IN (SELECT question_id FROM review_queue WHERE next_date <= date('now', '+8 hours'))) d
		 FROM questions q WHERE q.status = 'active' GROUP BY 1, 2 ORDER BY 1, w DESC LIMIT 60`).all<{ s: string; t: string; n: number; w: number; d: number }>();
	return results.length ? "题库（科目/考点：题数，错过，今天到期）：\n" + results.map((r) => `${r.s}/${r.t}：${r.n}题${r.w ? "，错" + r.w : ""}${r.d ? "，到期" + r.d : ""}`).join("\n") : "题库还是空的";
}

// 难题信号：学生说没懂/要详细/问为什么，聊得很长，或要讲数理化的解答题 → 直接让 DeepSeek 答
const HARD = /难|不懂|没懂|看不懂|不明白|详细|为什么|证明|推导|再讲|换个讲法|一步步|怎么来的/;
export async function chat(env: Env, messages: Msg[], ctx: Ctx = {}, allow?: () => Promise<boolean>): Promise<{ cached?: string; stream?: ReadableStream<Uint8Array>; engine?: string }> {
	const db = env.DB;
	const [c, bank] = await Promise.all([context(db, ctx), ctx.q || ctx.a || ctx.explain || ctx.marked ? Promise.resolve("") : bankIndex(db)]); // 并行查
	const oneShot = (ctx.explain || ctx.marked) && messages.length <= 1; // 一键讲解/解析：同一题同一结果只花一次额度
	if (oneShot && c.key) {
		const hit = await cacheGet(db, c.key, 24 * 14);
		if (hit) return { cached: hit };
	}
	const hist = messages.slice(-6).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 800) }) as Msg);
	const page = !oneShot && ctx.page?.text ? `学生当前页面（${String(ctx.page.title || ctx.page.path || "").slice(0, 30)}）的内容：\n${String(ctx.page.text).slice(0, 1500)}` : "";
	const sys = [CHAT_SYS, c.text || bank || (await bankIndex(db)), page].filter(Boolean).join("\n\n"); // 讲具体题时不带题库概况，省额度
	const prompt = ctx.marked && oneShot ? "逐题简要解析（每题≤80字：错因+关键思路），最后一句总结共性问题。" : ctx.explain && oneShot ? "讲讲这道题：错了就先指出错在哪，再给关键思路和步骤。" : null;
	if (prompt) hist[hist.length - 1] = { role: "user", content: prompt };
	const hard = HARD.test(messages[messages.length - 1]?.content ?? "") || messages.length >= 5 || c.hard;
	if (allow && !(await allow())) throw new MaxErr("今天和 Max 聊得够多了，明天再来"); // 只有真要问模型才算一次（缓存命中不算）
	let engine = "";
	const stream = await askStream(env, [{ role: "system", content: sys }, ...hist], { max: ctx.marked ? 900 : hard ? 800 : 600, route: hard ? "hard" : "work",
		done: oneShot && c.key ? (t) => cachePut(db, c.key!, t) : undefined, engine: (n) => (engine = n) });
	return { stream, engine };
}

// ---------- 错题本：Max 整理（错因 + 一句话诊断 + 统一考点） ----------
// 错因不用固定模板：Max 看题、正确答案、错答、用时自己分析
const ORG_SYS = `看题、正确答案、错答、用时，分析每道错题为什么错（不套模板，说具体原因）。
只输出 JSON 数组：[{"i":0,"reason":"错因≤6字","note":"≤25字错在哪+怎么避免","topic":"考点≤8字，优先用已有"}]`;
const WRONG_ROWS = `SELECT q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation, q.max_reason, q.max_note, q.max_at,
	a.id aid, a.answer_text, a.error_reason, a.comment, a.time_spent_sec, a.is_correct, a.status
	FROM questions q LEFT JOIN attempts a ON a.id = (SELECT MAX(id) FROM attempts WHERE question_id = q.id AND is_correct = 0)`;

/** 整理还没整理过（或整理后又错了）的错题，一次最多 n 道（一次调用） */
export async function organize(env: Env, n = 10): Promise<number> {
	const db = env.DB;
	const { results: rs } = await db.prepare(`${WRONG_ROWS}
		WHERE q.status IN ('active', 'mastered') AND (q.source = '原错题' OR a.id IS NOT NULL) AND (q.max_at IS NULL OR q.max_at < a.created_at)
		ORDER BY q.id DESC LIMIT ?`).bind(n).all<any>();
	if (!rs.length) return 0;
	const subjects = [...new Set(rs.map((r) => r.subject))];
	const { results: tops } = await db.prepare(`SELECT subject, topic FROM questions WHERE topic IS NOT NULL AND subject IN (${subjects.map(() => "?")}) GROUP BY 1, 2 LIMIT 80`).bind(...subjects).all<{ subject: string; topic: string }>();
	const list = rs.map((r, i) => `${i}. [${r.subject}] ${r.stem.slice(0, 200)}${r.options ? "｜选项：" + arr(r.options).join(" ") : ""}｜正确：${arr(r.answer).join(" / ")}｜错答：${String(r.answer_text ?? "（照片录入的原错题）").slice(0, 150)}${r.time_spent_sec ? `｜用时${r.time_spent_sec}秒` : ""}`).join("\n");
	const known = subjects.map((s) => `${s}：${tops.filter((t) => t.subject === s).map((t) => t.topic).join("、") || "无"}`).join("\n");
	const out = json<{ i: number; reason?: string; note?: string; topic?: string }[]>(await ask(env, [{ role: "system", content: ORG_SYS }, { role: "user", content: `已有考点：\n${known}\n\n错题：\n${list}` }], { max: 60 * rs.length + 80, ok: isArr }));
	if (!Array.isArray(out)) return 0;
	const stmts = out.filter((r) => rs[r.i]).map((r) => db.prepare("UPDATE questions SET max_reason = ?, max_note = ?, topic = COALESCE(?, topic), max_at = datetime('now') WHERE id = ?")
		.bind((r.reason || "").slice(0, 12) || null, (r.note || "").slice(0, 60) || null, r.topic && r.topic.length <= 12 ? r.topic : null, rs[r.i].id));
	if (stmts.length) await db.batch(stmts);
	return stmts.length;
}
/** 还没整理的错题数 */
export const unorganized = async (db: D1Database) => (await db.prepare(`SELECT COUNT(*) n FROM questions q LEFT JOIN attempts a ON a.id = (SELECT MAX(id) FROM attempts WHERE question_id = q.id AND is_correct = 0)
	WHERE q.status IN ('active', 'mastered') AND (q.source = '原错题' OR a.id IS NOT NULL) AND (q.max_at IS NULL OR q.max_at < a.created_at)`).first<{ n: number }>())?.n ?? 0;


/** 错题本错因统计：脚本归类 vs Max 归类 + Max 一段总结（按统计变化缓存） */
export async function wrongSummary(env: Env, force = false) {
	const db = env.DB;
	const { results: rs } = await db.prepare(`SELECT q.subject, q.topic, q.max_reason, q.max_note, q.max_at FROM questions q
		WHERE q.status = 'active' AND (q.source = '原错题' OR EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.is_correct = 0))`).all<any>(); // 只取统计要的几列
	const max: Record<string, number> = {};
	for (const r of rs) { const k = r.max_reason || (r.max_at ? null : "待分析"); if (k) max[k] = (max[k] || 0) + 1; }
	// 总结存一份，刷新只读它；只有第一次、每天定时、或手动「重新分析」才让 Max 重写
	const saved = json<{ text: string; sig: string }>((await db.prepare("SELECT v FROM meta WHERE k = 'wsum'").first<{ v: string }>())?.v ?? "");
	const sig = JSON.stringify(Object.keys(max).sort().map((k) => [k, max[k]])); // 排好序，顺序不同不算变
	let summary = saved?.text ?? null;
	if ((!saved || (force && saved.sig !== sig)) && rs.length >= 3 && (force || !(await cacheGet(db, "wsfail", 0.5)))) {
		try {
			const notes = rs.filter((r) => r.max_note).slice(0, 15).map((r) => `${r.subject}/${r.topic || "?"}：${r.max_note}`).join("\n");
			summary = await ask(env, [{ role: "system", content: "据错因统计和诊断，≤80字说初三学生最主要的问题和下一步怎么练。" },
				{ role: "user", content: `错因统计：${JSON.stringify(max)}\n诊断：\n${notes || "无"}` }], { max: 200 });
			await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('wsum', ?)").bind(JSON.stringify({ text: summary, sig })).run();
		} catch { summary = saved?.text ?? null; await cachePut(db, "wsfail", "1"); } // 失败半小时内不自动重试
	}
	return { total: rs.length, max, summary, stale: !!saved && saved.sig !== sig && rs.length >= 3, todo: await unorganized(db) };
}

// ---------- 错题文件夹：Max 总结，攒满 20 道发给 Claude 的就是这份总结（Claude 少读很多字） ----------
const FOLDER_SYS = `这些是初三学生错过、后来重做做对的题。≤200字写给老师（Claude）：主要问题（按科目/考点）、反复出现的错因、该出巩固题的考点。只写结论。`;
export async function folderSummary(env: Env, force = false): Promise<{ ids: number[]; text: string } | null> {
	const db = env.DB;
	const { results: rs } = await db.prepare(`${WRONG_ROWS} WHERE q.status = 'mastered' ORDER BY q.subject, q.topic LIMIT 40`).all<any>();
	if (!rs.length) return null;
	const ids = rs.map((r) => r.id);
	const old = json<{ ids: number[]; text: string }>((await db.prepare("SELECT v FROM meta WHERE k = 'folder_sum'").first<{ v: string }>())?.v ?? "");
	if (old && !force && ids.filter((i) => !old.ids.includes(i)).length < 5) return old; // 新进来不到 5 道：用上次的
	const list = rs.map((r) => `${r.subject}/${r.topic || "?"}｜错因：${r.max_reason || "?"}${r.max_note ? "｜" + r.max_note : ""}`).join("\n");
	const text = await ask(env, [{ role: "system", content: FOLDER_SYS }, { role: "user", content: list }], { max: 450 });
	const v = { ids, text: text.slice(0, 600) };
	const still = (await db.prepare(`SELECT COUNT(*) n FROM questions WHERE status = 'mastered' AND id IN (${ids.join(",")})`).first<{ n: number }>())?.n;
	if (still) await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('folder_sum', ?)").bind(JSON.stringify(v)).run(); // 写之前题已经发给 Claude 清掉了就不写
	return v;
}

/** 每天定时：用掉总管当天剩下的额度做整理（UTC 19 点后，额度 0 点重置） */
export async function maxDaily(env: Env) { // 北京时间凌晨 3 点：Max 把当天要用的都先想好，白天刷新页面不再花额度
	try { for (let i = 0; i < 4 && (await organize(env, 10)); i++); } catch {}
	try { await folderSummary(env); } catch {}
	try { await wrongSummary(env, true); } catch {}
	try { await brief(env, true); } catch {}
	try { await classify(env); } catch {} // 有新考点才整理
}

// ---------- 给 Claude 减负：交给 Claude 的题（作图/电路等有文字描述的），Max 先写初评 ----------
// 只看文字（画板描述里有算好的方程/交点、电路网表），不看图，省额度；Claude 同意就一键确认，拿不准再看图
export async function pregrade(env: Env, ids: number[]) {
	for (const id of ids) {
		const a = await env.DB.prepare(`SELECT a.answer_text, q.subject, q.stem, q.answer, q.explanation FROM attempts a JOIN questions q ON q.id = a.question_id
			WHERE a.id = ? AND a.status = '待批改' AND a.grader IS NULL`).bind(id).first<any>();
		if (!a || !String(a.answer_text ?? "").trim()) continue; // 没有文字（纯照片/手写）：只能 Claude 看图
		try {
			const r = json<{ score: number; comment?: string; sure?: number }>(await ask(env, [{ role: "system", content: GRADE_SYS + "\n作答里的 [作图]/[电路] 是画板的文字描述（坐标单位=格，方程和交点已算好）。" },
				{ role: "user", content: `题（${a.subject}）：${a.stem}\n参考：${arr(a.answer).join(" / ")}${a.explanation ? "\n要点：" + a.explanation : ""}\n作答：${a.answer_text}` }], { max: 220, ok: (t) => typeof json<any>(t)?.score === "number" }));
			if (r) await env.DB.prepare("UPDATE attempts SET max_score = ?, max_comment = ?, max_sure = ? WHERE id = ?")
				.bind(Math.max(0, Math.min(100, Math.round(r.score))), (r.comment || "").slice(0, 120), Math.max(0, Math.min(1, r.sure ?? 0.5)), id).run();
		} catch (e) { if (e instanceof MaxErr && /额度/.test(e.message)) return; } // 额度没了就停；单题出错跳过
	}
}

// ---------- 分类整理：每科一次调用，合并同义考点、给考点归到章节（数据没变就不调用） ----------
const CLASSIFY_SYS = `整理初三某科的考点：同义的合并成一个规范名（≤8字），每个考点归到教材章节（≤8字）。不要改变知识点含义。
只输出 JSON 数组：[{"from":"原考点","topic":"规范考点","cat":"章节"}]`;
const topicRows = (db: D1Database, subject: string) =>
	db.prepare("SELECT topic, COALESCE(category, '') cat, COUNT(*) c FROM questions WHERE subject = ? AND topic IS NOT NULL GROUP BY 1, 2 ORDER BY c DESC LIMIT 80").bind(subject).all<{ topic: string; cat: string; c: number }>();
export async function classify(env: Env, force = false): Promise<number> {
	const db = env.DB;
	const { results: subs } = await db.prepare("SELECT DISTINCT subject FROM questions WHERE topic IS NOT NULL").all<{ subject: string }>();
	let n = 0;
	for (const { subject } of subs) {
		const { results: rows } = await topicRows(db, subject);
		const sig = JSON.stringify(rows.map((r) => [r.topic, r.cat]));
		if (!force && (await db.prepare("SELECT v FROM meta WHERE k = ?").bind("cls:" + subject).first<{ v: string }>())?.v === sig) continue; // 没新考点：不花额度
		const out = json<{ from: string; topic?: string; cat?: string }[]>(await ask(env, [{ role: "system", content: CLASSIFY_SYS },
			{ role: "user", content: `${subject}（考点｜现章节｜题数）：\n${rows.map((r) => `${r.topic}｜${r.cat || "?"}｜${r.c}`).join("\n")}` }], { max: 40 * rows.length + 80, ok: isArr }));
		if (!Array.isArray(out)) continue;
		const known = new Set(rows.map((r) => r.topic));
		const stmts = out.filter((x) => known.has(x.from) && (x.topic || x.cat)).map((x) =>
			db.prepare("UPDATE questions SET topic = COALESCE(?, topic), category = COALESCE(?, category) WHERE subject = ? AND topic = ?")
				.bind(x.topic && x.topic.length <= 12 ? x.topic : null, x.cat && x.cat.length <= 12 ? x.cat : null, subject, x.from));
		for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
		n += stmts.length;
		const { results: after } = await topicRows(db, subject);
		await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind("cls:" + subject, JSON.stringify(after.map((r) => [r.topic, r.cat]))).run();
	}
	return n;
}
