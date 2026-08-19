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
