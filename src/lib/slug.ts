/** Slugifies a recipe title for use as a suggested export filename (PDF print dialog, share links, etc). */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'recipe';
}
