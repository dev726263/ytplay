#!/usr/bin/env bash
set -euo pipefail
launchctl kickstart -k gui/$(id -u)/com.anand.ytplayd 2>/dev/null || true
sleep 0.2
curl -s http://127.0.0.1:17845/health || true
echo
