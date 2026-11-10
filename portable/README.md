# DeepSeek Harness 便携版（U 盘版）

把 DeepSeek Harness 的 Web 前端套进 Electron 外壳，做成一个**双击即用、免安装、数据随盘走**的 Windows 便携程序。

产物默认落在 **源码所在盘符** 的 `\AI\deepseek-harness-protable`——本机源码在 `F:` 盘，所以实际路径是 `F:\AI\deepseek-harness-protable`（目录名沿用最初指定的拼写 `protable`，不是 `portable`）。

盘符只影响**编译时把文件写到哪**，不影响程序本身：产物以 exe 所在目录为根目录，U 盘插到任何电脑、被分配成任何盘符都能直接运行（见下表的「换电脑自动识别路径」）。

## 源码从哪来：三个仓库各管什么

| 角色 | 位置 | 作用 |
|---|---|---|
| 官方源码仓（上游） | `https://github.com/deepseek-ai/deepseek-harness` | MIT，59 个包组。**版本以这里为准**：官方发 `dsh-v*` tag，同时把 `@deepseek-ai/dsh` 发到 npm |
| 本机源码副本 | 工作区里的 `deepseek-harness-master\`（与 `deepseek-harness-portable\` 同级） | 官方仓的**快照**（`@deepseek-ai/dsh-root` 0.2.2-alpha.3，没有 `.git`）。只用来取原始图标、查实现细节，不参与构建 |
| fork 容器 | `https://github.com/lentll/deepseek-harness` | 从官方仓 fork 出来的个人副本，**只为放 `protable` 分支和跑 Actions**；它的 `master` 是上游快照，不承载任何外壳代码 |

升级链路是单向的：

```
官方仓打 tag dsh-v<版本>  →  npm 发布 @deepseek-ai/dsh@<版本>  →  本工程安装该版本 + 套 Electron 外壳
```

CI 每天直接查**官方仓**的 releases（`UPSTREAM_REPO: deepseek-ai/deepseek-harness`），不依赖 fork 的 `master` 是否同步过——所以 fork 落后于上游不影响出包。

## 它做了什么

| 需求 | 实现 |
|---|---|
| 像桌面版而不是浏览器页面 | Electron `BrowserWindow` 承载同一个 Web UI，`Menu` 置空，外链走系统浏览器 |
| 免安装、双击 exe | 直接把 Electron 运行时铺在目录根，`DeepSeek Harness.exe` 即入口 |
| 数据全部随 U 盘 | `$DSH_HOME`、`$DSH_AGENTS_HOME`、Chromium 的 userData/cache/crashDumps/logs/temp 全部重定向到 `data\` |
| 本机零残留 | 不写注册表、不写 `%APPDATA%`；原生加载器缓存用 `NARB_NATIVE_CACHE_DIR` 拉回盘内 |
| 换电脑自动识别路径 | 以 exe 所在目录为根；检测到根变化时，把会话/设置里记录的旧绝对路径批量改写，并留备份与报告 |
| 缓存也随盘走 | Chromium 的 HTTP/GPU/Shader 缓存、Local Storage、原生加载器缓存、崩溃转储、dsh 的 spill/临时文件全部落在 `data\` |
| 带数字签名 | 构建末尾用自签名代码签名证书签 exe（SHA256 + DigiCert 时间戳），可验篡改 |
| 程序与数据分离 | 程序在根目录 + `resources\`，数据只在 `data\`，升级只覆盖程序 |

## 目录

```
deepseek-harness-portable\
  src\
    main.js               Electron 主进程：窗口、生命周期、启动编排
    portable.js           便携路径推导、Electron 路径重定向、子进程环境
    dsh-server.js         启动 dsh Web 服务（ELECTRON_RUN_AS_NODE）、解析带 token 的 URL
    path-migration.js     换盘/换机后的绝对路径自愈
    splash.html           启动画面
  scripts\
    build-portable.mjs    组装最终产物
    progress.mjs          带百分比的整树拷贝（逐个文件复制 + 进度行）
    make-icon.mjs         PNG → 多尺寸 ICO
    sign-exe.ps1          自签名代码签名证书 + Authenticode 签名
  runtime\                由 npm 安装的 dsh 运行时（@deepseek-ai/dsh + 依赖）
  build\icon.ico
```

## 运行时为什么用 npm 包而不是源码

官方仓本体（`deepseek-ai/deepseek-harness`）是 59 个包组、约 139 万行 TypeScript 的 monorepo，`pnpm install + build` 需要 Node ≥ 24.9、MSVC 工具链与长时间构建。
`@deepseek-ai/dsh` 在 npm 上已发布完整运行时（含内置 Web 前端产物 `@deepseek-ai/dsh-web-frontend/dist`），因此本方案直接安装发布版，稳定、可重复。

**Electron 版本必须精确为 `44.7.0`**：dsh 的 `node-addon-require-builtin` 只认白名单内的 Electron 指纹（43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6），其余版本会在启动时报 `unsupported Electron runtime fingerprint` 并退出。Electron 44.7.0 内置 Node 24.21.0，满足 dsh 的 Node ≥ 24.9。

## 构建

```sh
npm install                      # electron@44.7.0 + resedit + sharp
npm install --prefix runtime @deepseek-ai/dsh@0.2.2-rc.1   # 当前出包版本；换版本见下
node scripts/make-icon.mjs       # 生成 build/icon.ico
node scripts/build-portable.mjs  # 输出到 <源码盘符>:\AI\deepseek-harness-protable
```

输出目录默认取**源码目录所在盘符** + `\AI\deepseek-harness-protable`，源码在哪个盘就写到哪个盘，脚本里不写死盘符；想换位置加 `--out <目录>`，或用环境变量 `DSH_PORTABLE_OUT` 固定。

版本号取自**官方仓**的 release tag：`dsh-v0.2.2-rc.1` → `0.2.2-rc.1`（去掉 `dsh-v` 前缀）。本地要跟新版就改上面那行版本号再跑；CI 出包时由 Actions 页面 Run workflow 里的 `version` 决定（留空则取 master `package.json` 与上游最新 release 中较大的那个）。

`build-portable.mjs` 是**幂等覆盖、从不删除**：不该进包的内容（多余 locale、`*.map`、`default_app.asar`）在复制阶段就被过滤，因此重复构建不会触发批量删除，也不会动 `data\`。

### 构建时的进度显示

两段大拷贝（Electron 载荷约 320 MB、dsh 运行时约 1.4 GB / 13 万个文件）都走 `scripts/progress.mjs`：先统计源目录的总字节与文件数，再逐个文件复制并刷新一行进度，不用再盯着黑屏猜是不是卡住。

```text
[build] copying dsh runtime  42%  623/1398 MB  58800/131113 files
```

- 在**终端**里这行用 `\r` 原地刷新，约每 120 ms 一次，行尾自动补空格覆盖上一次的残留；
- 输出被**重定向或跑在 CI** 时改为每前进 10% 打一行（最多 11 行），避免把 13 万个回车塞进日志；
- 每个阶段结束时补一行汇总：`[build] copying dsh runtime: 1398 MB, 131113 files in 251.9s`；
- 进度行刻意只用 ASCII：`\r` 覆盖要按字符数补空格，中文是全角、占两列，混进去会算错宽度。

`ci/_test-progress.mjs` 用 23 条断言锁住三个容易出错的方向：百分比提前到 100%（字节统计错）、文件漏拷（包不完整）、CI 日志被回车刷屏。

## 更新（一键）

改完 `src\` 里的外壳代码、或想换 dsh 运行时版本后，**双击项目根目录的 `一键更新.cmd`** 即可，不用记命令。

它依次做这些事：

1. 检查 Node 是否存在（没有就提示去装）；
2. 校验目标目录里有 `portable.marker`，防止把 1 GB 构建倒进别人的目录；
3. 记录更新前的运行时版本、会话数、`data\dsh-home` 文件数；
4. 检测并关闭正在运行的程序（`taskkill /T`，含 dsh 子进程），否则 exe 被占用无法替换；
5. 传了 `--version` 就先 `npm install` 该版本运行时到 `runtime\`；
6. 调 `build-portable.mjs` 就地覆盖程序文件，**从不删除、从不碰 `data\`**；
7. 重新签名，读回签名状态，把本次更新写进 `data\logs\update-history.log`；
8. 对比更新前后的数据数量，不一致则返回码 2 提醒。

### 常用变体

```bat
一键更新.cmd                                  :: 只更新当前代码
一键更新.cmd --version latest                 :: 顺带把 dsh 运行时升到 npm 最新版
一键更新.cmd --version <版本号>               :: 指定版本（也可用来回滚）
一键更新.cmd --out "<任意目录>"               :: 换输出位置（该目录需已有 portable.marker）
```

命令行等价写法：`node scripts\update.mjs [--version <ver>] [--out <dir>]`。

不传 `--out` 时用上面「构建」里的默认目录（源码盘符 + `\AI\deepseek-harness-protable`），换盘不用改脚本。

### 更新的前提

更新动作发生在**源码目录**（`deepseek-harness-portable\`，需要 Node + `node_modules` + `runtime\`），不是 U 盘上的产物目录；U 盘上的包只负责运行。想在另一台机器更新，把源码目录一起带过去，或在那台机器装 Node 再拷源码。

### 回滚

- 运行时版本：`一键更新.cmd --version <旧版本号>`，npm 装回旧版并重建。
- 外壳代码：项目没接 git，回滚靠自留副本；建议改完把 `src\` 复制一份到 `src.bak\`。

## 签名

`build-portable.mjs` 最后一步调用 `scripts/sign-exe.ps1`，顺序不能颠倒：`resedit` 写入图标与版本资源会重写整个 PE 文件，之前的摘要立刻作废。

- 证书：`Cert:\CurrentUser\My` 里 `CN=JiYuan LvDong Studio, O=JiYuan LvDong, C=CN` 的自签名代码签名证书（EKU 1.3.6.1.5.5.7.3.3，RSA 2048，SHA256，有效期 10 年），脚本会复用同一张，没有则自动创建。
- 签名：Authenticode + SHA256，时间戳走 `http://timestamp.digicert.com`（离线时自动降级为不带时间戳）。
- 结果：`Get-AuthenticodeSignature` 报 `UnknownError - 证书链在不受信任的根终止` 是自签名的**预期状态**，签名本身有效；文件属性里能看到签名者与有效期。要消除 SmartScreen 提示必须换成付费 OV/EV 证书。
- 重新构建后必须重新签名，否则签名失效（构建脚本已自动化）。

## 缓存落点

本机 `%APPDATA%` / `%LOCALAPPDATA%` 不留任何新增（`%LOCALAPPDATA%` 里 `electron`、`node-addon-native-custom-loader` 两项的时间戳停在上一次 `npm install` 时刻，运行 App 不会刷新）。

| 缓存 | 位置 |
|---|---|
| HTTP 磁盘缓存、Code Cache、GPU/Shader 缓存、Local Storage | `data\electron\session-data\` |
| Chromium userData（`Preferences`、`Local State`） | `data\electron\session-data\` |
| 原生插件编译缓存（`NARB_NATIVE_CACHE_DIR`） | `data\electron\native-cache\` |
| 崩溃转储 | `data\electron\crash-dumps\` |
| dsh spill、技能解包、ACL 锁 | `data\tmp\` |
| 运行日志 | `data\logs\` |

实测：运行一次后 `data\tmp` 新增 `dsh-spill-*`、`dsh-acl-skill-*`，主机 `%TEMP%` 条目数不变（50 → 50），且其中旧的 `dsh-*` 时间戳停在修复前的测试时刻。

## 云端构建（GitHub Actions）

本工程同时以 `portable/` 的形式维护在 fork `lentll/deepseek-harness` 的 `protable` 分支（外壳源码与 workflow 同址），`master` 上另有一份负责一键出包的 `build-portable.yml`。细节见 `推送指南.md`，要点：

- **上游是谁**：`env.UPSTREAM_REPO` 指向官方仓 `deepseek-ai/deepseek-harness`，按它的 release 列表取最新 `dsh-v*`（`/releases/latest` 会跳过 prerelease，而 dsh 只发 prerelease，所以列出来自己挑）。fork 的 `master` 只是上游旧快照，**不需要同步**，也不参与出包。
- **分支形态**：`protable` 是**独立根分支**（不含上游代码），只放 `portable/` 与 workflow。原因：本机到 GitHub 仅约 33 KB/s，完整克隆 353 MB 的上游仓库不现实，独立分支只有约 200 KB，CI 检出也快。
- **触发方式只有手动**：两份 workflow 都去掉了 `schedule` 和 `push`，同步上游、改外壳、提交代码都不会自己开跑；要出包就点 Run workflow。原因：一次构建 8–12 分钟且要下载 1.3 GB 依赖，自动跑容易在你没准备时占掉额度、覆盖 Release。
- **版本映射**：GitHub tag `dsh-v0.2.2-rc.1` → npm 包 `0.2.2-rc.1`；tag 已打但 npm 未发布时任务跳过并告警。
- **产物**：Release `portable-v<版本>` + `DeepSeek-Harness-portable-<版本>.7z`（**排除 `data/`**，因此不含任何 API Key）。
- **两道去敏守卫**：构建前先扫**仓库源码**（`scripts/check-secrets.mjs`：`.env`/`.credentials.yaml`/`*.pfx`/`*.pem` 等文件名，以及 `sk-` 密钥、GitHub token、PEM 私钥块、AWS key 的明文），命中即中断；构建后再扫 **`out\` 产物**（同上文件名 + `resources\app` 里的 `sk-` 明文），命中同样中断。前者防「提交进仓库但没进包」，后者防「构建过程新写的」，两者互补。命中报告只给文件名和行号，不打印命中的密文，避免 CI 日志变成新的泄露面。
- **签名**：`SIGNING_PFX_BASE64` / `SIGNING_PFX_PASSWORD` 两个 secret 已配置，构建末尾会给 `DeepSeek Harness.exe` 挂上自签证书与时间戳；secret 为空时该步骤自动跳过、不影响出包。

### 从主仓库一键构建（master 上的 build-portable.yml）

`master` 上另有一份 `.github/workflows/build-portable.yml`，让「更新主仓库后一键出包」不依赖切默认分支：

- **入口**：Actions → **Build portable (master)** → Run workflow。默认分支就是 master，所以按钮一直在。
- **版本**：填 `version` 就用它（不在 npm 上直接报错）；不填则取「本分支 `package.json` 版本」与「上游最新 `dsh-v*`」中较大的那个，若它还没发到 npm 就自动退回另一个——master 经常带着「已合并、未发布」的版本号。
- **外壳仍来自 protable**：先 checkout master 读版本，再把 `protable` 检出到 `portable-src/` 构建，上游源码与外壳不混在一起。
- **同名 Release**：已存在就直接跳过（避免误覆盖别人已下载的包），确实要重建时勾 `force`。

文件本地副本在 `ci/build-portable.yml`（改完贴回 GitHub），`ci/_test-semver.ps1` 与 `ci/_test-resolve.ps1` 是版本比较、版本选择的离线单测（12 + 6 条断言），`ci/_test-secrets.mjs` 是去敏扫描的 19 条断言（`node ci/_test-secrets.mjs`）。这些逻辑改动后先跑对应的单测再提交。

去敏扫描也能本地单跑，用来在提交前自查：

```bash
node scripts/check-secrets.mjs --root .          # 扫当前目录，干净则 exit 0
node scripts/check-secrets.mjs --root . --json   # 机器可读的命中列表
```

## 窗口与托盘

- 右上角 X **收进托盘**，不结束程序。判定逻辑在 `src/window-lifecycle.js` 的 `closeAction()`：只有「托盘图标确实建好了」且「当前不在退出流程中」两个条件同时成立才返回 `hide`，其余情况一律放行关闭。前半条防止窗口藏进一个不存在的托盘里再也找不回来，后半条防止退出时被自己的 close 处理器挡住、进程挂着不退。
- 托盘菜单三项：**显示主窗口** / **打开日志文件夹** / **退出**；左键单击或双击图标同样唤回窗口。
- 「退出」走的是 `app.quit()` → `before-quit` → `serverStop()`（内部 `taskkill /t` 收整棵进程树），所以从托盘退出和直接关系统都会清掉 dsh 子进程，不留孤儿进程。
- 第一次收起时弹一次系统气泡，说明窗口去了哪里、怎么找回。
- 托盘图标复用 `resources\app\build\icon.ico`（与窗口图标同一份多尺寸 ICO）。读不到图标时只记一条日志并退回「关闭即退出」的旧行为，不会出现「窗口消失且无法恢复」。
- 程序已在托盘时再次双击 exe，单实例锁会把请求转给已有进程，`second-instance` 直接唤回那个窗口。

## 运行机制

1. `resolvePortableRoot()` 取 `DSH_PORTABLE_ROOT` 或 exe 所在目录（认 `portable.marker`）。
2. 在 `app.whenReady()` 之前调用 `configureElectronPaths()`，把 Electron 的八条路径改到 `data\`。
3. `migratePortablePaths()` 比对 `data\portable-state.json` 里记录的旧根：不同则改写 `data\dsh-home` 下的文本文件（JSON 转义、正斜杠、YAML 三种写法都覆盖），前 1 MB 的文件进 `data\backup\`。
4. `startDshServer()` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑
   `dsh web --no-open --host 127.0.0.1 --port <3080|3081|…>`，从输出里抓 `dsh web: <url>`（该 URL 带一次性 token，前端鉴权靠它）。
5. 窗口加载该 URL。关闭窗口只是收进托盘（见上节）；真正退出时 `taskkill /t` 收掉整棵进程树。

## 自检开关（仅诊断用）

| 变量 | 作用 |
|---|---|
| `DSH_PORTABLE_CAPTURE=<file.png>` | 加载完成后截图，并把 `document.body.innerText` 存为 `<file.png>.txt` |
| `DSH_PORTABLE_CAPTURE_EXIT=1` | 截图后自动退出；失败时跳过错误弹窗，便于自动化 |
| `DSH_PORTABLE_CLOSE_TEST=1` | 加载完成后模拟点击右上角 X，把「托盘是否就绪 / 托盘图标屏幕坐标 / 窗口收起前是否可见 / 收起后是否仍可见 / 剩余窗口数」写进 `data\logs\close-test.txt`，然后退出 |
| `DSH_PORTABLE_CLOSE_TEST_SHOT=<file.png>` | 配合上一项：收起窗口前先抓一张整屏，用于核对托盘图标是否真的落在 `trayBounds` 报出的坐标上 |

## 已知限制

- 拖拽文件进对话、原生目录选择器等桌面专属能力依赖官方 desktop host 的 preload，本外壳走的是浏览器端降级路径。
- 没有自动更新，升级靠覆盖程序文件。
- 内置的 Office→PDF 转换引擎（`libreoffice-kit`）占 184 MB；不需要文档预览可直接删除该目录以瘦身。
