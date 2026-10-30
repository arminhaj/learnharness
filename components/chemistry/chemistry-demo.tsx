"use client";

import { useState } from "react";
import { QuestionDock } from "@/components/question-dock";
import { AnsweredCard } from "@/components/answered-card";
import { PracticeDock } from "@/components/practice-dock";
import { MoleculeFigure } from "./molecule-figure";
import { moleculeMarkdown, type MoleculeDocument, type QuestionAnswerData } from "@/src/core";

const quiz = {
	question: "Which structure contains an ester group?",
	options: [
		{ value: "ester", label: moleculeMarkdown({ smiles: "CC(=O)OCC", label: "Structure A" }) },
		{ value: "alcohol", label: moleculeMarkdown({ smiles: "CCC(O)C", label: "Structure B" }) },
		{ value: "ketone", label: moleculeMarkdown({ smiles: "CC(=O)CC", label: "Structure C" }) },
	],
	explanation: "Structure A contains a carbonyl carbon bonded to an oxygen that is bonded to another carbon: an ester group.",
	correctAnswer: "ester",
};
const practice = {
	statement: "Draw the ketone produced by oxidizing this secondary alcohol. You can use a copy of the starting structure.\n\n" + moleculeMarkdown({ smiles: "CC[C@H](O)C", label: "Starting structure" }),
	chemistry: { instructions: "Change the alcohol group to a carbonyl group." },
};

export function ChemistryDemo() {
	const [tab, setTab] = useState<"question" | "drawing" | "stereo">("question");
	const [answer, setAnswer] = useState<QuestionAnswerData>();
	const [submitted, setSubmitted] = useState<{ text: string; molecule?: MoleculeDocument }>();
	return <main className="mx-auto w-full max-w-3xl px-5 py-8">
		<h1 className="font-title text-2xl">Chemistry workspace</h1>
		<p className="mt-2 text-sm text-muted-foreground">Explore molecular questions, draw an answer, and inspect structures in 3D.</p>
		<nav className="my-5 flex flex-wrap gap-2" aria-label="Chemistry examples">
			{([['question', 'Molecular question'], ['drawing', 'Draw an answer'], ['stereo', 'Stereochemistry and 3D']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`rounded-md px-3 py-2 text-sm ${tab === key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{label}</button>)}
		</nav>
		{tab === "question" && <>{answer ? <><AnsweredCard answer={answer} input={quiz} /><button type="button" className="mt-3 rounded-md border px-3 py-2 text-sm" onClick={() => setAnswer(undefined)}>Try again</button></> : <div className="rounded-xl border bg-card"><QuestionDock toolName="quiz" toolCallId="chemistry-example-ester" input={quiz} expanded onExpand={() => {}} onSubmit={setAnswer} dictationClaim={false} /></div>}</>}
		{tab === "drawing" && <><div className="rounded-xl border bg-card"><PracticeDock chatId="chemistry-demo" problemCallId="chemistry-example-oxidation" input={practice} expanded onExpand={() => {}} onSubmit={(text, _codeRunId, molecule) => setSubmitted({ text, molecule })} /></div>{submitted && <section className="mt-5 border-t pt-4"><h2 className="font-medium">Submitted answer</h2>{submitted.molecule && <MoleculeFigure source={submitted.molecule} />}<p>{submitted.text}</p></section>}</>}
		{tab === "stereo" && <div className="grid gap-5 sm:grid-cols-2"><MoleculeFigure source={{ smiles: "CC[C@H](O)C", label: "2-butanol · one enantiomer" }} /><MoleculeFigure source={{ smiles: "CC[C@@H](O)C", label: "2-butanol · opposite enantiomer" }} /></div>}
	</main>;
}
