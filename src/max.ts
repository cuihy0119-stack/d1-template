// Max 助手 = 两个模型：
//   总管：Cloudflare Workers AI（免费额度每天 1 万神经元，UTC 0 点重置）→ 批改、整理错题、总结等后台活
//   备用：DeepSeek API（要在 Cloudflare 里设密钥 DEEPSEEK_API_KEY）→ 聊天；总管额度用完时也顶上后台活
// 省用量：关掉深度思考、限制输出长度、只发必要字段、能缓存的都缓存；作图/照片/手写题不碰，照旧交给 Claude。
import { today, updateQueue } from "./review";
import { pick } from "./tags";
import { cause, wrongLine } from "./cause";

const CF = ["@cf/qwen/qwen3.8-27b", "@cf/zai-org/glm-4.7-flash"]; // 总管 + 总管忙时的替补
const DAILY = 9800, SOFT = 8500; // Cloudflare 估算神经元：超过 SOFT 只留批改，超过 DAILY 不再用
const DS_DAILY = 400_000; // DeepSeek 每天最多用的 token（防止意外花钱）
const PASS = 80;
const REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"];
const DRAW = new Set(["作图", "函数", "电路", "光路", "受力", "证明"]); // 作图题：Max 不批，交给 Claude

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Route = "work" | "chat"; // work=后台活（总管优先），chat=聊天（备用优先）
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

async function providers(env: Env, route: Route, must = false): Promise<Prov[]> {
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
	const list = route === "chat" ? [...ds, ...cf] : [...cf, ...ds];
	if (!list.length) throw new MaxErr("Max 今天的额度用完了，明天再来" + (key ? "" : "（可以接 DeepSeek 备用）"));
	return list;
}

/** 一次问答，返回完整文本 */
export async function ask(env: Env, messages: Msg[], o: { max?: number; must?: boolean; route?: Route } = {}): Promise<string> {
	let last: unknown;
	for (const p of await providers(env, o.route ?? "work", o.must)) {
		try {
			const r: any = await p.call(messages, o.max ?? 500, false);
			const text = clean(String(r?.choices?.[0]?.message?.content ?? r?.response ?? ""));
			await p.bill(r?.usage?.prompt_tokens ?? est(messages), r?.usage?.completion_tokens ?? text.length);
			if (text) return text;
		} catch (e) { last = e; }
	}
	throw new MaxErr("Max 暂时连不上，稍后再试" + (last ? `（${String(last).slice(0, 60)}）` : ""));
}

/** 流式问答：边生成边显示；结束后记用量、可选写缓存 */
export async function askStream(env: Env, messages: Msg[], o: { max?: number; route?: Route; done?: (t: string) => Promise<unknown> } = {}): Promise<ReadableStream<Uint8Array>> {
	let src: ReadableStream<Uint8Array> | null = null, used_: Prov | null = null, last: unknown;
	for (const p of await providers(env, o.route ?? "chat")) {
		try { src = await p.call(messages, o.max ?? 700, true); used_ = p; break; } catch (e) { last = e; }
	}
	if (!src || !used_) throw new MaxErr("Max 暂时连不上，稍后再试" + (last ? `（${String(last).slice(0, 60)}）` : ""));
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

const json = <T>(t: string): T | null => {
	const m = t.match(/[[{][\s\S]*[\]}]/);
	try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
};
const arr = (s?: string | null): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

// ---------- 批改：非作图、没照片、没手写的题交给 Max ----------
export function byMax(q: { subject: string; stem: string; tag?: string | null; board?: string | null; type: string; options?: string | null }, work: string, photoKeys: string[], hand: boolean) {
	if (hand || photoKeys.some((k) => !k.startsWith("views/"))) return false; // 照片、手写、发给 Claude 的草纸图：要看图
	if (/\[(作图|电路)\]/.test(work)) return false;
	return !DRAW.has(pick({ ...q, opts: !!q.options }).tag);
}

const GRADE_SYS = `你是 Max，初三错题练习站的批改助手。按参考答案和评分要点给学生作答打分（0-100，≥80 算对）。
等价写法算对：0.5 与 1/2、x=2 与 2、顺序不同的多个根、单位写法不同但数值正确、意思相同的文字表述。
只输出 JSON：{"score":数字,"comment":"≤40字，指出关键对错","reason":"概念不清|表述不规范|审题失误|计算错误|不会做|空（对的留空）"}`;

/** 批改一条作答（先抢占，避免重复批）。失败：填空退回网站判，简答留给 Claude */
export async function grade(env: Env, id: number, fallback: number | null) {
	const db = env.DB;
	if (!(await db.prepare("UPDATE attempts SET grader = 'maxing' WHERE id = ? AND grader = 'max' AND status = '待批改'").bind(id).run()).meta.changes) return;
	const a = await db.prepare(
		`SELECT a.question_id, a.answer_text, q.subject, q.type, q.stem, q.options, q.answer, q.explanation
		 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id = ?`).bind(id).first<any>();
	try {
		if (!a) throw new Error("题目不在了");
		const user = [`题（${a.subject}·${a.type === "fill" ? "填空" : "解答"}）：${a.stem}`, a.options ? "选项：" + arr(a.options).join(" ") : "",
			"参考答案：" + arr(a.answer).join(" / "), a.explanation ? "评分要点：" + a.explanation : "", "学生作答：" + (a.answer_text || "（空）")].filter(Boolean).join("\n");
		const r = json<{ score: number; comment?: string; reason?: string }>(await ask(env, [{ role: "system", content: GRADE_SYS }, { role: "user", content: user }], { max: 200, must: true }));
		if (!r || typeof r.score !== "number") throw new Error("Max 没给出分数");
		const score = Math.max(0, Math.min(100, Math.round(r.score))), ok = score >= PASS;
		await db.prepare("UPDATE attempts SET score = ?, comment = ?, error_reason = ?, is_correct = ?, status = '已判', grader = 'max' WHERE id = ?")
			.bind(score, (r.comment || "").slice(0, 120) || null, !ok && REASONS.includes(r.reason ?? "") ? r.reason : null, ok ? 1 : 0, id).run();
		await updateQueue(db, a.question_id, ok);
		if (!ok) await db.prepare("UPDATE questions SET max_reason = ?, max_note = ?, max_at = datetime('now') WHERE id = ?")
			.bind(REASONS.includes(r.reason ?? "") ? r.reason : null, (r.comment || "").slice(0, 60) || null, a.question_id).run();
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
const REFINE_SYS = `你是 Max，帮老师检查刚录入的初三练习题。对每题输出：
- topic：考点（≤10字）。若「已有考点」里有同义的，必须原样用已有的；原考点已经合适就照抄。
- alt：仅填空题，参考答案的其它等价写法（如 1/2→0.5、x=2→2），最多 3 个，没有就 []。
- exp：只有原题没有解析时才写（≤50字关键思路），否则空字符串。
- warn：参考答案明显有错或题目缺条件时写一句（≤30字），否则空字符串。
只输出 JSON 数组：[{"i":序号,"topic":"","alt":[],"exp":"","warn":""}]`;

export async function refine(env: Env, ids: number[]): Promise<string> {
	if (!ids.length) return "";
	const db = env.DB;
	try {
		const { results: qs } = await db.prepare(`SELECT id, no, subject, type, tag, stem, options, answer, explanation, topic FROM questions WHERE id IN (${ids.map(() => "?")})`).bind(...ids).all<any>();
		const subjects = [...new Set(qs.map((q) => q.subject))];
		const { results: tops } = await db.prepare(`SELECT subject, topic FROM questions WHERE topic IS NOT NULL AND subject IN (${subjects.map(() => "?")}) GROUP BY subject, topic LIMIT 80`).bind(...subjects).all<{ subject: string; topic: string }>();
		const list = qs.map((q, i) => `${i}. [${q.subject}·${q.tag || q.type}] ${q.stem.slice(0, 300)}${q.options ? "｜选项：" + arr(q.options).join(" ") : ""}｜答：${arr(q.answer).join(" / ")}｜考点：${q.topic || "无"}｜解析：${q.explanation ? "有" : "无"}`).join("\n");
		const known = subjects.map((s) => `${s}：${tops.filter((t) => t.subject === s).map((t) => t.topic).join("、") || "无"}`).join("\n");
		const out = json<{ i: number; topic?: string; alt?: string[]; exp?: string; warn?: string }[]>(
			await Promise.race([
				ask(env, [{ role: "system", content: REFINE_SYS }, { role: "user", content: `已有考点：\n${known}\n\n题目：\n${list}` }], { max: 120 * qs.length + 100 }),
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
			if (alt.length || (topic && topic !== q.topic) || exp)
				stmts.push(db.prepare("UPDATE questions SET answer = ?, topic = COALESCE(?, topic), explanation = COALESCE(explanation, ?) WHERE id = ?").bind(JSON.stringify([...ans, ...alt]), topic, exp, q.id));
			if (r.warn) warns.push(`${q.subject}${q.no ?? ""}：${r.warn}`);
		}
		if (stmts.length) await db.batch(stmts);
		return `；Max 检查 ${qs.length} 题，优化 ${stmts.length} 题` + (warns.length ? `；⚠ 请核对：${warns.join("；")}` : "");
	} catch (e) {
		return e instanceof MaxErr ? `；Max 没检查（${e.message}）` : "";
	}
}

// ---------- 首页：今天先做什么 + 薄弱点 + 考前冲刺（一次调用，按天缓存，做题有变化且过了 3 小时才重算） ----------
const BRIEF_SYS = `你是 Max，初三学生的学习助手。根据数据给出今天的安排。只输出 JSON：
{"say":"≤60字，今天先做什么、为什么","order":[从候选题里挑最该先做的题号，最多10个，按先后],"weak":"≤80字，薄弱点总结和改进建议","sprint":"≤80字考前冲刺重点（没有7天内的考试就空字符串）"}`;

export async function brief(env: Env, force = false) {
	const db = env.DB, d = today();
	const [stats, due, fresh, exams, n] = await Promise.all([
		db.prepare(`SELECT a.subject, COALESCE(q.topic, a.topic, q.category, '未分类') topic, COUNT(*) n, SUM(a.is_correct = 0) wrong
			FROM attempts a LEFT JOIN questions q ON q.id = a.question_id
			WHERE a.status = '已判' AND a.created_at > datetime('now', '-30 days') GROUP BY 1, 2 HAVING wrong > 0 ORDER BY wrong * 1.0 / n DESC, wrong DESC LIMIT 8`).all<{ subject: string; topic: string; n: number; wrong: number }>(),
		db.prepare(`SELECT q.id, q.subject, q.no, COALESCE(q.topic, q.category) topic, substr(q.stem, 1, 40) stem, r.stage FROM questions q JOIN review_queue r ON r.question_id = q.id
			WHERE r.next_date <= ? AND q.status = 'active' ORDER BY r.next_date LIMIT 20`).bind(d).all<any>(),
		db.prepare(`SELECT q.id, q.subject, q.no, COALESCE(q.topic, q.category) topic, substr(q.stem, 1, 40) stem FROM questions q
			WHERE q.status = 'active' AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY q.id DESC LIMIT 20`).all<any>(),
		db.prepare("SELECT v FROM meta WHERE k = 'exams'").first<{ v: string }>(),
		db.prepare("SELECT (SELECT COUNT(*) FROM attempts) a, (SELECT COUNT(*) FROM questions WHERE status = 'active') q").first<{ a: number; q: number }>(),
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
	const sig = `${n?.a}:${n?.q}`;
	const hit = await db.prepare("SELECT v, at > datetime('now', '-3 hours') fresh FROM max_cache WHERE k = ?").bind("br:" + d).first<{ v: string; fresh: number }>();
	const old = hit ? json<any>(hit.v) : null;
	if (old && !force && (old.sig === sig || hit!.fresh)) return { ...base, ...old.r, cached: true };
	if (!cands.length && !weak.length) return { ...base, say: "题库还空着，拍照上传错题或让 Claude 出题吧", order: [], weakTip: "", sprint: "" };
	try {
		const user = [`今天 ${d}`, soon.length ? `临近考试：${soon.map((e: any) => `${e.name}（${e.days}天后）`).join("、")}` : "近 7 天没有考试",
			`近30天错得多的考点：${weak.map((w) => `${w.subject}/${w.topic} 错${w.wrong}/${w.n}`).join("；") || "无"}`,
			`候选题（题号｜类型｜科目考点｜题干开头）：\n${cands.map((q) => `${q.id}｜${q.kind}${q.stage != null ? "第" + (q.stage + 1) + "轮" : ""}｜${q.subject}/${q.topic || "?"}｜${q.stem}`).join("\n")}`].join("\n");
		const r = json<any>(await ask(env, [{ role: "system", content: BRIEF_SYS }, { role: "user", content: user }], { max: 400 })) ?? {};
		const ok = new Set(cands.map((q) => q.id));
		const out = { say: String(r.say || "").slice(0, 120), order: (Array.isArray(r.order) ? r.order : []).map(Number).filter((x: number) => ok.has(x)).slice(0, 10), weakTip: String(r.weak || "").slice(0, 160), sprint: soon.length ? String(r.sprint || "").slice(0, 160) : "" };
		if (!out.order.length) out.order = cands.slice(0, 10).map((q) => q.id);
		await cachePut(db, "br:" + d, JSON.stringify({ sig, r: out }));
		return { ...base, ...out };
	} catch (e) {
		const say = e instanceof MaxErr ? e.message : "Max 暂时不在，先按复习顺序做";
		return { ...base, say, order: cands.slice(0, 10).map((q) => q.id), weakTip: "", sprint: "", ...(old?.r ? { ...old.r, say: old.r.say } : {}) };
	}
}

// ---------- 聊天 ----------
const CHAT_SYS = `你是 Max，「错题练习站」里的常驻学习助手，服务一个初三学生（也在学法语）。
用中文回答，简洁直接（一般不超过 200 字），公式写 $..$，化学式写 $\\ce{..}$，可用 **加粗** 和分行列表。
只根据下面给的数据谈题库和成绩，不确定就说不确定，不编造。作图、电路、光路、受力、证明题的批改交给 Claude。
你能看到学生当前打开的页面内容，可以直接总结、分析它。
需要网站动作时，在回答最后单独一行写（网站会变成按钮）：[[练:科目/考点]] [[练:今日]] 开始练习；[[去:/wrong]] 错题本、[[去:/bank]] 题库、[[去:/]] 首页；[[整理错题]] 让你整理错题本。`;

type Ctx = { q?: number; a?: number; explain?: number; marked?: boolean; page?: { path?: string; title?: string; text?: string } };

async function context(db: D1Database, ctx: Ctx): Promise<{ text: string; key?: string }> {
	if (ctx.marked) {
		const { results } = await db.prepare(
			`SELECT q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation, a.id aid, a.answer_text, a.is_correct, a.status, a.error_reason, a.comment, a.time_spent_sec
			 FROM marks m JOIN questions q ON q.id = m.question_id LEFT JOIN attempts a ON a.id = m.attempt_id
			 WHERE m.attempt_id IS NOT NULL AND m.created_at > datetime('now','-1 day') ORDER BY m.created_at LIMIT 12`).all<any>();
		if (!results.length) return { text: "（没有标记的题，或已过 24 小时）" };
		return { text: "学生标记的题：\n" + results.map((r) => (r.status === "待批改" ? "【待批改】" : r.is_correct ? "【对】" : "【错】") + wrongLine(r)).join("\n"), key: "mk:" + results.map((r) => r.aid + ":" + (r.is_correct ?? "")).join(",") };
	}
	const aid = ctx.explain ?? ctx.a;
	if (aid) {
		const r = await db.prepare(
			`SELECT a.id aid, a.answer_text, a.is_correct, a.status, a.error_reason, a.comment, a.score, a.time_spent_sec, q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation
			 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id = ?`).bind(aid).first<any>();
		if (r) return { text: `当前这题（学生已交）：${r.status === "待批改" ? "【待批改】" : r.is_correct ? "【对】" : "【错】"}${wrongLine(r)}`, key: `ex:${r.aid}:${r.is_correct ?? ""}:${r.score ?? ""}` };
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

export async function chat(env: Env, messages: Msg[], ctx: Ctx = {}): Promise<{ cached?: string; stream?: ReadableStream<Uint8Array> }> {
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
	return { stream: await askStream(env, [{ role: "system", content: sys }, ...hist], { max: ctx.marked ? 900 : 600, done: oneShot && c.key ? (t) => cachePut(db, c.key!, t) : undefined }) };
}

// ---------- 错题本：Max 整理（错因 + 一句话诊断 + 统一考点） ----------
// 脚本先按作答推断错因（cause.ts），Max 再看题和错答给出自己的判断；两种都给学生看
const ORG_SYS = `你是 Max，管理一个初三学生的错题本。对每道错题给出：
- reason：错因，只能选一个：概念不清|表述不规范|审题失误|计算错误|不会做（参考「脚本初判」，但以题目和错答为准）
- note：≤30字，具体错在哪 + 下次注意什么
- topic：考点（≤10字），「已有考点」里有同义的就原样用
只输出 JSON 数组：[{"i":序号,"reason":"","note":"","topic":""}]`;
const WRONG_ROWS = `SELECT q.id, q.no, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation, q.max_reason, q.max_note,
	a.id aid, a.answer_text, a.error_reason, a.comment, a.time_spent_sec, a.is_correct, a.status
	FROM questions q LEFT JOIN attempts a ON a.id = (SELECT MAX(id) FROM attempts WHERE question_id = q.id AND is_correct = 0)`;

/** 整理还没整理过（或整理后又错了）的错题，一次最多 n 道（一次调用） */
export async function organize(env: Env, n = 10): Promise<number> {
	const db = env.DB;
	const { results: rs } = await db.prepare(`${WRONG_ROWS}
		WHERE q.status IN ('active', 'mastered') AND (q.source = '原错题' OR a.id IS NOT NULL) AND (q.max_at IS NULL OR q.max_at < a.created_at)
		ORDER BY q.id DESC LIMIT ?`).bind(n).all<any>();
	if (!rs.length) return 0;
	await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('org_at', datetime('now'))").run();
	const subjects = [...new Set(rs.map((r) => r.subject))];
	const { results: tops } = await db.prepare(`SELECT subject, topic FROM questions WHERE topic IS NOT NULL AND subject IN (${subjects.map(() => "?")}) GROUP BY 1, 2 LIMIT 80`).bind(...subjects).all<{ subject: string; topic: string }>();
	const list = rs.map((r, i) => `${i}. [${r.subject}] ${r.stem.slice(0, 200)}${r.options ? "｜选项：" + arr(r.options).join(" ") : ""}｜正确：${arr(r.answer).join(" / ")}｜错答：${String(r.answer_text ?? "（照片录入的原错题）").slice(0, 150)}｜脚本初判：${cause(r)}${r.time_spent_sec ? `｜用时${r.time_spent_sec}秒` : ""}`).join("\n");
	const known = subjects.map((s) => `${s}：${tops.filter((t) => t.subject === s).map((t) => t.topic).join("、") || "无"}`).join("\n");
	const out = json<{ i: number; reason?: string; note?: string; topic?: string }[]>(await ask(env, [{ role: "system", content: ORG_SYS }, { role: "user", content: `已有考点：\n${known}\n\n错题：\n${list}` }], { max: 60 * rs.length + 80 }));
	if (!Array.isArray(out)) return 0;
	const stmts = out.filter((r) => rs[r.i]).map((r) => db.prepare("UPDATE questions SET max_reason = ?, max_note = ?, topic = COALESCE(?, topic), max_at = datetime('now') WHERE id = ?")
		.bind(REASONS.includes(r.reason ?? "") ? r.reason : null, (r.note || "").slice(0, 60) || null, r.topic && r.topic.length <= 12 ? r.topic : null, rs[r.i].id));
	if (stmts.length) await db.batch(stmts);
	return stmts.length;
}
/** 还没整理的错题数 */
export const unorganized = async (db: D1Database) => (await db.prepare(`SELECT COUNT(*) n FROM questions q LEFT JOIN attempts a ON a.id = (SELECT MAX(id) FROM attempts WHERE question_id = q.id AND is_correct = 0)
	WHERE q.status IN ('active', 'mastered') AND (q.source = '原错题' OR a.id IS NOT NULL) AND (q.max_at IS NULL OR q.max_at < a.created_at)`).first<{ n: number }>())?.n ?? 0;

/** 脚本错因归类（cause() 的结果收成几大类） */
export const bucket = (c: string) => REASONS.find((r) => c.includes(r)) ?? (/漏选|多选/.test(c) ? "选项漏选/多选" : c.startsWith("待批改") ? "待批改" : "其它");

/** 错题本错因统计：脚本归类 vs Max 归类 + Max 一段总结（按统计变化缓存） */
export async function wrongSummary(env: Env) {
	const db = env.DB;
	const { results: rs } = await db.prepare(`${WRONG_ROWS} WHERE q.status = 'active' AND (q.source = '原错题' OR a.id IS NOT NULL)`).all<any>();
	const count = (f: (r: any) => string | null) => rs.reduce((m: Record<string, number>, r) => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
	const script = count((r) => bucket(cause(r))), max = count((r) => r.max_reason);
	const sig = "ws:" + JSON.stringify([script, max]);
	let summary = await cacheGet(db, sig, 24 * 7);
	if (!summary && rs.length >= 3) {
		try {
			const notes = rs.filter((r) => r.max_note).slice(0, 15).map((r) => `${r.subject}/${r.topic || "?"}：${r.max_note}`).join("\n");
			summary = await ask(env, [{ role: "system", content: "你是 Max，初三学生的学习助手。根据错因统计和诊断，用≤100字总结最主要的问题和下一步怎么练，直接说结论。" },
				{ role: "user", content: `脚本统计：${JSON.stringify(script)}\nMax 统计：${JSON.stringify(max)}\n诊断：\n${notes || "无"}` }], { max: 200 });
			await cachePut(db, sig, summary);
		} catch { summary = null; }
	}
	return { total: rs.length, script, max, summary, todo: await unorganized(db) };
}

// ---------- 错题文件夹：Max 总结，攒满 20 道发给 Claude 的就是这份总结（Claude 少读很多字） ----------
const FOLDER_SYS = `你是 Max。下面是一个初三学生错过、后来重做做对的题。用≤250字总结给老师（Claude）看：
①按科目/考点归类的主要问题 ②反复出现的错因 ③建议（哪些考点要出巩固题、归档时的重点）。直接写结论，不要客套。`;
export async function folderSummary(env: Env, force = false): Promise<{ ids: number[]; text: string } | null> {
	const db = env.DB;
	const { results: rs } = await db.prepare(`${WRONG_ROWS} WHERE q.status = 'mastered' ORDER BY q.subject, q.topic LIMIT 40`).all<any>();
	if (!rs.length) return null;
	const ids = rs.map((r) => r.id);
	const old = json<{ ids: number[]; text: string }>((await db.prepare("SELECT v FROM meta WHERE k = 'folder_sum'").first<{ v: string }>())?.v ?? "");
	if (old && !force && ids.filter((i) => !old.ids.includes(i)).length < 5) return old; // 新进来不到 5 道：用上次的
	const list = rs.map((r) => `${r.subject}/${r.topic || "?"}｜错因：${r.max_reason || bucket(cause(r))}${r.max_note ? "｜" + r.max_note : ""}`).join("\n");
	const text = await ask(env, [{ role: "system", content: FOLDER_SYS }, { role: "user", content: list }], { max: 450 });
	const v = { ids, text: text.slice(0, 600) };
	await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('folder_sum', ?)").bind(JSON.stringify(v)).run();
	return v;
}
/** 发给 Claude 的一行（短）：题号、考点、题干开头、错因、诊断 */
export const shortLine = (r: any) =>
	`${r.subject}${r.no ?? ""}（${r.topic || "?"}）：${String(r.stem).slice(0, 60)}${r.stem.length > 60 ? "…" : ""}｜正确：${arr(r.answer).join(" / ").slice(0, 40)}｜错因：${r.max_reason || bucket(cause(r))}${r.max_note ? "｜" + r.max_note : ""}${r.aid ? "｜作答id=" + r.aid : ""}`;

/** 每天定时：用掉总管当天剩下的额度做整理（UTC 19 点后，额度 0 点重置） */
export async function maxDaily(env: Env) {
	try { for (let i = 0; i < 4 && (await organize(env, 10)); i++); } catch {}
	try { await folderSummary(env); } catch {}
}
