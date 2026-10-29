import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCoalescedRead } from "../lib/coalesced-read.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("coalesced progress reads", () => {
	it("applies every completed read while faster refresh notifications coalesce into one trailing read", async () => {
		const requests: ReturnType<typeof deferred<number>>[] = [];
		const values: number[] = [];
		let active = 0;
		let mostActive = 0;
		const reader = createCoalescedRead({
			read: async () => {
				active++;
				mostActive = Math.max(mostActive, active);
				const request = deferred<number>();
				requests.push(request);
				try { return await request.promise; } finally { active--; }
			},
			onValue: (value) => values.push(value),
			onError: () => assert.fail("No failed reads expected"),
		});
		reader.refresh();
		for (let i = 0; i < 20; i++) reader.refresh();
		assert.equal(requests.length, 1);
		requests[0]!.resolve(1);
		await settle();
		assert.deepEqual(values, [1], "a completed response remains useful even after newer notifications");
		assert.equal(requests.length, 2, "all notifications during the request become one trailing read");
		for (let i = 0; i < 20; i++) reader.refresh();
		requests[1]!.resolve(2);
		await settle();
		assert.deepEqual(values, [1, 2]);
		assert.equal(requests.length, 3);
		requests[2]!.resolve(3);
		await settle();
		assert.deepEqual(values, [1, 2, 3], "serialized reads cannot roll back to an older response");
		assert.equal(mostActive, 1);
		assert.equal(requests.length, 3);
		reader.dispose();
	});

	it("reports failures and still runs an already requested trailing retry", async () => {
		const first = deferred<number>();
		let calls = 0;
		const errors: unknown[] = [];
		const values: number[] = [];
		const reader = createCoalescedRead({ read: () => ++calls === 1 ? first.promise : Promise.resolve(2), onValue: (value) => values.push(value), onError: (error) => errors.push(error) });
		reader.refresh();
		reader.refresh();
		first.reject(new Error("temporary status failure"));
		await settle();
		assert.equal(errors.length, 1);
		assert.deepEqual(values, [2]);
		assert.equal(calls, 2);
		reader.dispose();
	});

	it("ignores a late completion after unmount and cancels queued refreshes", async () => {
		const request = deferred<number>();
		let calls = 0;
		const reader = createCoalescedRead({ read: () => { calls++; return request.promise; }, onValue: () => assert.fail("Disposed reads must not update state"), onError: () => assert.fail("Disposed errors must not update state") });
		reader.refresh();
		reader.refresh();
		reader.dispose();
		request.resolve(1);
		await settle();
		reader.refresh();
		assert.equal(calls, 1);
	});
});
