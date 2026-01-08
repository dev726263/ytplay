#!/usr/bin/env bash
set -euo pipefail
launchctl kill SIGTERM gui/$(id -u)/com.anand.ytplayd 2>/dev/null || true
