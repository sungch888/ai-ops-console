#!/usr/bin/env bash
# AI Ops Console demo v2.2 - one-click start (macOS / Linux)
# Starts the data service (Python stdlib + SQLite) and serves the built UI.
cd "$(dirname "$0")"
PORT=8090
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ":$PORT "; do
  PORT=$((PORT+1))
done
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 (3.9+) and run again." >&2
  exit 1
fi
URL="http://127.0.0.1:$PORT"
( sleep 1; { command -v xdg-open >/dev/null && xdg-open "$URL"; command -v open >/dev/null && open "$URL"; } ) &
python3 server/server.py --port "$PORT" --dist dist --db server/data/aiops.db
