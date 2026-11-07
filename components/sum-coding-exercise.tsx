import { CodeWorkbench } from "@/components/code-workbench";
import { CodingHint } from "@/components/coding-hint";

export function SumCodingExercise({ language, problemCallId, integerType, referenceNote, returnNote }: {
	language: string;
	problemCallId: string;
	/** Fixed-width languages name their integer type; others supply a reference note instead. */
	integerType?: string;
	referenceNote?: string;
	/** Replaces the generic sentence about returning a value, for languages that return an expression. */
	returnNote?: string;
}) {
	return (
		<>
			<header className="mb-5">
				<p className="mb-1 text-xs text-muted-foreground">{language}</p>
				<h2 className="font-title text-2xl tracking-tight sm:text-3xl">Add two integers</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Complete <code className="text-foreground">add(a, b)</code> so it returns their sum. Try negative numbers, zero, and a sum beyond the 32-bit range.
				</p>
			</header>
			<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
				<section aria-label={`${language} exercise workspace`} className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
					<CodeWorkbench chatId="demo" problemCallId={problemCallId} />
				</section>
				<aside className="space-y-3" aria-label="Exercise guidance">
					<CodingHint>
						<p>Change the body of <code>add</code>. The starter already reads the two inputs, passes them to your function, and prints the value it returns.</p>
					</CodingHint>
					<section className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm" aria-label={`${language} reference`}>
						<h3 className="font-medium">Reference</h3>
						<p className="leading-relaxed text-muted-foreground">{referenceNote ?? <><code>{integerType}</code> can hold signed 64-bit values. Keep the parameters and result in that type so sums beyond the signed 32-bit range still fit.</>}</p>
						<p className="leading-relaxed text-muted-foreground">Use <code>+</code> to add two numbers. {returnNote ?? <><code>return</code> sends the resulting value back to the code that called your function.</>}</p>
						<p className="rounded-md bg-background/60 p-2"><code>add(2, 3) → 5</code></p>
					</section>
					<p className="text-xs leading-relaxed text-muted-foreground">Run <strong>Check</strong> on the starter to see the tests before you edit. A clean build or syntax check tells you the program was accepted. The tests tell you whether it produces the expected answers.</p>
				</aside>
			</div>
		</>
	);
}
