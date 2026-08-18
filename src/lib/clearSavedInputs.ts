const STORAGE_KEYS = [
	'recipeCalc:pasteTitle',
	'recipeCalc:pasteServings',
	'recipeCalc:pasteText',
	'recipeCalc:url',
	'recipeCalc:urlServings',
];

/** Clears every saved input field and sends the user back to a blank home page. */
export function startOver(): void {
	try {
		STORAGE_KEYS.forEach((k) => sessionStorage.removeItem(k));
	} catch {
		// sessionStorage can throw in locked-down privacy modes — clearing is best-effort.
	}
	window.location.href = '/';
}
