"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface CodingLanguage {
	label: string;
	exercises: readonly { href: string; title: string }[];
}

export function CodingExerciseNav({ languages }: { languages: readonly CodingLanguage[] }) {
	const pathname = usePathname();

	return (
		<nav aria-label="Coding exercises" className="flex flex-wrap gap-x-7 gap-y-3">
			{languages.map(({ label, exercises }) => (
				<div key={label}>
					<p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
					<ul className="flex flex-wrap gap-1.5" aria-label={label}>
						{exercises.map(({ href, title }) => (
							<li key={href}>
								<Link
									href={href}
									aria-current={pathname === href ? "page" : undefined}
									className={cn(
										"inline-flex min-h-8 items-center rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-foreground",
										pathname === href ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground",
									)}
								>
									{title}
								</Link>
							</li>
						))}
					</ul>
				</div>
			))}
		</nav>
	);
}
