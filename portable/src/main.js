/**
 * Portable shell for DeepSeek Harness.
 *
 * The window hosts the same Web application the browser build serves, so the
 * UI is identical; what differs is where everything lives. Every writable path
 * is derived from the executable's folder, the runtime runs on the Electron
 * executable in Node mode, and stale absolute paths are repaired when the
 * installation moves to another drive or machine.
 */

'use strict'

const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const {
  resolvePortableRoot,
  portablePaths,
  ensurePortableDirectories,
  configureElectronPaths,
  portableEnvironment,
} = require('./portable')
const { migratePortablePaths } = require('./path-migration')
const { startDshServer } = require('./dsh-server')

const APP_TITLE = 'DeepSeek Harness'
const APP_VERSION = require('../package.json').version

const root = resolvePortableRoot(process.execPath)
const dirs = portablePaths(root)
ensurePortableDirectories(dirs)
configureElectronPaths(app, dirs)

/** Append a line to the shell log. */
function log(message) {
  try {
    fs.appendFileSync(dirs.shellLog, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never break startup.
  }
}

/** Absolute path inside the packaged application source. */
function appFile(...segments) {
  return path.join(__dirname, ...segments)
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let serverStop
/** @type {BrowserWindow | undefined} */
let mainWindow
let quitting = false

/**
 * Open http(s) links outside the packaged window so the shell never renders an
 * arbitrary site with application privileges.
 */
function openExternal(url) {
  if (/^https?:/i.test(url)) void shell.openExternal(url)
}

/**
 * Whether a URL belongs to this installation's local server.
 * @param {string} url - candidate URL.
 * @returns {boolean} true for the loopback origin.
 */
function isLocalUrl(url) {
  return /^http:\/\/127\.0\.0\.1:\d+(?:[/?#]|$)/i.test(url)
}

/** Build the single application window, starting on the splash screen. */
function createWindow() {
  const iconPath = appFile('build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f14',
    title: APP_TITLE,
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = undefined
    app.quit()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalUrl(url)) openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLocalUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })

  void mainWindow.loadFile(appFile('splash.html'))
}

/**
 * Report a startup failure in the window and on disk, then exit.
 * @param {Error} error - the failure.
 */
async function reportStartupFailure(error) {
  log(`startup failed: ${error.stack ?? error.message}`)
  // A verification run must not wait for a human to dismiss the dialog.
  if (process.env.DSH_PORTABLE_CAPTURE_EXIT === '1') {
    app.exit(1)
    return
  }
  const detail = error.message
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: `${APP_TITLE} 启动失败`,
    message: '本地服务未能启动。',
    detail: `${detail}\n\n日志：${dirs.serverLog}`,
    buttons: ['打开日志文件夹', '退出'],
    defaultId: 1,
    noLink: true,
  })
  if (response === 0) void shell.openPath(dirs.logs)
  app.exit(1)
}

/** Start the runtime, repair stale paths, and show the Web application. */
async function boot() {
  log(`portable root: ${root}`)

  const migration = migratePortablePaths(dirs, APP_VERSION)
  if (migration.moved) {
    log(`paths migrated: ${migration.from} -> ${migration.to} (${migration.filesChanged ?? 0} files)`)
  }

  const env = portableEnvironment(dirs)
  const server = await startDshServer({
    resourcesPath: process.resourcesPath,
    dirs,
    env,
    onLog: () => {},
  })
  serverStop = server.stop
  log(`server ready: ${server.url.replace(/token=[^&]+/, 'token=***')}`)

  if (mainWindow === undefined) return
  await mainWindow.loadURL(server.url)
  mainWindow.setTitle(APP_TITLE)

  // Diagnostic hook: `DSH_PORTABLE_CAPTURE=<file.png>` writes a screenshot of
  // the rendered window, and `DSH_PORTABLE_CAPTURE_EXIT=1` closes it again.
  // Verification runs use it; ordinary launches ignore both variables.
  const captureTarget = process.env.DSH_PORTABLE_CAPTURE
  if (captureTarget !== undefined && captureTarget.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const image = await mainWindow.webContents.capturePage()
    fs.writeFileSync(captureTarget, image.toPNG())
    const text = await mainWindow.webContents.executeJavaScript('document.body.innerText').catch(() => '')
    fs.writeFileSync(`${captureTarget}.txt`, String(text), 'utf8')
    log(`captured window to ${captureTarget}`)
    if (process.env.DSH_PORTABLE_CAPTURE_EXIT === '1') app.quit()
  }
}

if (!app.requestSingleInstanceLock({ root })) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    createWindow()
    try {
      await boot()
    } catch (error) {
      await reportStartupFailure(error instanceof Error ? error : new Error(String(error)))
    }
  })

  app.on('before-quit', (event) => {
    if (quitting || serverStop === undefined) return
    event.preventDefault()
    quitting = true
    void Promise.resolve(serverStop()).finally(() => app.quit())
  })

  app.on('window-all-closed', () => app.quit())

  process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error.message}`))
}
