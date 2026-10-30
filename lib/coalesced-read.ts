/** Keep one request in flight and at most one trailing refresh. Every completed
 * read is applied in order, even when notifications arrive faster than HTTP. */
export function createCoalescedRead<T>({ read, onValue, onError }: {
	read: () => Promise<T>;
	onValue: (value: T) => void;
	onError: (error: unknown) => void;
}) {
	let running = false;
	let pending = false;
	let disposed = false;
	async function drain() {
		running = true;
		try {
			while (pending && !disposed) {
				pending = false;
				try {
					const value = await read();
					if (!disposed) onValue(value);
				} catch (error) {
					if (!disposed) onError(error);
				}
			}
		} finally { running = false; }
	}
	return {
		refresh() {
			if (disposed) return;
			pending = true;
			if (!running) void drain();
		},
		dispose() { disposed = true; pending = false; },
	};
}
