#!/usr/bin/env bash
# 打包演示版为可携带 zip（含 dist + 启动脚本 + 说明）
set -e
cd "$(dirname "$0")"
OUT="/sdcard/Download/DSH-Go"
mkdir -p "$OUT"
STAGE="/tmp/dsh-demo-pack"
rm -rf "$STAGE" && mkdir -p "$STAGE/AI运营管理平台-演示版"
D="$STAGE/AI运营管理平台-演示版"
cp -r dist "$D/dist"
cp start.sh start.bat README.md "$D/"
chmod +x "$D/start.sh"
cd "$STAGE"
zip -qr "$OUT/AI运营管理平台-演示版.zip" "AI运营管理平台-演示版"
echo "已打包：$OUT/AI运营管理平台-演示版.zip"
ls -lh "$OUT/AI运营管理平台-演示版.zip"
