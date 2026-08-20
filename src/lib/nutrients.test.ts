import { describe, expect, it } from 'vitest';
import { parseIngredients } from './parseIngredients';
import { analyzeIngredientLines, buildNutritionResult } from './nutrients';

/** End-to-end: freeform text -> parsed lines -> matched + gram-resolved + nutrient-scaled results,
 * without the Workers AI fallback (no `ai` binding available outside the Worker runtime). */
async function analyze(text: string) {
	return analyzeIngredientLines(parseIngredients(text), undefined);
}

describe('recipe text -> nutrition pipeline', () => {
	it('handles the full set of required free-text formats end to end', async () => {
		const text = [
			'500g chicken breast',
			'2 cups rice',
			'1 tbsp olive oil',
			'1 onion, chopped',
			'',
			'Chicken breast - 500 g',
			'Rice: 2 cups',
			'Olive oil: 1 tablespoon',
			'1 medium onion, finely chopped',
			'',
			'FOR THE CHICKEN',
			'- 500 grams chicken',
			'- 1 1/2 cups yogurt',
			'',
			'FOR THE SAUCE',
			'- 50g butter',
			'- 150 ml cream',
		].join('\n');

		const results = await analyze(text);

		// No section-heading lines leaked through as bogus ingredients.
		expect(results.some((r) => r.ingredientName.includes('FOR THE'))).toBe(false);
		expect(results).toHaveLength(12);

		// Every line resolved to a positive gram weight (nothing silently dropped to 0 by accident).
		for (const r of results) {
			expect(r.grams).toBeGreaterThan(0);
		}

		const totals = buildNutritionResult({
			id: 'test',
			title: 'Test recipe',
			servings: 4,
			ingredients: results,
			createdAt: 0,
		});
		expect(totals.totals.kcal).toBeGreaterThan(0);
		expect(totals.perServing.kcal).toBeCloseTo(totals.totals.kcal / 4, 1);
	});

	it('gives "salt to taste" zero grams and zero nutrients instead of guessing an amount', async () => {
		const [result] = await analyze('salt to taste');
		expect(result.quantity).toBeNull();
		expect(result.isOptionalOrToTaste).toBe(true);
		expect(result.grams).toBe(0);
		expect(result.nutrients.kcal).toBe(0);
	});

	it('resolves count ingredients (2 eggs) using ingredient-specific average weight, not a raw guess', async () => {
		const [result] = await analyze('2 eggs');
		expect(result.quantity).toBe(2);
		expect(result.unit).toBeNull();
		expect(result.grams).toBeGreaterThan(0);
		expect(result.matchedName).not.toBeNull();
	});

	it('flags an ambiguous ingredient match for user review instead of guessing silently', async () => {
		const [result] = await analyze('1 cup cheese');
		expect(result.matchedName).not.toBeNull();
		expect(result.ambiguous).toBe(true);
	});

	it('resolves US, UK, and India terminology for the same recipe', async () => {
		const results = await analyze(['1 zucchini, sliced', '1 courgette, sliced', '100g besan'].join('\n'));
		for (const r of results) {
			expect(r.matchedName).not.toBeNull();
			expect(r.grams).toBeGreaterThan(0);
		}
	});

	it('gives a bare, unquantified seasoning line a pinch-sized weight, not a whole-produce-item guess', async () => {
		// Regression: "Salt & black pepper" (no amount given) used to fall back to
		// GENERIC_COUNT_WEIGHT_G (100g — sized for "1 onion"), silently adding a whole 100g of ground
		// pepper's fiber/protein/sodium/fat to the recipe.
		const [salt, pepper] = await analyze('Salt & black pepper');
		expect(salt.grams).toBeLessThan(5);
		expect(pepper.grams).toBeLessThan(5);
	});

	it('resolves "1 can X" to a standard can size (~400g), not a generic 100g produce-item guess', async () => {
		const [result] = await analyze('1 can black beans');
		expect(result.grams).toBeGreaterThanOrEqual(350);
		expect(result.grams).toBeLessThanOrEqual(450);
	});

	it('gives a bare, unquantified "oil" line a drizzle-sized weight, not a whole-produce-item guess', async () => {
		// Regression: a URL-scraped recipe listing a bare "oil" (no amount — left to the cook, e.g.
		// "oil, for frying") used to fall back to GENERIC_COUNT_WEIGHT_G (100g, sized for "1 onion"),
		// pricing in ~880 kcal of pure fat for an ingredient the recipe never quantified at all.
		const [result] = await analyze('oil');
		expect(result.grams).toBeLessThan(20);
		expect(result.grams).toBeGreaterThan(0);
	});
});
