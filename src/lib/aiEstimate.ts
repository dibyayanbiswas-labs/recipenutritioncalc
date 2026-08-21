import type { NutrientProfile } from './matchIngredient';
import type { AiCallBudget } from './unitConversion';

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
// Exported so callers (nutrients.ts) can check which of these a real database entry is missing,
// to enrich it via the same estimate this module already produces — see enrichMissingNutrients.
export const OPTIONAL_KEYS = [
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

/** Looks up a previously-cached AI estimate so a repeat ingredient (e.g. across different users' recipes) never has to spend a Workers AI call twice. Never throws: a KV read failure (e.g. the free plan's daily read quota) is treated the same as a cache miss rather than surfacing as a raw error to the caller. */
export async function getCachedEstimate(ingredientName: string, kv: KVNamespace): Promise<NutrientProfile | null> {
	let raw: string | null;
	try {
		raw = await kv.get(cacheKey(ingredientName));
	} catch (err) {
		console.error('getCachedEstimate: KV read failed', err);
		return null;
	}
	if (!raw) return null;
	try {
		return JSON.parse(raw) as NutrientProfile;
	} catch {
		return null;
	}
}

// No expirationTtl: a food's per-100g nutrition doesn't change, so once estimated it can be reused
// forever — this is what keeps repeat ingredients from costing Neurons more than once. Also why a bad
// answer is worth a retry before it gets cached: it's stuck for every future user of that ingredient.
async function cacheEstimate(ingredientName: string, kv: KVNamespace, profile: NutrientProfile): Promise<void> {
	await kv.put(cacheKey(ingredientName), JSON.stringify(profile));
}

// A real food is essentially never zero across all 20 vitamin/mineral fields at once — even something
// as plain as white rice has nonzero thiamin, magnesium, etc. All-zero is a much stronger signal that
// the model phoned in a lazy completion for that call specifically than that the food genuinely has
// none of any of them, and it's worth one retry before that answer gets locked into the cache forever.
function hasAnyNonzeroOptional(profile: NutrientProfile): boolean {
	return OPTIONAL_KEYS.some((key) => (profile[key] ?? 0) > 0);
}

async function runEstimate(ingredientName: string, ai: Ai): Promise<NutrientProfile | null> {
	const result = (await ai.run(ESTIMATE_MODEL, {
		messages: [{ role: 'user', content: buildPrompt(ingredientName) }],
		// 256 was tuned for the original 8-field response; the vitamin/mineral fields roughly
		// quadruple the JSON's key count, so this needs proportionally more room to avoid a response
		// getting cut off mid-object and failing to parse.
		max_tokens: 700,
	})) as { response?: string | Record<string, unknown> };
	if (!result.response) return null;
	return parseResponse(result.response);
}

/** Asks Cloudflare Workers AI to estimate per-100g nutrition for an ingredient the local database couldn't match, caching the result in KV when available. Never throws — returns null on any failure so callers can fall back cleanly. */
export async function estimateNutritionWithAI(ingredientName: string, ai: Ai, kv?: KVNamespace): Promise<NutrientProfile | null> {
	try {
		let profile = await runEstimate(ingredientName, ai);
		if (profile && !hasAnyNonzeroOptional(profile)) {
			// Bounded to a single retry — if the second attempt is also all-zero, accept it rather than
			// looping; a food that's genuinely all-zero is vanishingly rare but not impossible.
			const retryProfile = await runEstimate(ingredientName, ai);
			if (retryProfile && hasAnyNonzeroOptional(retryProfile)) profile = retryProfile;
		}
		if (profile && kv) await cacheEstimate(ingredientName, kv, profile);
		return profile;
	} catch (err) {
		// Logged so a future model deprecation/shape change shows up in `wrangler tail` instead of
		// silently degrading every unmatched ingredient to zero nutrition.
		console.error('estimateNutritionWithAI: Workers AI call failed', err);
		return null;
	}
}

/** Fills in vitamin/mineral fields a *real, matched* database entry is genuinely missing (the key is
 * absent from its per100g data, not just zero — a real zero stays a real zero) using the same
 * estimate/cache/retry machinery as an unmatched ingredient, keyed by the entry's own canonical name
 * so every recipe that matches this entry shares one cached enrichment instead of paying per-recipe.
 * Core macro fields and any optional field the entry already has are never touched — this only ever
 * adds what wasn't there. Draws from the shared per-request budget; returns the entry's own per100g
 * unchanged if nothing's missing, the budget is exhausted, or no AI context is available. */
export async function enrichMissingNutrients(
	entryName: string,
	per100g: NutrientProfile,
	ai?: Ai,
	kv?: KVNamespace,
	budget?: AiCallBudget,
): Promise<NutrientProfile> {
	const missingKeys = OPTIONAL_KEYS.filter((key) => !(key in per100g));
	if (missingKeys.length === 0 || !ai) return per100g;

	// Cache lookup is free (no Neurons spent) and doesn't touch the call budget — only an actual model
	// call does, checked and consumed after the cache miss below. Same "ai-estimate:" cache namespace
	// as estimateNutritionWithAI's own per-ingredient cache — deliberately: whichever call happens to
	// run first for a given name (this entry's canonical name, or an unmatched ingredient that
	// happens to share the exact same text) populates it for both.
	let estimate = kv ? await getCachedEstimate(entryName, kv) : null;
	if (!estimate) {
		if (!budget || budget.calls <= 0) return per100g;
		budget.calls--;
		estimate = await estimateNutritionWithAI(entryName, ai, kv);
	}
	if (!estimate) return per100g;

	const enriched = { ...per100g };
	for (const key of missingKeys) {
		const value = estimate[key];
		if (typeof value === 'number' && Number.isFinite(value)) enriched[key] = value;
	}
	return enriched;
}
