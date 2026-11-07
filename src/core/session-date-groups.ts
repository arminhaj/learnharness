/** Local calendar days, rather than elapsed 24-hour periods, match the
 * learner's sidebar even across midnight and daylight-saving changes. */
export function sessionDayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export interface SessionDateGroup<T> {
	key: string;
	label: string;
	sessions: T[];
}

/** Last activity, grouped into local calendar-day ranges. Last week
 * means 2–6 days ago; seven days ago and earlier belong to Older.
 * Bad activity timestamps fall back to creation; undated records stay
 * visible at the end of Older. */
export function groupSessionsByDate<T extends { updatedAt: string; createdAt: string }>(
	sessions: readonly T[],
	now = new Date(),
): SessionDateGroup<T>[] {
	const today = sessionDayKey(now);
	const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	const yesterday = sessionDayKey(previous);
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
	const groups: SessionDateGroup<T>[] = [
		{ key: today, label: "Today", sessions: [] },
		{ key: yesterday, label: "Yesterday", sessions: [] },
		{ key: "last-week", label: "Last week", sessions: [] },
		{ key: "older", label: "Older", sessions: [] },
	];
	const dated = sessions.map((session, index) => {
		const updated = Date.parse(session.updatedAt);
		const created = Date.parse(session.createdAt);
		const timestamp = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : null;
		return { session, index, timestamp };
	}).sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || a.index - b.index);
	for (const { session, timestamp } of dated) {
		// A slightly fast clock stays with Today instead of creating a
		// future-dated section. Unknown dates stay with the oldest records.
		const index = timestamp === null ? 3 : timestamp >= todayStart ? 0 : timestamp >= previous.getTime() ? 1 : timestamp >= weekStart ? 2 : 3;
		groups[index]!.sessions.push(session);
	}
	return groups.filter((group) => group.sessions.length > 0);
}
