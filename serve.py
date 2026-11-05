# AI Operations Management Platform - demo launcher (cross-platform, ASCII only)
# Picks a free port, serves ./dist and opens the browser.
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

BASE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(BASE, 'dist')
HOST = '127.0.0.1'


def free_port(start=8090, end=8099):
    for p in range(start, end + 1):
        s = socket.socket()
        try:
            s.bind((HOST, p))
            s.close()
            return p
        except OSError:
            s.close()
    return None


def main():
    port = free_port()
    if port is None:
        print('[ERROR] No free port between 8090 and 8099.', flush=True)
        return 1
    if not os.path.isdir(DIST):
        print('[ERROR] Folder "dist" not found next to this script.', flush=True)
        return 1
    os.chdir(DIST)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            return

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer((HOST, port), Handler)
    url = 'http://%s:%d/' % (HOST, port)
    print('Demo URL: ' + url, flush=True)
    print('Press Ctrl+C here to stop the server. (Close this window to stop.)', flush=True)
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('Server stopped.', flush=True)
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
