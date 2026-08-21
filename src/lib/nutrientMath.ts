import dailyValuesData from '../data/dailyValues.json';
import { INGREDIENTS, type NutrientProfile } from './matchIngredient';

export const DAILY_VALUES = dailyValuesData as Record<string, number>;

export const NUTRIENT_KEYS = Object.keys(DAILY_VALUES) as (keyof NutrientProfile)[];

export interface HealthScore {
	score: number;
	rationale: string[];
}

// A nutrient whose source data is present in only a handful of the bundled database's ~40,000 entries
// (across all 5 regions) isn't a real "0% Daily Value" for whatever food that "0%" is attached to —
// it's an absence of data being displayed as if it were a measurement. vitaminE_mg is the extreme case
// (essentially unpopulated database-wide, so every food on the site would otherwise read as
// containing literally none of it, which can't be true), but computed generically here rather than
// hardcoded so this list self-corrects if the underlying data ever improves (e.g. via
// enrichMissingNutrients backfilling real entries over time) instead of needing to be hand-maintained.
// 5% is deliberately low — anything with genuinely partial-but-real coverage (most vitamins/minerals
// are 20%+) should still show its real, if imperfect, number rather than being hidden.
const LOW_COVERAGE_THRESHOLD = 0.05;

// Coverage is measured against the US entries specifically, not the full combined 5-region set —
// matchIngredient(name, 'US') biases every lookup toward US entries when one's available, so a food
// blending all 5 regions together can look reasonably covered on average while what a US-biased match
// actually lands on is nearly empty (this is exactly what happened with vitaminE_mg: ~0% in the US
// data alone, but ~51% once UK/AU/CA/IN — which real matches mostly don't land on — are averaged in).
function computeLowCoverageNutrientKeys(): Set<keyof NutrientProfile> {
	const keys = NUTRIENT_KEYS.filter((k) => k !== 'kcal');
	const low = new Set<keyof NutrientProfile>();
	const usEntries = INGREDIENTS.filter((e) => e.region === 'US');
	if (usEntries.length === 0) return low;
	for (const key of keys) {
		const present = usEntries.reduce((count, e) => count + (key in e.per100g ? 1 : 0), 0);
		if (present / usEntries.length < LOW_COVERAGE_THRESHOLD) low.add(key);
	}
	return low;
}

/** Nutrients where the bundled database has essentially no real data at all — a UI showing one of
 * these should say so rather than display a confident-looking "0%" (see the comment above). Computed
 * once per Worker isolate, not per-request. */
export const LOW_COVERAGE_NUTRIENT_KEYS: Set<keyof NutrientProfile> = computeLowCoverageNutrientKeys();

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
// Label wording mirrors GOOD_NUTRIENT_BANDS below rather than the FDA's raw ≥20%=high cutoff alone:
// the 5-10% tier still moves the score (a small, silent nudge) but doesn't get a verbal claim, the
// same way a nutrient at 5-10% DV earns a bonus point without being called a "Good source of" — a
// nutrient just above the "low" floor shouldn't read as a called-out concern on one side of the score
// while being treated as unremarkable on the other. First real claim ("Moderately high") starts at the
// same 10% DV threshold FDA's own "good source" claim requires (21 CFR 101.54); "High" at 20%+ matches
// FDA's own Nutrition Facts "high" cutoff (21 CFR 101.9).
const BAD_NUTRIENT_BANDS: { maxDV: number; penalty: number; label: string | null }[] = [
	{ maxDV: 5, penalty: 0, label: null },
	{ maxDV: 10, penalty: 1, label: null },
	{ maxDV: 20, penalty: 2, label: 'Moderately high' },
	{ maxDV: 35, penalty: 3, label: 'High' },
	{ maxDV: Infinity, penalty: 4, label: 'Very high' },
];
// "Good source of" / "Excellent source of" mirror the FDA's own nutrient-content-claim thresholds
// (21 CFR 101.54: "good source" requires 10-19% DV, "high"/"excellent source" requires >=20% DV) —
// the 5-10% tier still earns its bonus point but doesn't get a label, since FDA rules wouldn't let a
// real product call that a "good source" claim either.
const GOOD_NUTRIENT_BANDS: { maxDV: number; bonus: number; label: string | null }[] = [
	{ maxDV: 5, bonus: 0, label: null },
	{ maxDV: 10, bonus: 1, label: null },
	{ maxDV: 20, bonus: 2, label: 'Good source of' },
	{ maxDV: 35, bonus: 3, label: 'Excellent source of' },
	{ maxDV: Infinity, bonus: 4, label: 'Excellent source of' },
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

	const sugarBand = bandFor(sugarDV, BAD_NUTRIENT_BANDS);
	if (sugarBand.penalty > 0) {
		score -= sugarBand.penalty;
		if (sugarBand.label) rationale.push(`${sugarBand.label} added/total sugar per serving`);
	}
	const sodiumBand = bandFor(sodiumDV, BAD_NUTRIENT_BANDS);
	if (sodiumBand.penalty > 0) {
		score -= sodiumBand.penalty;
		if (sodiumBand.label) rationale.push(`${sodiumBand.label} sodium per serving`);
	}
	const satFatBand = bandFor(satFatDV, BAD_NUTRIENT_BANDS);
	if (satFatBand.penalty > 0) {
		score -= satFatBand.penalty;
		if (satFatBand.label) rationale.push(`${satFatBand.label} saturated fat per serving`);
	}
	const fiberBand = bandFor(fiberDV, GOOD_NUTRIENT_BANDS);
	if (fiberBand.bonus > 0) {
		score += fiberBand.bonus;
		if (fiberBand.label) rationale.push(`${fiberBand.label} fiber`);
	}
	const proteinBand = bandFor(proteinDV, GOOD_NUTRIENT_BANDS);
	if (proteinBand.bonus > 0) {
		score += proteinBand.bonus;
		if (proteinBand.label) rationale.push(`${proteinBand.label} protein`);
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
