#!/usr/bin/env bash
set -euo pipefail
echo "launchd:"
launchctl print gui/$(id -u)/com.anand.ytplayd 2>/dev/null | head -n 30 || true
echo
echo "health:"
curl -s http://127.0.0.1:17845/health || true
echo
echo "logs:"
ls -l /tmp/ytplayd.out /tmp/ytplayd.err 2>/dev/null || true
