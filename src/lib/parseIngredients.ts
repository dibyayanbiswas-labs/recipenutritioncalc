import { UNICODE_FRACTIONS, UNIT_ALIASES, UNIT_TABLE, OPTIONAL_PHRASES } from './units';

export interface ParsedIngredientLine {
	raw: string;
	quantity: number | null;
	quantityRange: [number, number] | null;
	unit: string | null;
	ingredientName: string;
	notes: string | null;
	isOptionalOrToTaste: boolean;
}

const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');
const UNIT_ALIAS_PATTERN = UNIT_ALIASES.map(escapeRegExp).join('|');

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function extractUnit(text: string): { unit: string | null; rest: string } {
	const match = text.match(new RegExp(`^(${UNIT_ALIAS_PATTERN})\\b\\.?(?:\\s+|$)`, 'i'));
	if (match) {
		// Exact case checked first: "T" (tablespoon) and "t" (teaspoon) are distinct, meaningful
		// aliases — lowercasing before the lookup would collapse both onto "t" (teaspoon) always.
		const def = UNIT_TABLE[match[1]] ?? UNIT_TABLE[match[1].toLowerCase()];
		if (def) {
			return { unit: def.canonical, rest: text.slice(match[0].length) };
		}
	}
	return { unit: null, rest: text };
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

// Preparation words that describe how an ingredient was cut/handled rather than what it is —
// safe to strip from the name before food-database matching. Deliberately excludes words like
// "ground" that usually name a distinct product in nutrition data (ground beef vs. beef, ground
// cinnamon vs. cinnamon stick), where stripping would change which food gets matched.
const PREP_WORDS = [
	'chopped',
	'diced',
	'minced',
	'grated',
	'sliced',
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

function extractNotes(text: string): { text: string; notes: string | null } {
	const notes: string[] = [];
	const withoutParens = text.replace(/\(([^)]*)\)/g, (_m, inner) => {
		notes.push(inner.trim());
		return ' ';
	});
	// Trailing comma clause, e.g. "chicken breast, diced"
	const commaMatch = withoutParens.match(/^([^,]+),\s*(.+)$/);
	let name = withoutParens;
	if (commaMatch) {
		name = commaMatch[1];
		notes.push(commaMatch[2].trim());
	}

	const { text: nameWithoutPrep, prep } = extractPreparationWord(name.replace(/\s+/g, ' ').trim());
	if (prep) notes.push(prep);

	return {
		text: nameWithoutPrep,
		notes: notes.length > 0 ? notes.join(', ') : null,
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
	} else {
		const fromName = extractNameFirstQuantity(working);
		if (fromName) {
			quantity = fromName.quantity;
			quantityRange = fromName.quantityRange;
			unit = fromName.unit;
			working = fromName.rest;
			nameFirst = fromName.name;
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

	const { text: leftoverName, notes: leftoverNotes } = extractNotes(working);

	// When the food name came from before a "name — amount" separator, anything left over after
	// pulling the amount out of the right-hand side (e.g. "medium" from "1 medium (150 g)") is a
	// descriptor, not the name — it goes into notes instead of overwriting the real name.
	let ingredientName: string;
	let notes: string | null;
	if (nameFirst) {
		ingredientName = nameFirst;
		notes = [leftoverName, leftoverNotes].filter((s) => s && s.length > 0).join(', ') || null;
	} else {
		ingredientName = leftoverName || working.trim();
		notes = leftoverNotes;
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

	return {
		raw,
		quantity,
		quantityRange,
		unit,
		ingredientName,
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
