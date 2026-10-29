"use client";

import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LEARNING_SUBJECT_UNASSIGNED_ID } from "@/src/core";
import type { LearningGraphSnapshot, LearningProgress } from "@/src/core";

export const LEARNING_PROGRESS_LABELS: Record<LearningProgress, string> = {
	unassessed: "Unassessed",
	learning: "Learning",
	comfortable: "Comfortable",
};

/** Shape carries the distinction as well as color: hollow, centered, filled. */
export function LearningProgressDot({ progress, className }: { progress: LearningProgress; className?: string }) {
	return (
		<span aria-hidden="true" className={cn(
			"inline-flex size-3 shrink-0 items-center justify-center rounded-full border",
			progress === "comfortable" ? "border-[#709b83] bg-[#709b83]" : progress === "learning" ? "border-[#b58b55]" : "border-muted-foreground/70",
			className,
		)}>
			{progress === "learning" && <span className="size-1 rounded-full bg-[#b58b55]" />}
		</span>
	);
}

export function LearningProgressLegend({ className }: { className?: string }) {
	return (
		<div aria-label="Understanding legend" className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground", className)}>
			{(["unassessed", "learning", "comfortable"] as const).map((progress) => (
				<span key={progress} className="inline-flex items-center gap-2"><LearningProgressDot progress={progress} />{LEARNING_PROGRESS_LABELS[progress]}</span>
			))}
		</div>
	);
}

export interface LearningIcebergProps {
	learning: LearningGraphSnapshot;
	selectedId: string | null;
	onSelect: (id: string) => void;
	visibleIds?: ReadonlySet<string>;
	subjects?: { id: string; name: string; nodeIds: string[] }[];
	subjectId?: string | null;
	onSubjectChange?: (id: string) => void;
	className?: string;
}

/** Remember the initial fallback too: a newly discovered subject must not
 * switch the open map. An empty refresh does not erase the user's choice. */
export function useLearningSubjectSelection(subjects: readonly { id: string }[]) {
	const [subjectId, setSubjectId] = useState<string | null>(null);
	const activeSubjectId = subjects.some((subject) => subject.id === subjectId) ? subjectId : subjects[0]?.id ?? null;
	useEffect(() => {
		if (activeSubjectId !== null) setSubjectId(activeSubjectId);
	}, [activeSubjectId]);
	return [activeSubjectId, setSubjectId] as const;
}

export function LearningIceberg({ learning, selectedId, onSelect, visibleIds, subjects, subjectId, onSubjectChange, className }: LearningIcebergProps) {
	const nodeById = new Map(learning.nodes.map((node) => [node.id, node]));
	const groups = learning.groups.filter((group) => group.members.some((id) => !visibleIds || visibleIds.has(id)));
	const levels = [...new Set(groups.map((group) => group.depth))].sort((a, b) => a - b);
	const groupById = new Map(learning.groups.map((group) => [group.id, group]));
	const groupedIds = new Set(learning.groups.flatMap((group) => group.members));
	const ungrouped = learning.nodes.filter((node) => !groupedIds.has(node.id) && (!visibleIds || visibleIds.has(node.id)));
	const subject = subjects?.find((value) => value.id === subjectId);
	return (
		<div data-testid="learning-iceberg" className={cn("lh-no-drag overflow-y-auto overscroll-contain bg-background px-4 pb-8 pt-4 sm:px-6", className)}>
			<div className="mb-6 max-w-2xl">
				{subjects && onSubjectChange && <label className="mb-4 flex max-w-sm items-center gap-3 text-xs text-muted-foreground">Subject<select aria-label="Iceberg subject" value={subjectId ?? ""} onChange={(event) => onSubjectChange(event.target.value)} disabled={subjects.length === 0} className="min-h-10 min-w-0 flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:border-foreground/60 disabled:opacity-50">{subjects.map((value) => <option key={value.id} value={value.id}>{value.name} · {value.nodeIds.length}</option>)}</select></label>}
				<h2 className="font-title text-2xl">{subject?.name ?? "The shape of the subject"}</h2>
				<p className="mt-2 font-prose text-base leading-relaxed text-muted-foreground">Concepts learned together, from foundations toward deeper applications. Your understanding sits on top of the map.</p>
				{subject && <p className="mt-2 text-xs text-muted-foreground">{subject.id === LEARNING_SUBJECT_UNASSIGNED_ID ? "These concepts have no subject assignment yet. Set subjects in their details." : `Showing concepts assigned to ${subject.name}. Change a concept’s subjects in its details.`}</p>}
				<LearningProgressLegend className="mt-4" />
				<p className="mt-3 text-xs text-muted-foreground">Ready means the recorded prerequisites are comfortable, including prerequisites in other subjects. It does not mark the next concept as understood.</p>
			</div>
			{groups.length === 0 && ungrouped.length === 0 && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{visibleIds && visibleIds.size === 0 ? "No concepts match this search." : "Groups will appear as the harness maps related concepts from your sessions."}</p>}
			<div className="space-y-6">
				{levels.map((depth) => (
					<section key={depth} aria-label={depth === 0 ? "Foundations" : `Depth ${depth}`} className="relative border-t border-dashed border-border/70 pt-4">
						<div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
							{depth > 0 && <ArrowDownIcon className="size-3" aria-hidden="true" />}
							<span>{depth === 0 ? "Foundations" : `Depth ${depth}`}</span>
							<span className="ml-auto normal-case tracking-normal">{depth === 0 ? "Start here" : "Builds on earlier concepts"}</span>
						</div>
						<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] items-start gap-4">
							{groups.filter((group) => group.depth === depth).map((group) => {
								const members = group.members.map((id) => nodeById.get(id)).filter((node) => node !== undefined);
								const incoming = learning.groupEdges.filter((edge) => edge.to === group.id).map((edge) => groupById.get(edge.from)).filter((value) => value !== undefined);
								const unlocked = group.unlocks.map((id) => nodeById.get(id)).filter((node) => node !== undefined);
								return (
									<article key={group.id} data-testid={`learning-group-${group.id}`} className="min-w-0 rounded-xl border border-border/70 bg-card/70 p-4">
										<div className="flex items-start justify-between gap-3">
											<h3 className="font-title text-xl">{group.name}</h3>
											<span className="shrink-0 pt-1 text-xs tabular-nums text-muted-foreground">{group.counts.comfortable}/{members.length}</span>
										</div>
										{group.description && <p className="mt-1 font-prose text-sm leading-relaxed text-muted-foreground">{group.description}</p>}
										<div role="img" aria-label={`${group.counts.comfortable} comfortable, ${group.counts.learning} learning, ${group.counts.unassessed} unassessed`} className="mt-3 flex h-1 overflow-hidden rounded-full bg-border/40">
											<span className="bg-[#709b83]" style={{ width: `${100 * group.counts.comfortable / Math.max(members.length, 1)}%` }} />
											<span className="bg-[#b58b55]" style={{ width: `${100 * group.counts.learning / Math.max(members.length, 1)}%` }} />
										</div>
										<p className="mt-2 text-xs text-muted-foreground">{group.readyNodeIds.length} ready to learn · {group.counts.learning} learning</p>
										<ul className="mt-3 space-y-1">
											{members.filter((node) => !visibleIds || visibleIds.has(node.id)).map((node) => (
												<li key={node.id}>
													<button type="button" aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)} className={cn("flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent", selectedId === node.id && "bg-accent")}>
														<LearningProgressDot progress={node.progress} />
														<span className="min-w-0 flex-1 break-words font-prose text-base">{node.name}<span className="sr-only">, {LEARNING_PROGRESS_LABELS[node.progress]}</span></span>
														{node.ready && node.progress !== "comfortable" && <span className="shrink-0 text-xs text-muted-foreground">Ready</span>}
													</button>
												</li>
												))}
										</ul>
										{incoming.length > 0 && <p className="mt-3 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">Builds on {incoming.map((value) => value.name).join(" · ")}</p>}
										{unlocked.length > 0 && (
											<div className="mt-3 border-t border-border/50 pt-3">
												<p className="text-xs text-muted-foreground">Comfort with this group unlocks</p>
												{unlocked.map((node) => <button key={node.id} type="button" onClick={() => onSelect(node.id)} className="mt-1 flex min-h-9 items-center gap-2 text-left font-prose text-sm hover:underline focus-visible:underline"><ArrowUpRightIcon aria-hidden="true" className="size-3 shrink-0" />{node.name}</button>)}
											</div>
										)}
									</article>
								);
							})}
						</div>
					</section>
				))}
			</div>
			{ungrouped.length > 0 && <section aria-label="Not grouped yet" className="mt-6 border-t border-dashed border-border/70 pt-4">
				<h3 className="text-xs uppercase tracking-wider text-muted-foreground">Not grouped yet</h3>
				<p className="mt-2 font-prose text-sm text-muted-foreground">These concepts are on your map. A later update can place them alongside related concepts.</p>
				<ul className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2">{ungrouped.map((node) => <li key={node.id}><button type="button" onClick={() => onSelect(node.id)} aria-pressed={selectedId === node.id} className={cn("flex min-h-11 w-full items-center gap-3 rounded-md border border-border/50 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent", selectedId === node.id && "bg-accent")}><LearningProgressDot progress={node.progress} /><span className="font-prose text-base">{node.name}<span className="sr-only">, {LEARNING_PROGRESS_LABELS[node.progress]}</span></span></button></li>)}</ul>
			</section>}
			{learning.cycles.length > 0 && <p role="status" className="mt-6 rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">Some prerequisites form a loop. These concepts share a depth until you correct the connections in their details.</p>}
		</div>
	);
}
