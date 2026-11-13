"use client";

import { ChevronLeftIcon, ChevronRightIcon, FocusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const directions = [
	{ value: "prerequisites", label: "Prerequisites" },
	{ value: "unlocks", label: "Unlocks" },
] as const;

type FocusDirection = (typeof directions)[number]["value"];

export interface LearningFocusControlsProps {
	anchorName: string;
	direction: FocusDirection;
	level: number;
	maxLevel: number;
	conceptCount: number;
	connectionCount: number;
	showPaths: boolean;
	onDirectionChange: (direction: FocusDirection) => void;
	onLevelChange: (level: number) => void;
	onShowPathsChange: (showPaths: boolean) => void;
	onExit: () => void;
	className?: string;
}

const buttonClass = "inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent focus-visible:outline-ring disabled:opacity-40";
const groupClass = "flex shrink-0 items-center gap-0.5 rounded-lg border border-border/70 p-0.5";
const pressedClass = "bg-accent font-medium text-foreground";

export function LearningFocusControls({
	anchorName, direction, level, maxLevel, conceptCount, connectionCount, showPaths,
	onDirectionChange, onLevelChange, onShowPathsChange, onExit, className,
}: LearningFocusControlsProps) {
	const hasLevels = maxLevel > 0;
	const emptyStatus = direction === "prerequisites"
		? "No recorded prerequisites in this view."
		: "No recorded dependent concepts in this view.";

	return (
		<section aria-label="Concept focus" className={cn("lh-no-drag flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border bg-card/95 px-2 py-1.5 text-xs shadow-sm backdrop-blur", className)}>
			<div className="flex min-w-0 max-w-full items-center gap-1.5 px-1">
				<FocusIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				<span className="sr-only">Focused on </span>
				<span className="truncate font-medium" title={anchorName}>{anchorName}</span>
			</div>
			<div role="group" aria-label="Focus direction" className={groupClass}>
				{directions.map(({ value, label }) => (
					<button key={value} type="button" className={cn(buttonClass, direction === value && pressedClass)} aria-pressed={direction === value} onClick={() => onDirectionChange(value)}>
						{label}
					</button>
				))}
			</div>
			<div role="group" aria-label="Focus level" className={groupClass}>
				<button type="button" className={cn(buttonClass, "size-8 px-0")} aria-label="Previous level" disabled={level <= 1} onClick={() => onLevelChange(level - 1)}>
					<ChevronLeftIcon aria-hidden="true" className="size-4" />
				</button>
				<span className="whitespace-nowrap px-1 font-medium tabular-nums">{hasLevels ? `Level ${level} of ${maxLevel}` : "Anchor only"}</span>
				<button type="button" className={cn(buttonClass, "size-8 px-0")} aria-label="Next level" disabled={level >= maxLevel} onClick={() => onLevelChange(level + 1)}>
					<ChevronRightIcon aria-hidden="true" className="size-4" />
				</button>
			</div>
			<button type="button" className={cn(buttonClass, "border border-border/70", showPaths && pressedClass)} aria-pressed={hasLevels && showPaths} disabled={!hasLevels} title="Show the recorded connections along paths between this level and the focus concept." onClick={() => onShowPathsChange(!showPaths)}>
				Show paths
			</button>
			<button type="button" className={cn(buttonClass, "text-muted-foreground")} onClick={onExit}>
				<XIcon aria-hidden="true" className="size-3.5" />Exit focus
			</button>
			<p role="status" aria-atomic="true" className="px-1 text-muted-foreground">
				{hasLevels ? <>
					<span className="sr-only">Level {level}. </span>
					{conceptCount} {conceptCount === 1 ? "concept" : "concepts"} · {connectionCount} {connectionCount === 1 ? "connection" : "connections"} at this level
				</> : emptyStatus}
			</p>
		</section>
	);
}
