#!/usr/bin/env bash
# AI Ops Console demo v2.2 - one-click start (macOS / Linux)
# Starts the data service (Python stdlib + SQLite) and serves the built UI.
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 (3.9+) and run again." >&2
  exit 1
fi

# 挑一个没人占的端口：从 8090 起逐个试。
# 不能靠 lsof / ss 判断是否被占用 —— 精简系统（容器 / 手机 proot）里这两个命令
# 常常都没有，或者读不到 /proc/net，会「误判成没人占用」→ 直接撞端口失败。
# 用 python 自己 bind 一下试探，最可靠，而且 python3 本来就是必需依赖。
PORT=$(python3 - <<'PY'
import socket
for port in range(8090, 8190):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('0.0.0.0', port))
    except OSError:
        continue
    finally:
        s.close()
    print(port)
    break
else:
    raise SystemExit('8090-8189 都被占用了，请先停掉旧实例')
PY
)
if [ -z "$PORT" ]; then
  echo "没有可用端口（8090-8189 全被占用），请先停掉旧实例" >&2
  exit 1
fi

URL="http://127.0.0.1:$PORT"
( sleep 1; { command -v xdg-open >/dev/null && xdg-open "$URL"; command -v open >/dev/null && open "$URL"; } ) &
python3 server/server.py --port "$PORT" --dist dist --db server/data/aiops.db
