import { describe, expect, it } from 'vitest';
import { matchIngredient } from './matchIngredient';

describe('matchIngredient — ambiguity flagging', () => {
	it('flags a bare "cheese" query as ambiguous instead of silently picking one variety', () => {
		// Cheddar, swiss, cottage cheese etc. all match "cheese" equally well by name but have very
		// different calorie profiles — the match itself should still succeed (best-effort), but be
		// flagged so the UI can ask the user to confirm which cheese was meant.
		const m = matchIngredient('cheese');
		expect(m).not.toBeNull();
		expect(m?.ambiguous).toBe(true);
	});

	it('does not flag an unambiguous, fully-qualified match', () => {
		const m = matchIngredient('olive oil');
		expect(m).not.toBeNull();
		expect(m?.ambiguous).toBe(false);
	});

	it('does not flag same-food entries that differ only by source region', () => {
		// "onion" resolves to raw onion in every regional database with near-identical calories —
		// picking whichever region happens to win shouldn't be treated as a meaningful guess.
		const m = matchIngredient('onion');
		expect(m).not.toBeNull();
		expect(m?.ambiguous).toBe(false);
	});
});

describe('matchIngredient — regional terminology', () => {
	it('matches UK terms (courgette, aubergine, coriander)', () => {
		expect(matchIngredient('courgette')?.entry.name.toLowerCase()).toContain('courgette');
		expect(matchIngredient('aubergine')).not.toBeNull();
		expect(matchIngredient('coriander')).not.toBeNull();
	});

	it('matches US terms for the same foods (zucchini, eggplant, cilantro)', () => {
		expect(matchIngredient('zucchini')).not.toBeNull();
		expect(matchIngredient('eggplant')).not.toBeNull();
		expect(matchIngredient('cilantro')).not.toBeNull();
	});

	it('matches India terms (besan, curd)', () => {
		expect(matchIngredient('besan')?.entry.name.toLowerCase()).toContain('besan');
		expect(matchIngredient('curd')).not.toBeNull();
	});

	it('matches Australia terms (capsicum)', () => {
		expect(matchIngredient('capsicum')).not.toBeNull();
	});
});

describe('matchIngredient — regression: bare-word and off-type mismatches', () => {
	it('a bare "pepper" query means black pepper (the spice), not a bell/chili pepper (the vegetable)', () => {
		const m = matchIngredient('pepper', 'US');
		expect(m?.entry.name.toLowerCase()).toContain('pepper');
		expect(m?.entry.name.toLowerCase()).toContain('black');
		expect(m?.entry.name.toLowerCase()).not.toContain('jalapeno');
	});

	it('an explicit variety query still wins over the bare-pepper default', () => {
		const m = matchIngredient('jalapeno pepper', 'US');
		expect(m?.entry.name.toLowerCase()).toContain('jalapeno');
	});

	it('"vegetable oil" resolves to a neutral cooking oil, not an extreme-satFat tropical oil', () => {
		const m = matchIngredient('vegetable oil', 'US');
		expect(m).not.toBeNull();
		expect(m!.entry.per100g.satFat_g).toBeLessThan(20);
	});

	it('"french fries" matches an actual fries entry, not "French toast"', () => {
		const m = matchIngredient('frozen french fries', 'US');
		expect(m?.entry.name.toLowerCase()).not.toContain('toast');
		expect(m?.entry.name.toLowerCase()).toContain('french fried');
	});

	it('"kosher salt" and "sea salt" match table salt instead of missing coverage by one descriptor word', () => {
		const plain = matchIngredient('salt', 'US');
		const kosher = matchIngredient('kosher salt', 'US');
		const sea = matchIngredient('sea salt', 'US');
		expect(kosher?.entry.name).toBe(plain?.entry.name);
		expect(sea?.entry.name).toBe(plain?.entry.name);
		expect(kosher?.confidence).not.toBe('low');
	});

	it('"unsalted butter" matches the well-tagged US "butter, without salt" entry, not an untagged regional "unsalted" entry', () => {
		const m = matchIngredient('unsalted butter', 'US');
		expect(m).not.toBeNull();
		expect(m!.entry.region).toBe('US');
		expect(m!.entry.name.toLowerCase()).toContain('butter');
		// The bug: "unsalted" only appears verbatim in UK/CA/IN "Butter, unsalted" entries, none of which
		// carry allergen data — silently dropping the Milk allergen tag for an obviously dairy ingredient.
		expect(m!.entry.allergens).toContain('milk');
	});

	it('a bare "milk" query means everyday dairy milk, not buttermilk, chocolate milk, or another specialty product', () => {
		const m = matchIngredient('milk', 'US');
		expect(m).not.toBeNull();
		const name = m!.entry.name.toLowerCase();
		expect(name).toContain('milk');
		for (const wrongVariant of ['buttermilk', 'chocolate', 'producer', 'filled', 'evaporated', 'imitation', 'dry', 'canned']) {
			expect(name).not.toContain(wrongVariant);
		}
		expect(m!.entry.allergens).toContain('milk');
	});

	it('"soy sauce" matches a well-tagged US entry, not an untagged regional "Sauce, soy, commercial" entry', () => {
		const m = matchIngredient('soy sauce', 'US');
		expect(m).not.toBeNull();
		expect(m!.entry.region).toBe('US');
		// The bug: US soy sauce entries are named "soy sauce made from X" with no comma, so they lost
		// the primary-segment precision bonus entirely and fell behind a terser AU "Sauce, soy,
		// commercial" entry that carries no allergen data at all — silently dropping the soy allergen.
		expect(m!.entry.allergens).toContain('soy');
	});
});
