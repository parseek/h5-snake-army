# 贪吃蛇 · Canvas

一份 **纯静态** 的 Canvas 贪吃蛇。前端不依赖任何框架、构建工具或 Tauri API ——
既可以用浏览器直接打开（`file://` 也行），也可以套进 Tauri 壳里当桌面程序跑。

## 玩法

| 模式 | 说明 |
|---|---|
| 单人 | 15×15 场地 |
| 本地双人 · 合作 | 30×15，队友出局后场上会掉复活道具，活着的人吃到就能救回来 |
| 本地双人 · 竞争 | 30×15，炮塔会把对方也算进目标，先出局的一方输 |
| 联机对战 | WebRTC 直连 + 手动交换连接码；程序版本不一致会直接拒绝连接 |

键位：P1 方向键 + `/` 建塔，P2 WASD + `Q` 建塔，
`P` 暂停，`Esc` 回模式选择。屏幕上也有方向键和建塔按钮（只控 P1）。

## 怎么跑

### 1. 浏览器（零依赖）

双击 `index.html` 即可。想联机的话建议起个 http 服务（`file://` 下 WebRTC 没验证过）：

```bash
python -m http.server 8080
```

### 2. 桌面程序（Tauri 2）

需要 Rust 工具链 + Node；Windows 上还需要 WebView2 运行时（Win10/11 一般自带）。

```bash
npm install          # 只装 Tauri CLI
npm run sync         # 把前端拷进 dist/（Tauri 只打包 dist/）
npm run dev          # 开发模式
npm run build:exe    # 只出 exe（快）
npm run build        # 出 exe + NSIS 安装包
```

前端文件**始终留在仓库根目录**，`dist/` 是构建时生成的、不入库。
Tauri 壳里没有任何业务逻辑，只负责给一个原生窗口和 WebView2。

### 3. 局域网主机（可选）

```bash
python lan-host.py 8080
```

会打印局域网地址，同一个 Wi-Fi 下打开就能拿到游戏。
背景：浏览器不能监听端口、不能收广播，也没有 mDNS 浏览 API，所以「自动搜索房间」
必须有一台机器在监听 —— 这个脚本就是那一台。页面侧的一键进房 UI 还没接。

## 目录

```
index.html             前端全部代码（HTML + CSS + JS 都在这一个文件里）
assets/global.css      只有 body { margin: 0 }
lan-host.py            可选的局域网主机 / 信令中转（Python 标准库）
src-tauri/             Tauri 壳（Rust）
scripts/sync-web.mjs   把前端拷进 dist/
```

## 联机的已知边界

- 只在**本机回环**验证过（两个独立浏览器实例互相连接）；局域网 / 跨公网需要两台真机才能测。
- 公共免费 TURN 实测**全部失效**，所以跨网在对称 NAT 下打不通 —— 要么自建 coturn，
  要么买一个商业 TURN，按 `turn:主机:端口|用户名|密码` 填进「ICE 服务器」框。
- 同一个 Wi-Fi 下如果连不上，直接填对方的局域网 IP（面板上的第二个输入框）通常能解决。
