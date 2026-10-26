/**
 * Rewrites the rows of a transcript component (assistant or user message) after it renders:
 * untagged fenced blocks get a tint and a left bar, existing file paths become terminal links.
 * The host exposes no hook for either, so the component prototype's row renderers are wrapped.
 */

export type RowTransform = (rows: readonly string[], width: number) => readonly string[];

type Rows = {
	render(width: number): readonly string[];
	renderTranscriptStableRows?(count: number, width: number): readonly string[];
};

const INSTALLED = Symbol.for("omp-collapsed.transcriptRows");

/** Restores the renderers `installTranscriptRows` wrapped. */
export function uninstallTranscriptRows(proto: object): void {
	(proto as Record<symbol, (() => void) | undefined>)[INSTALLED]?.();
}

/**
 * Wraps `proto`'s row renderers with `transform`. Reinstalling (extension reload in the same
 * process) restores the previous originals first, so wrappers never stack.
 */
export function installTranscriptRows(proto: Rows, transform: RowTransform): () => void {
	uninstallTranscriptRows(proto);
	const holder = proto as unknown as Record<symbol, (() => void) | undefined>;
	const originals = { render: proto.render, stable: proto.renderTranscriptStableRows };
	proto.render = function(this: Rows, width) {
		return transform(originals.render.call(this, width), width);
	};
	if (originals.stable) {
		proto.renderTranscriptStableRows = function(this: Rows, count, width) {
			return transform(originals.stable!.call(this, count, width), width);
		};
	}
	const uninstall = () => {
		proto.render = originals.render;
		if (originals.stable) proto.renderTranscriptStableRows = originals.stable;
		holder[INSTALLED] = undefined;
	};
	holder[INSTALLED] = uninstall;
	return uninstall;
}

/** Whether a `#rrggbb` theme background reads as a light theme. */
export function isLightHex(hex: string): boolean {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) return false;
	const luma = 0.299 * Number.parseInt(match[1], 16) + 0.587 * Number.parseInt(match[2], 16) + 0.114 * Number.parseInt(match[3], 16);
	return luma > 140;
}

export type ColorMode = "truecolor" | "256color";

/** ANSI background escape for `hex` in the terminal's color mode. */
export function backgroundAnsi(hex: string, mode: ColorMode): string {
	const ansi = Bun.color(hex, mode === "truecolor" ? "ansi-16m" : "ansi-256");
	if (ansi === null) throw new Error(`Invalid color value: ${hex}`);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}
