import dailyValuesData from '../data/dailyValues.json';
import type { NutrientProfile } from './matchIngredient';

export const DAILY_VALUES = dailyValuesData as Record<string, number>;

export const NUTRIENT_KEYS = Object.keys(DAILY_VALUES) as (keyof NutrientProfile)[];

export interface HealthScore {
	score: number;
	rationale: string[];
}

export function emptyProfile(): NutrientProfile {
	const p = {} as NutrientProfile;
	for (const key of NUTRIENT_KEYS) p[key] = 0;
	return p;
}

export function scaleProfile(per100g: NutrientProfile, grams: number): NutrientProfile {
	const result = emptyProfile();
	const factor = grams / 100;
	for (const key of NUTRIENT_KEYS) {
		result[key] = Math.round((per100g[key] ?? 0) * factor * 100) / 100;
	}
	return result;
}

export function addProfiles(a: NutrientProfile, b: NutrientProfile): NutrientProfile {
	const result = emptyProfile();
	for (const key of NUTRIENT_KEYS) {
		result[key] = Math.round(((a[key] ?? 0) + (b[key] ?? 0)) * 100) / 100;
	}
	return result;
}

export function divideProfile(a: NutrientProfile, divisor: number): NutrientProfile {
	const result = emptyProfile();
	for (const key of NUTRIENT_KEYS) {
		result[key] = Math.round(((a[key] ?? 0) / divisor) * 100) / 100;
	}
	return result;
}

export function computeDailyValuePercent(perServing: NutrientProfile): Record<string, number> {
	const dailyValuePercent: Record<string, number> = {};
	for (const key of NUTRIENT_KEYS) {
		const dv = DAILY_VALUES[key];
		dailyValuePercent[key] = dv ? Math.round(((perServing[key] ?? 0) / dv) * 1000) / 10 : 0;
	}
	return dailyValuePercent;
}

// Graduated %DV bands rather than one all-or-nothing cutoff, so the score can move smoothly across
// its full range instead of being capped. The bands extend the FDA Nutrition Facts convention that
// <=5% DV is "low" and >=20% DV is "high" (21 CFR 101.9) with two extra steps on each side, the same
// banding technique Nutri-Score uses for its own negative/positive points — so a recipe that's
// genuinely low across sugar/sodium/sat-fat AND rich in fiber/protein can actually reach 9-10, and one
// that's extreme on a bad nutrient can actually reach 1-2, instead of every recipe being squeezed into
// a 4-7 band by a formula that only ever moves by 1 point in each direction.
const BAD_NUTRIENT_BANDS: { maxDV: number; penalty: number }[] = [
	{ maxDV: 5, penalty: 0 },
	{ maxDV: 10, penalty: 1 },
	{ maxDV: 20, penalty: 2 },
	{ maxDV: 35, penalty: 3 },
	{ maxDV: Infinity, penalty: 4 },
];
const GOOD_NUTRIENT_BANDS: { maxDV: number; bonus: number }[] = [
	{ maxDV: 5, bonus: 0 },
	{ maxDV: 10, bonus: 1 },
	{ maxDV: 20, bonus: 2 },
	{ maxDV: 35, bonus: 3 },
	{ maxDV: Infinity, bonus: 4 },
];

function bandFor<T extends { maxDV: number }>(dv: number, bands: T[]): T {
	return bands.find((b) => dv <= b.maxDV) ?? bands[bands.length - 1];
}

export function computeHealthScore(perServing: NutrientProfile): HealthScore {
	let score = 5;
	const rationale: string[] = [];

	const sugarDV = ((perServing.sugar_g ?? 0) / DAILY_VALUES.sugar_g) * 100;
	const sodiumDV = ((perServing.sodium_mg ?? 0) / DAILY_VALUES.sodium_mg) * 100;
	const satFatDV = ((perServing.satFat_g ?? 0) / DAILY_VALUES.satFat_g) * 100;
	const fiberDV = ((perServing.fiber_g ?? 0) / DAILY_VALUES.fiber_g) * 100;
	const proteinDV = ((perServing.protein_g ?? 0) / DAILY_VALUES.protein_g) * 100;

	const sugarPenalty = bandFor(sugarDV, BAD_NUTRIENT_BANDS).penalty;
	if (sugarPenalty > 0) {
		score -= sugarPenalty;
		rationale.push(sugarPenalty >= 3 ? 'Very high added/total sugar per serving' : 'High added/total sugar per serving');
	}
	const sodiumPenalty = bandFor(sodiumDV, BAD_NUTRIENT_BANDS).penalty;
	if (sodiumPenalty > 0) {
		score -= sodiumPenalty;
		rationale.push(sodiumPenalty >= 3 ? 'Very high sodium per serving' : 'High sodium per serving');
	}
	const satFatPenalty = bandFor(satFatDV, BAD_NUTRIENT_BANDS).penalty;
	if (satFatPenalty > 0) {
		score -= satFatPenalty;
		rationale.push(satFatPenalty >= 3 ? 'Very high saturated fat per serving' : 'High saturated fat per serving');
	}
	const fiberBonus = bandFor(fiberDV, GOOD_NUTRIENT_BANDS).bonus;
	if (fiberBonus > 0) {
		score += fiberBonus;
		rationale.push(fiberBonus >= 3 ? 'Excellent source of fiber' : 'Good source of fiber');
	}
	const proteinBonus = bandFor(proteinDV, GOOD_NUTRIENT_BANDS).bonus;
	if (proteinBonus > 0) {
		score += proteinBonus;
		rationale.push(proteinBonus >= 3 ? 'Excellent source of protein' : 'Good source of protein');
	}

	score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));
	if (rationale.length === 0) rationale.push('Balanced macro profile relative to daily values');

	return { score, rationale };
}

/** Recomputes per-serving figures from fixed recipe totals and a new serving count — the same math
 * `buildNutritionResult` uses server-side, kept here so the client can live-update without re-running
 * ingredient matching. */
export function recomputeForServings(
	totals: NutrientProfile,
	servings: number,
): { servings: number; perServing: NutrientProfile; dailyValuePercent: Record<string, number>; healthScore: HealthScore } {
	const safeServings = servings > 0 ? servings : 1;
	const perServing = divideProfile(totals, safeServings);
	return {
		servings: safeServings,
		perServing,
		dailyValuePercent: computeDailyValuePercent(perServing),
		healthScore: computeHealthScore(perServing),
	};
}
