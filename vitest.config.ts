import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		testTimeout: 120_000,
		hookTimeout: 120_000,
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
