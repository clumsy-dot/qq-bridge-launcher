# qq-bridge-launcher

<p align="center"><img src="assets/preview.png" width="140" alt="icon"></p>

> Windows 上把 **QQ → SnowLuma → DeepSeek Harness → qq-bridge** 这条链路一键拉起来的小工具，支持多 QQ 账号、自动分配 OneBot 端口、自动处理 DSH 随机端口。

A tiny Windows launcher that boots the whole `QQ → SnowLuma → DeepSeek Harness → qq-bridge` chain in one click, with multi-account support (auto port assignment) and account switching.

---

## 它解决什么问题

这套链路平时启动很麻烦，踩过的坑：

| 坑 | 本工具的做法 |
| --- | --- |
| 四个组件有启动顺序（桥接要连 SnowLuma 的 OneBot 端口 + DSH 的 Web API） | 按依赖顺序自动启动，缺谁补谁 |
| **DSH 桌面版每次启动的 Web 端口都是随机的**，而 qq-bridge 的 `dsh.baseUrl` 是写死的 | 从 DSH 进程反查当前端口，自动写回桥接配置 |
| **多个 QQ 账号的 OneBot 默认都用 3000/3001**，一起启动必然 `EADDRINUSE` | 按 QQ 号升序自动分配独立端口：第 1 个 `3000/3001`、第 2 个 `3010/3011`… |
| **SnowLuma 每次重启都要人工点「加载进程注入」**，账号才接入 OneBot | 打开 `hookAutoLoad`，启动时自动注入每个发现的 QQ 进程 |
| QQ 客户端自重启（`--relaunch`）后，SnowLuma 进程还在但 OneBot 端口消失 | 检测到"进程在、端口没"就自动杀掉重启 |
| 桥接的 token 自愈可能把连接切到另一个账号 | 把桥接**钉死**在选定账号的端口 + token 上（`followDiscoveredEndpoint: false`） |

## 部署时会修改什么（重要）

**本工具运行时一定会改写 qq-bridge 和 SnowLuma 的配置文件** —— 这是它工作的方式，不是可选项：

| 目标项目 | 文件 | 改写的字段 |
| --- | --- | --- |
| SnowLuma | `config/runtime.json` | `hookAutoLoad` → `true` |
| SnowLuma | `config/onebot_<QQ号>.json` | `networks.httpServers[0].port`、`networks.wsServers[0].port` |
| qq-bridge | `config.json` | `dsh.baseUrl`、`dsh.authToken`、`snowluma.{wsUrl,httpUrl,accessToken,followDiscoveredEndpoint,homeDir}` |
| qq-bridge | `state/active-qq.txt` | 当前接入的 QQ 号 |

> 上表只列出**字段名**，不含任何实际值：token、真实 QQ 号、本机路径都不会出现在本仓库里（`<QQ号>` 是占位符）。

保障措施：

- **只在值不同时才写**（幂等，重复运行不会反复改动）
- 每次改写前自动备份为 `*.bak-<时间戳>`（保留最近 20 份）
- **不会碰**这两个项目的源码、SnowLuma 的 `index.mjs`/前端、QQ 客户端、`%USERPROFILE%\.dsh` 下的 DSH profile 与凭据
- 想先看会改哪些文件？用**预演模式**，它只打印计划、不写任何文件、不启动/重启任何程序：

```bat
node src/cli.cjs --dry-run
```

## 前置条件

1. Windows 10 / 11
2. [Node.js](https://nodejs.org/) 18+（建议 22+）
3. 已安装并配置好 **SnowLuma**（含登录 QQ、开启 OneBot HTTP/WS）
4. 已安装 **DeepSeek Harness** 桌面端
5. 已克隆并 `npm install` 过 **qq-bridge**，且已经跑过它的 DSH 端安装（见 qq-bridge 的 `docs/guides/DSH_SETUP.md`）

> 本工具只负责"把已经装好的东西按正确顺序拉起来、把配置对接对"，不安装/不修改上面三个项目本身。

## 快速开始

```bat
:: 1. 克隆到任意目录（建议路径不含空格）
git clone https://github.com/clumsy-dot/qq-bridge-launcher.git qq-bridge-launcher
cd qq-bridge-launcher

:: 2. 首次配置（也可以直接双击 setup.bat）
node src/cli.cjs --init

:: 3. 先预演一遍，确认会改哪些文件（不会写入、不会启动）
node src/cli.cjs --dry-run

:: 4. 一键启动（也可以直接双击 start.bat）
node src/cli.cjs
```

首次配置会逐项确认（直接回车采用自动探测结果）：

```
① QQ 客户端 QQ.exe 路径              [自动探测结果]
② SnowLuma 安装目录（含 launcher.bat）
③ DeepSeek Harness 程序路径
④ qq-bridge 仓库目录（含 start.bat）
⑤ 想固定接入的 QQ 号（留空 = 每次启动时询问/使用上次选择）
```

配置写入 `config.json`（**已被 .gitignore 排除**，不要提交）。

## 使用方式

### 第一次使用

1. 装好 Node.js 18+（建议 22+），以及前置条件里的 QQ / SnowLuma / DSH / qq-bridge
2. 把本仓库克隆到任意目录（路径别含空格）
3. 双击 **`setup.bat`**，逐项回车确认自动探测到的路径；想固定接入某个 QQ 就填号码
4. （建议）跑一次 `node src/cli.cjs --dry-run`，先看清楚会改动哪些文件
5. 双击 **`start.bat`** 正式启动

### 以后每次（比如开机之后）

**双击 `start.bat` 就行。** 它会按依赖顺序补齐：

```
DSH 桌面端 → QQ 客户端 → SnowLuma（自动注入）→ qq-bridge（自动同步 DSH 端口、钉住账号）
```

- 成功标志：最后打印 `全部就绪：<QQ号> 已接入，现在可以在 QQ 上给机器人发消息了。`
- **弹出的窗口不要关**：
  - `start.bat` 是桥接的守护窗口，关了桥接就停了（5 秒自动重启机制也依赖它）
  - SnowLuma / QQ 的窗口同理
  - 启动脚本自己的窗口会停在「你可以关闭此窗口」，关掉它不影响后台组件
- 如果 QQ 客户端自己重启过导致 Hook 失效，工具会检测到并自动重启 SnowLuma

### 换接入的 QQ 账号

双击 **`select-account.bat`**，按提示输入 QQ 号（或列表序号），确认后会自动改配置并重启桥接：

```
检测到以下 QQ 账号：
  1) 123456789   OneBot HTTP 3000 / WS 3001
  2) 987654321   OneBot HTTP 3010 / WS 3011
  0) 取消

请输入要接入桥接的 QQ 号（直接回车 = 123456789）：
```

### 放到桌面（可选）

`start.bat` / `select-account.bat` 右键 → **发送到 → 桌面快捷方式**；再右键快捷方式 → 属性 → **更改图标** → 选 `assets\icon.ico`。

### 想确认它在干什么

| 想知道 | 看哪里 |
| --- | --- |
| 这次会改什么（不改任何东西） | `node src/cli.cjs --dry-run` |
| 有哪些账号可用 | `node src/cli.cjs --list` |
| 桥接当前状态 | 控制台 http://127.0.0.1:3100 |
| 连接/报错日志 | `<qq-bridge>\state\bridge.log` |
| SnowLuma 注入情况 | `<SnowLuma>\logs\snowluma-<日期>.log` 里的 `[Hook]` 行 |

## 日常使用

| 操作 | 双击 | 命令行 |
| --- | --- | --- |
| 一键启动（使用上次选的账号） | `start.bat` | `node src/cli.cjs` |
| 预演：只看会改哪些文件 | — | `node src/cli.cjs --dry-run` |
| 切换接入的 QQ 账号 | `select-account.bat` | `node src/cli.cjs --ask` |
| 指定 QQ 号启动 | — | `node src/cli.cjs --qq 123456789` |
| 列出 SnowLuma 里已接入的账号 | — | `node src/cli.cjs --list` |
| 修改安装路径 | `setup.bat` | `node src/cli.cjs --init` |

选择账号时的界面：

```
检测到以下 QQ 账号：
  1) 123456789   OneBot HTTP 3000 / WS 3001
  2) 987654321   OneBot HTTP 3010 / WS 3011
  0) 取消

请输入要接入桥接的 QQ 号（直接回车 = 123456789）：
```

## 端口约定

| 用途 | 端口 |
| --- | --- |
| 第 1 个账号 OneBot HTTP / WS | 3000 / 3001 |
| 第 2 个账号 OneBot HTTP / WS | 3010 / 3011 |
| 第 3 个账号 | 3020 / 3021 |
| … | 步进 10 |
| qq-bridge 本地控制台 | 3100（由 qq-bridge 配置决定） |

端口只按 **QQ 号升序** 固定分配，所以切换账号不需要改端口；只有**新账号加入**时才需要重启一次 SnowLuma（工具会自动做）。

## 工作原理

1. **探测 DSH 端口**：`Get-NetTCPConnection` 找出 `DeepSeek Harness` 进程监听的端口。
2. **确保 SnowLuma 运行**：进程不在就启动；进程在但所有 OneBot 端口都没了就判定 Hook 失效并重启。
3. **读账号**：扫描 `<SnowLuma>/config/onebot_<QQ号>.json`，得到每个账号的端口与 token。
4. **分配端口**：按 QQ 号升序改成 `3000/3001`、`3010/3011`…（有改动才重启 SnowLuma）。
5. **开自动注入**：把 `<SnowLuma>/config/runtime.json` 的 `hookAutoLoad` 设为 `true`，启动时再传 `SNOWLUMA_HOOK_AUTOLOAD=1` 双保险。
6. **钉定桥接**：写 `qq-bridge/config.json` 的 `dsh.baseUrl`（当前 DSH 端口）和 `snowluma.{wsUrl,httpUrl,accessToken,followDiscoveredEndpoint:false,homeDir}`。
7. **重启桥接**：配置有变化时调用桥接控制台 `POST /api/restart`（需 `state/console-token`），由 `start.bat` 守护窗口自动拉起。
8. **验证**：等桥接日志出现「SnowLuma 已连接 / DSH 已就绪」，打印状态表。

所有写文件动作都会先做时间戳备份（`*.bak-<ISO 时间>`，自动保留最近 20 份）。

## 常见问题

**Q: 报 `EADDRINUSE: 127.0.0.1:3000`**
多账号端口冲突。跑一次 `start.bat`，本工具会重新分配端口并重启 SnowLuma。

**Q: SnowLuma 日志里一直没有 `[Hook] login detected`**
QQ 没登录或停在登录界面；也可能是 QQ 客户端刚自重启过。登录 QQ 后重跑 `start.bat`。

**Q: 桥接日志反复 `token 自愈失败 / 连不上 OneBot HTTP API`**
SnowLuma 的 OneBot 端口没起来（见上一条）。本工具每次启动都会检查。

**Q: DSH 重启后桥接连不上（`事件流中断: fetch failed`）**
DSH 换了随机端口。重跑 `start.bat` 即可自动同步。

**Q: 启动 DSH 报 `cannot resolve profile bundle`**
这是 qq-bridge 的 DSH 端安装问题，与本工具无关。按 qq-bridge 文档执行 `dsh plugin --profile <profile> install` 后重启 DSH。

**Q: 一个桥接实例能同时接多个 QQ 账号吗？**
不能，SnowLuma 的 OneBot 端点是一对一的。要同时跑两个机器人，需要两个桥接实例（各自独立的 `consolePort`、`state` 和工作目录），本工具目前按"一次接入一个账号"设计。

## 文件与路径

本工具会读写下面这些文件（`<项目>` = 本仓库目录，`<SnowLuma>` = SnowLuma 安装目录，`<qq-bridge>` = qq-bridge 仓库目录）：

| 文件 | 位置 | 谁在读写 | 作用 |
| --- | --- | --- | --- |
| 启动器配置 | `<项目>/config.json` | 工具读写 | 本机路径、固定 QQ 号；**已被 .gitignore 排除** |
| 当前接入账号 | `<qq-bridge>/state/active-qq.txt` | 工具写入 | 记住上次选择的 QQ 号 |
| SnowLuma 运行时设置 | `<SnowLuma>/config/runtime.json` | 工具写入 | 把 `hookAutoLoad` 设为 `true`（免手动加载注入） |
| 账号 OneBot 配置 | `<SnowLuma>/config/onebot_<QQ号>.json` | 工具改写端口 | 每个账号各自的 HTTP/WS 端口与 token |
| SnowLuma 日志 | `<SnowLuma>/logs/snowluma-<日期>.log` | 只读 | 排错看 `[Hook]` / `[OneBot]` |
| 桥接配置 | `<qq-bridge>/config.json` | 工具改写 | `dsh.baseUrl`、`snowluma.{wsUrl,httpUrl,accessToken,...}` |
| 桥接日志 | `<qq-bridge>/state/bridge.log` | 只读 | 判断「SnowLuma 已连接 / DSH 已就绪」 |
| 桥接控制台 token | `<qq-bridge>/state/console-token` | 只读 | 调 `POST /api/restart` 需要 |
| DSH 凭据 | `%USERPROFILE%\.dsh\.credentials.yaml` | 不由本工具改 | 桥接据此离线铸造登录 Cookie |
| 自动备份 | 被改文件旁边 `*.bak-<ISO时间>` | 工具生成 | 每次改写前备份，保留最近 20 份 |

**具体改写的字段（只在值不同时才写，写前自动备份）：**

- `<SnowLuma>/config/runtime.json` → `hookAutoLoad = true`
- `<SnowLuma>/config/onebot_<QQ号>.json` → `networks.httpServers[0].port` / `networks.wsServers[0].port`（按 QQ 号升序分配）
- `<qq-bridge>/config.json` → `dsh.baseUrl`、`dsh.authToken`、`snowluma.{wsUrl,httpUrl,accessToken,followDiscoveredEndpoint,homeDir}`
- `<qq-bridge>/state/active-qq.txt` → 当前接入的 QQ 号

**本工具不会碰：**

- SnowLuma 主程序与前端（`index.mjs`、`client/`、`native/`）
- qq-bridge 源码（`src/*`、`start.bat` 等）
- QQ 客户端
- `%USERPROFILE%\.dsh` 下的 profile 与凭据（DSH 端的 preset / MCP 安装需要按 qq-bridge 的 `setup-dsh.mjs` 自行执行，本工具不代跑，避免擅自改你的 DSH 配置）
- 桌面快捷方式（本工具只提供 `start.bat` / `setup.bat` / `select-account.bat`，快捷方式由用户自己创建）

> 工具只操作本地进程、端口和上述配置文件，不联网、不上传任何数据。

## 目录结构

```
qq-bridge-launcher/
├─ start.bat              # 一键启动
├─ setup.bat              # 首次配置向导
├─ select-account.bat     # 切换接入的 QQ 账号
├─ config.example.json    # 配置模板（不含任何真实路径/QQ 号）
├─ assets/
│  ├─ preview.png         # README 顶部展示图（384×384 原图）
│  └─ icon.ico            # Windows 图标（16~256 多尺寸，由原图直接生成）
├─ src/
│  ├─ cli.cjs             # 入口 & 编排
│  ├─ config.cjs          # 配置读写 / 首次向导 / 路径自动探测
│  ├─ dsh.cjs             # DSH 进程与随机端口发现
│  ├─ snowluma.cjs        # 账号发现 / 端口分配 / hookAutoLoad / 启停
│  ├─ bridge.cjs          # 桥接配置改写 / 账号钉定 / 重启 / 日志状态
│  └─ util.cjs            # 进程、端口、窗口启动、日志等基础工具
└─ state/                 # 运行时状态（当前账号，gitignore）
```

## 安全性

- 不联网、不收集任何数据，只操作本机进程/端口/配置文件。
- `config.json` 只有本机路径和你可选的 QQ 号；qq-bridge 的 `config.json` 里含有 OneBot token，**两者都不要提交**（`.gitignore` 已处理）。

## 免责声明

- 本项目是**非官方第三方工具**，与腾讯（QQ）、SnowLuma、DeepSeek 均无任何隶属、合作或背书关系。文中出现的 `QQ`、`DeepSeek Harness`、`SnowLuma` 等名称仅用于说明兼容性，相关商标归各自所有者。
- 本项目**不包含、不分发**上述软件的任何代码、二进制或资源。运行时只是启动你本机已安装的程序，并读写本 README「部署时会修改什么」一节列出的配置文件。
- 上游软件各有自己的许可协议（例如 SnowLuma 为「源码可见非商业许可」，qq-bridge 为 MIT）。**请自行确认你的使用场景符合它们的条款**；本项目仅面向个人、非商业用途。
- 使用非官方协议工具接入 QQ **可能违反腾讯的用户协议并带来账号风险**（封禁、限制等），请自行评估并**风险自负**；作者不对账号、数据或其它损失承担责任。

## 致谢

- [qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）—— 桥接本体，本工具负责把它和 SnowLuma / DSH 串起来。
- SnowLuma、DeepSeek Harness —— 本工具对接的上游程序（不在本仓库内）。

## License

本项目**代码**以 [MIT](LICENSE) 发布。`assets/preview.png` / `assets/icon.ico` 是项目自带的图片素材，不属于 MIT 授权范围；若你二次分发，请自行确认该图片的授权情况。
