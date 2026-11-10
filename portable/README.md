# DeepSeek Harness 便携版（U 盘版）

把 DeepSeek Harness 的 Web 前端套进 Electron 外壳，做成一个**双击即用、免安装、数据随盘走**的 Windows 便携程序。

产物默认落在 **源码所在盘符** 的 `\AI\deepseek-harness-portable`——本机源码在 `F:` 盘，所以实际路径是 `F:\AI\deepseek-harness-portable`。

盘符只影响**编译时把文件写到哪**，不影响程序本身：产物以 exe 所在目录为根目录，U 盘插到任何电脑、被分配成任何盘符都能直接运行（见下表的「换电脑自动识别路径」）。

## 源码从哪来：三个仓库各管什么

| 角色 | 位置 | 作用 |
|---|---|---|
| 官方源码仓（上游） | `https://github.com/deepseek-ai/deepseek-harness` | MIT，59 个包组。**版本以这里为准**：官方发 `dsh-v*` tag，同时把 `@deepseek-ai/dsh` 发到 npm |
| 本机源码副本 | 工作区里的 `deepseek-harness-master\`（与 `deepseek-harness-portable\` 同级） | 官方仓的**快照**（`@deepseek-ai/dsh-root` 0.2.2-alpha.3，没有 `.git`）。只用来取原始图标、查实现细节，不参与构建 |
| fork 容器 | `https://github.com/lentll/deepseek-harness` | 从官方仓 fork 出来的个人副本，**只为放 `portable` 分支和跑 Actions**；它的 `master` 是上游快照，不承载任何外壳代码 |

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
    portable.js           便携路径推导、Electron 路径重定向、子进程环境、profile 覆盖注入
    workspace-repair.js   把默认/失效工作区搬回盘内（只复制不删除）
    dsh-server.js         启动 dsh Web 服务（ELECTRON_RUN_AS_NODE）、解析带 token 的 URL
    path-migration.js     换盘/换机后的绝对路径自愈
    preload.js            向页面只暴露 deleteSession 一个方法
    session-menu.js       宿主侧删除：id 校验、目录定位、状态清理、后台重启
    session-menu-injected.js  注入页面：给会话菜单补「删除会话」
    splash.html           启动画面
  scripts\
    build-portable.mjs    组装最终产物
    progress.mjs          带百分比的整树拷贝（逐个文件复制 + 进度行）
    make-icon.mjs         PNG → 多尺寸 ICO
    sign-exe.ps1          自签名代码签名证书 + Authenticode 签名
  runtime\                由 npm 安装的 dsh 运行时（@deepseek-ai/dsh + 依赖）
  build\icon.ico

产物里的 data\：
  dsh-home\               DSH_HOME：profiles（含 patch 覆盖）、sessions、skills、storages
  agents\                 DSH_AGENTS_HOME
  documents\              冒充系统「文档」目录，dsh 首次创建的默认工作区落在这里
  workspace\              从主机搬来的工作区（技能装在 <工作区>\skills）
  home\                   便携 $HOME：.skillhub、.local\bin、.openclaw、.gitconfig
  pnpm\                   插件/技能安装的 store 与缓存
  electron\               Chromium 配置与各类缓存
  logs\  tmp\  backup\
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
node scripts/build-portable.mjs  # 输出到 <源码盘符>:\AI\deepseek-harness-portable
```

输出目录默认取**源码目录所在盘符** + `\AI\deepseek-harness-portable`，源码在哪个盘就写到哪个盘，脚本里不写死盘符；想换位置加 `--out <目录>`，或用环境变量 `DSH_PORTABLE_OUT` 固定。

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

不传 `--out` 时用上面「构建」里的默认目录（源码盘符 + `\AI\deepseek-harness-portable`），换盘不用改脚本。

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
| 插件 / 技能安装的 pnpm store 与 HTTP 缓存（`npm_config_store_dir`、`npm_config_cache`、`PNPM_HOME`） | `data\pnpm\` |
| 任何 `~` 展开（`$HOME`：SkillHub CLI、`.openclaw`、Git 身份） | `data\home\` |
| `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` | `data\cache\` / `data\home\.config\` |
| 运行日志 | `data\logs\` |

实测：运行一次后 `data\tmp` 新增 `dsh-spill-*`、`dsh-acl-skill-*`，主机 `%TEMP%` 条目数不变（50 → 50），且其中旧的 `dsh-*` 时间戳停在修复前的测试时刻。

**主机零写入实测**（2026-11-10，完整启动 → 加载 Web → 退出）：以启动时刻为界，扫描 `%USERPROFILE%`（深度 4，含 `.dsh`、`.agents`、`.cache`、`.npm`、`.pnpm`、`AppData`）、`%APPDATA%`、`%LOCALAPPDATA%\Temp`、`%LOCALAPPDATA%\CrashDumps`、`D:\Users\Documents`、`%ProgramData`，窗口内新增文件 **0 个**（仅 WorkBuddy 自身日志 4 条，与应用无关）；同期 `data\` 内新增 Chromium 缓存、GPU/Shader 缓存、Cookies、Local Storage、会话、日志等 24 个文件。

## 工作区与技能装在哪

dsh 的**默认工作区**不是从 `DSH_HOME` 推出来的，而是拿系统的「文档」目录拼出来的：`<文档>\deepseek-harness\default-workspace`。上一版就是栽在这里——工作区落在 `D:\Users\Documents\...`，于是 Skill 商店（skillhub）把 kit 装进那个本机目录，拔掉 U 盘什么都带不走。

现在有两道约束把它按回盘内：

1. **首次创建就落盘**：`src/portable.js` 的 `ensureProfileOverlay()` 往 profile 补丁层（`data\dsh-home\profiles\web\cordis.patch.yml`）注入一条 `workspace-controller` 覆盖，`documentsDirectory` 用 `!!js process.env.DSH_PORTABLE_ROOT + '\data\documents'` 现算——写死盘符会在换机时失效，现算才能在 E:、F: 上都对。补丁只加一次（带 marker 幂等），空 profile 的 `[]` 会先被摘掉再追加，否则 YAML 会因子序列冲突解析失败、整个 Web 起不来（`ci/_test-profile-overlay.mjs` 用 js-yaml 真解析把关）。
2. **旧记录自愈**：`src/workspace-repair.js` 在每次启动、dsh 加载注册表之前跑一遍：`default-workspace` 即使目录还在也搬到 `data\workspace\default-workspace`（内容一并复制，≤64 MB），换机后失效的路径重新指向 `data\workspace\<标题>`，用户自己挑的目录只要还在就一根手指都不碰。原记录备份到 `data\backup\workspace-<时间>.json`，报告写 `data\logs\workspace-repair-<时间>.json`。

两条都**只复制、不删除**：旧目录原样留在本机，报告里的 `leftover` 就是可以自行清理的路径。技能本体（`<DSH_HOME>\skills`、`<工作区>\.dsh\skills`）因此也在盘内。

### 技能商店装到哪：`$HOME` 也是便携的

工作区搬进盘内只解决了一半：SkillHub 的安装器是**纯 `$HOME` 驱动**的，脚本里写死了三处——

```
$HOME/.skillhub          CLI 本体、config.json、skills_index
$HOME/.local/bin         skillhub 可执行入口
$HOME/.openclaw/…        可选插件与 workspace/skills
```

`$HOME` 继承主机时，这三处全落在 `C:\Users\<你>\`，拔盘即失。所以 `portableEnvironment()` 把 `HOME` 指向 `data\home`（并给出 `SKILLHUB_CONFIG_PATH`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_WORKSPACE` 三个覆盖，供 CLI 自己解析的那部分用），`XDG_CONFIG_HOME` 一并指到 `data\home\.config`。

两个细节：

- **分隔符必须转成正斜杠**。shell 会把 `F:\data\home` 当成一个完整的字面文件名，`mkdir -p "$HOME/.skillhub"` 就会造出名为 `F:\data\home\.skillhub` 的怪目录；所有交给 shell 的路径都过一遍 `toUnixPath()`。
- **Git 身份**跟着 `$HOME` 走。首次启动时若 `data\home\.gitconfig` 不存在、而主机有，就复制一份过去（已有则从不覆盖，日志记 `portable home seeded: .gitconfig`），否则 agent 一提交就报 `Please tell me who you are`。

实测（用便携环境的 `HOME` 跑安装器）：`Install complete. cli: ...\data\home\.local\bin\skillhub`；`skillhub install markdown --namespace clawhub_ivangdavila` → `...\data\workspace\default-workspace\skills\@clawhub_ivangdavila\markdown`；主机 `C:\Users\Administrator\.skillhub` 与 `.openclaw` 始终不存在。

> 技能本体按 CLI 语义装在**当前目录**下的 `./skills`，所以「在哪个工作区里装就落在哪个工作区」，工作区在盘内 → 技能在盘内。

实测（全新空目录当便携根）：首启日志 `workspace overlay: added` → 新建记录 `...\data\documents\deepseek-harness\default-workspace`；已有安装：日志 `workspaces re-pointed: D:\Users\Documents\... -> ...\data\workspace\default-workspace`，`skillhub-kit` 一并搬入。

## 云端构建（GitHub Actions）

本工程同时以 `portable/` 的形式维护在 fork `lentll/deepseek-harness` 的 `portable` 分支（外壳源码与 workflow 同址），`master` 上另有一份负责一键出包的 `build-portable.yml`。细节见 `推送指南.md`，要点：

- **上游是谁**：`env.UPSTREAM_REPO` 指向官方仓 `deepseek-ai/deepseek-harness`，按它的 release 列表取最新 `dsh-v*`（`/releases/latest` 会跳过 prerelease，而 dsh 只发 prerelease，所以列出来自己挑）。fork 的 `master` 只是上游旧快照，**不需要同步**，也不参与出包。
- **分支形态**：`portable` 是**独立根分支**（不含上游代码），只放 `portable/` 与 workflow。原因：本机到 GitHub 仅约 33 KB/s，完整克隆 353 MB 的上游仓库不现实，独立分支只有约 200 KB，CI 检出也快。
- **触发方式只有手动**：两份 workflow 都去掉了 `schedule` 和 `push`，同步上游、改外壳、提交代码都不会自己开跑；要出包就点 Run workflow。原因：一次构建 8–12 分钟且要下载 1.3 GB 依赖，自动跑容易在你没准备时占掉额度、覆盖 Release。
- **版本映射**：GitHub tag `dsh-v0.2.2-rc.1` → npm 包 `0.2.2-rc.1`；tag 已打但 npm 未发布时任务跳过并告警。
- **产物**：Release `portable-v<版本>` + `DeepSeek-Harness-portable-<版本>.7z`（**排除 `data/`**，因此不含任何 API Key）。
- **两道去敏守卫**：构建前先扫**仓库源码**（`scripts/check-secrets.mjs`：`.env`/`.credentials.yaml`/`*.pfx`/`*.pem` 等文件名，以及 `sk-` 密钥、GitHub token、PEM 私钥块、AWS key 的明文），命中即中断；构建后再扫 **`out\` 产物**（同上文件名 + `resources\app` 里的 `sk-` 明文），命中同样中断。前者防「提交进仓库但没进包」，后者防「构建过程新写的」，两者互补。命中报告只给文件名和行号，不打印命中的密文，避免 CI 日志变成新的泄露面。
- **签名**：`SIGNING_PFX_BASE64` / `SIGNING_PFX_PASSWORD` 两个 secret 已配置，构建末尾会给 `DeepSeek Harness.exe` 挂上自签证书与时间戳；secret 为空时该步骤自动跳过、不影响出包。

### 从主仓库一键构建（master 上的 build-portable.yml）

`master` 上另有一份 `.github/workflows/build-portable.yml`，让「更新主仓库后一键出包」不依赖切默认分支：

- **入口**：Actions → **Build portable (master)** → Run workflow。默认分支就是 master，所以按钮一直在。
- **版本**：填 `version` 就用它（不在 npm 上直接报错）；不填则取「本分支 `package.json` 版本」与「上游最新 `dsh-v*`」中较大的那个，若它还没发到 npm 就自动退回另一个——master 经常带着「已合并、未发布」的版本号。
- **外壳仍来自 portable 分支**：先 checkout master 读版本，再把 `portable` 分支检出到 `portable-src/` 构建，上游源码与外壳不混在一起。
- **同名 Release**：已存在就直接跳过（避免误覆盖别人已下载的包），确实要重建时勾 `force`。

文件本地副本在 `ci/build-portable.yml`（改完贴回 GitHub），`ci/_test-semver.ps1` 与 `ci/_test-resolve.ps1` 是版本比较、版本选择的离线单测（12 + 6 条断言），`ci/_test-secrets.mjs` 是去敏扫描的 19 条断言（`node ci/_test-secrets.mjs`）。这些逻辑改动后先跑对应的单测再提交。

去敏扫描也能本地单跑，用来在提交前自查：

```bash
node scripts/check-secrets.mjs --root .          # 扫当前目录，干净则 exit 0
node scripts/check-secrets.mjs --root . --json   # 机器可读的命中列表
```

## 删除会话

上游只提供「归档会话」：归档只是把 id 放进一个隐藏集合，日志仍留在 `data\dsh-home\sessions\`，永久占盘；工作区菜单里的「删除工作区」也只把工作区从列表里摘掉，同样不删日志。会话行菜单里的**删除会话**是本外壳补的。

- 入口有两个：会话行右侧 **⋯** 按钮，以及**在会话行上直接右键**。右键菜单由上游自己弹出（`getTriggerProps` 绑定了 `onContextMenu`），外壳只负责在 `contextmenu` 事件里记下这一行是谁——不拦截、不合成、不改变菜单位置。
- 会话行的 `data-row-key="session:<id>"` 就是目标身份，按下 ⋯ 或在行上右键的瞬间记录，所以菜单永远指向你操作的那一行；菜单项本身是从「归档会话」克隆的，样式、图标位、hover 都跟随主题，只有图标换成 `dsw-icon-trash-outline-regular`、文字换成红色。
- 点击后弹原生确认框，**默认按钮是「取消」**（Enter / Esc / 关窗都等于放弃）；「删除」是一次明确的点击。
- 确认后顺序是：停 dsh → 删掉 `sessions\<组>\<session-id>\` 这一个目录 → 从 `storages\workspace.json` 里抹掉该 id 的归档/置顶/工作区记账 → **立刻应答**，页面随即把那一行从列表里去掉（实测 206 ms）→ 后台重启 dsh → 重新加载窗口。
- 为什么不能只刷新页面：dsh 在**启动时**把会话头索引进内存（`this.headers`），运行时没有重建入口，列表也就一直从这份索引里出。删了文件后按 F5，请求仍会命中那条内存记录，行照旧出现——**幽灵行**。所以重启是让「列表 == 磁盘」的唯一手段。
- 重启要几秒，但用户不必等它来确认点击生效：宿主先回答，行先消失，重启在回答之后 500 ms 才开始，期间显示启动画面。
- 只删这一个目录。所属分组目录即使空了也保留；会话里产生过的文件（在工作区目录下）不受影响。
- 「新会话」那一行是当前工作区的占位会话（上游对该行不渲染 ⋯ 按钮，也不绑右键菜单），删掉后 dsh 会立刻再造一个空的，所以那一行不提供删除。

`src/session-menu.js` 是宿主侧（只认 `session-<uuid>` 格式、只删除解析出来的、且必须位于 `sessions\` 之下的目录），`src/session-menu-injected.js` 是注入到页面的那一小段（只加菜单项、只把点击交给 preload 的单一通道），`src/preload.js` 只暴露 `deleteSession` 一个方法。

实测（真实点击 + 真实鼠标事件）：右键菜单读到 `置顶会话 | 重命名 | 分叉会话 | 复制 Session ID | 在文件夹显示 | 归档会话 | 删除会话`；点击「删除」后 `hiddenAfterMs = 206`，重启完成时列表与磁盘同时只剩占位行。

## 窗口与托盘

- 右上角 X **收进托盘**，不结束程序。判定逻辑在 `src/window-lifecycle.js` 的 `closeAction()`：只有「托盘图标确实建好了」且「当前不在退出流程中」两个条件同时成立才返回 `hide`，其余情况一律放行关闭。前半条防止窗口藏进一个不存在的托盘里再也找不回来，后半条防止退出时被自己的 close 处理器挡住、进程挂着不退。
- 托盘菜单三项：**显示主窗口** / **打开日志文件夹** / **退出**；左键**单击**图标即唤回窗口（不需要双击，双击也不会出错，只是多余）。单击回归时会把窗口提到当前前台——Windows 的前台窗口锁会让单纯的 `show()` 留在别的窗口后面，看起来像"点了没反应"，所以代码里用一次性的置顶复位来抢前台，随后立即撤销，窗口不会长期置顶。
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
| `DSH_PORTABLE_DELETE_PROBE=<file.json>` | 走完整条删除路径：打开第一个会话行的 ⋯ 菜单、读菜单项、点「删除会话」、采样行消失的时刻、等页面重载，最后把菜单项、颜色、`hiddenAfterMs`、重载后列表与磁盘目录写入该文件，然后退出 |
| `DSH_PORTABLE_DELETE_TEST=1` | 让删除确认框直接返回「删除」，供上一项无人值守跑通；真机上不要设 |
| `DSH_PORTABLE_DIALOG_SHOT=<file.png>` | 配合上一项但不点确认：抓一张整屏，用来看确认框的图标、按钮顺序与默认焦点 |
| `DSH_PORTABLE_CTX_PROBE=<file.json>` | 列出所有会话行（标题、是否有 ⋯ 按钮），随后在行中间派发一次 `contextmenu`、再在 ⋯ 上派发一次，记录两次弹出的菜单项，用来确认右键这条路径可用 |
| `DSH_PORTABLE_SEND_PROBE=<file.json>` | 往输入框里敲一条短消息并发送，用于造一条非占位会话来验证菜单；会真实调用一次模型 |

## 已知限制

- 拖拽文件进对话、原生目录选择器等桌面专属能力依赖官方 desktop host 的 preload，本外壳走的是浏览器端降级路径。
- 没有自动更新，升级靠覆盖程序文件。
- 内置的 Office→PDF 转换引擎（`libreoffice-kit`）占 184 MB；不需要文档预览可直接删除该目录以瘦身。
