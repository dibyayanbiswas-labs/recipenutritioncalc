// Public by design — meant to be embedded in the page's HTML so the widget can load.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAEXt8noz7I2XHJGk';

// One action per protected surface, validated against Cloudflare's response below so a token minted
// for one form can't be replayed against another.
export const TURNSTILE_ACTIONS = {
	pasteText: 'paste_text',
	url: 'recipe_url',
	manual: 'manual_entry',
	photo: 'photo_upload',
} as const;

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 8000;

/** Verifies a Turnstile token server-side against Cloudflare's siteverify endpoint before a form
 * handler does any real work. Fails closed: a missing/oversized token, network error, non-2xx
 * response, or a `success: false`/mismatched-action result all count as a failed check — a bot
 * check that quietly passes on error defeats its own purpose. */
export async function verifyTurnstileToken(
	token: unknown,
	secret: string,
	expectedAction: string,
	remoteIp?: string,
): Promise<boolean> {
	if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
		const body = new URLSearchParams({ secret, response: token });
		if (remoteIp) body.set('remoteip', remoteIp);
		const response = await fetch(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) return false;
		const result = (await response.json()) as { success?: boolean; action?: string };
		return result.success === true && result.action === expectedAction;
	} catch {
		return false;
	}
}
