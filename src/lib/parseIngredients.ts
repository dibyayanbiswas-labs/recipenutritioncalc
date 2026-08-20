import { UNICODE_FRACTIONS, UNIT_ALIASES, UNIT_TABLE, OPTIONAL_PHRASES, type UnitClass } from './units';

export interface ParsedIngredientLine {
	raw: string;
	quantity: number | null;
	quantityRange: [number, number] | null;
	unit: string | null;
	ingredientName: string;
	/** `ingredientName` plus any trailing descriptor words (e.g. "drained and rinsed", "cooked") that
	 * change which nutrition-database entry is correct — use this, not `ingredientName`, for food
	 * matching/AI-estimate lookups. `ingredientName` alone stays the clean display form. */
	matchName: string;
	notes: string | null;
	isOptionalOrToTaste: boolean;
}

const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');
const UNIT_ALIAS_PATTERN = UNIT_ALIASES.map(escapeRegExp).join('|');
// Count-class aliases only ("clove", "slice", "piece", ...) — see extractTrailingCountUnit below.
const COUNT_UNIT_ALIAS_PATTERN = UNIT_ALIASES.filter((a) => UNIT_TABLE[a].unitClass === 'count')
	.map(escapeRegExp)
	.join('|');

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words/phrases that carry no food-identity information but often survive next to a real amount —
// "1/4 tsp salt, plus more to taste" — harmless for display (kept in `notes`) but poison food-database
// matching when left in the match query, e.g. "salt plus more" failing to match "salt, table" even
// though "salt" alone matches instantly.
const MATCH_NOISE_PHRASES = ['plus more', 'plus extra', 'or more', 'and more'];
function stripMatchNoise(text: string): string {
	let result = text;
	for (const phrase of MATCH_NOISE_PHRASES) {
		result = result.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi'), ' ');
	}
	return result.replace(/\s+/g, ' ').trim();
}

/** Inserts a space at letter/digit boundaries, so "rice500g" reads as "rice 500 g". */
function normalizeSpacing(text: string): string {
	return text.replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
}

function parseQuantityToken(token: string): number | null {
	token = token.trim();
	if (!token) return null;

	// Mixed number with unicode fraction, e.g. "1½"
	const mixedUnicode = token.match(new RegExp(`^(\\d+)\\s*([${UNICODE_FRACTION_CHARS}])$`));
	if (mixedUnicode) {
		return Number(mixedUnicode[1]) + UNICODE_FRACTIONS[mixedUnicode[2]];
	}
	// Bare unicode fraction
	if (UNICODE_FRACTIONS[token] !== undefined) {
		return UNICODE_FRACTIONS[token];
	}
	// Mixed number with ascii fraction, e.g. "1 1/2"
	const mixedAscii = token.match(/^(\d+)\s+(\d+)\/(\d+)$/);
	if (mixedAscii) {
		return Number(mixedAscii[1]) + Number(mixedAscii[2]) / Number(mixedAscii[3]);
	}
	// Bare ascii fraction, e.g. "1/2"
	const ascii = token.match(/^(\d+)\/(\d+)$/);
	if (ascii) {
		return Number(ascii[1]) / Number(ascii[2]);
	}
	// Plain integer/decimal
	if (/^\d+(\.\d+)?$/.test(token)) {
		return Number(token);
	}
	return null;
}

const QUANTITY_TOKEN = `\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?\\s*[${UNICODE_FRACTION_CHARS}]|[${UNICODE_FRACTION_CHARS}]|\\d+(?:\\.\\d+)?`;

const WORD_NUMBERS: Record<string, number> = {
	a: 1,
	an: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
};

// Fixed, self-contained word phrases with a conventional count — distinct from WORD_NUMBERS since
// each is checked as a whole "(a/an) WORD (of)?" phrase, not a single word, and must be tried before
// the bare "a"/"an" = 1 fallback below (otherwise "a dozen eggs" would stop at "a" = 1).
const MULTIPLIER_WORDS: Record<string, number> = { dozen: 12, couple: 2, few: 3 };
const MULTIPLIER_WORD_PATTERN = new RegExp(`^(?:(?:a|an)\\s+)?(${Object.keys(MULTIPLIER_WORDS).join('|')})\\s+(?:of\\s+)?`, 'i');

function extractMultiplierWordQuantity(text: string): { quantity: number; rest: string } | null {
	const match = text.match(MULTIPLIER_WORD_PATTERN);
	if (!match) return null;
	return { quantity: MULTIPLIER_WORDS[match[1].toLowerCase()], rest: text.slice(match[0].length) };
}

function extractQuantity(text: string): {
	quantity: number | null;
	quantityRange: [number, number] | null;
	rest: string;
} {
	// Range: "2-3", "2 to 3", "2–3"
	const rangeMatch = text.match(new RegExp(`^(${QUANTITY_TOKEN})\\s*(?:-|–|to)\\s*(${QUANTITY_TOKEN})(?:\\s+|$)`));
	if (rangeMatch) {
		const a = parseQuantityToken(rangeMatch[1]);
		const b = parseQuantityToken(rangeMatch[2]);
		if (a !== null && b !== null) {
			return {
				quantity: (a + b) / 2,
				quantityRange: [a, b],
				rest: text.slice(rangeMatch[0].length),
			};
		}
	}

	// Multiplier: "2 x 400g", "3 x 500 ml" — total quantity is the product; the unit (if any) is
	// left in `rest` for the normal extractUnit() pass right after this returns.
	const multiplierMatch = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*[x×]\\s*(${QUANTITY_TOKEN})(?:\\s+|$)`, 'i'));
	if (multiplierMatch) {
		const count = Number(multiplierMatch[1]);
		const each = parseQuantityToken(multiplierMatch[2]);
		if (each !== null) {
			return { quantity: count * each, quantityRange: null, rest: text.slice(multiplierMatch[0].length) };
		}
	}

	// Single quantity token — followed by whitespace, or the end of the string ("500" with nothing after).
	const singleMatch = text.match(new RegExp(`^(${QUANTITY_TOKEN})(?:\\s+|$)`));
	if (singleMatch) {
		const q = parseQuantityToken(singleMatch[1]);
		if (q !== null) {
			return { quantity: q, quantityRange: null, rest: text.slice(singleMatch[0].length) };
		}
	}

	// Fixed multiplier phrases, e.g. "a dozen eggs", "couple of onions", "a few sprigs" — tried before
	// the bare word-number fallback below so "a dozen" doesn't stop early at "a" = 1.
	const multiplierWord = extractMultiplierWordQuantity(text);
	if (multiplierWord) {
		return { quantity: multiplierWord.quantity, quantityRange: null, rest: multiplierWord.rest };
	}

	// Word number fallback, e.g. "a pinch of salt", "two eggs"
	const wordMatch = text.match(/^([a-zA-Z]+)(?:\s+|$)/);
	if (wordMatch && WORD_NUMBERS[wordMatch[1].toLowerCase()] !== undefined) {
		return {
			quantity: WORD_NUMBERS[wordMatch[1].toLowerCase()],
			quantityRange: null,
			rest: text.slice(wordMatch[0].length),
		};
	}

	return { quantity: null, quantityRange: null, rest: text };
}

function extractUnit(text: string): { unit: string | null; unitClass: UnitClass | null; rest: string } {
	const match = text.match(new RegExp(`^(${UNIT_ALIAS_PATTERN})\\b\\.?(?:\\s+|$)`, 'i'));
	if (match) {
		// Exact case checked first: "T" (tablespoon) and "t" (teaspoon) are distinct, meaningful
		// aliases — lowercasing before the lookup would collapse both onto "t" (teaspoon) always.
		const def = UNIT_TABLE[match[1]] ?? UNIT_TABLE[match[1].toLowerCase()];
		if (def) {
			return { unit: def.canonical, unitClass: def.unitClass, rest: text.slice(match[0].length) };
		}
	}
	return { unit: null, unitClass: null, rest: text };
}

/** Fallback for a compound food noun whose natural word order puts the unit word at the very end
 * instead of the front — "garlic clove", "bread slice" — rather than the front-anchored "1 clove
 * garlic"/"1 slice bread" the primary extractUnit() pass expects. Only tried when that primary pass
 * found no unit at all, and scoped to count-class units: those are the only ones naturally said this
 * way ("2 flour cups" isn't idiomatic, but "1 garlic clove" is extremely common) — without this, "1
 * garlic clove" fell through to a generic 100g count weight, ~30x the real ~3g of a single clove. */
function extractTrailingCountUnit(text: string): { unit: string; rest: string } | null {
	const match = text.match(new RegExp(`^(.+?)\\s+(${COUNT_UNIT_ALIAS_PATTERN})\\b\\.?\\s*$`, 'i'));
	if (!match) return null;
	const unitDef = UNIT_TABLE[match[2]] ?? UNIT_TABLE[match[2].toLowerCase()];
	if (!unitDef) return null;
	return { unit: unitDef.canonical, rest: match[1].trim() };
}

// A container noun ("cans", "boxes", ...) sometimes trails a weight/volume unit that's already fully
// captured the amount, e.g. "2 x 400g cans chopped tomatoes" (800g total, already resolved by the "g").
// Left in place, the leftover container word becomes noise in the ingredient name and blocks matching
// ("cans chopped tomatoes" fails to match "tomatoes, canned, ..."). Only stripped after a weight/volume
// unit — when the unit itself is the container word ("2 cans beans"), it's the real, meaningful unit and
// must not be touched.
const CONTAINER_NOISE_WORDS = ['can', 'cans', 'packet', 'packets', 'box', 'boxes', 'container', 'containers'];
const CONTAINER_NOISE_PATTERN = new RegExp(`^(?:${CONTAINER_NOISE_WORDS.join('|')})\\b\\.?\\s*`, 'i');

// A bare "pinch"/"dash" at the very start of a line names the quantity (1) and the unit at once — e.g.
// "Pinch of salt", "A dash of hot sauce" — unlike every other unit, which only resolves after an
// explicit leading number ("1 tsp salt"). Without this, such lines have no quantity and no unit at all,
// and fall back to a full 100g generic count weight — hugely overstating what's meant to be a trace
// amount (a pinch is ~0.36g, roughly 300x less).
const IMPLICIT_UNIT_WORDS = ['pinch', 'dash'];
const IMPLICIT_UNIT_PATTERN = new RegExp(`^(?:(?:a|an)\\s+)?(${IMPLICIT_UNIT_WORDS.join('|')})(?:es)?\\b\\.?\\s*(?:of\\s+)?`, 'i');

function extractImplicitUnitQuantity(text: string): { quantity: number; unit: string; rest: string } | null {
	const match = text.match(IMPLICIT_UNIT_PATTERN);
	if (!match) return null;
	const unitDef = UNIT_TABLE[match[1].toLowerCase()];
	if (!unitDef) return null;
	return { quantity: 1, unit: unitDef.canonical, rest: text.slice(match[0].length) };
}

/** A separator only counts as a "name — amount" divider when it has whitespace around a dash/em-dash,
 * or immediately follows a colon — so a compound word like "stir-fry" is never mistaken for one. */
const NAME_FIRST_SEPARATOR = /^(.+?)(?:\s+[-–—]\s+|:\s*)(.+)$/;

/** Fallback for lines that don't start with a quantity: "Chicken breast - 500 g", "Rice: 2 cups",
 * "Onion — 1 medium (150 g), finely chopped". Splits at the connector, then parses the right-hand
 * side with the exact same front-anchored logic as a normal line — so anything after the amount
 * (parens, commas, trailing prep notes) is handled uniformly, instead of requiring the amount to be
 * the very last thing on the line. */
function extractNameFirstQuantity(
	text: string,
): { name: string; quantity: number; quantityRange: [number, number] | null; unit: string | null; rest: string } | null {
	const match = text.match(NAME_FIRST_SEPARATOR);
	if (!match) return null;
	const [, name, afterSeparator] = match;
	const { quantity, quantityRange, rest: afterQuantity } = extractQuantity(afterSeparator);
	if (quantity === null) return null;
	const { unit, rest } = extractUnit(afterQuantity);
	return { name: name.trim(), quantity, quantityRange, unit, rest };
}

/** Last-resort fallback for a name directly followed by an amount with no separator at all, e.g.
 * "chopped tomatoes 800g" or "flour 2 cups" — only fires when a recognized unit sits at the very end.
 * A trailing bare number with no unit is too ambiguous to safely reinterpret this way (could be
 * anything), so that case is deliberately left alone; without this, though, a clearly-marked trailing
 * "800g" was silently discarded and replaced with a generic 100g guess. */
function extractTrailingQuantity(text: string): { name: string; quantity: number; unit: string } | null {
	const match = text.match(new RegExp(`^(.+?)\\s+(${QUANTITY_TOKEN})\\s*(${UNIT_ALIAS_PATTERN})\\b\\.?\\s*$`, 'i'));
	if (!match) return null;
	const [, name, qtyToken, unitToken] = match;
	const quantity = parseQuantityToken(qtyToken);
	if (quantity === null) return null;
	const unitDef = UNIT_TABLE[unitToken] ?? UNIT_TABLE[unitToken.toLowerCase()];
	if (!unitDef) return null;
	return { name: name.trim(), quantity, unit: unitDef.canonical };
}

/** A parenthetical giving an explicit weight/volume, e.g. "(150 g)" or "(80–100 g)", is more
 * reliable than a count-based amount read elsewhere on the line ("1 medium", "4 slices") — when
 * present it becomes the ingredient's quantity+unit outright, instead of a generic per-count guess. */
function extractWeightOverride(
	text: string,
): { text: string; quantity: number; quantityRange: [number, number] | null; unit: string } | null {
	const pattern = new RegExp(
		`\\(\\s*(${QUANTITY_TOKEN})(?:\\s*(?:-|–|to)\\s*(${QUANTITY_TOKEN}))?\\s*(${UNIT_ALIAS_PATTERN})\\s*\\)`,
		'i',
	);
	const match = text.match(pattern);
	if (!match) return null;

	const unitDef = UNIT_TABLE[match[3]] ?? UNIT_TABLE[match[3].toLowerCase()];
	if (!unitDef || unitDef.unitClass === 'count') return null; // only a weight/volume figure is worth overriding with

	const a = parseQuantityToken(match[1]);
	if (a === null) return null;
	const b = match[2] ? parseQuantityToken(match[2]) : null;

	return {
		text: (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).replace(/\s+/g, ' ').trim(),
		quantity: b !== null ? (a + b) / 2 : a,
		quantityRange: b !== null ? [a, b] : null,
		unit: unitDef.canonical,
	};
}

// Preparation/ripeness words that describe how an ingredient was cut/handled or its ripeness rather
// than what it is — safe to strip from the name before food-database matching. Deliberately excludes
// words like "ground" that usually name a distinct product in nutrition data (ground beef vs. beef,
// ground cinnamon vs. cinnamon stick), where stripping would change which food gets matched.
const PREP_WORDS = [
	'chopped',
	'diced',
	'minced',
	'grated',
	'sliced',
	'ripe',
	'unripe',
	'overripe',
	'crushed',
	'shredded',
	'peeled',
	'julienned',
	'cubed',
	'melted',
	'softened',
	'beaten',
	'whisked',
	'mashed',
	'trimmed',
	'halved',
	'quartered',
	'zested',
	'juiced',
	'crumbled',
	'sifted',
	'deveined',
	'seeded',
	'cored',
	'pitted',
];
const PREP_ADVERBS = ['finely', 'coarsely', 'roughly', 'thinly', 'thickly', 'freshly', 'loosely'];
const PREP_WORD_PATTERN = `(?:(?:${PREP_ADVERBS.join('|')})\\s+)?(?:${PREP_WORDS.join('|')})`;
const LEADING_PREP = new RegExp(`^${PREP_WORD_PATTERN}\\b\\s*`, 'i');
const TRAILING_PREP = new RegExp(`\\s+${PREP_WORD_PATTERN}$`, 'i');
const CUT_PREP_STRIP_PATTERN = new RegExp(`\\b${PREP_WORD_PATTERN}\\b`, 'gi');

/** Strips pure cut/texture instructions (chopped, diced, softened, ...) anywhere in the text, leaving
 * everything else — including state/processing words like "canned", "cooked", "drained", "rinsed",
 * "frozen" — intact. Those words are noise for a display name but matter for picking the right
 * nutrition-database entry, so they're kept when building a food-matching query. */
function stripCutPrepWords(text: string): string {
	return text.replace(CUT_PREP_STRIP_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

/** Strips a leading or trailing preparation word not already caught by a comma clause,
 * e.g. "chopped tomatoes" -> "tomatoes" (+"chopped" as a note), so it doesn't hurt food matching. */
function extractPreparationWord(text: string): { text: string; prep: string | null } {
	const leading = text.match(LEADING_PREP);
	if (leading) {
		const rest = text.slice(leading[0].length).trim();
		if (rest) return { text: rest, prep: leading[0].trim() };
	}
	const trailing = text.match(TRAILING_PREP);
	if (trailing) {
		const rest = text.slice(0, trailing.index).trim();
		if (rest) return { text: rest, prep: trailing[0].trim() };
	}
	return { text, prep: null };
}

function extractNotes(text: string): { text: string; notes: string | null; matchExtra: string } {
	const notes: string[] = [];
	const withoutParens = text.replace(/\(([^)]*)\)/g, (_m, inner) => {
		notes.push(inner.trim());
		return ' ';
	});
	// Trailing comma clause, e.g. "chicken breast, diced"
	const commaMatch = withoutParens.match(/^([^,]+),\s*(.+)$/);
	let name = withoutParens;
	let commaClause = '';
	if (commaMatch) {
		name = commaMatch[1];
		commaClause = commaMatch[2].trim();
		notes.push(commaClause);
	}

	const { text: nameWithoutPrep, prep } = extractPreparationWord(name.replace(/\s+/g, ' ').trim());
	if (prep) notes.push(prep);

	// The comma clause often carries the food's actual prep/processing state — "chickpeas, drained and
	// rinsed" must match a canned/drained entry, not dried chickpeas; "chicken, cooked, shredded" must
	// match cooked chicken, not raw. Only the cut/texture words are noise for matching, so those are
	// the only thing stripped before it's kept for the match query.
	const matchExtra = commaClause ? stripCutPrepWords(commaClause) : '';

	return {
		text: nameWithoutPrep,
		notes: notes.length > 0 ? notes.join(', ') : null,
		matchExtra,
	};
}

function detectOptional(text: string): boolean {
	const lower = text.toLowerCase();
	return OPTIONAL_PHRASES.some((phrase) => lower.includes(phrase));
}

const SECTION_HEADING_KEYWORDS =
	/^(for the|to serve|to garnish|toppings?|garnish|assembly|filling|topping|crust|base|dressing|marinade|glaze|frosting|icing|method|instructions?|directions?)\b/i;

/** True for recipe section dividers like "FOR THE CHICKEN" or "For the sauce:" — never a real
 * ingredient line, so these are dropped before parsing rather than turned into a bogus zero-quantity
 * ingredient. Any digit rules a line out, since a real ingredient amount always contains one. */
function isSectionHeadingLine(line: string): boolean {
	const trimmed = line.replace(/:\s*$/, '').trim();
	if (trimmed.length === 0 || /\d/.test(trimmed)) return false;
	if (SECTION_HEADING_KEYWORDS.test(trimmed)) return true;
	const letters = trimmed.replace(/[^a-zA-Z]/g, '');
	return letters.length >= 3 && trimmed === trimmed.toUpperCase();
}

// A pasted recipe blog often carries a leading headnote or embedded step ("Preheat your oven to
// 350°F.", "In a large bowl, combine the dry ingredients.") above or between the real ingredient
// lines. Unlike a section heading, these often contain a digit (an oven temperature, a time), so
// isSectionHeadingLine's digit-free guard doesn't catch them — left alone, such a line has no
// leading amount, gets treated as its own "ingredient", and silently becomes a phantom AI-estimated
// line with a fabricated ~100g/0kcal profile folded into the recipe's totals.
const INSTRUCTION_LEADING_VERBS = new Set([
	'preheat',
	'bake',
	'mix',
	'combine',
	'whisk',
	'stir',
	'pour',
	'heat',
	'cook',
	'let',
	'cover',
	'remove',
	'serve',
	'garnish',
	'season',
	'place',
	'transfer',
	'line',
	'grease',
	'fold',
	'beat',
	'chill',
	'refrigerate',
	'freeze',
	'drain',
	'rinse',
	'simmer',
	'boil',
	'reduce',
	'sprinkle',
	'spread',
	'roll',
	'knead',
	'divide',
	'arrange',
	'drizzle',
	'discard',
	'repeat',
	'continue',
	'meanwhile',
	'add',
	'saute',
	'cut',
	'slice',
	'chop',
	'wash',
	'toss',
	'marinate',
	'rest',
	'flip',
	'turn',
	'check',
	'taste',
	'adjust',
	'assemble',
]);
// A real ingredient line is never both digit-free-at-the-start AND this long — a genuine long
// ingredient ("2 cups fresh basil leaves, torn, plus extra for garnish") always starts with its own
// quantity, so the leading-quantity check below still lets it through regardless of word count.
const INSTRUCTIONAL_WORD_COUNT_THRESHOLD = 8;

/** True for a narrative/instructional sentence rather than a real ingredient line — see the verb list
 * above. Requires no parseable leading amount, so a genuinely long or verb-led ingredient line is never
 * mistaken for one as long as it actually starts with (or is introduced by) a real quantity; and never
 * fires on an optional/"to taste" line, which is handled by its own (deliberately permissive) path. */
function isInstructionalLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0 || detectOptional(trimmed)) return false;

	const words = trimmed.split(/\s+/);
	const firstWord = words[0].toLowerCase().replace(/[^a-z-]/g, '');
	const startsWithInstructionVerb = INSTRUCTION_LEADING_VERBS.has(firstWord);
	if (!startsWithInstructionVerb && words.length < INSTRUCTIONAL_WORD_COUNT_THRESHOLD) return false;

	const hasLeadingAmount =
		extractQuantity(trimmed).quantity !== null ||
		extractImplicitUnitQuantity(trimmed) !== null ||
		extractNameFirstQuantity(trimmed) !== null;
	return !hasLeadingAmount;
}

// Matches a bare "salt and/& pepper" line (with optional descriptors on either side and an optional
// trailing "to taste"-style phrase), e.g. "Salt & black pepper", "kosher salt and freshly ground black
// pepper", "Salt and pepper to taste". Scoped to lines with no digit at all (see the caller) — a
// recipe never writes this idiom with a shared amount, so it's always meant as two separate seasonings.
const SALT_AND_PEPPER_IDIOM = /^((?:[a-z]+\s+)*salt)\s*(?:and|&)\s*((?:[a-z]+\s+)*pepper)([\s,]*(?:to taste|as needed|as desired))?\s*$/i;

/** Splits the "salt and pepper" idiom into two independent ingredient lines. Without this, the whole
 * phrase is looked up as a single food and — because a composite USDA dish entry that happens to
 * contain both literal words ("Peppers, sweet, green, cooked, boiled, drained, with salt") scores a
 * perfect coverage match — it wins over either actual seasoning, silently substituting a vegetable
 * side dish for what's actually just salt and pepper. */
function splitSaltAndPepperIdiom(line: string): string[] {
	const match = line.match(SALT_AND_PEPPER_IDIOM);
	if (!match) return [line];
	const suffix = match[3] ? ` ${match[3].replace(/^[\s,]+/, '')}` : '';
	return [`${match[1]}${suffix}`, `${match[2]}${suffix}`];
}

/** Fallback for a whole ingredient list pasted as one comma-separated line instead of one per line,
 * e.g. "500g chicken, 2 cups rice, 1 tbsp olive oil". Deliberately narrow: it only fires when EVERY
 * resulting segment has its own detectable amount — so a single ingredient whose own comma is just a
 * prep note ("1 onion, chopped") is left alone, since "chopped" has no amount of its own. */
function splitCommaSeparatedIngredients(line: string): string[] {
	if (!line.includes(',')) return [line];
	const segments = line
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (segments.length < 2) return [line];

	const eachHasAmount = segments.every((s) => extractQuantity(s).quantity !== null || extractNameFirstQuantity(s) !== null);
	return eachHasAmount ? segments : [line];
}

/** Splits freeform recipe text into candidate ingredient lines. Hard rule: one line in -> at most
 * one ingredient out. No cross-line merging, no splitting one line into several based on a guess —
 * the sole, deliberate exception is a whole comma-separated list pasted onto one line, which only
 * splits when every resulting piece unambiguously has its own amount (see above). Nothing else here
 * tries to fix up a malformed paste, since that guessing is what produced unpredictable results. */
export function splitIntoLines(text: string): string[] {
	return normalizeSpacing(text)
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		// The `.` branch requires the period NOT be followed by a digit, so a decimal quantity like
		// "1.5 scoops" is left alone instead of being misread as a "1. " numbered-list marker.
		.map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\d+(?:\.(?!\d)|\))\s*/, ''))
		.map((l) => l.replace(/[,;]+\s*$/, '').trim()) // trailing "2 cups oats," -> "2 cups oats"
		.filter((l) => l.length > 0)
		.filter((l) => !isSectionHeadingLine(l))
		.filter((l) => !isInstructionalLine(l))
		// Digit-free guard: a line with an explicit shared amount ("1 tsp salt and pepper") doesn't
		// unambiguously split into two amounts, so it's left alone rather than guessed at.
		.flatMap((l) => (/\d/.test(l) ? [l] : splitSaltAndPepperIdiom(l)))
		.flatMap((l) => splitCommaSeparatedIngredients(l));
}

/** Parses a single ingredient line into quantity/unit/name/notes. Tries "amount name" first
 * (the primary supported format), then falls back to "name amount" for lines that don't start
 * with a quantity at all. A parenthetical explicit weight, if present, always wins for the final
 * quantity+unit — see extractWeightOverride. */
// A leading approximation marker ("About 1 cup", "~200g", "approx. 2 tbsp") would otherwise block
// quantity extraction entirely, since none of it is a digit/fraction/word-number — stripped before
// anything else runs so the amount underneath still parses normally.
const APPROX_PREFIX = /^(?:about|approx\.?|approximately)\s+|^~\s*/i;

export function parseIngredientLine(raw: string): ParsedIngredientLine {
	let working = raw.trim().replace(APPROX_PREFIX, '');
	const isOptionalOrToTaste = detectOptional(working);

	const weightOverride = extractWeightOverride(working);
	if (weightOverride) working = weightOverride.text;

	let { quantity, quantityRange, rest: afterQuantity } = extractQuantity(working);
	let unit: string | null = null;
	let nameFirst: string | null = null;

	if (quantity !== null) {
		working = afterQuantity;
		const extractedUnit = extractUnit(working);
		unit = extractedUnit.unit;
		working = extractedUnit.rest;
		// A container word directly after an already-resolved weight/volume unit ("400g cans...") is
		// redundant noise, not a second amount — see CONTAINER_NOISE_PATTERN. When the unit itself IS
		// the container ("2 cans beans", unitClass 'count'), this is skipped, since it's the real unit.
		if (extractedUnit.unitClass && extractedUnit.unitClass !== 'count') {
			working = working.replace(CONTAINER_NOISE_PATTERN, '');
		}
		if (!unit) {
			const trailingUnit = extractTrailingCountUnit(working);
			if (trailingUnit) {
				unit = trailingUnit.unit;
				working = trailingUnit.rest;
			}
		}
	} else {
		const implicitUnit = extractImplicitUnitQuantity(working);
		if (implicitUnit) {
			quantity = implicitUnit.quantity;
			unit = implicitUnit.unit;
			working = implicitUnit.rest;
		} else {
			const fromName = extractNameFirstQuantity(working);
			if (fromName) {
				quantity = fromName.quantity;
				quantityRange = fromName.quantityRange;
				unit = fromName.unit;
				working = fromName.rest;
				nameFirst = fromName.name;
			} else {
				const fromTrailing = extractTrailingQuantity(working);
				if (fromTrailing) {
					quantity = fromTrailing.quantity;
					unit = fromTrailing.unit;
					working = '';
					nameFirst = fromTrailing.name;
				}
			}
		}
	}

	// "of" connector, e.g. "1 cup of flour"
	working = working.replace(/^of\s+/i, '');

	// Drop "to taste" / "optional" / etc. from the name itself so it doesn't hurt food-database
	// matching, e.g. "salt to taste" -> "salt" (isOptionalOrToTaste is already recorded above).
	if (isOptionalOrToTaste) {
		for (const phrase of OPTIONAL_PHRASES) {
			working = working.replace(new RegExp(`\\s*,?\\s*${escapeRegExp(phrase)}\\b`, 'gi'), '');
		}
		working = working.trim();
	}

	const { text: leftoverName, notes: leftoverNotes, matchExtra: leftoverMatchExtra } = extractNotes(working);

	// When the food name came from before a "name — amount" separator, anything left over after
	// pulling the amount out of the right-hand side (e.g. "medium" from "1 medium (150 g)") is a
	// descriptor, not the name — it goes into notes instead of overwriting the real name.
	let ingredientName: string;
	let notes: string | null;
	let matchExtra: string;
	if (nameFirst) {
		// A leading/trailing cut-prep word can end up inside `nameFirst` itself (e.g. "chopped tomatoes"
		// from extractTrailingQuantity) exactly as it can in the primary quantity-first flow — strip it
		// the same way so it doesn't block matching (e.g. "chopped tomatoes" -> "tomatoes").
		const { text: nameFirstWithoutPrep, prep: nameFirstPrep } = extractPreparationWord(nameFirst);
		ingredientName = nameFirstWithoutPrep;
		notes = [nameFirstPrep, leftoverName, leftoverNotes].filter((s) => s && s.length > 0).join(', ') || null;
		// Neither piece is part of the food's identity here (that's already `nameFirst`) — both are
		// pure descriptors, so both can carry a prep/processing state relevant to matching, e.g.
		// "Chickpeas: 1/2 cup drained and rinsed" puts "drained and rinsed" in `leftoverName` itself.
		matchExtra = [stripCutPrepWords(leftoverName), leftoverMatchExtra].filter((s) => s && s.length > 0).join(' ');
	} else {
		ingredientName = leftoverName || working.trim();
		notes = leftoverNotes;
		matchExtra = leftoverMatchExtra;
	}

	if (weightOverride) {
		quantity = weightOverride.quantity;
		quantityRange = weightOverride.quantityRange;
		unit = weightOverride.unit;
	}

	// "Butter or margarine" -> match on "butter" alone; the alternative is noted, not merged into a
	// two-food query that would never match anything as a single entry. Doesn't handle a shared
	// trailing word ("orange or lemon zest") — a narrow, deliberate limitation, not a general "or"
	// grammar parser.
	const orMatch = ingredientName.match(/^(.+?)\s+or\s+(.+)$/i);
	if (orMatch) {
		ingredientName = orMatch[1].trim();
		notes = [notes, `or ${orMatch[2].trim()}`].filter((s) => s && s.length > 0).join(', ') || null;
	}

	const matchName = stripMatchNoise([ingredientName, matchExtra].filter((s) => s && s.length > 0).join(' ').trim());

	return {
		raw,
		quantity,
		quantityRange,
		unit,
		ingredientName,
		matchName: matchName || ingredientName,
		notes,
		isOptionalOrToTaste,
	};
}

/** Parses freeform recipe text (paste, OCR output, or URL-extracted ingredient strings) into structured lines. */
export function parseIngredients(text: string): ParsedIngredientLine[] {
	return splitIntoLines(text).map(parseIngredientLine);
}

export interface FormatCheckResult {
	ok: boolean;
	reason?: string;
	unparsedExamples?: string[];
	/** True only when there's nothing to calculate at all — callers should stop the user from
	 * submitting. False (or absent) means the format looks off but there's still something to
	 * work with, so callers should warn and let the calculation proceed. */
	blocking?: boolean;
}

/** Best-effort sanity check: if most lines have no detectable quantity at all, the paste is probably
 * malformed rather than just containing a few "salt to taste"-style items. Only the empty-input case
 * blocks calculation outright; a bad-but-nonempty format just gets flagged as a warning, since a
 * best-effort result is more useful than none. */
export function checkIngredientTextFormat(text: string): FormatCheckResult {
	const lines = parseIngredients(text);
	if (lines.length === 0) {
		return { ok: false, blocking: true, reason: 'Add at least one ingredient line.' };
	}

	const unparsed = lines.filter((l) => l.quantity === null && l.quantityRange === null && !l.isOptionalOrToTaste);

	if (unparsed.length / lines.length > 0.5) {
		return {
			ok: false,
			reason:
				'We couldn\'t find an amount on most lines. Each line needs to be one ingredient, written as "amount unit ingredient" — for example "500g basmati rice" or "2 cups flour".',
			unparsedExamples: unparsed.slice(0, 3).map((l) => l.raw),
		};
	}

	return { ok: true };
}
