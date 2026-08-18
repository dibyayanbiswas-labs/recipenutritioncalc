import type { NutritionResult } from './nutrients';

const RESULT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export function generateResultId(): string {
	// Short, URL-safe id. crypto.randomUUID() is available in the Workers runtime.
	return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export async function saveResult(kv: KVNamespace, result: NutritionResult): Promise<void> {
	await kv.put(resultKey(result.id), JSON.stringify(result), { expirationTtl: RESULT_TTL_SECONDS });
}

export async function loadResult(kv: KVNamespace, id: string): Promise<NutritionResult | null> {
	const raw = await kv.get(resultKey(id));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as NutritionResult;
	} catch {
		return null;
	}
}

function resultKey(id: string): string {
	return `result:${id}`;
}
