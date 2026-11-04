import { CodingExerciseNav, type CodingLanguage } from "@/components/coding-exercise-nav";

import type { CodingLanguageId } from "@/src/core/coding-session";
import { codingLanguages } from "@/src/server/coding-sessions";

const examples: Record<CodingLanguageId, CodingLanguage> = {
	cpp: {
		label: "C++20",
		exercises: [
			{ href: "/code-demo/cpp", title: "Add two integers" },
			{ href: "/code-demo/api", title: "Borrow a book" },
		],
	},
	rust: {
		label: "Rust",
		exercises: [
			{ href: "/code-demo/rust", title: "Add two integers" },
			{ href: "/code-demo/api/rust", title: "Borrow a book" },
			{ href: "/code-demo/axum", title: "Build an HTTP handler" },
		],
	},
};

export default function CodingExamplesPage() {
	return (
		<section className="space-y-4">
			<h2 className="font-title text-2xl">Example workspaces</h2>
			<p className="text-sm text-muted-foreground">Try a prepared exercise with a hint, a reference, and local checks.</p>
			<CodingExerciseNav languages={codingLanguages().map(({ id }) => examples[id])} />
		</section>
	);
}
