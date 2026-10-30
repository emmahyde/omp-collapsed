import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup, type Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { theme, ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import collapsed from "../index";

test("cards uses the native read renderer while ast shows an outline", async () => {
	const dir = mkdtempSync(join(tmpdir(), "collapsed-cards-"));
	const settings = await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
	ensureThemeSync();
	const original = toolRenderers.read;
	const originalContextNotes = toolRenderers.context_notes;
	const text = "# Main Doc\nIntroduction\n## Setup\nRun bun install\n### Advanced\nDetails\n";
	const result = {
		content: [{ type: "text" as const, text }],
		details: { resolvedPath: "/fake/README.md", displayTarget: "README.md", kind: "file", displayContent: { text, startLine: 1, lineNumbers: [1, 2, 3, 4, 5, 6] }, totalLines: 6 },
		isError: false,
	};
	const options = { expanded: false, isPartial: false };
	const args = { path: "README.md" };
	const native = original.renderResult(result, options, theme, args)?.render(100);
	const anything: any = new Proxy(() => anything, { get: () => anything, apply: () => anything });
	collapsed(anything);
	const mode = lookup("collapsed.toolRows") as Setting<string>;
	try {
		expect(native).toBeDefined();
		mode.set(settings, "ast");
		await Promise.resolve();
		const outline = toolRenderers.read.renderResult(result, options, theme, args)?.render(100).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
		expect(outline).toContain("README.md · markdown · 6 lines · 3 sections");
		mode.set(settings, "cards");
		await Promise.resolve();
		expect(toolRenderers.read.renderResult(result, options, theme, args)?.render(100)).toEqual(native);
		expect(toolRenderers.context_notes).toBe(originalContextNotes);
	} finally {
		resetSettingsForTest();
		rmSync(dir, { recursive: true, force: true });
	}
});
