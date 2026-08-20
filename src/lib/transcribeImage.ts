// Verified against Cloudflare's model catalog at implementation time; re-check
// developers.cloudflare.com/workers-ai/models/ if this ever needs swapping —
// the catalog moves and model listings churn.
const OCR_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Sentinel the OCR prompt asks the model to return verbatim when it can't find real ingredient text —
// distinct from an empty response, which the model rarely gives even for a blank image (see
// transcribeOnce's temperature/prompt comments for why this is needed at all).
const NO_TEXT_SENTINEL = 'NONE';

// A hallucinated transcription of a blank/illegible image is measurably UNSTABLE across repeated calls,
// even at temperature 0.1 — the model invents a different plausible-looking grocery list nearly every
// time — while a genuine transcription of real printed/handwritten text comes back essentially the same
// each time. A single low-temperature call alone isn't sufficient: it was observed still confidently
// hallucinating a fake ingredient list for a plain blank-white image instead of ever emitting
// NO_TEXT_SENTINEL, a regression of an earlier attempt at this same fix (see git history — "fix: OCR
// hallucination"). Requiring two independent transcriptions of the same image to substantially agree
// catches what the sentinel alone misses, at the cost of a second Workers AI call per photo upload — an
// acceptable trade for a path that otherwise silently feeds fabricated ingredients into a nutrition
// calculation.
const TRANSCRIPTION_AGREEMENT_THRESHOLD = 0.5;

async function transcribeOnce(ai: Ai, bytes: Uint8Array): Promise<string> {
	const aiResult = (await ai.run(OCR_MODEL, {
		image: Array.from(bytes),
		prompt:
			'Transcribe every recipe ingredient line from this image exactly as written, one ingredient per line. Output only the ingredient lines — no commentary, no headings. ' +
			`If the image is blank, unclear, or does not actually contain any legible recipe ingredient text, respond with exactly the single word ${NO_TEXT_SENTINEL} and nothing else — never invent or guess ingredients that aren't really there.`,
		max_tokens: 1024,
		// Near-zero temperature: this is a transcription task, not a creative one, and a low temperature
		// measurably cuts down on the model inventing a plausible-looking ingredient list for a
		// blank/unreadable image instead of admitting it can't read anything — though not enough on its
		// own, see TRANSCRIPTION_AGREEMENT_THRESHOLD above.
		temperature: 0.1,
	})) as { response?: string; description?: string };
	return (aiResult.response ?? aiResult.description ?? '').trim();
}

// Case/punctuation-loose on purpose: models don't always echo a bare token back verbatim (e.g. "NONE."
// or trailing commentary despite the instruction) — a strict equality check would let those slip
// through as if they were real transcribed text.
function isNoTextSentinel(text: string): boolean {
	return new RegExp(`^${NO_TEXT_SENTINEL}\\b`, 'i').test(text);
}

// Line-set Jaccard similarity between two transcriptions of the same image — order-independent and
// tolerant of trivial punctuation/whitespace differences a genuine re-transcription can introduce,
// while still catching the "two completely different invented grocery lists" signature of a
// hallucinated read (see TRANSCRIPTION_AGREEMENT_THRESHOLD above).
export function transcriptionAgreement(a: string, b: string): number {
	const normalize = (text: string) =>
		new Set(
			text
				.toLowerCase()
				.split('\n')
				.map((line) => line.replace(/[^a-z0-9\s]/g, '').trim())
				.filter(Boolean),
		);
	const setA = normalize(a);
	const setB = normalize(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	let intersection = 0;
	for (const line of setA) if (setB.has(line)) intersection++;
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 1 : intersection / union;
}

/** Combines two independent low-temperature transcriptions of the same image into one trusted result,
 * or '' when either call reported no text or the two disagree enough to look hallucinated rather than
 * genuinely re-read — see TRANSCRIPTION_AGREEMENT_THRESHOLD above. */
export function resolveTranscription(first: string, second: string): string {
	if (!first || !second || isNoTextSentinel(first) || isNoTextSentinel(second)) return '';
	if (transcriptionAgreement(first, second) < TRANSCRIPTION_AGREEMENT_THRESHOLD) return '';
	return first;
}

/** Runs two independent low-temperature OCR transcriptions of the same image in parallel and combines
 * them into one trusted result — '' when no legible ingredient text was found, or the two reads
 * disagree enough to look hallucinated rather than a genuine re-read of the same page. */
export async function transcribeIngredientImage(bytes: Uint8Array, ai: Ai): Promise<string> {
	const [first, second] = await Promise.all([transcribeOnce(ai, bytes), transcribeOnce(ai, bytes)]);
	return resolveTranscription(first, second);
}
