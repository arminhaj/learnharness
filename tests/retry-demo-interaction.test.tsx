import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChatActionsContext } from "../components/chat.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { modelsNotConfigured, providerKeyMissing } from "../src/core/settings.ts";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import type { LhViewMessage } from "../src/core/view.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const failed: JobRecord = {
	id: "job_failed", chatId: "chem174", toolCallId: "demo_call", kind: "demo", status: "error", activity: "failed",
	createdAt: "2026-11-02T20:00:00Z", updatedAt: "2026-11-02T20:01:00Z", error: "Builder crashed",
	result: { title: "Waveform timing", html: "", tested: true, notes: "FAILED: Builder crashed" },
	delivery: { kind: "result", status: "pending" },
};
const running: JobRecord = {
	...failed, id: "job_retry", retryOf: failed.id, status: "running", activity: "building demo", result: undefined, error: undefined,
};
const failureMessage: LhViewMessage = {
	id: `steer_${failed.id}`, role: "user", parts: [{ type: "data-subagent-artifact", data: { kind: "demo", result: failed.result! } }],
};
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sends = 0;
let refreshes = 0;
let requests: { url: string; body: unknown }[] = [];
let display: "dispatch" | "result" = "dispatch";

async function render(jobs: JobRecord[]) {
	await act(async () => root!.render(
		<ChatActionsContext.Provider value={{ chatId: "chem174", syncFromServer: async () => {}, refreshJobs: () => { refreshes++; }, sendText: () => { sends++; }, openSetup: () => {} }}>
			<JobsContext.Provider value={jobs}>
				<div data-testid="pending-question">Which signal leads?<textarea defaultValue="My unfinished answer" /></div>
				{display === "dispatch" ? <DispatchCard toolCallId="demo_call" kind="demo" /> : <SubagentSteerCard message={failureMessage} />}
			</JobsContext.Provider>
		</ChatActionsContext.Provider>,
	));
}

async function mount(response: () => Promise<Response>, jobs = [failed], mode: typeof display = "dispatch") {
	display = mode; sends = 0; refreshes = 0; requests = [];
	globalThis.fetch = async (url, init) => {
		assert.equal(init?.method, "POST");
		assert.equal(init.headers && (init.headers as Record<string, string>)["Content-Type"], "application/json");
		requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
		return response();
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await render(jobs);
	(host.querySelector("textarea") as HTMLTextAreaElement).value = "My unfinished answer";
}

function button(): HTMLButtonElement {
	const node = host!.querySelector<HTMLButtonElement>('[data-testid="retry-demo-button"]');
	assert.ok(node, "expected Retry demo button"); return node;
}

async function click() {
	await act(async () => button().dispatchEvent(new dom.window.Event("click", { bubbles: true })));
}

afterEach(async () => {
	try {
		assert.equal(sends, 0, "retry must not send a learner answer or teacher message");
		if (host) assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "My unfinished answer");
	} finally {
		await act(async () => root?.unmount()); root = null; host?.remove(); host = null;
		globalThis.fetch = originalFetch;
	}
});

describe("retry demo interactions", () => {
	for (const status of [200, 202]) it(`retains the accepted ${status} attempt while the jobs feed remains stale`, async () => {
		let complete!: (response: Response) => void;
		await mount(() => new Promise(resolve => { complete = resolve; }));
		await act(async () => {
			const target = button();
			target.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
			target.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
		});
		assert.equal(requests.length, 1, "duplicate clicks cannot start another request");
		assert.equal(button().disabled, true);
		assert.equal(button().textContent, "Retrying…");
		assert.deepEqual(requests[0], { url: "/api/jobs/job_failed/retry", body: { chatId: "chem174" } });
		await act(async () => complete(Response.json({ job: running }, { status })));
		assert.equal(refreshes, 1, "even an idempotent reply refreshes the parent's artifact projection");
		assert.equal(host!.querySelector('[data-testid="retry-demo-button"]'), null);
		assert.match(host!.textContent!, /building demo/);
		await render([{ ...failed, updatedAt: "2099-01-01T00:00:00Z" }]);
		assert.equal(host!.querySelector('[data-testid="retry-demo-button"]'), null, "stale activity timestamps cannot revive the old failure");
		assert.match(host!.textContent!, /building demo/);
		const done: JobRecord = { ...running, status: "done", activity: "finished" };
		await render([failed, done]);
		assert.match(host!.textContent!, /finished/);
		assert.equal(host!.querySelector('[data-testid="dispatch-card"]'), null);
	});

	it("shows an API error and allows a deliberate retry without changing the question", async () => {
		await mount(async () => Response.json({ error: "The selected model is unavailable" }, { status: 503 }));
		await click();
		assert.equal(button().disabled, false);
		assert.match(host!.querySelector('[role="alert"]')!.textContent!, /selected model is unavailable/);
		await click();
		assert.equal(requests.length, 2);
	});

	it("handles connection failures and malformed successful responses", async () => {
		let step = 0;
		await mount(async () => {
			if (step++ === 0) throw new Error("Connection lost");
			return Response.json({ job: { id: "wrong", kind: "demo", chatId: "another-session" } }, { status: 202 });
		});
		await click(); assert.match(host!.querySelector('[role="alert"]')!.textContent!, /Connection lost/);
		await click(); assert.match(host!.querySelector('[role="alert"]')!.textContent!, /response was incomplete/);
		assert.equal(button().disabled, false);
	});

	it("uses the newer failed attempt once polling catches up", async () => {
		await mount(async () => Response.json({ job: running }, { status: 202 }));
		await click();
		const retryFailed: JobRecord = { ...running, status: "error", error: "Browser verification failed" };
		await render([failed, retryFailed]);
		assert.ok(button());
		await click();
		assert.deepEqual(requests.map(request => request.url), ["/api/jobs/job_failed/retry", "/api/jobs/job_retry/retry"]);
	});

	for (const error of [modelsNotConfigured(["cheap"]).error, providerKeyMissing("claude-code", ["cheap"]).error]) {
		it(`offers retry beside setup recovery: ${error}`, async () => {
			await mount(async () => Response.json({ error: "Still needs setup" }, { status: 503 }), [{ ...failed, error }]);
			assert.ok(host!.querySelector('[data-testid="dispatch-setup-link"]'));
			await click(); assert.equal(requests.length, 1);
		});
	}

	it("a failed result card retries its owning job and immediately shows the accepted running attempt", async () => {
		await mount(async () => Response.json({ job: running }, { status: 202 }), [failed], "result");
		assert.ok(host!.querySelector('[data-testid="demo-card-failed"]'));
		await click();
		assert.equal(host!.querySelector('[data-testid="demo-card-failed"]'), null);
		assert.match(host!.textContent!, /building demo/);
		assert.equal(host!.querySelector('[data-testid="retry-demo-button"]'), null);
	});

	it("hides an obsolete failure when the server returns an already-completed retry", async () => {
		await mount(async () => Response.json({ job: { ...running, status: "done" } }, { status: 200 }), [failed], "result");
		await click();
		assert.equal(host!.querySelector('[data-testid="demo-card-failed"]'), null);
		assert.equal(host!.querySelector('[data-testid="retry-demo-button"]'), null);
	});

	it("selects current running attempts regardless of feed order and offers no retry there", async () => {
		await mount(async () => { throw new Error("must not call"); }, [failed, running]);
		assert.match(host!.textContent!, /building demo/);
		assert.equal(host!.querySelector('[data-testid="retry-demo-button"]'), null);
		assert.equal(requests.length, 0);
	});
});
