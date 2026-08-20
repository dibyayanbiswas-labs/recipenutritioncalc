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

// A standard retail can (soup, beans, tomatoes, coconut milk, ...) runs ~400g/14-15oz regardless of
// what's in it — the can size is a property of the container, not the specific food, unlike "piece"
// or "slice" where no single number is meaningful. Without this, "1 can black beans" or "1 can
// coconut milk" fell back to GENERIC_COUNT_WEIGHT_G (100g, sized for a whole produce item like "1
// onion"), understating a can's actual contents by roughly 4x whenever the matched entry didn't
// separately carry its own avgUnitWeightG.
const CAN_DEFAULT_WEIGHT_G = 400;

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
	const genericCountWeight = entry && isSeasoningEntry(entry) ? SEASONING_DEFAULT_G : GENERIC_COUNT_WEIGHT_G;

	// No unit at all — treat as a count (e.g. "2 eggs", "1 onion").
	if (!unitDef) {
		if (entry?.avgUnitWeightG) {
			return { grams: quantity * entry.avgUnitWeightG, conversionSource: 'ingredient-data' };
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
