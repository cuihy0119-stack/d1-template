// Max 联网搜索：不需要额外服务，依次试 Tavily（设了 TAVILY_API_KEY 才用，最稳）→ Bing 网页 → DuckDuckGo 网页 → 中文维基；拿到结果就停。
// 只取标题 + 摘要 + 网站名（够 Max 判断就行，省 token），整段不超过 ~1500 字。
export type Hit = { title: string; snippet: string; url: string };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const text = (h: string) =>
	h.replace(/<[^>]*>/g, "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
		return ENT[e.toLowerCase()] ?? m;
	}).replace(/\s+/g, " ").trim();

const get = async (url: string, headers: Record<string, string> = {}) => {
	const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.6", ...headers }, redirect: "follow" });
	if (!r.ok) throw new Error("HTTP " + r.status);
	return r;
};

/** Bing 的结果链接有时是 bing.com/ck/a?…&u=a1<base64> 的跳转，解出真实网址 */
export function unwrapBing(href: string): string {
	try {
		const u = new URL(href, "https://www.bing.com");
		if (/(^|\.)bing\.com$/.test(u.hostname)) {
			const e = u.searchParams.get("u");
			if (e?.startsWith("a1")) { const b = e.slice(2).replace(/-/g, "+").replace(/_/g, "/"); return new TextDecoder().decode(Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0))); }
			return "";
		}
		return u.href;
	} catch { return ""; }
}

export function parseBing(html: string): Hit[] {
	const out: Hit[] = [];
	for (const blk of html.split(/<li class="b_algo/).slice(1)) {
		const a = blk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!a) continue;
		const url = unwrapBing(text(a[1])), p = blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
		if (url && /^https?:/.test(url)) out.push({ title: text(a[2]), snippet: p ? text(p[1]) : "", url });
	}
	return out;
}

export function parseDdg(html: string): Hit[] {
	const out: Hit[] = [];
	for (const blk of html.split(/<div class="[^"]*result__body/).slice(1)) {
		const a = blk.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || blk.match(/<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
		if (!a) continue;
		let url = text(a[1]);
		try { const u = new URL(url, "https://duckduckgo.com"); url = u.searchParams.get("uddg") || u.href; } catch { continue; }
		const s = blk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
		if (/^https?:/.test(url)) out.push({ title: text(a[2]), snippet: s ? text(s[1]) : "", url });
	}
	return out;
}

const engines: ((q: string, env: Env) => Promise<Hit[]>)[] = [
	async (q, env) => {
		const key = (env as any).TAVILY_API_KEY as string | undefined;
		if (!key) return [];
		const r = await fetch("https://api.tavily.com/search", { method: "POST", signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json", authorization: "Bearer " + key },
			body: JSON.stringify({ query: q, max_results: 5, search_depth: "basic" }) });
		if (!r.ok) throw new Error("Tavily " + r.status);
		return ((await r.json<any>()).results ?? []).map((x: any) => ({ title: String(x.title ?? ""), snippet: String(x.content ?? ""), url: String(x.url ?? "") }));
	},
	async (q) => parseBing(await (await get("https://www.bing.com/search?setlang=zh-Hans&cc=CN&q=" + encodeURIComponent(q))).text()),
	async (q) => parseDdg(await (await get("https://html.duckduckgo.com/html/?kl=cn-zh&q=" + encodeURIComponent(q))).text()),
	async (q) => {
		const j = await (await get("https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=" + encodeURIComponent(q))).json<any>();
		return (j?.query?.search ?? []).map((x: any) => ({ title: x.title, snippet: text(String(x.snippet)), url: "https://zh.wikipedia.org/wiki/" + encodeURIComponent(x.title) }));
	},
];

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** 搜一次，返回给模型看的文字（n=0 表示没搜到） */
export async function webSearch(env: Env, query: string): Promise<{ text: string; n: number }> {
	const q = query.replace(/(请|帮我|麻烦|能不能|可以)?(联网)?(搜索|搜一下|搜搜|查一下|查查|查询)(一下)?/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || query.slice(0, 100);
	let hits: Hit[] = [];
	for (const run of engines) {
		try { hits = (await run(q, env)).filter((h) => h.title && h.url).slice(0, 5); } catch { hits = []; }
		if (hits.length) break;
	}
	if (!hits.length) return { text: `联网搜索「${q}」没有搜到结果（搜索服务暂时不可用或没有相关网页）。`, n: 0 };
	return {
		n: hits.length,
		text: `联网搜索「${q}」的结果（网页摘要，可能不准或过时）：\n` + hits.map((h, i) => `${i + 1}. ${clip(h.title, 50)}｜${clip(h.snippet, 180)}｜${host(h.url)}`).join("\n"),
	};
}
