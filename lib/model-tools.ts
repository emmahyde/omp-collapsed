import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortName = (typeof EFFORTS)[number];

const isEffort = (value: string): value is EffortName => (EFFORTS as readonly string[]).includes(value);

/**
 * Split a trailing `:effort` off a model selector. Only a known effort name counts, so ids that
 * merely contain a colon (`amazon-bedrock/us.amazon.nova-micro-v1:0`) stay intact.
 */
export function parseSelector(selector: string): { model: string; effort?: EffortName } {
	const trimmed = selector.trim();
	const cut = trimmed.lastIndexOf(":");
	if (cut > 0) {
		const suffix = trimmed.slice(cut + 1).toLowerCase();
		if (isEffort(suffix)) return { model: trimmed.slice(0, cut), effort: suffix };
	}
	return { model: trimmed };
}

export interface CallModelParams {
	model: string;
	prompt: string;
	system?: string;
	thinking?: EffortName;
	maxTokens?: number;
}

type Reasoning = NonNullable<Parameters<typeof completeSimple>[2]>["reasoning"];

export async function callModel(ctx: ExtensionContext, params: CallModelParams, signal?: AbortSignal) {
	const { model: selector, effort } = parseSelector(params.model);
	const model = ctx.models.resolve(selector);
	if (!model) {
		const known = ctx.models
			.list()
			.slice(0, 8)
			.map(m => `${m.provider}/${m.id}`)
			.join(", ");
		throw new Error(`Unknown model "${selector}". Try a provider/id, bare id, or @role. Available (first 8): ${known || "none"}. Run /model to see the full list.`);
	}
	const apiKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId(), { signal });
	if (!apiKey) throw new Error(`No API key available for provider "${model.provider}".`);
	signal?.throwIfAborted();
	const reasoning = (params.thinking ?? effort) as Reasoning;
	const response = await completeSimple(
		model,
		{
			...(params.system ? { systemPrompt: [params.system] } : {}),
			messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
		},
		{ apiKey, signal, ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}), ...(reasoning ? { reasoning } : {}) },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `Model call ${response.stopReason}.`);
	}
	const text = response.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	return { text, details: { model: `${model.provider}/${model.id}`, usage: response.usage, stopReason: response.stopReason } };
}

