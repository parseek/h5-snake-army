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


def _num(d, key, lo, hi, dflt):
    """把请求里的数字夹到 [lo, hi]；给不出数就用默认值。座位号允许负数。"""
    try:
        v = int(d.get(key, dflt))
    except Exception:
        v = dflt
    return max(lo, min(hi, v))


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

    # ---------- 座位小工具 ----------
    # 每个房间有一张座位表：座位 1..max_players-1 是玩家席，负数（-1、-2…）是观战席。
    # 房主把每个座位的 offer 挂上来，来客取一个空座位、把 answer 放回去。
    # 这套规则跟 Rust 侧的 src-tauri/src/lan.rs 一模一样，前端只有一条代码路径。
    def _free_player_seats(self, r):
        n = 0
        for s in range(1, int(r.get("max_players", 2))):
            st = r["seats"].get(s)
            if st and not st.get("answer"):
                n += 1
        return n

    def _answered_player_seats(self, r):
        return sum(1 for s, st in r["seats"].items() if s > 0 and st.get("answer"))

    def _spectators(self, r):
        return sum(1 for s, st in r["seats"].items() if s < 0 and st.get("answer"))

    def _free_spectator_seats(self, r):
        return sum(1 for s, st in r["seats"].items() if s < 0 and not st.get("answer"))

    def _live_players(self, r):
        return max(int(r.get("players", 1)), 1 + self._answered_player_seats(r))

    def _take_seat(self, r):
        """下一个能坐的座位：先玩家席，再观战席；都没有就 None"""
        for s in range(1, int(r.get("max_players", 2))):
            st = r["seats"].get(s)
            if st and not st.get("answer"):
                return s
        spec = sorted(
            [s for s, st in r["seats"].items() if s < 0 and not st.get("answer")],
            reverse=True,
        )
        return spec[0] if spec else None

    def _room_json(self, rid, r):
        free, free_spec = self._free_player_seats(r), self._free_spectator_seats(r)
        return {
            "id": rid,
            "name": r["name"],
            "desc": r.get("desc", ""),
            "player": r.get("player", ""),
            "cols": r.get("cols", 30),
            "rows": r.get("rows", 15),
            "maxPlayers": r.get("max_players", 2),
            "players": self._live_players(r),
            "spectators": self._spectators(r),
            "freeSeats": free,
            "freeSpectatorSeats": free_spec,
            "taken": free == 0 and free_spec == 0,
        }

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
                out = [self._room_json(k, v) for k, v in rooms.items()]
            self._json({"host": HOST_NAME, "rooms": out})
            return

        if path == "/api/offer":
            # 来客取座位：先玩家席，再观战席
            with lock:
                self._sweep()
                r = rooms.get(q.get("id", [""])[0])
                seat, offer, name = None, "", ""
                if r:
                    r["seen"] = time.time()
                    seat = self._take_seat(r)
                    name = r["name"]
                    if seat is not None:
                        offer = r["seats"][seat]["offer"]
            if not r:
                self._json({"error": "房间不存在或已过期"}, 404)
                return
            if seat is None:
                self._json({"error": "座位都满了"}, 409)
                return
            self._json({"name": name, "seat": seat, "offer": offer})
            return

        if path == "/api/answers":
            # 房主轮询：哪些座位有人应答了。故意「读不消费」，由房主按座位去重。
            reported = q.get("players", [""])[0]
            with lock:
                self._sweep()
                r = rooms.get(q.get("id", [""])[0])
                out = []
                if r:
                    r["seen"] = time.time()
                    if reported.isdigit():
                        r["players"] = max(1, int(reported))
                    out = [
                        {"seat": s, "answer": st["answer"]}
                        for s, st in sorted(r["seats"].items())
                        if st.get("answer")
                    ]
            if not r:
                self._json({"error": "房间不存在或已过期"}, 404)
                return
            self._json({"answers": out})
            return

        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path

        if path == "/api/room":
            d = self._body()
            with lock:
                self._sweep()
                rid = "r%d" % int(time.time() * 1000 % 100000000)
                rooms[rid] = {
                    "name": (str(d.get("name") or "").strip() or HOST_NAME)[:24],
                    "desc": str(d.get("desc") or "").strip()[:80],
                    "player": (str(d.get("player") or "").strip() or HOST_NAME)[:16],
                    "cols": _num(d, "cols", 10, 60, 30),
                    "rows": _num(d, "rows", 8, 40, 15),
                    "max_players": _num(d, "maxPlayers", 2, 6, 2),
                    "players": 1,
                    "seats": {},
                    "seen": time.time(),
                }
            self._json({"id": rid})
            return

        if path == "/api/offer":
            # 房主把某个座位的 offer 挂上来
            d = self._body()
            offer = d.get("offer") or ""
            if not offer:
                self._json({"error": "缺少 offer"}, 400)
                return
            with lock:
                self._sweep()
                r = rooms.get(d.get("id", ""))
                if r:
                    r["seen"] = time.time()
                    r["seats"][_num(d, "seat", -9, 9, 0)] = {
                        "offer": offer,
                        "answer": None,
                    }
            if not r:
                self._json({"error": "房间不存在或已过期"}, 404)
                return
            self._json({"ok": True})
            return

        if path == "/api/answer":
            d = self._body()
            answer = d.get("answer") or ""
            if not answer:
                self._json({"error": "缺少 answer"}, 400)
                return
            seat = _num(d, "seat", -9, 9, 0)
            with lock:
                self._sweep()
                r = rooms.get(d.get("id", ""))
                st = r["seats"].get(seat) if r else None
                if not r:
                    code, out = 404, {"error": "房间不存在或已过期"}
                elif st is None:
                    code, out = 400, {"error": "这个座位没有对应的 offer"}
                elif st.get("answer"):
                    code, out = 409, {"error": "这个座位刚被人坐下了"}
                else:
                    st["answer"] = answer
                    r["seen"] = time.time()
                    code, out = 200, {"ok": True}
            self._json(out, code)
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
