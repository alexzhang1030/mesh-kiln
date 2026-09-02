/// <reference lib="webworker" />

import type { BakeRequest, BakeResponse, CancelRequest } from '../session/protocol';
import { runBake } from './pipeline';

const ctx = self as DedicatedWorkerGlobalScope;
let activeJob = 0;

ctx.onmessage = (event: MessageEvent<BakeRequest | CancelRequest>) => {
	const data = event.data;
	switch (data.type) {
		case 'cancel':
			if (data.jobId === activeJob) activeJob = 0;
			return;
		case 'bake':
			activeJob = data.jobId;
			void runJob(data);
			return;
		default: {
			const exhausted: never = data;
			post({ type: 'error', jobId: 0, message: `Unknown bake message: ${String(exhausted)}` });
		}
	}
};

async function runJob(request: BakeRequest): Promise<void> {
	const jobId = request.jobId;
	await runBake(
		request.source,
		request.settings,
		(event) => {
			if (jobId !== activeJob) return;
			switch (event.type) {
				case 'start':
					post({ type: 'start', jobId, stage: event.stage, topology: event.topology });
					return;
				case 'progress':
					post({
						type: 'progress',
						jobId,
						stage: event.stage,
						value: event.value,
						topology: event.topology
					});
					return;
				case 'complete':
					post({ type: 'complete', jobId, glb: event.glb, triangleCount: event.triangleCount, topology: event.topology }, [
						event.glb
					]);
					return;
				case 'error':
					post({ type: 'error', jobId, message: event.message });
					return;
				default: {
					const exhausted: never = event;
					post({ type: 'error', jobId, message: `Unknown bake event: ${String(exhausted)}` });
				}
			}
		},
		{ isCancelled: () => jobId !== activeJob }
	);
}

function post(message: BakeResponse, transfer: Transferable[] = []): void {
	ctx.postMessage(message, transfer);
}
