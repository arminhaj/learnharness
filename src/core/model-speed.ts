/** Fast is a processing tier, independent of the model's thinking budget.
 * Keep the documented model families explicit: accepting a service_tier
 * field does not mean every OpenAI model offers Fast processing.
 * https://learn.chatgpt.com/docs/agent-configuration/speed
 * https://developers.openai.com/api/docs/guides/fast-mode
 */
const FAST_MODE_MODELS = new Set([
	"gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
	"gpt-5.6", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex",
]);

/** Final provider-reported processing for one successful response. App-only
 * metadata: the requested preference never proves which tier was served. */
export interface ProcessingTier {
	requested: "priority" | "fast";
	served: "default" | "priority" | "fast";
}

export function supportsFastMode(provider: string | undefined, id: string | undefined): boolean {
	if ((provider !== "chatgpt" && provider !== "openai") || !id) return false;
	return FAST_MODE_MODELS.has(id.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
}
