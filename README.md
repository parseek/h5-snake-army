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
npm install              # 只装 Tauri CLI
npm run fetch:easytier   # 下载跨网用的 EasyTier（不联机跨网可以不装）
npm run dev              # 开发模式
npm run build:exe        # 只编译出 exe（快，约 1.5 分钟）
npm run build            # 完整发布包：exe + EasyTier + 便携 zip
```

前端文件**始终留在仓库根目录**，`dist/` 是构建时生成的、不入库。

产物固定在这个路径（`scripts/pack-exe.mjs` 会把 exe 拷过来，
不管机器上的 `CARGO_TARGET_DIR` 指到哪）：

```
src-tauri/target/release/snake-army.exe
```

中间产物仍然留在 `CARGO_TARGET_DIR`（本机是 `C:\rust-targets`），
那里是全机器共享的缓存，项目里只放最终那一个 exe。
Tauri 壳里没有任何业务逻辑，只负责给一个原生窗口和 WebView2。

### 3. 局域网主机（可选）

```bash
python lan-host.py 8080
```

会打印局域网地址，同一个 Wi-Fi 下打开就能拿到游戏。
背景：浏览器不能监听端口、不能收广播，也没有 mDNS 浏览 API，所以「自动搜索房间」
必须有一台机器在监听 —— 这个脚本就是那一台。页面侧的一键进房 UI 还没接。

## 联机

### 桌面版：局域网自动搜房（推荐）

桌面版里 Rust 侧内嵌了信令服务 + UDP 广播探测，同一个 Wi-Fi 下：

1. 主机：「联机对战」→「**开个房间**」
2. 客机：「联机对战」→「**搜索房间**」→ 列表里点「加入」

不用交换任何连接码，也不用跑 `lan-host.py`。

### 浏览器版：手动交换连接码

纯浏览器没有原生侧那半边能力 —— 网页不能监听端口、不能收 UDP 广播、也没有 mDNS 浏览 API，
所以「搜索房间」那一块**在浏览器里会整个隐藏**，自动退回手动连接码。
前端核心逻辑一行都没为桌面版改过，同一份 `index.html` 两边都跑。

### 端口

| 用途 | 端口 |
|---|---|
| 信令 HTTP | 优先 **47812**，被占（例如同机开了第二个实例）则退回系统随机分配 |
| UDP 探测 | 固定 **47811**；被占则本机不做应答，其它功能照常 |

### 跨网（EasyTier 虚拟局域网）

联机面板上选「**跨网**」：

1. 先准备二进制：`npm run fetch:easytier`
   （走 ghfast.top 镜像下载，因为不少机器把 github.com 整个 hosts 掉了）
2. 两边填**一样的**网络名和密码 →「启动虚拟局域网」
3. 虚拟网起来之后，面板上会出现「搜索房间 / 开个房间」—— 和同一个 Wi-Fi 时**用法完全一样**

原理：EasyTier 会把你们接进同一张虚拟局域网，而它有一个
`--enable-udp-broadcast-relay`（仅 Windows）会把本机 UDP 广播转发给对端节点，
官方说明就是「帮助局域网游戏发现房间」—— 正好让上面那套 UDP 搜房跨网生效。
所以跨网不是另写一套联机，而是**把跨网变成局域网**。

**两个前提**：

- **需要管理员权限**：EasyTier 建虚拟网卡绕不开 TUN/wintun。没管理员时程序会明确提示，
  而不是让你干等；EasyTier 自己的日志在面板里也能看到。
- **需要一个会合点**：官方的 `public.easytier.cn` 已经 NXDOMAIN 了。
  可以填社区共享节点的 IP（`tcp://IP:11010`），或者自己起一台 ——
  所谓公共共享节点，就是「网络名密码相同的普通 EasyTier 节点」，放在有公网 IP 的机器上即可。

**不装 EasyTier 的退路**：面板上的「连接码」类型仍然可用；
配合自建 coturn / 商业 TURN（填进「ICE 服务器」框）一样能跨网。

### 联机类型对照

| 类型 | 需要什么 | 怎么用 |
|---|---|---|
| 局域网 | 同一个 Wi-Fi | 一边「开个房间」，另一边「搜索房间」→ 加入 |
| 跨网 | 管理员权限 + 会合点 | 两边填一样的网络名密码 → 起来后同局域网 |
| 连接码 | 无 | 手动把码发给对方 |

浏览器版只有「连接码」一种，类型选择器整个隐藏 —— 那两种都要原生侧才做得到。

## 目录

```
index.html                  前端全部代码（HTML + CSS + JS 都在这一个文件里）
assets/global.css           只有 body { margin: 0 }
lan-host.py                 可选的局域网主机 / 信令中转（Python 标准库）
src-tauri/src/lan.rs        内嵌信令服务 + UDP 广播探测
src-tauri/src/easytier.rs   EasyTier 进程管理（跨网）
src-tauri/binaries/         EasyTier 二进制（不入库，npm run fetch:easytier 下载）
scripts/sync-web.mjs        把前端拷进 dist/
scripts/pack-exe.mjs        把 exe 拷到 src-tauri/target/release/
scripts/fetch-easytier.mjs  下载 EasyTier
```

## 发布

### 出一个「完整可运行」的包

```bash
npm run dist
```

依次做三件事：下载 EasyTier（还没有的话）→ 编译并打包 exe → 组装便携包。产物：

```
release/snake-army-1.0.0-win-x64.zip      14.5 MB
  snake-army.exe                           3.11 MB   主程序（前端已经嵌进去了）
  binaries/easytier-core.exe              23.27 MB   跨网用
  binaries/easytier-cli.exe                9.51 MB   排查用
  binaries/wintun.dll                      0.41 MB   虚拟网卡驱动
  binaries/Packet.dll                      0.21 MB   WinDivert 用户态 DLL
  binaries/WinDivert64.sys                 0.09 MB   UDP 广播转发要的内核驱动
  README.md
```

解压就能双击跑，不用安装，也不用单独去下 EasyTier。

**`binaries/` 里五个文件一个都不能少。** 少 `Packet.dll` 的话
`easytier-core.exe` 会直接以 `0xC0000135`（STATUS_DLL_NOT_FOUND）退出，
连日志都来不及打。这是实测踩出来的：第一版就漏了，包里的 EasyTier 起不来。

### 发到 Gitee Releases

仓库在 Gitee，而且这台机器的 hosts 把 github.com 整个指到了 127.0.0.1，所以发行版发 Gitee：

**网页**：仓库 →「发行版」→「新建发行版」，填 tag（比如 `v1.0.0`），
把上面那个 zip 传上去。

**或者 API**：

```bash
curl -X POST "https://gitee.com/api/v5/repos/nxbznine_bilibili/h5-snake-army/releases" \
  -d "access_token=<你的令牌>" \
  -d "tag_name=v1.0.0" \
  -d "name=贪吃蛇 v1.0.0" \
  -d "body=首个可发布版本"

# 拿到 release id 之后传附件：
curl -X POST "https://gitee.com/api/v5/repos/nxbznine_bilibili/h5-snake-army/releases/<id>/attach_files" \
  -d "access_token=<你的令牌>" \
  -F "file=@release/snake-army-1.0.0-win-x64.zip"
```

安装器（NSIS/MSI）这条路**没走**：Tauri 的打包工具要从 GitHub 现场下载，
而本机 hosts 把 github.com 整个指到了 127.0.0.1。便携包解压即用，够用。

### 版本号写在哪

两处要一起改：`package.json` 的 `version`（决定 zip 文件名）和
`src-tauri/tauri.conf.json` 的 `version`（决定程序属性里的版本），
另外前端 `index.html` 里的 `APP_VERSION` 管的是联机握手时的版本校验。

## 联机的已知边界

已验证：

- 局域网房间端到端跑通（两个无头浏览器 + 真实内嵌信令服务）：搜索到房间 → 点加入 →
  双方 `open=true`、`count=2`、`errs=[]`。
- EasyTier 的进程管理跑通（有单元测试）：能找到二进制、按参数拉起、读到日志、停掉。

未验证 / 有前提：

- **真实的跨网连接没在这台机器上验证过**：EasyTier 建虚拟网卡需要管理员权限，
  而当前账户不是管理员（`is_admin = false`，也没有 wintun 驱动）。
  要真正跑通，需要以管理员身份运行，并且两台机器都在。
- 官方的 `public.easytier.cn` 已失效，得另外找会合点。
- WebRTC 直连只在**本机回环**验证过；真实局域网 / 公网需要两台真机。
- 公共免费 TURN 实测**全部失效**，所以纯 WebRTC 方案在对称 NAT 下打不通。
- 同一个 Wi-Fi 下如果连不上，直接填对方的局域网 IP（面板上的第二个输入框）通常能解决。
