import { describe, expect, test } from "bun:test";
import { backgroundAnsi, installTranscriptRows, isLightHex } from "../lib/transcript-rows";

function component() {
	return { render: (_width: number) => ["hi"] as readonly string[], renderTranscriptStableRows: (_count: number, _width: number) => ["stable"] as readonly string[] };
}

describe("installTranscriptRows", () => {
	test("transforms render and stable rows and passes the width", () => {
		const proto = component();
		installTranscriptRows(proto, (rows, width) => rows.map(row => `${row}:${width}`));
		expect(proto.render(7)).toEqual(["hi:7"]);
		expect(proto.renderTranscriptStableRows(1, 9)).toEqual(["stable:9"]);
	});

	test("reinstall does not stack wrappers and uninstall restores the originals", () => {
		const proto = component();
		const original = proto.render;
		installTranscriptRows(proto, rows => rows.map(row => `a${row}`));
		const uninstall = installTranscriptRows(proto, rows => rows.map(row => `b${row}`));
		expect(proto.render(1)).toEqual(["bhi"]);
		uninstall();
		expect(proto.render).toBe(original);
	});

	test("a prototype without stable rows stays without them", () => {
		const proto: { render(width: number): readonly string[]; renderTranscriptStableRows?: unknown } = { render: () => ["x"] };
		installTranscriptRows(proto as Parameters<typeof installTranscriptRows>[0], rows => rows);
		expect(proto.renderTranscriptStableRows).toBeUndefined();
	});
});

describe("colors", () => {
	test("isLightHex tells light from dark", () => {
		expect(isLightHex("#ffffff")).toBe(true);
		expect(isLightHex("#101010")).toBe(false);
		expect(isLightHex("nope")).toBe(false);
	});
	test("backgroundAnsi emits a background escape", () => {
		expect(backgroundAnsi("#010203", "truecolor")).toBe("\x1b[48;2;1;2;3m");
		expect(() => backgroundAnsi("not a color", "truecolor")).toThrow();
	});
});
