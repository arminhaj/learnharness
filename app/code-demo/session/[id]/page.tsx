import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeWorkbench } from "@/components/code-workbench";
import { CodingHint } from "@/components/coding-hint";
import { executableProfileFor } from "@/src/core";
import { codeProfileReadiness, codingLanguages, getCodingSession } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function CodingSessionPage({ params }: { params: Promise<{ id: string }> }) {
	const session = getCodingSession((await params).id);
	if (!session) notFound();
	const readiness = (await codeProfileReadiness()).find(item => item.profileId === executableProfileFor(session.exercise.language)?.id);
	const language = codingLanguages().find(item => item.id === session.exercise.language);
	return (
		<>
			<header className="mb-5 max-w-3xl space-y-2">
				{session.teachingStep && (
					<Link href={`/chat/${session.teachingStep.chatId}`} className="text-sm underline underline-offset-4">Back to Teaching</Link>
				)}
				<p className="capitalize text-xs text-muted-foreground">{session.mode} · {language?.label}{session.simulation ? " · Simulated API or service" : ""}</p>
				<h2 className="font-title text-2xl tracking-tight sm:text-3xl">{session.title}</h2>
				<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{session.brief}</p>
			</header>
			<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
				<section aria-label="Generated coding workspace" className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4">
					<p className="text-xs text-muted-foreground">Review the generated source before running checks on your computer.</p>
					{readiness?.state === "unavailable" && <p role="status" className="text-xs text-muted-foreground">{readiness.message} You can still edit and save; checks need it.</p>}
					<CodeWorkbench chatId="coding" problemCallId={session.id} />
				</section>
				<aside className="min-w-0 space-y-3" aria-label="Exercise guidance">
					<CodingHint><p className="whitespace-pre-wrap break-words">{session.hint}</p></CodingHint>
					<section className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
						<h3 className="font-medium">Exercise reference</h3>
						<p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{session.reference}</p>
					</section>
					{session.supportFiles.length > 0 && (
						<section className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
							<h3 className="font-medium">Supporting files</h3>
							{session.supportFiles.map(file => (
								<details key={file.path}>
									<summary className="cursor-pointer font-mono text-xs">{file.path}</summary>
									<pre className="mt-2 max-h-64 overflow-auto rounded bg-background/60 p-2 text-xs" tabIndex={0}>{file.source}</pre>
								</details>
							))}
						</section>
					)}
				</aside>
			</div>
		</>
	);
}
