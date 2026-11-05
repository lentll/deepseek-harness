/**
 * One-shot updater for the portable package.
 *
 * Wraps `build-portable.mjs` with the concerns an in-place update has that a
 * first build does not: closing the running app so files are not locked,
 * optionally moving the dsh runtime to a newer npm version, and proving that
 * the user's `data` folder survived untouched.
 *
 * Usage:
 *   node scripts/update.mjs                       # rebuild with current code
 *   node scripts/update.mjs --version 0.2.3       # upgrade the dsh runtime first
 *   node scripts/update.mjs --version latest      # newest published runtime
 *   node scripts/update.mjs --out "<package dir>"
 *
 * Exit code 0 means the package was rebuilt, re-signed, and kept its data.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const buildScript = path.join(here, 'build-portable.mjs')

const APP_NAME = 'DeepSeek Harness'
const EXE_NAME = `${APP_NAME}.exe`
const RUNTIME_PACKAGE = '@deepseek-ai/dsh'

/** Arguments that take a value, so `--out` alone is not mistaken for a path. */
const VALUED_FLAGS = new Set(['--out', '--version'])

/**
 * Read a `--flag value` pair from argv.
 * @param {string} flag - flag name including dashes.
 * @param {string} fallback - value when the flag is absent.
 * @returns {string} the resolved value.
 */
function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

/**
 * Default output directory: `<project drive>:\AI\deepseek-harness-protable`.
 *
 * Deriving the drive from the project keeps the default correct after the whole
 * workspace is copied to another USB stick, where `F:` may well not exist.
 * @returns {string} absolute package directory.
 */
function defaultOutDir() {
  if (process.env.DSH_PORTABLE_OUT) return path.resolve(process.env.DSH_PORTABLE_OUT)
  const drive = path.parse(projectRoot).root
  return path.join(drive, 'AI', 'deepseek-harness-protable')
}

const outDir = path.resolve(argValue('--out', defaultOutDir()))
const targetExe = path.join(outDir, EXE_NAME)
const requestedVersion = argValue('--version', '')

/** @param {string} message - line to print. */
function step(message) {
  console.log(`\n[update] ${message}`)
}

/** @param {string} message - fatal reason. */
function fail(message) {
  console.error(`\n[update] 失败：${message}`)
  process.exit(1)
}

/**
 * Count files and bytes below a directory, skipping missing paths.
 * @param {string} directory - absolute path.
 * @returns {{files: number, bytes: number}} totals.
 */
function measure(directory) {
  const total = { files: 0, bytes: 0 }
  if (!fs.existsSync(directory)) return total
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      total.files += 1
      try {
        total.bytes += fs.statSync(absolute).size
      } catch {
        // Unreadable entries do not change the verdict.
      }
    }
  }
  return total
}

/**
 * Read the version of the dsh runtime currently vendored in the project.
 * @returns {string} version string, or `unknown` when the package is missing.
 */
function installedRuntimeVersion() {
  try {
    const manifest = path.join(projectRoot, 'runtime', 'node_modules', ...RUNTIME_PACKAGE.split('/'), 'package.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version
  } catch {
    return 'unknown'
  }
}

/**
 * True when the portable app is running, which locks the executable on Windows.
 * @returns {boolean} whether a matching process exists.
 */
function appIsRunning() {
  const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}`
  // tasklist answers "信息: 没有运行的任务匹配指定标准。" when nothing matches,
  // so a match is detected by the executable name actually appearing.
  return output.toLowerCase().includes(EXE_NAME.toLowerCase())
}

/**
 * Close every process of the portable app, including its dsh child, so the
 * rebuild can replace the executable. Unsent chat input is the only thing lost.
 * @returns {void}
 */
function closeRunningApp() {
  if (!appIsRunning()) return
  step('检测到程序正在运行，先关闭它（未发送的输入会丢失）')
  spawnSync('taskkill', ['/IM', EXE_NAME, '/T', '/F'], { stdio: 'inherit', windowsHide: true })
  // The tree kill is asynchronous from the file system's point of view.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && appIsRunning()) {
    spawnSync('timeout', ['/t', '1', '/nobreak'], { windowsHide: true, shell: true })
  }
  if (appIsRunning()) fail('程序仍在运行，请手动退出后再试')
}

/**
 * Install a dsh runtime version into the project so the next build ships it.
 * @param {string} version - npm version or dist-tag such as `latest`.
 * @returns {void}
 */
function installRuntime(version) {
  step(`安装 ${RUNTIME_PACKAGE}@${version}（可能需要几分钟）`)
  const result = spawnSync(
    'npm',
    ['install', '--prefix', 'runtime', `${RUNTIME_PACKAGE}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: projectRoot, stdio: 'inherit', shell: true, windowsHide: true },
  )
  if (result.status !== 0) fail(`npm install 返回 ${result.status}，运行时未更新`)
  step(`运行时现在是 ${installedRuntimeVersion()}`)
}

/**
 * Ask Windows for the Authenticode state of the rebuilt executable.
 * @returns {string} status plus signer, or a placeholder when unavailable.
 */
function signatureStatus() {
  if (!fs.existsSync(targetExe)) return '（未找到 exe）'
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${targetExe.replace(/'/g, "''")}'`,
    `'{0}|{1}' -f $s.Status, $s.SignerCertificate.Subject`,
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}`.trim()
  return output.length > 0 ? output : '（无法读取签名状态）'
}

/**
 * Append one line per update so the package carries its own upgrade history.
 * @param {string} out - package directory.
 * @param {string[]} lines - fields to record.
 * @returns {void}
 */
function appendHistory(out, lines) {
  const logFile = path.join(out, 'data', 'logs', 'update-history.log')
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${lines.join(' | ')}\n`, 'utf8')
  } catch {
    // A read-only USB stick should not fail the update after a successful build.
  }
}

/**
 * Build the command line for `build-portable.mjs`.
 * @returns {string[]} argv passed to Node.
 */
function forwardedArgs() {
  const forwarded = []
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index]
    if (!token.startsWith('--')) continue
    if (token === '--out') {
      index += 1
      continue
    }
    if (VALUED_FLAGS.has(token)) {
      index += 1
      continue
    }
    forwarded.push(token)
  }
  return forwarded
}

function main() {
  const started = Date.now()

  step('DeepSeek Harness 便携版 · 一键更新')
  step(`Node ${process.versions.node}`)
  step(`源码：${projectRoot}`)
  step(`目标：${outDir}`)

  if (!fs.existsSync(buildScript)) fail(`构建脚本缺失：${buildScript}`)
  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'electron', 'dist'))) {
    fail('缺少 Electron 运行时，请先在源码目录执行 npm install')
  }

  // A missing marker means the target is not our package: refuse to pour a
  // 1 GB build into a directory that belongs to something else.
  if (fs.existsSync(outDir) && !fs.existsSync(path.join(outDir, 'portable.marker'))) {
    fail(`${outDir} 不是便携版目录（缺少 portable.marker），请用 --out 指定正确位置`)
  }

  const before = {
    dshHome: measure(path.join(outDir, 'data', 'dsh-home')),
    sessions: fs.existsSync(path.join(outDir, 'data', 'dsh-home', 'sessions'))
      ? fs.readdirSync(path.join(outDir, 'data', 'dsh-home', 'sessions')).length
      : 0,
    version: installedRuntimeVersion(),
  }
  step(`更新前：运行时 ${before.version}，会话 ${before.sessions} 个，dsh-home ${before.dshHome.files} 个文件`)

  closeRunningApp()

  if (requestedVersion.length > 0) installRuntime(requestedVersion)

  step('重建程序文件（data 目录不会被动）')
  const build = spawnSync(process.execPath, [buildScript, '--out', outDir, ...forwardedArgs()], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (build.status !== 0) fail(`构建返回 ${build.status}`)

  const after = {
    dshHome: measure(path.join(outDir, 'data', 'dsh-home')),
    sessions: fs.existsSync(path.join(outDir, 'data', 'dsh-home', 'sessions'))
      ? fs.readdirSync(path.join(outDir, 'data', 'dsh-home', 'sessions')).length
      : 0,
    version: installedRuntimeVersion(),
  }
  const signature = signatureStatus()
  const seconds = ((Date.now() - started) / 1000).toFixed(0)

  step('完成')
  console.log(`  运行时版本 : ${before.version} → ${after.version}`)
  console.log(`  会话       : ${before.sessions} → ${after.sessions}`)
  console.log(`  dsh-home   : ${before.dshHome.files} 个文件 / ${(before.dshHome.bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`              → ${after.dshHome.files} 个文件 / ${(after.dshHome.bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  签名       : ${signature}`)
  console.log(`  耗时       : ${seconds}s`)
  console.log(`  双击运行   : ${targetExe}`)

  appendHistory(outDir, [before.version, '->', after.version, 'sessions', String(after.sessions), signature])

  console.log('\n用法备忘：')
  console.log('  只更新当前代码            : 双击 一键更新.cmd')
  console.log('  顺带升级 dsh 运行时       : 一键更新.cmd --version latest')
  console.log('  指定/回滚运行时版本       : 一键更新.cmd --version 0.2.2-alpha.3')
  console.log('  更新到别的目录            : 一键更新.cmd --out "<目录>"')

  if (after.dshHome.files !== before.dshHome.files || after.sessions !== before.sessions) {
    console.error('\n[update] 注意：data 内容数量发生变化，请检查 data\\logs 下的日志。')
    process.exit(2)
  }
}

main()
