import Link from "next/link";
import { NewCodingWorkspace } from "@/components/new-coding-workspace";
import { codingLanguages, recentCodingSessions } from "@/src/server/coding-sessions";

export const dynamic = "force-dynamic";

export default function CodingPage() {
	const languages = codingLanguages();
	const sessions = recentCodingSessions();
	return (
		<div className="space-y-8">
			<NewCodingWorkspace languages={languages} />
			{sessions.length > 0 && (
				<section className="max-w-2xl space-y-3">
					<h2 className="font-title text-2xl">Recent workspaces</h2>
					<ul className="divide-y divide-border rounded-lg border border-border">
						{sessions.map(session => (
							<li key={session.id}>
								<Link href={`/code-demo/session/${session.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-3 text-sm hover:bg-accent">
									<span>{session.title}</span>
									<span className="capitalize text-xs text-muted-foreground">{session.mode} · {languages.find(language => language.id === session.language)?.label}</span>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
