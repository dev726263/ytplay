#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.anand.ytplayd.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/com.anand.ytplayd.plist"

PY="$ROOT/.venv/bin/python"
DAEMON="$ROOT/src/ytplayd.py"

mkdir -p "$HOME/Library/LaunchAgents"

# Render template with correct paths
sed -e "s|__PYTHON__|$PY|g" -e "s|__DAEMON__|$DAEMON|g" "$PLIST_SRC" > "$PLIST_DST"

echo "Wrote $PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Loaded launchd agent. Use ./scripts/start.sh and ./scripts/status.sh"
