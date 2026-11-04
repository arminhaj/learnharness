import { Code2Icon } from "lucide-react";
import { CodingExerciseNav, type CodingLanguage } from "@/components/coding-exercise-nav";

const languages: readonly CodingLanguage[] = [
	{
		label: "C++20",
		exercises: [
			{ href: "/code-demo", title: "Add two integers" },
			{ href: "/code-demo/api", title: "Borrow a book" },
		],
	},
];

export default function CodingLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-7 sm:py-8">
				<header className="mb-6 space-y-4 border-b border-border pb-5">
					<div>
						<h1 className="flex items-center gap-2 font-title text-3xl tracking-tight">
							<Code2Icon aria-hidden="true" className="size-5 text-muted-foreground" />
							Coding
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">Work through guided exercises and run tests on your code.</p>
					</div>
					<CodingExerciseNav languages={languages} />
					<p className="text-xs text-muted-foreground">Save your edits before switching exercises.</p>
				</header>
				{children}
			</div>
		</div>
	);
}
