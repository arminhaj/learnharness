import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { toolNameToMcp } from "./tool-bridge.ts";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

type ReplayPart = string | ImageContent;

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${toolNameToMcp(block.name)}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const name = toolNameToMcp(message.toolName);
			const label = message.isError ? `[tool result ${name} error]` : `[tool result ${name}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toContentBlocks(parts: ReplayPart[]): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toUserContent(conversation: Message[]): ClaudeContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);

	return toContentBlocks(conversation.flatMap(getReplayParts));
}

export function toClaudeInput(messages: Message[]): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const tools = getCurrentTools(messages);
	const systemPrompt = getCurrentSystemPrompt(messages);
	// The app stores short tool names; the CLI registers their MCP names.
	// Fresh replay (including a figure's render image) must teach the same
	// names as the actual registry, or Claude may call a nonexistent bare tool.
	const toolNames = tools.length === 0 ? "" : [
		"Tool names in the instructions and tool results are shorthand. When calling a tool, use its exact registered MCP name below:",
		...tools.map((tool) => `- ${tool.name} → ${toolNameToMcp(tool.name)}`),
	].join("\n");

	return {
		systemPrompt: [systemPrompt, toolNames].filter(Boolean).join("\n\n"),
		tools,
		userContent: toUserContent(conversation),
	};
}

export function toStreamJsonLine(content: ClaudeContentBlock[]): string {
	return JSON.stringify({ type: "user", message: { role: "user", content } });
}
