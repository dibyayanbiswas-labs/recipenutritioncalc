/** Prints only the element with `targetId`, hiding the rest of the page for the duration (see the
 * `.is-print-scoped` / `.is-print-target` rules in global.css). Browsers use `document.title` as
 * the suggested filename in the print dialog's "Save as PDF" destination, so callers pass a
 * human-friendly name (no extension) to steer that filename. */
export function printElementAsPdf(targetId: string, suggestedFilename: string): void {
	const target = document.getElementById(targetId);
	if (!target) {
		window.print();
		return;
	}

	const originalTitle = document.title;
	document.body.classList.add('is-print-scoped');
	target.classList.add('is-print-target');
	document.title = suggestedFilename;

	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		document.body.classList.remove('is-print-scoped');
		target.classList.remove('is-print-target');
		document.title = originalTitle;
		window.removeEventListener('afterprint', restore);
	};

	window.addEventListener('afterprint', restore);
	window.print();
	// Safari doesn't reliably fire `afterprint` once the system dialog closes.
	setTimeout(restore, 2000);
}
