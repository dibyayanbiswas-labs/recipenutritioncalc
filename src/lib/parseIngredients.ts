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

	// Single quantity token — followed by whitespace, or the end of the string ("500" with nothing after).
	const singleMatch = text.match(new RegExp(`^(${QUANTITY_TOKEN})(?:\\s+|$)`));
	if (singleMatch) {
		const q = parseQuantityToken(singleMatch[1]);
		if (q !== null) {
			return { quantity: q, quantityRange: null, rest: text.slice(singleMatch[0].length) };
		}
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

/** Same idea as extractQuantity, but anchored to the END of the string — for "basmati rice 500 g" (name-then-amount). */
function extractQuantityUnitFromEnd(text: string): { quantity: number; unit: string | null; rest: string } | null {
	const match = text.match(new RegExp(`(${QUANTITY_TOKEN})\\s*(${UNIT_ALIAS_PATTERN})?\\s*$`, 'i'));
	if (!match) return null;
	const quantity = parseQuantityToken(match[1]);
	if (quantity === null) return null;

	let unit: string | null = null;
	if (match[2]) {
		const alias = match[2].toLowerCase();
		const def = UNIT_TABLE[alias] ?? UNIT_TABLE[match[2]];
		if (def) unit = def.canonical;
	}

	const rest = text.slice(0, match.index).trim();
	if (!rest) return null; // nothing left to call an ingredient name — not a useful match
	return { quantity, unit, rest };
}

function extractUnit(text: string): { unit: string | null; rest: string } {
	const match = text.match(new RegExp(`^(${UNIT_ALIAS_PATTERN})\\b\\.?(?:\\s+|$)`, 'i'));
	if (match) {
		const alias = match[1].toLowerCase();
		const def = UNIT_TABLE[alias] ?? UNIT_TABLE[match[1]];
		if (def) {
			return { unit: def.canonical, rest: text.slice(match[0].length) };
		}
	}
	return { unit: null, rest: text };
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
	return {
		text: name.replace(/\s+/g, ' ').trim(),
		notes: notes.length > 0 ? notes.join(', ') : null,
	};
}

function detectOptional(text: string): boolean {
	const lower = text.toLowerCase();
	return OPTIONAL_PHRASES.some((phrase) => lower.includes(phrase));
}

/** True if the whole line is nothing but a quantity (+ optional unit) — e.g. "500g" on its own line. */
function isQuantityOnlyLine(line: string): boolean {
	const { quantity, rest } = extractQuantity(line);
	if (quantity === null) return false;
	const { rest: afterUnit } = extractUnit(rest.trim());
	return afterUnit.trim().length === 0;
}

/** Splits a line that turns out to contain several "name amount unit" ingredients run together
 * (e.g. after normalizeSpacing collapses "basmati rice500g chicken500g" onto one line) into one
 * chunk per amount, each ending right after its unit. Only called on lines that don't already
 * start with a quantity, so normal "2 cups flour" lines are never touched by this. */
function splitConcatenatedIngredients(line: string): string[] {
	// The QUANTITY_TOKEN alternation only matches actual numeric/fraction text, so every match here
	// is already a valid amount — no extra validation needed.
	const re = new RegExp(`(?:${QUANTITY_TOKEN})\\s*(?:${UNIT_ALIAS_PATTERN})?`, 'gi');
	const matches = [...line.matchAll(re)];
	if (matches.length <= 1) return [line];

	const chunks: string[] = [];
	let cursor = 0;
	for (const m of matches) {
		const end = (m.index ?? 0) + m[0].length;
		chunks.push(line.slice(cursor, end).trim());
		cursor = end;
	}
	const trailing = line.slice(cursor).trim();
	if (trailing && chunks.length > 0) chunks[chunks.length - 1] += ' ' + trailing;
	return chunks.filter((c) => c.length > 0);
}

/** Splits freeform recipe text (or OCR output) into individual candidate ingredient lines, tolerating
 * a few common malformed pastes: name and amount on separate lines, or a whole recipe run together
 * with no separators at all ("basmati rice500g chicken500g"). */
export function splitIntoLines(text: string): string[] {
	const rawLines = normalizeSpacing(text)
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''));

	// "basmati rice" / "500g" on consecutive lines -> merge into "basmati rice 500g".
	const merged: string[] = [];
	for (const line of rawLines) {
		const prev = merged[merged.length - 1];
		if (isQuantityOnlyLine(line) && prev !== undefined && extractQuantity(prev).quantity === null) {
			merged[merged.length - 1] = `${prev} ${line}`;
		} else {
			merged.push(line);
		}
	}

	// A line that already parses as quantity-first ("2 cups flour") is left alone. Only lines that
	// don't start with a quantity get checked for multiple concatenated ingredients.
	const final: string[] = [];
	for (const line of merged) {
		if (extractQuantity(line).quantity !== null) {
			final.push(line);
		} else {
			final.push(...splitConcatenatedIngredients(line));
		}
	}
	return final;
}

/** Parses a single ingredient line into quantity/unit/name/notes. Tries "amount name" first
 * (the primary supported format), then falls back to "name amount" for lines that don't start
 * with a quantity at all. */
export function parseIngredientLine(raw: string): ParsedIngredientLine {
	let working = raw.trim();
	const isOptionalOrToTaste = detectOptional(working);

	let { quantity, quantityRange, rest: afterQuantity } = extractQuantity(working);
	let unit: string | null = null;

	if (quantity !== null) {
		working = afterQuantity;
		const extractedUnit = extractUnit(working);
		unit = extractedUnit.unit;
		working = extractedUnit.rest;
	} else {
		const fromEnd = extractQuantityUnitFromEnd(working);
		if (fromEnd) {
			quantity = fromEnd.quantity;
			unit = fromEnd.unit;
			working = fromEnd.rest;
		}
	}

	// "of" connector, e.g. "1 cup of flour"
	working = working.replace(/^of\s+/i, '');

	const { text: ingredientName, notes } = extractNotes(working);

	return {
		raw,
		quantity,
		quantityRange,
		unit,
		ingredientName: ingredientName || working.trim(),
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
}

/** Best-effort sanity check: if most lines have no detectable quantity at all, the paste is probably
 * malformed rather than just containing a few "salt to taste"-style items. Used to block calculation
 * with actionable feedback instead of silently producing a mostly-empty result. */
export function checkIngredientTextFormat(text: string): FormatCheckResult {
	const lines = parseIngredients(text);
	if (lines.length === 0) {
		return { ok: false, reason: 'Add at least one ingredient line.' };
	}

	const unparsed = lines.filter((l) => l.quantity === null && l.quantityRange === null && !l.isOptionalOrToTaste);

	if (unparsed.length / lines.length > 0.5) {
		return {
			ok: false,
			reason:
				"We couldn't find an amount for most of these lines. Try one ingredient per line, formatted as \"amount unit ingredient\" — for example \"500g basmati rice\" or \"2 cups flour\".",
			unparsedExamples: unparsed.slice(0, 3).map((l) => l.raw),
		};
	}

	return { ok: true };
}
