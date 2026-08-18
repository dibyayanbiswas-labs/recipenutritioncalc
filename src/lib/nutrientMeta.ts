export interface NutrientMeta {
	key: string;
	label: string;
	unit: string;
}

export const MACRO_META: NutrientMeta[] = [
	{ key: 'protein_g', label: 'Protein', unit: 'g' },
	{ key: 'carbs_g', label: 'Carbohydrates', unit: 'g' },
	{ key: 'fat_g', label: 'Fat', unit: 'g' },
	{ key: 'satFat_g', label: 'Saturated fat', unit: 'g' },
	{ key: 'fiber_g', label: 'Fiber', unit: 'g' },
	{ key: 'sugar_g', label: 'Sugar', unit: 'g' },
	{ key: 'sodium_mg', label: 'Sodium', unit: 'mg' },
	{ key: 'cholesterol_mg', label: 'Cholesterol', unit: 'mg' },
];

export const MICRO_META: NutrientMeta[] = [
	{ key: 'vitaminA_mcg', label: 'Vitamin A', unit: 'mcg' },
	{ key: 'vitaminC_mg', label: 'Vitamin C', unit: 'mg' },
	{ key: 'vitaminD_mcg', label: 'Vitamin D', unit: 'mcg' },
	{ key: 'vitaminE_mg', label: 'Vitamin E', unit: 'mg' },
	{ key: 'vitaminK_mcg', label: 'Vitamin K', unit: 'mcg' },
	{ key: 'thiamin_mg', label: 'Thiamin (B1)', unit: 'mg' },
	{ key: 'riboflavin_mg', label: 'Riboflavin (B2)', unit: 'mg' },
	{ key: 'niacin_mg', label: 'Niacin (B3)', unit: 'mg' },
	{ key: 'vitaminB6_mg', label: 'Vitamin B6', unit: 'mg' },
	{ key: 'folate_mcg', label: 'Folate', unit: 'mcg' },
	{ key: 'vitaminB12_mcg', label: 'Vitamin B12', unit: 'mcg' },
	{ key: 'calcium_mg', label: 'Calcium', unit: 'mg' },
	{ key: 'iron_mg', label: 'Iron', unit: 'mg' },
	{ key: 'magnesium_mg', label: 'Magnesium', unit: 'mg' },
	{ key: 'phosphorus_mg', label: 'Phosphorus', unit: 'mg' },
	{ key: 'potassium_mg', label: 'Potassium', unit: 'mg' },
	{ key: 'zinc_mg', label: 'Zinc', unit: 'mg' },
	{ key: 'copper_mg', label: 'Copper', unit: 'mg' },
	{ key: 'manganese_mg', label: 'Manganese', unit: 'mg' },
	{ key: 'selenium_mcg', label: 'Selenium', unit: 'mcg' },
];
