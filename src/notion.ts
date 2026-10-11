// 错题 → Notion 笔记：用 Notion 官方接口按考点名搜页面标题（不用 AI、不花额度）。
// 需要在 Cloudflare 加密钥 NOTION_TOKEN（Notion 内部集成的密钥），并在 Notion 里把笔记页「连接」给这个集成。
// 结果缓存在 max_cache：找到的存 7 天，没找到的存 1 天，同一考点不重复搜。
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

export async function findNote(env: Env, topic: string): Promise<{ note: Note | null; setup?: boolean }> {
	const token = (env as any).NOTION_TOKEN as string | undefined;
	if (!token) return { note: null, setup: true };
	topic = topic.trim().slice(0, 30);
	if (!topic) return { note: null };
	const key = "nt:" + topic, hit = (await cacheGet(env.DB, key, 24 * 7)) ?? ((await cacheGet(env.DB, key + ":none", 24)) ? "" : null);
	if (hit != null) return { note: hit ? JSON.parse(hit) : null };
	const r = await fetch("https://api.notion.com/v1/search", {
		method: "POST", signal: AbortSignal.timeout(8000),
		headers: { authorization: "Bearer " + token, "notion-version": "2022-06-28", "content-type": "application/json" },
		body: JSON.stringify({ query: topic, filter: { property: "object", value: "page" }, page_size: 15 }),
	});
	if (!r.ok) throw new Error("Notion " + r.status + (r.status === 401 ? "（密钥不对）" : ""));
	const best = ((await r.json<any>()).results ?? []).filter((p: any) => !p.archived && p.url)
		.map((p: any) => ({ url: String(p.url), title: titleOf(p), s: score(titleOf(p), topic) })).filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s)[0];
	const note = best ? { url: best.url, title: best.title } : null;
	await cachePut(env.DB, note ? key : key + ":none", note ? JSON.stringify(note) : "1");
	return { note };
}
