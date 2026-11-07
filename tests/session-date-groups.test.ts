import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSessionsByDate } from "../src/core/session-date-groups.ts";

const now = new Date(2026, 10, 2, 12);
const stamp = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();
const session = (id: string, updatedAt: string, createdAt = stamp(1)) => ({ id, updatedAt, createdAt });

describe("session date groups", () => {
	it("groups by last activity in Today, Yesterday, Last week, Older order", () => {
		const groups = groupSessionsByDate([
			session("oldest", stamp(-6)),
			session("three-days", stamp(-1)),
			session("morning", stamp(2, 8)),
			session("yesterday", stamp(1)),
			session("six-days", stamp(-4)),
			session("seven-days", stamp(-5)),
			session("two-days", stamp(0)),
			session("resumed", stamp(2, 11), stamp(-5)),
		], now);
		assert.deepEqual(groups.map(({ key, label, sessions }) => ({ key, label, ids: sessions.map((s) => s.id) })), [
			{ key: "2026-11-02", label: "Today", ids: ["resumed", "morning"] },
			{ key: "2026-11-01", label: "Yesterday", ids: ["yesterday"] },
			{ key: "last-week", label: "Last week", ids: ["two-days", "three-days", "six-days"] },
			{ key: "older", label: "Older", ids: ["seven-days", "oldest"] },
		]);
	});

	it("uses calendar days at local midnight and across daylight saving", () => {
		const afterMidnight = new Date(2026, 10, 2, 0, 15);
		const previousMorning = new Date(2026, 10, 1, 0, 10);
		assert.equal(groupSessionsByDate([session("previous", previousMorning.toISOString())], afterMidnight)[0]?.label, "Yesterday");
		const beforeMidnight = new Date(2026, 10, 1, 23, 59);
		assert.equal(groupSessionsByDate([session("previous", beforeMidnight.toISOString())], afterMidnight)[0]?.label, "Yesterday");
	});

	it("handles the year boundary and updates labels with the calendar", () => {
		const chats = [session("last-year", new Date(2025, 11, 31, 23, 59).toISOString())];
		assert.equal(groupSessionsByDate(chats, new Date(2026, 0, 1, 0, 1))[0]?.label, "Yesterday");
		assert.equal(groupSessionsByDate(chats, new Date(2026, 0, 2, 0, 1))[0]?.label, "Last week");
		assert.equal(groupSessionsByDate(chats, new Date(2026, 0, 7, 0, 1))[0]?.label, "Older");
	});

	it("uses calendar-day boundaries for the week cutoff across both DST changes", () => {
		for (const [year, month, day] of [[2026, 10, 2], [2026, 2, 10]] as const) {
			const current = new Date(year, month, day, 0, 15);
			const cutoff = new Date(year, month, day - 6);
			const groups = groupSessionsByDate([
				session("before-cutoff", new Date(cutoff.getTime() - 1).toISOString()),
				session("at-cutoff", cutoff.toISOString()),
			], current);
			assert.deepEqual(groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [
				["Last week", ["at-cutoff"]], ["Older", ["before-cutoff"]],
			]);
		}
	});

	it("retains malformed legacy records and puts undated sessions last in Older", () => {
		const groups = groupSessionsByDate([
			session("undated", "invalid", "invalid"),
			session("dated-older", stamp(-6)),
			session("fallback", "invalid", stamp(1)),
			session("today", stamp(2)),
		], now);
		assert.deepEqual(groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [
			["Today", ["today"]], ["Yesterday", ["fallback"]], ["Older", ["dated-older", "undated"]],
		]);
	});

	it("keeps future clock skew in Today without adding a date section", () => {
		assert.equal(groupSessionsByDate([session("future", stamp(3))], now)[0]?.label, "Today");
	});

	it("does not mutate the snapshot, retains ties, and omits empty groups", () => {
		const chats = Object.freeze([session("first", stamp(1)), session("second", stamp(1))]);
		assert.deepEqual(groupSessionsByDate(chats, now)[0]?.sessions.map((s) => s.id), ["first", "second"]);
		assert.deepEqual(chats.map((s) => s.id), ["first", "second"]);
		assert.deepEqual(groupSessionsByDate([], now), []);
	});
});
