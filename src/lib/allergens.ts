export const ALLERGEN_LABELS: Record<string, string> = {
	milk: 'Milk',
	egg: 'Egg',
	fish: 'Fish',
	shellfish: 'Shellfish',
	'tree-nut': 'Tree nuts',
	peanut: 'Peanuts',
	wheat: 'Wheat',
	soy: 'Soy',
	sesame: 'Sesame',
};

/** Unions the allergen tags carried by each matched ingredient into one recipe-level list. */
export function unionAllergens(perIngredientAllergens: (string[] | undefined)[]): string[] {
	const set = new Set<string>();
	for (const list of perIngredientAllergens) {
		for (const a of list ?? []) set.add(a);
	}
	return [...set].sort();
}
