import ingredientsUS from '../data/ingredients.json';
import ingredientsUK from '../data/ingredients.uk.json';
import ingredientsAU from '../data/ingredients.au.json';
import ingredientsCA from '../data/ingredients.ca.json';
import ingredientsIN from '../data/ingredients.in.json';

export interface NutrientProfile {
	kcal: number;
	protein_g: number;
	fat_g: number;
	satFat_g: number;
	carbs_g: number;
	fiber_g: number;
	sugar_g: number;
	sodium_mg: number;
	vitaminA_mcg?: number;
	vitaminC_mg?: number;
	vitaminD_mcg?: number;
	vitaminE_mg?: number;
	vitaminK_mcg?: number;
	thiamin_mg?: number;
	riboflavin_mg?: number;
	niacin_mg?: number;
	vitaminB6_mg?: number;
	folate_mcg?: number;
	vitaminB12_mcg?: number;
	calcium_mg?: number;
	iron_mg?: number;
	magnesium_mg?: number;
	phosphorus_mg?: number;
	potassium_mg?: number;
	zinc_mg?: number;
	copper_mg?: number;
	manganese_mg?: number;
	selenium_mcg?: number;
	cholesterol_mg?: number;
}

/** Food composition database a region's data was sourced from. */
export type RegionCode = 'US' | 'UK' | 'AU' | 'CA' | 'IN';

export const REGIONS: { code: RegionCode; label: string; source: string }[] = [
	{ code: 'US', label: 'United States', source: 'USDA FoodData Central' },
	{ code: 'UK', label: 'United Kingdom', source: 'McCance & Widdowson / CoFID' },
	{ code: 'AU', label: 'Australia', source: 'Australian Food Composition Database' },
	{ code: 'CA', label: 'Canada', source: 'Canadian Nutrient File' },
	{ code: 'IN', label: 'India', source: 'Indian Nutrient Databank (from IFCT 2017)' },
];

export interface IngredientEntry {
	name: string;
	aliases: string[];
	per100g: NutrientProfile;
	region: RegionCode;
	gPerCup?: number;
	avgUnitWeightG?: number;
	allergens?: string[];
}

export const INGREDIENTS = [
	...(ingredientsUS as IngredientEntry[]),
	...(ingredientsUK as IngredientEntry[]),
	...(ingredientsAU as IngredientEntry[]),
	...(ingredientsCA as IngredientEntry[]),
	...(ingredientsIN as IngredientEntry[]),
];

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface IngredientMatch {
	entry: IngredientEntry;
	confidence: MatchConfidence;
	/** Fraction of the query's tokens found in the matched entry's canonical name (0-1). */
	score: number;
	/** True when another near-equally-scored candidate has a meaningfully different nutrient
	 * profile — e.g. "cheese" scores an equally good match against cheddar, swiss, and cottage
	 * cheese, whose calorie counts differ by 4x. Picking one over the others would be a guess,
	 * so callers should surface this for user review rather than silently trusting the top pick. */
	ambiguous: boolean;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'fresh', 'large', 'small', 'medium']);
const COOKED_STATE_WORDS = new Set([
	'cooked',
	'baked',
	'roasted',
	'grilled',
	'fried',
	'boiled',
	'steamed',
	'braised',
	'broiled',
	'sauteed',
	'poached',
	'smoked',
	'stewed',
	'simmered',
	'casseroled',
	'seared',
	'charred',
	'rotisserie',
]);

/** Very light suffix stemming so "sugars"/"tomatoes"/"onions" match their singular query forms. */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
	if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
	if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
	return word;
}

/** Ordered, de-duplicated (first occurrence kept) token list — position matters for scoring. */
function tokenizeOrdered(s: string): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const raw of s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
		if (raw.length === 0 || STOP_WORDS.has(raw)) continue;
		const t = stem(raw);
		if (!seen.has(t)) {
			seen.add(t);
			ordered.push(t);
		}
	}
	return ordered;
}

function tokenize(s: string): Set<string> {
	return new Set(tokenizeOrdered(s));
}

// Species/type substitutions that are technically correct token matches but almost never what a
// recipe means by the plain ingredient name (e.g. "milk" defaulting to "milk, sheep, fluid").
// Penalized only when the query itself doesn't ask for them.
const UNCOMMON_VARIANT_WORDS = new Set([
	'sheep',
	'goat',
	'human',
	'buffalo',
	'mare',
	'donkey',
	'reindeer',
	'meatless',
	'vegetarian',
	'vegan',
	'black', // only demoted when the query itself doesn't say "black" (see the exemption below) —
	// otherwise a plain "rice"/"pepper" query lands on the uncommon black-rice/variety entry purely
	// because its qualifier chain happens to be shorter than the everyday white/standard version.
]);
// A recipe naming a plain ingredient almost always means its everyday fresh/liquid form, not a
// shelf-stable processed variant — penalized only when the query doesn't ask for that form.
const PROCESSED_FORM_WORDS = new Set(['dried', 'dry', 'powder', 'condensed', 'imitation', 'concentrate', 'dehydrated']);

// --- Inverted index, built once per Worker isolate (amortized across requests, not per-request cost) ---
// Scoring always happens against an entry's full canonical NAME (never a short alias) — a short
// alias like "oil" or "spices" would otherwise win matches purely by having few tokens to penalize,
// regardless of relevance. Aliases still feed the index so genuine synonyms remain findable.
const entryNameTokensOrdered: string[][] = INGREDIENTS.map((e) => tokenizeOrdered(e.name));
const entryNameTokens: Set<string>[] = entryNameTokensOrdered.map((t) => new Set(t));
// USDA names are usually "PrimaryIngredient, qualifier, qualifier, ..." (e.g. "Chicken, broiler or
// fryers, breast, raw") — whether the query fully explains that FIRST segment, the food's actual head
// noun, as opposed to a composite food that merely mentions the word later (e.g. "Bread, egg" for a
// query of "egg"), is a much stronger relevance signal than raw whole-name token overlap. But a
// second naming convention puts a broad category label first instead ("Spices, cinnamon, ground";
// "Nuts, almonds, raw") — for those, segment 2 carries the real identity and segment 1 is noise.
// Kept intentionally small and conservative: each entry here was verified against real data, since
// this pattern doesn't hold universally (e.g. "Crackers, milk" is milk-FLAVORED crackers, not a
// "crackers" category label followed by the real identity).
// 'grains' added for CNF (Canadian Nutrient File), which consistently uses the same category-prefix
// convention for its staple grain entries (e.g. "Grains, wheat flour, white, all purpose, bleached";
// "Grains, rice, brown, medium-grain, dry") — verified against the bundled CNF data.
const CATEGORY_PREFIX_DENYLIST = new Set(['spices', 'nuts', 'seeds', 'grains']);
const entryPrimaryTokens: Set<string>[] = INGREDIENTS.map((e) => {
	const segments = e.name.split(',');
	const first = segments[0].trim();
	if (segments.length > 1 && CATEGORY_PREFIX_DENYLIST.has(first)) return tokenize(segments[1]);
	return tokenize(first);
});
const invertedIndex = new Map<string, number[]>(); // token -> entry indices

for (let entryIndex = 0; entryIndex < INGREDIENTS.length; entryIndex++) {
	const allTokens = new Set(entryNameTokens[entryIndex]);
	for (const alias of INGREDIENTS[entryIndex].aliases) {
		for (const t of tokenize(alias)) allTokens.add(t);
	}
	for (const token of allTokens) {
		let list = invertedIndex.get(token);
		if (!list) {
			list = [];
			invertedIndex.set(token, list);
		}
		list.push(entryIndex);
	}
}

const EXTRA_TOKEN_PENALTY = 0.08;
const PRIMARY_MATCH_BONUS = 0.5;
const POSITION_BONUS_WEIGHT = 0.15;
const UNCOMMON_VARIANT_PENALTY = 0.15;
// Large enough to win out over a shorter/terser name from a different region for the same food
// (regional entries often carry more qualifiers than a source's own single best-known name would),
// but still well under PRIMARY_MATCH_BONUS/typical coverage gaps, so it never promotes an outright
// worse or unrelated match just for being in the requested region.
const REGION_MATCH_BONUS = 0.3;
// How close a runner-up's rankScore must be to the winner's to be considered "tied" for ambiguity
// purposes. Deliberately tight — real variety ties (e.g. every "Cheese, <variety>" entry) land at
// the *exact* same score, so this only needs to cover floating-point/position-bonus noise, not a
// wide band that would also sweep in genuinely lower-ranked candidates.
const AMBIGUITY_SCORE_MARGIN = 0.05;
// Two candidates this far apart in kcal/100g are different enough foods that picking the wrong one
// would meaningfully skew the result — the bar for actually flagging a near-tie as ambiguous.
const AMBIGUITY_KCAL_SPREAD = 40;

/** Matches a parsed ingredient name against the bundled nutrition database via an inverted-index lookup + query-coverage scoring.
 * `region`, when given, nudges scoring toward that region's food composition data without excluding the rest — a recipe's
 * ingredients may still fall back to another region's entry when the preferred region has no reasonable match. */
export function matchIngredient(name: string, region?: RegionCode): IngredientMatch | null {
	const queryTokens = tokenize(name);
	if (queryTokens.size === 0) return null;

	const queryHasCookedWord = [...queryTokens].some((t) => COOKED_STATE_WORDS.has(t));

	// Gather only candidates that share at least one token with the query — avoids scanning
	// all ~8000 entries per ingredient line, which matters under Workers' CPU-time limits.
	const candidateEntryIndices = new Set<number>();
	for (const token of queryTokens) {
		const list = invertedIndex.get(token);
		if (list) for (const i of list) candidateEntryIndices.add(i);
	}
	if (candidateEntryIndices.size === 0) return null;

	let bestEntryIndex = -1;
	let bestRankScore = -Infinity;
	let bestCoverage = 0;
	let bestSignature = '';
	// Best rankScore + representative kcal per distinct name-token signature — collapses the same
	// food listed by multiple regional databases (which commonly differ a little in kcal purely from
	// source methodology) into one candidate, so cross-region duplication alone never reads as ambiguity.
	const bestBySignature = new Map<string, { rankScore: number; kcal: number }>();

	for (const entryIndex of candidateEntryIndices) {
		const nameTokens = entryNameTokens[entryIndex];
		let intersection = 0;
		for (const t of queryTokens) if (nameTokens.has(t)) intersection++;
		const coverage = intersection / queryTokens.size;

		const extraTokens = nameTokens.size - intersection;
		const hasCookedWord = [...nameTokens].some((t) => COOKED_STATE_WORDS.has(t));
		const hasRawWord = nameTokens.has('raw');
		const hasUncommonVariantWord = [...nameTokens].some((t) => UNCOMMON_VARIANT_WORDS.has(t));
		const hasProcessedFormWord = [...nameTokens].some((t) => PROCESSED_FORM_WORDS.has(t));

		const isOffType =
			(hasCookedWord && !queryHasCookedWord) ||
			(hasUncommonVariantWord && ![...queryTokens].some((t) => UNCOMMON_VARIANT_WORDS.has(t))) ||
			(hasProcessedFormWord && ![...queryTokens].some((t) => PROCESSED_FORM_WORDS.has(t)));

		const primaryTokens = entryPrimaryTokens[entryIndex];
		let primaryIntersection = 0;
		for (const t of primaryTokens) if (queryTokens.has(t)) primaryIntersection++;
		const primaryPrecision = primaryTokens.size > 0 ? primaryIntersection / primaryTokens.size : 0;

		// Reward query tokens found EARLY in the name over ones found deep in a qualifier chain —
		// disambiguates e.g. "Oil, olive, salad or cooking" (olive at position 1) from "Oil, corn,
		// peanut, and olive" (olive mentioned last, as a minor part of a blend), which otherwise tie.
		const orderedTokens = entryNameTokensOrdered[entryIndex];
		let positionScore = 0;
		for (const t of queryTokens) {
			const pos = orderedTokens.indexOf(t);
			if (pos !== -1) positionScore += 1 / (1 + pos);
		}
		const positionBonus = (positionScore / queryTokens.size) * POSITION_BONUS_WEIGHT;

		// sqrt rather than linear: a long chain of nutrition-label-style qualifiers ("with added
		// vitamin d", "3.25% milkfat") shouldn't be punished much harder than a couple of qualifiers —
		// what matters most is whether the food's actual identity (primaryPrecision) is right.
		let rankScore =
			coverage - EXTRA_TOKEN_PENALTY * Math.sqrt(extraTokens) + PRIMARY_MATCH_BONUS * primaryPrecision + positionBonus;
		if (hasCookedWord && !queryHasCookedWord) rankScore -= 0.05;
		if (hasRawWord) rankScore += 0.02;
		if (hasUncommonVariantWord && ![...queryTokens].some((t) => UNCOMMON_VARIANT_WORDS.has(t))) {
			rankScore -= UNCOMMON_VARIANT_PENALTY;
		}
		if (hasProcessedFormWord && ![...queryTokens].some((t) => PROCESSED_FORM_WORDS.has(t))) {
			rankScore -= UNCOMMON_VARIANT_PENALTY;
		}
		if (region && INGREDIENTS[entryIndex].region === region) {
			rankScore += REGION_MATCH_BONUS;
		}

		const signature = [...nameTokens].sort().join('|');
		if (!isOffType) {
			const existing = bestBySignature.get(signature);
			if (!existing || rankScore > existing.rankScore) {
				bestBySignature.set(signature, { rankScore, kcal: INGREDIENTS[entryIndex].per100g.kcal });
			}
		}
		if (rankScore > bestRankScore) {
			bestRankScore = rankScore;
			bestEntryIndex = entryIndex;
			bestCoverage = coverage;
			bestSignature = signature;
		}
	}

	if (bestEntryIndex === -1) return null;

	const confidence: MatchConfidence = bestCoverage >= 0.9 ? 'high' : bestCoverage >= 0.5 ? 'medium' : 'low';

	// A near-tied runner-up only matters if picking it instead would actually change the nutrition
	// result — e.g. picking cheddar over swiss cheese matters, picking one region's "chicken breast,
	// raw" over another's essentially doesn't. Comparing best-per-signature (rather than every raw
	// candidate) keeps that same-food-different-region case from reading as a tie in the first place.
	const bestKcal = INGREDIENTS[bestEntryIndex].per100g.kcal;
	let ambiguous = false;
	for (const [signature, candidate] of bestBySignature) {
		if (signature === bestSignature) continue;
		if (bestRankScore - candidate.rankScore > AMBIGUITY_SCORE_MARGIN) continue;
		if (Math.abs(candidate.kcal - bestKcal) > AMBIGUITY_KCAL_SPREAD) {
			ambiguous = true;
			break;
		}
	}

	return { entry: INGREDIENTS[bestEntryIndex], confidence, score: bestCoverage, ambiguous };
}
