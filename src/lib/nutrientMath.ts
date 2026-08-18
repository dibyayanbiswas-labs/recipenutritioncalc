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

export function computeHealthScore(perServing: NutrientProfile): HealthScore {
	let score = 5;
	const rationale: string[] = [];

	const sugarDV = ((perServing.sugar_g ?? 0) / DAILY_VALUES.sugar_g) * 100;
	const sodiumDV = ((perServing.sodium_mg ?? 0) / DAILY_VALUES.sodium_mg) * 100;
	const satFatDV = ((perServing.satFat_g ?? 0) / DAILY_VALUES.satFat_g) * 100;
	const fiberDV = ((perServing.fiber_g ?? 0) / DAILY_VALUES.fiber_g) * 100;
	const proteinDV = ((perServing.protein_g ?? 0) / DAILY_VALUES.protein_g) * 100;

	if (sugarDV > 20) {
		score -= 1;
		rationale.push('High added/total sugar per serving');
	}
	if (sodiumDV > 20) {
		score -= 1;
		rationale.push('High sodium per serving');
	}
	if (satFatDV > 20) {
		score -= 1;
		rationale.push('High saturated fat per serving');
	}
	if (fiberDV > 15) {
		score += 1;
		rationale.push('Good source of fiber');
	}
	if (proteinDV > 20) {
		score += 1;
		rationale.push('Good source of protein');
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
