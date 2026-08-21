/** Disables a submit button and swaps its label to a spinner + custom text for the moment between a
 * native form POST firing and the full-page navigation that follows it landing — Calculate can take
 * several seconds (ingredient matching plus Workers AI fallbacks), so this keeps the click from
 * looking like nothing happened. Never restored: the page navigates away right after. */
export function showCalculating(button: HTMLButtonElement | null, label: string): void {
	if (!button) return;
	button.disabled = true;
	button.innerHTML = `<svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg><span>${label}</span>`;
}
