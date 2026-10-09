import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { addDays, today, updateQueue } from "./review";

const PASS_SCORE = 80; // 简答/大题得分（百分制）达到这个分数算「对」
const ERROR_REASONS = ["概念不清", "表述不规范", "审题失误", "计算错误", "不会做"] as const;
const MAX_IMAGES = 8; // 一次最多返回的图片数，避免响应过大

const questionShape = {
	subject: z.string().describe("科目，如 化学、数学、物理、法语"),
	category: z.string().optional().describe("章节/分类，如「第二单元 我们周围的空气」；与用户 Notion 错题库里的分类保持一致，网站按 科目→分类→考点 分组展示"),
	topic: z.string().describe("考点，如 氧气的性质"),
	type: z.enum(["single", "multi", "fill", "short"]).describe("single 单选 / multi 多选 / fill 填空 / short 简答和大题"),
	stem: z.string().describe("题干。公式用 $...$，化学式用 $\\ce{...}$"),
	options: z.array(z.string()).optional().describe('选择题选项，如 ["A. xxx","B. xxx"]；填空和简答不填'),
	answer: z
		.array(z.string())
		.describe("选择题=正确选项字母，如 [\"B\"] 或 [\"A\",\"C\"]；填空题=所有可接受答案；简答题=[参考答案]"),
	explanation: z.string().optional().describe("解析"),
};

type Img = { type: "image"; data: string; mimeType: string };
type Content = { type: "text"; text: string } | Img;

async function loadImages(db: D1Database, keys: string[]): Promise<Img[]> {
	const out: Img[] = [];
	for (const key of keys) {
		const r = await db
			.prepare("SELECT content_type, data FROM photos WHERE key = ?")
			.bind(key)
			.first<{ content_type: string; data: string }>();
		if (r) out.push({ type: "image", data: r.data, mimeType: r.content_type });
	}
	return out;
}

async function insertQuestion(db: D1Database, q: any, source: "原错题" | "同类题") {
	const res = await db
		.prepare(
			"INSERT INTO questions (subject, category, topic, type, stem, options, answer, explanation, source, origin_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
		)
		.bind(
			q.subject,
			q.category ?? null,
			q.topic,
			q.type,
			q.stem,
			q.options?.length ? JSON.stringify(q.options) : null,
			JSON.stringify(q.answer),
			q.explanation ?? null,
			source,
			q.origin_id ?? null,
		)
		.run();
	return res.meta.last_row_id;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function buildServer(env: Env) {
	const db = env.DB;
	const server = new McpServer({ name: "错题练习站", version: "1.0.0" });

	server.registerTool(
		"get_inbox",
		{
			description:
				"获取所有待处理内容：①用户新上传、还没整理的照片（以图片返回，带 upload_id），②用户已作答、等待批改的简答/大题（含题干、参考答案、用户文字答案和过程照片，带 attempt_id）。整理照片请用 add_wrong_questions，批改请用 grade。每次最多返回 8 张图片，处理完再调用一次获取剩余内容。",
			inputSchema: {},
		},
		async () => {
			const content: Content[] = [];
			let budget = MAX_IMAGES;

			const uploads = await db
				.prepare("SELECT id, r2_key, created_at FROM uploads WHERE status = '待处理' ORDER BY id")
				.all<{ id: number; r2_key: string; created_at: string }>();
			content.push({ type: "text", text: `待整理照片共 ${uploads.results.length} 张。` });
			let shownUploads = 0;
			for (const u of uploads.results) {
				if (budget <= 0) break;
				const imgs = await loadImages(db, [u.r2_key]);
				content.push({ type: "text", text: `[照片 upload_id=${u.id}，上传于 ${u.created_at}]` }, ...imgs);
				budget -= 1;
				shownUploads++;
			}
			if (uploads.results.length > shownUploads) {
				content.push({ type: "text", text: `（还有 ${uploads.results.length - shownUploads} 张照片未显示，处理完后再调用 get_inbox）` });
			}

			const att = await db
				.prepare(
					`SELECT a.id, a.answer_text, a.photo_key, a.time_spent_sec, q.id qid, q.subject, q.topic, q.stem, q.options, q.answer, q.explanation
					 FROM attempts a JOIN questions q ON q.id = a.question_id
					 WHERE a.status = '待批改' ORDER BY a.id`,
				)
				.all<any>();
			content.push({ type: "text", text: `待批改作答共 ${att.results.length} 条。` });
			let shownAtt = 0;
			for (const a of att.results) {
				const keys: string[] = a.photo_key ? String(a.photo_key).split(",") : [];
				if (budget < keys.length && shownAtt > 0) break;
				const imgs = await loadImages(db, keys.slice(0, Math.max(budget, 0)));
				budget -= imgs.length;
				content.push(
					{
						type: "text",
						text: [
							`[待批改 attempt_id=${a.id}，question_id=${a.qid}，${a.subject}·${a.topic}，用时 ${a.time_spent_sec ?? 0} 秒。用户的过程照片可能是手写/手绘的画板图，请直接读图批改]`,
							`题干：${a.stem}`,
							a.options ? `选项：${a.options}` : "",
							`参考答案：${a.answer}`,
							a.explanation ? `解析：${a.explanation}` : "",
							`用户文字作答：${a.answer_text || "（无）"}`,
							imgs.length ? `用户过程照片（${imgs.length} 张）见下：` : "（无照片）",
						]
							.filter(Boolean)
							.join("\n"),
					},
					...imgs,
				);
				shownAtt++;
			}
			if (att.results.length > shownAtt) {
				content.push({ type: "text", text: `（还有 ${att.results.length - shownAtt} 条待批改未显示，处理完后再调用 get_inbox）` });
			}
			return { content };
		},
	);

	server.registerTool(
		"add_wrong_questions",
		{
			description:
				"把从照片里整理出的原错题存入题库，并自动进入复习队列（明天开始按 1、2、4、7、15 天重做）。每道题可带 upload_id（它来自哪张照片），对应上传会被标为已处理；照片里没有可用错题时，把它的 upload_id 放进 done_upload_ids 也会标为已处理。",
			inputSchema: {
				items: z.array(z.object({ ...questionShape, upload_id: z.number().int().optional().describe("来自哪张照片") })),
				done_upload_ids: z.array(z.number().int()).optional().describe("没有可整理错题、但已看过的照片"),
			},
		},
		async ({ items, done_upload_ids }) => {
			const ids: number[] = [];
			const uploadIds = new Set<number>(done_upload_ids ?? []);
			for (const it of items) {
				const id = await insertQuestion(db, it, "原错题");
				await db
					.prepare("INSERT OR REPLACE INTO review_queue (question_id, next_date, stage) VALUES (?, ?, 0)")
					.bind(id, addDays(today(), 1))
					.run();
				ids.push(id);
				if (it.upload_id) uploadIds.add(it.upload_id);
			}
			for (const u of uploadIds) await db.prepare("UPDATE uploads SET status = '已处理' WHERE id = ?").bind(u).run();
			return text(`已存入 ${ids.length} 道原错题（question_id: ${ids.join(", ") || "无"}），标记已处理照片 ${uploadIds.size} 张。`);
		},
	);

	server.registerTool(
		"add_questions",
		{
			description:
				"推送同类题（新题）。保存后会立刻出现在用户的「今日练习」里。origin_id 填它对应的原错题 question_id（可选）。",
			inputSchema: {
				questions: z.array(z.object({ ...questionShape, origin_id: z.number().int().optional().describe("对应的原错题 question_id") })),
			},
		},
		async ({ questions }) => {
			const ids: number[] = [];
			for (const q of questions) ids.push(await insertQuestion(db, q, "同类题"));
			return text(`已推送 ${ids.length} 道新题到今日练习（question_id: ${ids.join(", ")}）。`);
		},
	);

	server.registerTool(
		"grade",
		{
			description: `批改一条「待批改」的简答/大题作答，写入评分、评语和错因，用户刷新结果页即可看到。score 为百分制 0-100，达到 ${PASS_SCORE} 分算做对（做对则复习间隔推进，做错则明天重做）。error_reason 只能是：${ERROR_REASONS.join(" / ")}；满分时可不填。`,
			inputSchema: {
				attempt_id: z.number().int(),
				score: z.number().min(0).max(100),
				comment: z.string().describe("评语：指出对在哪、错在哪、怎么改"),
				error_reason: z.enum(ERROR_REASONS).optional(),
			},
		},
		async ({ attempt_id, score, comment, error_reason }) => {
			const a = await db
				.prepare("SELECT question_id FROM attempts WHERE id = ?")
				.bind(attempt_id)
				.first<{ question_id: number }>();
			if (!a) return { ...text(`找不到 attempt_id=${attempt_id}`), isError: true };
			const ok = score >= PASS_SCORE;
			await db
				.prepare(
					"UPDATE attempts SET score = ?, comment = ?, error_reason = ?, is_correct = ?, status = '已判' WHERE id = ?",
				)
				.bind(score, comment, error_reason ?? null, ok ? 1 : 0, attempt_id)
				.run();
			await updateQueue(db, a.question_id, ok);
			return text(`已批改 attempt_id=${attempt_id}：${score} 分，${ok ? "算做对" : "算做错，明天重做"}。`);
		},
	);

	server.registerTool(
		"get_records",
		{
			description:
				"返回指定时间范围内的全部作答记录（科目、考点、题型、对错、得分、错因、评语、用时、时间），供你自己统计分析、写总结。days 默认 7；subject 可选，不填则所有科目。",
			inputSchema: {
				days: z.number().int().min(1).max(365).optional(),
				subject: z.string().optional(),
			},
		},
		async ({ days, subject }) => {
			const { results } = await db
				.prepare(
					`SELECT a.id attempt_id, a.created_at, q.id question_id, q.subject, q.category, q.topic, q.type, q.source,
					        a.status, a.is_correct, a.score, a.error_reason, a.comment, a.time_spent_sec
					 FROM attempts a JOIN questions q ON q.id = a.question_id
					 WHERE a.created_at >= datetime('now', ?) AND (? IS NULL OR q.subject = ?)
					 ORDER BY a.id LIMIT 2000`,
				)
				.bind(`-${days ?? 7} days`, subject ?? null, subject ?? null)
				.all();
			return text(JSON.stringify({ count: results.length, records: results }));
		},
	);

	server.registerTool(
		"get_question_bank",
		{
			description:
				"列出题库里所有题（question_id、科目、分类、考点、题型、题干摘要、来源、掌握状态），用于整理分类、同步到 Notion、避免出重复的题。subject 可选。",
			inputSchema: { subject: z.string().optional() },
		},
		async ({ subject }) => {
			const { results } = await db
				.prepare(
					`SELECT q.id question_id, q.subject, q.category, q.topic, q.type, substr(q.stem, 1, 60) stem, q.source,
					        CASE WHEN r.question_id IS NULL THEN (CASE WHEN q.source = '原错题' THEN '已掌握' ELSE '未入复习' END) ELSE '复习中，下次 ' || r.next_date END status
					 FROM questions q LEFT JOIN review_queue r ON r.question_id = q.id
					 WHERE (? IS NULL OR q.subject = ?) ORDER BY q.id LIMIT 2000`,
				)
				.bind(subject ?? null, subject ?? null)
				.all();
			return text(JSON.stringify({ count: results.length, questions: results }));
		},
	);

	server.registerTool(
		"organize_questions",
		{
			description:
				"批量调整已有题目的分类：修改 subject / category / topic（只改你传的字段）。用于把题库整理成和用户 Notion 错题库一致的科目→章节→考点结构，网站会立刻按新分类展示。",
			inputSchema: {
				items: z.array(
					z.object({
						question_id: z.number().int(),
						subject: z.string().optional(),
						category: z.string().optional(),
						topic: z.string().optional(),
					}),
				),
			},
		},
		async ({ items }) => {
			let n = 0;
			for (const it of items) {
				const r = await db
					.prepare(
						"UPDATE questions SET subject = COALESCE(?, subject), category = COALESCE(?, category), topic = COALESCE(?, topic) WHERE id = ?",
					)
					.bind(it.subject ?? null, it.category ?? null, it.topic ?? null, it.question_id)
					.run();
				n += r.meta.changes;
			}
			return text(`已更新 ${n} 道题的分类。`);
		},
	);

	server.registerTool(
		"post_summary",
		{
			description: "写一段总结，显示在用户首页（会替换显示为最新一条）。用简短、鼓励又具体的话，指出薄弱考点和接下来怎么练。",
			inputSchema: { text: z.string().min(1) },
		},
		async ({ text: t }) => {
			await db.prepare("INSERT INTO summaries (text) VALUES (?)").bind(t).run();
			return text("总结已发布到首页。");
		},
	);

	return server;
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
