import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearHomeDraft, stashHomeDraft, takeHomeDraft, withHomeDraftHandoff, type HomeDraft } from "../components/home-draft.ts";

function fixture() {
	const data = new Map<string, string>();
	const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => { data.set(key, value); },
		removeItem: (key) => { data.delete(key); },
	};
	return { data, storage };
}

const draft: HomeDraft = {
	topic: "Unsent notes: γ & ? # 世界\nKeep this exact text.",
	mode: "practice",
	picks: [{ id: "n_future_growth", name: "Growth", statement: "Growth relates change to amount." }],
};
const fail = () => { throw new Error("synthetic storage failure"); };

describe("home draft handoff", () => {
	it("resnapshots text, mode and picks edited during a deferred session creation", async () => {
		const { storage } = fixture();
		let current = draft;
		let release!: (destination: string) => void;
		const destination = new Promise<string>((resolve) => { release = resolve; });
		const handoff = withHomeDraftHandoff(() => current, () => destination, storage);
		current = { topic: "Edited while waiting", mode: "teach", picks: [{ id: "n_new", name: "New pick", statement: "A changed selection." }] };
		release("/chat/new_session");
		assert.equal(await handoff, "/chat/new_session");
		assert.deepEqual(takeHomeDraft(storage), current);
	});

	it("captures a dictated tail flushed after the session creation completes", async () => {
		const { storage } = fixture();
		let current = draft;
		let finish!: () => void;
		const dictation = new Promise<void>((resolve) => { finish = resolve; });
		const handoff = withHomeDraftHandoff(() => current, async () => {
			await dictation;
			current = { ...current, topic: `${current.topic} Last dictated words.` };
			return "/chat/with_dictation";
		}, storage);
		finish();
		await handoff;
		assert.deepEqual(takeHomeDraft(storage), current);
	});

	it("refuses navigation and clears the earlier snapshot when the second write fails", async () => {
		for (const writeFailure of [fail, () => {}]) {
			const { storage, data } = fixture();
			let current = draft;
			const handoff = withHomeDraftHandoff(() => current, async () => {
				current = { ...draft, topic: "Newer live draft" };
				storage.setItem = writeFailure;
				return "/chat/already_created";
			}, storage);
			await assert.rejects(handoff, /preserve your home draft/);
			assert.equal(data.size, 0, "an obsolete draft must not be restored later");
			assert.equal(current.topic, "Newer live draft", "the live draft stays available for retry");
		}
	});

	it("never begins creation without a safe first snapshot and clears failed preparation", async () => {
		let preparations = 0;
		await assert.rejects(withHomeDraftHandoff(() => draft, async () => { preparations++; return "/chat/never"; }, null), /preserve your home draft/);
		assert.equal(preparations, 0);
		const { storage, data } = fixture();
		const failure = new Error("Creation failed");
		await assert.rejects(withHomeDraftHandoff(() => draft, async () => { throw failure; }, storage), failure);
		assert.equal(data.size, 0);
	});

	for (const mode of ["teach", "practice"] as const) {
		it(`restores ${mode} text and picks once without touching other handoffs`, () => {
			const { storage, data } = fixture();
			data.set("lh.openingPrompt.chat_1", "other handoff");
			assert.equal(stashHomeDraft({ ...draft, mode }, storage), true);
			assert.deepEqual(takeHomeDraft(storage), { ...draft, mode });
			assert.equal(takeHomeDraft(storage), null);
			assert.equal(data.get("lh.openingPrompt.chat_1"), "other handoff");
		});
	}

	it("preserves the selected mode even when the composer and picks are empty", () => {
		const { storage } = fixture();
		const empty: HomeDraft = { topic: "", mode: "practice", picks: [] };
		assert.equal(stashHomeDraft(empty, storage), true);
		assert.deepEqual(takeHomeDraft(storage), empty);
	});

	it("clears a failed launch handoff", () => {
		const { storage } = fixture();
		stashHomeDraft(draft, storage);
		clearHomeDraft(storage);
		assert.equal(takeHomeDraft(storage), null);
	});

	it("does not claim success for a failed or silently dropped write", () => {
		for (const method of ["getItem", "setItem"] as const) {
			const { storage } = fixture();
			storage[method] = fail;
			assert.equal(stashHomeDraft(draft, storage), false);
		}
		const { storage } = fixture();
		storage.setItem = () => {};
		assert.equal(stashHomeDraft(draft, storage), false);
	});

	it("ignores and consumes corrupt or invalid stored values", () => {
		for (const value of ["not JSON", "null", "[]", JSON.stringify({ ...draft, topic: 5 }), JSON.stringify({ ...draft, mode: "unknown" }), JSON.stringify({ ...draft, picks: [null] }), JSON.stringify({ ...draft, picks: [{ id: "n_1" }] })]) {
			const { storage, data } = fixture();
			stashHomeDraft(draft, storage);
			storage.setItem([...data.keys()][0]!, value);
			assert.equal(takeHomeDraft(storage), null);
			assert.equal(data.size, 0);
		}
	});

	it("does not restore if it cannot consume the handoff", () => {
		for (const removeItem of [fail, () => {}]) {
			const { storage } = fixture();
			stashHomeDraft(draft, storage);
			storage.removeItem = removeItem;
			assert.equal(takeHomeDraft(storage), null);
			assert.doesNotThrow(() => clearHomeDraft(storage));
		}
	});

	it("contains unavailable storage and a throwing browser storage getter", () => {
		assert.equal(stashHomeDraft(draft, null), false);
		assert.equal(takeHomeDraft(null), null);
		assert.doesNotThrow(() => clearHomeDraft(null));
		const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		try {
			Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: fail });
			assert.equal(stashHomeDraft(draft), false);
			assert.equal(takeHomeDraft(), null);
			assert.doesNotThrow(() => clearHomeDraft());
		} finally {
			if (original) Object.defineProperty(globalThis, "sessionStorage", original);
			else Reflect.deleteProperty(globalThis, "sessionStorage");
		}
	});
});
