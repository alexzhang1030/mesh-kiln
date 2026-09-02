import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineNuxtConfig } from 'nuxt/config';
import type { Plugin } from 'vite';

const watlasWasmPath = resolve(fileURLToPath(new URL('.', import.meta.url)), 'node_modules/watlas/dist/watlas.wasm');

function emitWatlasWasm(): Plugin {
	return {
		name: 'kiln-emit-watlas-wasm',
		apply: 'build',
		generateBundle() {
			if (!existsSync(watlasWasmPath)) {
				throw new Error('watlas.wasm is missing from node_modules/watlas/dist.');
			}
			this.emitFile({
				type: 'asset',
				fileName: 'watlas.wasm',
				originalFileName: 'watlas.wasm',
				source: readFileSync(watlasWasmPath)
			});
		}
	};
}

function watlasLocatePublicWasm(): Plugin {
	return {
		name: 'kiln-watlas-locate-public-wasm',
		transform(code, id) {
			const normalized = id.replace(/\\/g, '/');
			if (!normalized.includes('/watlas/dist/watlas.js')) return;
			if (code.includes('return "/watlas.wasm"') && code.includes('function findWasmBinary')) {
				return;
			}
			const next = code.replace(
				/function findWasmBinary\(\)\{if\(Module\["locateFile"\]\)\{return locateFile\("watlas\.wasm"\)\}return new URL\([^)]+\)\.href\}/,
				'function findWasmBinary(){if(ENVIRONMENT_IS_NODE){if(Module["locateFile"]){return locateFile("watlas.wasm")}return new URL("watlas.wasm",import.meta.url).href}return "/watlas.wasm"}'
			);
			if (next === code) {
				this.warn('watlas.js findWasmBinary no longer matches; bake worker may miss /watlas.wasm.');
				return;
			}
			return { code: next, map: null };
		}
	};
}

export default defineNuxtConfig({
	ssr: false,
	compatibilityDate: '2026-08-29',
	css: ['~/assets/css/app.css'],
	app: {
		head: {
			title: 'Kiln',
			htmlAttrs: { lang: 'en' },
			meta: [
				{
					name: 'description',
					content: 'Local GLB triangle reducer.'
				},
				{ name: 'theme-color', content: '#14110e' }
			],
			link: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]
		}
	},
	alias: {
		kiln: fileURLToPath(new URL('./src', import.meta.url))
	},
	nitro: {
		preset: 'vercel',
		prerender: {
			routes: ['/']
		}
	},
	vite: {
		plugins: [emitWatlasWasm(), watlasLocatePublicWasm()],
		worker: {
			format: 'es',
			plugins: () => [watlasLocatePublicWasm()]
		},
		optimizeDeps: {
			exclude: ['watlas', 'meshoptimizer']
		},
		assetsInclude: ['**/*.wasm'],
		server: {
			port: 43173,
			host: '127.0.0.1',
			strictPort: true
		}
	}
});
