#!/usr/bin/env sh
# Install or update omp-collapsed as an Oh My Pi extension.
# Run from an authenticated checkout: sh install.sh
# Requires native Apple-silicon macOS, Git, Bun, OMP with MLX tiny-model support,
# and uv (recommended) or Python 3.10–3.13 with venv/pip.
# Override the destination with OMP_COLLAPSED_DIR or source with OMP_COLLAPSED_REPO.
# OMP's own profile/environment controls select its config and model cache.
set -eu

REPO="${OMP_COLLAPSED_REPO:-https://github.com/emmahyde/omp-collapsed.git}"
DEST="${OMP_COLLAPSED_DIR:-$HOME/.omp/agent/extensions/omp-collapsed}"

fail() {
	echo "install.sh: $*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not on PATH"
}

case "$(uname -s)/$(uname -m)" in
	Darwin/arm64) ;;
	*) fail "GROUP/LINES MLX setup requires native Apple-silicon macOS (Darwin/arm64); Intel Macs, Rosetta shells, and Linux are not supported by this installer" ;;
esac

need git
need bun
need omp
if ! command -v uv >/dev/null 2>&1; then
	need python3
	python3 -c 'import sys, venv; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)' ||
		fail "MLX requires uv or Python 3.10–3.13 with venv/pip; install uv (recommended) or a supported Python"
fi

if [ -d "$DEST/.git" ]; then
	echo "Updating omp-collapsed in $DEST"
	git -C "$DEST" pull --ff-only
elif [ -e "$DEST" ]; then
	echo "install.sh: $DEST exists and is not a git checkout; move it aside or set OMP_COLLAPSED_DIR" >&2
	exit 1
else
	echo "Cloning omp-collapsed into $DEST"
	mkdir -p "$(dirname "$DEST")"
	git clone --depth 1 "$REPO" "$DEST" ||
		fail "cannot clone $REPO; this repository requires access and authenticated Git (for GitHub CLI users: gh auth login && gh auth setup-git)"
fi

echo "Installing dependencies"
bun install --cwd "$DEST" --production --omit=peer --frozen-lockfile
# Explicitly select MLX for the download: the default tiny-model backend is ONNX.
# OMP owns the pinned mlx-lm runtime, model downloads, locks, and cache reuse.
echo "Preparing GROUP/LINES model: llama3.2:3b (mlx-community/Llama-3.2-3B-Instruct-4bit)"
PI_TINY_DEVICE=mlx omp tiny-models download llama3.2:3b ||
	fail "MLX model setup failed; use a current native arm64 OMP with MLX support, network access to Python packages/Hugging Face, and sufficient free disk/memory, then rerun"

# OMP can silently fall back to ONNX when its MLX worker cannot start. Check the
# actual MLX cache and load the model with OMP's private Python before claiming
# success. The CLI exposes the cache root through its word-completion directory.
CATALOG="$(PI_TINY_DEVICE=mlx omp tiny-models list --json)" ||
	fail "cannot read the model catalog; update OMP to a version with MLX tiny-model support"
OMP_COLLAPSED_CATALOG="$CATALOG" bun -e '
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
try {
  const catalog = JSON.parse(process.env.OMP_COLLAPSED_CATALOG);
  const repo = "mlx-community/Llama-3.2-3B-Instruct-4bit";
  if (catalog.models?.find(m => m.key === "llama3.2:3b")?.mlxRepo !== repo)
    throw new Error("OMP does not map llama3.2:3b to the required MLX repository");
  if (!path.isAbsolute(catalog.wordCompletion?.dir ?? ""))
    throw new Error("OMP does not expose its tiny-model cache directory");
  const root = path.dirname(path.dirname(catalog.wordCompletion.dir));
  const model = path.join(root, "mlx", repo.replace("/", "--"));
  if (!fs.existsSync(path.join(model, ".omp-complete.json")))
    throw new Error("MLX weights are absent (OMP may have fallen back to ONNX)");
  const marker = JSON.parse(fs.readFileSync(path.join(model, ".omp-complete.json"), "utf8"));
  if (marker.repo !== repo || !Array.isArray(marker.files) || !marker.files.length ||
      !marker.files.every(file => typeof file === "string" && fs.existsSync(path.join(model, file))))
    throw new Error("MLX model download is incomplete (OMP may have fallen back to ONNX)");
  const runtimes = path.join(path.dirname(root), "tiny-mlx-runtime");
  const candidates = fs.readdirSync(runtimes).filter(name => name.startsWith("mlx-lm-"))
    .filter(name => fs.existsSync(path.join(runtimes, name, ".omp-mlx-lm")))
    .sort((a, b) => fs.statSync(path.join(runtimes, b)).mtimeMs - fs.statSync(path.join(runtimes, a)).mtimeMs);
  if (!candidates.length) throw new Error("OMP has not installed its MLX Python runtime");
  const python = path.join(runtimes, candidates[0], "bin", "python");
  const result = cp.spawnSync(python, ["-c",
    "import sys; import mlx.core as mx; from mlx_lm import load; assert mx.metal.is_available(), \"Metal GPU unavailable\"; load(sys.argv[1]); print(\"MLX model loaded successfully\")",
    model], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("the downloaded model could not load through MLX");
} catch (error) {
  console.error(`install.sh: ${error.message}. Update OMP or fix MLX prerequisites, then rerun.`);
  process.exit(1);
}
'

# Use OMP's merge-aware settings writer; never replace the user's config file.
# Apply only after downloads/dependencies succeed. This changes the shared tiny-model
# backend (also used by OMP titles/memory), not unrelated settings or model roles.
omp config set providers.tinyModelDevice mlx ||
	fail "could not enable providers.tinyModelDevice; use an OMP version with MLX configuration support"

echo
echo "omp-collapsed installed. Restart OMP (or run /reload-plugins), then open /collapsed."
echo "GROUP/LINES use local llama3.2:3b via MLX; existing model caches and extension data are preserved."
echo "Unset PI_TINY_DEVICE or set it to mlx when launching OMP; environment, project settings, and --config overlays can override the saved backend."
echo "A non-default OMP_COLLAPSED_DIR must be in OMP's configured extension discovery paths."
