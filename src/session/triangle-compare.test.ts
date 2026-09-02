import { describe, expect, it } from 'vitest';
import { compareTriangleCounts, triangleCompareKicker } from './triangle-compare';

describe('triangle compare HUD', () => {
	it('does not call an increase a reduction', () => {
		const compare = compareTriangleCounts(3456, 5975);
		expect(compare.kind).toBe('worse');
		if (compare.kind !== 'worse') return;
		expect(compare.extra).toBe(2519);
		const kicker = triangleCompareKicker(compare);
		expect(kicker.toLowerCase()).not.toContain('reduction');
		expect(kicker.toLowerCase()).toContain('worse');
		expect(kicker).toContain('+');
	});

	it('labels a real drop as reduction', () => {
		const compare = compareTriangleCounts(9216, 5998);
		expect(compare.kind).toBe('reduced');
		expect(triangleCompareKicker(compare).toLowerCase()).toContain('reduction');
	});
});
