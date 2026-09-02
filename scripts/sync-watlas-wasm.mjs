import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/watlas/dist/watlas.wasm');
const dest = resolve(root, 'public/watlas.wasm');

if (!existsSync(source)) {
	throw new Error(`watlas.wasm not found at ${source}. Run pnpm install first.`);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);
console.log(`copied watlas.wasm → ${dest}`);
