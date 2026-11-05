#!/usr/bin/env bash
# Build the UI, then pack a portable demo zip (dist + server + collector + docs + start scripts).
set -e
cd "$(dirname "$0")"
node node_modules/vite/bin/vite.js build
python3 tools/package_demo.py ai-ops-demo.zip
echo "done: $(pwd)/ai-ops-demo.zip"
