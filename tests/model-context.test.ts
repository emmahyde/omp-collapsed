import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { lookup, type Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import collapsed from "../index";
import { toonForModel } from "../lib/model-context";

test("converts structured bash, MCP, and eval output without losing surrounding text", () => {
	const bash = toonForModel('{"items":[{"id":"9007199254740993","name":"one"}]}\nCommand exited with code 0', "bash")!;
	const [body, footer] = bash.split("\nCommand exited");
	expect(decode(body)).toEqual({ items: [{ id: "9007199254740993", name: "one" }] });
	expect(footer).toBe(" with code 0");
	const mcp = toonForModel('Result:\n```json\n{"ok":true,"count":2}\n```\nNext step', "mcp__example")!;
	expect(mcp).toContain("Result:\n```toon\n");
	expect(mcp).toContain("\n```\nNext step");
	expect(decode(mcp.split("```toon\n")[1].split("\n```")[0])).toEqual({ ok: true, count: 2 });
	const output = toonForModel("display[1]:\n{ name: 'first', count: 2 }\ndisplay[2]:\n{'name': 'second', 'valid': True}", "eval")!;
	expect(output).toContain("display[1]:\nname: first\ncount: 2");
	expect(output).toContain("display[2]:\nname: second\nvalid: true");
});

test("leaves unsafe numbers, prose, and non-JSON code fences intact", () => {
	expect(toonForModel('{"id":9007199254740993}', "bash")).toBeUndefined();
	expect(toonForModel("No matching records found.", "bash")).toBeUndefined();
	expect(toonForModel("```js\n{ id: 1 }\n```", "eval")).toBeUndefined();
});

test("model context conversion is independent of view mode and preserves image order and errors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "collapsed-context-"));
	const settings = await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
	const handlers: Record<string, (event: any) => any> = {};
	const api = { on: (name: string, handler: (event: any) => any) => { handlers[name] = handler; }, registerShortcut() {}, registerMessageRenderer() {}, registerCommand() {} };
	collapsed(api as any);
	const mode = lookup("collapsed.toolRows") as Setting<string>;
	const toon = lookup("collapsed.toolResultsToon") as Setting<boolean>;
	const image = { type: "image", data: "AAAA", mimeType: "image/png" };
	const messages = ["bash", "mcp__example", "eval"].map((toolName, index) => ({
		role: "toolResult", toolCallId: String(index), toolName, isError: false,
		content: [{ type: "text", text: '{"value":1}' }, image, { type: "text", text: '{"value":2}' }],
	}));
	const error = { role: "toolResult", toolCallId: "error", toolName: "bash", isError: true, content: [{ type: "text", text: '{"failure":true}' }] };
	try {
		for (const value of ["cards", "ast", "lines", "group"]) {
			mode.set(settings, value);
			await Promise.resolve();
			const result = handlers.context({ messages: [...messages, error] });
			for (const message of result.messages.slice(0, 3)) {
				expect(decode(message.content[0].text)).toEqual({ value: 1 });
				expect(message.content[1]).toBe(image);
				expect(decode(message.content[2].text)).toEqual({ value: 2 });
			}
			expect(result.messages[3]).toBe(error);
		}
		toon.set(settings, false);
		await Promise.resolve();
		expect(handlers.context({ messages })).toBeUndefined();
	} finally {
		await Promise.resolve();
		resetSettingsForTest();
		rmSync(dir, { recursive: true, force: true });
	}
});
