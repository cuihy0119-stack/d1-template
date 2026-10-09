import type { Hono } from "hono";
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { passcodeOk } from "./auth";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body: string, status = 200, headers?: Headers) {
	const h = headers ?? new Headers();
	h.set("Content-Type", "text/html; charset=utf-8");
	return new Response(
		`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权</title><link rel="stylesheet" href="/style.css"></head><body><main class="login">${body}</main></body></html>`,
		{ status, headers: h },
	);
}

// 授权 Claude 访问：在这里输入口令并同意（单用户）
export function mountAuthorize(app: Hono<{ Bindings: Env }>) {
	app.get("/authorize", async (c) => {
		try {
			const oauth = c.env.OAUTH_PROVIDER;
			const req = await oauth.parseAuthRequest(c.req.raw);
			const d = await oauth.describeConsent(req);
			const consent = await oauth.beginConsent(req);
			return page(
				`<h1>授权 Claude</h1>
<p>「${esc(d.clientName)}」想连接你的错题练习站（出题、批改、写总结）。</p>
<p class="mute">回调地址：${esc(d.redirectHost)}</p>
<form method="post">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<input type="password" name="passcode" placeholder="口令" required>
<button class="btn primary" name="decision" value="approve">允许</button>
<button class="btn" name="decision" value="deny" formnovalidate>拒绝</button>
</form>`,
				200,
				consent.headers,
			);
		} catch (e) {
			return fail(e);
		}
	});

	app.post("/authorize", async (c) => {
		try {
			const oauth = c.env.OAUTH_PROVIDER;
			const form = await c.req.formData();
			const handle = String(form.get("handle") ?? "");
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(c.req.raw, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}
			if (!c.env.PASSCODE || !(await passcodeOk(String(form.get("passcode") ?? ""), c.env.PASSCODE))) {
				return page(`<h1>口令不对</h1><p class="err">请返回 Claude 重新发起连接。</p>`, 401);
			}
			const approved = await oauth.approveConsent(c.req.raw, handle, { scope: ["mcp"] });
			const { redirectTo } = await oauth.completeAuthorization({
				request: approved.request,
				userId: "owner",
				metadata: {},
				scope: approved.request.scope,
				props: { userId: "owner" },
			});
			approved.headers.set("Location", redirectTo);
			return new Response(null, { status: 302, headers: approved.headers });
		} catch (e) {
			return fail(e);
		}
	});
}

function fail(e: unknown) {
	if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
	if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
		const msg = e instanceof AuthorizationError ? e.description : "无法验证这个应用";
		return page(`<h1>授权失败</h1><p class="err">${esc(String(msg))}</p>`, 400);
	}
	throw e;
}
