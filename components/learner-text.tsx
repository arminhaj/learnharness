"use client";

import { PathText } from "@/components/file-path-chip";
import { ToolContentResponse } from "@/components/ai-elements/message";

/** Highlight fenced source without interpreting ordinary learner prose as
 * Markdown (file chips and literal text retain their existing behavior). */
export function LearnerText({ text }: { text: string }) {
	const blocks = Array.from(text.matchAll(/^(`{3,})([a-zA-Z0-9_+-]*)\n[\s\S]*?\n\1(?=\n|$)/gm));
	if (!blocks.length) return <PathText text={text} />;
	let offset = 0;
	const parts = blocks.map((block) => {
		const before = text.slice(offset, block.index);
		offset = block.index! + block[0].length;
		return <div key={block.index}>
			{before && <span className="whitespace-pre-wrap"><PathText text={before} /></span>}
			<div className="not-italic text-foreground"><ToolContentResponse>{block[0]}</ToolContentResponse></div>
		</div>;
	});
	return <>{parts}{offset < text.length && <span className="whitespace-pre-wrap"><PathText text={text.slice(offset)} /></span>}</>;
}
