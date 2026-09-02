/// <reference lib="webworker" />

import type { ImportRequest, ImportResponse } from '../session/protocol';
import { sourceTransferList } from '../session/protocol';
import { parseGlb } from './parse-glb';

const ctx = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<ImportRequest>) => {
	const data = event.data;
	if (data.type !== 'import') return;
	void runImport(data);
};

async function runImport(request: ImportRequest): Promise<void> {
	post({ type: 'start', jobId: request.jobId });
	try {
		const { source, summary } = await parseGlb(request.glb);
		post({ type: 'complete', jobId: request.jobId, source, summary }, sourceTransferList(source));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Import failed.';
		post({ type: 'error', jobId: request.jobId, message });
	}
}

function post(message: ImportResponse, transfer: Transferable[] = []): void {
	ctx.postMessage(message, transfer);
}
