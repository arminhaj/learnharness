import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { ApiCodeDemo } from "@/components/api-code-demo";

export default function ApiCodeDemoPage() {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-7 sm:py-8">
				<Link href="/code-demo" className="mb-5 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-3.5" />Code exercises</Link>
				<header className="mb-6">
					<div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
						<span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-800 dark:text-amber-200">Simulated API</span>
						<span className="text-muted-foreground">C++20 · Library service</span>
					</div>
					<h1 className="font-title text-2xl tracking-tight sm:text-3xl">Borrow a book through an API.</h1>
					<p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Complete <code className="text-foreground">borrow_book</code>: look up a book, borrow an available copy, and return the right result for missing books, no stock, or an offline service.</p>
					<p className="mt-2 text-xs leading-relaxed text-muted-foreground">Your C++ is compiled and executed locally. The library is simulated: no real service is contacted and no real loans are created. Each run starts with fresh stock.</p>
				</header>
				<ApiCodeDemo />
			</div>
		</div>
	);
}
