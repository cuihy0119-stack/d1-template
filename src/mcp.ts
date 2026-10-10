import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { addDays, today, updateQueue } from "./review";
import { pick } from "./tags";
import { TEMPLATES } from "./templates";
import { wrongLine } from "./cause";

// 省用量：工具说明尽量短；返回用紧凑文本（TSV）而不是 JSON；作图答案 = 文字描述 + 几何信息 + 600px 小图。
const PASS = 80; // 简答得分（百分制）≥80 算做对
const REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"] as const;
const MAX_IMAGES = 6;

const INSTRUCTIONS = `错题练习站（初三自用）。省用量：一次 save 写完，回复简短。
批改：get_inbox → save({grades})（只有作图/写过程的题，选择填空网站已判）。学生说「解析标记的题」：get_data({kind:"marked"})。知道学生临近的考试（名称+日期）就 save({exams:[{name,date}]}) 更新首页倒计时。出题：先 get_data({kind:"tpl"}) 取模板（每对话一次）照填；复习旧题 save({review:[id]})。
作答标记：[计算]步骤/算式 [作图]画板描述(单位=格,含算好的方程/交点) [电路]网表+通电结果；附图=手绘或草纸(已裁剪)，文字和图一起看。`;

// 题目（短字段名省输出）
const Q = z.object({
	subject: z.string().optional(),
	category: z.string().optional(),
	topic: z.string().optional(),
	stem: z.string(),
	opts: z.array(z.string()).optional(),
	ans: z.array(z.string()).describe("见模板"),
	exp: z.string().optional().describe("解析"),
	tag: z.string().optional().describe("必填，见模板"),
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
	const row: Record<string, unknown> = {
		subject, category: q.category ?? def.category ?? null, topic: q.topic ?? def.topic ?? null, type, stem: q.stem,
		options: q.opts?.length ? JSON.stringify(q.opts) : null, answer: JSON.stringify(q.ans), explanation: q.exp ?? null, source,
		origin_id: q.origin ?? null, board: board === "coord" || board === "grid" ? board : null, tag, // 画板读题时由 tag 推出
	};
	const ins = () => db.prepare(`INSERT INTO questions (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => "?")})`).bind(...Object.values(row)).run();
	const r = await ins().catch((e) => { // 迁移 0006 还没跑：先不存 tag，读题时按题干判断
		if (!/no such column: tag/.test(String(e))) throw e;
		delete row.tag;
		return ins();
	});
	return `${r.meta.last_row_id}${tag}`;
}

// ---------- 错题本定期推送 ----------
// 网站不能主动叫 Claude，所以搭在正常交互（收件箱、保存）的返回里：距上次推送满 7 天、或新增错题满 20 道，
// 就附上这段时间新增的错题清单，请 Claude 问学生要不要整理归档进 Notion。每次推送后重新计时。
const DIGEST_DAYS = 7, DIGEST_MAX = 20;
async function wrongDigest(db: D1Database): Promise<string> {
	const last = (await db.prepare("SELECT v FROM meta WHERE k = 'digest_at'").first<{ v: string }>())?.v ?? "1970-01-01 00:00:00";
	// 每道题取最近一次做错的作答：错答、错因、评语都带上
	const { results } = await db
		.prepare(
			`SELECT q.id, q.subject, COALESCE(q.topic, q.category) topic, q.type, q.stem, q.options, q.answer, q.explanation,
			        a.answer_text, a.error_reason, a.comment, a.time_spent_sec
			 FROM questions q JOIN attempts a ON a.id = (SELECT MAX(id) FROM attempts WHERE question_id = q.id AND is_correct = 0)
			 WHERE a.created_at > ? AND q.status = 'active' ORDER BY q.subject, topic LIMIT 40`,
		)
		.bind(last)
		.all<any>();
	const due = Date.now() - Date.parse(last.replace(" ", "T") + "Z") >= DIGEST_DAYS * 864e5;
	if (!results.length || (!due && results.length < DIGEST_MAX)) return "";
	await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('digest_at', datetime('now'))").run();
	return `\n\n【错题本定期整理】上次之后新增错题 ${results.length} 道（题干、选项、错答、正确答案、错因、解析都已整理好）：\n${results.map(wrongLine).join("\n")}\n→ 先回答完学生，再问一句：要不要把这些错题整理归档进 Notion？同意后用 Notion 连接器按 科目/章节/考点 归档，每题照抄上面的 题干、选项、错答、正确答案、错因、解析，不用回网站写入。`;
}

export function buildServer(env: Env) {
	const db = env.DB;
	const s = new McpServer({ name: "错题练习站", version: "1.8.0" }, { instructions: INSTRUCTIONS });

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
			// 作答照片 + 手绘/草纸小图（已裁剪压缩）；views/ 是只给学生自己看的整板图，文字描述已经够
			const keys = String(a.photo_key ?? "").split(",").filter((k) => k && !k.startsWith("views/"));
			if (keys.length > budget) { out.push({ type: "text", text: `另有待批改作答，下次再取` }); break; }
			budget -= keys.length;
			out.push(
				{ type: "text", text: `#${a.id} ${a.subject}｜题：${a.stem}${a.options ? "｜选项：" + a.options : ""}｜参考：${a.answer}｜答：${ans || "（空）"}${keys.length ? `｜附图${keys.length}张` : ""}` },
				...(await images(db, keys)),
			);
		}
		if (!out.length) out.push({ type: "text", text: "收件箱是空的" });
		const dg = await wrongDigest(db);
		if (dg) out.push({ type: "text", text: dg });
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
				review: z.array(z.number().int()).optional().describe("旧题 id：放回今日练习复习"),
				exams: z.array(z.object({ name: z.string(), date: z.string().describe("YYYY-MM-DD") })).optional().describe("临近考试（整表替换），首页显示倒计时"),
				summary: z.string().optional(),
			},
		},
		async ({ def = {}, questions = [], wrong = [], done_uploads = [], grades = [], organize = [], review = [], exams, summary }) => {
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
				const ids: string[] = [];
				for (const q of list) {
					try { ids.push(await insertQuestion(db, q, def, source)); } catch (e) { err.push(`「${q.stem.slice(0, 10)}」${(e as Error).message}`); }
				}
				return ids;
			};
			if (wrong.length) {
				const ids = await add(wrong, "原错题");
				const next = addDays(today(), 1);
				for (const id of ids) await db.prepare("INSERT OR REPLACE INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0)").bind(parseInt(id), next).run();
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
						.bind(it.subject ?? null, it.category ?? null, it.topic ?? null, t?.tag ?? null, t?.board === "coord" || t?.board === "grid" ? t.board : null, it.id)
						.run();
					n += r.meta.changes;
				}
				out.push(`分类 ${n}`);
			}
			if (review.length) { // 复习：旧题今天到期，状态改回复习中
				for (const id of review) {
					await db.prepare("UPDATE questions SET status = 'active', status_at = NULL WHERE id = ?").bind(id).run();
					await db.prepare("INSERT OR REPLACE INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0)").bind(id, today()).run();
				}
				out.push(`复习 ${review.join(",")}`);
			}
			if (exams) {
				await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('exams', ?)").bind(JSON.stringify(exams.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)))).run();
				out.push(`考试 ${exams.length} 场`);
			}
			if (summary) {
				await db.prepare("INSERT INTO summaries (text) VALUES (?)").bind(summary).run();
				out.push("总结 ok");
			}
			return text(([...out, ...(err.length ? ["错误：" + err.join("；")] : [])].join("；") || "无操作") + (await wrongDigest(db)));
		},
	);

	s.registerTool(
		"get_data",
		{
			description: "kind=tpl 出题模板（出题前取）；kind=marked 学生标记的题（含作答、对错、答案、考点，用来解析）；kind=records 作答记录 TSV（days 默认 7）；kind=bank 题库清单 TSV（默认只列复习中的题，all=true 列全部）。",
			inputSchema: { kind: z.enum(["tpl", "marked", "records", "bank"]), days: z.number().int().min(1).max(365).optional(), subject: z.string().optional(), all: z.boolean().optional() },
		},
		async ({ kind, days, subject, all }) => {
			if (kind === "tpl") return text(TEMPLATES);
			if (kind === "marked") { // 临时文件夹：交卷后的标记题，24 小时内有效；一题一行，错题带错答和错因
				const { results } = await db.prepare(
					`SELECT q.id, q.subject, q.topic, q.type, q.stem, q.options, q.answer, q.explanation, a.answer_text, a.is_correct, a.status, a.error_reason, a.comment, a.time_spent_sec
					 FROM marks m JOIN questions q ON q.id = m.question_id LEFT JOIN attempts a ON a.id = m.attempt_id
					 WHERE m.attempt_id IS NOT NULL AND m.created_at > datetime('now','-1 day') ORDER BY m.created_at`).all<any>();
				return text(results.length ? results.map((r) => (r.status === "待批改" ? "【待批改】" : r.is_correct ? "【对】" : "【错】") + wrongLine(r)).join("\n") : "没有标记的题（或已过 24 小时）");
			}
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
