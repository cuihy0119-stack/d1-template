declare namespace Cloudflare {
	interface Env {
		OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
	}
}
