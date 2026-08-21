// Same non-deprecated backend as the nutrition-estimate fallback (see aiEstimate.ts) — re-check
// developers.cloudflare.com/workers-ai/models/ if this ever needs swapping.
const WEIGHT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

function buildPrompt(ingredientName: string, measureDescription: string): string {
	return [
		'You are a culinary reference. Given a food ingredient and a measure of it, respond with ONLY',
		'a JSON object (no markdown, no explanation, no code fences) containing your best estimate of',
		'its weight in grams for that measure, with exactly this key: grams. The value must be a plain',
		'number (not a string).',
		'',
		`Ingredient: ${ingredientName}`,
		`Measure: ${measureDescription}`,
	].join('\n');
}

// Workers AI returns `response` as a plain string for most models, but pre-parses it into an object
// when the model's output is valid JSON — same gotcha as aiEstimate.ts's parseResponse.
function parseResponse(response: string | Record<string, unknown>): number | null {
	let parsed: unknown = response;
	if (typeof response === 'string') {
		try {
			parsed = JSON.parse(response.trim());
		} catch {
			const match = response.match(/\{[\s\S]*\}/);
			if (!match) return null;
			try {
				parsed = JSON.parse(match[0]);
			} catch {
				return null;
			}
		}
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const value = (parsed as Record<string, unknown>).grams;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return value;
}

function cacheKey(ingredientName: string, measureDescription: string): string {
	return `ai-weight:${measureDescription.trim().toLowerCase()}:${ingredientName.trim().toLowerCase()}`;
}

/** Looks up a previously-cached weight estimate so a repeat ingredient+measure (e.g. across different
 * users' recipes) never has to spend a Workers AI call twice. */
export async function getCachedWeightEstimate(
	ingredientName: string,
	measureDescription: string,
	kv: KVNamespace,
): Promise<number | null> {
	const raw = await kv.get(cacheKey(ingredientName, measureDescription));
	if (raw === null) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

// No expirationTtl: a food's typical weight for a given measure doesn't change, so once estimated it
// can be reused forever — same reasoning as aiEstimate.ts's cacheEstimate.
async function cacheWeightEstimate(ingredientName: string, measureDescription: string, kv: KVNamespace, grams: number): Promise<void> {
	await kv.put(cacheKey(ingredientName, measureDescription), String(grams));
}

/** Asks Cloudflare Workers AI for the typical gram weight of a named measure (e.g. "one whole piece",
 * "1 US cup", "one slice") of an ingredient the database has no precise conversion data for, caching
 * the result in KV when available. Never throws — returns null on any failure so callers can fall
 * back cleanly to their existing generic default. */
export async function estimateGramsWithAI(
	ingredientName: string,
	measureDescription: string,
	ai: Ai,
	kv?: KVNamespace,
): Promise<number | null> {
	try {
		const result = (await ai.run(WEIGHT_MODEL, {
			messages: [{ role: 'user', content: buildPrompt(ingredientName, measureDescription) }],
			max_tokens: 64,
		})) as { response?: string | Record<string, unknown> };
		if (!result.response) return null;
		const grams = parseResponse(result.response);
		if (grams && kv) await cacheWeightEstimate(ingredientName, measureDescription, kv, grams);
		return grams;
	} catch (err) {
		// Logged for the same reason as aiEstimate.ts's failure log — so a model deprecation or shape
		// change shows up in `wrangler tail` instead of silently degrading to the generic gram default.
		console.error('estimateGramsWithAI: Workers AI call failed', err);
		return null;
	}
}
