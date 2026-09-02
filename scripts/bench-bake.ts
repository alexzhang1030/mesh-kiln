import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGlb } from '../src/import-worker/parse-glb';
import { runBake } from '../src/bake-worker/pipeline';

const bytes = new Uint8Array(readFileSync(resolve('static/sample-crest.glb')));
const { source, summary } = await parseGlb(bytes.buffer);
console.log(`imported ${summary.triangleCount} tris`);
const started = Date.now();
await runBake(
	source,
	{ triangleBudget: 6000, topologyMode: 'voxel', mapSize: 512 },
	(event) => {
		if (event.type === 'start') console.log(`start ${event.stage} ${Date.now() - started}ms`);
		if (event.type === 'progress' && event.stage === 'maps') {
			const pct = Math.round(event.value * 100);
			if (pct % 25 === 0) console.log(`maps ${pct}% ${Date.now() - started}ms`);
		}
		if (event.type === 'complete') {
			console.log(`complete tris=${event.triangleCount} bytes=${event.glb.byteLength} ${Date.now() - started}ms`);
		}
		if (event.type === 'error') console.error(event.message);
	}
);
