/**
 * Assemble the portable Windows package.
 *
 * Running the result needs no installer and no host-side state: the Electron
 * payload, the dsh runtime, and the writable `data` folder all live in one
 * directory that can be copied to a USB stick.
 *
 * The build never deletes: content that should not ship is filtered out while
 * copying, so an existing package can be updated in place and user data in
 * `data/` is never touched.
 *
 * Usage:
 *   node scripts/build-portable.mjs [--out <dir>] [--keep-maps]
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as ResEdit from 'resedit'
import { copyTree, copyTreeWithProgress } from './progress.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const APP_NAME = 'DeepSeek Harness'
const EXE_NAME = `${APP_NAME}.exe`
/** Default target: `<project drive>:\AI\deepseek-harness-protable`, so a copied workspace keeps working. */
const DEFAULT_OUT = path.join(path.parse(projectRoot).root, 'AI', 'deepseek-harness-protable')

/** Locales kept from Electron's `locales` folder; Windows falls back to en-US. */
const KEPT_LOCALES = new Set(['en-US.pak', 'zh-CN.pak'])

/**
 * Read a `--flag value` pair from argv.
 * @param {string} flag - flag name including dashes.
 * @param {string} fallback - value when the flag is absent.
 * @returns {string} the resolved value.
 */
function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1]
}

const outDir = path.resolve(argValue('--out', DEFAULT_OUT))
const keepMaps = process.argv.includes('--keep-maps')
const shellVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist')
const runtimeDir = path.join(projectRoot, 'runtime')

/**
 * Fail with a readable message instead of a stack trace.
 * @param {string} message - what went wrong.
 * @returns {never} always throws.
 */
function fail(message) {
  console.error(`\n[build] ${message}`)
  process.exit(1)
}

for (const required of [electronDist, path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')]) {
  if (!fs.existsSync(required)) fail(`missing input: ${required}`)
}

/**
 * Remove a single file when present. Only ever called for one known file, never
 * for a directory tree.
 * @param {string} target - absolute file path.
 * @returns {void}
 */
function removeFileIfPresent(target) {
  try {
    if (fs.statSync(target).isFile()) fs.rmSync(target, { force: true })
  } catch {
    // Absent is the expected case.
  }
}

/**
 * Embed the application icon and version strings into the Electron executable.
 * @param {string} exePath - the renamed executable.
 * @param {string} icoPath - multi-size icon file.
 * @returns {void}
 */
function patchExecutable(exePath, icoPath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const resources = ResEdit.NtExecutableResource.from(exe)

  if (fs.existsSync(icoPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath))
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
    const target = groups.length > 0 ? groups[0].id : 1
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      target,
      1033,
      iconFile.icons.map((icon) => icon.data),
    )
  }

  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
  if (versions.length > 0) {
    const info = versions[0]
    info.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: APP_NAME,
        FileDescription: APP_NAME,
        CompanyName: 'DeepSeek AI',
        LegalCopyright: 'MIT License',
        InternalName: 'deepseek-harness',
        OriginalFilename: EXE_NAME,
      },
    )
    const [major, minor, patch] = shellVersion.split('.').map((value) => Number.parseInt(value, 10) || 0)
    info.setFileVersion(major, minor, patch, 0)
    info.setProductVersion(major, minor, patch, 0)
    info.outputToResourceEntries(resources.entries)
  }

  resources.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
}

/**
 * Sign the executable with the local code-signing certificate.
 *
 * The certificate is self-signed, so Windows reports the chain as untrusted
 * while the signature itself stays valid: it proves the binary was not altered
 * after this build. Trusting it publicly would need a paid OV/EV certificate.
 * A missing certificate or an offline timestamp authority is not fatal — the
 * build still ships, only the signature is skipped.
 *
 * @param {string} exePath - the renamed executable.
 * @returns {void}
 */
function signExecutable(exePath) {
  if (process.platform !== 'win32') {
    console.log('[build] skipping signature: not on Windows')
    return
  }
  const script = path.join(here, 'sign-exe.ps1')
  if (!fs.existsSync(script)) {
    console.log('[build] skipping signature: scripts/sign-exe.ps1 missing')
    return
  }
  console.log('[build] signing executable')
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ExePath', exePath],
      { stdio: 'inherit', windowsHide: true },
    )
  } catch (error) {
    console.log(`[build] signature skipped: ${error.message}`)
  }
}

/**
 * Total size of a directory in megabytes.
 * @param {string} directory - absolute path.
 * @returns {string} size with no decimals.
 */
function dirSizeMb(directory) {
  let total = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else {
        try {
          total += fs.statSync(absolute).size
        } catch {
          // Skip unreadable entries.
        }
      }
    }
  }
  walk(directory)
  return (total / 1024 / 1024).toFixed(0)
}

const instructions = `DeepSeek Harness 便携版（U 盘版）
======================================================================

一、怎么用
  双击 “DeepSeek Harness.exe” 即可运行，不需要安装，也不会打开浏览器页面，
  界面就是一个独立的桌面窗口。

  首次启动会在 data 目录里自动建好所需文件。如果 data 里已经附带
  预置的模型配置（provider 指向一个 OpenAI 兼容网关），打开就能直接对话。

  如果 data 里没有预置配置（例如从 GitHub 发布页下载的构建产物，
  发布包不含任何密钥），首次使用请进 设置（Settings）→ Models 添加 provider：
    - 协议选 OpenAI 兼容（openai-completions）
    - Base URL 填你的网关地址（示例：https://api.example.com/v1）
    - API Key 填你自己 sk- 开头的密钥，再选一个模型即可。

  也可以用记事本改 data\\dsh-home\\.env 里的网关密钥变量，
  以及 data\\dsh-home\\profiles\\web\\cordis.patch.yml 里的模型列表。


二、目录结构
  DeepSeek Harness.exe     程序本体（双击这个）
  resources\\               程序资源：Electron 运行时 + dsh 运行时 + Web 前端
  data\\                    全部数据，随 U 盘走
    dsh-home\\              会话、设置、凭据、插件档案（$DSH_HOME）
    agents\\                共享的 Agent 配置（$DSH_AGENTS_HOME）
    electron\\              窗口的浏览器配置与缓存
    logs\\                  运行日志（启动失败时先看这里）
    tmp\\                   临时文件
    backup\\                换机器时的路径修正备份
  portable.marker          便携版标记文件，请勿删除


三、换电脑 / 换盘符
  直接插到另一台电脑双击运行即可。程序会自动：
  1) 以 exe 所在目录作为根目录，重新定位所有数据；
  2) 检测到上次运行位置和这次不同（例如 F: 变成 G:）时，
     自动把会话和设置里记录的旧绝对路径改写成新路径；
     修改明细写入 data\\logs\\path-migration-*.json，
     改动前的文件备份在 data\\backup\\ 下。


四、零残留说明
  本程序只写 data 目录，不写注册表，不写系统用户目录：
  - 浏览器配置、缓存、崩溃转储、日志、临时文件全部重定向到 data\\；
  - 运行结束后不会在 C 盘留下用户数据；
  - 拔掉 U 盘，本机不留应用痕迹
    （Windows 自身的“最近使用程序”记录属于系统行为，与本程序无关）。


五、升级
  只替换程序文件，data 目录不要动：
  覆盖 “DeepSeek Harness.exe” 与 resources\\ 目录，数据会继续沿用。


六、常见问题
  1) 启动报错：查看 data\\logs\\server.log 与 data\\logs\\shell.log。
  2) 端口被占用：程序会自动改用 3081、3082 等其他端口，无需处理。
  3) 想彻底重置：关闭程序后删除 data 目录，重新运行会重建。
  4) 首次在别的电脑运行弹出“Windows 已保护你的电脑”：
     程序带的是自签名证书，可证明文件未被篡改，但未购买公共信任的
     代码签名证书，所以 SmartScreen 仍会提示。
     点“更多信息”→“仍要运行”即可，只需一次。
     右键 exe → 属性 → 数字签名，可以看到签名者与证书有效期。
`

function main() {
  const started = Date.now()
  const existed = fs.existsSync(outDir)
  console.log(`[build] target: ${outDir}${existed ? ' (updating in place)' : ''}`)
  fs.mkdirSync(outDir, { recursive: true })

  // 1. Electron payload at the package root, minus unused locales.
  copyTreeWithProgress(electronDist, outDir, {
    label: '[build] copying Electron payload',
    keepMaps,
    filter: (source) => {
      const relative = path.relative(electronDist, source)
      const [first, second] = relative.split(path.sep)
      if (first === 'locales' && second !== undefined && !KEPT_LOCALES.has(second)) return false
      return true
    },
  })

  const originalExe = path.join(outDir, 'electron.exe')
  const targetExe = path.join(outDir, EXE_NAME)
  if (fs.existsSync(originalExe)) {
    removeFileIfPresent(targetExe)
    fs.renameSync(originalExe, targetExe)
  }
  if (!fs.existsSync(targetExe)) fail(`executable missing after copy: ${targetExe}`)

  // 2. Application source.
  console.log('[build] writing application')
  const appDir = path.join(outDir, 'resources', 'app')
  fs.mkdirSync(appDir, { recursive: true })
  copyTree(path.join(projectRoot, 'src'), path.join(appDir, 'src'), { keepMaps })
  copyTree(path.join(projectRoot, 'build'), path.join(appDir, 'build'), { keepMaps })
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'deepseek-harness-portable',
        productName: APP_NAME,
        version: shellVersion,
        private: true,
        main: 'src/main.js',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // 3. dsh runtime, outside the app folder so it can spawn subprocesses freely.
  //    ~1.5 GB across ~140k files, so this is the phase that needs a percentage.
  const runtimeOut = path.join(outDir, 'resources', 'runtime')
  fs.mkdirSync(runtimeOut, { recursive: true })
  copyTreeWithProgress(path.join(runtimeDir, 'node_modules'), path.join(runtimeOut, 'node_modules'), {
    label: '[build] copying dsh runtime',
    keepMaps,
  })
  copyTree(path.join(runtimeDir, 'package.json'), path.join(runtimeOut, 'package.json'), { keepMaps })

  // 4. Portable marker and the data skeleton. Existing data is left untouched.
  fs.writeFileSync(path.join(outDir, 'portable.marker'), 'DeepSeek Harness portable build\n', 'utf8')
  for (const directory of ['data/dsh-home', 'data/agents', 'data/electron', 'data/logs', 'data/tmp', 'data/backup']) {
    fs.mkdirSync(path.join(outDir, directory), { recursive: true })
  }

  // 5. Icon and version stamp.
  console.log('[build] stamping executable')
  patchExecutable(targetExe, path.join(appDir, 'build', 'icon.ico'))

  // 6. Signature. Must come after stamping: writing the icon or the version
  // resource rewrites the executable and invalidates any earlier digest.
  signExecutable(targetExe)

  fs.writeFileSync(path.join(outDir, '使用说明.txt'), instructions, 'utf8')

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`[build] done in ${seconds}s, ${dirSizeMb(outDir)} MB at ${outDir}`)
}

main()
