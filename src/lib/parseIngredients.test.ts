import { describe, expect, it } from 'vitest';
import { parseIngredientLine, parseIngredients } from './parseIngredients';

/** parseIngredientLine assumes letter/digit boundaries are already spaced out (that normalization
 * happens once, up front, in parseIngredients/splitIntoLines) — so a directly-pasted "500g" is
 * exercised through the full pipeline here, same as a real paste would be. */
function parseLine(raw: string) {
	return parseIngredients(raw)[0];
}

describe('parseIngredientLine', () => {
	it('parses a simple weight ingredient', () => {
		const r = parseLine('500g chicken');
		expect(r.quantity).toBe(500);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('chicken');
	});

	it('parses a mixed-number volume quantity', () => {
		const r = parseIngredientLine('1 1/2 cups rice');
		expect(r.quantity).toBe(1.5);
		expect(r.unit).toBe('cup');
		expect(r.ingredientName).toBe('rice');
	});

	it('parses a unicode fraction quantity', () => {
		const r = parseIngredientLine('½ tsp salt');
		expect(r.quantity).toBe(0.5);
		expect(r.unit).toBe('tsp');
		expect(r.ingredientName).toBe('salt');
	});

	it('parses a plain count ingredient with no unit', () => {
		const r = parseIngredientLine('2 eggs');
		expect(r.quantity).toBe(2);
		expect(r.unit).toBeNull();
		expect(r.ingredientName).toBe('eggs');
	});

	it('extracts a size descriptor and comma-clause preparation note', () => {
		const r = parseIngredientLine('1 medium onion, chopped');
		expect(r.quantity).toBe(1);
		expect(r.ingredientName).toBe('medium onion');
		expect(r.notes).toBe('chopped');
	});

	it('treats "salt to taste" as optional with no invented quantity', () => {
		const r = parseIngredientLine('salt to taste');
		expect(r.quantity).toBeNull();
		expect(r.isOptionalOrToTaste).toBe(true);
		expect(r.ingredientName).toBe('salt');
	});

	it('does not invent a quantity for other to-taste/optional phrasing', () => {
		const r = parseIngredientLine('black pepper, to taste');
		expect(r.quantity).toBeNull();
		expect(r.isOptionalOrToTaste).toBe(true);
	});

	it('parses "name - amount unit" (dash-separated, name first)', () => {
		const r = parseIngredientLine('Chicken breast - 500 g');
		expect(r.quantity).toBe(500);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('Chicken breast');
	});

	it('parses "name: amount unit" (colon-separated, name first)', () => {
		const r = parseIngredientLine('Rice: 2 cups');
		expect(r.quantity).toBe(2);
		expect(r.unit).toBe('cup');
		expect(r.ingredientName).toBe('Rice');

		const r2 = parseIngredientLine('Olive oil: 1 tablespoon');
		expect(r2.quantity).toBe(1);
		expect(r2.unit).toBe('tbsp');
		expect(r2.ingredientName).toBe('Olive oil');
	});

	it('strips a leading preparation word not attached by a comma', () => {
		const r = parseIngredientLine('1 cup chopped tomatoes');
		expect(r.ingredientName).toBe('tomatoes');
		expect(r.notes).toBe('chopped');
	});

	it('leaves a food-identity word like "ground" attached to the name', () => {
		// "ground beef" is a distinct product in nutrition data from plain "beef" — stripping it
		// would change which food gets matched, so it must NOT be treated as a preparation word.
		const r = parseIngredientLine('1 lb ground beef');
		expect(r.ingredientName).toBe('ground beef');
		expect(r.notes).toBeNull();
	});

	it('parses count ingredients with a unit word like "cloves"', () => {
		const r = parseIngredientLine('3 cloves garlic');
		expect(r.quantity).toBe(3);
		expect(r.unit).toBe('count');
		expect(r.ingredientName).toBe('garlic');
	});

	it('handles a UK-style ingredient (courgette, millilitres)', () => {
		const r = parseLine('200ml courgette puree');
		expect(r.quantity).toBe(200);
		expect(r.unit).toBe('ml');
		expect(r.ingredientName).toBe('courgette puree');
	});

	it('handles an India-style ingredient (besan, gram measurement)', () => {
		const r = parseLine('100g besan');
		expect(r.quantity).toBe(100);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('besan');
	});

	it('handles a US/Canada-style imperial ingredient (lb, oz)', () => {
		const r = parseIngredientLine('1 lb butter, softened');
		expect(r.quantity).toBe(1);
		expect(r.unit).toBe('lb');
		expect(r.ingredientName).toBe('butter');
		expect(r.notes).toBe('softened');
	});
});

describe('parseIngredients (multi-line + section headings)', () => {
	it('drops ALL-CAPS section headings instead of treating them as ingredients', () => {
		const text = `FOR THE CHICKEN
- 500 grams chicken
- 1 1/2 cups yogurt

FOR THE SAUCE
- 50g butter
- 150 ml cream`;
		const lines = parseIngredients(text);
		expect(lines.map((l) => l.ingredientName)).toEqual(['chicken', 'yogurt', 'butter', 'cream']);
		expect(lines.every((l) => l.quantity !== null)).toBe(true);
	});

	it('drops "For the ..." headings regardless of case', () => {
		const text = `For the sauce:
50g butter
150 ml cream`;
		const lines = parseIngredients(text);
		expect(lines).toHaveLength(2);
		expect(lines[0].ingredientName).toBe('butter');
	});

	it('parses each format style from a mixed free-text paste', () => {
		const text = [
			'500g chicken breast',
			'2 cups rice',
			'1 tbsp olive oil',
			'1 onion, chopped',
			'Chicken breast - 500 g',
			'Rice: 2 cups',
			'salt to taste',
		].join('\n');
		const lines = parseIngredients(text);
		expect(lines).toHaveLength(7);
		for (const line of lines) {
			expect(line.quantity !== null || line.isOptionalOrToTaste).toBe(true);
		}
	});
});
