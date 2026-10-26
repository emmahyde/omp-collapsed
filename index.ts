import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Box, formatMetricRow, Markdown, type MetricSpec, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { code as codeNode } from "@oh-my-pi/pi-tui/native/describe";
// Only host-mapped specifiers share the running instance; a deeper pi-tui path would patch a private copy.
import { AssistantMessageComponent, ReadToolGroupComponent, ToolExecutionComponent, UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { installToolRuns, type RunCard } from "./lib/tool-runs";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import { completeSimple, type Judge, type Usage } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme as uiTheme } from "@oh-my-pi/pi-tui/theme";
import { fileHyperlink, previewWindowRows } from "@oh-my-pi/pi-tui/render";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { readSourceFsPath, renderFallbackToolCard, renderTaskToolCard, splitPathAndSel } from "./lib/host-copies";
import { green } from "./lib/colors";
import { cardGutter, hiddenSize, rowSuffix } from "./lib/card-gutter";
import { testSummaryLine } from "./lib/test-summary";
import { commandSourcePath, compactBlocks, groupGrepPrefixes, isBraceLanguage, joinLoneClosers, printsLineNumbers, extensionOf, scanComments, stripComments, stripLineNumbers } from "./lib/source-text";
import { presentReadExcerpt } from "./lib/read-display";
import { outlineMarkdown, outlineSource, recoverOldText, renderEditOutline, renderGrepOutline, renderMarkdownOutline, renderOutline, renderRange, type GrepFileMatches, type Outline } from "./lib/code-outline";
import { referenceLocations } from "./lib/reference-output";
// Keep helper modules below lib/: configured extension roots scan direct .ts files.
import { isSettingsInitialized, settings as hostSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgReadToolResultPreview } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cappedRenderPayload, collapseTextLines, decodeNestedJson, formatJsonOutput, formatFileExcerpt, isFileExcerpt, formatSearchOutput, formatCommandText, formatJsonWithFooter, markdownOutput, parseGrepOutput, parseTabularData, parseYamlDocument, sanitizeTerminalText, separateGeneratedNoticeFooter, stripGeneratedNoticeFooter } from "./lib/tool-output";
import { splitArchiveOutput } from "./lib/archive-output";
import { decodeEvalOutput } from "./lib/eval-output";
import { EvalSummaryCache } from "./lib/eval-summary";
import { RunSystemPrompt, setSkillNames, TOOL_ROWS_MODES, type Complete } from "./lib/tool-rows";
import { ToolRows } from "./lib/tool-rows-host";
import { WikiIndex } from "./lib/wiki-index";
import { compactEvalResult, fitCollapseLine } from "./lib/eval-collapse";
import { underlineLabel, underlinePathTokens } from "./lib/path-styling";
import { booleanSetting, enumSetting, integerSetting, readSetting, settings, stringSetting, watchSetting } from "./lib/settings";
import { stylePlainBlocks } from "./lib/plain-blocks";
import { backgroundAnsi, installTranscriptRows, isLightHex, type ColorMode } from "./lib/transcript-rows";
import { createPathResolver, linkComponentRows, linkPathRows } from "./lib/path-links";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { waitStatusLine } from "./lib/wait-status";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";


type TweakDef = {
	name: string;
	title: string;
	description: string;
	render: () => string;
};

type Tweak = TweakDef & { setting: Setting<boolean> };

/**
 * Each entry owns its label and display copy; its on/off state is a persisted OMP setting,
 * `hydemods.<camelName>` (the names hydemods used, so existing settings carry over).
 */
const TWEAK_DEFS: TweakDef[] = [
	{
		name: "integrated-tool-expansion",
		title: "Integrated tool cards",
		description: "Draws structured tool results inside OMP's own tool card.",
		render: () => "Ctrl+O expands, Ctrl+Shift+T toggles omp-collapsed rendering for the session. Collapsed height: /collapsed collapsed-lines N or +/- here.",
	},
	{
		name: "tool-results-toon",
		title: "TOON tool results",
		description: "Formats structured tool results as TOON in cards and model context.",
		render: () => "Unpacks JSON, printed Eval tool envelopes, and MCP JSON blocks. Uniform arrays share one header. Read and grep results retain AST context.",
	},
	{
		name: "eval-command-summaries",
		title: "Eval command summaries",
		description: "Uses the tiny model to describe each Eval command without delaying execution.",
		render: () => "Shows a short intent summary when ready. Uses @tiny or @smol, never the primary model; falls back to the original title on failure.",
	},
	{
		name: "ast-structuring",
		title: "AST structuring",
		description: "Shows file reads, writes, edits and source printed by bash as declaration outlines instead of raw text.",
		render: () => "Declarations are parsed with tree-sitter; bodies fold to a line count. Comments and line-number gutters are always stripped from displayed source. Off shows the plain excerpt; the model sees the same output either way.",
	},
	{
		name: "plain-code-blocks",
		title: "Plain code blocks stand out",
		description: "Tints fenced blocks that have no language tag and hangs a green bar on their left.",
		render: () => "The host leaves untagged fences unhighlighted, so mockups, logs and diagrams blend into prose. Tagged blocks (```ts) keep their syntax colors.",
	},
	{
		name: "tool-runs",
		title: "Collapse earlier tool calls",
		description: "Folds every card in an unbroken run of tool calls to its header row, keeping the newest full.",
		render: () => "A run is tool calls with no user message and no assistant text between them. Failed and still-running cards stay full; Ctrl+O expands everything.",
	},
	{
		name: "path-links",
		title: "Clickable paths",
		description: "Turns every existing file path in the transcript into a terminal link, including paths in code spans, bare filenames, and paths wrapped across two rows.",
		render: () => "Paths resolve against the working directory and ~. Only paths that exist are linked; a :line or #L12 suffix opens at that line.",
	},
];

const TWEAKS: Tweak[] = TWEAK_DEFS.map(def => ({ ...def, setting: booleanSetting(def.name, def.title, def.description) }));

const isTweakEnabled = (name: string): boolean => {
	const tweak = TWEAKS.find(t => t.name === name);
	return tweak ? readSetting(tweak.setting) : false;
};

const pathResolver = createPathResolver(() => process.cwd());
/** Path linker for transcript rows, or undefined while the tweak is off. */
const pathLinksFor = () => (isTweakEnabled("path-links") ? pathResolver : undefined);

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolMessage = {
	customType: string;
	content: string | unknown[];
	details?: {
		toolName: string;
		result: unknown;
		isError?: boolean;
		cwd?: string;
	};
};

type RendererOptions = {
	expanded?: boolean;
};

const DEFAULT_COLLAPSED_LINES = 5;
const collapsedLinesSetting = integerSetting(
	"collapsed-lines",
	"Collapsed tool card lines",
	"Content rows shown in a collapsed tool card; an inline glyph marks the hidden rows.",
	DEFAULT_COLLAPSED_LINES,
);

const toolRowsSetting = enumSetting(
	"tool-rows",
	"Tool rows",
	"How tool calls draw. cards: tool cards with plain output. ast: tool cards with reads, writes, edits, grep hits and printed source as declaration outlines. lines: one row per call, described by a local model, with no gaps. group: one row per burst of calls, summarized by a local model once the agent replies. Ctrl+O shows the cards.",
	TOOL_ROWS_MODES,
	"group",
);
/** Declaration outlines: always in `ast` mode, never in plain `cards`; in lines/group (Ctrl+O cards) the AST structuring tweak decides. */
const astOutlines = (): boolean => {
	const mode = readSetting(toolRowsSetting);
	return mode === "ast" || (mode !== "cards" && isTweakEnabled("ast-structuring"));
};
const toolRowsModelSetting = stringSetting(
	"tool-rows-model",
	"Tool rows model",
	"Local model (see `omp tiny-models`) that writes tool row lines. It runs on the Apple GPU when providers.tinyModelDevice is mlx.",
	"llama3.2:3b",
	value => {
		if (!value.trim()) throw new Error("hydemods.toolRowsModel must name a local model");
	},
);
const toolPillsSetting = booleanSetting(
	"tool-pills",
	"Tool label pills",
	"Draw each tool row's label as a pill: upper case, bold, the tool's colour as the fill, and black or white text by brightness.",
	false,
);
const wikiBadgesSetting = booleanSetting(
	"wiki-badges",
	"Wiki badges on tool rows",
	"Mark a tool row with ◆ when the knowledge wiki (~/.llm-wiki, or .llm-wiki in the working folder) has a page whose title, slug or tags name the row's file or skill.",
	true,
);

type ToolDisplayState = { collapsedLines: number; cardsOn: boolean };

type StructuredFormat = "json" | "yaml" | "toon" | "code" | "file" | "links" | "markdown" | "text" | "command" | "outline" | "edit-outline";

type StructuredText = {
	text: string;
	format: StructuredFormat;
	lang?: string;
	/** Filesystem path the first row names, for hyperlinking in tree layouts. */
	path?: string;
};

const CODE_KEYWORDS: Record<string, true> = {
	using: true, namespace: true, public: true, private: true, protected: true, internal: true,
	static: true, readonly: true, class: true, struct: true, interface: true, enum: true,
	void: true, return: true, new: true, if: true, else: true, switch: true, case: true,
	break: true, for: true, foreach: true, in: true, while: true, do: true, async: true,
	await: true, try: true, catch: true, finally: true, throw: true, typeof: true,
	override: true, virtual: true, abstract: true, sealed: true, get: true, set: true,
	var: true, is: true, as: true, null: true, true: true, false: true, this: true,
	base: true, import: true, export: true, from: true, const: true, let: true,
	function: true, def: true, elif: true, not: true, and: true, or: true, pass: true,
	yield: true, lambda: true,
};

// C#-style primitive aliases, the only lowercase types the highlighter must know: every
// capitalised type name (Unity's Vector3, .NET's List, TypeScript's Promise) already hits the
// generic capitalised-identifier rule in colorizeCodeLine.
const CODE_TYPES: Record<string, true> = {
	int: true, float: true, double: true, bool: true, string: true, char: true, byte: true,
	sbyte: true, short: true, ushort: true, uint: true, ulong: true, long: true, decimal: true,
	object: true,
};

function colorizeCodeLine(line: string, theme: ThemeLike): string {
	if (/^\s*(?:\/\/|#|--)/.test(line)) {
		return theme.fg("syntaxComment", line);
	}

	const tokenRegex = /("(?:\\.|[^"\\])*"|'[^'\\]*(?:\\.[^'\\]*)*'|\x60[^\x60\\]*(?:\\.[^\x60\\]*)*\x60|(?:\/\/|#|--).*$|\b\d+(?:\.\d+)?[fFmMdD]?\b|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*\/%=<>!&|^~?:]+)/g;

	return line.replace(tokenRegex, (match) => {
		if (match.startsWith("//") || match.startsWith("#") || match.startsWith("--")) {
			return theme.fg("syntaxComment", match);
		}
		const c = match.charCodeAt(0);
		if (c === 34 || c === 39 || c === 96) {
			return theme.fg("syntaxString", match);
		}
		if (/^\d/.test(match)) {
			return theme.fg("syntaxNumber", match);
		}
		if (CODE_KEYWORDS[match]) {
			return theme.fg("syntaxKeyword", match);
		}
		if (CODE_TYPES[match] || /^[A-Z][a-zA-Z0-9_]+$/.test(match)) {
			return theme.fg("syntaxType", match);
		}
		if (/^[+\-*\/%=<>!&|^~?:]+$/.test(match)) {
			return theme.fg("syntaxOperator", match);
		}
		return match;
	});
}

function colorizeAstToonLine(line: string, theme: ThemeLike): string {
	const kvMatch = line.match(/^(\s*)(?:(-\s+))?([a-zA-Z0-9_]+(?:\[\d+\])?(?:\{[^}]+\})?):\s*(.*)$/);
	if (kvMatch) {
		const indent = kvMatch[1];
		const bullet = kvMatch[2] ? theme.fg("accent", "- ") : "";
		const key = kvMatch[3];
		const val = kvMatch[4];
		const coloredKey = theme.fg("syntaxKeyword", key);
		if (!val) return `${indent}${bullet}${coloredKey}:`;

		let coloredVal = val;
		if (val === "class" || val === "struct" || val === "interface" || val === "enum") {
			coloredVal = theme.fg("syntaxKeyword", val);
		} else if (/^[A-Z][a-zA-Z0-9_]+$/.test(val)) {
			coloredVal = theme.fg("syntaxType", val);
		} else {
			coloredVal = colorizeCodeLine(val, theme);
		}
		return `${indent}${bullet}${coloredKey}: ${coloredVal}`;
	}

	return colorizeCodeLine(line, theme);
}

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/*                          Structured Results & Panels                       */
/* -------------------------------------------------------------------------- */

function prettifyYaml(value: string): string {
	const lines = value.trim().split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ""));
	const contentLines = lines.filter((line) => line.trim().length > 0);
	if (contentLines.length === 0) return "";
	const minimumIndent = Math.min(
		...contentLines.map((line) => (line.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "  ").length),
	);
	return lines.map((line) => line.slice(Math.min(minimumIndent, line.length))).join("\n");
}

function isLikelyCode(text: string): boolean {
	return /(?:;\s*$|[{}]|\b(?:using|namespace|class|interface|public|private|protected|import|export|function|const|let|var|def|fn|return)\b|\/\/|\/\*)/m.test(text);
}

interface ToolResultBlock {
	type?: string;
	text?: string;
}

interface ToolResultEnvelope {
	content?: ToolResultBlock[];
	details?: {
		jsonOutputs?: unknown[];
		data?: unknown;
		result?: unknown;
		[key: string]: unknown;
	};
}

function extractToolPayload(event: { toolName: string; result: unknown }): unknown {
	const result = event.result;
	if (!result || typeof result !== "object") return result;

	const envelope = result as ToolResultEnvelope;
	if (Array.isArray(envelope.content)) {
		const textParts = envelope.content
			.filter((c): c is ToolResultBlock & { text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		const rawText = textParts.join("\n");

		if (event.toolName === "eval" && Array.isArray(envelope.details?.jsonOutputs)) {
			const jsonOutputs = envelope.details.jsonOutputs;
			if (jsonOutputs.length > 0) {
				if (jsonOutputs.length === 1) {
					const item = jsonOutputs[0];
					if (
						item &&
						typeof item === "object" &&
						"text" in item &&
						Object.keys(item).length === 1
					) {
						const textVal = (item as Record<string, unknown>).text;
						if (typeof textVal === "string" && textVal.includes("\n")) {
							return textVal;
						}
					}
					return item;
				}
				return jsonOutputs;
			}
		}

		const displayMatch = /^display\[\d+\]:\s*\n([\s\S]*)$/.exec(stripGeneratedNoticeFooter(rawText).trim());
		if (displayMatch) {
			const body = displayMatch[1].trim();
			try {
				const parsed: unknown = JSON.parse(body);
				if (
					parsed &&
					typeof parsed === "object" &&
					"text" in parsed &&
					Object.keys(parsed).length === 1
				) {
					const textVal = (parsed as Record<string, unknown>).text;
					if (typeof textVal === "string" && textVal.includes("\n")) {
						return textVal;
					}
				}
				return parsed;
			} catch {
				return body;
			}
		}

		if (event.toolName === "grep") {
			const grepParsed = parseGrepOutput(rawText);
			if (grepParsed) return grepParsed;
		}

		const trimmedRaw = stripGeneratedNoticeFooter(rawText).trim();
		if (trimmedRaw.startsWith("{") || trimmedRaw.startsWith("[")) {
			try {
				return JSON.parse(trimmedRaw);
			} catch {
				// Not JSON, fall through
			}
		}
		// MCP tools often serialize structuredContent as a markdown fenced ```json block.
		const fencedRaw = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmedRaw);
		if (fencedRaw && /^[\[{]/.test(fencedRaw[1].trim())) {
			try {
				return JSON.parse(fencedRaw[1].trim());
			} catch {
				// Not JSON, fall through
			}
		}

		if (rawText.length > 0) return rawText;
	}

	if (envelope.details && typeof envelope.details === "object") {
		if (envelope.details.data !== undefined) return envelope.details.data;
		if (envelope.details.result !== undefined) return envelope.details.result;
	}

	return result;
}

function structuredResult(result: unknown): StructuredText {
	const useToon = isTweakEnabled("tool-results-toon");
	// Tool output is untrusted: strip escape hatches before anything parses or measures it.
	const text = typeof result === "string" ? sanitizeTerminalText(result) : result;
	if (typeof text === "string") {
		const search = formatSearchOutput(text);
		if (search !== undefined) return { text: search, format: "text" };
	}
	if (typeof text === "string" && isFileExcerpt(text)) {
		return { text: formatFileExcerpt(text, useToon), format: "text" };
	}
	const target = decodeNestedJson(text);

	if (target !== null && typeof target === "object") {
		if (useToon) {
			try {
				return formatJsonOutput(target, useToon);
			} catch {
				// Fall through
			}
		}
		try {
			return { text: JSON.stringify(target, null, 2) ?? String(target), format: "json" };
		} catch {
			return { text: String(target), format: "text" };
		}
	}

	if (typeof text === "string") {
		if (useToon) {
			const timedJson = formatJsonWithFooter(text, useToon);
			if (timedJson) return timedJson;
		}
		const yaml = isLikelyCode(text) ? undefined : parseYamlDocument(text);
		if (yaml !== undefined) {
			if (useToon) {
				try {
					return formatJsonOutput(decodeNestedJson(yaml), useToon);
				} catch (error) {
					// Only a parse-level failure falls back to the YAML text; a formatter bug
					// must not pass for "not structured".
					if (!(error instanceof SyntaxError)) throw error;
				}
			}
			return { text: prettifyYaml(text), format: "yaml" };
		}

		// Output that reads as code keeps syntax colour but is never rewritten: real outlines
		// come from the tree-sitter read/edit cards, not from guessing at command output.
		if (isLikelyCode(text)) return { text, format: "code" };

		if (useToon) {
			const tabular = parseTabularData(text);
			if (tabular !== undefined && tabular.length > 0) {
				try {
					return formatJsonOutput(tabular, useToon);
				} catch {
					// Fall through
				}
			}
		}
	}

	return { text: typeof text === "string" ? text : String(text), format: "text" };
}

// Joined text blocks of a tool result: the same view the native card and the model start from.
function toolResultText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) continue;
		if (typeof block.text === "string") texts.push(block.text);
	}
	return texts.length === 0 ? undefined : texts.join("\n");
}

// Complete JSON tool output, including `display[N]:`-prefixed eval results, encoded as TOON for
// the model. Undefined when the text is not one JSON document or when TOON would not be a plain
// body (command results, artifact previews, excerpts), so those results reach the model verbatim.
function toonForModel(text: string): string | undefined {
	const { body, footer } = separateGeneratedNoticeFooter(text);
	const trimmed = body.trim();
	let jsonText: string;
	const displayMatch = /^(?:display\[\d+\]:\s*)?([\[{][\s\S]*)$/.exec(trimmed);
	if (displayMatch) {
		jsonText = displayMatch[1];
	} else {
		// MCP tools often serialize structuredContent as a markdown fenced ```json block.
		const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
		if (fenced && /^[\[{]/.test(fenced[1].trim())) {
			jsonText = fenced[1].trim();
		} else {
			return undefined;
		}
	}
	const decoded = decodeNestedJson(jsonText);
	if (decoded === null || typeof decoded !== "object") return undefined;
	try {
		const output = formatJsonOutput(decoded);
		if (output.format !== "toon") return undefined;
		return footer ? `${output.text}\n${footer.trimStart()}` : output.text;
	} catch {
		return undefined;
	}
}

// True when OMP's own card already draws this result as a JSON tree: the tool (or the xd://
// device behind a write) has no bespoke renderer and the text is one JSON document.
function nativeRendersJsonTree(toolName: string, args: unknown, text: string | undefined): boolean {
	if (text === undefined) return false;
	const trimmed = stripGeneratedNoticeFooter(text).trimEnd();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try { JSON.parse(trimmed); } catch { return false; }
	let rendererName = toolName;
	if (toolName === "write" && args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path.startsWith("xd://")) {
		rendererName = args.path.slice("xd://".length).split(/[/?#]/)[0] || toolName;
	}
	return !(rendererName in toolRenderers);
}

function colorizeOutlineLine(line: string, theme: ThemeLike): string {
	const header = /^(\S[^·]*?)( · .*)$/.exec(line);
	if (header) return `${theme.fg("accent", header[1])}${theme.fg("dim", header[2])}`;
	const fold = /^(\s*)(⋯\d+)$/.exec(line);
	if (fold) return `${fold[1]}${theme.fg("muted", fold[2])}`;
	// Markdown heading row: indent, hashes, heading text, line number
	const mdRow = /^(\s*)(#{1,6})\s+(.*?)(  :\d+)?$/.exec(line);
	if (mdRow) {
		const indent = mdRow[1];
		const hashes = theme.fg("syntaxKeyword", mdRow[2]);
		const title = theme.fg("syntaxType", mdRow[3]);
		const lineTarget = mdRow[4] ? theme.fg("dim", mdRow[4]) : "";
		return `${indent}${hashes} ${title}${lineTarget}`;
	}
	const row = /^(\s*)(.*?)(  ⋯\d+)?$/.exec(line);
	if (row) return `${row[1]}${colorizeCodeLine(row[2], theme)}${row[3] ? theme.fg("muted", row[3]) : ""}`;
	return line;
}

const EDIT_MARKER_COLOR: Record<string, ThemeColor> = { "~": "warning", "+": "success", "−": "error", "→": "accent" };

function colorizeEditOutlineLine(line: string, theme: ThemeLike): string {
	const header = /^(\S[^·]*?)( · .*)$/.exec(line);
	if (header) return `${theme.fg("accent", header[1])}${theme.fg("dim", header[2])}`;
	const diagnosticsHeading = /^ ! (Diagnostics.*)$/.exec(line);
	if (diagnosticsHeading) return ` ${theme.fg("error", "!")} ${theme.fg("warning", diagnosticsHeading[1])}`;
	const diagnostic = /^(\s{5})([✖⚠ℹ·]) (.*)$/.exec(line);
	if (diagnostic) {
		const color: ThemeColor = diagnostic[2] === "✖" ? "error" : diagnostic[2] === "⚠" ? "warning" : "dim";
		return `${diagnostic[1]}${theme.fg(color, diagnostic[2])} ${theme.fg(color, diagnostic[3])}`;
	}
	const detail = /^(\s{3,})([+−→]) (.*)$/.exec(line);
	if (detail) return `${detail[1]}${theme.fg(EDIT_MARKER_COLOR[detail[2]], detail[2])} ${colorizeCodeLine(detail[3], theme)}`;
	const row = /^ ([~+− ]) (\s*)(.*?)(  \([+−][\d −+]*\))?$/.exec(line);
	if (row) {
		const marker = row[1] === " " ? " " : theme.fg(EDIT_MARKER_COLOR[row[1]], row[1]);
		const signature = row[1] === " " || row[3] === "(top level)" ? theme.fg("dim", row[3]) : colorizeCodeLine(row[3], theme);
		return ` ${marker} ${row[2]}${signature}${row[4] ? theme.fg(EDIT_MARKER_COLOR[row[1]], row[4]) : ""}`;
	}
	return line;
}

function colorizeStructuredLine(line: string, format: StructuredFormat, theme: ThemeLike): string {
	// Already coloured by whatever printed it. Tokenising would wrap the digits inside `\x1b[38;2;…m`
	// and shred the escape itself, leaving bare `38;2;91;192;190m` fragments on screen.
	if (line.includes("\x1b[")) return line;
	if (format === "links") return line;
	if (format === "outline") return colorizeOutlineLine(line, theme);
	if (format === "edit-outline") return colorizeEditOutlineLine(line, theme);
	if (format === "command") {
		if (/^\s*Result(?: \d+)?(?:;|$)/.test(line)) return theme.fg(/; failed(?:;|$)/.test(line) ? "error" : "accent", line);
		return line;
	}
	if (/^\s*(?:\[[^\]\r\n]+#(?:[\da-f]+|:[^\]\r\n]*)?\]|#{1,6} .+#[\da-f]+|#{1,6} .+\/)\s*$/i.test(line)) return theme.fg("dim", line);
	if (/^\s*\[(?:Showing lines|truncated;|Source:)/.test(line) || /^\s*(?:…|\.\.\.)\s*$/.test(line)) return theme.fg("dim", line);
	if (format === "file") {
		if (/^\s*[\w$]+(?:\[\d+\])?(?:\{[^}]+\})?:\s/.test(line)) return colorizeAstToonLine(line, theme);
		// Check for line-numbered source code output: e.g. "4:describe(...)" or "   4│ const x = 1;"
		const lineNumbered = /^(\s*\*?\d+[:│])\s*(.*)$/.exec(line);
		if (lineNumbered) {
			const num = theme.fg("dim", lineNumbered[1]);
			const code = colorizeCodeLine(lineNumbered[2], theme);
			return `${num} ${code}`;
		}
		return colorizeCodeLine(line, theme);
	}
	if (format === "toon") {
		return colorizeAstToonLine(line, theme);
	}
	if (format === "code") {
		return colorizeCodeLine(line, theme);
	}
	const token = /^(\s*)(.*)$/.exec(line);
	if (!token) return line;
	const [, indent, value] = token;
	const colored = value.replace(
		format === "yaml"
			? /^(\s*(?:-\s+)?)([^:#\n]+)(:)(.*)$/
			: /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g,
		(...matches: string[]) => {
			if (format === "yaml") {
				const [, prefix, key, colon, rest] = matches;
				return `${prefix}${theme.fg("accent", key.trim())}${colon}${rest}`;
			}
			const [, key, string, number, literal] = matches;
			if (key) return theme.fg("accent", key);
			if (string) return theme.fg("success", string);
			if (number) return theme.fg("warning", number);
			return theme.fg(literal === "null" ? "muted" : "syntaxKeyword", literal);
		},
	);
	return indent + colored;
}

// Tool-card styling: the host card owns the background.
// Pad one card line to the requested width without changing its background.
function padToolBlockLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return line + " ".repeat(Math.max(0, width - visible));
}

type ToolCardDetails = NonNullable<ToolMessage["details"]>;

// Which hydemods layout a result gets. "text" means hydemods has nothing structural to add.
function structureToolResult(details: ToolCardDetails | undefined): StructuredText {
	const result = details?.result;
	const references = referenceLocations(result);
	const markdownText = markdownOutput(result);
	const base = details?.cwd ?? process.cwd();
	const structured: StructuredText = references ? {
		text: references.locations.map(location => {
			const path = location.path.startsWith("~/") ? resolve(homedir(), location.path.slice(2)) : resolve(base, location.path);
			const label = `${location.path}:${location.line}:${location.column}`;
			// Link only a file the user can actually open: a path the model invented, or one
			// outside the workspace and home, must not become an OSC 8 link.
			const home = homedir();
			let linkable = !/[\x00-\x1f\x7f]/.test(path) && (path.startsWith(`${base}${sep}`) || path.startsWith(`${home}${sep}`));
			if (linkable) {
				try {
					linkable = statSync(path).isFile();
				} catch {
					linkable = false;
				}
			}
			return linkable ? fileHyperlink(path, underlineLabel(label), { line: location.line }) : underlineLabel(label);
		}).concat(references.incomplete ? ["…"] : []).join("\n"),
		format: "links",
	} : markdownText !== undefined ? { text: markdownText, format: "markdown" } : structuredResult(result);
	if (structured.format === "text" && markdownOutput(structured.text) !== undefined) structured.format = "markdown";
	if (structured.format !== "links" && structured.format !== "markdown" && structured.format !== "command" && isFileExcerpt(structured.text)) structured.format = "file";
	return structured;
}

// File excerpts show `[name#:range]` instead of the snapshot header; the code under it loses its
// line numbers and comments. The host's display text wins over the model-facing text.
function commentFreeText(structured: StructuredText, displayText?: string): string {
	if (structured.format !== "file" || !/^\[[^\]#\r\n]+#[\da-f]+\]\r?\n/i.test(structured.text)) {
		return stripGeneratedNoticeFooter(structured.text);
	}
	const shown = presentReadExcerpt({ text: structured.text, displayContent: displayText === undefined ? undefined : { text: displayText }, filenameShown: false });
	return shown.header ? `${shown.header}\n${shown.body}` : shown.body;
}

function toolMessageRenderer(message: ToolMessage, options: RendererOptions, theme: Theme, display: ToolDisplayState, structured: StructuredText = structureToolResult(message.details)) {
	const details = message.details;
	const toolName = details?.toolName || "tool";
	const error = details?.isError;
	const resultDetails = (details?.result as { details?: ReadOutlineDetails } | undefined)?.details;
	const pretty = commentFreeText(structured, resultDetails?.displayContent?.text).trim() || "(empty)";
	const rawLines = pretty
		.split(/\r?\n/)
		.map((line) => line.replace(/\t/g, "  ").trimEnd())
		.filter((line) => structured.format === "command" || line.length > 0);

	const label = theme.fg(error ? "error" : "success", toolName);
	// A quote-style rule between the tool name and its output; continuation rows carry it too.
	const rule = error ? theme.fg("error", "│") : green("│");
	const trailingRule = error ? theme.fg("error", "┆") : green("┆");
	const coloredPrefix = `${label} ${rule} `;
	// Continuation lines hang under the first content column (visible width of "name ").
	const indent = " ".repeat(`${toolName} `.length);
	const hangingIndent = `${indent}${rule} `;

	const markdown = structured.format === "markdown"
		? new Markdown(pretty.replace(/^(\[[^\]\r\n]+#[\da-f]+\]|\[(?:Source:|Showing lines|truncated;)[^\r\n]*\])$/gim, line => theme.fg("dim", line)), 0, 0, getMarkdownTheme(), { color: text => theme.fg("text", text) })
		: undefined;
	// A failed result keeps the standard layout; the error colour is what says it failed.
	const contentLines = markdown ? [] : rawLines.map((line, index) => {
		const colored = error ? theme.fg("error", line) : colorizeStructuredLine(line, structured.format, theme);
		if ((structured.format === "file" && index === 0) || (structured.path && index === 0)) return underlineLabel(colored);
		return structured.format === "command" || structured.format === "text" ? underlinePathTokens(colored) : colored;
	});
	const heading = `${label} · expanded ${structured.lang || structured.format} output`;
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded === true;
			const renderedContent = markdown
				? markdown.render(Math.max(1, width - (expanded ? 2 : visibleWidth(coloredPrefix))))
				: contentLines;
			if (expanded) {
				return [heading, ...renderedContent.map(line => `  ${line}`)]
					.flatMap(line => wrapTextWithAnsi(line, width))
					.map(line => padToolBlockLine(line, width));
			}
			const limit = display.collapsedLines;
			// Collapsed edit cards are the declaration tree; the change lines wait for expansion.
			// Diagnostics sit below the tree and stay visible: the heading and the first few messages.
			const diagnosticsAt = structured.format === "edit-outline" ? rawLines.findIndex(line => /^ ! Diagnostics/.test(line)) : -1;
			const tree = diagnosticsAt >= 0 ? renderedContent.slice(0, diagnosticsAt) : renderedContent;
			let hiddenLines = 0;
			let selected: string[] = [
				...(structured.format === "edit-outline"
					? tree.filter((_, index) => !/^\s{3,}[+−→] /.test(rawLines[index]))
					: tree),
			];
			if (selected.length > limit) {
				// Output reads in order: the first rows, with what follows reported by the size in the last gutter.
				hiddenLines = selected.length - Math.max(1, limit);
				selected = selected.slice(0, Math.max(1, limit));
			}
			if (diagnosticsAt >= 0) {
				const messages = renderedContent.slice(diagnosticsAt + 1);
				const kept = collapseTextLines(messages, 3, false, { marker: () => theme.fg("muted", "[...]") });
				selected = [...selected, renderedContent[diagnosticsAt], ...kept];
			}
			// Every card ends on a dashed rule; hidden rows are reported as an estimated size (Ctrl+O shows them).
			const hiddenText = hiddenLines > 0 && diagnosticsAt < 0 ? hiddenSize(pretty) : undefined;
			return selected.map((line, index) => {
				const isFirst = index === 0;
				const isLast = index === selected.length - 1;
				const gutter = cardGutter({ prefix: isFirst ? coloredPrefix : hangingIndent, rule, trailingRule, indentWidth: indent.length, isFirst, isLast, hiddenText });
				return padToolBlockLine(truncateToWidth(`${gutter}${line}${rowSuffix(isFirst, isLast, hiddenText)}`, width), width);
			});
		},
		invalidate() { markdown?.invalidate(); },
	};
}

// A context_notes write acknowledges with one line; the notebook itself is what the card
// should show. Reads already return the notebook as the result.
function notebookPayload(toolName: string, args: unknown, isError: boolean | undefined): string | undefined {
	if (isError || toolName !== "context_notes") return;
	const text = (args as { text?: unknown } | undefined)?.text;
	return typeof text === "string" && text.trim() ? text : undefined;
}

/* ------------------------- declaration outlines ------------------------- */

// Outlines are pure functions of file content; keep the latest few so repaints and history
// replays do not re-parse.
const OUTLINE_MEMO_LIMIT = 64;
const outlineMemo = new Map<string, Outline | undefined>();

function memoOutline(key: string, code: string, path: string | undefined): Outline | undefined {
	if (outlineMemo.has(key)) return outlineMemo.get(key);
	let outline: Outline | undefined;
	try {
		// Comments never appear on a card, so signatures are read from the comment-free text; lines stay put.
		outline = outlineSource(path ? scanComments(code, extensionOf(path)).lines.join("\n") : code, { path }, summarizeCode);
	} catch {
		outline = undefined;
	}
	if (outlineMemo.size >= OUTLINE_MEMO_LIMIT) outlineMemo.delete(outlineMemo.keys().next().value!);
	outlineMemo.set(key, outline);
	return outline;
}

function displayPath(path: string): string {
	const cwd = process.cwd();
	if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

type ReadOutlineDetails = {
	kind?: string;
	resolvedPath?: string;
	displayTarget?: string;
	totalLines?: number;
	truncation?: { truncated?: boolean };
	displayContent?: { text: string; startLine?: number; lineNumbers?: Array<number | null> };
	meta?: { source?: { type?: string; value?: unknown } };
};

// Once a read has an outline it keeps it: the transcript repaints the same result object long
// after the file it came from has been edited again.
const readOutlineByResult = new WeakMap<object, StructuredText>();

// A file read as a declaration outline. Whole-file reads outline the returned text; ranges
// outline the file on disk, but only where the disk still holds the lines the read returned.
function readOutlineStructured(result: { content: unknown; details?: unknown }, args: unknown): StructuredText | undefined {
	const remembered = readOutlineByResult.get(result);
	if (remembered) return remembered;
	const structured = computeReadOutline(result, args);
	if (structured) readOutlineByResult.set(result, structured);
	return structured;
}
// A grep result enriched with AST declaration context for matching lines.
function grepOutlineStructured(result: { content: unknown; details?: unknown; isError?: boolean }): StructuredText | undefined {
	if (result.isError) return undefined;
	const details = (result.details ?? {}) as {
		displayContent?: string;
		cwd?: string;
		files?: string[];
		scopePath?: string;
		searchPath?: string;
	};

	const rawText = details.displayContent ?? toolResultText(result.content) ?? "";
	if (!rawText || rawText === "No matches found") return undefined;

	// Parse file blocks and line matches from grep displayContent or raw output.
	// OMP grep output uses either:
	// 1) Single-file format: [path/to/file#hash] or starting directly with matches when scopePath is given.
	// 2) Multi-file format: markdown headings:
	//    # /dir/path/
	//    ## sub/
	//    ### file.ts#C690
	// 3) Line rows:
	//    Context: `  12: text` or `  12│text`
	//    Matches: ` *13: text` or ` *13│text`
	//    Elisions: `    │...`
	const lines = rawText.split(/\r?\n/);
	const filesMap = new Map<string, Array<{ line: number; text: string; starred: boolean }>>();
	let currentFile: string | undefined;
	const dirStack: string[] = [];

	for (const line of lines) {
		const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch[1].length;
			let headingTarget = headingMatch[2].trim();
			// Strip trailing tag like #D5B3
			const hashIndex = headingTarget.indexOf("#");
			if (hashIndex > 0) headingTarget = headingTarget.slice(0, hashIndex).trim();

			if (headingTarget.endsWith("/")) {
				// Directory heading
				dirStack.length = Math.min(dirStack.length, level - 1);
				dirStack[level - 1] = headingTarget;
				currentFile = undefined;
			} else {
				// File heading
				dirStack.length = Math.min(dirStack.length, level - 1);
				const dirPrefix = dirStack.join("");
				const candidatePath = dirPrefix ? `${dirPrefix}${headingTarget}` : headingTarget;
				currentFile = candidatePath;
				if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
			}
			continue;
		}

		const bracketMatch = /^\[([^\]#\s]+)(?:#[a-f0-9]+)?\]$/i.exec(line);
		if (bracketMatch) {
			currentFile = bracketMatch[1];
			if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
			continue;
		}

		if (!currentFile && details.scopePath && (line.includes(":") || line.includes("│"))) {
			currentFile = details.scopePath;
			if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
		}

		if (currentFile) {
			const matchLine = /^\s*(\*)?\s*(\d+)[│:]\s?(.*)$/.exec(line);
			if (matchLine) {
				const starred = Boolean(matchLine[1]);
				const lineNum = Number(matchLine[2]);
				const matchText = matchLine[3];
				filesMap.get(currentFile)!.push({ line: lineNum, text: matchText, starred });
			}
		}
	}

	if (filesMap.size === 0) return undefined;

	const fileMatchesList: GrepFileMatches[] = [];
	for (const [filePath, rows] of filesMap.entries()) {
		// When any row in the file is explicitly starred (*), filter to only starred rows (actual matches, not context)
		const hasStarred = rows.some(r => r.starred);
		const filtered = hasStarred ? rows.filter(r => r.starred) : rows;
		if (filtered.length > 0) {
			fileMatchesList.push({
				path: filePath,
				matches: filtered.map(r => ({ line: r.line, text: r.text })),
			});
		}
	}
	if (fileMatchesList.length === 0) return undefined;

	const outlineForFile = (filePath: string) => {
		const baseDir = details.cwd ?? process.cwd();
		const resolved = resolve(baseDir, filePath.startsWith("~/") ? resolve(homedir(), filePath.slice(2)) : filePath);
		try {
			const stat = statSync(resolved);
			const code = readFileSync(resolved, "utf8");
			const stamp = `${stat.size}:${stat.mtimeMs}`;
			const outline = memoOutline(`disk:${resolved}:${stamp}`, code, resolved);
			return { outline, lines: code.split(/\r?\n/) };
		} catch {
			return undefined;
		}
	};

	const rendered = renderGrepOutline(fileMatchesList, outlineForFile);
	if (!rendered) return undefined;

	return { text: rendered.join("\n"), format: "outline" };
}

// A whole-file write shown as the declaration outline of what was written, plus diagnostics.
function writeOutlineStructured(result: { details?: unknown; isError?: boolean }, args: unknown): StructuredText | undefined {
	if (result.isError) return undefined;
	const { path, content } = (args ?? {}) as { path?: unknown; content?: unknown };
	if (typeof path !== "string" || typeof content !== "string" || !content.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
	const details = (result.details ?? {}) as { resolvedPath?: unknown; diagnostics?: EditOutlineDetails["diagnostics"] };
	const fsPath = typeof details.resolvedPath === "string" ? details.resolvedPath : resolve(path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
	const outline = memoOutline(`text:${fsPath}:${Bun.hash(content)}`, content, fsPath);
	if (!outline || outline.declarations.length === 0) {
		// Nothing to outline (scripts, data, prose): one summary row instead of the full content.
		const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
		const rows = [`${displayPath(fsPath)} · ${lines} line${lines === 1 ? "" : "s"} written`, ...diagnosticsRows(details.diagnostics, fsPath)];
		return { text: rows.join("\n"), format: "outline", path: fsPath };
	}
	const rows = [...renderOutline(outline, displayPath(fsPath)), ...diagnosticsRows(details.diagnostics, fsPath)];
	return { text: rows.join("\n"), format: "outline", lang: outline.language, path: fsPath };
}

function computeReadOutline(result: { content: unknown; details?: unknown }, args: unknown): StructuredText | undefined {
	const details = (result.details ?? undefined) as ReadOutlineDetails | undefined;
	const text = details?.displayContent?.text;
	if (typeof text !== "string" || !text.trim() || (details?.kind && details.kind !== "file")) return undefined;
	const rawPath = (args as { path?: unknown; file_path?: unknown } | undefined);
	const target = typeof rawPath?.path === "string" ? rawPath.path : typeof rawPath?.file_path === "string" ? rawPath.file_path : "";
	const split = splitPathAndSel(target);
	const source = readSourceFsPath(details as Parameters<typeof readSourceFsPath>[0]) ?? details?.resolvedPath ?? details?.displayTarget ?? split.path;
	if (!source || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return undefined;
	const fsPath = source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : resolve(source);
	const label = displayPath(split.path.startsWith("~/") ? resolve(homedir(), split.path.slice(2)) : resolve(split.path));
	// A range ending on a blank line ends the text with "\n"; `lineNumbers` counts that row.
	const shown = text.split("\n");
	if (!details?.displayContent?.lineNumbers && shown[shown.length - 1] === "") shown.pop();
	const startLine = details?.displayContent?.startLine ?? 1;
	const whole = startLine === 1 && !details?.truncation?.truncated && (details?.totalLines === undefined || Math.abs(details.totalLines - shown.length) <= 1);
	if (whole) {
		const isMarkdown = /\.(?:md|markdown|mdx)$/i.test(fsPath);
		if (isMarkdown) {
			const mdOutline = outlineMarkdown(text);
			if (mdOutline && mdOutline.headings.length > 0) {
				return { text: renderMarkdownOutline(mdOutline, label).join("\n"), format: "outline", lang: "markdown", path: fsPath };
			}
		}
		const outline = memoOutline(`text:${fsPath}:${Bun.hash(text)}`, text, fsPath);
		if (!outline || outline.declarations.length === 0) return undefined;
		return { text: renderOutline(outline, label).join("\n"), format: "outline", lang: outline.language, path: fsPath };
	}
	let disk: string;
	let stamp: string;
	try {
		const stat = statSync(fsPath);
		stamp = `${stat.size}:${stat.mtimeMs}`;
		disk = readFileSync(fsPath, "utf8");
	} catch {
		return undefined;
	}
	const diskLines = disk.split(/\r?\n/);
	// OMP pads a range with context and elides the gap as a `…` row; `lineNumbers` maps each
	// shown row to its source line (null for the elision).
	const numbers = details?.displayContent?.lineNumbers ?? shown.map((_, index) => startLine + index);
	if (numbers.length !== shown.length) return undefined;
	const numbered = numbers.filter((line): line is number => line !== null);
	if (numbered.length === 0) return undefined;
	// The requested lines, not the padded ones: `:50-60`, `:50`, `:50+10`, or several joined by commas.
	const parts = (split.sel ?? "").split(",").map(part => /^(\d+)(?:-(\d+)|\+(\d+))?$/.exec(part.trim())).filter((part): part is RegExpExecArray => part !== null);
	const requestedStart = Math.max(parts.length ? Math.min(...parts.map(part => Number(part[1]))) : -Infinity, Math.min(...numbered));
	const requestedEnd = Math.min(parts.length
		? Math.max(...parts.map(part => part[2] ? Number(part[2]) : part[3] ? Number(part[1]) + Number(part[3]) - 1 : Number(part[1])))
		: Infinity, Math.max(...numbered));
	if (requestedStart > requestedEnd) return undefined;
	// Only the requested lines must still be on disk; the padding is context OMP added and an
	// edit right beside the range rewrites it without touching what was read.
	const requested = numbers.map((line, index) => line !== null && line >= requestedStart && line <= requestedEnd ? index : -1).filter(index => index >= 0);
	if (requested.length === 0) return undefined;
	// Each contiguous run of requested lines is located on its own: an edit between two ranges
	// of one read moves the later range without touching the earlier one.
	const segments: number[][] = [];
	for (const index of requested) {
		const current = segments[segments.length - 1];
		if (current && numbers[index] === numbers[current[current.length - 1]]! + 1) current.push(index);
		else segments.push([index]);
	}
	const locate = (segment: number[]): number | undefined => {
		const matchesAt = (offset: number) => segment.every(index => {
			const at = numbers[index]! + offset;
			return at >= 1 && at <= diskLines.length && diskLines[at - 1].trimEnd() === shown[index].trimEnd();
		});
		if (matchesAt(0)) return 0;
		const anchorIndex = segment.find(index => shown[index].trim().length > 0);
		if (anchorIndex === undefined) return undefined;
		const anchorLine = numbers[anchorIndex]!;
		const anchorText = shown[anchorIndex].trimEnd();
		for (let line = 1; line <= diskLines.length; line++) {
			if (diskLines[line - 1].trimEnd() === anchorText && matchesAt(line - anchorLine)) return line - anchorLine;
		}
		return undefined;
	};
	const offsets = segments.map(locate);
	if (offsets.some(offset => offset === undefined)) return undefined;
	const first = segments[0];
	const last = segments[segments.length - 1];
	const rangeStart = numbers[first[0]]! + offsets[0]!;
	const endLine = numbers[last[last.length - 1]]! + offsets[offsets.length - 1]!;
	const outline = memoOutline(`disk:${fsPath}:${stamp}`, disk, fsPath);
	if (!outline) return undefined;
	const scan = scanComments(disk, extensionOf(fsPath));
	const rows = renderRange(outline, scan.lines, rangeStart, endLine, label, scan.dropped);
	return rows ? { text: rows.join("\n"), format: "outline", lang: outline.language, path: fsPath } : undefined;
}

type EditOutlineDetails = {
	diff?: string;
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	/** Outline captured by hydemods when the edit finished, while the disk still matched the diff. */
	hydemodsOutline?: string;
	perFileResults?: Array<{ diagnostics?: DiagnosticsLike }>;
	diagnostics?: DiagnosticsLike;
};

type DiagnosticsLike = { summary?: string; messages?: string[]; errored?: boolean };

const DIAGNOSTIC_GLYPH: Record<string, string> = { error: "✖", warning: "⚠", information: "ℹ", info: "ℹ", hint: "·" };

// LSP diagnostics as rows under the outline: a `!` heading with the summary, then one row per
// message with a severity glyph. The file is dropped from messages about the edited file, since
// the card heading already names it.
function diagnosticsRows(diagnostics: DiagnosticsLike | undefined, path: string | undefined): string[] {
	const messages = diagnostics?.messages ?? [];
	if (messages.length === 0) return [];
	const rows = [` ! Diagnostics${diagnostics?.summary ? ` (${diagnostics.summary})` : ""}`];
	for (const message of messages) {
		const parsed = /^(.+?):(\d+):(\d+) \[(\w+)\] (.*)$/.exec(message);
		if (!parsed) {
			rows.push(`     · ${message}`);
			continue;
		}
		const [, file, line, column, severity, text] = parsed;
		const own = path !== undefined && (path.endsWith(file) || file.endsWith(path));
		rows.push(`     ${DIAGNOSTIC_GLYPH[severity.toLowerCase()] ?? "·"} ${own ? "" : `${file}:`}${line}:${column} ${text}`);
	}
	return rows;
}

const editOutlineMemo = new Map<string, StructuredText | undefined>();

// An edit as the declarations it touched. Multi-file batches keep the native card. When the
// engine pruned the snapshots (large files), the file on disk stands in for the new text and
// the old text is rebuilt from it and the diff, as long as the diff still fits the disk.
function editOutlineStructured(result: { content: unknown; details?: unknown }): StructuredText | undefined {
	const details = (result.details ?? undefined) as EditOutlineDetails | undefined;
	if (!details || typeof details.diff !== "string" || !details.diff.trim() || (details.perFileResults?.length ?? 0) > 1) return undefined;
	const path = typeof details.path === "string" ? details.path : undefined;
	if (typeof details.hydemodsOutline === "string") return { text: details.hydemodsOutline, format: "edit-outline", path };
	const diagnostics = details.diagnostics ?? details.perFileResults?.[0]?.diagnostics;
	// Diagnostics can be filled in after the edit settles, so they are part of the memo key.
	const diagnosticsKey = Bun.hash(JSON.stringify(diagnostics?.messages ?? [])).toString();
	let newText = details.newText;
	let oldText = details.oldText;
	let key: string;
	if (typeof newText === "string") {
		key = `${path ?? ""}:${Bun.hash(details.diff)}:${Bun.hash(newText)}:${diagnosticsKey}`;
	} else {
		if (!path) return undefined;
		try {
			const stat = statSync(path);
			key = `${path}:${Bun.hash(details.diff)}:disk:${stat.size}:${stat.mtimeMs}:${diagnosticsKey}`;
			if (editOutlineMemo.has(key)) return editOutlineMemo.get(key);
			newText = readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
		oldText = recoverOldText(newText, details.diff);
		if (oldText === undefined) return undefined;
	}
	if (editOutlineMemo.has(key)) return editOutlineMemo.get(key);
	let structured: StructuredText | undefined;
	try {
		const rows = renderEditOutline({ oldText: oldText ?? "", newText, diff: details.diff, path }, path ? displayPath(path) : "edit", summarizeCode);
		structured = rows ? { text: [...rows, ...diagnosticsRows(diagnostics, path)].join("\n"), format: "edit-outline", path } : undefined;
	} catch {
		structured = undefined;
	}
	if (editOutlineMemo.size >= OUTLINE_MEMO_LIMIT) editOutlineMemo.delete(editOutlineMemo.keys().next().value!);
	editOutlineMemo.set(key, structured);
	return structured;
}

/* --------------------------- grouped read cards --------------------------- */

type ReadResultLike = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type ReadGroupState = {
	entries: Map<string, { args: unknown; result?: ReadResultLike }>;
	usage: Map<string, { usage: Usage; durationMs?: number; ttftMs?: number; timestamp?: number; turnElapsedMs?: number }>;
	expanded: boolean;
	visible: boolean;
};

// OMP folds consecutive reads into ReadToolGroupComponent, which draws its own summary rows and
// never consults toolRenderers. Record what each group is told, and draw the group as OMP does
// (`Read path` or `Read (N)` plus a tree) with each read's declaration outline nested under its
// path. Reads without an outline keep a bare path row; the group draws itself while any read is
// still pending. The class must come from `@oh-my-pi/pi-tui`: only host-mapped specifiers share
// the running instance, and a deeper import would patch a private copy.
// What each grouped read block was told, recorded by the takeover below; tool rows read it too.
const readGroupStates = new WeakMap<ReadToolGroupComponent, ReadGroupState>();

function installReadGroupTakeover(takeover: CardTakeover): void {
	const states = readGroupStates;
	const stateOf = (group: ReadToolGroupComponent): ReadGroupState => {
		let state = states.get(group);
		if (!state) {
			state = { entries: new Map(), usage: new Map(), expanded: false, visible: true };
			states.set(group, state);
		}
		return state;
	};
	const proto = ReadToolGroupComponent.prototype;
	const original = {
		updateArgs: proto.updateArgs,
		updateResult: proto.updateResult,
		renameEntry: proto.renameEntry,
		removeEntry: proto.removeEntry,
		attachUsage: proto.attachUsage,
		setExpanded: proto.setExpanded,
		setToolActivityVisible: proto.setToolActivityVisible,
		render: proto.render,
	};
	proto.updateArgs = function(args, toolCallId) {
		if (toolCallId) {
			const state = stateOf(this);
			const entry = state.entries.get(toolCallId);
			if (entry) entry.args = args;
			else state.entries.set(toolCallId, { args });
		}
		return original.updateArgs.call(this, args, toolCallId);
	};
	proto.updateResult = function(result, isPartial, toolCallId) {
		if (toolCallId && !isPartial) {
			const entry = stateOf(this).entries.get(toolCallId);
			if (entry) entry.result = result;
		}
		return original.updateResult.call(this, result, isPartial, toolCallId);
	};
	proto.renameEntry = function(oldId, newId) {
		const state = stateOf(this);
		const entry = state.entries.get(oldId);
		if (entry && oldId !== newId && !state.entries.has(newId)) {
			const reordered = [...state.entries].map(([key, value]) => [key === oldId ? newId : key, value] as const);
			state.entries = new Map(reordered);
		}
		return original.renameEntry.call(this, oldId, newId);
	};
	proto.removeEntry = function(toolCallId) {
		stateOf(this).entries.delete(toolCallId);
		return original.removeEntry.call(this, toolCallId);
	};
	proto.attachUsage = function(toolCallIds, usage, durationMs, ttftMs, timestamp, turnElapsedMs) {
		const state = stateOf(this);
		let anchor: string | undefined;
		for (const id of toolCallIds) if (state.entries.has(id)) anchor = id;
		if (anchor) state.usage.set(anchor, { usage, durationMs, ttftMs, timestamp, turnElapsedMs });
		return original.attachUsage.call(this, toolCallIds, usage, durationMs, ttftMs, timestamp, turnElapsedMs);
	};
	proto.setExpanded = function(expanded) {
		stateOf(this).expanded = expanded;
		return original.setExpanded.call(this, expanded);
	};
	proto.setToolActivityVisible = function(visible) {
		stateOf(this).visible = visible;
		return original.setToolActivityVisible.call(this, visible);
	};
	proto.render = function(width) {
		const state = states.get(this);
		if (!state || !state.visible || !takeover.active() || state.entries.size === 0) return original.render.call(this, width);
		const rows: ReadTreeRow[] = [];
		for (const [id, entry] of state.entries) {
			if (!entry.result || entry.result.isError) return original.render.call(this, width);
			rows.push({ id, ...readTreeRow(entry.result, entry.args) });
		}
		if (!rows.some(row => row.outline || row.prose)) return original.render.call(this, width);
		return renderReadTree(rows, state, uiTheme, takeover.display, width);
	};
}

type ReadTreeRow = { id: string; header: string; outline?: string[]; prose?: string[] };

// One read as a tree row: the path line (hyperlinked when it names a file) and, when the read
// parses, its outline rows beneath.
function readTreeRow(result: ReadResultLike, args: unknown): Omit<ReadTreeRow, "id"> {
	const structured = readOutlineStructured(result, args);
	if (structured) {
		const [header, ...outline] = structured.text.split("\n");
		const colored = colorizeOutlineLine(header, uiTheme);
		return { header: structured.path ? fileHyperlink(structured.path, underlineLabel(colored)) : colored, outline };
	}
	const rawPath = args as { path?: unknown; file_path?: unknown } | undefined;
	const target = typeof rawPath?.path === "string" ? rawPath.path : typeof rawPath?.file_path === "string" ? rawPath.file_path : "";
	const split = splitPathAndSel(target);
	const shown = /^[a-z][a-z0-9+.-]*:\/\//i.test(split.path) ? target : `${displayPath(split.path.startsWith("~/") ? resolve(homedir(), split.path.slice(2)) : resolve(split.path))}${split.sel ? `:${split.sel}` : ""}`;
	const details = result.details as ReadOutlineDetails | undefined;
	const modelText = toolResultText(result.content);
	const displayText = details?.displayContent?.text;
	const isExcerpt = displayText !== undefined || (modelText !== undefined && /^\[[^\]#\r\n]+#[\da-f]+\]\r?\n/i.test(modelText));
	const header = isExcerpt ? `[${shown}]` : shown;
	// The row above already names the file, so only the code body is shown.
	const text = isExcerpt
		? presentReadExcerpt({ text: modelText ?? "", displayContent: displayText === undefined ? undefined : { text: displayText }, path: split.path, selector: split.sel || undefined, filenameShown: true }).body.trim()
		: stripGeneratedNoticeFooter(modelText ?? "").trim();
	return { header: /^[a-z][a-z0-9+.-]*:\/\//i.test(split.path) ? uiTheme.fg("accent", header) : uiTheme.fg("accent", underlineLabel(header)), prose: text ? text.split(/\r?\n/) : undefined };
}

// A read drops blank rows, and a collapsed preview keeps the first rows and ends at a `… N more`
// row: keeping the last row would leave a lone `}` hanging below the count. Expanded shows all.
function collapseReadRows(kept: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	if (expanded || kept.length <= limit) return kept;
	const shown = Math.max(1, limit - 1);
	return [...kept.slice(0, shown), theme.fg("muted", `… ${kept.length - shown} more`)];
}

function outlineRows(outline: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	return collapseReadRows(outline.filter(line => line.trim() !== "").map(line => colorizeOutlineLine(line, theme)), expanded, limit, theme);
}

function proseRows(prose: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	const colored = prose.filter(line => line.trim() !== "").map(line => {
		// Check for line-numbered source code output: e.g. "4:describe(...)" or "   4│ const x = 1;"
		const lineNumbered = /^(\s*\*?\d+[:│])\s*(.*)$/.exec(line);
		if (lineNumbered) return `${theme.fg("dim", lineNumbered[1])} ${colorizeCodeLine(lineNumbered[2], theme)}`;
		if (/^\[[^\]]+#[0-9a-fA-F]+\]$/.test(line)) return theme.fg("dim", line);
		return colorizeCodeLine(line, theme);
	});
	return collapseReadRows(colored, expanded, limit, theme);
}

// Mirrors pi-tui's usage row, but against the theme handed to the renderer. The
// `overlays/usage-row` subpath is not host-mapped, so its copy of the theme
// singleton is never initialised and reading `theme.icon` there throws.
function formatUsageRow(theme: Theme, usage: Usage, durationMs?: number, ttftMs?: number, timestamp?: number, turnElapsedMs?: number): string {
	const specs: MetricSpec[] = [];
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		const d = new Date(timestamp);
		const pad = (n: number): string => String(n).padStart(2, "0");
		specs.push({ value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` });
	}
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) specs.push({ value: `Δ ${formatDuration(Math.round(turnElapsedMs))}` });
	specs.push({ leading: theme.icon.input, value: formatNumber(usage.input + usage.cacheWrite) });
	specs.push({ leading: theme.icon.output, value: formatNumber(usage.output) });
	if (usage.cacheRead > 0) specs.push({ leading: theme.icon.cache, value: formatNumber(usage.cacheRead) });
	if (ttftMs && ttftMs > 0) specs.push({ leading: theme.icon.time, value: `${(ttftMs / 1000).toFixed(1)}s` });
	if (durationMs && durationMs > 100 && usage.output > 0) {
		specs.push({ leading: theme.icon.throughput, value: `${((usage.output / durationMs) * 1000).toFixed(1)}/s` });
	}
	return formatMetricRow(specs, { separator: "  " });
}

function renderReadTree(rows: ReadTreeRow[], state: ReadGroupState, theme: Theme, display: ToolDisplayState, width: number): string[] {
	const title = theme.fg("toolTitle", theme.bold("Read"));
	const usageLines = (id: string, prefix: string): string[] => {
		const row = state.usage.get(id);
		return row ? [theme.fg("dim", `${prefix}${formatUsageRow(theme, row.usage, row.durationMs, row.ttftMs, row.timestamp, row.turnElapsedMs)}`)] : [];
	};
	const lines: string[] = [];
	if (rows.length === 1) {
		const [row] = rows;
		lines.push(` ${theme.format.bullet} ${title} ${row.header}`);
		const body = row.outline ? outlineRows(row.outline, state.expanded, display.collapsedLines, theme) : proseRows(row.prose ?? [], state.expanded, display.collapsedLines, theme);
		for (const line of body) lines.push(`   ${line}`);
		lines.push(...usageLines(row.id, "   "));
	} else {
		lines.push(` ${theme.format.bullet} ${title}${theme.fg("dim", ` (${rows.length})`)}`);
		rows.forEach((row, index) => {
			const last = index === rows.length - 1;
			const connector = last ? theme.tree.last : theme.tree.branch;
			const guide = last ? " ".repeat(visibleWidth(connector)) : `${theme.tree.vertical}${" ".repeat(Math.max(0, visibleWidth(connector) - visibleWidth(theme.tree.vertical)))}`;
			lines.push(`   ${theme.fg("dim", connector)} ${row.header}`);
			const body = row.outline ? outlineRows(row.outline, state.expanded, display.collapsedLines, theme) : proseRows(row.prose ?? [], state.expanded, display.collapsedLines, theme);
			for (const line of body) lines.push(`   ${theme.fg("dim", guide)} ${line}`);
			lines.push(...usageLines(row.id, `   ${guide} `));
		});
	}
	return lines.map(line => fitCollapseLine(line, width));
}

type CardTakeover = {
	active: () => boolean;
	display: ToolDisplayState;
	summary?: (language: string, code: string) => string | undefined;
};

// LSP diagnostics ride along in edit/write details (top level, in `meta`, or per file). The
// edit outline draws its own; any other hydemods view would drop them, so those results keep
// the native card and its diagnostics tree.
function carriesDiagnostics(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const record = details as { diagnostics?: unknown; meta?: { diagnostics?: unknown }; perFileResults?: unknown[] };
	if (record.diagnostics || record.meta?.diagnostics) return true;
	return Array.isArray(record.perFileResults) && record.perFileResults.some(carriesDiagnostics);
}

// A todo update is one row: the task that just finished (green, checked), else the one just
// started, else the overall count. The native card's phase-by-phase listing waits for Ctrl+O.
function todoOneLine(details: unknown, theme: Theme): string | undefined {
	const todo = details as { phases?: { tasks: { content: string; status: string }[] }[]; completedTasks?: { content: string }[] } | undefined;
	if (!todo || !Array.isArray(todo.phases)) return undefined;
	const done = todo.completedTasks ?? [];
	if (done.length > 0) return `${green(`☑ ${done[0].content}`)}${done.length > 1 ? theme.fg("muted", ` +${done.length - 1}`) : ""}`;
	const tasks = todo.phases.flatMap(phase => phase.tasks);
	const active = tasks.find(task => task.status === "in_progress");
	if (active) return theme.fg("accent", `☐ ${active.content}`);
	const finished = tasks.filter(task => task.status === "completed").length;
	return theme.fg("muted", `${finished}/${tasks.length} done`);
}

// Source a shell command printed (`sed -n`, `cat`, `grep -n`) gets the treatment a read gets: the
// line-number gutter is dropped, comments go, and where the command names the file, the text
// folds into its declaration outline. Output that is not numbered and names no file stays plain.
function bashSourceStructured(args: unknown, text: string, ast: boolean): StructuredText | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	const path = typeof command === "string" ? commandSourcePath(command) : undefined;
	const cleaned = stripGeneratedNoticeFooter(sanitizeTerminalText(text).replace(/\r\n/g, "\n")).replace(/\n+Wall time: [^\n]*\s*$/, "");
	const numbering = typeof command === "string" && printsLineNumbers(command);
	// Rows that all begin `path:line:` (grep -rn, or any tool printing that shape) group under one header per file.
	const grouped = groupGrepPrefixes(cleaned);
	if (grouped.grouped) return { text: grouped.text.replace(/^\n+|\s+$/g, ""), format: "code" };
	const stripped = stripLineNumbers(cleaned, numbering ? 1 : undefined);
	if (!path && !stripped.numbered) return undefined;
	const ext = path ? extensionOf(path) : undefined;
	const code = stripComments(stripped.text, ext).replace(/^\n+|\s+$/g, "");
	if (!code) return undefined;
	if (path && ast) {
		const outline = memoOutline(`bash:${path}:${Bun.hash(code)}`, code, path);
		if (outline && outline.declarations.length > 0) {
			return { text: renderOutline(outline, displayPath(path)).join("\n"), format: "outline", lang: outline.language, path };
		}
	}
	const compact = isBraceLanguage(ext) ? compactBlocks(code, { singleQuotes: ext !== "rs" && ext !== "go" }) : joinLoneClosers(code);
	return { text: compact.split("\n").filter(row => row.trim() !== "").join("\n"), format: "code", lang: ext };
}

// The hydemods view of one settled result, or undefined when the native renderer should draw it:
// takeover off, still streaming, plain text hydemods cannot improve, a JSON document OMP already
// shows as a tree, or a payload past the size cap. Failures get the same card in error colour
// rather than a different one.

// Eval envelopes are data, never executable source.
function evalStructuredValue(value: unknown): StructuredText {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const envelope = value as { text?: unknown; details?: ReadOutlineDetails; hasError?: boolean };
		if (typeof envelope.text === "string" && !envelope.hasError) {
			const source = envelope.details && readSourceFsPath(envelope.details as Parameters<typeof readSourceFsPath>[0]);
			const result = { content: [{ type: "text", text: envelope.text }], details: envelope.details };
			const outline = source && readOutlineStructured(result, { path: source });
			if (outline) return outline;
			if (Object.keys(value).every(key => key === "text")) return evalStructuredValue(envelope.text);
			if (envelope.details && typeof (envelope.details as { displayContent?: unknown }).displayContent === "string") {
				const grep = grepOutlineStructured(result);
				if (grep) return grep;
			}
		}
	}
	if (typeof value === "string") {
		const raw = sanitizeTerminalText(value);
		if (/^\s*\*\d+[:│]|^#{1,3} .+/m.test(raw)) {
			const grep = grepOutlineStructured({ content: [{ type: "text", text: raw }] });
			if (grep) return grep;
		}
		const blocks = raw.split(/(?=^\[[^\]\r\n]+#[\da-f]{4}\]\r?$)/im);
		let changed = false;
		const rendered = blocks.map(block => {
			const header = /^\[([^\]\r\n]+)#[\da-f]{4}\]\r?\n/i.exec(block);
			if (!header) return block;
			const lines = block.slice(header[0].length).split(/\r?\n/);
			const numbers: Array<number | null> = [];
			const sourceLines: string[] = [];
			let at = 0;
			for (; at < lines.length; at++) {
				const row = /^(\d+):(.*)$/.exec(lines[at]);
				if (row) { numbers.push(Number(row[1])); sourceLines.push(row[2]); }
				else if (/^\s*…\s*$/.test(lines[at])) { numbers.push(null); sourceLines.push("…"); }
				else break;
			}
			if (!numbers.some(n => n !== null)) return block;
			const outline = readOutlineStructured({
				content: [], details: {
					resolvedPath: header[1], truncation: { truncated: true },
					displayContent: { text: sourceLines.join("\n"), startLine: numbers.find(n => n !== null), lineNumbers: numbers },
				}
			}, { path: header[1] });
			if (!outline) return block;
			changed = true;
			return outline.text + "\n" + lines.slice(at).join("\n");
		});
		if (changed) return { text: rendered.join(""), format: "outline" };
	}
	return structuredResult(value);
}

function formatEvalText(value: unknown, theme: Theme): string {
	const structured = evalStructuredValue(value);
	return structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
}

// Archive listings are rendered as data cards; the prose around them keeps its normal treatment.
function formatEvalArchiveText(raw: string, theme: Theme): string | undefined {
	const segments = splitArchiveOutput(sanitizeTerminalText(raw));
	if (!segments.some(segment => segment.kind === "archive")) return undefined;
	return segments.map(segment => {
		if (segment.kind === "prose") return segment.text ? formatEvalText(segment.text, theme) : "";
		const structured = formatJsonOutput(segment.value);
		const card = structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
		return segment.text.endsWith("\n") ? card + "\n" : card;
	}).join("");
}

function formatEvalPrintedOutput(text: string, theme: Theme): string {
	const cleaned = stripGeneratedNoticeFooter(text);
	if (cappedRenderPayload(cleaned) === undefined) return cleaned;
	return decodeEvalOutput(cleaned).map(part => {
		try {
			if ("value" in part) return formatEvalText(part.value, theme);
			return formatEvalArchiveText(part.raw, theme) ?? formatEvalText(part.raw, theme);
		} catch {
			// Malformed tool metadata must not prevent the original output from being read.
			return sanitizeTerminalText(part.raw);
		}
	}).join("");
}

type EvalViewArgs = { code?: string; language?: string; title?: string; cells?: EvalViewArgs[] };
type EvalViewResult = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };

function evalViewArgs(args: unknown, takeover: CardTakeover, expanded = false): unknown {
	if (!args || typeof args !== "object") return args;
	const input = args as EvalViewArgs;
	const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
	const summarize = (cell: EvalViewArgs) => {
		const code = typeof cell.code === "string" && !expanded && cappedRenderPayload(cell.code) !== undefined
			? collapseTextLines(cell.code.split(/\r?\n/), limit, false, { marker: "[...]" }).join("\n")
			: cell.code;
		return {
			...cell,
			...(code !== undefined ? { code } : {}),
			title: typeof cell.code === "string" ? takeover.summary?.(cell.language ?? "python", cell.code) ?? cell.title : cell.title,
		};
	};
	return input.cells ? { ...input, cells: input.cells.map(summarize) } : summarize(input);
}

// Freeze settled outlines against their returned snapshot, not later disk contents.
const evalViewOutputs = new WeakMap<object, { cells?: string[]; output?: string; json?: string }>();
function evalViewResult(result: EvalViewResult, partial: boolean, theme: Theme, takeover: CardTakeover): EvalViewResult {
	const details = (result.details ?? {}) as { cells?: Array<EvalViewArgs & { output: string; textOutput?: string; hasMarkdown?: boolean; status?: string }>; jsonOutputs?: unknown[] };
	if (details.jsonOutputs?.some(value => cappedRenderPayload(value) === undefined)) return result;
	let formatted = partial ? undefined : evalViewOutputs.get(result);
	if (!partial && !formatted) {
		const json = details.jsonOutputs?.map(value => {
			try {
				const structured = evalStructuredValue(value);
				return structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
			} catch {
				return sanitizeTerminalText(JSON.stringify(value, null, 2) ?? String(value));
			}
		}).join("\n\n");
		formatted = {
			cells: details.cells?.map(cell => {
				const sourceOutput = details.jsonOutputs?.length && cell.textOutput !== undefined ? cell.textOutput : cell.output;
				return cell.hasMarkdown ? sourceOutput : formatEvalPrintedOutput(sourceOutput, theme);
			}),
			output: details.cells?.length ? undefined : formatEvalPrintedOutput(toolResultText(result.content) ?? "", theme),
			json,
		};
		evalViewOutputs.set(result, formatted);
	}
	const cells = details.cells?.map((cell, index) => {
		const summary = takeover.summary?.(cell.language ?? "python", cell.code ?? "");
		const extra = index === details.cells!.length - 1 ? formatted?.json : undefined;
		const baseOutput = formatted?.cells?.[index] ?? (details.jsonOutputs?.length && cell.textOutput !== undefined ? cell.textOutput : cell.output);
		const combinedOutput = [baseOutput, extra].filter(Boolean).join("\n\n");
		return {
			...cell, title: summary ?? cell.title,
			output: combinedOutput,
			...(cell.textOutput !== undefined ? { textOutput: combinedOutput } : {}),
		};
	});
	const output = formatted && !cells?.length ? [formatted.output, formatted.json].filter(Boolean).join("\n\n") : undefined;
	return {
		...result,
		content: output === undefined ? result.content : [
			{ type: "text", text: output },
			...(Array.isArray(result.content) ? result.content.filter(item => item.type !== "text") : []),
		],
		details: { ...details, ...(cells ? { cells } : {}), ...(formatted ? { jsonOutputs: [] } : {}) },
	};
}

type EvalArchiveCell = EvalViewArgs & { output: string; textOutput?: string; hasMarkdown?: boolean; status?: string; exitCode?: number; durationMs?: number; statusEvents?: Array<Record<string, unknown>>; statusEventsElided?: number };

// A settled, successful Eval whose printed output holds archive listings becomes one hydemods card
// (code, archive data, prose, status, foot) in place of the native cell box. Failed, partial or
// oversized results return undefined and keep the native box, so errors stay as the host draws them.
function evalArchiveCard(result: EvalViewResult, partial: boolean, expanded: boolean, takeover: CardTakeover): string | undefined {
	if (partial || result.isError || !takeover.active()) return undefined;
	const details = (result.details ?? {}) as { cells?: EvalArchiveCell[]; jsonOutputs?: unknown[] };
	const cells = details.cells;
	if (!cells?.length || details.jsonOutputs?.some(value => cappedRenderPayload(value) === undefined)) return undefined;
	if (cells.some(cell => (cell.status !== undefined && cell.status !== "complete") || (cell.exitCode !== undefined && cell.exitCode !== 0) || cell.hasMarkdown)) return undefined;
	const outputs = cells.map(cell => cell.textOutput ?? cell.output);
	if (outputs.some(output => cappedRenderPayload(output) === undefined)) return undefined;
	const split = outputs.map(output => splitArchiveOutput(sanitizeTerminalText(output)));
	if (!split.some(segments => segments.some(segment => segment.kind === "archive"))) return undefined;
	const rows: string[] = [];
	cells.forEach((cell, index) => {
		const code = cell.code ?? "";
		rows.push(`eval: ${takeover.summary?.(cell.language ?? "python", code) ?? cell.title ?? code.split("\n")[0]}`);
		if (expanded && code) rows.push("code:", ...code.split("\n").map(line => `  ${sanitizeTerminalText(line)}`));
		for (const segment of split[index]) {
			const body = segment.kind === "archive" ? formatJsonOutput(segment.value).text : segment.text;
			rows.push(...body.replace(/\s+$/, "").split("\n").filter(line => line.trim() !== ""));
		}
		const hidden = cell.statusEventsElided ?? 0;
		if (hidden > 0) rows.push(`status: ${hidden} earlier`);
		for (const event of cell.statusEvents ?? []) {
			const fields = Object.entries(event).filter(([key, value]) => key !== "op" && key !== "resolvedThinkingLevel" && ["string", "number", "boolean"].includes(typeof value));
			rows.push(`status: ${sanitizeTerminalText(String(event.op ?? "event"))}${fields.map(([key, value]) => ` ${key}=${sanitizeTerminalText(String(value))}`).join("")}`);
		}
		rows.push(`foot: done${cell.exitCode === undefined ? "" : ` · exit ${cell.exitCode}`}${cell.durationMs === undefined ? "" : ` · ${cell.durationMs} ms`}`);
	});
	for (const value of details.jsonOutputs ?? []) rows.push(...formatJsonOutput(value).text.split("\n"));
	return rows.join("\n");
}
function hydemodsResultComponent(toolName: string, result: { content: unknown; details?: unknown; isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, args: unknown, takeover: CardTakeover) {
	if (!takeover.active()) return undefined;
	// Background-job wait: one status line collapsed; the full snapshot stays in the model result and on Ctrl+O.
	if (toolName === "wait") {
		const intent = typeof (args as { i?: unknown } | undefined)?.i === "string" ? (args as { i: string }).i : undefined;
		const line = waitStatusLine(result, { ...options, intent }, theme);
		return line === undefined ? undefined : new Text(line, 0, 0);
	}
	if (options.isPartial) return undefined;
	// A rejected edit is routine (stale anchor, retry follows): one line, full text on Ctrl+O.
	if (toolName === "edit" && result.isError && !options.expanded) {
		const message = toolResultText(result.content)?.trim() ?? "";
		const reason = message.split(/\n|(?<=\.)\s/)[0] ?? "edit rejected";
		return new Text(`${theme.fg("error", "edit rejected:")} ${theme.fg("muted", reason)} ${theme.fg("dim", "(Ctrl+O)")}`, 0, 0);
	}
	if (toolName === "todo" && !result.isError && !options.expanded) {
		const line = todoOneLine(result.details, theme);
		if (line) {
			const details: ToolCardDetails = { toolName, result: line, isError: false, cwd: process.cwd() };
			return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: false }, theme, takeover.display, { text: line, format: "command" });
		}
	}
	const astOn = astOutlines();
	const outline = !astOn ? undefined : toolName === "read" ? readOutlineStructured(result, args) : toolName === "edit" ? editOutlineStructured(result) : toolName === "write" ? writeOutlineStructured(result, args) : toolName === "grep" ? grepOutlineStructured(result) : undefined;
	if (!outline && carriesDiagnostics(result.details)) return undefined;
	if (outline) {
		const details: ToolCardDetails = { toolName, result: outline.text, isError: false, cwd: process.cwd() };
		return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, outline);
	}
	// An edit that cannot be outlined is better shown as OMP's diff than as a file excerpt.
	if (toolName === "edit") return undefined;
	const resultText = toolResultText(result.content);
	// A shell command handed to the background: its eventual output arrives as its own message.
	if (toolName === "bash" && resultText && /^Backgrounded (early|as job)/.test(resultText)) {
		const job = /\bbg_\d+\b/.exec(resultText)?.[0];
		return new Text(theme.fg("muted", `↳ backgrounded${job ? ` as ${job}` : ""}; output follows when it finishes`), 0, 0);
	}
	if (toolName === "bash" && !result.isError && resultText) {
		const summary = testSummaryLine(sanitizeTerminalText(resultText), theme);
		if (summary) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName, result: summary, isError: false, cwd: process.cwd() } }, { expanded: options.expanded }, theme, takeover.display, { text: summary, format: "command" });
		const source = bashSourceStructured(args, resultText, astOn);
		if (source) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName, result: source.text, isError: false, cwd: process.cwd() } }, { expanded: options.expanded }, theme, takeover.display, source);
	}
	if (!result.isError && nativeRendersJsonTree(toolName, args, resultText)) return undefined;
	// Huge results keep the native card: hydemods would re-parse, colour and Markdown-render
	// the whole payload on every repaint, and the native card already limits what it draws.
	if (resultText !== undefined && cappedRenderPayload(resultText) === undefined) return undefined;
	const payload = notebookPayload(toolName, args, result.isError) ?? extractToolPayload({ toolName, result });
	if (cappedRenderPayload(payload) === undefined) return undefined;
	const details: ToolCardDetails = { toolName, result: payload, isError: result.isError, cwd: process.cwd() };
	const structured = structureToolResult(details);
	// Plain shell text still carries a Wall-time footer worth lifting into a heading.
	if (structured.format === "text" && toolName === "bash") {
		const command = formatCommandText(structured.text);
		if (command) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, command);
	}
	return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, structured);
}

// Draw hydemods results inside OMP's own tool card instead of beside it. Every bespoke
// renderer is wrapped so its result view defers to hydemods when hydemods applies; tools that
// fall to OMP's generic card keep it, except the ones listed in EXTRA_CARD_TOOLS. Because the
// native component owns the card, Ctrl+O expansion and hidden tool output apply unchanged.
const EXTRA_CARD_TOOLS = ["context_notes", "wait"];
// Tools whose native card is already the better view; hydemods never replaces these.
const NATIVE_CARD_TOOLS: Record<string, true> = { find: true };

function installNativeCardTakeover(takeover: CardTakeover): void {
	for (const [name, original] of Object.entries(toolRenderers)) {
		if (NATIVE_CARD_TOOLS[name]) continue;
		const wrapped: ToolRenderer = {
			...original,
			renderCall(args, options, theme) {
				const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
				return original.renderCall(name === "eval" && takeover.active() ? evalViewArgs(args, takeover, expanded) : args, options, theme);
			},
			renderResult(result, options, theme, args) {
				if (name === "eval") {
					const archiveExpanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const archiveCard = evalArchiveCard(result, options.isPartial, archiveExpanded, takeover);
					if (archiveCard !== undefined) {
						const card = toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName: "eval", result: archiveCard, isError: false, cwd: process.cwd() } }, { expanded: archiveExpanded }, theme, takeover.display, { text: archiveCard, format: "toon" });
						return linkComponentRows(card, pathLinksFor);
					}
					const context = (options as { renderContext?: { expanded?: boolean; output?: string } }).renderContext;
					const nativeOptions = {
						...options, renderContext: {
							...(options as { renderContext?: object }).renderContext,
							previewLines: takeover.display.collapsedLines,
						}
					};
					const active = takeover.active();
					const formatted = active ? evalViewResult(result, options.isPartial, theme, takeover) : result;
					const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const callArgs = active ? evalViewArgs(args, takeover, expanded) : args;
					const base = original.renderResult(formatted, nativeOptions, theme, callArgs);
					if (!active || !base) return base;
					let cachedWidth = -1;
					let cachedLimit = -1;
					let component = base;
					return Object.assign(Object.create(base), {
						render(width: number): readonly string[] {
							const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
							if (width !== cachedWidth || limit !== cachedLimit) {
								cachedWidth = width;
								cachedLimit = limit;
								component = original.renderResult(compactEvalResult(formatted, { expanded, limit, width, theme, output: context?.output }), { ...nativeOptions, renderContext: { ...nativeOptions.renderContext, output: undefined } }, theme, callArgs) ?? base;
							}
							return component.render(width);
						},
						invalidate() { cachedWidth = -1; component.invalidate?.(); },
					});
				}
				if (name === "task") {
					const taskCard = renderTaskToolCard(result, options, theme);
					if (taskCard) return taskCard;
				}
				const card = hydemodsResultComponent(name, result, options, theme, args, takeover);
				return card ? linkComponentRows(card, pathLinksFor) : original.renderResult(result, options, theme, args);
			},
		};
		if (original.describeCall) wrapped.describeCall = (args, options) => {
			const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
			return original.describeCall!(name === "eval" && takeover.active() ? evalViewArgs(args, takeover, expanded) : args, options);
		};
		if (original.describeResult) {
			wrapped.describeResult = (result, options, args) => {
				if (name === "eval") {
					const archiveExpanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const archiveCard = evalArchiveCard(result, options.isPartial, archiveExpanded, takeover);
					if (archiveCard !== undefined) return {
						...original.describeResult!(result, options, evalViewArgs(args, takeover)),
						body: [codeNode(archiveCard, { lang: "yaml" })],
						preview: { lines: takeover.display.collapsedLines },
					};
					const active = takeover.active();
					const context = (options as { renderContext?: { expanded?: boolean; output?: string } }).renderContext;
					const expanded = context?.expanded ?? options.expanded;
					const formatted = active ? evalViewResult(result, options.isPartial, uiTheme, takeover) : result;
					const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
					return original.describeResult!(
						active ? compactEvalResult(formatted, { expanded, limit, theme: uiTheme, output: context?.output }) : result,
						{ ...options, renderContext: { ...context, ...(active ? { output: undefined } : {}), previewLines: takeover.display.collapsedLines } },
						active ? evalViewArgs(args, takeover, expanded) : args,
					);
				}
				if (takeover.active() && !options.isPartial) {
					const resultText = toolResultText(result.content);
					if (resultText !== undefined && cappedRenderPayload(resultText) !== undefined) {
						const payload = notebookPayload(name, args, result.isError) ?? extractToolPayload({ toolName: name, result });
						if (cappedRenderPayload(payload) !== undefined) {
							const structured = structureToolResult({ toolName: name, result: payload, isError: result.isError, cwd: process.cwd() });
							if (structured.format === "toon") return {
								...original.describeResult!(result, options, args),
								body: [codeNode(structured.text, { lang: "yaml" })],
								preview: { lines: takeover.display.collapsedLines },
							};
						}
					}
				}
				return original.describeResult!(result, options, args);
			};
		}
		toolRenderers[name] = wrapped;
	}
	for (const name of EXTRA_CARD_TOOLS) {
		if (name in toolRenderers) continue;
		const fallback = (args: unknown, result: { content: unknown; isError?: boolean } | undefined, options: { expanded: boolean; isPartial: boolean }, theme: Theme) =>
			renderFallbackToolCard({
				label: name,
				args,
				result: result ? { output: toolResultText(result.content) ?? "", isError: result.isError } : undefined,
				options,
			}, theme);
		toolRenderers[name] = {
			mergeCallAndResult: true,
			renderCall: (args, options, theme) => fallback(args, undefined, options, theme),
			renderResult: (result, options, theme, args) => {
				const card = hydemodsResultComponent(name, result, options, theme, args, takeover);
				return card ? linkComponentRows(card, pathLinksFor) : fallback(args, result, options, theme);
			},
		};
	}
}

const COLLAPSED_LINE_PRESETS = [1, 3, 4, 5, 10];

// The collapsed-lines control is a row in the panel's selection order (after the tweaks); it is
// distinguished from tweaks by identity rather than by a tweak-shaped stub.
const COLLAPSED_LINES_ROW = Symbol("collapsed-lines");

function panelComponent(theme: ThemeLike, done: (result: undefined) => void, display: ToolDisplayState, onToggle?: () => void) {
	type PanelRow = Tweak | typeof COLLAPSED_LINES_ROW;
	const selectable: PanelRow[] = [...TWEAKS, COLLAPSED_LINES_ROW];
	const body = new Box(2, 1);
	const content = new Text();
	let selectedIndex = 0;

	const collapsedLinesRow = (selected: boolean): string[] => {
		const marker = selected ? theme.fg("accent", "❯") : " ";
		const options = COLLAPSED_LINE_PRESETS.map(preset => preset === display.collapsedLines
			? theme.fg("accent", theme.bold(`[${preset}]`))
			: theme.fg("muted", ` ${preset} `));
		const custom = COLLAPSED_LINE_PRESETS.includes(display.collapsedLines) ? "" : theme.fg("accent", theme.bold(`[${display.collapsedLines}]`));
		const chooser = [...options, custom].filter(Boolean).join(theme.fg("muted", "·"));
		return [
			` ${marker} ${chooser}  ${theme.bold("Collapsed card lines")}`,
			theme.fg("muted", "           Content rows per collapsed card; [...] marks truncation inline."),
			"           ←/→ pick a preset; +/- step by one; also /collapsed collapsed-lines N.",
		];
	};

	const paint = () => {
		const lines: string[] = [
			theme.fg("accent", theme.bold("COLLAPSED")),
			theme.fg("muted", "Toggles persist globally in settings.yaml, not per session"),
			"",
		];

		for (const tweak of TWEAKS) {
			const selected = selectable[selectedIndex] === tweak;
			const marker = selected ? theme.fg("accent", "❯") : " ";
			const state = readSetting(tweak.setting) ? theme.fg("success", "● enabled") : theme.fg("muted", "○ disabled");
			lines.push(` ${marker} ${state}  ${theme.bold(tweak.title)}`);
			lines.push(theme.fg("muted", `           ${tweak.description}`));
			lines.push(`           ${tweak.render()}`);
		}
		lines.push(...collapsedLinesRow(selectable[selectedIndex] === COLLAPSED_LINES_ROW));
		lines.push("");
		lines.push(theme.fg("border", "────────────────────────────────────────"));
		lines.push(theme.fg("muted", "↑/↓ or j/k select  ·  Space/Enter toggle  ·  ←/→ collapsed-lines preset  ·  +/- collapsed lines  ·  Esc/q close"));
		content.setText(lines.join("\n"));
		body.invalidate();
	};

	const moveSelection = (delta: number) => {
		selectedIndex = (selectedIndex + delta + selectable.length) % selectable.length;
		paint();
	};

	const setCollapsedLines = (next: number) => {
		if (next < 1 || next === display.collapsedLines) return;
		display.collapsedLines = next;
		collapsedLinesSetting.set(settings, next);
		paint();
		onToggle?.();
	};

	// Presets in order; a custom value steps to the next preset above it (or wraps).
	const cyclePreset = (direction: 1 | -1) => {
		const current = COLLAPSED_LINE_PRESETS.indexOf(display.collapsedLines);
		if (current >= 0) {
			setCollapsedLines(COLLAPSED_LINE_PRESETS[(current + direction + COLLAPSED_LINE_PRESETS.length) % COLLAPSED_LINE_PRESETS.length]);
			return;
		}
		const above = COLLAPSED_LINE_PRESETS.find(preset => preset > display.collapsedLines);
		const below = [...COLLAPSED_LINE_PRESETS].reverse().find(preset => preset < display.collapsedLines);
		setCollapsedLines((direction === 1 ? above ?? COLLAPSED_LINE_PRESETS[0] : below ?? COLLAPSED_LINE_PRESETS[COLLAPSED_LINE_PRESETS.length - 1]));
	};

	const toggleSelected = () => {
		const row = selectable[selectedIndex];
		if (row === COLLAPSED_LINES_ROW) {
			cyclePreset(1);
			return;
		}
		if (!row) return;
		row.setting.set(settings, !readSetting(row.setting));
		paint();
		onToggle?.();
	};

	body.addChild(content);
	paint();

	return {
		render(width: number): readonly string[] {
			return body.render(width).map((line) => truncateToWidth(line, width));
		},
		invalidate() {
			body.invalidate();
		},
		handleInput(data: string) {
			if (data === "\u001b" || data === "q" || data === "Q") {
				done(undefined);
				return;
			}
			if (data === "\u001b[A" || data === "k" || data === "K") {
				moveSelection(-1);
				return;
			}
			if (data === "\u001b[B" || data === "j" || data === "J") {
				moveSelection(1);
				return;
			}
			if (data === "\u001b[C" || data === "l" || data === "L") {
				cyclePreset(1);
				return;
			}
			if (data === "\u001b[D" || data === "h" || data === "H") {
				cyclePreset(-1);
				return;
			}
			if (data === "+" || data === "=") {
				setCollapsedLines(display.collapsedLines + 1);
				return;
			}
			if (data === "-" || data === "_") {
				setCollapsedLines(display.collapsedLines - 1);
				return;
			}
			if (data === " " || data === "\r" || data === "\n") toggleSelected();
		},
	};
}

/* -------------------------------------------------------------------------- */
/*                               Extension Entry                              */
/* -------------------------------------------------------------------------- */

export default function collapsed(pi: ExtensionAPI): void {
	const display: ToolDisplayState = { collapsedLines: readSetting(collapsedLinesSetting), cardsOn: true };
	const repaintToolCards = (ctx: ExtensionContext) => {
		// ExtensionUIContext exposes no repaint call, and no other extension-visible setter
		// invalidates drawn tool blocks; the interactive host's setToolsExpanded ends in
		// ui.requestRender(true), so re-setting the current value is the supported way to repaint
		// them. Needed when a toggle changes which renderer applies: with the takeover off,
		// hydemodsResultComponent falls back to the host renderer on the next paint.
		if (ctx.hasUI) ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
	};
	let lastCtx: ExtensionContext | undefined;
	// Untagged fences and file paths in the assistant and user messages. The prototypes are wrapped
	// once a session exists (the live theme is not initialized when the extension loads).
	let transcriptRowsInstalled = false;
	const ensureTranscriptRows = () => {
		if (transcriptRowsInstalled) return;
		transcriptRowsInstalled = true;
		const theme = uiTheme as unknown as { getBgHex(color: string): string; getColorMode(): ColorMode };
		const tints = new Map<string, string>();
		const plainTint = (): string => {
			const hex = isLightHex(theme.getBgHex("userMessageBg")) ? "#e8ecf1" : "#1f252d";
			const mode = theme.getColorMode();
			const key = `${mode}${hex}`;
			let tint = tints.get(key);
			if (!tint) {
				tint = backgroundAnsi(hex, mode);
				tints.set(key, tint);
			}
			return tint;
		};
		const linkPaths = (rows: readonly string[]): readonly string[] => {
			const resolver = pathLinksFor();
			return resolver ? linkPathRows(rows, resolver) : rows;
		};
		installTranscriptRows(AssistantMessageComponent.prototype, (rows, width) =>
			linkPaths(isTweakEnabled("plain-code-blocks") ? stylePlainBlocks(rows, width, plainTint(), visibleWidth) : rows));
		installTranscriptRows(UserMessageComponent.prototype, linkPaths);
	};
	const toolRuns = installToolRuns(ToolExecutionComponent.prototype as unknown as RunCard, {
		headRow: (rows, width) => truncateToWidth(rows.find(row => /\S/.test(row.replace(/\x1b\[[0-9;]*m/g, ""))) ?? "", width),
		requestRender: () => { if (lastCtx) repaintToolCards(lastCtx); },
	});
	const restoreToolDisplay = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		ensureTranscriptRows();
		display.collapsedLines = readSetting(collapsedLinesSetting);
		repaintToolCards(ctx);
	};
	watchSetting(collapsedLinesSetting, value => {
		display.collapsedLines = value;
		if (lastCtx) repaintToolCards(lastCtx);
	});

	// omp-collapsed draws inside OMP's tool card (never beside it). One native card per call; Ctrl+O
	// expansion and hidden tool output apply to it as usual. The hotkey below toggles whether
	// omp-collapsed or the original renderer fills the result view for the session.
	const evalSummaries = new EvalSummaryCache();
	const takeover: CardTakeover = {
		display, active: () => display.cardsOn && isTweakEnabled("integrated-tool-expansion"),
		summary: (language, code) => {
			if (!lastCtx || !lastCtx.hasUI || !isTweakEnabled("eval-command-summaries")) return;
			evalSummaries.request(language, code, lastCtx, () => { if (lastCtx) repaintToolCards(lastCtx); });
			return evalSummaries.get(language, code);
		},
	};
	installNativeCardTakeover(takeover);
	installReadGroupTakeover(takeover);

	// Tool rows: one line per call, or one per burst, written by a local model.
	// Shared by every instance in the process: a task subagent records its own calls here,
	// so the UI session's rows can name them and show their intents when the subagent is focused.
	const callsKey = Symbol.for("hydemods.toolRows.calls");
	const liveCalls: Map<string, { name: string; args: unknown }> = ((globalThis as Record<symbol, unknown>)[callsKey] ??= new Map()) as Map<string, { name: string; args: unknown }>;
	let scannedEntries = -1;
	const lookupCall = (id: string) => {
		const known = liveCalls.get(id);
		if (known || !lastCtx) return known;
		const entries = lastCtx.sessionManager.getEntries();
		if (entries.length === scannedEntries) return undefined;
		scannedEntries = entries.length;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") liveCalls.set(block.id, { name: block.name, args: block.arguments });
			}
		}
		return liveCalls.get(id);
	};
	const localLine: Complete = async (system, prompt, signal) => {
		const model = lastCtx?.modelRegistry.find("local", readSetting(toolRowsModelSetting).trim());
		if (!model) return undefined;
		// A run summary has one line per distinct tool; a call line is one phrase.
		const maxTokens = system === RunSystemPrompt ? 240 : 40;
		const response = await completeSimple(model, { systemPrompt: [system], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal, maxTokens });
		if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
		return response.content.map(block => (block.type === "text" ? block.text : "")).join("");
	};
	let rowsJudge: { ctx: ExtensionContext; judge: Judge } | undefined;
	// The personal vault, then a project vault in the working folder, as llm-wiki keeps them.
	const wikiIndex = new WikiIndex(() => [resolve(homedir(), ".llm-wiki/meta/registry.json"), resolve(lastCtx?.cwd ?? process.cwd(), ".llm-wiki/meta/registry.json")]);
	const toolRows = new ToolRows({
		mode: () => readSetting(toolRowsSetting),
		expanded: () => (lastCtx?.hasUI ? lastCtx.ui.getToolsExpanded() : false),
		pills: () => readSetting(toolPillsSetting),
		knows: subject => readSetting(wikiBadgesSetting) && wikiIndex.knows(subject),
		theme: () => uiTheme,
		complete: localLine,
		repaint: () => { if (lastCtx) repaintToolCards(lastCtx); },
		readEntries: group => readGroupStates.get(group)?.entries,
		lookupCall,
		// One judge request per burst of calls with intents, billed to the session.
		judge: () => {
			if (!lastCtx) return undefined;
			if (rowsJudge?.ctx !== lastCtx) rowsJudge = { ctx: lastCtx, judge: resolveJudge({ settings: hostSettings, registry: lastCtx.modelRegistry, sessionModel: lastCtx.model, purpose: "omp_collapsed_tool_rows", onUsage: journalJudgmentUsage(lastCtx.sessionManager) }) };
			return rowsJudge.judge;
		},
	});
	let uninstallToolRows: (() => void) | undefined;
	watchSetting(toolRowsSetting, () => toolRows.refresh());
	watchSetting(toolRowsModelSetting, () => toolRows.reset());
	watchSetting(toolPillsSetting, () => toolRows.refresh());
	watchSetting(wikiBadgesSetting, () => toolRows.refresh());
	pi.on("tool_execution_start", event => {
		// OMP moves the agent's `i` out of the args into `intent` before the call runs.
		const args = event.intent && event.args && typeof event.args === "object" ? { ...event.args, i: event.intent } : event.args;
		liveCalls.set(event.toolCallId, { name: event.toolName, args });
		toolRows.noteCall(event.toolCallId);
	});
	// When the tool cards are active, OMP's inline read previews are redundant and clash with the
	// read cards. Override it off while active; clear override when off.
	const syncReadPreviewMapping = () => {
		if (!isSettingsInitialized()) return;
		if (takeover.active()) {
			cfgReadToolResultPreview.override(hostSettings, false);
		} else {
			cfgReadToolResultPreview.clearOverride(hostSettings);
		}
	};
	syncReadPreviewMapping();
	const cardsTweak = TWEAKS.find((tweak) => tweak.name === "integrated-tool-expansion");
	if (cardsTweak) watchSetting(cardsTweak.setting, () => syncReadPreviewMapping());

	const toggleCards = (ctx: ExtensionContext) => {
		display.cardsOn = !display.cardsOn;
		syncReadPreviewMapping();
		repaintToolCards(ctx);
		if (ctx.hasUI) ctx.ui.notify(`omp-collapsed cards ${display.cardsOn ? "on" : "off"}`, "info");
	};
	pi.registerShortcut("ctrl+shift+t", { description: "Toggle omp-collapsed tool cards", handler: toggleCards });
	const cycleToolRows = (ctx: ExtensionContext) => {
		if (!isSettingsInitialized()) return;
		const current = readSetting(toolRowsSetting);
		const next = TOOL_ROWS_MODES[(TOOL_ROWS_MODES.indexOf(current) + 1) % TOOL_ROWS_MODES.length];
		toolRowsSetting.set(settings, next);
		// Redraw now rather than on the settings watcher, which is a no-op when it was set up before settings loaded.
		lastCtx = ctx;
		toolRows.refresh();
		repaintToolCards(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Tool rows: ${TOOL_ROWS_MODES.map((mode) => (mode === next ? `[${mode}]` : mode)).join(" · ")}`, "info");
	};
	pi.registerShortcut("ctrl+n", { description: "Cycle tool rows (cards → ast → lines → group)", handler: cycleToolRows });

	// Sessions saved before the takeover carry a card message per tool call; the native
	// card now shows that content, so those messages render as nothing.
	pi.registerMessageRenderer("integrated-tool-expansion", () => ({ render: () => [], invalidate() { } }));

	/* ------------------------- TOON for the model ------------------------- */

	// The model reads JSON tool results as TOON; the persisted result and every card keep the
	// original JSON. Encoded per call id and re-used until the result text changes (pruning).
	const toonByCallId = new Map<string, { source: string; toon: string | undefined }>();
	const TOON_CACHE_LIMIT = 2000;

	pi.on("context", (event) => {
		if (!isTweakEnabled("tool-results-toon")) return;
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "toolResult" || message.isError) return message;
			const source = toolResultText(message.content);
			if (source === undefined) return message;
			let cached = toonByCallId.get(message.toolCallId);
			if (!cached || cached.source !== source) {
				if (toonByCallId.size >= TOON_CACHE_LIMIT) toonByCallId.clear();
				cached = { source, toon: toonForModel(source) };
				toonByCallId.set(message.toolCallId, cached);
			}
			if (cached.toon === undefined) return message;
			changed = true;
			const images = message.content.filter((block) => block.type !== "text");
			return { ...message, content: [{ type: "text" as const, text: cached.toon }, ...images] };
		});
		return changed ? { messages } : undefined;
	});

	pi.on("message_update", (event) => {
		const { role, content } = event.message as { role?: unknown; content?: unknown };
		if (role === "assistant" && Array.isArray(content) && content.some((b: { type?: string; text?: string }) => b.type === "text" && b.text?.trim())) toolRuns.close();
		if (event.message.role === "assistant") {
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				// OMP strips `i` from a running call's arguments; keep the copy `tool_execution_start` recorded.
				const known = liveCalls.get(block.id)?.args as { i?: unknown } | undefined;
				const args = typeof known?.i === "string" && block.arguments && typeof block.arguments === "object" && !("i" in block.arguments) ? { ...block.arguments, i: known.i } : block.arguments;
				liveCalls.set(block.id, { name: block.name, args });
				toolRows.noteCall(block.id);
			}
		}
	});
	pi.on("agent_start", () => {
		toolRows.setIdle(false);
		toolRuns.setActive(isTweakEnabled("tool-runs"));
	});
	pi.on("agent_end", (_event, ctx) => {
		toolRows.setIdle(true);
		toolRuns.setActive(false);
		repaintToolCards(ctx);
	});
	pi.on("message_start", (event) => {
		if ((event.message as { role?: unknown }).role === "user") toolRuns.close();
	});
	// Large files come back with pruned snapshots, and the card is redrawn long after later
	// edits change the disk. Capture the outline now, while the disk still matches this diff.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError || !event.details || typeof event.details !== "object") return undefined;
		// EditToolDetails is the host's type; this reads the subset it outlines from.
		const details: EditOutlineDetails = event.details;
		if (typeof details.newText === "string" || details.hydemodsOutline !== undefined) return undefined;
		const outline = editOutlineStructured({ content: event.content, details });
		return outline ? { details: { ...event.details, hydemodsOutline: outline.text } } : undefined;
	});

	// One handler per session event. Session switches start from nothing, so tool-row state resets.
	const onSession = (_event: unknown, ctx: ExtensionContext) => {
		evalSummaries.clear();
		liveCalls.clear();
		scannedEntries = -1;
		// Only a session with a UI owns the transcript. A task subagent loads this extension in the same
		// process; installing there would replace the UI session's rows with ones that can't name its calls.
		// session_start fires before OMP replays a resumed transcript, so its blocks still adopt.
		if (ctx.hasUI) uninstallToolRows ??= toolRows.install();
		toolRows.reset();
		toolRows.setIdle(true);
		setSkillNames(pi.getCommands().filter(command => command.source === "skill").map(command => command.name));
		restoreToolDisplay(ctx);
	};
	pi.on("session_start", onSession);
	pi.on("session_switch", onSession);
	pi.on("session_branch", onSession);
	pi.on("session_tree", onSession);
	pi.on("session_shutdown", () => { evalSummaries.clear(); lastCtx = undefined; });

	pi.registerCommand("collapsed", {
		description: "Open the tweak panel or set collapsed-lines N (default 5, saved to settings)",
		handler: async (args, ctx) => {
			const [command, value, ...extra] = args.trim().split(/\s+/);
			if (command) {
				if (command === "collapsed-lines" && value === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Collapsed line limit: ${display.collapsedLines}; default: ${DEFAULT_COLLAPSED_LINES}`, "info");
					return;
				}
				const next = Number(value);
				if (command !== "collapsed-lines" || !value || !/^\d+$/.test(value) || extra.length || !Number.isInteger(next) || next < 1) {
					if (ctx.hasUI) ctx.ui.notify("Use /collapsed collapsed-lines N, where N is a positive whole number.", "warning");
					return;
				}
				collapsedLinesSetting.set(settings, next);
				display.collapsedLines = next;
				repaintToolCards(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Collapsed line limit set to ${next}; saved to settings.`, "info");
				return;
			}
			// Setting collapsed-lines works headless; only opening the panel needs the UI.
			if (!ctx.hasUI) return;
			await ctx.ui.custom(
				(_tui, theme, keybindings, done) => {
					const component = panelComponent(theme, done, display, () => syncReadPreviewMapping());
					return {
						...component,
						handleInput(data: string) {
							if (keybindings.matches(data, "app.interrupt") || data === "q" || data === "Q") {
								done(undefined);
								return;
							}
							component.handleInput(data);
						},
					};
				},
				{ overlay: true },
			);
		},
	});
}
