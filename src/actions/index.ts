import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro/zod';
import { env } from 'cloudflare:workers';
import { analyzeIngredientLines, analyzeRecipeText, buildNutritionResult } from '../lib/nutrients';
import { checkIngredientTextFormat, parseIngredientLine } from '../lib/parseIngredients';
import { extractRecipeFromUrl } from '../lib/schemaOrgRecipe';
import { generateResultId, saveResult } from '../lib/kv';

// Verified against Cloudflare's model catalog at implementation time; re-check
// developers.cloudflare.com/workers-ai/models/ if this ever needs swapping —
// the catalog moves and model listings churn.
const OCR_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export const server = {
	analyzeText: defineAction({
		accept: 'form',
		input: z.object({
			text: z.string().min(1, 'Paste some ingredients first.'),
			servings: z.coerce.number().min(1).max(100).default(1),
			title: z.string().optional(),
		}),
		handler: async ({ text, servings, title }) => {
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
				formatWarning: formatCheck.ok ? null : (formatCheck.reason ?? null),
			});
			await saveResult(env.RESULTS_KV, result);
			return result;
		},
	}),

	analyzeUrl: defineAction({
		accept: 'form',
		input: z.object({
			url: z.url('Enter a valid recipe URL.'),
			servingsOverride: z.coerce.number().min(1).max(100).optional(),
		}),
		handler: async ({ url, servingsOverride }) => {
			const extracted = await extractRecipeFromUrl(url);
			if (!extracted.ok) {
				throw new ActionError({ code: 'BAD_REQUEST', message: extracted.reason });
			}

			const id = generateResultId();
			const text = extracted.recipe.ingredientLines.join('\n');
			const result = await analyzeRecipeText({
				id,
				title: extracted.recipe.title,
				text,
				servings: servingsOverride ?? extracted.recipe.servings,
				sourceUrl: url,
				createdAt: Date.now(),
				ai: env.AI,
			});
			await saveResult(env.RESULTS_KV, result);
			return result;
		},
	}),

	analyzeManual: defineAction({
		accept: 'form',
		input: z.object({
			title: z.string().optional(),
			servings: z.coerce.number().min(1).max(100).default(1),
			quantity: z.array(z.string()),
			unit: z.array(z.string()),
			name: z.array(z.string()),
		}),
		handler: async ({ title, servings, quantity, unit, name }) => {
			const id = generateResultId();
			const lines = name
				.map((n, i) => ({ quantity: quantity[i] ?? '', unit: unit[i] ?? '', name: n }))
				.filter((r) => r.name.trim().length > 0)
				.map((r) => parseIngredientLine([r.quantity, r.unit, r.name].filter(Boolean).join(' ').trim()));

			if (lines.length === 0) {
				throw new ActionError({ code: 'BAD_REQUEST', message: 'Add at least one ingredient.' });
			}

			const ingredients = await analyzeIngredientLines(lines, env.AI);
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
		}),
		handler: async ({ image }) => {
			if (!image.type.startsWith('image/')) {
				throw new ActionError({ code: 'BAD_REQUEST', message: 'Please upload an image file.' });
			}

			const bytes = new Uint8Array(await image.arrayBuffer());
			let text: string;
			try {
				const aiResult = (await env.AI.run(OCR_MODEL, {
					image: Array.from(bytes),
					prompt:
						'Transcribe every recipe ingredient line from this image exactly as written, one ingredient per line. Output only the ingredient lines — no commentary, no headings.',
					max_tokens: 1024,
				})) as { response?: string; description?: string };
				text = aiResult.response ?? aiResult.description ?? '';
			} catch (err) {
				// Logged so the real cause (e.g. no local Workers AI emulation — see astro.config.mjs) is
				// visible in `astro dev logs` / `wrangler tail`, instead of only the generic message below.
				console.error('transcribeImage: Workers AI call failed', err);
				throw new ActionError({
					code: 'INTERNAL_SERVER_ERROR',
					message: "Couldn't read that photo. Try a clearer image or paste the ingredients instead.",
				});
			}

			if (!text.trim()) {
				throw new ActionError({
					code: 'UNPROCESSABLE_CONTENT',
					message: "Couldn't find any ingredient text in that photo. Try a clearer image or paste the ingredients instead.",
				});
			}

			return { text: text.trim() };
		},
	}),
};
