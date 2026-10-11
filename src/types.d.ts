declare namespace Cloudflare {
	interface Env {
		OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
		AI: Ai;
		RL_LOGIN?: RateLimit;
		RL_AI?: RateLimit;
		RL_API?: RateLimit;
	}
}
