import type { NutrientProfile } from './matchIngredient';

// A small, cheap instruct model — this is a short structured-JSON task, not the vision OCR path,
// so it doesn't need a large model. Re-check developers.cloudflare.com/workers-ai/models/ if this
// ever needs swapping; the catalog moves.
const ESTIMATE_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const CORE_KEYS = ['kcal', 'protein_g', 'fat_g', 'satFat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg'] as const;

function buildPrompt(ingredientName: string): string {
	return [
		'You are a nutrition database. Given a food ingredient name, respond with ONLY a JSON object',
		'(no markdown, no explanation, no code fences) containing your best estimate of its nutrition',
		'per 100 grams, with exactly these keys: kcal, protein_g, fat_g, satFat_g, carbs_g, fiber_g,',
		'sugar_g, sodium_mg. All values must be plain numbers (not strings).',
		'',
		`Ingredient: ${ingredientName}`,
	].join('\n');
}

function parseResponse(text: string): NutrientProfile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			parsed = JSON.parse(match[0]);
		} catch {
			return null;
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
			max_tokens: 256,
		})) as { response?: string };
		if (!result.response) return null;
		const profile = parseResponse(result.response);
		if (profile && kv) await cacheEstimate(ingredientName, kv, profile);
		return profile;
	} catch {
		return null;
	}
}
