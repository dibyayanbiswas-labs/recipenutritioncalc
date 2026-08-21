import { defineAction, ActionError, type ActionAPIContext } from 'astro:actions';
import { z } from 'astro/zod';
import { env } from 'cloudflare:workers';
import { analyzeIngredientLines, analyzeRecipeText, buildNutritionResult } from '../lib/nutrients';
import { checkIngredientTextFormat, parseIngredientLine } from '../lib/parseIngredients';
import { extractRecipeFromUrl } from '../lib/schemaOrgRecipe';
import { generateResultId, saveResult } from '../lib/kv';
import { transcribeIngredientImage } from '../lib/transcribeImage';
import { TURNSTILE_ACTIONS, verifyTurnstileToken } from '../lib/turnstile';

// A full-resolution mobile camera photo can be several MB — read into a Uint8Array and then spread into
// a plain number array for the AI binding (see transcribeIngredientImage), that's easily enough to
// exceed the Worker's memory limit ("exceeded maximum capacity") before the model ever sees it. The
// client resizes photos above this size before upload (see PhotoUploadForm.astro), so this is a safety
// net for whatever gets here anyway — a non-JS client, or a resize that silently failed — returning a
// clear error instead of risking an out-of-memory crash.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Verifies the Turnstile token attached to a form submission before its handler does any real
 * work, throwing a FORBIDDEN ActionError on failure. Skipped in local dev (`astro dev`), where
 * TURNSTILE_SECRET is never configured — see src/types/env.d.ts. */
async function requireHuman(token: unknown, action: string, context: ActionAPIContext): Promise<void> {
	if (import.meta.env.DEV) return;
	const ok = await verifyTurnstileToken(token, env.TURNSTILE_SECRET, action, context.clientAddress);
	if (!ok) {
		throw new ActionError({ code: 'FORBIDDEN', message: 'Verification failed — please refresh the page and try again.' });
	}
}

/** Throttles a single client's submissions across all 4 recipe-analysis actions (they share one
 * budget — spreading a burst across paste/url/manual/photo shouldn't dodge the limit). Not run in
 * local dev: there's only ever one client hitting `astro dev`, and the binding isn't worth wiring
 * up for a single-developer loop. */
async function requireUnderRateLimit(context: ActionAPIContext): Promise<void> {
	if (import.meta.env.DEV) return;
	const { success } = await env.SUBMIT_RATE_LIMITER.limit({ key: context.clientAddress });
	if (!success) {
		throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: "You're submitting a bit fast — wait a moment and try again." });
	}
}

export const server = {
	analyzeText: defineAction({
		accept: 'form',
		input: z.object({
			// Astro's form-data parsing turns an empty-string field into `null` before Zod ever sees it,
			// which would otherwise fail the base `z.string()` check with a raw "expected string,
			// received null" error instead of the friendly message below — preprocess it back to ''.
			text: z.preprocess((v) => v ?? '', z.string().min(1, 'Paste some ingredients first.')),
			servings: z.coerce.number().min(1, 'Servings must be at least 1.').max(100, 'Servings can be at most 100.').default(1),
			title: z.string().optional(),
			'cf-turnstile-response': z.preprocess((v) => v ?? '', z.string()),
		}),
		handler: async ({ text, servings, title, 'cf-turnstile-response': turnstileToken }, context) => {
			await requireUnderRateLimit(context);
			await requireHuman(turnstileToken, TURNSTILE_ACTIONS.pasteText, context);

			const formatCheck = checkIngredientTextFormat(text);
			if (!formatCheck.ok && formatCheck.blocking) {
				throw new ActionError({ code: 'BAD_REQUEST', message: formatCheck.reason ?? 'That format is hard to read.' });
			}

			const id = generateResultId();
			const result = await analyzeRecipeText({
				id,
				title: title?.trim() || 'My recipe',
				text,
				servings,
				createdAt: Date.now(),
				ai: env.AI,
				kv: env.RESULTS_KV,
				formatWarning: formatCheck.ok ? null : (formatCheck.reason ?? null),
			});
			await saveResult(env.RESULTS_KV, result);
			return result;
		},
	}),

	analyzeUrl: defineAction({
		accept: 'form',
		input: z.object({
			// Same empty-field-becomes-null issue as analyzeText.text — see the comment there.
			url: z.preprocess((v) => v ?? '', z.url('Enter a valid recipe URL.')),
			servingsOverride: z.coerce
				.number()
				.min(1, 'Servings must be at least 1.')
				.max(100, 'Servings can be at most 100.')
				.optional(),
			'cf-turnstile-response': z.preprocess((v) => v ?? '', z.string()),
		}),
		handler: async ({ url, servingsOverride, 'cf-turnstile-response': turnstileToken }, context) => {
			await requireUnderRateLimit(context);
			await requireHuman(turnstileToken, TURNSTILE_ACTIONS.url, context);

			const extracted = await extractRecipeFromUrl(url);
			if (!extracted.ok) {
				throw new ActionError({ code: 'BAD_REQUEST', message: extracted.reason });
			}

			const id = generateResultId();
			const text = extracted.recipe.ingredientLines.join('\n');
			// A scraped recipeYield of exactly 1 is frequently a whole-dish count mislabeled as a
			// serving count (e.g. a page's schema.org data giving bare "1" for "1 loaf"/"1 batch"/"1
			// pie" — the unit word usually isn't even preserved in the machine-readable yield, so
			// there's no way to detect the specific case, only the general pattern) rather than a
			// genuinely single-serving recipe. Surfacing this only when the user hasn't already
			// overridden it themselves.
			const servingsIsUnverifiedSingleYield = !servingsOverride && extracted.recipe.servings === 1;
			const result = await analyzeRecipeText({
				id,
				title: extracted.recipe.title,
				text,
				servings: servingsOverride ?? extracted.recipe.servings,
				sourceUrl: url,
				createdAt: Date.now(),
				ai: env.AI,
				kv: env.RESULTS_KV,
				formatWarning: servingsIsUnverifiedSingleYield
					? "This recipe's source page lists its yield as 1 — that's often a whole dish (e.g. \"1 loaf\" or \"1 batch\"), not a single serving. Double-check and adjust the servings count if needed."
					: null,
			});
			await saveResult(env.RESULTS_KV, result);
			return result;
		},
	}),

	analyzeManual: defineAction({
		accept: 'form',
		input: z.object({
			title: z.string().optional(),
			servings: z.coerce.number().min(1, 'Servings must be at least 1.').max(100, 'Servings can be at most 100.').default(1),
			quantity: z.array(z.string()),
			unit: z.array(z.string()),
			name: z.array(z.string()),
			'cf-turnstile-response': z.preprocess((v) => v ?? '', z.string()),
		}),
		handler: async ({ title, servings, quantity, unit, name, 'cf-turnstile-response': turnstileToken }, context) => {
			await requireUnderRateLimit(context);
			await requireHuman(turnstileToken, TURNSTILE_ACTIONS.manual, context);

			const id = generateResultId();
			const lines = name
				.map((n, i) => ({ quantity: quantity[i] ?? '', unit: unit[i] ?? '', name: n }))
				.filter((r) => r.name.trim().length > 0)
				.map((r) => parseIngredientLine([r.quantity, r.unit, r.name].filter(Boolean).join(' ').trim()));

			if (lines.length === 0) {
				throw new ActionError({ code: 'BAD_REQUEST', message: 'Add at least one ingredient.' });
			}

			const ingredients = await analyzeIngredientLines(lines, env.AI, env.RESULTS_KV);
			const result = buildNutritionResult({
				id,
				title: title?.trim() || 'My recipe',
				servings,
				ingredients,
				createdAt: Date.now(),
			});
			await saveResult(env.RESULTS_KV, result);
			return result;
		},
	}),

	transcribeImage: defineAction({
		accept: 'form',
		input: z.object({
			image: z.instanceof(File),
			'cf-turnstile-response': z.preprocess((v) => v ?? '', z.string()),
		}),
		handler: async ({ image, 'cf-turnstile-response': turnstileToken }, context) => {
			await requireUnderRateLimit(context);
			await requireHuman(turnstileToken, TURNSTILE_ACTIONS.photo, context);

			if (!image.type.startsWith('image/')) {
				throw new ActionError({ code: 'BAD_REQUEST', message: 'Please upload an image file.' });
			}
			if (image.size > MAX_IMAGE_BYTES) {
				throw new ActionError({
					code: 'BAD_REQUEST',
					message: 'That image is too large (max 8MB). Try a smaller photo, or paste the ingredients instead.',
				});
			}

			const bytes = new Uint8Array(await image.arrayBuffer());
			let text: string;
			try {
				text = await transcribeIngredientImage(bytes, env.AI);
			} catch (err) {
				// Logged so the real cause (e.g. no local Workers AI emulation — see astro.config.mjs) is
				// visible in `astro dev logs` / `wrangler tail`, instead of only the generic message below.
				console.error('transcribeImage: Workers AI call failed', err);
				throw new ActionError({
					code: 'INTERNAL_SERVER_ERROR',
					message: "Couldn't read that photo. Try a clearer image or paste the ingredients instead.",
				});
			}

			if (!text) {
				throw new ActionError({
					code: 'UNPROCESSABLE_CONTENT',
					message: "Couldn't find any ingredient text in that photo. Try a clearer image or paste the ingredients instead.",
				});
			}

			return { text };
		},
	}),
};
