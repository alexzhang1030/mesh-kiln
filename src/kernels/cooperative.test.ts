import { describe, expect, it } from 'vitest';
import { nowMs, yieldToEventLoop } from './cooperative';

describe('cooperative worker scheduling', () => {
	it('yields through a task and resumes', async () => {
		const before = nowMs();
		await expect(yieldToEventLoop()).resolves.toBeUndefined();
		expect(nowMs()).toBeGreaterThanOrEqual(before);
	});
});
