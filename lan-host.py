#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
贪吃蛇 · 局域网主机

浏览器不能开 UDP 广播、也不能监听端口，所以"自动搜索房间"必须有一台机器在监听 ——
就是这个小脚本。它同时干两件事：

  1. 把当前目录当静态站点发出去（friend 直接打开网址就能拿到游戏）
  2. 提供一个极简的信令中转（房间列表 / 交换 offer-answer）

用法：
    python lan-host.py            # 默认 8080 端口
    python lan-host.py 9000       # 换端口

启动后屏幕上会打印局域网地址，把它发给同一个 Wi-Fi 下的朋友即可。
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.dirname(os.path.abspath(__file__))
ROOM_TTL = 60.0          # 超过这么久没人动的房间算过期
HOST_NAME = socket.gethostname()

rooms = {}
lock = threading.Lock()


def lan_ip():
    """拿本机在局域网里的地址：连一个外网地址但不真发数据，看内核选了哪张网卡。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # ---------- 小工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return {}

    def _sweep(self):
        now = time.time()
        for k in [k for k, v in rooms.items() if now - v["seen"] > ROOM_TTL]:
            rooms.pop(k, None)

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        path = url.path

        if path == "/api/ping":
            self._json({"ok": True, "name": HOST_NAME})
            return

        if path == "/api/rooms":
            with lock:
                self._sweep()
                out = [
                    {"id": k, "name": v["name"], "taken": v["answer"] is not None}
                    for k, v in rooms.items()
                ]
            self._json({"host": HOST_NAME, "rooms": out})
            return

        if path == "/api/offer":
            with lock:
                self._sweep()
                r = rooms.get(q.get("id", [""])[0])
                if r:
                    r["seen"] = time.time()
            if not r:
                self._json({"error": "房间不存在或已过期"}, 404)
                return
            self._json({"name": r["name"], "offer": r["offer"]})
            return

        if path == "/api/answer":
            with lock:
                self._sweep()
                r = rooms.get(q.get("id", [""])[0])
                if r:
                    r["seen"] = time.time()
            if not r:
                self._json({"error": "房间不存在或已过期"}, 404)
                return
            self._json({"answer": r["answer"] or ""})
            return

        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path

        if path == "/api/room":
            d = self._body()
            if not d.get("offer"):
                self._json({"error": "缺少 offer"}, 400)
                return
            with lock:
                self._sweep()
                rid = "r%d" % int(time.time() * 1000 % 100000000)
                rooms[rid] = {
                    "name": (d.get("name") or HOST_NAME)[:24],
                    "offer": d["offer"],
                    "answer": None,
                    "seen": time.time(),
                }
            self._json({"id": rid})
            return

        if path == "/api/answer":
            d = self._body()
            with lock:
                self._sweep()
                r = rooms.get(d.get("id", ""))
                if not r:
                    self._json({"error": "房间不存在或已过期"}, 404)
                    return
                if r["answer"]:
                    self._json({"error": "这个房间已经有人进去了"}, 409)
                    return
                r["answer"] = d.get("answer") or ""
                r["seen"] = time.time()
            self._json({"ok": True})
            return

        if path == "/api/close":
            d = self._body()
            with lock:
                rooms.pop(d.get("id", ""), None)
            self._json({"ok": True})
            return

        self._json({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


def main():
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        print("!! 当前目录里没有 index.html，确认在游戏目录下运行")
        return

    ip = lan_ip()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True

    print("=" * 56)
    print(" 贪吃蛇 · 局域网主机已启动")
    print("=" * 56)
    print("  本机打开:   http://127.0.0.1:%d" % PORT)
    print("  发给朋友:   http://%s:%d" % (ip, PORT))
    print()
    print(" 同一个 Wi-Fi 下的人打开上面那个地址，")
    print(" 进「联机对战」就能直接看到房间列表，点一下进来。")
    print()
    print(" 房间 60 秒没人动会自动过期。Ctrl+C 退出。")
    print("=" * 56)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
