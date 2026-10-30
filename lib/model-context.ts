import { decodeEvalOutput } from "./eval-output";
import { formatJsonOutput, MAX_RENDER_BYTES, parseTabularData, separateGeneratedNoticeFooter } from "./tool-output";

function safeNumbers(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
	if (Array.isArray(value)) return value.every(safeNumbers);
	if (value && typeof value === "object") return Object.values(value).every(safeNumbers);
	return true;
}

function encodeValue(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	try {
		if (!safeNumbers(value)) return undefined;
		const output = formatJsonOutput(value);
		return output.format === "toon" ? output.text : undefined;
	} catch {
		return undefined;
	}
}

function parseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

export function toonForModel(text: string, toolName: string): string | undefined {
	if (Buffer.byteLength(text, "utf8") > MAX_RENDER_BYTES) return undefined;
	let changed = false;
	const convertPlain = (input: string): string => {
		return decodeEvalOutput(input).map(record => {
			if (!Object.hasOwn(record, "value")) return record.raw;
			const value = parseJson(record.raw) ?? (toolName === "eval" ? record.value : undefined);
			const encoded = encodeValue(value);
			if (encoded === undefined) return record.raw;
			changed = true;
			const indent = /^[ \t]*/.exec(record.raw)?.[0] ?? "";
			return encoded.split("\n").map(line => indent + line).join("\n");
		}).join("");
	};

	const fences = /^[ \t]*```([^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?$)/gm;
	let output = "";
	let end = 0;
	for (const match of text.matchAll(fences)) {
		output += convertPlain(text.slice(end, match.index));
		const encoded = match[1].trim().toLowerCase() === "json" ? encodeValue(parseJson(match[2])) : undefined;
		if (encoded === undefined) output += match[0];
		else {
			changed = true;
			output += `\`\`\`toon\n${encoded}\n\`\`\``;
		}
		end = match.index + match[0].length;
	}
	output += convertPlain(text.slice(end));
	if (changed) return output;

	const { body, footer } = separateGeneratedNoticeFooter(text);
	const rows = parseTabularData(body);
	const table = rows && encodeValue(rows);
	return table === undefined ? undefined : `${table}${footer ? `\n${footer.trimStart()}` : ""}`;
}
