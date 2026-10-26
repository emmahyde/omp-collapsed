import { describe, expect, test } from "bun:test";
import { parseSelector } from "../lib/model-tools";

describe("parseSelector", () => {
	test("splits only known effort suffixes", () => {
		expect(parseSelector("anthropic/claude-opus-5-5:high")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
		expect(parseSelector("@slow:XHigh")).toEqual({ model: "@slow", effort: "xhigh" });
	});
	test("leaves role aliases and plain ids alone", () => {
		expect(parseSelector("@slow")).toEqual({ model: "@slow" });
		expect(parseSelector("  gpt-5  ")).toEqual({ model: "gpt-5" });
	});
	test("keeps colons that belong to the model id", () => {
		expect(parseSelector("amazon-bedrock/us.amazon.nova-micro-v1:0")).toEqual({ model: "amazon-bedrock/us.amazon.nova-micro-v1:0" });
		expect(parseSelector("ollama/llama3:latest")).toEqual({ model: "ollama/llama3:latest" });
		expect(parseSelector("ollama/llama3:latest:low")).toEqual({ model: "ollama/llama3:latest", effort: "low" });
	});
	test("a bare effort word is not a selector suffix", () => {
		expect(parseSelector(":high")).toEqual({ model: ":high" });
	});
});
