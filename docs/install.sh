#!/bin/bash
# Installs the latest Relay into /Applications:
#   curl -fsSL https://aahannp.github.io/agent-desk/install.sh | bash
# Up to 1.8.x the DMG holds "Agent Desk.app", from 1.9.0 "Relay.app": it installs whichever app the DMG has.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "Relay is a Mac app." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Relay needs a Mac with Apple silicon." >&2; exit 1; }

url=$(curl -fsSL https://api.github.com/repos/aahannp/agent-desk/releases/latest |
  grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)
[ -n "$url" ] || { echo "Couldn't find the latest release. Try again in a minute." >&2; exit 1; }

tmp=$(mktemp -d)
trap 'hdiutil detach -quiet "$tmp/mnt" 2>/dev/null || true; rm -rf "$tmp"' EXIT
echo "Downloading ${url##*/}"
curl -fL --progress-bar -o "$tmp/relay.dmg" "$url"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/relay.dmg"

set -- "$tmp/mnt/"*.app
{ [ $# -eq 1 ] && [ -d "$1" ]; } || { echo "Expected exactly one app in ${url##*/}. Nothing was installed." >&2; exit 1; }
name=${1##*/}
app="/Applications/$name"
running() { pgrep -f "/Applications/$1/Contents/MacOS/" >/dev/null; }
if running "$name"; then echo "Quit ${name%.app} first (⌘Q), then run this again." >&2; exit 1; fi
# Relay keeps using Agent Desk's data folder, so the two must never run at once.
if [ "$name" = Relay.app ] && running "Agent Desk.app"; then echo "Quit Agent Desk first (⌘Q), then run this again." >&2; exit 1; fi

rm -rf "$app"
ditto "$1" "$app"
if [ "$name" = Relay.app ] && [ -e "/Applications/Agent Desk.app" ]; then
  echo "Agent Desk.app is still in /Applications. Your data now lives with Relay, so you can delete it (drag it to the Trash)."
fi
echo "Installed. Opening ${name%.app}…"
open "$app"
