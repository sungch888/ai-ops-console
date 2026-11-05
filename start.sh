#!/usr/bin/env bash
# AI Operations Management Platform - demo launcher (Mac / Linux)
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 not found. Install Python 3 and run ./start.sh again."
  exit 1
fi
exec python3 serve.py
