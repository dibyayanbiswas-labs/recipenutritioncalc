import { UNIT_TABLE } from './units';
import type { IngredientEntry } from './matchIngredient';
import type { ParsedIngredientLine } from './parseIngredients';

export type ConversionSource = 'ingredient-data' | 'estimated';

export interface GramResolution {
	grams: number;
	conversionSource: ConversionSource;
}

const WATER_G_PER_ML = 1;
const GENERIC_COUNT_WEIGHT_G = 100;
// A seasoning is never eaten "1 of" the way a countable produce item is ("1 onion" -> a whole
// onion), so falling through to GENERIC_COUNT_WEIGHT_G for one is never right — it means a bare,
// unitless line like "Salt & black pepper" (no "tsp"/"pinch" given) silently priced in 100g of
// ground pepper, enough to swing sodium/fat/fiber/protein and skew the health score. None of these
// entries carry an avgUnitWeightG in the source data (spices aren't sold "per piece"), so this has
// to be caught by name instead: every regional DB puts spices under a "Spices, ..." category prefix,
// and salt as a bare "Salt"/"Salt, table..." entry — checked case-insensitively since only the US
// source lowercases the prefix.
const SEASONING_DEFAULT_G = 1.5;
function isSeasoningEntry(entry: IngredientEntry): boolean {
	const firstSegment = entry.name.split(',')[0].trim().toLowerCase();
	return firstSegment === 'spices' || firstSegment === 'salt';
}

// Same problem as the seasoning case above, just for cooking oil: a bare, unitless "oil" line (e.g.
// scraped from a recipe that just lists "oil" for frying, with the amount left to the cook) has no
// count semantics either, but every regional DB prefixes fat/oil entries with an "Oil, ..." category
// name the same way it prefixes spices — so this is caught the same way. Defaulting to a full
// produce-item-sized 100g priced in ~880 kcal of pure fat for a recipe that never gave an amount,
// often dwarfing every other ingredient's contribution combined. ~1 tbsp is the common real-world
// "drizzle"/pan-frying amount.
const OIL_DEFAULT_G = 13.5;
function isOilEntry(entry: IngredientEntry): boolean {
	const firstSegment = entry.name.split(',')[0].trim().toLowerCase();
	return firstSegment === 'oil';
}

// A standard retail can (soup, beans, tomatoes, coconut milk, ...) runs ~400g/14-15oz regardless of
// what's in it — the can size is a property of the container, not the specific food, unlike "piece"
// or "slice" where no single number is meaningful. Without this, "1 can black beans" or "1 can
// coconut milk" fell back to GENERIC_COUNT_WEIGHT_G (100g, sized for a whole produce item like "1
// onion"), understating a can's actual contents by roughly 4x whenever the matched entry didn't
// separately carry its own avgUnitWeightG.
const CAN_DEFAULT_WEIGHT_G = 400;

// A line with genuinely no amount at all — not even a bare number — and no unit almost never means
// "assume one full 100g produce-item serving": real recipes write ingredients this way almost
// exclusively for a garnish/finishing touch ("Grated parmesan cheese", "Chopped walnuts, for topping",
// a comma-separated garnish list like "Paprika, red pepper flakes, and/or fresh parsley") or a
// seasoning, never a self-contained portion. `line.isOptionalOrToTaste` (see above) already zeroes
// this out when the line says so explicitly ("to taste", "for garnish", ...), but real recipes omit an
// amount on a garnish/topping line at least as often without using one of those specific phrases — this
// catches that same pattern generally instead of chasing every possible wording one at a time, the same
// way SEASONING_DEFAULT_G/OIL_DEFAULT_G above already do for their specific categories.
const NO_QUANTITY_DEFAULT_G = 5;

// Rough category densities (g per US cup, ~236.588mL), keyed by a substring of the ingredient's name —
// checked in order, first match wins. Only consulted when neither the matched database entry nor an
// AI estimate carries a precise gPerCup: without this, a volume measurement of anything but an actual
// liquid falls all the way through to WATER_G_PER_ML below, which silently prices a cup of chopped
// walnuts at water's density (236.6g vs. a real ~117g/cup, ~2x over) or a cup of flour at ~120g's worth
// counted as ~237g. These are widely-cited approximate reference values (USDA/King Arthur/industry
// baking references), not database-precise — but meaningfully closer than treating every dry, powdery,
// or airy ingredient as if it were water.
const CATEGORY_G_PER_CUP: { keywords: string[]; gPerCup: number }[] = [
	{ keywords: ['powdered sugar', 'confectioners sugar', "confectioner's sugar", 'icing sugar'], gPerCup: 120 },
	{ keywords: ['brown sugar'], gPerCup: 220 },
	{ keywords: ['honey', 'molasses', 'corn syrup', 'maple syrup', 'golden syrup', 'syrup'], gPerCup: 330 },
	{
		keywords: ['walnut', 'pecan', 'almond', 'cashew', 'pistachio', 'hazelnut', 'macadamia', 'peanut', 'chopped nut'],
		gPerCup: 120,
	},
	{ keywords: ['chia seed', 'flax seed', 'flaxseed', 'sesame seed', 'sunflower seed', 'pumpkin seed'], gPerCup: 150 },
	{ keywords: ['nutritional yeast'], gPerCup: 60 },
	{ keywords: ['flour', 'cocoa', 'cornstarch', 'corn starch', 'starch', 'breadcrumb', 'bread crumb'], gPerCup: 120 },
	{ keywords: ['rolled oat', 'oats', 'quinoa', 'couscous', 'rice', 'grain'], gPerCup: 185 },
	{ keywords: ['shredded cheese', 'grated cheese', 'grated parmesan', 'shredded parmesan'], gPerCup: 100 },
	{ keywords: ['vegetable oil', 'olive oil', 'canola oil', 'sunflower oil', 'coconut oil', 'sesame oil'], gPerCup: 218 },
	// Only reached when the matched entry itself has no gPerCup (some regional "Butter, unsalted"-style
	// entries don't) — without this, a cup of butter fell all the way through to WATER_G_PER_ML
	// (236.6g/cup), overstating the real ~227g/cup by about 4%. Checked last since earlier, more
	// specific keywords ("peanut", "cocoa") already claim compound terms like "peanut butter"/"cocoa
	// butter" first — this only ever fires for plain butter.
	{ keywords: ['butter'], gPerCup: 227 },
];

function estimateGPerCupFromName(name: string): number | null {
	const lower = name.toLowerCase();
	for (const { keywords, gPerCup } of CATEGORY_G_PER_CUP) {
		if (keywords.some((k) => lower.includes(k))) return gPerCup;
	}
	return null;
}

/** Resolves a parsed quantity+unit (against a matched ingredient, if any) into a gram weight. */
export function resolveGrams(line: ParsedIngredientLine, entry: IngredientEntry | null): GramResolution {
	const quantity = line.quantity ?? (line.isOptionalOrToTaste ? 0 : 1);

	if (line.isOptionalOrToTaste && line.quantity === null) {
		return { grams: 0, conversionSource: 'ingredient-data' };
	}

	const unitDef = line.unit ? UNIT_TABLE[line.unit] ?? findByCanonical(line.unit) : null;
	const isSeasoning = !!entry && isSeasoningEntry(entry);
	const isOil = !!entry && isOilEntry(entry);
	const genericCountWeight = isSeasoning ? SEASONING_DEFAULT_G : isOil ? OIL_DEFAULT_G : GENERIC_COUNT_WEIGHT_G;

	// No unit at all — treat as a count (e.g. "2 eggs", "1 onion").
	if (!unitDef) {
		if (entry?.avgUnitWeightG) {
			return { grams: quantity * entry.avgUnitWeightG, conversionSource: 'ingredient-data' };
		}
		// Seasoning/oil already have their own tuned no-amount default above; anything else that named no
		// quantity at all falls to the general small garnish/finishing default instead of a full 100g count.
		if (line.quantity === null && !isSeasoning && !isOil) {
			return { grams: NO_QUANTITY_DEFAULT_G, conversionSource: 'estimated' };
		}
		return { grams: quantity * genericCountWeight, conversionSource: 'estimated' };
	}

	if (unitDef.unitClass === 'weight') {
		return { grams: quantity * unitDef.toBase, conversionSource: 'ingredient-data' };
	}

	if (unitDef.unitClass === 'volume') {
		if (entry?.gPerCup) {
			const gPerMl = entry.gPerCup / 236.588;
			return { grams: quantity * unitDef.toBase * gPerMl, conversionSource: 'ingredient-data' };
		}
		const categoryGPerCup = estimateGPerCupFromName(entry?.name ?? line.matchName);
		if (categoryGPerCup) {
			const gPerMl = categoryGPerCup / 236.588;
			return { grams: quantity * unitDef.toBase * gPerMl, conversionSource: 'estimated' };
		}
		return { grams: quantity * unitDef.toBase * WATER_G_PER_ML, conversionSource: 'estimated' };
	}

	// count-class unit (piece, clove, slice, can, ...)
	if (entry?.avgUnitWeightG) {
		return { grams: quantity * entry.avgUnitWeightG, conversionSource: 'ingredient-data' };
	}
	if (unitDef.canonical === 'can') {
		return { grams: quantity * CAN_DEFAULT_WEIGHT_G, conversionSource: 'estimated' };
	}
	return { grams: quantity * genericCountWeight, conversionSource: 'estimated' };
}

function findByCanonical(canonical: string) {
	return Object.values(UNIT_TABLE).find((u) => u.canonical === canonical) ?? null;
}
