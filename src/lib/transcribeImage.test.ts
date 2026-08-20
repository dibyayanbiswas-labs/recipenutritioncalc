import { describe, it, expect } from 'vitest';
import { resolveTranscription, transcriptionAgreement } from './transcribeImage';

describe('resolveTranscription', () => {
	it('trusts two matching transcriptions', () => {
		const text = '2 cups flour\n1 cup sugar\n1 tsp salt\n2 eggs';
		expect(resolveTranscription(text, text)).toBe(text);
	});

	it('tolerates minor punctuation/whitespace differences between the two reads', () => {
		const first = '2 cups flour\n1 cup sugar\n1 tsp salt\n2 eggs';
		const second = '2 cups flour\n1 cup sugar,\n1 tsp. salt\n2  eggs';
		expect(resolveTranscription(first, second)).toBe(first);
	});

	it('rejects when either read is the NONE sentinel', () => {
		expect(resolveTranscription('NONE', '2 cups flour')).toBe('');
		expect(resolveTranscription('2 cups flour', 'None.')).toBe('');
		expect(resolveTranscription('NONE', 'NONE')).toBe('');
	});

	it('rejects when either read is empty', () => {
		expect(resolveTranscription('', '2 cups flour')).toBe('');
		expect(resolveTranscription('2 cups flour', '')).toBe('');
	});

	// Regression test for the OCR hallucination bug: a blank/illegible image made the model invent a
	// different plausible-looking grocery list on almost every call instead of ever emitting the NONE
	// sentinel — two substantially different invented lists is exactly the failure this guards against.
	it('rejects two wildly different invented ingredient lists (hallucination signature)', () => {
		const first = 'Sugar\nFlour\nButter\nEggs\nVanilla\nMilk\nBaking powder\nSalt';
		const second = 'Olive oil\nOnion\nGarlic\nSalt\nPepper\nChicken\nTomato\nCucumber';
		expect(resolveTranscription(first, second)).toBe('');
	});

	it('accepts when the two reads mostly overlap with only a line or two of drift', () => {
		const first = '2 cups flour\n1 cup sugar\n1 tsp salt\n2 eggs\n1 tsp vanilla';
		const second = '2 cups flour\n1 cup sugar\n1 tsp salt\n2 eggs\n1 tsp vanila extract';
		expect(resolveTranscription(first, second)).toBe(first);
	});
});

describe('transcriptionAgreement', () => {
	it('is 1 when both are empty', () => {
		expect(transcriptionAgreement('', '')).toBe(1);
	});

	it('is 0 for completely disjoint line sets', () => {
		expect(transcriptionAgreement('a\nb', 'c\nd')).toBe(0);
	});

	it('is 1 for identical (case/punctuation-insensitive) line sets', () => {
		expect(transcriptionAgreement('Salt\nPepper', 'salt\npepper.')).toBe(1);
	});
});
