import { CodingExerciseNav, type CodingLanguage } from "@/components/coding-exercise-nav";

import type { CodingLanguageId } from "@/src/core";
import { codingLanguages } from "@/src/server";

const examples: Record<CodingLanguageId, CodingLanguage> = {
	cpp: {
		label: "C++20",
		exercises: [
			{ href: "/code-demo/cpp", title: "Add two integers" },
			{ href: "/code-demo/api", title: "Borrow a book" },
		],
	},
	python: {
		label: "Python 3.11+",
		exercises: [
			{ href: "/code-demo/python", title: "Add two integers" },
		],
	},
	rust: {
		label: "Rust 2021",
		exercises: [
			{ href: "/code-demo/rust", title: "Add two integers" },
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
