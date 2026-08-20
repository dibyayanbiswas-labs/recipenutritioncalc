export interface ExtractedRecipe {
	title: string;
	ingredientLines: string[];
	servings: number;
}

export type SchemaOrgExtractResult = { ok: true; recipe: ExtractedRecipe } | { ok: false; reason: string };

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 3_000_000;

function isSafeUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function findRecipeNode(json: unknown): any | null {
	if (json == null) return null;
	if (Array.isArray(json)) {
		for (const item of json) {
			const found = findRecipeNode(item);
			if (found) return found;
		}
		return null;
	}
	if (typeof json !== 'object') return null;
	const obj = json as Record<string, unknown>;

	const type = obj['@type'];
	const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
	if (isRecipe) return obj;

	if (Array.isArray(obj['@graph'])) {
		const found = findRecipeNode(obj['@graph']);
		if (found) return found;
	}
	return null;
}

function parseServings(recipeYield: unknown): number {
	if (typeof recipeYield === 'number') return recipeYield;
	if (Array.isArray(recipeYield)) return parseServings(recipeYield[0]);
	if (typeof recipeYield === 'string') {
		const match = recipeYield.match(/\d+/);
		if (match) return Number(match[0]);
	}
	return 1;
}

/** Fetches a recipe URL server-side and extracts ingredients from embedded schema.org Recipe JSON-LD. v1 is JSON-LD-only. */
export async function extractRecipeFromUrl(rawUrl: string): Promise<SchemaOrgExtractResult> {
	if (!isSafeUrl(rawUrl)) {
		return { ok: false, reason: 'Please enter a valid http(s) URL.' };
	}

	let html: string;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const response = await fetch(rawUrl, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; RecipeNutritionCalcBot/1.0)',
			},
		});
		clearTimeout(timeout);
		if (!response.ok) {
			if (response.status === 403 || response.status === 401) {
				return {
					ok: false,
					reason: 'This site is blocking automated requests, so we can\'t fetch that page. Open it in your browser, copy the ingredient list, and use Paste text instead.',
				};
			}
			return { ok: false, reason: `Couldn't fetch that page (status ${response.status}).` };
		}
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > MAX_HTML_BYTES) {
			return { ok: false, reason: 'That page is too large to analyze.' };
		}
		html = new TextDecoder().decode(buffer);
	} catch {
		return { ok: false, reason: "Couldn't fetch that page. Check the URL and try again." };
	}

	// The type attribute's quotes are optional here — unquoted HTML attribute values are valid HTML
	// and common in the wild (e.g. Yoast SEO, used by a large share of WordPress recipe sites, emits
	// `<script type=application/ld+json class=yoast-schema-graph>` with no quotes at all).
	const scriptMatches = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];

	for (const match of scriptMatches) {
		try {
			const json = JSON.parse(match[1].trim());
			const recipeNode = findRecipeNode(json);
			if (recipeNode) {
				const ingredientLines: string[] = Array.isArray(recipeNode.recipeIngredient)
					? recipeNode.recipeIngredient.filter((s: unknown) => typeof s === 'string')
					: [];
				if (ingredientLines.length > 0) {
					return {
						ok: true,
						recipe: {
							title: typeof recipeNode.name === 'string' ? recipeNode.name : 'Imported recipe',
							ingredientLines,
							servings: parseServings(recipeNode.recipeYield),
						},
					};
				}
			}
		} catch {
			// malformed JSON-LD block, try the next one
		}
	}

	return {
		ok: false,
		reason: "We couldn't find structured recipe data on that page. Try pasting the ingredient list directly instead.",
	};
}
