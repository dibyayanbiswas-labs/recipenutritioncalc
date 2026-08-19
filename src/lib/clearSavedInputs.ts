/** Clears one saved input field. Used by each form's "Start over" button, which only empties
 *  that form's content so the user can start a new entry without losing title/servings. */
export function clearSavedInput(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// sessionStorage can throw in locked-down privacy modes — clearing is best-effort.
	}
}
