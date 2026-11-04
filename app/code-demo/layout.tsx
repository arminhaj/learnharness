import Link from "next/link";
import { Code2Icon } from "lucide-react";

export default function CodingLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-7 sm:py-8">
				<header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
					<h1 className="flex items-center gap-2 font-title text-3xl tracking-tight">
						<Code2Icon aria-hidden="true" className="size-5 text-muted-foreground" />
						Coding
					</h1>
					<nav aria-label="Coding workspace" className="flex gap-4 text-sm">
						<Link href="/code-demo" className="underline underline-offset-4">New workspace</Link>
						<Link href="/code-demo/examples" className="text-muted-foreground underline underline-offset-4">Examples</Link>
					</nav>
				</header>
				{children}
			</div>
		</div>
	);
}
