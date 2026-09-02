import { describe, expect, it } from 'vitest';
import { owlSdf } from './owl';

describe('owl implicit sculpt', () => {
	it('has a body, head, and branch with empty space around them', () => {
		expect(owlSdf(0, 0.22, 0.04)).toBeLessThan(0);
		expect(owlSdf(0, 0.86, 0.08)).toBeLessThan(0);
		expect(owlSdf(0, -0.52, 0.01)).toBeLessThan(0);
		expect(owlSdf(-0.2, 1.18, 0.02)).toBeLessThan(0);
		expect(owlSdf(0, 0.7, 0.42)).toBeLessThan(0);
		expect(owlSdf(-0.12, -0.36, 0.14)).toBeLessThan(0);
		expect(owlSdf(3, 3, 3)).toBeGreaterThan(0.5);
		expect(owlSdf(0, 2.4, 0)).toBeGreaterThan(0);
	});
});
