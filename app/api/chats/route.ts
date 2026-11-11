import { chainsForSelection, createConceptSessionRequest, formatChainLine, LEARNING_SUBJECT_UNASSIGNED_ID, learningSubjects } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createChat, isTurnRunning, learningGraphView, listChats, readSettingsRecord, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem, LearningSessionContext, LearningSessionSubject } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().filter((c) => !c.exploration).map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; learningContext?: unknown; learningSubjectId?: unknown };
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid session request" }, { status: 400 });
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	const input = body.learningContext as { nodeId: string; subjectId?: unknown } | null | undefined;
	if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || typeof input.nodeId !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(input.nodeId))) {
		return Response.json({ error: "learningContext requires a valid nodeId" }, { status: 400 });
	}
	if (body.learningSubjectId !== undefined && (input !== undefined || kind === "practice" || body.learningSubjectId === LEARNING_SUBJECT_UNASSIGNED_ID)) {
		return Response.json({ error: "Choose a named subject for a freeform Teaching session" }, { status: 400 });
	}
	const subjectId = input === undefined ? body.learningSubjectId : input.subjectId;
	if (subjectId !== undefined && (typeof subjectId !== "string" || !subjectId)) {
		return Response.json({ error: "The learning subject id must be a non-empty string" }, { status: 400 });
	}

	let learningContext: LearningSessionContext | undefined;
	let learningPick: GraphContextPick | undefined;
	let learningSubject: LearningSessionSubject | undefined;
	if (input !== undefined || subjectId !== undefined) {
		const snapshot = learningGraphView();
		const subject = subjectId === undefined ? undefined : learningSubjects(snapshot).find(({ id }) => id === subjectId);
		if (subjectId !== undefined && !subject) {
			return Response.json({ error: "This subject is no longer in the learning map" }, { status: 404 });
		}
		if (subject) learningSubject = { id: subject.id, name: subject.name };

		if (input !== undefined) {
			const nodeId = snapshot.idAliases?.[input.nodeId] ?? input.nodeId;
			const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) return Response.json({ error: "This concept is no longer in the learning map" }, { status: 404 });
			if (subject && !subject.nodeIds.includes(node.id)) {
				return Response.json({ error: "This concept is not in the selected subject" }, { status: 400 });
			}
			const prerequisiteIds = new Set(snapshot.prerequisites.filter((edge) => edge.to === node.id).map((edge) => edge.from));
			learningPick = { id: node.id, name: node.name, statement: node.statement };
			learningContext = {
				nodeId: node.id, mode: kind ?? "teach",
				launchPrompt: title || createConceptSessionRequest(node, kind ?? "teach").title,
				progress: node.progress,
				symbols: node.symbols.map(({ notation, meaning }) => ({ notation, meaning })),
				prerequisites: snapshot.nodes.filter((candidate) => prerequisiteIds.has(candidate.id)).map(({ id, name, statement, progress }) => ({ id, name, statement, progress })),
			};
		}
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = learningPick ? [learningPick] : Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	let chainLines: string[] = [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
	}
	const messages = picks.length > 0 || learningSubject
		? [newGraphContextMessage(picks, chainLines, learningContext, learningSubject)]
		: undefined;
	// The new session owns the strong-slot model choice from birth.
	const strong = readSettingsRecord()?.models?.strong;
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind, {
		messages,
		learningSubjectId: learningSubject?.id,
		settings: strong?.model ? {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
			...(strong.fastMode !== undefined ? { fastMode: strong.fastMode } : {}),
		} : undefined,
	});
	return Response.json({ id: chat.id, title: chat.title });
}
