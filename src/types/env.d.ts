export {};

// TURNSTILE_SECRET is a Worker secret set via the Cloudflare dashboard (Workers & Pages -> Settings ->
// Variables and Secrets), not a binding declared in wrangler.jsonc — `wrangler types` never generates
// it, so it's added here by hand. Merges into __BaseEnv_Env (see worker-configuration.d.ts), which
// both the global `Env` and `Cloudflare.Env` interfaces extend.
declare global {
	interface __BaseEnv_Env {
		TURNSTILE_SECRET: string;
	}
}
