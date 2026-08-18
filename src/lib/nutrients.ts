import { matchIngredient, type MatchConfidence, type NutrientProfile } from './matchIngredient';
import { parseIngredients, type ParsedIngredientLine } from './parseIngredients';
import { resolveGrams, type ConversionSource } from './unitConversion';
import { unionAllergens } from './allergens';
import { estimateNutritionWithAI } from './aiEstimate';
import {
	DAILY_VALUES,
	type HealthScore,
	addProfiles,
	computeDailyValuePercent,
	computeHealthScore,
	divideProfile,
	emptyProfile,
	scaleProfile,
} from './nutrientMath';

// Safety valve against a pathological input (e.g. a huge pasted blob of unmatchable lines)
// triggering dozens of parallel Workers AI calls in a single request.
const MAX_AI_FALLBACK_CALLS = 15;

export { DAILY_VALUES, type HealthScore };

export interface IngredientResult {
	raw: string;
	ingredientName: string;
	quantity: number | null;
	quantityRange: [number, number] | null;
	unit: string | null;
	grams: number;
	conversionSource: ConversionSource;
	matchedName: string | null;
	matchConfidence: MatchConfidence | 'none' | 'ai-estimated';
	nutrients: NutrientProfile;
	isOptionalOrToTaste: boolean;
	allergens: string[];
}

export interface NutritionResult {
	id: string;
	title: string;
	servings: number;
	ingredients: IngredientResult[];
	totals: NutrientProfile;
	perServing: NutrientProfile;
	dailyValuePercent: Record<string, number>;
	allergens: string[];
	healthScore: HealthScore;
	sourceUrl: string | null;
	createdAt: number;
}

/** Resolves each parsed ingredient line into a nutrient contribution, using the bundled ingredient database, with a Workers AI estimate as a last-resort fallback for lines that don't match anything at all. */
export async function analyzeIngredientLines(lines: ParsedIngredientLine[], ai?: Ai): Promise<IngredientResult[]> {
	let aiCallsRemaining = MAX_AI_FALLBACK_CALLS;

	return Promise.all(
		lines.map(async (line) => {
			const match = matchIngredient(line.ingredientName);
			const entry = match?.entry ?? null;

			let aiProfile: NutrientProfile | null = null;
			let matchConfidence: MatchConfidence | 'none' | 'ai-estimated' = match?.confidence ?? 'none';
			if (!entry && ai && !line.isOptionalOrToTaste && aiCallsRemaining > 0) {
				aiCallsRemaining--;
				aiProfile = await estimateNutritionWithAI(line.ingredientName, ai);
				if (aiProfile) matchConfidence = 'ai-estimated';
			}

			const { grams, conversionSource } = resolveGrams(line, entry);
			const nutrients = entry ? scaleProfile(entry.per100g, grams) : aiProfile ? scaleProfile(aiProfile, grams) : emptyProfile();

			return {
				raw: line.raw,
				ingredientName: line.ingredientName,
				quantity: line.quantity,
				quantityRange: line.quantityRange,
				unit: line.unit,
				grams: Math.round(grams * 10) / 10,
				conversionSource,
				matchedName: entry?.name ?? null,
				matchConfidence,
				nutrients,
				isOptionalOrToTaste: line.isOptionalOrToTaste,
				allergens: entry?.allergens ?? [],
			};
		}),
	);
}

/** Aggregates per-ingredient results into recipe totals, per-serving values, %DV, allergens, and a health score. */
export function buildNutritionResult(params: {
	id: string;
	title: string;
	servings: number;
	ingredients: IngredientResult[];
	sourceUrl?: string | null;
	createdAt: number;
}): NutritionResult {
	const { id, title, servings, ingredients, sourceUrl = null, createdAt } = params;
	const safeServings = servings > 0 ? servings : 1;

	const totals = ingredients.reduce((acc, ing) => addProfiles(acc, ing.nutrients), emptyProfile());
	const perServing = divideProfile(totals, safeServings);
	const dailyValuePercent = computeDailyValuePercent(perServing);

	return {
		id,
		title,
		servings: safeServings,
		ingredients,
		totals,
		perServing,
		dailyValuePercent,
		allergens: unionAllergens(ingredients.map((i) => i.allergens)),
		healthScore: computeHealthScore(perServing),
		sourceUrl,
		createdAt,
	};
}

/** End-to-end: freeform text -> full NutritionResult. */
export async function analyzeRecipeText(params: {
	id: string;
	title: string;
	text: string;
	servings: number;
	sourceUrl?: string | null;
	createdAt: number;
	ai?: Ai;
}): Promise<NutritionResult> {
	const { ai, ...rest } = params;
	const lines = parseIngredients(params.text);
	const ingredients = await analyzeIngredientLines(lines, ai);
	return buildNutritionResult({ ...rest, ingredients });
}
