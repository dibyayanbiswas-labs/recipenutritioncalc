export type UnitClass = 'volume' | 'count' | 'weight';

export interface UnitDef {
	canonical: string;
	unitClass: UnitClass;
	/** conversion factor relative to the class's base unit (mL for volume, g for weight, 1 for count) */
	toBase: number;
}

// Ordered longest-alias-first within each entry isn't required here; matching sorts globally.
export const UNIT_TABLE: Record<string, UnitDef> = {
	cup: { canonical: 'cup', unitClass: 'volume', toBase: 236.588 },
	cups: { canonical: 'cup', unitClass: 'volume', toBase: 236.588 },
	c: { canonical: 'cup', unitClass: 'volume', toBase: 236.588 },
	tablespoon: { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	tablespoons: { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	tbsp: { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	'tbsp.': { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	tbs: { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	T: { canonical: 'tbsp', unitClass: 'volume', toBase: 14.7868 },
	teaspoon: { canonical: 'tsp', unitClass: 'volume', toBase: 4.92892 },
	teaspoons: { canonical: 'tsp', unitClass: 'volume', toBase: 4.92892 },
	tsp: { canonical: 'tsp', unitClass: 'volume', toBase: 4.92892 },
	'tsp.': { canonical: 'tsp', unitClass: 'volume', toBase: 4.92892 },
	t: { canonical: 'tsp', unitClass: 'volume', toBase: 4.92892 },
	'fluid ounce': { canonical: 'fl oz', unitClass: 'volume', toBase: 29.5735 },
	'fluid ounces': { canonical: 'fl oz', unitClass: 'volume', toBase: 29.5735 },
	'fl oz': { canonical: 'fl oz', unitClass: 'volume', toBase: 29.5735 },
	pint: { canonical: 'pint', unitClass: 'volume', toBase: 473.176 },
	pints: { canonical: 'pint', unitClass: 'volume', toBase: 473.176 },
	quart: { canonical: 'quart', unitClass: 'volume', toBase: 946.353 },
	quarts: { canonical: 'quart', unitClass: 'volume', toBase: 946.353 },
	milliliter: { canonical: 'ml', unitClass: 'volume', toBase: 1 },
	milliliters: { canonical: 'ml', unitClass: 'volume', toBase: 1 },
	millilitre: { canonical: 'ml', unitClass: 'volume', toBase: 1 },
	ml: { canonical: 'ml', unitClass: 'volume', toBase: 1 },
	liter: { canonical: 'l', unitClass: 'volume', toBase: 1000 },
	liters: { canonical: 'l', unitClass: 'volume', toBase: 1000 },
	litre: { canonical: 'l', unitClass: 'volume', toBase: 1000 },
	l: { canonical: 'l', unitClass: 'volume', toBase: 1000 },

	gram: { canonical: 'g', unitClass: 'weight', toBase: 1 },
	grams: { canonical: 'g', unitClass: 'weight', toBase: 1 },
	g: { canonical: 'g', unitClass: 'weight', toBase: 1 },
	kilogram: { canonical: 'kg', unitClass: 'weight', toBase: 1000 },
	kilograms: { canonical: 'kg', unitClass: 'weight', toBase: 1000 },
	kg: { canonical: 'kg', unitClass: 'weight', toBase: 1000 },
	ounce: { canonical: 'oz', unitClass: 'weight', toBase: 28.3495 },
	ounces: { canonical: 'oz', unitClass: 'weight', toBase: 28.3495 },
	oz: { canonical: 'oz', unitClass: 'weight', toBase: 28.3495 },
	pound: { canonical: 'lb', unitClass: 'weight', toBase: 453.592 },
	pounds: { canonical: 'lb', unitClass: 'weight', toBase: 453.592 },
	lb: { canonical: 'lb', unitClass: 'weight', toBase: 453.592 },
	lbs: { canonical: 'lb', unitClass: 'weight', toBase: 453.592 },

	piece: { canonical: 'count', unitClass: 'count', toBase: 1 },
	pieces: { canonical: 'count', unitClass: 'count', toBase: 1 },
	scoop: { canonical: 'scoop', unitClass: 'count', toBase: 1 },
	scoops: { canonical: 'scoop', unitClass: 'count', toBase: 1 },
	clove: { canonical: 'count', unitClass: 'count', toBase: 1 },
	cloves: { canonical: 'count', unitClass: 'count', toBase: 1 },
	slice: { canonical: 'count', unitClass: 'count', toBase: 1 },
	slices: { canonical: 'count', unitClass: 'count', toBase: 1 },
	can: { canonical: 'can', unitClass: 'count', toBase: 1 },
	cans: { canonical: 'can', unitClass: 'count', toBase: 1 },
	stalk: { canonical: 'count', unitClass: 'count', toBase: 1 },
	stalks: { canonical: 'count', unitClass: 'count', toBase: 1 },
	packet: { canonical: 'count', unitClass: 'count', toBase: 1 },
	packets: { canonical: 'count', unitClass: 'count', toBase: 1 },
	container: { canonical: 'count', unitClass: 'count', toBase: 1 },
	containers: { canonical: 'count', unitClass: 'count', toBase: 1 },
	box: { canonical: 'count', unitClass: 'count', toBase: 1 },
	boxes: { canonical: 'count', unitClass: 'count', toBase: 1 },
	pinch: { canonical: 'pinch', unitClass: 'weight', toBase: 0.36 },
	pinches: { canonical: 'pinch', unitClass: 'weight', toBase: 0.36 },
	dash: { canonical: 'dash', unitClass: 'volume', toBase: 0.6 },
	dashes: { canonical: 'dash', unitClass: 'volume', toBase: 0.6 },
};

/** Aliases sorted longest-first so multi-word units match before a shorter substring would. */
export const UNIT_ALIASES = Object.keys(UNIT_TABLE).sort((a, b) => b.length - a.length);

export const UNICODE_FRACTIONS: Record<string, number> = {
	'½': 0.5,
	'⅓': 1 / 3,
	'⅔': 2 / 3,
	'¼': 0.25,
	'¾': 0.75,
	'⅕': 0.2,
	'⅖': 0.4,
	'⅗': 0.6,
	'⅘': 0.8,
	'⅙': 1 / 6,
	'⅚': 5 / 6,
	'⅛': 0.125,
	'⅜': 0.375,
	'⅝': 0.625,
	'⅞': 0.875,
};

export const OPTIONAL_PHRASES = [
	'to taste',
	'optional',
	'for garnish',
	'for serving',
	'as needed',
	'as desired',
	'as required',
	'for frying',
	'for greasing',
	'for cooking',
	'for drizzling',
	'for dusting',
];
