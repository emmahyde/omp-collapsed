import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "../install.sh");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "omp-collapsed-install-"));
	const bin = join(root, "bin");
	const dest = join(root, "extension");
	const cache = join(root, "agent", "cache", "tiny-models");
	const model = join(cache, "mlx", "mlx-community--Llama-3.2-3B-Instruct-4bit");
	const runtime = join(dirname(cache), "tiny-mlx-runtime", "mlx-lm-0.31.3");
	const calls = join(root, "calls");
	await mkdir(bin, { recursive: true });
	await mkdir(model, { recursive: true });
	await mkdir(join(runtime, "bin"), { recursive: true });
	await writeFile(calls, "");
	await writeFile(join(model, "config.json"), "{}");
	await writeFile(join(model, ".omp-complete.json"), JSON.stringify({
		repo: "mlx-community/Llama-3.2-3B-Instruct-4bit", files: ["config.json"],
	}));
	await writeFile(join(runtime, ".omp-mlx-lm"), "0.31.3");
	const catalog = join(root, "catalog.json");
	await writeFile(catalog, JSON.stringify({
		models: [{ key: "llama3.2:3b", mlxRepo: "mlx-community/Llama-3.2-3B-Instruct-4bit" }],
		wordCompletion: { dir: join(cache, "predict", "model") },
	}));
	async function executable(file: string, body: string) {
		await writeFile(file, `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> "$CALLS"\n${body}\n`);
		await chmod(file, 0o755);
	}
	await executable(join(bin, "uname"), 'if [ "$1" = "-s" ]; then echo "${TEST_OS:-Darwin}"; else echo arm64; fi');
	await executable(join(bin, "uv"), "exit 0");
	await executable(join(bin, "git"), 'if [ "$1" = clone ]; then mkdir -p "$OMP_COLLAPSED_DIR/.git"; fi');
	await executable(join(bin, "bun"), 'if [ "$1" = install ]; then exit 0; fi\nexec "$REAL_BUN" "$@"');
	await executable(join(bin, "omp"), `case "$1 $2" in
  "tiny-models download") [ "$PI_TINY_DEVICE" = mlx ] || exit 12; exit "\${TEST_DOWNLOAD_EXIT:-0}" ;;
  "tiny-models list") cat "$CATALOG" ;;
  "config set") [ "$3" = providers.tinyModelDevice ] && [ "$4" = mlx ] ;;
  *) exit 13 ;;
esac`);
	await executable(join(runtime, "bin", "python"), 'exit "${TEST_MLX_EXIT:-0}"');
	const env = {
		...process.env,
		PATH: `${bin}:/usr/bin:/bin`,
		HOME: root,
		CALLS: calls,
		CATALOG: catalog,
		REAL_BUN: process.execPath,
		OMP_COLLAPSED_DIR: dest,
		OMP_COLLAPSED_REPO: "https://example.invalid/private-extension.git",
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_TINY_DEVICE: "cpu",
	};
	return {
		root, dest, model, env,
		async run(overrides: Record<string, string> = {}) {
			const proc = Bun.spawn(["/bin/sh", installer], { cwd: root, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { stdout, stderr, exitCode, calls: await readFile(calls, "utf8") };
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}


test("installer rejects unsupported platforms before making changes", async () => {
	const f = await fixture();
	try {
		const result = await f.run({ TEST_OS: "Linux" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("native Apple-silicon macOS");
		expect(result.calls).not.toContain("tiny-models download");
		expect(result.calls).not.toContain("config set");
	} finally { await f.cleanup(); }
});

test("installer does not persist MLX after a failed download", async () => {
	const f = await fixture();
	try {
		const result = await f.run({ TEST_DOWNLOAD_EXIT: "1" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("MLX model setup failed");
		expect(result.calls).not.toContain("config set");
	} finally { await f.cleanup(); }
});

test("successful ONNX fallback without MLX weights cannot report installation success", async () => {
	const f = await fixture();
	try {
		await rm(join(f.model, ".omp-complete.json"));
		const result = await f.run();
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("omp-collapsed installed.");
		expect(result.calls).not.toContain("config set");
	} finally { await f.cleanup(); }
});

test("a cached model still must load through MLX before the device setting is changed", async () => {
	const f = await fixture();
	try {
		const result = await f.run({ TEST_MLX_EXIT: "1" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("could not load through MLX");
		expect(result.calls).not.toContain("config set");
	} finally { await f.cleanup(); }
});
