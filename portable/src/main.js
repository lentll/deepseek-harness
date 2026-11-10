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

const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, nativeImage, screen, shell } = require('electron')
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
const { closeAction, trayMenuTemplate, trayTooltip, hiddenNotice } = require('./window-lifecycle')

const APP_TITLE = 'DeepSeek Harness'
const APP_ID = 'cn.jiyuan.deepseek-harness.portable'
const APP_VERSION = require('../package.json').version

// Windows needs an AppUserModelID for tray notifications and stable taskbar
// grouping. Called before `ready`, as the platform expects.
app.setAppUserModelId(APP_ID)

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

/**
 * Absolute path inside the packaged `build` folder.
 *
 * The build script copies `build/` next to `src/`, not into it, so
 * `appFile('build', …)` would look for `src/build/…` and silently find nothing —
 * which is how the window icon went missing while every log line still looked
 * healthy. Keep build assets on this helper.
 * @param {string} name - file name inside `build`.
 * @returns {string} absolute path.
 */
function buildAsset(name) {
  return path.join(__dirname, '..', 'build', name)
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let serverStop
/** @type {BrowserWindow | undefined} */
let mainWindow
/** @type {Tray | undefined} */
let tray
/** Whether a tray icon exists, i.e. whether hiding the window can be undone. */
let trayReady = false
let quitting = false
let hiddenNoticeShown = false

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

/**
 * Bring the window back from the tray, restoring it if it was minimised.
 *
 * Showing a hidden window is not always enough on Windows: the process that
 * owns a tray icon is not the foreground process, so `show()` can leave the
 * window behind whatever the user was looking at. It then looks like the click
 * did nothing, and the second click of an impatient double-click is what
 * appears to "work". A one-shot always-on-top toggle lifts it above the current
 * foreground window and is reverted immediately, so nothing stays pinned.
 */
function showMainWindow() {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  if (!mainWindow.isFocused() && process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true)
    mainWindow.setAlwaysOnTop(false)
  }
  mainWindow.focus()
}

/** Tell the user once that the window went to the tray instead of closing. */
function notifyHidden() {
  if (hiddenNoticeShown) return
  hiddenNoticeShown = true
  try {
    tray?.displayBalloon({ title: APP_TITLE, content: hiddenNotice(APP_TITLE), iconType: 'info' })
  } catch (error) {
    // Balloons are best-effort: Windows may have notifications turned off.
    log(`tray balloon failed: ${error.message}`)
  }
}

/**
 * Create the notification-area icon.
 *
 * Failure is not fatal: without a tray there is nothing to restore the window
 * from, so the close button keeps its old meaning of "quit" (that decision
 * lives in closeAction()).
 */
function createTray() {
  const iconPath = buildAsset('icon.ico')
  try {
    const image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) throw new Error(`icon unreadable: ${iconPath}`)
    tray = new Tray(image)
    tray.setToolTip(trayTooltip({ title: APP_TITLE, version: APP_VERSION }))
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenuTemplate({
          onShow: () => showMainWindow(),
          onOpenLogs: () => void shell.openPath(dirs.logs),
          onQuit: () => app.quit(),
        }),
      ),
    )
    // A single left click is the whole gesture. Windows reports the first click
    // of a rapid double click here too, so a second listener for the double
    // click event would just run the same code twice — the icon is not a
    // "double-click me" control and must not depend on a second click.
    tray.on('click', () => showMainWindow())
    trayReady = true
    log('tray ready')
  } catch (error) {
    trayReady = false
    log(`tray unavailable, close will quit: ${error.message}`)
  }
}

/** Build the single application window, starting on the splash screen. */
function createWindow() {
  const iconPath = buildAsset('icon.ico')
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

  // The title-bar X hides the window into the tray instead of ending the
  // session; the tray menu's 退出 is the way out. Hiding is only done when a
  // tray icon actually exists, otherwise the window would vanish for good, so
  // the rule lives in closeAction() and falls back to quitting.
  mainWindow.on('close', (event) => {
    if (closeAction({ quitting, trayReady }) === 'quit') return
    event.preventDefault()
    mainWindow?.hide()
    notifyHidden()
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    // Reached while quitting, or when the renderer destroyed the window behind
    // our back; a resident process with no window to show is worse than exiting.
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

  // Diagnostic hook: `DSH_PORTABLE_CLOSE_TEST=1` clicks the title-bar X the way
  // a user would and records whether the app lived on with the window hidden.
  // `DSH_PORTABLE_CLOSE_TEST_SHOT=<file.png>` additionally grabs the screen
  // first, so the tray icon can be confirmed against the coordinates Electron
  // reports for it. Ordinary launches ignore both variables.
  if (process.env.DSH_PORTABLE_CLOSE_TEST === '1') {
    const visibleBefore = mainWindow.isVisible()
    const trayBounds = trayReady ? tray?.getBounds() : undefined
    const shot = process.env.DSH_PORTABLE_CLOSE_TEST_SHOT
    if (shot !== undefined && shot.length > 0) {
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height },
      })
      const primary = sources.find((source) => source.display_id === String(display.id)) ?? sources[0]
      if (primary !== undefined) fs.writeFileSync(shot, primary.thumbnail.toPNG())
    }
    mainWindow.close()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const line =
      `close test: tray=${trayReady} trayBounds=${JSON.stringify(trayBounds)} ` +
      `visibleBefore=${visibleBefore} visibleAfter=${mainWindow?.isVisible() ?? false} ` +
      `windows=${BrowserWindow.getAllWindows().length}`
    log(line)
    fs.writeFileSync(path.join(dirs.logs, 'close-test.txt'), `${line}\n`, 'utf8')
    app.quit()
  }

  // Diagnostic hook: `DSH_PORTABLE_TRAY_TEST=1` hides the window the way the X
  // does, publishes the tray icon rectangle, then records whether the window
  // came back. An external driver clicks that rectangle with a real mouse event,
  // so a passing run proves the icon answers a *single* click; emitting
  // `tray.emit('click')` here would only prove the handler is wired.
  if (process.env.DSH_PORTABLE_TRAY_TEST === '1') {
    const visibleBefore = mainWindow.isVisible()
    const bounds = trayReady ? tray?.getBounds() : undefined
    const boundsFile = path.join(dirs.logs, 'tray-test-bounds.json')
    fs.writeFileSync(boundsFile, JSON.stringify(bounds ?? null), 'utf8')
    mainWindow.close()
    const deadline = Date.now() + 15000
    while (mainWindow !== undefined && !mainWindow.isVisible() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const line =
      `tray test: tray=${trayReady} bounds=${JSON.stringify(bounds)} ` +
      `visibleBefore=${visibleBefore} visibleAfterClick=${mainWindow?.isVisible() ?? false}`
    log(line)
    fs.writeFileSync(path.join(dirs.logs, 'tray-test.txt'), `${line}\n`, 'utf8')
    app.quit()
  }
}

if (!app.requestSingleInstanceLock({ root })) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch is a request to see the window, including when the first
    // copy is sitting in the tray with no taskbar button.
    showMainWindow()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    createWindow()
    createTray()
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
