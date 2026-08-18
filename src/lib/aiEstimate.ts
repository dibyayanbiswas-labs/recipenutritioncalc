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

/** Asks Cloudflare Workers AI to estimate per-100g nutrition for an ingredient the local database couldn't match. Never throws — returns null on any failure so callers can fall back cleanly. */
export async function estimateNutritionWithAI(ingredientName: string, ai: Ai): Promise<NutrientProfile | null> {
	try {
		const result = (await ai.run(ESTIMATE_MODEL, {
			messages: [{ role: 'user', content: buildPrompt(ingredientName) }],
			max_tokens: 256,
		})) as { response?: string };
		if (!result.response) return null;
		return parseResponse(result.response);
	} catch {
		return null;
	}
}
