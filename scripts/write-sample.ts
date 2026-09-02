import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureGlb } from '../src/kernels/example-meshes';
import { createCrestGlb, fixtureTriangleCount } from '../src/kernels/fixture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const heavy = process.argv.includes('--heavy');

if (heavy) {
	const out = resolve(root, 'public', 'sample-crest-100k.glb');
	mkdirSync(dirname(out), { recursive: true });
	const glb = await createCrestGlb({ segments: 160, name: 'crest-100k' });
	writeFileSync(out, Buffer.from(glb));
	console.log(`Wrote ${out}`);
	console.log(`triangles=${fixtureTriangleCount(160)} bytes=${glb.byteLength}`);
} else {
	const alias = resolve(root, 'public', 'sample-crest.glb');
	const crest = await buildFixtureGlb('crest');
	writeFileSync(alias, Buffer.from(crest));
	console.log(`Wrote ${alias} bytes=${crest.byteLength}`);
}
