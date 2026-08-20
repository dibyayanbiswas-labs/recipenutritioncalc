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

// 'extra'/'virgin' added alongside the existing size/freshness words: "extra virgin olive oil" is one
// of the most common ingredients in any recipe database, but the only matching entry is named "oil,
// olive, salad or cooking" — without stripping these, the query's 4 tokens only ever cover 2 of the
// entry's 4 (0.5), landing just under MIN_MATCH_COVERAGE and silently routing a hugely common
// ingredient to the AI-estimate fallback instead of the accurate database entry.
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'fresh', 'large', 'small', 'medium', 'extra', 'virgin']);
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
	'microwaved',
]);

// The "-ies" -> "-y" rule below assumes the singular ends in a consonant + "y" (berry/berries,
// curry/curries) — wrong for a word that already ends in "i" (chili/chilies, chilli/chillies),
// where it produces a bogus "chily"/"chilli" mismatch. "green chilies" was matching "beet greens"
// for exactly this reason: "chilies" stemmed to a token nothing in the database has.
// "fries" (the noun, as in "french fries") stems to "fry" under the regular '-ies'->'-y' rule, but
// every matching entry in the source data spells it "french fried" (adjective) — "fried" is also a
// COOKED_STATE_WORDS literal, so this maps to that exact string rather than to "fry", keeping the
// existing cooked-word handling intact instead of introducing a third, disconnected token spelling.
const STEM_EXCEPTIONS: Record<string, string> = {
	chilies: 'chili',
	chillies: 'chilli',
	fries: 'fried',
	// "cookies" ends in "-ies" but its singular is "cookie", not the "-y" the regular rule below would
	// produce ("cooky") — without this, NAMED_DISH_WORDS' 'cookie' entry never actually matches
	// "Chocolate chip cookies", since the entry's real stemmed token is "cooky".
	cookies: 'cookie',
};

// A word ending in "-es" is ambiguous about how much to strip: most of the time the singular already
// ends in a silent "e" and the plural is just "+s" (cube/cubes, sauce/sauces, cheese/cheeses,
// apple/apples) — stripping only the trailing "s" recovers it. Only strip the full "es" for the
// genuine sibilant-plural pattern, where the singular has no trailing "e" at all: box/boxes,
// church/churches, dish/dishes, kiss/kisses, buzz/buzzes (all needing a doubled consonant or x/ch/sh
// immediately before "es" — that doubling is what distinguishes "kisses" from "houses"/"cheeses"), or
// a consonant + "o" (tomato/tomatoes, potato/potatoes). Blindly always stripping "es" (the previous
// behavior) silently turned "cubes" into "cub" and "apples" into "appl" — tokens nothing in the
// database has, since entries are tokenized the same way and mostly don't happen to collide on the
// wrong stem too.
const HARD_ES_ENDING = /(?:ches|shes|xes|zzes|sses)$/;
const CONSONANT_O_ES_ENDING = /[^aeiou]oes$/;

/** Very light suffix stemming so "sugars"/"tomatoes"/"onions" match their singular query forms. */
function stem(word: string): string {
	if (STEM_EXCEPTIONS[word]) return STEM_EXCEPTIONS[word];
	if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
	if (word.length > 4 && word.endsWith('es')) {
		if (HARD_ES_ENDING.test(word) || CONSONANT_O_ES_ENDING.test(word)) return word.slice(0, -2);
		return word.slice(0, -1);
	}
	if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
	return word;
}

/** Ordered, de-duplicated (first occurrence kept) token list — position matters for scoring. */
function tokenizeOrdered(s: string): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	// Normalize accented Latin letters ("jalapeño", "crème fraîche") to their plain-ASCII base
	// ("jalapeno", "creme fraiche") before the [^a-z0-9] strip below — otherwise that strip removes
	// the accent character entirely rather than folding it, breaking the word into unmatched pieces
	// (e.g. "jalapeño" -> "jalape"/"o") even though the database's entry is the plain-ASCII spelling.
	const normalized = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	for (const raw of normalized.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
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
	'black', // only demoted when the query itself doesn't say "black" (see the exemption below) —
	// otherwise a plain "rice"/"pepper" query lands on the uncommon black-rice/variety entry purely
	// because its qualifier chain happens to be shorter than the everyday white/standard version.
	// A bare "oil"/"vegetable oil" query means the everyday neutral cooking oil (canola/soybean,
	// ~7-15g satFat/100g), not one of these extreme-satFat tropical oils (palm ~49g, palm kernel
	// ~81.5g, coconut ~86.5g/100g) — but "vegetable oil, palm kernel" was winning anyway: its literal
	// "vegetable oil" prefix gives it full query coverage plus the region-match bonus, while the
	// correct plain "oil, vegetable, soybean, refined"-style entry has to compete on the same terms.
	// Demoted only when the query doesn't explicitly ask for that variant, same as sheep/goat milk.
	'palm',
	'kernel',
	'coconut',
]);
// Substitute-product words that need SUBSTITUTE_PRODUCT_PENALTY rather than UNCOMMON_VARIANT_PENALTY —
// split out from the set above because these particular substitutes are disproportionately likely to
// BE an entry's entire primary (pre-comma) segment ("bacon, meatless"; "mayonnaise, made with tofu";
// "bacon, turkey, ..."), which already wins PRIMARY_MATCH_BONUS (0.5) outright against a same-food
// entry like "pork, cured, bacon, unprepared" whose real identity sits in a later segment and gets no
// primary bonus at all. UNCOMMON_VARIANT_PENALTY (0.15) doesn't come close to closing a gap that size,
// so — like CONCENTRATE_WORDS/CONCENTRATE_PENALTY above — this needs a penalty large enough to actually
// flip the ranking, not just nudge it. Demoted only when the query doesn't explicitly ask for the
// substitute.
const SUBSTITUTE_PRODUCT_WORDS = new Set([
	'meatless',
	'vegetarian',
	'vegan',
	'turkey', // e.g. "bacon"/"sausage" defaulting to the turkey variant instead of the everyday
	// (usually pork) one — same species-substitute problem as sheep/goat milk above.
	// A bare "mayonnaise" query means the everyday egg-based condiment, not a tofu-based substitute —
	// same problem, just for a plant-based swap instead of an animal one.
	'tofu',
]);
const SUBSTITUTE_PRODUCT_PENALTY = 0.5;
// A recipe naming a plain ingredient almost always means its everyday fresh/liquid form, not a
// shelf-stable processed variant — penalized only when the query doesn't ask for that form.
const PROCESSED_FORM_WORDS = new Set([
	'dried',
	'dry',
	'powder',
	'condensed',
	'imitation',
	'concentrate',
	'dehydrated',
	'canned',
	'preserved',
	'pickled',
	'flavoured',
	'flavored',
]);
// A recipe naming a plain ingredient means the everyday, standard-sodium version — not a "reduced/low
// sodium" reformulation — but the reformulated product often has a shorter, terser name than the
// standard one (e.g. "milk, low sodium, fluid" vs. "milk, whole, 3.25% milkfat, with added vitamin d"),
// so it wins the qualifier-count race for a bare "milk"/"bacon" query despite being a specialty product
// with a wildly different sodium value (e.g. 3mg vs ~38mg sodium/100g for milk). Needs a penalty on the
// same order as CONCENTRATE_PENALTY, not UNCOMMON_VARIANT_PENALTY: the standard entry frequently also
// loses the primary-segment bonus to the specialty one (e.g. "bacon, pre-sliced, reduced/low sodium,
// ..." vs. "pork, cured, bacon, ..." — "bacon" IS the specialty entry's primary segment, but only a late
// qualifier in the standard USDA name), so a small nudge isn't enough to flip the ranking on its own.
const SODIUM_MODIFIER_WORDS = new Set(['sodium']);
const SODIUM_MODIFIER_PENALTY = 0.5;
// A recipe volume like "500ml beef stock" means the diluted, ready-to-use liquid, but a cube/granules
// entry is a concentrate meant to be DISSOLVED into that much liquid — scaling it as if it were the
// liquid itself overstates sodium by roughly the dilution factor (~30-40x for a bouillon cube). This
// needs a much larger penalty than PROCESSED_FORM_WORDS: a cube entry is often the ONLY same-food
// entry that contains every query word verbatim ("beef" + "stock"), so it wins on coverage alone even
// with the standard penalty applied — the concentration error here is an order of magnitude worse than
// a typical dried-vs-fresh gap, so it needs to be knocked out of contention outright, not just nudged.
const CONCENTRATE_WORDS = new Set(['cube', 'granules']);
const CONCENTRATE_PENALTY = 0.6;
// A short, specific named dish/product (e.g. "Spanish rice", "duchesse potatoes") can otherwise
// out-rank the plain everyday ingredient purely because it has fewer qualifier tokens to be
// penalized for, even though it's a completely different food (different prep, added ingredients,
// often much higher sodium/fat) — not a description of the plain ingredient. Penalized only when
// the query itself doesn't ask for that specific dish.
// 'toast' added because "french fries" ("fry"-stemmed) shares its "french" token with "French toast,
// frozen, ready-to-heat" — an unrelated breakfast bread — which then out-ranked every actual fries
// entry: those are all named "Potatoes, french fried, ..." in the source data (potato as the head
// noun, so they get no primary-segment bonus for a "french fries" query at all), so "french toast"'s
// primary-segment credit for sharing "french" was otherwise enough to win outright.
// 'cookie' (stemmed from "cookies") added as a general demotion for dish-named entries competing
// against a plain ingredient query. It alone isn't enough to fix "chocolate chips" specifically —
// that took adding a properly-named "chocolate chips, semisweet" entry (see ingredients.json) so the
// real ingredient scores its own PRIMARY_MATCH_BONUS instead of losing to whichever prepared dish
// (cookies, waffles, granola bars, ...) happens to have the fewest qualifier words that day — but it
// still helps in the general case where no such entry exists and the honest answer is "no match".
const NAMED_DISH_WORDS = new Set(['spanish', 'duchesse', 'toast', 'cookie']);

// Salt-type descriptors that don't correspond to a distinct database entry — there's only ever one
// "salt, table" entry, covering all of these culinarily-different-but-nutritionally-identical forms.
// Without stripping them, "kosher salt"/"sea salt" (2 query tokens, only "salt" itself present in the
// entry's 2-token name) land at exactly 0.5 coverage — just under MIN_MATCH_COVERAGE — and fall
// through to a much less accurate AI estimate for one of the most common savory recipe ingredients.
const SALT_DESCRIPTOR_WORDS = new Set(['kosher', 'sea', 'fine', 'coarse', 'flaky', 'flake', 'rock', 'iodized', 'himalayan', 'pink']);

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
// 'fish', 'game meat', 'crustaceans', 'mollusks' added after auditing USDA's own convention for those
// groups — e.g. "Fish, salmon, atlantic, wild, cooked, dry heat", "Crustaceans, shrimp, farm raised,
// raw" — where the actual food a recipe names ("salmon", "shrimp") is always segment 2, same as spices.
// 'soup' added for the same reason (400+ entries: "Soup, stock, beef, home-prepared", "Soup, black
// bean, canned, condensed") — without it, a query like "beef stock" got ZERO identity-match bonus for
// the one entry that's actually a beef stock, since its segment 1 is "soup" not "beef"/"stock", while
// unrelated raw beef cuts (segment 1 genuinely "beef") won the full bonus purely for starting with the
// right word — enough to outrank the correct stock entry even after penalizing off-type words.
// 'sauce' added for the same reason (140+ entries across regions: "Sauce, peanut, made from peanut
// butter, water, soy sauce"; "Sauce, barbecue, commercial"; "Sauce, teriyaki, ready-to-serve") — without
// it, a plain "soy sauce" query landed on "Sauce, peanut, ..." instead of any of the six real soy-sauce
// entries: that entry's segment 1 is just "sauce" (1 token, 100% primary-match precision against a query
// containing "sauce"), while the correct soy-sauce entries have no comma at all, so their whole 6-token
// name counts as the primary segment and only gets partial credit — enough for a nutritionally unrelated
// peanut sauce to outrank actual soy sauce.
const CATEGORY_PREFIX_DENYLIST = new Set(['spices', 'nuts', 'seeds', 'grains', 'fish', 'game meat', 'crustaceans', 'mollusks', 'soup', 'sauce']);
const entryPrimaryTokens: Set<string>[] = INGREDIENTS.map((e) => {
	const segments = e.name.split(',');
	// Lowercased before the denylist check: only the US (USDA) source consistently lowercases these
	// category prefixes ("spices, cinnamon, ground") — UK/AU/CA/IN entries capitalize them ("Spices,
	// cinnamon, ground"), so a case-sensitive check silently never matched for 4 of the 5 regions.
	const first = segments[0].trim();
	if (segments.length > 1 && CATEGORY_PREFIX_DENYLIST.has(first.toLowerCase())) return tokenize(segments[1]);
	return tokenize(first);
});
// Precomputed per-entry lowercased first segment — used for the bare-"pepper" tiebreak below.
const entryPrimaryCategory: string[] = INGREDIENTS.map((e) => e.name.split(',')[0].trim().toLowerCase());
const BARE_PEPPER_SPICE_BONUS = 0.3;
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
	if (queryTokens.has('salt')) {
		for (const w of SALT_DESCRIPTOR_WORDS) queryTokens.delete(w);
	}
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
		const hasNamedDishWord = [...nameTokens].some((t) => NAMED_DISH_WORDS.has(t));
		const hasConcentrateWord = [...nameTokens].some((t) => CONCENTRATE_WORDS.has(t));
		const queryHasConcentrateWord = [...queryTokens].some((t) => CONCENTRATE_WORDS.has(t));
		const hasSodiumModifierWord = [...nameTokens].some((t) => SODIUM_MODIFIER_WORDS.has(t));
		const queryHasSodiumModifierWord = [...queryTokens].some((t) => SODIUM_MODIFIER_WORDS.has(t));
		const hasSubstituteProductWord = [...nameTokens].some((t) => SUBSTITUTE_PRODUCT_WORDS.has(t));
		const queryHasSubstituteProductWord = [...queryTokens].some((t) => SUBSTITUTE_PRODUCT_WORDS.has(t));
		// Unlike "black rice" (genuinely uncommon — 'black' is rightly demoted for a plain "rice"
		// query), "black pepper" IS the plain, default sense of a bare "pepper" query — so the general
		// black-variant demotion below would otherwise fight the bare-pepper spice tiebreak just above,
		// leaving "spices, pepper, white" to win over "spices, pepper, black" for no good reason.
		const isBarePepperBlackException =
			queryTokens.size === 1 && queryTokens.has('pepper') && nameTokens.has('black') && entryPrimaryCategory[entryIndex] === 'spices';

		const isOffType =
			(hasCookedWord && !queryHasCookedWord) ||
			(hasUncommonVariantWord && !isBarePepperBlackException && ![...queryTokens].some((t) => UNCOMMON_VARIANT_WORDS.has(t))) ||
			(hasProcessedFormWord && ![...queryTokens].some((t) => PROCESSED_FORM_WORDS.has(t))) ||
			(hasNamedDishWord && ![...queryTokens].some((t) => NAMED_DISH_WORDS.has(t))) ||
			(hasConcentrateWord && !queryHasConcentrateWord) ||
			(hasSodiumModifierWord && !queryHasSodiumModifierWord) ||
			(hasSubstituteProductWord && !queryHasSubstituteProductWord);

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
		// Rewards an entry for being in *some* cooked state whenever the query names one too, even when
		// the exact words differ (query "sauteed"/"grilled"/"roasted" vs. an entry that literally says
		// "cooked") — without this, a cooked-state query gets no credit for matching cooked entries at
		// all, so a bare/plain entry with fewer qualifier words can out-rank the correctly-prepared one
		// purely on token count (e.g. "mushrooms sauteed" landing on "mushroom, oyster" instead of any
		// actually-cooked mushroom entry).
		if (hasCookedWord && queryHasCookedWord) rankScore += 0.1;
		if (hasRawWord) rankScore += 0.02;
		if (hasUncommonVariantWord && !isBarePepperBlackException && ![...queryTokens].some((t) => UNCOMMON_VARIANT_WORDS.has(t))) {
			rankScore -= UNCOMMON_VARIANT_PENALTY;
		}
		if (hasProcessedFormWord && ![...queryTokens].some((t) => PROCESSED_FORM_WORDS.has(t))) {
			rankScore -= UNCOMMON_VARIANT_PENALTY;
		}
		if (hasNamedDishWord && ![...queryTokens].some((t) => NAMED_DISH_WORDS.has(t))) {
			rankScore -= UNCOMMON_VARIANT_PENALTY;
		}
		// A bare, single-word "pepper" query — the common case after "salt and pepper" is split into
		// its two ingredients — is a well-known culinary default for black pepper (the spice), not a
		// bell/chili/jalapeno pepper (the vegetable). Both interpretations otherwise score identically
		// (perfect coverage either way), so without an explicit tiebreak "peppers, jalapeno, raw" won
		// purely because "peppers" alone as its primary segment gave it a full primary-match bonus,
		// while "spices, pepper, black"'s primary segment is "pepper, black" — only half-matched since
		// a bare query never says "black" either.
		if (queryTokens.size === 1 && queryTokens.has('pepper') && entryPrimaryCategory[entryIndex] === 'spices') {
			rankScore += BARE_PEPPER_SPICE_BONUS;
		}
		if (hasConcentrateWord && !queryHasConcentrateWord) {
			rankScore -= CONCENTRATE_PENALTY;
		}
		if (hasSodiumModifierWord && !queryHasSodiumModifierWord) {
			rankScore -= SODIUM_MODIFIER_PENALTY;
		}
		if (hasSubstituteProductWord && !queryHasSubstituteProductWord) {
			rankScore -= SUBSTITUTE_PRODUCT_PENALTY;
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

	// Below this, only a minority of the query's words are actually present in the candidate's name —
	// e.g. "kelp noodles" sharing just "noodles" with "chow mein noodles" (0.5 coverage), or "dragon
	// fruit chunks" sharing just "fruit" with "fruit syrup" (0.33). Returning a low-coverage guess here
	// used to present a wrong nutrition profile with a confident-looking label; returning null instead
	// routes the caller to the (KV-cached) AI-estimate fallback, which is more accurate for a genuinely
	// unmatched ingredient than a database entry that only superficially shares a word.
	const MIN_MATCH_COVERAGE = 0.51;
	if (bestEntryIndex === -1 || bestCoverage < MIN_MATCH_COVERAGE) return null;

	const confidence: MatchConfidence = bestCoverage >= 0.9 ? 'high' : 'medium';

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
