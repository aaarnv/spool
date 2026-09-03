#!/bin/sh
# Installs the wake daemon as a launchd agent so it survives reboots.
# The nohup recipe in the README dies with the terminal session; this does not.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.spool.mcp-watch.plist"
mkdir -p "$HOME/.spool-mcp" "$HOME/Library/LaunchAgents"
sed -e "s|__SPOOL_REPO__|$REPO|" -e "s|__HOME__|$HOME|" -e "s|/usr/local/bin/node|$NODE|" \
  "$REPO/ops/com.spool.mcp-watch.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded com.spool.mcp-watch ($NODE, log: ~/.spool-mcp/watch.log)"
