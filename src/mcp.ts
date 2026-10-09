import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { addDays, today, updateQueue } from "./review";

// 省用量：工具说明尽量短；返回用紧凑文本（TSV）而不是 JSON；作图答案默认是文字描述，只有手绘笔迹才附图。
const PASS = 80; // 简答得分（百分制）≥80 算做对
const REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"] as const;
const MAX_IMAGES = 6;

const INSTRUCTIONS = `错题练习站（初三学生自用）。省用量：一次批量调用，回复简短。
批改：get_inbox → grade(一次传全部) → 需要时 post_summary。
出题：add_questions，作图题设 board（coord 坐标系 / grid 方格），公式用 $..$，化学式 $\\ce{..}$。
作答里的「[作图]」是作图板的文字描述（坐标单位=格），据此批改；含「手绘」时才附图。`;

const Q = {
	subject: z.string(),
	category: z.string().optional().describe("章节"),
	topic: z.string().describe("考点"),
	type: z.enum(["single", "multi", "fill", "short"]),
	stem: z.string(),
	options: z.array(z.string()).optional().describe('["A. ..","B. .."]'),
	answer: z.array(z.string()).describe("选择=字母；填空=所有可接受答案；简答=[参考答案]"),
	explanation: z.string().optional(),
	board: z.enum(["coord", "grid"]).optional().describe("作图题才填"),
};

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

async function insertQuestion(db: D1Database, q: any, source: "原错题" | "同类题") {
	const r = await db
		.prepare(
			"INSERT INTO questions (subject, category, topic, type, stem, options, answer, explanation, source, origin_id, board) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		)
		.bind(q.subject, q.category ?? null, q.topic, q.type, q.stem, q.options?.length ? JSON.stringify(q.options) : null,
			JSON.stringify(q.answer), q.explanation ?? null, source, q.origin_id ?? null, q.board ?? null)
		.run();
	return r.meta.last_row_id;
}

export function buildServer(env: Env) {
	const db = env.DB;
	const s = new McpServer({ name: "错题练习站", version: "1.1.0" }, { instructions: INSTRUCTIONS });

	s.registerTool("get_inbox", { description: "待处理：新上传的照片（upload_id）+ 待批改作答（attempt_id）。", inputSchema: {} }, async () => {
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
			// 作图板的图只在含手绘笔迹时才给，拍的照片总是给
			const keys = String(a.photo_key ?? "").split(",").filter((k) => k && (!k.startsWith("boards/") || ans.includes("手绘")));
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
		"add_wrong_questions",
		{
			description: "存入照片里整理出的原错题（明天起进复习）。upload_id 对应的照片标为已处理；没错题的照片放 done_upload_ids。",
			inputSchema: { items: z.array(z.object({ ...Q, upload_id: z.number().int().optional() })), done_upload_ids: z.array(z.number().int()).optional() },
		},
		async ({ items, done_upload_ids }) => {
			const done = new Set(done_upload_ids ?? []);
			const ids: number[] = [];
			for (const it of items) {
				const id = await insertQuestion(db, it, "原错题");
				await db.prepare("INSERT OR REPLACE INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0)").bind(id, addDays(today(), 1)).run();
				ids.push(id);
				if (it.upload_id) done.add(it.upload_id);
			}
			for (const u of done) await db.prepare("UPDATE uploads SET status = '已处理' WHERE id = ?").bind(u).run();
			return text(`ok 题 ${ids.join(",") || "无"}；照片已处理 ${done.size}`);
		},
	);

	s.registerTool(
		"add_questions",
		{ description: "推送新题，立刻进入「今日练习」。", inputSchema: { questions: z.array(z.object({ ...Q, origin_id: z.number().int().optional() })) } },
		async ({ questions }) => {
			const ids: number[] = [];
			for (const q of questions) ids.push(await insertQuestion(db, q, "同类题"));
			return text(`ok 题 ${ids.join(",")}`);
		},
	);

	s.registerTool(
		"grade",
		{
			description: `批量批改。score 百分制，≥${PASS} 算对；评语简短具体。`,
			inputSchema: {
				items: z.array(
					z.object({ attempt_id: z.number().int(), score: z.number().min(0).max(100), comment: z.string(), error_reason: z.enum(REASONS).optional() }),
				),
			},
		},
		async ({ items }) => {
			const res: string[] = [];
			for (const g of items) {
				const a = await db.prepare("SELECT question_id FROM attempts WHERE id = ?").bind(g.attempt_id).first<{ question_id: number }>();
				if (!a) { res.push(`#${g.attempt_id} 不存在`); continue; }
				const ok = g.score >= PASS;
				await db
					.prepare("UPDATE attempts SET score = ?, comment = ?, error_reason = ?, is_correct = ?, status = '已判' WHERE id = ?")
					.bind(g.score, g.comment, g.error_reason ?? null, ok ? 1 : 0, g.attempt_id)
					.run();
				await updateQueue(db, a.question_id, ok);
				res.push(`#${g.attempt_id}${ok ? "✓" : "✗"}`);
			}
			return text(res.join(" "));
		},
	);

	s.registerTool(
		"get_records",
		{
			description: "作答记录（TSV），用于统计分析。days 默认 7。",
			inputSchema: { days: z.number().int().min(1).max(365).optional(), subject: z.string().optional() },
		},
		async ({ days, subject }) => {
			const { results } = await db
				.prepare(
					`SELECT substr(a.created_at, 6, 5) d, q.subject s, q.topic t, q.type ty,
					        CASE a.status WHEN '待批改' THEN '?' ELSE a.is_correct END ok, a.score sc, a.error_reason why, a.time_spent_sec sec
					 FROM attempts a JOIN questions q ON q.id = a.question_id
					 WHERE a.created_at >= datetime('now', ?) AND (? IS NULL OR q.subject = ?) ORDER BY a.id LIMIT 1000`,
				)
				.bind(`-${days ?? 7} days`, subject ?? null, subject ?? null)
				.all();
			return text(tsv(results as Record<string, unknown>[]));
		},
	);

	s.registerTool(
		"get_question_bank",
		{ description: "题库清单（TSV）：id、科目、章节、考点、题干摘要、状态。用于整理分类、避免重复出题。", inputSchema: { subject: z.string().optional() } },
		async ({ subject }) => {
			const { results } = await db
				.prepare(
					`SELECT q.id, q.subject s, q.category c, q.topic t, substr(q.stem, 1, 30) stem,
					        CASE WHEN r.question_id IS NOT NULL THEN '复习' WHEN EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) THEN '已做' ELSE '未做' END st
					 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
					 WHERE (? IS NULL OR q.subject = ?) ORDER BY q.id LIMIT 2000`,
				)
				.bind(subject ?? null, subject ?? null)
				.all();
			return text(tsv(results as Record<string, unknown>[]));
		},
	);

	s.registerTool(
		"organize_questions",
		{
			description: "批量改分类（只改传入字段），使题库与用户 Notion 错题库一致。",
			inputSchema: {
				items: z.array(z.object({ question_id: z.number().int(), subject: z.string().optional(), category: z.string().optional(), topic: z.string().optional() })),
			},
		},
		async ({ items }) => {
			let n = 0;
			for (const it of items) {
				const r = await db
					.prepare("UPDATE questions SET subject = COALESCE(?, subject), category = COALESCE(?, category), topic = COALESCE(?, topic) WHERE id = ?")
					.bind(it.subject ?? null, it.category ?? null, it.topic ?? null, it.question_id)
					.run();
				n += r.meta.changes;
			}
			return text(`ok ${n}`);
		},
	);

	s.registerTool("post_summary", { description: "写总结到首页（简短：薄弱点 + 下一步）。", inputSchema: { text: z.string().min(1) } }, async ({ text: t }) => {
		await db.prepare("INSERT INTO summaries (text) VALUES (?)").bind(t).run();
		return text("ok");
	});

	return s;
}

// 无状态：每个请求新建 server + transport
export const mcpHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const server = buildServer(env);
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		await server.connect(transport);
		return transport.handleRequest(request);
	},
};
