export function nowMs(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function yieldToEventLoop(): Promise<void> {
	if (typeof MessageChannel === 'function') {
		return new Promise((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				channel.port2.close();
				resolve();
			};
			channel.port2.postMessage(undefined);
		});
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}
