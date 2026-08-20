import { describe, expect, it } from 'vitest';
import { computeHealthScore, emptyProfile } from './nutrientMath';

describe('computeHealthScore — full 1-10 range', () => {
	// Regression: the original formula was a flat baseline-5 +-1-per-criterion adjustment with only
	// two possible bonuses (fiber, protein), so the highest score any recipe could ever reach was 7 —
	// no combination of real-world numbers could produce an 8, 9, or 10. Graduated %DV bands replace
	// the flat +-1 step so a genuinely excellent or genuinely poor recipe can reach the ends of the range.

	it('a recipe with negligible bad nutrients and abundant fiber/protein can reach the top of the range', () => {
		const profile = { ...emptyProfile(), fiber_g: 20, protein_g: 40, sugar_g: 0, sodium_mg: 50, satFat_g: 0 };
		const result = computeHealthScore(profile);
		expect(result.score).toBeGreaterThanOrEqual(9);
	});

	it('a recipe extreme in sugar, sodium, and saturated fat can reach the bottom of the range', () => {
		const profile = { ...emptyProfile(), sugar_g: 80, sodium_mg: 4000, satFat_g: 60, fiber_g: 0, protein_g: 0 };
		const result = computeHealthScore(profile);
		expect(result.score).toBeLessThanOrEqual(2);
	});

	it('a perfectly empty profile lands at the neutral baseline with no rationale triggered', () => {
		const result = computeHealthScore(emptyProfile());
		expect(result.score).toBe(5);
		expect(result.rationale).toEqual(['Balanced macro profile relative to daily values']);
	});

	it('stays within [1, 10] for a wildly out-of-range profile', () => {
		const result = computeHealthScore({ ...emptyProfile(), sugar_g: 1000, sodium_mg: 100000, satFat_g: 1000 });
		expect(result.score).toBeGreaterThanOrEqual(1);
		expect(result.score).toBeLessThanOrEqual(10);
	});

	it('escalates rationale wording ("Very high" / "Excellent") at the extreme bands', () => {
		const result = computeHealthScore({ ...emptyProfile(), sugar_g: 80, fiber_g: 20 });
		expect(result.rationale).toContain('Very high added/total sugar per serving');
		expect(result.rationale).toContain('Excellent source of fiber');
	});
});
