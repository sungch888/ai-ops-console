#!/usr/bin/env bash
# 起连接器局域网模拟环境（5 端口 9101-9105）。
# 用法： ./sim/start-sim.sh [监听地址]      默认 0.0.0.0（局域网可达）
# 常用环境变量： SIM_STEP=4（分段秒数） SIM_TOKEN=xxx（开鉴权） SIM_PORT_BASE=9101 SIM_K8S_WRITE=1
cd "$(dirname "$0")/.."
exec python3 -u sim/connectors.py --host "${1:-0.0.0.0}"
