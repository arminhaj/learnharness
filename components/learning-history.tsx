"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRightIcon, BookmarkPlusIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import { historyPassageKey, historyReplayGroups, momentLabels, strategyKey, propositionSessionHref, type HistoryEpisode, type HistoryPassage, type LearningHistorySnapshot } from "@/src/core";
import { TopBar } from "./top-bar";
import { useServerEvent, useServerResync } from "./server-events";
import { SessionStarter } from "./start-session";

const actionClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 py-2 font-ui text-xs hover:bg-accent disabled:opacity-40";
const labelClass = "font-ui text-xs uppercase tracking-wider text-muted-foreground";
const empty: LearningHistorySnapshot = { enabled: false, sessions: [], passages: {}, episodes: [], moments: [], corrections: {}, savedStrategies: [], status: { running: false, completed: 0, total: 0 } };
const date = (stamp: string) => new Date(stamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function historySourceHref(data: LearningHistorySnapshot, chatId: string, messageId: string) {
	return propositionSessionHref({ provenance: [{ chatId, messageId, subjectId: data.sessions.find(s => s.id === chatId)?.parentId }] }, chatId);
}

/** Wording is explicitly coherence-edited speech, never presented as a
 * verbatim quote. Unresolved dictation stays visible and user-correctable. */
export function HistorySpeech({ passage, title, href, onCorrect }: { passage?: HistoryPassage; title: string; href?: string; onCorrect?: (text: string) => Promise<void> }) {
	const [editing, setEditing] = useState(false), [text, setText] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
	return <section className={`my-4 rounded-lg border p-4 ${passage ? "" : "border-dashed"}`}>
		<p className={labelClass}>{title}</p>
		{passage ? <>
			<p className="mt-2 whitespace-pre-wrap font-prose text-xl">{passage.text}</p>
			<p className="mt-3 text-xs text-muted-foreground">{date(passage.observedAt)} · coherence-edited speech</p>
			{passage.unclear.length > 0 && <p className="mt-2 font-prose text-sm">Unclear dictation: {passage.unclear.join("; ")}</p>}
			<div className="mt-3 flex flex-wrap gap-3">{href && <Link className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={href}>Go to source moment <ArrowUpRightIcon className="size-3" /></Link>}{onCorrect && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setText(passage.text); setEditing(!editing); }}>Correct wording</button>}</div>
			{editing && <form className="mt-3" onSubmit={async e => { e.preventDefault(); setSaving(true); setError(null); try { await onCorrect?.(text); setEditing(false); } catch (error) { setError(error instanceof Error ? error.message : "Could not save this wording."); } finally { setSaving(false); } }}><label className="text-xs">Your wording<textarea className="mt-2 w-full rounded-md border bg-background p-3 font-prose text-lg" value={text} onChange={e => setText(e.target.value)} rows={4} required maxLength={16000} /></label><button className={actionClass} disabled={saving || !text.trim()}>Save wording</button>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</form>}
		</> : <p className="mt-3 font-prose text-base text-muted-foreground">No earlier learner explanation was found. The history does not invent one from the tutor’s explanation.</p>}
	</section>;
}

export function LearningHistoryPage() {
	const router = useRouter(), starter = useRef(new SessionStarter());
	const [data, setData] = useState(empty), [loaded, setLoaded] = useState(false), [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<"timeline" | "strategies" | "replay">("timeline"), [sessionId, setSessionId] = useState("");
	const [selected, setSelected] = useState(""), [strategy, setStrategy] = useState(""), [topic, setTopic] = useState("");
	const [sourceOpen, setSourceOpen] = useState(false), [correcting, setCorrecting] = useState(false), [correction, setCorrection] = useState("");
	const [hiddenLater, setHiddenLater] = useState(false), [drafts, setDrafts] = useState<Record<string, string>>({}), [starting, setStarting] = useState(false);
	const started = useRef(false);
	const load = useCallback(async () => {
		try { const response = await fetch("/api/learning-history"); const body = await response.json(); if (!response.ok) throw new Error(body.error); setData(body); setLoaded(true); }
		catch (error) { setError(error instanceof Error ? error.message : "Could not load learning history."); }
	}, []);
	useEffect(() => { void load(); }, [load]);
	useServerEvent("learning-history-changed", () => void load());
	useServerEvent("chats-changed", () => void load());
	useServerResync(() => void load());
	const refresh = useCallback(async (cancel = false) => {
		setError(null);
		try { const response = await fetch("/api/learning-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cancel ? { cancel: true } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); await load(); }
		catch (error) { setError(error instanceof Error ? error.message : "History update could not start."); }
	}, [load]);
	useEffect(() => { if (loaded && !started.current) { started.current = true; if (data.sessions.some(s => s.pending) && !data.status.running) void refresh(); } }, [loaded, data.sessions, data.status.running, refresh]);
	async function mutate(body: unknown) {
		setError(null);
		try {
			const response = await fetch("/api/learning-history", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(result);
		} catch (error) { setError(error instanceof Error ? error.message : "Could not save this change."); throw error; }
	}
	const filtered = useMemo(() => ({ ...data, episodes: data.episodes.filter(e => !sessionId || e.chatId === sessionId), moments: data.moments.filter(m => !sessionId || m.chatId === sessionId) }), [data, sessionId]);
	const episodes = filtered.episodes;
	const event = episodes.find(e => e.id === selected) ?? episodes[0];
	const strategies = useMemo(() => {
		const groups = new Map<string, { key: string; name: string; cue: string; episodes: HistoryEpisode[] }>();
		for (const e of episodes) if (e.strategy) { const key = strategyKey(e.strategy.name), group = groups.get(key) ?? { key, name: e.strategy.name, cue: e.strategy.cue, episodes: [] }; group.episodes.push(e); groups.set(key, group); }
		return [...groups.values()];
	}, [episodes]);
	const chosenStrategy = strategies.find(s => s.key === strategy) ?? strategies[0];
	const replays = historyReplayGroups(filtered), replay = replays.find(r => r.key === topic) ?? replays[0];
	const passage = (chatId: string, id: string | null) => id ? data.passages[historyPassageKey(chatId, id)] : undefined;
	const speech = (chatId: string, id: string | null, title: string) => {
		const p = passage(chatId, id);
		return <HistorySpeech key={`${chatId}/${id}/${title}`} passage={p} title={title} href={p ? historySourceHref(data, chatId, p.messageId) : undefined} onCorrect={p ? text => mutate({ action: "wording", chatId, passageId: p.id, text }) : undefined} />;
	};
	const titleFor = (id: string) => data.sessions.find(s => s.id === id)?.title ?? "Session";
	return <div className="flex h-dvh min-w-0 flex-col">
		<TopBar><span className="font-ui text-sm">Learning history</span><div className="ml-auto flex gap-2"><button className={actionClass} onClick={() => void refresh(data.status.running)}>{data.status.running ? "Stop update" : <><RefreshCwIcon className="size-3" />Update history</>}</button></div></TopBar>
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
				<h1 className="font-title text-3xl">How you got here</h1><p className="mt-2 font-prose text-lg text-muted-foreground">What changed in your thinking. What helped you get there.</p>
				<div className="my-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{data.sessions.filter(s => s.analyzedAt && !s.pending).length} of {data.sessions.length} existing sessions analyzed</span><label className="flex min-w-0 items-center gap-2">Sessions <select aria-label="Filter history by session" className="min-w-0 max-w-80 rounded-md border bg-background p-2 text-foreground" value={sessionId} onChange={e => { setSessionId(e.target.value); setSelected(""); }}><option value="">All sessions</option>{data.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label></div>
				{data.status.running && <p role="status" className="my-3 rounded-md border bg-card p-3 text-xs">{data.status.stage === "cleaning" ? "Making recorded speech coherent" : "Finding learning episodes"} · {data.status.completed} of {data.status.total} sessions finished{data.status.chatId ? ` · ${titleFor(data.status.chatId)}` : ""}. You can keep learning.</p>}
				{(error || data.status.error) && <p role="alert" className="my-3 rounded-md border p-3 font-prose text-base text-destructive">{error ?? data.status.error}</p>}
				<details className="mb-4 text-xs text-muted-foreground"><summary>History coverage and wording</summary><p className="my-3 font-prose text-base">Earlier conversations are included automatically. A dedicated coherence pass cleans dictated speech without summarizing or correcting your ideas. Uncertain words remain flagged. Personal markers are recorded only when you add them.</p><ul className="space-y-2">{data.sessions.map(s => <li key={s.id}>{s.title} · {s.error ?? (s.pending ? "Awaiting analysis" : "Analyzed")}</li>)}</ul></details>
				<nav role="tablist" aria-label="Learning history views" className="mb-6 flex flex-wrap gap-1 border-b">{([['timeline','Turning points'],['strategies','Successful strategies'],['replay','Then & now']] as const).map(([value, label]) => <button key={value} id={`history-tab-${value}`} type="button" role="tab" aria-controls={`history-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onKeyDown={e => {
						const tabs = ['timeline', 'strategies', 'replay'] as const;
						const index = tabs.indexOf(value);
						const target = e.key === "ArrowRight" ? tabs[(index + 1) % 3] : e.key === "ArrowLeft" ? tabs[(index + 2) % 3] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[2] : undefined;
						if (target) { e.preventDefault(); setTab(target); document.getElementById(`history-tab-${target}`)?.focus(); }
					}} onClick={() => { setTab(value); setSourceOpen(false); }} className={`border-b-2 px-3 py-3 text-sm hover:bg-accent ${tab === value ? "border-foreground" : "border-transparent text-muted-foreground"}`}>{label}</button>)}</nav>
				{!loaded && !error && <p role="status">Loading history…</p>}
				{loaded && !data.sessions.length && <p className="font-prose text-lg">Your teaching sessions will appear here. You can mark meaningful moments as you learn.</p>}
				<section role="tabpanel" id="history-panel-timeline" aria-labelledby="history-tab-timeline" hidden={tab !== "timeline"}>
					{filtered.moments.length > 0 && <details open={!episodes.length} className="mb-6 rounded-lg border p-4"><summary className="text-sm">Moments you marked · {filtered.moments.length}</summary><div className="mt-3 space-y-4">{filtered.moments.map(m => <div key={m.id} className="border-l-2 pl-3"><span className="text-sm">{momentLabels[m.kind]}</span><p className="mt-1 text-xs text-muted-foreground">{titleFor(m.chatId)} · marked by you {date(m.createdAt)} · {m.surface === "session" ? "in the session" : "while reviewing history"}</p>{m.note && <p className="mt-2 whitespace-pre-wrap font-prose text-base">{m.note}</p>}<Link className="mt-2 inline-block text-xs underline" href={historySourceHref(data, m.chatId, m.messageId)}>Go to marked moment</Link></div>)}</div></details>}
					{event ? <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)]"><div className="space-y-2">{episodes.map(e => <button type="button" key={e.id} aria-pressed={e.id === event.id} onClick={() => { setSelected(e.id); setSourceOpen(false); setCorrecting(false); }} className={`w-full rounded-lg border p-3 text-left ${e.id === event.id ? "border-border bg-card" : "border-transparent hover:bg-accent"}`}><span className="text-xs text-muted-foreground">{date(e.observedAt)}</span><span className="mt-2 block font-prose text-lg">{e.title}</span></button>)}</div><article>
						<p className={labelClass}>Suggested from conversation history</p><h2 className="mt-2 font-title text-2xl">{event.title}</h2><p className="mt-2 text-xs text-muted-foreground">{titleFor(event.chatId)} · {event.topic}</p>
						{speech(event.chatId, event.beforeId, "Your earlier explanation")}
						<div className="rounded-lg border bg-card p-4"><p className={labelClass}>What happened between</p><p className="mt-2 font-prose text-lg">{event.change}</p></div>
						{speech(event.chatId, event.afterId, "Your later explanation")}
						<dl className="space-y-3 border-t pt-4">{[["Subject assumption",event.subjectAssumption],["Learning process",event.processPattern],["Tutor contribution",event.tutorContribution]].map(([label,value]) => <div key={label} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-prose text-base">{value || "No supported observation in this episode."}</dd></div>)}</dl><p className="mt-3 text-xs text-muted-foreground">Evidence: {{ explanation:"learner explanation", with_help:"demonstration with help", independent:"independent application", uncertain:"uncertain" }[event.support]}. Later recall is a separate observation.</p>
						{data.corrections[event.id] && <div className="mt-4 rounded-md border bg-card p-3"><p className={labelClass}>Your correction</p><p className="mt-2 whitespace-pre-wrap font-prose text-base">{data.corrections[event.id]}</p></div>}
						<div className="mt-4 flex flex-wrap gap-2"><button className={actionClass} onClick={() => setSourceOpen(!sourceOpen)}>Read cleaned context</button><button className={actionClass} onClick={() => { setCorrection(data.corrections[event.id] ?? ""); setCorrecting(!correcting); }}>Correct interpretation</button></div>
						{correcting && <form className="mt-4" onSubmit={e => { e.preventDefault(); void mutate({ action:"correct",episodeId:event.id,text:correction }).then(() => setCorrecting(false)).catch(() => {}); }}><label className="text-sm">Your context<textarea className="my-2 w-full rounded-md border bg-background p-3 font-prose text-lg" maxLength={8000} value={correction} onChange={e => setCorrection(e.target.value)} rows={3} /></label><button className={actionClass}>Save correction</button></form>}
						{sourceOpen && <div className="mt-4 border-t pt-4"><p className={labelClass}>Cleaned conversation context</p>{[...new Set(event.contextIds)].map(id => speech(event.chatId,id,passage(event.chatId,id)?.role === "learner" ? "You" : "Tutor"))}{!event.contextIds.length && <p className="mt-3 font-prose">No additional context was identified.</p>}</div>}
					</article></div> : loaded && <p className="font-prose text-lg text-muted-foreground">{data.status.running ? "Turning points will appear as earlier sessions are analyzed." : "No supported turning points yet. Your marked moments remain available; no additional journaling is required."}</p>}
				</section>
				<section role="tabpanel" id="history-panel-strategies" aria-labelledby="history-tab-strategies" hidden={tab !== "strategies"}>
					{chosenStrategy ? <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)]"><div className="space-y-2">{strategies.map(s => <button className={`w-full rounded-lg border p-3 text-left ${s.key === chosenStrategy.key ? "bg-card" : "border-transparent hover:bg-accent"}`} aria-pressed={s.key === chosenStrategy.key} key={s.key} onClick={() => setStrategy(s.key)}><span className="font-prose text-lg">{s.name}</span><span className="mt-2 block text-xs text-muted-foreground">{new Set(s.episodes.map(e => e.chatId)).size} source sessions{data.savedStrategies.includes(s.key) ? " · kept" : ""}</span></button>)}</div><article><p className={labelClass}>Suggested from earlier sessions</p><h2 className="mt-2 font-title text-2xl">{chosenStrategy.name}</h2><div className="my-4 rounded-lg border bg-card p-4"><p className={labelClass}>A cue to use again</p><p className="mt-2 font-prose text-lg">{chosenStrategy.cue}</p></div>{chosenStrategy.episodes.map(e => <div key={e.id} className="border-t py-4"><p className="text-xs text-muted-foreground">{titleFor(e.chatId)} · {date(e.observedAt)}</p><p className="my-2 font-prose text-lg">{e.strategy!.observation}</p><button className="text-xs underline" onClick={() => { setSelected(e.id); setTab("timeline"); }}>Inspect this episode</button></div>)}<p className="text-xs text-muted-foreground">These observations describe what followed an approach; they do not establish a fixed learning style or prove causation.</p><div className="mt-4 flex flex-wrap gap-2"><button className={actionClass} onClick={() => void mutate({ action:"strategy",key:chosenStrategy.key,saved:!data.savedStrategies.includes(chosenStrategy.key) }).catch(() => {})}>{data.savedStrategies.includes(chosenStrategy.key) ? <CheckIcon className="size-3" /> : <BookmarkPlusIcon className="size-3" />}{data.savedStrategies.includes(chosenStrategy.key) ? "Kept · remove" : "Keep in my strategies"}</button><button className={actionClass} disabled={starting} onClick={async () => { setStarting(true); try { const prompt = `Help me practice ${chosenStrategy.episodes.map(e => e.topic).filter((v,i,a)=>a.indexOf(v)===i).join(", ")}. A strategy I want to test is: ${chosenStrategy.cue} Give me a fresh problem and check whether I use the approach independently before offering a reminder. Do not assume this strategy always helps.`; router.push(await starter.current.start({ title:prompt,kind:"practice" },fetch)); } catch { setError("Could not start practice. Check your model setup and try again."); } finally { setStarting(false); } }}>Try in practice</button></div></article></div> : <p className="font-prose text-lg text-muted-foreground">Strategies appear when the conversation supports an approach and what followed it.</p>}
				</section>
				<section role="tabpanel" id="history-panel-replay" aria-labelledby="history-tab-replay" hidden={tab !== "replay"}>
					{replay ? <><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><label className="text-xs">Concept <select className="ml-2 max-w-full rounded-md border bg-background p-2" value={replay.key} onChange={e => { setTopic(e.target.value); setHiddenLater(false); }}>{replays.map(r => <option key={r.key} value={r.key}>{r.topic}</option>)}</select></label><button className={actionClass} onClick={() => setHiddenLater(!hiddenLater)}>{hiddenLater ? "Reveal later explanation" : "Replay without later answer"}</button></div><h2 className="font-title text-2xl">{replay.topic}</h2><div className="grid gap-4 lg:grid-cols-2"><div>{replay.samples.length > 1 ? speech(replay.samples[0]!.chatId,replay.samples[0]!.passage.id,"Then") : <HistorySpeech title="Then" />}</div><div>{hiddenLater ? <section className="my-4 rounded-lg border bg-card p-4"><label className={labelClass}>Your explanation today · optional<textarea className="my-3 w-full rounded-md border bg-background p-3 font-prose text-lg normal-case tracking-normal" rows={5} value={drafts[replay.key] ?? ""} onChange={e => setDrafts({ ...drafts,[replay.key]:e.target.value })} /></label><button className={actionClass} onClick={() => setHiddenLater(false)}>Reveal later explanation</button><p className="mt-3 text-xs text-muted-foreground">Replay draft stays on this page and is not assessed.</p></section> : speech(replay.samples.at(-1)!.chatId,replay.samples.at(-1)!.passage.id,"Later")}</div></div>{!hiddenLater && drafts[replay.key] && <div className="rounded-lg border p-4"><p className={labelClass}>Your replay draft · not assessed</p><p className="mt-2 whitespace-pre-wrap font-prose text-lg">{drafts[replay.key]}</p></div>}<p className="mt-4 font-prose text-base text-muted-foreground">{replay.samples.length > 1 ? "Compare the reasoning and the context, including any hints. A later explanation is evidence from that occasion, not a permanent mastery rating." : "Only one learner explanation is available. The earlier state remains unknown."}</p></> : <p className="font-prose text-lg text-muted-foreground">Then-and-now comparisons are built from learner explanations already present in your sessions.</p>}
				</section>
			</div>
		</div>
	</div>;
}
