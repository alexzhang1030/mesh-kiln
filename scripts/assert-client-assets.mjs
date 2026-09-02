import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else out.push(path.replaceAll('\\', '/'));
	}
	return out;
}

const roots = [
	'.vercel/output/static',
	'.output/public',
	'.nuxt/dist/client',
	'node_modules/.cache/nuxt/.nuxt/dist/client'
];
const files = roots.flatMap((root) => walk(root));
if (files.length === 0) {
	throw new Error('No client build output found.');
}

const missing = [];
for (const label of ['import-worker', 'bake-worker', 'preview-worker']) {
	if (!files.some((file) => file.includes(label))) missing.push(label);
}

const staticDir = '.vercel/output/static';
const hasLiteralWasm = (paths) => paths.some((file) => basename(file) === 'watlas.wasm');
if (existsSync(staticDir)) {
	if (!hasLiteralWasm(walk(staticDir))) missing.push('watlas.wasm');
} else if (!hasLiteralWasm(files)) {
	missing.push('watlas.wasm');
}

if (missing.length > 0) {
	throw new Error(`Vite/Nuxt build is missing ${missing.join(', ')}.\n${files.join('\n')}`);
}

const wasmFiles = files.filter((file) => basename(file) === 'watlas.wasm');
const bakeWorkers = files.filter((file) => file.includes('bake-worker') && file.endsWith('.js'));
if (bakeWorkers.length === 0) {
	throw new Error('No bake-worker bundle found.');
}
for (const worker of bakeWorkers) {
	const source = readFileSync(worker, 'utf8');
	if (source.includes('Vite did not emit watlas.wasm')) {
		throw new Error(`${worker} still throws Vite did not emit watlas.wasm.`);
	}
	if (!source.includes('/watlas.wasm')) {
		throw new Error(`${worker} does not load /watlas.wasm.`);
	}
}

console.log(`client assets ok (${files.length} files)`);
console.log(`watlas.wasm → ${wasmFiles.join(', ')}`);
