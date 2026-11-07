import type { ChatListItem } from "./contracts/chat.ts";
import { groupSessionsByDate, type SessionDateGroup } from "./session-date-groups.ts";

/** Explicit organization takes precedence; otherwise use exact plan counts. */
export function sessionLessonComplete(chat: Pick<ChatListItem, "lessonCompleted" | "lessonCompletion">): boolean {
	if (typeof chat.lessonCompleted === "boolean") return chat.lessonCompleted;
	const progress = chat.lessonCompletion;
	return !!progress && progress.total > 0 && progress.completed === progress.total;
}

export function sessionSection(chat: Pick<ChatListItem, "archivedAt" | "lessonCompleted" | "lessonCompletion" | "busy" | "compacting">): "active" | "completed" | "archive" {
	if (chat.archivedAt) return "archive";
	if (!chat.busy && !chat.compacting && sessionLessonComplete(chat)) return "completed";
	return "active";
}

/** Organization never removes records: archive overrides the derived section,
 * and restoring a session uses its current progress. */
export function groupSessionsForSidebar(sessions: readonly ChatListItem[], now = new Date()): SessionDateGroup<ChatListItem>[] {
	const buckets = { active: [] as ChatListItem[], completed: [] as ChatListItem[], archive: [] as ChatListItem[] };
	for (const session of sessions) buckets[sessionSection(session)].push(session);
	const ordered = (list: ChatListItem[]) => groupSessionsByDate(list, now).flatMap(group => group.sessions);
	return [
		...groupSessionsByDate(buckets.active, now),
		{ key: "completed", label: "Completed", sessions: ordered(buckets.completed) },
		{ key: "archive", label: "Archive", sessions: ordered(buckets.archive) },
	];
}
