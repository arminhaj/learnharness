import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

const TASK = "Explain the synthetic source finding for this lesson.";
const SOURCE = "https://example.test/primary-source";
const BRIEF = `## Summary\nThe synthetic source establishes the finding. [Primary source](${SOURCE})\n\n## Gaps\nNo further sources were available.`;

function searchFixture() {
	const queries: string[] = [];
	const provider: SearchProvider = { id: "brave", search: async (query) => {
		queries.push(query);
		return [{ title: "Synthetic primary source", url: SOURCE, snippet: `Evidence for ${query}` }];
	} };
	return { queries, search: () => provider };
}

function gatherResponses(incidentalText = false): AssistantMessage[] {
	return Array.from({ length: 11 }, (_, i) => fauxAssistantMessage([
		...(incidentalText ? [fauxText("I will check one more source.")] : []),
		fauxToolCall("web_search", { query: `facet-${i}` }, { id: `search-${i}` }),
	], { stopReason: "toolUse" }));
}

function scripted(responses: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	const requests: { tools: string[]; transcript: string; options: SimpleStreamOptions }[] = [];
	const engine: PiEngine = { model: faux.getModel(), streamFn: (model, context, options) => {
		const normalized = normalizeContext(context);
		requests.push({
			tools: getCurrentTools(normalized.messages).map((tool) => tool.name),
			transcript: JSON.stringify(normalized.messages),
			options: options ?? {},
		});
		return faux.streamSimple(model, context, options);
	} };
	return { engine, requests };
}

describe("researcher completion budget", () => {
	for (const incidentalText of [false, true]) {
		it(`reserves a tools-disabled brief after bounded collection${incidentalText ? " even with incidental text" : ""}`, async () => {
			const { engine, requests } = scripted([...gatherResponses(incidentalText), fauxAssistantMessage(BRIEF)]);
			const { queries, search } = searchFixture();
			let usageCalls = 0;
			const result = await runResearcherAgent(TASK, { engine, search, onUsage: () => usageCalls++ });
			assert.equal(result, BRIEF);
			assert.equal(requests.length, 12, "collection and synthesis share the existing total budget");
			assert.equal(queries.length, 11, "the final call cannot gather more sources");
			assert.equal(usageCalls, 12, "synthesis usage remains accounted for");
			const final = requests.at(-1)!;
			assert.deepEqual(final.tools, [], "synthesis must have no executable tools");
			assert.ok(final.transcript.includes(TASK), "original research task survives");
			assert.ok(final.transcript.includes(SOURCE), "source citations survive");
			for (let i = 0; i < 11; i++) assert.ok(final.transcript.includes(`Evidence for facet-${i}`), `source evidence ${i} survives`);
		});
	}

	it("returns a naturally completed brief without another model request", async () => {
		const { engine, requests } = scripted([gatherResponses()[0]!, fauxAssistantMessage(BRIEF)]);
		const { search } = searchFixture();
		assert.equal(await runResearcherAgent(TASK, { engine, search }), BRIEF);
		assert.equal(requests.length, 2);
	});

	for (const [label, final] of [
		["blank", fauxAssistantMessage(" \n ")],
		["truncated", fauxAssistantMessage("An unfinished finding", { stopReason: "length" })],
		["another tool call", fauxAssistantMessage([fauxText("More research needed"), fauxToolCall("web_search", { query: "forbidden-extra-search" })], { stopReason: "toolUse" })],
	] as const) {
		it(`fails boundedly when final synthesis returns ${label}`, async () => {
			const { engine, requests } = scripted([...gatherResponses(), final]);
			const { queries, search } = searchFixture();
			await assert.rejects(runResearcherAgent(TASK, { engine, search }));
			assert.equal(requests.length, 12, "invalid synthesis cannot restart the research loop");
			assert.equal(queries.length, 11, "no synthesis-stage tool is executed");
		});
	}

	it("propagates cancellation during synthesis without restarting research", { timeout: 2000 }, async () => {
		const controller = new AbortController();
		let synthesisStarted!: () => void;
		const started = new Promise<void>((resolve) => { synthesisStarted = resolve; });
		const { engine, requests } = scripted([...gatherResponses(), async (_context, options) => {
			synthesisStarted();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		}]);
		const { queries, search } = searchFixture();
		const running = runResearcherAgent(TASK, { engine, search, abortSignal: controller.signal });
		await started;
		controller.abort();
		await assert.rejects(running, { name: "AbortError" });
		assert.equal(requests.length, 12);
		assert.equal(queries.length, 11);
	});

	it("releases the invocation's provider signal after successful settlement", async () => {
		const { engine, requests } = scripted([fauxAssistantMessage(BRIEF)]);
		const result = await runSubagent([], { role: "researcher", engine, systemPrompt: "Offline test", prompt: TASK, maxTurns: 1 });
		assert.equal(result.text, BRIEF, "cleanup must preserve a successful result");
		assert.equal(requests[0]!.options.signal?.aborted, true, "retained provider processes receive cleanup after settlement");
	});
});
