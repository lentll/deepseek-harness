# DeepSeek Harness 便携版（U 盘版）

把 DeepSeek Harness 的 Web 前端套进 Electron 外壳，做成一个**双击即用、免安装、数据随盘走**的 Windows 便携程序。

产物默认落在 **源码所在盘符** 的 `\AI\deepseek-harness-protable`——本机源码在 `F:` 盘，所以实际路径是 `F:\AI\deepseek-harness-protable`（目录名沿用最初指定的拼写 `protable`，不是 `portable`）。

盘符只影响**编译时把文件写到哪**，不影响程序本身：产物以 exe 所在目录为根目录，U 盘插到任何电脑、被分配成任何盘符都能直接运行（见下表的「换电脑自动识别路径」）。

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
    make-icon.mjs         PNG → 多尺寸 ICO
    sign-exe.ps1          自签名代码签名证书 + Authenticode 签名
  runtime\                由 npm 安装的 dsh 运行时（@deepseek-ai/dsh + 依赖）
  build\icon.ico
```

## 运行时为什么用 npm 包而不是源码

仓库本体是 59 个包组、约 139 万行 TypeScript 的 monorepo，`pnpm install + build` 需要 Node ≥ 24.9、MSVC 工具链与长时间构建。
`@deepseek-ai/dsh` 在 npm 上已发布完整运行时（含内置 Web 前端产物 `@deepseek-ai/dsh-web-frontend/dist`），因此本方案直接安装发布版，稳定、可重复。

**Electron 版本必须精确为 `44.7.0`**：dsh 的 `node-addon-require-builtin` 只认白名单内的 Electron 指纹（43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6），其余版本会在启动时报 `unsupported Electron runtime fingerprint` 并退出。Electron 44.7.0 内置 Node 24.21.0，满足 dsh 的 Node ≥ 24.9。

## 构建

```sh
npm install                      # electron@44.7.0 + resedit + sharp
npm install --prefix runtime @deepseek-ai/dsh@0.2.2-alpha.3
node scripts/make-icon.mjs       # 生成 build/icon.ico
node scripts/build-portable.mjs  # 输出到 <源码盘符>:\AI\deepseek-harness-protable
```

输出目录默认取**源码目录所在盘符** + `\AI\deepseek-harness-protable`，源码在哪个盘就写到哪个盘，脚本里不写死盘符；想换位置加 `--out <目录>`，或用环境变量 `DSH_PORTABLE_OUT` 固定。

`build-portable.mjs` 是**幂等覆盖、从不删除**：不该进包的内容（多余 locale、`*.map`、`default_app.asar`）在复制阶段就被过滤，因此重复构建不会触发批量删除，也不会动 `data\`。

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
一键更新.cmd --version 0.2.2-alpha.3          :: 指定版本（也可用来回滚）
一键更新.cmd --out "<任意目录>"                 :: 换输出位置（该目录需已有 portable.marker）
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

本工程同时以 `portable/` 的形式维护在 fork `lentll/deepseek-harness` 的 `protable` 分支上，由 `.github/workflows/portable-build.yml` 自动出包。细节见 `推送指南.md`，要点：

- **分支形态**：`protable` 是**独立根分支**（不含上游代码），只放 `portable/` 与 workflow。原因：本机到 GitHub 仅约 33 KB/s，完整克隆 353 MB 的上游仓库不现实，独立分支只有约 200 KB，CI 检出也快。
- **定时任务的前提**：GitHub 的 `schedule` 只认默认分支上的 workflow，所以要么把 `protable` 设为 fork 的默认分支，要么把同一份 workflow 贴到 master。
- **三条触发**：每天 20:00 UTC 拉上游最新 `dsh-v*` release tag；手动 `workflow_dispatch`（可指定版本 / `force`）；push 到 `protable` 自动重建。
- **版本映射**：GitHub tag `dsh-v0.2.2-rc.1` → npm 包 `0.2.2-rc.1`；tag 已打但 npm 未发布时任务跳过并告警。
- **产物**：Release `portable-v<版本>` + `DeepSeek-Harness-portable-<版本>.7z`（**排除 `data/`**，因此不含任何 API Key）。
- **去敏守卫**：打包前扫描 `out\resources\app`，发现 `.env`、`.credentials.yaml` 或 `sk-xxxx` 明文即构建失败。
- **签名**：`SIGNING_PFX_BASE64` / `SIGNING_PFX_PASSWORD` 两个 secret 存在则签名，否则跳过。

## 运行机制

1. `resolvePortableRoot()` 取 `DSH_PORTABLE_ROOT` 或 exe 所在目录（认 `portable.marker`）。
2. 在 `app.whenReady()` 之前调用 `configureElectronPaths()`，把 Electron 的八条路径改到 `data\`。
3. `migratePortablePaths()` 比对 `data\portable-state.json` 里记录的旧根：不同则改写 `data\dsh-home` 下的文本文件（JSON 转义、正斜杠、YAML 三种写法都覆盖），前 1 MB 的文件进 `data\backup\`。
4. `startDshServer()` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑
   `dsh web --no-open --host 127.0.0.1 --port <3080|3081|…>`，从输出里抓 `dsh web: <url>`（该 URL 带一次性 token，前端鉴权靠它）。
5. 窗口加载该 URL，退出时 `taskkill /t` 收掉整棵进程树。

## 自检开关（仅诊断用）

| 变量 | 作用 |
|---|---|
| `DSH_PORTABLE_CAPTURE=<file.png>` | 加载完成后截图，并把 `document.body.innerText` 存为 `<file.png>.txt` |
| `DSH_PORTABLE_CAPTURE_EXIT=1` | 截图后自动退出；失败时跳过错误弹窗，便于自动化 |

## 已知限制

- 拖拽文件进对话、原生目录选择器等桌面专属能力依赖官方 desktop host 的 preload，本外壳走的是浏览器端降级路径。
- 没有自动更新，升级靠覆盖程序文件。
- 内置的 Office→PDF 转换引擎（`libreoffice-kit`）占 184 MB；不需要文档预览可直接删除该目录以瘦身。
