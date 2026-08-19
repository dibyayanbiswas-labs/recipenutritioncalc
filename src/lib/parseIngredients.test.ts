import { describe, expect, it } from 'vitest';
import { parseIngredientLine, parseIngredients, splitIntoLines } from './parseIngredients';

/** parseIngredientLine assumes letter/digit boundaries are already spaced out (that normalization
 * happens once, up front, in parseIngredients/splitIntoLines) — so a directly-pasted "500g" is
 * exercised through the full pipeline here, same as a real paste would be. */
function parseLine(raw: string) {
	return parseIngredients(raw)[0];
}

describe('parseIngredientLine — core formats', () => {
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

	it('parses "scoops" as its own unit, not part of the ingredient name', () => {
		const r = parseIngredientLine('1.5 scoops whey protein');
		expect(r.quantity).toBe(1.5);
		expect(r.unit).toBe('scoop');
		expect(r.ingredientName).toBe('whey protein');
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

	it('distinguishes "T" (tablespoon) from "t" (teaspoon) by case', () => {
		const tbsp = parseIngredientLine('1 T butter');
		expect(tbsp.unit).toBe('tbsp');
		const tsp = parseIngredientLine('1 t salt');
		expect(tsp.unit).toBe('tsp');
	});
});

describe('parseIngredientLine — name-first / connector formats', () => {
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

	it('parses "name — amount, trailing note" (em-dash, with a comma clause after the amount)', () => {
		const r = parseLine('Onion — 1 medium, finely chopped');
		expect(r.quantity).toBe(1);
		expect(r.ingredientName).toBe('Onion');
		expect(r.notes).toContain('finely chopped');
	});

	it('does not mistake a compound word like "stir-fry" for a name/amount separator', () => {
		const r = parseLine('Stir-fry sauce - 100ml');
		expect(r.quantity).toBe(100);
		expect(r.unit).toBe('ml');
		expect(r.ingredientName).toBe('Stir-fry sauce');
	});
});

describe('parseIngredientLine — explicit weight in parentheses overrides a count-based amount', () => {
	it('"Onion — 1 medium (150 g), finely chopped" uses the 150g, not a generic per-onion guess', () => {
		const r = parseLine('Onion — 1 medium (150 g), finely chopped');
		expect(r.ingredientName).toBe('Onion');
		expect(r.quantity).toBe(150);
		expect(r.unit).toBe('g');
	});

	it('"4 slices (80–100 g) Cheddar cheese" uses the midpoint of the weight range', () => {
		const r = parseLine('4 slices (80–100 g) Cheddar cheese');
		expect(r.ingredientName).toBe('Cheddar cheese');
		expect(r.quantity).toBe(90);
		expect(r.unit).toBe('g');
		expect(r.quantityRange).toEqual([80, 100]);
	});

	it('a parenthetical count (e.g. "(2 pieces)") is left as a note, not treated as a weight override', () => {
		const r = parseLine('1 cup diced tomatoes (2 pieces)');
		expect(r.unit).toBe('cup');
		expect(r.quantity).toBe(1);
	});
});

describe('parseIngredientLine — "N x amount unit" multiplier', () => {
	it('multiplies a "N x amount unit" quantity, e.g. "2 x 100g" flour', () => {
		const r = parseLine('2 x 100g flour');
		expect(r.quantity).toBe(200);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('flour');
	});
});

describe('splitIntoLines — hard rule: one line in, at most one ingredient out', () => {
	it('does NOT merge a name on one line with an amount on the next (no cross-line guessing)', () => {
		const lines = splitIntoLines('basmati rice\n500g');
		expect(lines).toEqual(['basmati rice', '500 g']);
	});

	it('does NOT split one line into several just because it contains multiple numbers', () => {
		// A single, oddly-phrased line stays a single line — no guessing at where it should be cut.
		const lines = splitIntoLines('1 sprig curry leaves (10-12 leaves)');
		expect(lines).toHaveLength(1);
	});

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

	it('does not mistake a decimal quantity for a numbered-list marker, e.g. "1.5 scoops"', () => {
		const r = parseLine('1.5 scoops whey protein');
		expect(r.quantity).toBe(1.5);
		expect(r.ingredientName).toBe('whey protein');

		const r2 = parseLine('10.5 gms rice');
		expect(r2.quantity).toBe(10.5);
	});

	it('still strips real numbered-list markers like "1. " and "2) "', () => {
		expect(splitIntoLines('1. Chop onions')).toEqual(['Chop onions']);
		expect(splitIntoLines('2) Mix ingredients')).toEqual(['Mix ingredients']);
	});

	it('strips a trailing stray comma from a line, e.g. "2 cups oats,"', () => {
		const r = parseLine('2 cups oats,');
		expect(r.quantity).toBe(2);
		expect(r.unit).toBe('cup');
		expect(r.ingredientName).toBe('oats');
	});
});

describe('splitIntoLines — comma-separated single-line paste fallback', () => {
	it('splits a whole list pasted onto one comma-separated line, when every piece has its own amount', () => {
		const lines = splitIntoLines('500g chicken, 2 cups rice, 1 tbsp olive oil');
		expect(lines).toEqual(['500 g chicken', '2 cups rice', '1 tbsp olive oil']);
	});

	it('also works when the comma-joined pieces are name-first style', () => {
		const lines = splitIntoLines('Chicken breast - 500g, Rice: 2 cups');
		expect(lines).toEqual(['Chicken breast - 500 g', 'Rice: 2 cups']);
	});

	it('does NOT split a single ingredient whose comma is just a prep note', () => {
		const lines = splitIntoLines('1 onion, chopped');
		expect(lines).toEqual(['1 onion, chopped']);
	});

	it('does NOT split "name — amount (weight), note" even though it has an internal comma', () => {
		const lines = splitIntoLines('Onion — 1 medium (150 g), finely chopped');
		expect(lines).toEqual(['Onion — 1 medium (150 g), finely chopped']);
	});

	it('leaves a partially-unparseable comma line alone rather than guessing where to cut it', () => {
		// "vanilla" has no amount of its own, so this is NOT confidently a 3-item list.
		const lines = splitIntoLines('2 cups oats, 1 cup flour, vanilla');
		expect(lines).toHaveLength(1);
	});
});

describe('parseIngredients — mixed free-text paste', () => {
	it('parses each required format style from a mixed paste', () => {
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

	it('parses the exact bug-report examples end to end', () => {
		const text = ['2 cups oats,', 'Onion — 1 medium (150 g), finely chopped', '2 x 100g flour', '4 slices (80–100 g) Cheddar cheese'].join(
			'\n',
		);
		const lines = parseIngredients(text);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatchObject({ quantity: 2, unit: 'cup', ingredientName: 'oats' });
		expect(lines[1]).toMatchObject({ quantity: 150, unit: 'g', ingredientName: 'Onion' });
		expect(lines[2]).toMatchObject({ quantity: 200, unit: 'g', ingredientName: 'flour' });
		expect(lines[3]).toMatchObject({ quantity: 90, unit: 'g', ingredientName: 'Cheddar cheese' });
	});
});

describe('parseIngredientLine — "for X" phrasing is treated as optional, not a missing amount', () => {
	it('"Oil, for frying" does not default to a fake quantity', () => {
		const r = parseIngredientLine('Oil, for frying');
		expect(r.quantity).toBeNull();
		expect(r.isOptionalOrToTaste).toBe(true);
		expect(r.ingredientName).toBe('Oil');
	});

	it('also recognizes "for greasing", "for cooking", "for drizzling", "for dusting"', () => {
		for (const phrase of ['for greasing', 'for cooking', 'for drizzling', 'for dusting']) {
			const r = parseIngredientLine(`Butter, ${phrase}`);
			expect(r.isOptionalOrToTaste).toBe(true);
		}
	});
});

describe('parseIngredientLine — word-based multiplier counts', () => {
	it('"a dozen eggs" is 12, not 1', () => {
		const r = parseIngredientLine('a dozen eggs');
		expect(r.quantity).toBe(12);
		expect(r.ingredientName).toBe('eggs');
	});

	it('"dozen eggs" (no article) also works', () => {
		expect(parseIngredientLine('dozen eggs').quantity).toBe(12);
	});

	it('"a couple of onions" is 2', () => {
		const r = parseIngredientLine('a couple of onions');
		expect(r.quantity).toBe(2);
		expect(r.ingredientName).toBe('onions');
	});

	it('"a few sprigs thyme" is approximated as 3', () => {
		expect(parseIngredientLine('a few sprigs thyme').quantity).toBe(3);
	});

	it('a bare "a"/"an" without a multiplier word is still 1, e.g. "a lemon"', () => {
		expect(parseIngredientLine('a lemon').quantity).toBe(1);
	});
});

describe('parseIngredientLine — leading approximation markers', () => {
	it('"About 1 cup chopped nuts" strips "About" and still parses the amount', () => {
		const r = parseLine('About 1 cup chopped nuts');
		expect(r.quantity).toBe(1);
		expect(r.unit).toBe('cup');
		expect(r.ingredientName).toBe('nuts');
		expect(r.notes).toBe('chopped');
	});

	it('"~200g paneer" strips the leading tilde', () => {
		const r = parseLine('~200g paneer');
		expect(r.quantity).toBe(200);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('paneer');
	});

	it('"approx. 2 tbsp honey" strips "approx."', () => {
		const r = parseIngredientLine('approx. 2 tbsp honey');
		expect(r.quantity).toBe(2);
		expect(r.unit).toBe('tbsp');
	});
});

describe('parseIngredientLine — packet/container/box as count units', () => {
	it('"1 packet Maggi noodles (70g)" does not leak "packet" into the ingredient name', () => {
		const r = parseLine('1 packet Maggi noodles (70g)');
		expect(r.quantity).toBe(70);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('Maggi noodles');
	});

	it('"2 packets instant yeast" (no weight given) resolves packets as a count unit, not part of the name', () => {
		const r = parseLine('2 packets instant yeast');
		expect(r.quantity).toBe(2);
		expect(r.unit).toBe('count');
		expect(r.ingredientName).toBe('instant yeast');
	});

	it('recognizes "container" and "box" the same way', () => {
		expect(parseLine('1 container yogurt').ingredientName).toBe('yogurt');
		expect(parseLine('1 box cereal').ingredientName).toBe('cereal');
	});
});

describe('parseIngredientLine — "X or Y" alternative naming', () => {
	it('"Butter or margarine — 100g" matches on the primary ingredient, notes the alternative', () => {
		const r = parseLine('Butter or margarine — 100g');
		expect(r.quantity).toBe(100);
		expect(r.unit).toBe('g');
		expect(r.ingredientName).toBe('Butter');
		expect(r.notes).toContain('or margarine');
	});

	it('also works quantity-first: "100g butter or margarine"', () => {
		const r = parseLine('100g butter or margarine');
		expect(r.ingredientName).toBe('butter');
		expect(r.notes).toContain('or margarine');
	});

	it('a parenthetical alternative already worked and still does: "1 cup milk (or almond milk)"', () => {
		const r = parseLine('1 cup milk (or almond milk)');
		expect(r.ingredientName).toBe('milk');
		expect(r.notes).toContain('or almond milk');
	});
});
