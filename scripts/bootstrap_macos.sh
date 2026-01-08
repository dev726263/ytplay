#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure brew
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install from https://brew.sh then re-run."
  exit 1
fi

echo "[1/5] Installing system dependencies (mpv, yt-dlp, python)..."
brew install mpv yt-dlp python || true

echo "[2/5] Creating python venv..."
cd "$ROOT"
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -U openai ytmusicapi

echo "[3/5] Creating state dir ~/.ytplay ..."
mkdir -p "$HOME/.ytplay"

echo "[4/5] Installing config template to ~/.ytplay/.env if missing..."
if [ ! -f "$HOME/.ytplay/.env" ]; then
  cp "$ROOT/config/.env.example" "$HOME/.ytplay/.env"
  echo "Created $HOME/.ytplay/.env (edit it to add OPENAI_API_KEY)."
else
  echo "Found existing $HOME/.ytplay/.env (leaving it)."
fi

echo "[5/5] Done. Next: edit ~/.ytplay/.env and run ./scripts/install_launchd.sh"
