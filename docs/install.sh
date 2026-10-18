#!/bin/bash
# Installs the latest Agent Desk into /Applications:
#   curl -fsSL https://aahannp.github.io/agent-desk/install.sh | bash
set -euo pipefail

app="/Applications/Agent Desk.app"
[ "$(uname -s)" = Darwin ] || { echo "Agent Desk is a Mac app." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Agent Desk needs a Mac with Apple silicon." >&2; exit 1; }
if pgrep -f "$app/Contents/MacOS/" >/dev/null; then echo "Quit Agent Desk first (⌘Q), then run this again." >&2; exit 1; fi

url=$(curl -fsSL https://api.github.com/repos/aahannp/agent-desk/releases/latest |
  grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)
[ -n "$url" ] || { echo "Couldn't find the latest release. Try again in a minute." >&2; exit 1; }

tmp=$(mktemp -d)
trap 'hdiutil detach -quiet "$tmp/mnt" 2>/dev/null || true; rm -rf "$tmp"' EXIT
echo "Downloading ${url##*/}"
curl -fL --progress-bar -o "$tmp/agent-desk.dmg" "$url"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/agent-desk.dmg"

rm -rf "$app"
ditto "$tmp/mnt/Agent Desk.app" "$app"
echo "Installed. Opening Agent Desk…"
open "$app"
