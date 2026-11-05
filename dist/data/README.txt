This directory is filled by the read-only collector:
  python3 collector/collect.py --selftest --out dist/data
  python3 collector/collect.py --config collector/config.json --loop 30

If manifest.json is missing or older than 15 minutes, the pages fall back to
platform-derived numbers and label the source as "platform derived".
