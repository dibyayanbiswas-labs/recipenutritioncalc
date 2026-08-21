import type { NutrientProfile } from './matchIngredient';

// A small, cheap instruct model — this is a short structured-JSON task, not the vision OCR path,
// so it doesn't need a large model. @cf/meta/llama-3.1-8b-instruct was deprecated 2026-05-30 (error
// 5028); -fast is its non-deprecated successor backend. Re-check
// developers.cloudflare.com/workers-ai/models/ if this ever needs swapping again; the catalog moves.
const ESTIMATE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const CORE_KEYS = ['kcal', 'protein_g', 'fat_g', 'satFat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg'] as const;
// Vitamins/minerals the site's %DV chart displays (see dailyValues.json) — optional because requiring
// the model to nail all 20 of these to accept the response at all would make CORE_KEYS (the fields
// that actually drive kcal/macros) fail far more often on a technicality. Missing/invalid ones here
// just come back as 0 the same way a real database entry with a gap in its source data already does
// (see scaleProfile's `?? 0`) — better than every AI-estimated ingredient (e.g. an organ meat like
// liver, or anything else the local database has no entry for) silently reading as containing zero
// vitamin A/B12/etc. regardless of what the actual food is.
const OPTIONAL_KEYS = [
	'vitaminA_mcg',
	'vitaminC_mg',
	'vitaminD_mcg',
	'vitaminE_mg',
	'vitaminK_mcg',
	'thiamin_mg',
	'riboflavin_mg',
	'niacin_mg',
	'vitaminB6_mg',
	'folate_mcg',
	'vitaminB12_mcg',
	'calcium_mg',
	'iron_mg',
	'magnesium_mg',
	'phosphorus_mg',
	'potassium_mg',
	'zinc_mg',
	'copper_mg',
	'manganese_mg',
	'selenium_mcg',
	'cholesterol_mg',
] as const;

function buildPrompt(ingredientName: string): string {
	return [
		'You are a nutrition database. Given a food ingredient name, respond with ONLY a JSON object',
		'(no markdown, no explanation, no code fences) containing your best estimate of its nutrition',
		'per 100 grams. All values must be plain numbers (not strings), in these units.',
		'',
		'Required — always include a real estimate for each:',
		`${CORE_KEYS.join(', ')}`,
		'',
		'Also include your best estimate for as many of these vitamins/minerals as you can — use 0 only',
		'when the ingredient genuinely contains none of it, not as a placeholder for "unsure":',
		`${OPTIONAL_KEYS.join(', ')}`,
		'',
		`Ingredient: ${ingredientName}`,
	].join('\n');
}

// Workers AI returns `response` as a plain string for most models, but when the model's output is
// valid JSON, the platform pre-parses it into an object before handing it back — so this has to accept
// either shape rather than assuming a string to call .trim()/.match() on.
function parseResponse(response: string | Record<string, unknown>): NutrientProfile | null {
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
	const obj = parsed as Record<string, unknown>;
	const profile = {} as NutrientProfile;
	for (const key of CORE_KEYS) {
		const value = obj[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) return null;
		profile[key] = value;
	}
	for (const key of OPTIONAL_KEYS) {
		const value = obj[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) profile[key] = value;
	}
	return profile;
}

function cacheKey(ingredientName: string): string {
	return `ai-estimate:${ingredientName.trim().toLowerCase()}`;
}

/** Looks up a previously-cached AI estimate so a repeat ingredient (e.g. across different users' recipes) never has to spend a Workers AI call twice. */
export async function getCachedEstimate(ingredientName: string, kv: KVNamespace): Promise<NutrientProfile | null> {
	const raw = await kv.get(cacheKey(ingredientName));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as NutrientProfile;
	} catch {
		return null;
	}
}

// No expirationTtl: a food's per-100g nutrition doesn't change, so once estimated it can be reused
// forever — this is what keeps repeat ingredients from costing Neurons more than once.
async function cacheEstimate(ingredientName: string, kv: KVNamespace, profile: NutrientProfile): Promise<void> {
	await kv.put(cacheKey(ingredientName), JSON.stringify(profile));
}

/** Asks Cloudflare Workers AI to estimate per-100g nutrition for an ingredient the local database couldn't match, caching the result in KV when available. Never throws — returns null on any failure so callers can fall back cleanly. */
export async function estimateNutritionWithAI(ingredientName: string, ai: Ai, kv?: KVNamespace): Promise<NutrientProfile | null> {
	try {
		const result = (await ai.run(ESTIMATE_MODEL, {
			messages: [{ role: 'user', content: buildPrompt(ingredientName) }],
			// 256 was tuned for the original 8-field response; the vitamin/mineral fields roughly
			// quadruple the JSON's key count, so this needs proportionally more room to avoid a
			// response getting cut off mid-object and failing to parse.
			max_tokens: 700,
		})) as { response?: string | Record<string, unknown> };
		if (!result.response) return null;
		const profile = parseResponse(result.response);
		if (profile && kv) await cacheEstimate(ingredientName, kv, profile);
		return profile;
	} catch (err) {
		// Logged so a future model deprecation/shape change shows up in `wrangler tail` instead of
		// silently degrading every unmatched ingredient to zero nutrition.
		console.error('estimateNutritionWithAI: Workers AI call failed', err);
		return null;
	}
}
