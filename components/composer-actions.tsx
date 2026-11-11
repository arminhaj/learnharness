"use client";

import type { ReactNode } from "react";
import { DumbbellIcon } from "lucide-react";
import type { LearningSubject } from "@/src/core";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, setup }: { picker?: ReactNode; setup?: ReactNode }) {
	if (!picker && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{setup}
		</div>
	);
}

export function TeachingSubjectPicker({ subjects, value, onChange, disabled }: {
	subjects: readonly Pick<LearningSubject, "id" | "name">[];
	value?: string;
	onChange: (id: string | undefined) => void;
	disabled?: boolean;
}) {
	return (
		<label className="flex max-w-full items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
			Subject
			<select
				aria-label="Teaching subject"
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value || undefined)}
				disabled={disabled}
				className="min-w-0 max-w-48 bg-card text-foreground"
			>
				<option value="">No subject</option>
				{subjects.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
			</select>
		</label>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
