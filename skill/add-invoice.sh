#!/bin/bash
# Wrapper: automatically finds the latest uploaded media file and passes it to the CLI.
# Usage: add-invoice.sh --json '{...}'

MEDIA_DIR="$HOME/.openclaw/media/inbound"
SKILL_DIR="$(dirname "$0")"

LATEST_FILE=""
if [ -d "$MEDIA_DIR" ]; then
  LATEST_FILE=$(ls -t "$MEDIA_DIR" 2>/dev/null | head -1)
  if [ -n "$LATEST_FILE" ]; then
    LATEST_FILE="$MEDIA_DIR/$LATEST_FILE"
  fi
fi

if [ -n "$LATEST_FILE" ] && [ -f "$LATEST_FILE" ]; then
  exec node --experimental-sqlite "$SKILL_DIR/invoice-manager.mjs" add "$@" --file "$LATEST_FILE"
else
  exec node --experimental-sqlite "$SKILL_DIR/invoice-manager.mjs" add "$@"
fi
