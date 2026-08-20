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
