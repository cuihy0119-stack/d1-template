// 错题 → Notion 笔记（不用 AI、不花额度）：先查对照表（科目 + 考点关键词 → 笔记页，由 Claude 读 Notion 后写入）；
// 对照表没有具体命中时，设了 NOTION_TOKEN 才按标题搜 Notion；最后用这一科的兜底页。搜索结果缓存在 max_cache（找到 7 天、没找到 1 天）。
import { cacheGet, cachePut } from "./max";

export type Note = { url: string; title: string };
const strip = (s: string) => s.replace(/[\s·・:：\-—_/]/g, "").toLowerCase();

/** 页面标题（取 title 类型的属性） */
const titleOf = (p: any): string => {
	for (const v of Object.values<any>(p?.properties ?? {})) if (v?.type === "title") return (v.title ?? []).map((t: any) => t.plain_text ?? "").join("");
	return "";
};

/** 标题和考点的匹配分：完全一样 3，标题包含考点 2，考点包含标题（≥2 字）1，其它 0 */
export function score(title: string, topic: string): number {
	const a = strip(title), b = strip(topic);
	if (!a || !b) return 0;
	return a === b ? 3 : a.includes(b) ? 2 : a.length >= 2 && b.includes(a) ? 1 : 0;
}

/** 对照表（存在 meta.notes，Claude 通过 MCP save({notes}) 整表更新）：s 科目（可多个别名）、k 考点关键词、t/u 笔记标题和链接；k 为空 = 这一科的兜底页 */
export type Entry = { s: string[]; t: string; u: string; k?: string[] };

/** 在对照表里找：科目对得上，考点含关键词（越长越准）；没有关键词命中就用这一科的兜底页（分数 0.5） */
export function pickEntry(map: Entry[], subject: string, topic: string): { e: Entry; sc: number } | null {
	let best: { e: Entry; sc: number } | null = null;
	for (const e of map) {
		if (subject && e.s.length && !e.s.includes(subject)) continue;
		const sc = (e.k ?? []).reduce((m, k) => (k && topic.includes(k) ? Math.max(m, k.length) : m), 0) || (e.k?.length ? 0 : subject && e.s.length ? 0.5 : 0);
		if (sc > (best?.sc ?? 0)) best = { e, sc };
	}
	return best;
}

export async function findNote(env: Env, subject: string, topic: string): Promise<{ note: Note | null }> {
	topic = topic.trim().slice(0, 30); subject = subject.trim().slice(0, 10);
	if (!topic) return { note: null };
	let map: Entry[] = [];
	try { map = JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k = 'notes'").first<{ v: string }>())?.v ?? "[]"); } catch {}
	const hit = pickEntry(map, subject, topic), mine = hit && { url: hit.e.u, title: hit.e.t };
	if (hit && hit.sc >= 1) return { note: mine }; // 对照表里有这个考点
	const found = await searchNotion(env, topic).catch(() => null); // 没设 NOTION_TOKEN 就跳过；设了就按标题搜
	return { note: found ?? mine ?? null };
}

async function searchNotion(env: Env, topic: string): Promise<Note | null> {
	const token = (env as any).NOTION_TOKEN as string | undefined;
	if (!token) return null;
	const key = "nt:" + topic, hit = (await cacheGet(env.DB, key, 24 * 7)) ?? ((await cacheGet(env.DB, key + ":none", 24)) ? "" : null);
	if (hit != null) return hit ? JSON.parse(hit) : null;
	const r = await fetch("https://api.notion.com/v1/search", {
		method: "POST", signal: AbortSignal.timeout(8000),
		headers: { authorization: "Bearer " + token, "notion-version": "2022-06-28", "content-type": "application/json" },
		body: JSON.stringify({ query: topic, filter: { property: "object", value: "page" }, page_size: 15 }),
	});
	if (!r.ok) throw new Error("Notion " + r.status);
	const best = ((await r.json<any>()).results ?? []).filter((p: any) => !p.archived && p.url)
		.map((p: any) => ({ url: String(p.url), title: titleOf(p), s: score(titleOf(p), topic) })).filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s)[0];
	const note = best ? { url: best.url, title: best.title } : null;
	await cachePut(env.DB, note ? key : key + ":none", note ? JSON.stringify(note) : "1");
	return note;
}
