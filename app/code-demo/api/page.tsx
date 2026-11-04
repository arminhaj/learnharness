import { ApiCodeDemo } from "@/components/api-code-demo";
import { CodingHint } from "@/components/coding-hint";

export default function ApiCodeDemoPage() {
	return (
		<>
			<header className="mb-5">
				<p className="mb-1 text-xs text-muted-foreground">C++20 · Simulated API</p>
				<h2 className="font-title text-2xl tracking-tight sm:text-3xl">Borrow a book through an API</h2>
				<p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Complete <code className="text-foreground">borrow_book</code> so it looks up a book, borrows an available copy, and reports missing books, no stock, or an offline service.</p>
				<p className="mt-1 text-xs leading-relaxed text-muted-foreground">Your code runs locally against a simulated library. Each run starts with fresh stock.</p>
			</header>
			<div className="mb-4">
				<CodingHint>
					<p>Read the API reference before calling <code>borrow</code>. A failed borrow can mean a missing book or an empty shelf. Which API call tells you which happened?</p>
				</CodingHint>
			</div>
			<ApiCodeDemo />
		</>
	);
}
