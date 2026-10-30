"use client";

import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, CornerUpLeftIcon, CompassIcon } from "lucide-react";
import { LearningMomentsProvider, MarkLearningMoment } from "@/components/learning-moments";
import { ChatActionsContext } from "@/components/chat";
import { JobsContext } from "@/components/jobs-context";
import { QuestionDock } from "@/components/question-dock";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { AnsweredCard } from "@/components/answered-card";
import { PlanBlock } from "@/components/plan-block";
import { artifactRenderers } from "@/components/artifacts";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import { CompactionCutDivider, CompactionMomentDivider, type CompactionDividerData } from "@/components/compaction-divider";
import { Composer } from "@/components/composer";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { useChatSession } from "@/components/session";
import { SourcePassage } from "@/components/source-passage";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { endsInFailedTurn, firstSourceTextParts, messageAnchorId, textPartMessageId, findPendingToolCall, pendingQuestionOf, phaseAt3, questionNeedsReveal, dismissedAnswer, toolQuestionKind, type ArtifactPartProps, type ChatRecord, type JobRecord, type LhViewMessage, type PlanBlockData, type QuestionAnswerData } from "@/src/core";

export type ExplorationRecord = ChatRecord & {
	exploration: {
		parentChatId: string;
		sourceMessageId: string;
		parentTitle: string;
		topic: string;
		status: "active" | "closed";
	};
};

export function explorationErrorMessage(message: string): string {
	try {
		const body = JSON.parse(message) as { error?: unknown; code?: unknown };
		if (body.code === "models_not_configured") return "Set up your models in Settings to continue exploring.";
		if (typeof body.error === "string") return body.error;
	} catch { /* Plain text is already suitable for display. */ }
	return message;
}

function readDraft(chatId: string): string {
	try { return typeof window === "undefined" ? "" : sessionStorage.getItem(`lh:exploration-draft:${chatId}`) ?? ""; }
	catch { return ""; }
}

function saveDraft(chatId: string, text: string): void {
	try {
		if (text) sessionStorage.setItem(`lh:exploration-draft:${chatId}`, text);
		else sessionStorage.removeItem(`lh:exploration-draft:${chatId}`);
	} catch { /* The mounted field still retains its draft if browser storage is unavailable. */ }
}

async function responseBody<T>(response: Response): Promise<T> {
	const body = await response.json();
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The exploration could not be updated. Please try again.");
	return body as T;
}

export async function createInlineExploration(parentId: string, sourceMessageId: string, topic: string, request: typeof fetch = fetch): Promise<ExplorationRecord> {
	const body = await responseBody<{ chat: ExplorationRecord }>(await request(`/api/chats/${parentId}/explorations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sourceMessageId, topic: topic.trim() }),
	}));
	return body.chat;
}

export async function changeInlineExploration(parentId: string, childId: string, action: "close" | "reopen", request: typeof fetch = fetch): Promise<ExplorationRecord> {
	const body = await responseBody<{ chat: ExplorationRecord }>(await request(`/api/chats/${parentId}/explorations/${childId}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action }),
	}));
	return body.chat;
}

/** The lesson stays mounted. These records only select the separate inline input lane. */
export function useInlineExplorations(parentId: string) {
	const [records, setRecords] = useState<ExplorationRecord[]>([]);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draftSourceId, setDraftSourceId] = useState<string | null>(null);
	const [opening, setOpening] = useState<{ id: string; text: string } | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [changing, setChanging] = useState(false);
	const loadingRef = useRef(0);
	const requestedRef = useRef(false);
	const load = useCallback(async () => {
		const generation = ++loadingRef.current;
		try {
			const body = await responseBody<{ explorations: ExplorationRecord[] }>(await fetch(`/api/chats/${parentId}/explorations`));
			if (generation !== loadingRef.current) return;
			setRecords(body.explorations);
			setReady(true);
			setError(null);
			if (!requestedRef.current) {
				requestedRef.current = true;
				const requested = new URL(window.location.href).searchParams.get("exploration");
				if (requested && body.explorations.some(chat => chat.id === requested)) {
					setExpanded(previous => new Set([...previous, requested]));
				}
			}
		} catch (cause) {
			if (generation === loadingRef.current) setError(cause instanceof Error ? cause.message : "Could not load explorations.");
		}
	}, [parentId]);
	useEffect(() => { void load(); return () => { loadingRef.current++; }; }, [load]);
	useServerEvent("chats-changed", () => { void load(); });
	useServerResync(() => { void load(); });
	const update = (chat: ExplorationRecord) => {
		// A list request that started before this write cannot undo its result.
		loadingRef.current++;
		setRecords(previous => [...previous.filter(item => item.id !== chat.id), chat]
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
	};
	const create = async (sourceId: string, topic: string) => {
		if (changing || !topic.trim()) return;
		setChanging(true);
		setError(null);
		try {
			const chat = await createInlineExploration(parentId, sourceId, topic);
			update(chat);
			setOpening({ id: chat.id, text: topic.trim() });
			setDraftSourceId(null);
			setExpanded(previous => new Set([...previous, chat.id]));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not start the exploration.");
		} finally { setChanging(false); }
	};
	const change = async (chat: ExplorationRecord, action: "close" | "reopen") => {
		if (changing) return false;
		setChanging(true);
		setError(null);
		try {
			const updated = await changeInlineExploration(parentId, chat.id, action);
			update(updated);
			setExpanded(previous => {
				const next = new Set(previous);
				if (action === "close") next.delete(chat.id);
				else next.add(chat.id);
				return next;
			});
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not update the exploration.");
			return false;
		} finally { setChanging(false); }
	};
	const active = records.find(chat => chat.exploration.status === "active");
	return {
		records, ready, error, changing, active, draftSourceId, setDraftSourceId, create, change, load,
		paused: !ready || !!active || draftSourceId !== null,
		opening,
		openingDelivered: () => setOpening(null),
		isExpanded: (chat: ExplorationRecord) => chat.exploration.status === "active" || expanded.has(chat.id),
		toggle: (id: string) => setExpanded(previous => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		}),
	};
}

export function ExplorationStarter({ busy, onStart, onCancel, dictationSlot }: { busy: boolean; onStart: (topic: string) => void; onCancel: () => void; dictationSlot?: ReactNode }) {
	const [topic, setTopic] = useState("");
	const topicRef = useRef("");
	const applyTopic = useCallback((value: string) => { topicRef.current = value; setTopic(value); }, []);
	useDictationTarget(useCallback(text => applyTopic(joinDictation(topicRef.current, text)), [applyTopic]), true);
	const start = () => {
		if (busy) return;
		void finishDictation().then(() => { if (topicRef.current.trim()) onStart(topicRef.current); });
	};
	return (
		<div data-testid="exploration-starter" className="my-3 rounded-xl border border-primary/25 bg-card p-3">
			<label className="mb-2 block text-sm font-medium">What would you like to explore?</label>
			<textarea aria-label="Exploration question" value={topic} onChange={event => applyTopic(event.target.value)} autoFocus rows={2} maxLength={2000}
				className="lh-input w-full resize-none rounded-md border bg-background p-2 outline-none focus:border-primary"
				placeholder="Ask about this idea without moving the lesson forward…"
				onKeyDown={event => {
					if (event.key === "Escape") { event.stopPropagation(); if (!busy) onCancel(); }
					if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); start(); }
				}} />
			<div className="mx-auto mt-2 flex w-full max-w-[46rem] items-center justify-end gap-2">
				{dictationSlot && <div className="flex min-w-0 flex-1 items-center justify-center">{dictationSlot}</div>}
				<button type="button" onClick={onCancel} disabled={busy} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50">Cancel</button>
				<button type="button" onClick={start} disabled={busy || (!topic.trim() && !isDictationActive())} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Starting…" : "Explore"}</button>
			</div>
		</div>
	);
}

export function InlineExploration({ chat, expanded, changing, canReopen, initialPrompt, onInitialDelivered, onToggle, onClose, onReopen, onOpenPlan, dictationSlot }: {
	chat: ExplorationRecord;
	expanded: boolean;
	changing: boolean;
	canReopen: boolean;
	initialPrompt?: string;
	onInitialDelivered: () => void;
	onToggle: () => void;
	onClose: () => void;
	onReopen: () => void;
	/** The page owns plan overlays outside the transcript scroller. */
	onOpenPlan?: (messages: LhViewMessage[]) => void;
	dictationSlot?: ReactNode;
}) {
	const active = chat.exploration.status === "active";
	// Retain the child session and pending answer fields when returning. A
	// never-opened archive stays lazy; a visited branch releases its input claims.
	const [visited, setVisited] = useState(expanded);
	if (expanded && !visited) setVisited(true);
	return (
		<section id={`exploration-${chat.id}`} data-testid="inline-exploration" data-exploration-id={chat.id} data-active={active}
			className="my-4 overflow-hidden rounded-xl border border-primary/25 bg-card/50">
			<div className="flex items-center gap-2 px-3 py-2">
				<button type="button" onClick={onToggle} disabled={active} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm disabled:opacity-100">
					{expanded ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
					<CompassIcon className="size-4 shrink-0 text-primary" />
					<span className="truncate font-medium">{chat.exploration.topic}</span>
					{!active && <span className="shrink-0 text-xs text-muted-foreground">Exploration</span>}
				</button>
				{!active && expanded && <button type="button" onClick={onReopen} disabled={!canReopen || changing} className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-accent disabled:opacity-40">Continue exploring</button>}
			</div>
			{visited && <div hidden={!expanded}><ExplorationConversation key={chat.id} chat={chat} active={active} changing={changing} initialPrompt={initialPrompt}
				onInitialDelivered={onInitialDelivered} onClose={onClose} onOpenPlan={onOpenPlan} dictationSlot={dictationSlot} /></div>}
		</section>
	);
}

function ExplorationConversation({ chat, active, changing, initialPrompt, onInitialDelivered, onClose, onOpenPlan, dictationSlot }: {
	chat: ExplorationRecord; active: boolean; changing: boolean; initialPrompt?: string; onInitialDelivered: () => void; onClose: () => void; onOpenPlan?: (messages: LhViewMessage[]) => void; dictationSlot?: ReactNode;
}) {
	const { messages, nativeMessages, send, status, error, setMessages, resumeStream, setReattachSettled, submitAnswer, dismissQuestion, questionDraft, saveQuestionDraft } = useChatSession({ chatId: chat.id, initialMessages: chat.messages });
	const parentActions = useContext(ChatActionsContext);
	const pending = findPendingToolCall(messages, pendingQuestionOf(nativeMessages));
	const pendingId = pending?.key ?? null;
	const phase = phaseAt3(messages, undefined, "plan");
	const requiresReveal = !!pending && questionNeedsReveal(pending.tool, pending.input, phase);
	const [revealedId, setRevealedId] = useState<string | null>(null);
	const revealPending = requiresReveal && revealedId !== pendingId;
	const [readingThinking, setReadingThinking] = useState("");
	const readingRef = useRef(readingThinking);
	const applyReading = useCallback((value: string) => { readingRef.current = value; setReadingThinking(value); }, []);
	useEffect(() => { applyReading(pendingId ? questionDraft(pendingId)?.readingThinking ?? "" : ""); }, [pendingId, questionDraft, applyReading]);
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	useEffect(() => { if (!active) setAbortAsk(null); }, [active]);
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const [text, setText] = useState(() => readDraft(chat.id));
	const textRef = useRef(text);
	const applyText = useCallback((value: string) => { textRef.current = value; setText(value); }, []);
	useEffect(() => { saveDraft(chat.id, text); }, [chat.id, text]);
	useEffect(() => () => saveDraft(chat.id, textRef.current), [chat.id]);
	useDictationTarget(useCallback(value => applyText(joinDictation(textRef.current, value)), [applyText]), active && !pending);
	const [remoteBusy, setRemoteBusy] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [loading, setLoading] = useState(true);
	const [transportError, setTransportError] = useState<string | null>(null);
	const localBusy = status === "submitted" || status === "streaming";
	const busy = localBusy || remoteBusy;
	const busyRef = useRef(localBusy);
	busyRef.current = localBusy;
	const initialRef = useRef(false);
	const deliveredRef = useRef(onInitialDelivered);
	deliveredRef.current = onInitialDelivered;
	const inputRef = useRef<HTMLDivElement>(null);
	const syncGeneration = useRef(0);
	const sync = useCallback(async () => {
		const generation = ++syncGeneration.current;
		try {
			const record = await responseBody<ChatRecord & { turnInFlight?: boolean; turnError?: string; compacting?: boolean }>(await fetch(`/api/chats/${chat.id}`));
			if (generation !== syncGeneration.current) return;
			setTransportError(null);
			setRemoteBusy(!!record.turnInFlight);
			setCompacting(!!record.compacting);
			if (!busyRef.current) {
				setMessages(record.messages, record.turnError);
				if (record.turnInFlight) resumeStream();
			}
		} catch (cause) {
			if (generation === syncGeneration.current) setTransportError(cause instanceof Error ? cause.message : "Could not load this exploration.");
		} finally { if (generation === syncGeneration.current) setLoading(false); }
	}, [chat.id, setMessages, resumeStream]);
	setReattachSettled(() => { setRemoteBusy(false); void sync().catch(() => {}); });
	useEffect(() => { void sync().catch(() => {}); return () => { syncGeneration.current++; }; }, [sync]);
	useServerEvent("turn-started", ({ chatId }) => { if (chatId === chat.id && !busyRef.current) void sync().catch(() => {}); });
	useServerEvent("turn-settled", ({ chatId }) => { if (chatId === chat.id) { setRemoteBusy(false); if (!busyRef.current) void sync().catch(() => {}); } });
	useServerResync(() => { if (!busyRef.current) void sync().catch(() => {}); });
	useServerEvent("compaction-changed", ({ chatId, running }) => { if (chatId === chat.id) { setCompacting(running); if (!running && !busyRef.current) void sync(); } });
	useServerEvent("record-changed", ({ chatId }) => { if (chatId === chat.id && !busyRef.current) void sync(); });
	// Own-stream settle can arrive before the stream closes. Adopt durable
	// tool results once idle so failed answers and background deliveries recover.
	const previousStatus = useRef(status);
	useEffect(() => {
		const wasBusy = previousStatus.current === "submitted" || previousStatus.current === "streaming";
		previousStatus.current = status;
		if (wasBusy && !localBusy) void sync();
	}, [status, localBusy, sync]);
	const fetchJobs = useCallback(async () => {
		try {
			const result = await responseBody<{ jobs?: JobRecord[] }>(await fetch(`/api/jobs?chatId=${encodeURIComponent(chat.id)}`));
			setJobs(result.jobs ?? []);
		} catch { /* Transcript and turn events still recover delivered artifacts. */ }
	}, [chat.id]);
	useEffect(() => { void fetchJobs(); }, [fetchJobs]);
	useServerEvent("jobs-changed", ({ chatId }) => { if (chatId == null || chatId === chat.id) { void fetchJobs(); if (!busyRef.current) void sync(); } });
	useServerResync(() => { void fetchJobs(); });
	useEffect(() => {
		if (loading || transportError || !active || initialRef.current) return;
		if (nativeMessages.some(message => message.role === "user")) { initialRef.current = true; deliveredRef.current(); return; }
		if (!initialPrompt) { if (!textRef.current) applyText(chat.exploration.topic); return; }
		initialRef.current = true;
		// A create succeeds independently of the first send. Failed delivery leaves
		// the question editable here, without creating a second exploration.
		void send({ type: "text", text: initialPrompt }, () => deliveredRef.current()).then(accepted => {
			if (!accepted) applyText(initialPrompt);
		});
	}, [active, initialPrompt, loading, transportError, send, nativeMessages, chat.exploration.topic, applyText]);
	useEffect(() => {
		if (!active) return;
		inputRef.current?.focus({ preventScroll: true });
	}, [active]);
	const doSend = () => {
		if (!active || busy || compacting || loading || transportError || pending) return;
		void finishDictation().then(() => {
			const outgoing = textRef.current.trim();
			if (!outgoing) return;
			applyText("");
			void send({ type: "text", text: outgoing }, () => deliveredRef.current()).then(accepted => {
				if (!accepted && !textRef.current) applyText(outgoing);
			});
		});
	};
	const [stopping, setStopping] = useState(false);
	const stop = async () => {
		setStopping(true);
		try {
			await fetch("/api/activity/abort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "turn", id: chat.id }) });
		} catch { setTransportError("Could not stop the response. Please try again."); }
		finally { setStopping(false); }
	};
	const hashVisited = useRef(false);
	useEffect(() => {
		if (loading || hashVisited.current) return;
		const hash = window.location.hash.slice(1);
		const ownMessage = nativeMessages.some(message => "id" in message && messageAnchorId(String(message.id)) === hash);
		if (ownMessage) {
			hashVisited.current = true;
			requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: "center" }));
		}
	}, [loading, nativeMessages]);
	const firstParts = firstSourceTextParts(messages);
	const inputPaused = !active || busy || compacting || loading || !!transportError;
	const reveal = () => { void finishDictation().then(() => setRevealedId(pendingId)); };
	const answer = (output: QuestionAnswerData) => {
		if (!pending || inputPaused) return;
		saveQuestionDraft(pending.key, { readingThinking: readingRef.current });
		const reading = readingRef.current.trim();
		submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
	};
	const confirmAbort = (mode: AbortMode) => {
		setAbortAsk(null);
		if (mode === "turn") { void stop(); return; }
		if (!active || !pending) return;
		void finishDictation().then(() => {
			const output = dismissedAnswer(toolQuestionKind(pending.tool), (pending.input as { question?: string })?.question ?? "");
			const reading = readingRef.current.trim();
			dismissQuestion(pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
			if (busy) void stop();
		});
	};
	useEffect(() => {
		if (!active) return;
		const abort = () => {
			if (abortAsk || document.querySelector('[role="dialog"]')) return;
			if (pending) setAbortAsk("question");
			else if (busy) setAbortAsk("turn");
		};
		window.addEventListener("lh:kbd-abort-turn", abort);
		return () => window.removeEventListener("lh:kbd-abort-turn", abort);
	}, [active, abortAsk, pending, busy]);
	return (
		<ChatActionsContext.Provider value={{ chatId: chat.id, syncFromServer: sync,
			sendText: value => { if (active && !busy && !compacting) void send({ type: "text", text: value }); },
			openSetup: () => parentActions?.openSetup() }}>
		<LearningMomentsProvider chatId={chat.id} busy={busy}>
		<JobsContext.Provider value={jobs}>
		<div className="border-t border-primary/15 px-4 pb-3">
			<div data-testid="exploration-transcript" className="space-y-3 py-3">
				{messages.map(message => {
					if (message.parts.some(part => part.type === "data-subagent-artifact" || part.type === "data-subagent-aborted")) {
						return <SourcePassage key={message.id} messageId={message.id}><SubagentSteerCard message={message} /></SourcePassage>;
					}
					return <SourcePassage key={message.id} messageId={message.role === "user" ? message.id : undefined} className={message.role === "user" ? "border-l-2 border-muted-foreground/30 pl-3 text-sm" : "text-sm"}>
						{message.role === "user" && message.parts.some(part => part.type === "text") && <div className="text-xs font-medium uppercase text-muted-foreground">You</div>}
						{message.parts.map((part, index) => {
							if (part.type === "text") {
								const id = textPartMessageId(part.id);
								return <div key={part.id || index} id={id && firstParts.get(id) === part.id ? messageAnchorId(id) : undefined} data-source-message-id={message.role !== "user" ? id ?? undefined : undefined} data-source-part-id={part.id}>{message.role === "user" ? <p className="whitespace-pre-wrap">{part.text}</p> : <MessageResponse>{part.text}</MessageResponse>}{message.role !== "user" && id && firstParts.get(id) === part.id && <MarkLearningMoment messageId={id} />}</div>;
							}
							if (part.type === "reasoning") return <Reasoning key={index} isStreaming={localBusy}><ReasoningTrigger /><ReasoningContent>{part.text ?? ""}</ReasoningContent></Reasoning>;
							if (part.type === "data-plan-block") return <PlanBlock key={index} data={part.data as PlanBlockData} onOpen={() => onOpenPlan?.(messages)} />;
							if (part.type === "data-compaction") return <CompactionMomentDivider key={index} data={part.data as CompactionDividerData} />;
							if (part.type === "data-compaction-cut") return <CompactionCutDivider key={index} data={part.data as CompactionDividerData} />;
							if (part.type.startsWith("tool-") && part.state === "output-error") return part.errorText === "Operation aborted" ? null : <div key={index} className="text-xs text-muted-foreground">Retrying…</div>;
							if (["tool-quiz", "tool-explain", "tool-ask_user_question", "tool-probe", "tool-recall"].includes(part.type)) {
								return part.state === "output-available" ? <SourcePassage key={index} messageId={part.sourceMessageId}><AnsweredCard answer={part.output as QuestionAnswerData} input={part.input} /></SourcePassage> : null;
							}
							if (part.type.startsWith("tool-") && part.state === "input-streaming") return <LiveToolCard key={index} part={part as ArtifactPartProps["part"]} />;
							const Renderer = part.type.startsWith("tool-") ? artifactRenderers[part.type.slice(5)] : undefined;
							return Renderer ? <Renderer key={index} part={part as ArtifactPartProps["part"]} /> : null;
						})}
					</SourcePassage>;
				})}
				{busy && <div role="status" className="text-xs text-muted-foreground">Exploring…</div>}
				{error && <p role="alert" className="text-sm text-destructive">{explorationErrorMessage(error.message)}</p>}
				{transportError && <p role="alert" className="text-sm text-destructive">{transportError} <button type="button" className="underline" onClick={() => { void sync(); }}>Retry</button></p>}
				{compacting && <div role="status" className="text-xs text-muted-foreground">Compacting this exploration…</div>}
				{active && !busy && !compacting && endsInFailedTurn(nativeMessages) && <button type="button" className="rounded-md border px-3 py-1 text-sm hover:bg-accent" onClick={() => { void send({ type: "retry" }); }}>Retry response</button>}
			</div>
			<div hidden={!active} inert={!active}>
				{pending ? <>
					{requiresReveal && <ReadingThinkingField value={readingThinking} onChange={applyReading} onEscape={() => { void finishDictation(); }} onOpen={revealPending ? reveal : undefined} claim={active && revealPending} />}
					<div className="rounded-xl border bg-background"><QuestionDock key={pending.key}
						toolName={pending.tool as "quiz" | "explain" | "ask_user_question" | "probe" | "recall"} toolCallId={pending.toolCallId} input={pending.input as never}
						expanded={!revealPending} reveal={revealPending} phase={phase} onExpand={reveal} onSubmit={answer}
						initialDraft={questionDraft(pending.key)?.form} onSaveDraft={form => saveQuestionDraft(pending.key, { form })}
						paused={inputPaused || revealPending} compactionRunning={compacting} dictationClaim={active && !revealPending} onEscape={() => { void finishDictation(); }} /></div>
					{busy && <button type="button" onClick={() => setAbortAsk("turn")} className="mr-3 mt-2 text-xs text-muted-foreground underline">Stop response</button>}
					<button type="button" disabled={inputPaused} onClick={() => setAbortAsk("question")} className="mt-2 text-xs text-muted-foreground underline disabled:opacity-40">Dismiss question</button>
				</> : <div className="rounded-xl border bg-background"><Composer busy={busy} value={text} onChange={applyText} onSend={doSend} onStop={() => setAbortAsk("turn")} canSend={!inputPaused && (!!text.trim() || isDictationActive())} inputRef={inputRef} placeholder="Ask more about this idea…" /></div>}
				<div className="mx-auto mt-3 flex w-full max-w-[46rem] items-center justify-between gap-3">
					{active && dictationSlot && <div className="flex min-w-0 flex-1 items-center justify-center">{dictationSlot}</div>}
					<span className="text-xs text-muted-foreground">Your lesson is waiting where you left it.</span>
					<button type="button" onClick={onClose} disabled={busy || compacting || changing || stopping || loading || jobs.some(job => job.status === "running")} className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-40"><CornerUpLeftIcon className="size-4" />Return to lesson</button>
				</div>
			</div>
		</div>
		<AbortTurnDialog mode={active ? abortAsk : null} onClose={() => setAbortAsk(null)} onConfirm={confirmAbort} busy={busy} />
		</JobsContext.Provider>
		</LearningMomentsProvider>
		</ChatActionsContext.Provider>
	);
}
