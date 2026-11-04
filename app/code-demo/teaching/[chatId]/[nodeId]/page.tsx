import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NewCodingWorkspace } from "@/components/new-coding-workspace";
import type { TeachingCodingStep } from "@/src/core/coding-session";
import { codingLanguages, getCodingSession, getTeachingCodingStep, teachingCodingSessionId } from "@/src/server/coding-sessions";

export const dynamic = "force-dynamic";

export default async function TeachingCodingPage({ params }: { params: Promise<TeachingCodingStep> }) {
	const link = await params;
	const step = getTeachingCodingStep(link);
	if (!step) notFound();
	const existing = getCodingSession(teachingCodingSessionId(link));
	if (existing) redirect(`/code-demo/session/${existing.id}`);
	const requested = step.node.coding?.language;
	const languages = codingLanguages().filter(language => !requested || language.id === requested);
	return (
		<div className="space-y-4">
			<Link href={`/chat/${link.chatId}`} className="text-sm underline underline-offset-4">Back to Teaching</Link>
			<p className="text-sm text-muted-foreground">{step.lesson}</p>
			{languages.length ? (
				<NewCodingWorkspace
					languages={languages}
					step={{ ...link, title: step.node.title, goal: step.node.coding?.goal ?? step.node.title, mode: step.node.coding?.mode ?? "problem" }}
				/>
			) : (
				<>
					<h2 className="font-title text-2xl">{step.node.title}</h2>
					<p className="text-sm text-muted-foreground">This step needs a {requested} runner. This build supports {codingLanguages().map(language => language.label).join(" and ")}.</p>
				</>
			)}
		</div>
	);
}
