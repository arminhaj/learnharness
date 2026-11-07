"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { PanelRightIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import type { DemoResult, LhViewMessage, SubagentArtifactData } from "@/src/core";

type DemoEntry = { message: LhViewMessage; title: string };

export function completedDemos(transcript: readonly LhViewMessage[]): DemoEntry[] {
	return transcript.flatMap(message => {
		const artifact = message.parts.find(part => part.type === "data-subagent-artifact")?.data as SubagentArtifactData | undefined;
		if (artifact?.kind !== "demo") return [];
		const result = artifact.result as DemoResult | undefined;
		if (typeof result?.title !== "string" || typeof result.html !== "string" || !result.html.trim()) return [];
		return [{ message, title: result.title.trim() || "Interactive demo" }];
	});
}

export function DemoPicker({ demos, buttonRef, onSelect }: {
	demos: DemoEntry[];
	buttonRef: RefObject<HTMLButtonElement | null>;
	onSelect: (messageId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	usePopoverDismiss(rootRef, open, () => {
		if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
		setOpen(false);
	});
	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<button
				ref={buttonRef}
				type="button"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				onClick={() => setOpen(!open)}
			>
				<PanelRightIcon className="size-3.5" aria-hidden />
				Demos
			</button>
			{open && (
				<ul id={listId} aria-label="Completed demos" className="absolute right-0 top-full z-40 mt-2 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
					{demos.map(demo => (
						<li key={demo.message.id}>
							<button type="button" className="w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-sm wrap-break-word hover:bg-accent focus-visible:bg-accent" onClick={() => {
								onSelect(demo.message.id);
								setOpen(false);
								buttonRef.current?.focus();
							}}>
								{demo.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
