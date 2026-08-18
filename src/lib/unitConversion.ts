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

/** Resolves a parsed quantity+unit (against a matched ingredient, if any) into a gram weight. */
export function resolveGrams(line: ParsedIngredientLine, entry: IngredientEntry | null): GramResolution {
	const quantity = line.quantity ?? (line.isOptionalOrToTaste ? 0 : 1);

	if (line.isOptionalOrToTaste && line.quantity === null) {
		return { grams: 0, conversionSource: 'ingredient-data' };
	}

	const unitDef = line.unit ? UNIT_TABLE[line.unit] ?? findByCanonical(line.unit) : null;

	// No unit at all — treat as a count (e.g. "2 eggs", "1 onion").
	if (!unitDef) {
		if (entry?.avgUnitWeightG) {
			return { grams: quantity * entry.avgUnitWeightG, conversionSource: 'ingredient-data' };
		}
		return { grams: quantity * GENERIC_COUNT_WEIGHT_G, conversionSource: 'estimated' };
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
	return { grams: quantity * GENERIC_COUNT_WEIGHT_G, conversionSource: 'estimated' };
}

function findByCanonical(canonical: string) {
	return Object.values(UNIT_TABLE).find((u) => u.canonical === canonical) ?? null;
}
