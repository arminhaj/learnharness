import Link from "next/link";
import { ArrowLeftIcon, Code2Icon } from "lucide-react";
import { CodeWorkbench } from "@/components/code-workbench";

export default function CodeDemoPage() {
	return (
		<div className="h-full overflow-y-auto">
		<div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
			<Link href="/" className="mb-8 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-3.5" />Back to LearnHarness</Link>
			<div className="mb-6 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground"><Code2Icon className="size-4" />Code workspace · C++</div>
			<h1 className="font-title text-3xl tracking-tight sm:text-4xl">From snippet to working solution.</h1>
			<p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">The starter file includes the headers, entry point, and input handling. Work in the code box or open the same file in your editor, then check your saved solution.</p>
			<Link href="/code-demo/api" className="mt-3 inline-block text-xs underline underline-offset-4 hover:text-muted-foreground">Try the library API exercise →</Link>
			<div className="mt-8 grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
				<aside className="space-y-5 text-sm">
					<div>
						<h2 className="mb-2 font-medium">Your task</h2>
						<p className="leading-relaxed text-muted-foreground">Complete <code className="text-foreground">add(a, b)</code> to return the sum of two integers. Handle negative numbers, zero, and sums larger than a 32-bit integer.</p>
					</div>
					<div className="rounded-lg border border-border/70 p-3">
						<p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Example</p>
						<code className="text-sm">add(2, 3) → 5</code>
					</div>
					<p className="text-xs leading-relaxed text-muted-foreground">Try checking the starter first. It builds successfully, but fails several tests. Compiler success and solution correctness are shown separately.</p>
					<p className="text-xs leading-relaxed text-muted-foreground">In a practice session, Check &amp; submit sends the exact code and check results to your tutor for feedback. This demo works without starting a session.</p>
				</aside>
				<section aria-label="C++ exercise workspace" className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-5">
					<CodeWorkbench chatId="demo" problemCallId="cpp-sum" />
				</section>
			</div>
		</div>
		</div>
	);
}
