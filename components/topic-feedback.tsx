"use client";

import { TOPIC_CHALLENGE_LABELS, TOPIC_RELEVANCE_LABELS, type TopicFeedback } from "@/src/core";
import { cn } from "@/lib/utils";

export function TopicFeedbackControl({ value, onChange }: { value: TopicFeedback; onChange: (value: TopicFeedback) => void }) {
	const hasFeedback = value.relevance || value.challenge || value.madeMeThink;
	return (
		<details className="border-t border-border/60 px-4 py-2" data-question-control>
			<summary className="cursor-pointer text-xs font-medium text-muted-foreground focus-visible:outline-ring">
				Rate this topic{hasFeedback ? " · Added" : " (optional)"}
			</summary>
			<div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
				<fieldset>
					<legend className="mb-1 text-xs text-muted-foreground">Relevance</legend>
					<div className="flex flex-wrap gap-1">
						{(Object.keys(TOPIC_RELEVANCE_LABELS) as Array<keyof typeof TOPIC_RELEVANCE_LABELS>).map((key) => (
							<FeedbackChip key={key} selected={value.relevance === key} onClick={() => onChange({ ...value, relevance: value.relevance === key ? undefined : key })}>
								{TOPIC_RELEVANCE_LABELS[key]}
							</FeedbackChip>
						))}
					</div>
				</fieldset>
				<fieldset>
					<legend className="mb-1 text-xs text-muted-foreground">Stimulation</legend>
					<div className="flex flex-wrap gap-1">
						{(Object.keys(TOPIC_CHALLENGE_LABELS) as Array<keyof typeof TOPIC_CHALLENGE_LABELS>).map((key) => (
							<FeedbackChip key={key} selected={value.challenge === key} onClick={() => onChange({ ...value, challenge: value.challenge === key ? undefined : key })}>
								{TOPIC_CHALLENGE_LABELS[key]}
							</FeedbackChip>
						))}
						<FeedbackChip selected={value.madeMeThink === true} onClick={() => onChange({ ...value, madeMeThink: value.madeMeThink ? undefined : true })}>
							Made me think
						</FeedbackChip>
					</div>
				</fieldset>
			</div>
		</details>
	);
}

function FeedbackChip({ children, selected, onClick }: { children: string; selected: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onClick}
			className={cn("rounded-full border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring", selected && "border-primary bg-accent")}
		>
			{children}
		</button>
	);
}
