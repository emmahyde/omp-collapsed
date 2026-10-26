#!/usr/bin/env sh
# Install or update omp-collapsed as an Oh My Pi extension.
#
#   curl -fsSL https://raw.githubusercontent.com/emmahyde/omp-collapsed/main/install.sh | sh
#
# Clones (or pulls) the repository into ~/.omp/agent/extensions/omp-collapsed, where OMP
# discovers directory extensions, then installs its dependencies with Bun.
# Override the destination with OMP_COLLAPSED_DIR or the source with OMP_COLLAPSED_REPO.
set -eu

REPO="${OMP_COLLAPSED_REPO:-https://github.com/emmahyde/omp-collapsed.git}"
DEST="${OMP_COLLAPSED_DIR:-$HOME/.omp/agent/extensions/omp-collapsed}"

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "install.sh: $1 is required but not on PATH" >&2; exit 1; }
}
need git
need bun
command -v omp >/dev/null 2>&1 || echo "install.sh: warning: omp not found on PATH; the extension loads once OMP is installed" >&2

if [ -d "$DEST/.git" ]; then
	echo "Updating omp-collapsed in $DEST"
	git -C "$DEST" pull --ff-only
elif [ -e "$DEST" ]; then
	echo "install.sh: $DEST exists and is not a git checkout; move it aside or set OMP_COLLAPSED_DIR" >&2
	exit 1
else
	echo "Cloning omp-collapsed into $DEST"
	mkdir -p "$(dirname "$DEST")"
	git clone --depth 1 "$REPO" "$DEST"
fi

echo "Installing dependencies"
bun install --cwd "$DEST" --frozen-lockfile

echo
echo "omp-collapsed installed. Restart OMP (or run /reload-plugins in a session), then open /collapsed."
echo "It replaces the tool-card and tool-row features of hydemods; do not run both."
