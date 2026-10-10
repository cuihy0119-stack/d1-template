import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { addDays, today, updateQueue } from "./review";
import { pick } from "./tags";

// 省用量：工具说明尽量短；返回用紧凑文本（TSV）而不是 JSON；作图答案 = 文字描述 + 几何信息 + 600px 小图。
const PASS = 80; // 简答得分（百分制）≥80 算做对
const REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"] as const;
const MAX_IMAGES = 6;

const INSTRUCTIONS = `错题练习站（初三学生自用）。省用量：尽量一次 save 做完所有写入，回复简短。
流程：get_inbox → save({grades, wrong, questions, summary})。
出题：save({def:{subject,category}, questions:[{stem, tag, opts?, ans, exp?}]})；公式 $..$，化学式 $\\ce{..}$；tag=题型：选择(给opts)/填空/计算/解答/证明/作图/函数/电路/光路/受力/简答，网站据此自动配题型和画板。
作答里：「[计算]」=逐步公式(LaTeX)；「[作图]」=作图板描述（坐标单位=格，含代码算好的方程、交轴点、交点、点在哪条线上）；「[电路]」=电路网表（各元件两端接的节点、串并联/短路/断头提示）。以文字为准，配小图核对整体。`;

// 题目（短字段名省输出）
const Q = z.object({
	subject: z.string().optional(),
	category: z.string().optional(),
	topic: z.string().optional(),
	stem: z.string(),
	opts: z.array(z.string()).optional().describe('["A. ..","B. .."]'),
	ans: z.array(z.string()).describe("选择=字母；填空=所有可接受答案；简答=[参考答案]"),
	exp: z.string().optional().describe("解析"),
	tag: z.string().optional().describe("选择/填空/计算/解答/证明/作图/函数/电路/光路/受力/简答"),
}).loose(); // 旧缓存工具可能还传 type/board，留着给 pick() 参考
type QIn = z.infer<typeof Q> & { origin?: number; type?: string; board?: string };

type Img = { type: "image"; data: string; mimeType: string };
type Content = { type: "text"; text: string } | Img;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
// 紧凑表格：首行表头，制表符分隔
const tsv = (rows: Record<string, unknown>[]) =>
	rows.length
		? [Object.keys(rows[0]).join("\t"), ...rows.map((r) => Object.values(r).map((v) => String(v ?? "").replace(/\s+/g, " ")).join("\t"))].join("\n")
		: "（无）";

async function images(db: D1Database, keys: string[]): Promise<Img[]> {
	const out: Img[] = [];
	for (const key of keys) {
		const r = await db.prepare("SELECT content_type, data FROM photos WHERE key = ?").bind(key).first<{ content_type: string; data: string }>();
		if (r) out.push({ type: "image", data: r.data, mimeType: r.content_type });
	}
	return out;
}

async function insertQuestion(db: D1Database, q: QIn, def: Partial<QIn>, source: "原错题" | "同类题") {
	const subject = q.subject ?? def.subject;
	if (q.subject && q.subject !== def.subject) def = {}; // 换了科目就不沿用本批的章节/考点
	if (!subject) throw new Error("缺 subject");
	const { tag, board } = pick({ subject, stem: q.stem, tag: q.tag, board: q.board, type: q.type === "fill" || q.type === "short" ? q.type : null, opts: !!q.opts?.length });
	const type = tag === "选择" ? (q.ans.length > 1 ? "multi" : "single") : tag === "填空" ? "fill" : "short";
	const r = await db
		.prepare(
			"INSERT INTO questions (subject, category, topic, type, stem, options, answer, explanation, source, origin_id, board, tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		)
		.bind(subject, q.category ?? def.category ?? null, q.topic ?? def.topic ?? null, type, q.stem, q.opts?.length ? JSON.stringify(q.opts) : null,
			JSON.stringify(q.ans), q.exp ?? null, source, q.origin ?? null, board === "phys" ? "grid" : board, tag) // phys 不在表的 CHECK 里，读题时按 tag 还原
		.run();
	return r.meta.last_row_id;
}

export function buildServer(env: Env) {
	const db = env.DB;
	const s = new McpServer({ name: "错题练习站", version: "1.3.0" }, { instructions: INSTRUCTIONS });

	s.registerTool("get_inbox", { description: "待处理：新照片（upload_id）+ 待批改作答（#id）。", inputSchema: {} }, async () => {
		const out: Content[] = [];
		let budget = MAX_IMAGES;
		const ups = (await db.prepare("SELECT id, r2_key FROM uploads WHERE status = '待处理' ORDER BY id").all<{ id: number; r2_key: string }>()).results;
		for (const u of ups) {
			if (budget <= 0) { out.push({ type: "text", text: `另有 ${ups.length - ups.indexOf(u)} 张照片，下次再取` }); break; }
			out.push({ type: "text", text: `照片 upload_id=${u.id}` }, ...(await images(db, [u.r2_key])));
			budget--;
		}
		const atts = (
			await db
				.prepare(
					`SELECT a.id, a.answer_text, a.photo_key, q.subject, q.stem, q.options, q.answer
					 FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.status = '待批改' ORDER BY a.id`,
				)
				.all<any>()
		).results;
		for (const a of atts) {
			const ans = String(a.answer_text ?? "");
			const keys = String(a.photo_key ?? "").split(",").filter(Boolean); // 作图板小图（约 500 token）+ 拍的照片
			if (keys.length > budget) { out.push({ type: "text", text: `另有待批改作答，下次再取` }); break; }
			budget -= keys.length;
			out.push(
				{ type: "text", text: `#${a.id} ${a.subject}｜题：${a.stem}${a.options ? "｜选项：" + a.options : ""}｜参考：${a.answer}｜答：${ans || "（空）"}${keys.length ? `｜附图${keys.length}张` : ""}` },
				...(await images(db, keys)),
			);
		}
		if (!out.length) out.push({ type: "text", text: "收件箱是空的" });
		return { content: out };
	});

	s.registerTool(
		"save",
		{
			description: "一次写入（各项都可省）：grades 批改（score 百分制，≥80 算对）；wrong 照片里的原错题（明天起复习）；questions 推送新题到今日练习；organize 改分类/标签；summary 首页总结。",
			inputSchema: {
				def: z.object({ subject: z.string().optional(), category: z.string().optional(), topic: z.string().optional() }).optional().describe("本批题共用的科目/章节/考点"),
				questions: z.array(Q.extend({ origin: z.number().int().optional().describe("对应原错题 id") })).optional(),
				wrong: z.array(Q.extend({ upload: z.number().int().optional().describe("来自哪张照片") })).optional(),
				done_uploads: z.array(z.number().int()).optional().describe("看过但没有错题的照片"),
				grades: z
					.array(z.object({ id: z.number().int().describe("attempt_id"), score: z.number().min(0).max(100), comment: z.string(), reason: z.enum(REASONS).optional() }))
					.optional(),
				organize: z.array(z.object({ id: z.number().int(), subject: z.string().optional(), category: z.string().optional(), topic: z.string().optional(), tag: z.string().optional() })).optional(),
				summary: z.string().optional(),
			},
		},
		async ({ def = {}, questions = [], wrong = [], done_uploads = [], grades = [], organize = [], summary }) => {
			const out: string[] = [];
			const err: string[] = [];
			if (grades.length) {
				const r: string[] = [];
				for (const g of grades) {
					const a = await db.prepare("SELECT question_id FROM attempts WHERE id = ?").bind(g.id).first<{ question_id: number }>();
					if (!a) { err.push(`#${g.id} 不存在`); continue; }
					const ok = g.score >= PASS;
					await db
						.prepare("UPDATE attempts SET score = ?, comment = ?, error_reason = ?, is_correct = ?, status = '已判' WHERE id = ?")
						.bind(g.score, g.comment, g.reason ?? null, ok ? 1 : 0, g.id)
						.run();
					await updateQueue(db, a.question_id, ok);
					r.push(`#${g.id}${ok ? "✓" : "✗"}`);
				}
				out.push("批改 " + r.join(" "));
			}
			const add = async (list: QIn[], source: "原错题" | "同类题") => {
				const ids: number[] = [];
				for (const q of list) {
					try { ids.push(await insertQuestion(db, q, def, source)); } catch (e) { err.push(`「${q.stem.slice(0, 10)}」${(e as Error).message}`); }
				}
				return ids;
			};
			if (wrong.length) {
				const ids = await add(wrong, "原错题");
				const next = addDays(today(), 1);
				for (const id of ids) await db.prepare("INSERT OR REPLACE INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0)").bind(id, next).run();
				out.push(`错题 ${ids.join(",")}`);
			}
			const done = new Set([...done_uploads, ...wrong.map((w) => w.upload).filter((u): u is number => !!u)]);
			for (const u of done) await db.prepare("UPDATE uploads SET status = '已处理' WHERE id = ?").bind(u).run();
			if (done.size) out.push(`照片已处理 ${done.size}`);
			if (questions.length) out.push(`新题 ${(await add(questions, "同类题")).join(",")}`);
			if (organize.length) {
				let n = 0;
				for (const it of organize) {
					const q = it.tag ? await db.prepare("SELECT subject, stem, type, options FROM questions WHERE id = ?").bind(it.id).first<any>() : null;
					const t = q ? pick({ ...q, tag: it.tag, opts: !!q.options }) : null;
					const r = await db
						.prepare("UPDATE questions SET subject = COALESCE(?1, subject), category = COALESCE(?2, category), topic = COALESCE(?3, topic), tag = COALESCE(?4, tag), board = CASE WHEN ?4 IS NULL THEN board ELSE ?5 END WHERE id = ?6")
						.bind(it.subject ?? null, it.category ?? null, it.topic ?? null, t?.tag ?? null, t?.board === "phys" ? "grid" : t?.board ?? null, it.id)
						.run();
					n += r.meta.changes;
				}
				out.push(`分类 ${n}`);
			}
			if (summary) {
				await db.prepare("INSERT INTO summaries (text) VALUES (?)").bind(summary).run();
				out.push("总结 ok");
			}
			return text([...out, ...(err.length ? ["错误：" + err.join("；")] : [])].join("；") || "无操作");
		},
	);

	s.registerTool(
		"get_data",
		{
			description: "查询（TSV）：kind=records 作答记录（days 默认 7）；kind=bank 题库清单（默认只列复习中的题，all=true 列全部）。",
			inputSchema: { kind: z.enum(["records", "bank"]), days: z.number().int().min(1).max(365).optional(), subject: z.string().optional(), all: z.boolean().optional() },
		},
		async ({ kind, days, subject, all }) => {
			const sql =
				kind === "records"
					? `SELECT substr(a.created_at, 6, 5) d, a.subject s, a.topic t, COALESCE(q.tag, q.type) ty,
					        CASE a.status WHEN '待批改' THEN '?' ELSE a.is_correct END ok, a.score sc, a.error_reason why, a.time_spent_sec sec
					   FROM attempts a LEFT JOIN questions q ON q.id = a.question_id
					   WHERE a.created_at >= datetime('now', ?1) AND (?2 IS NULL OR a.subject = ?2) AND ?3 IS NOT NULL ORDER BY a.id LIMIT 1000`
					: `SELECT q.id, q.subject s, q.category c, q.topic t, q.tag g, substr(q.stem, 1, 30) stem,
					        CASE WHEN r.question_id IS NOT NULL THEN '复习' WHEN EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) THEN '已做' ELSE '未做' END st
					   FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
					   WHERE ?1 IS NOT NULL AND (?2 IS NULL OR q.subject = ?2) AND (?3 OR q.status = 'active') ORDER BY q.id LIMIT 2000`;
			const { results } = await db.prepare(sql).bind(`-${days ?? 7} days`, subject ?? null, all ? 1 : 0).all();
			return text(tsv(results as Record<string, unknown>[]));
		},
	);

	return s;
}

// ---------- 旧工具名兼容 ----------
// claude.ai 会缓存工具列表；工具合并后，旧名字的调用在这里转成 save / get_data，不用重连也能用，且不增加工具列表长度。
const oldQ = (q: any) => ({ ...q, opts: q.opts ?? q.options, ans: q.ans ?? q.answer, exp: q.exp ?? q.explanation, origin: q.origin ?? q.origin_id, upload: q.upload ?? q.upload_id });
const LEGACY: Record<string, (a: any) => [string, any]> = {
	add_questions: (a) => ["save", { questions: (a.questions ?? []).map(oldQ) }],
	add_wrong_questions: (a) => ["save", { wrong: (a.items ?? []).map(oldQ), done_uploads: a.done_upload_ids }],
	grade: (a) => ["save", { grades: (a.items ?? [a]).map((g: any) => ({ id: g.id ?? g.attempt_id, score: g.score, comment: g.comment, reason: g.reason ?? g.error_reason })) }],
	organize_questions: (a) => ["save", { organize: (a.items ?? []).map((i: any) => ({ ...i, id: i.id ?? i.question_id })) }],
	post_summary: (a) => ["save", { summary: a.text }],
	get_records: (a) => ["get_data", { kind: "records", days: a.days, subject: a.subject }],
	get_question_bank: (a) => ["get_data", { kind: "bank", subject: a.subject, all: true }],
};
async function upgradeLegacy(request: Request): Promise<Request> {
	if (request.method !== "POST") return request;
	const body = await request.clone().json().catch(() => null);
	if (!body) return request;
	let changed = false;
	const fix = (m: any) => {
		const f = m?.method === "tools/call" && LEGACY[m.params?.name];
		if (!f) return m;
		changed = true;
		const [name, args] = f(m.params.arguments ?? {});
		return { ...m, params: { ...m.params, name, arguments: args } };
	};
	const out = Array.isArray(body) ? body.map(fix) : fix(body);
	return changed ? new Request(request, { body: JSON.stringify(out) }) : request;
}

// 无状态：每个请求新建 server + transport
export const mcpHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const server = buildServer(env);
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		await server.connect(transport);
		return transport.handleRequest(await upgradeLegacy(request));
	},
};
