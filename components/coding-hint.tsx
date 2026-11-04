import type { ReactNode } from "react";

export function CodingHint({ children }: { children: ReactNode }) {
	return (
		<details className="rounded-lg border border-border bg-card p-3 text-sm">
			<summary className="cursor-pointer font-medium">Hint</summary>
			<div className="mt-2 leading-relaxed text-muted-foreground">{children}</div>
		</details>
	);
}
