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
	/** True when a comparably-good alternative match exists with a meaningfully different nutrient
	 * profile (e.g. "cheese" -> cheddar vs. swiss vs. cottage), so the top pick shouldn't be trusted
	 * without the user confirming which food was actually meant. */
	ambiguous: boolean;
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
	/** Set when the pasted ingredient text didn't match the expected "amount unit ingredient" format
	 * closely enough to trust — surfaced to the user as a non-blocking accuracy warning. */
	formatWarning: string | null;
}

/** Resolves each parsed ingredient line into a nutrient contribution, using the bundled ingredient database, with a Workers AI estimate as a last-resort fallback for lines that don't match anything at all. */
export async function analyzeIngredientLines(lines: ParsedIngredientLine[], ai?: Ai): Promise<IngredientResult[]> {
	let aiCallsRemaining = MAX_AI_FALLBACK_CALLS;

	return Promise.all(
		lines.map(async (line) => {
			// Defaults to 'US': the site's %DV table is US/USDA-based and there's no region picker in the
			// UI, so without this every match was scored across all 5 regional databases with no
			// preference — the shortest/sparsest name often won regardless of region (see matchIngredient's
			// REGION_MATCH_BONUS), which is how "pasta, cooked" could land on a Canadian corn-pasta entry.
			const match = matchIngredient(line.matchName, 'US');
			const entry = match?.entry ?? null;

			let aiProfile: NutrientProfile | null = null;
			let matchConfidence: MatchConfidence | 'none' | 'ai-estimated' = match?.confidence ?? 'none';
			if (!entry && ai && !line.isOptionalOrToTaste && aiCallsRemaining > 0) {
				aiCallsRemaining--;
				aiProfile = await estimateNutritionWithAI(line.matchName, ai);
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
				ambiguous: match?.ambiguous ?? false,
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
	formatWarning?: string | null;
}): NutritionResult {
	const { id, title, servings, ingredients, sourceUrl = null, createdAt, formatWarning = null } = params;
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
		formatWarning,
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
	formatWarning?: string | null;
}): Promise<NutritionResult> {
	const { ai, formatWarning, ...rest } = params;
	const lines = parseIngredients(params.text);
	const ingredients = await analyzeIngredientLines(lines, ai);
	return buildNutritionResult({ ...rest, ingredients, formatWarning });
}
