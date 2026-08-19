/** Rasterizes `targetId` (via html2canvas) and slices it across A4 pages of a real PDF file (via
 * jsPDF), so "Download" saves an actual .pdf instead of routing through the OS print dialog. Both
 * libraries are dynamically imported so their ~200KB stays out of the initial page bundle. */
export async function exportElementAsPdf(targetId: string, filename: string): Promise<void> {
	const target = document.getElementById(targetId);
	if (!target) throw new Error(`exportElementAsPdf: no element with id "${targetId}" found`);

	const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);

	document.body.classList.add('is-pdf-export');
	try {
		const canvas = await html2canvas(target, {
			scale: Math.min(2, window.devicePixelRatio || 1.5),
			backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
			useCORS: true,
		});

		const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
		const pageWidth = pdf.internal.pageSize.getWidth();
		const pageHeight = pdf.internal.pageSize.getHeight();
		const margin = 24;
		const contentWidth = pageWidth - margin * 2;
		const contentHeight = pageHeight - margin * 2;

		// canvas px -> pdf pt scale, and how many source pixels fit one page's content height.
		const scale = contentWidth / canvas.width;
		const sliceHeightPx = Math.max(1, Math.floor(contentHeight / scale));

		const pageCanvas = document.createElement('canvas');
		pageCanvas.width = canvas.width;
		const pageCtx = pageCanvas.getContext('2d');
		if (!pageCtx) throw new Error('2D canvas context unavailable');

		let renderedPx = 0;
		let pageIndex = 0;
		while (renderedPx < canvas.height) {
			const sliceHeight = Math.min(sliceHeightPx, canvas.height - renderedPx);
			pageCanvas.height = sliceHeight;
			pageCtx.clearRect(0, 0, pageCanvas.width, sliceHeight);
			pageCtx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

			if (pageIndex > 0) pdf.addPage();
			pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', margin, margin, contentWidth, sliceHeight * scale);

			renderedPx += sliceHeight;
			pageIndex++;
		}

		pdf.save(`${filename}.pdf`);
	} finally {
		document.body.classList.remove('is-pdf-export');
	}
}
