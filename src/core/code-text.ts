/** Store code answers as portable Markdown while keeping source bytes intact. */
export function fenceCode(source: string, language = "cpp"): string {
	if (!source.trim()) return source;
	const runs = source.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
	const safeLanguage = /^[a-zA-Z0-9_+-]+$/.test(language) ? language : "text";
	return `${fence}${safeLanguage}\n${source}\n${fence}`;
}

export function readCodeFence(text: string): { language: string; source: string } | null {
	const match = /^(`{3,})([a-zA-Z0-9_+-]*)\n([\s\S]*)\n\1$/.exec(text);
	return match ? { language: match[2] || "text", source: match[3]! } : null;
}
