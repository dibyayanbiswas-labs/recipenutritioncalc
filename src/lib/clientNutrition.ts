// Client-side entry point for live servings recompute. Only pulls in the pure math + small
// metadata tables — never `nutrients.ts` / `matchIngredient.ts`, which drag in the multi-thousand
// entry ingredient database that has no reason to ship to the browser.
export { recomputeForServings, DAILY_VALUES } from './nutrientMath';
export { MACRO_META, MICRO_META } from './nutrientMeta';
export type { NutrientProfile } from './matchIngredient';
