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

const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  resolvePortableRoot,
  portablePaths,
  ensurePortableDirectories,
  configureElectronPaths,
  portableEnvironment,
  ensureProfileOverlay,
  pruneEmptyDirectory,
} = require('./portable')
const { migratePortablePaths } = require('./path-migration')
const { repairWorkspaces } = require('./workspace-repair')
const { startDshServer, initProfile } = require('./dsh-server')
const { installSessionMenu } = require('./session-menu')
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
      // The page cannot delete a Session itself; the bridge in preload.js is
      // the single narrow channel for that one action.
      preload: appFile('preload.js'),
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

  // dsh ships no "delete Session" action, so the shell adds one to the Session
  // row menu after every load — including the reload that follows a confirmed
  // delete, which is why this is a load hook and not a one-shot call.
  const sessionMenuPatch = fs.readFileSync(appFile('session-menu-injected.js'), 'utf8')
  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents.executeJavaScript(sessionMenuPatch).catch((error) => {
      log(`session menu patch failed: ${error.message}`)
    })
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

/** Drop the empty `~/.dsh` the runtime leaves behind, if it is still empty. */
function pruneHostHome() {
  const hostHome = path.join(os.homedir(), '.dsh')
  if (pruneEmptyDirectory(hostHome)) log(`removed empty host folder: ${hostHome}`)
}

/**
 * Start the dsh server and remember how to stop it.
 *
 * Kept separate from {@link boot} so a delete can restart the runtime: dsh
 * indexes Session headers in memory at boot, so a running server keeps serving
 * a row whose log no longer exists until it is started again.
 *
 * @returns {Promise<{url: string, stop: () => unknown}>} the running server.
 */
async function startRuntime() {
  const server = await startDshServer({
    resourcesPath: process.resourcesPath,
    dirs,
    env: portableEnvironment(dirs),
    onLog: () => {},
  })
  serverStop = server.stop
  log(`server ready: ${server.url.replace(/token=[^&]+/, 'token=***')}`)
  return server
}

/** Stop the dsh server, if one is running, and forget its stop handle. */
async function stopRuntime() {
  const stop = serverStop
  serverStop = undefined
  if (stop === undefined) return
  await Promise.resolve(stop())
  log('server stopped')
}

/**
 * Stop the runtime, start it again on a fresh token, and load the window.
 *
 * The restart takes a few seconds because dsh rebuilds its plugin tree, so the
 * splash screen comes back first: a blank window for that long reads as a crash.
 *
 * @returns {Promise<void>} resolution after the window points at the new server.
 */
async function restartRuntime() {
  if (mainWindow !== undefined) await mainWindow.loadFile(appFile('splash.html'))
  await stopRuntime()
  const server = await startRuntime()
  if (mainWindow === undefined) return
  await mainWindow.loadURL(server.url)
  mainWindow.setTitle(APP_TITLE)
}

/** Start the runtime, repair stale paths, and show the Web application. */
async function boot() {
  log(`portable root: ${root}`)

  const migration = migratePortablePaths(dirs, APP_VERSION)
  if (migration.moved) {
    log(`paths migrated: ${migration.from} -> ${migration.to} (${migration.filesChanged ?? 0} files)`)
  }

  const env = portableEnvironment(dirs)

  // dsh resolves its first-use Workspace from the OS Documents folder, which is
  // a host path. The override has to be in the profile patch layer before the
  // Web application boots, so a first run materialises the profile first.
  const overlay = ensureProfileOverlay(dirs)
  if (overlay.reason === 'no-profile') {
    const created = await initProfile({ resourcesPath: process.resourcesPath, dirs, env })
    const retried = created ? ensureProfileOverlay(dirs) : { written: false, reason: 'profile-init-failed' }
    log(`workspace overlay: ${retried.reason}`)
  } else {
    log(`workspace overlay: ${overlay.reason}`)
  }

  // Workspaces recorded on the host disk (or on another machine's drive) are
  // re-pointed at the portable folder before the runtime loads the registry.
  const repaired = repairWorkspaces(dirs)
  if (repaired.changed) {
    const moved = repaired.moves.map((move) => `${move.from} -> ${move.to}`).join('; ')
    log(`workspaces re-pointed: ${moved}`)
  } else {
    log(`workspaces unchanged: ${repaired.reason ?? 'none'}`)
  }

  const server = await startRuntime()

  // The runtime touches `~/.dsh` during startup even though DSH_HOME is set;
  // clearing the empty leftover keeps the "nothing on the host" promise.
  pruneHostHome()

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

  // Diagnostic hook: `DSH_PORTABLE_DOM_TEST=<file.json>` records the sidebar's
  // session rows and the open context menu as raw markup, then quits. It exists
  // to answer one question with evidence instead of guesswork: does the page
  // expose the Session id anywhere in the DOM? Ordinary launches ignore it.
  const domTarget = process.env.DSH_PORTABLE_DOM_TEST
  if (domTarget !== undefined && domTarget.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const probe = `(() => {
      const attrs = new Set()
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes || []) if (a.name.startsWith('data-')) attrs.add(a.name)
      }
      const buttons = [...document.querySelectorAll('button')].slice(0, 40).map((b) => ({
        label: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        text: (b.innerText || '').trim().slice(0, 16),
        cls: String(b.className).slice(0, 70)
      }))
      const rows = [...document.querySelectorAll('[role="treeitem"], [role="option"], [role="row"]')]
        .slice(0, 3).map((el) => el.outerHTML.slice(0, 700))
      return { attrs: [...attrs].sort(), buttons, rows, sessionIds: (document.documentElement.innerHTML.match(/session-[0-9a-f]{8}-[0-9a-f]{4}/g) || []).slice(0, 5) }
    })()`
    const report = { beforeMenu: await mainWindow.webContents.executeJavaScript(probe).catch((e) => String(e)) }
    const clickMore = `(() => {
      window.__probeAdded = []
      window.__probeObserver = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) window.__probeAdded.push(n)
      })
      window.__probeObserver.observe(document.body, { childList: true, subtree: true })
      const row = document.querySelector('[data-row-key^="session:"] [data-context-menu-trigger]')
      if (!row) return 'no-session-trigger'
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      row.click()
      return 'clicked ' + (row.closest('[data-row-key]')?.getAttribute('data-row-key') ?? '?')
    })()`
    report.clicked = await mainWindow.webContents.executeJavaScript(clickMore).catch((e) => String(e))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const menuProbe = `(() => {
      const added = (window.__probeAdded || []).map((n) => ({ tag: n.tagName, cls: String(n.className).slice(0, 80), role: n.getAttribute('role'), html: n.outerHTML.slice(0, 5000) }))
      const menu = document.querySelector('[role="menu"][data-context-menu]')
      return {
        addedCount: added.length,
        added: added.slice(0, 2),
        menuItems: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.innerText.trim()) : [],
        menuHtml: menu ? menu.outerHTML.slice(0, 8000) : '',
        icons: [...document.querySelectorAll('symbol')].map((s) => s.id).filter((id) => /trash|delete|remove|cross|close|bin/i.test(id)).slice(0, 20)
      }
    })()`
    report.menu = await mainWindow.webContents.executeJavaScript(menuProbe).catch((e) => String(e))
    fs.writeFileSync(domTarget, JSON.stringify(report, null, 2), 'utf8')
    log(`wrote DOM report to ${domTarget}`)
    app.quit()
  }

  // Diagnostic hook: `DSH_PORTABLE_DELETE_PROBE=<file.json>` walks the whole
  // delete path the way a user does — open the row menu, read the entries,
  // click the injected one — and records what happened. It pairs with
  // `DSH_PORTABLE_DELETE_TEST=1`, which answers the native dialog automatically.
  // Ordinary launches ignore both variables.
  const deleteProbe = process.env.DSH_PORTABLE_DELETE_PROBE
  if (deleteProbe !== undefined && deleteProbe.length > 0) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const report = {}
    const js = (code) => mainWindow.webContents.executeJavaScript(code).catch((error) => `error: ${error.message}`)
    await wait(4500)
    report.opened = await js(`(() => {
      const trigger = document.querySelector('[data-row-key^="session:"] [data-context-menu-trigger]')
      if (!trigger) return 'no-session-row'
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger.click()
      return trigger.closest('[data-row-key]').getAttribute('data-row-key')
    })()`)
    await wait(700)
    report.beforeDelete = await js('performance.timeOrigin')
    report.menu = await js(`(() => {
      const menu = document.querySelector('[role="menu"][data-context-menu]')
      if (!menu) return 'no-menu'
      const items = [...menu.querySelectorAll('[role="menuitem"]')]
      const entry = items.find((item) => (item.innerText || '').includes('删除会话'))
      const composed = entry === undefined ? null : getComputedStyle(entry).color
      if (entry !== undefined) entry.click()
      return { labels: items.map((item) => (item.innerText || '').split('\\n')[0].trim()), clicked: entry !== undefined, color: composed }
    })()`)
    // `DSH_PORTABLE_DIALOG_SHOT=<file.png>` grabs the native confirmation the
    // user actually sees, then exits without answering it. Paired with no
    // DSH_PORTABLE_DELETE_TEST, the dialog stays open for the screenshot.
    const dialogShot = process.env.DSH_PORTABLE_DIALOG_SHOT
    if (dialogShot !== undefined && dialogShot.length > 0) {
      await wait(1800)
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height },
      })
      const primary = sources.find((source) => source.display_id === String(display.id)) ?? sources[0]
      if (primary !== undefined) fs.writeFileSync(dialogShot, primary.thumbnail.toPNG())
      log(`captured the delete dialog to ${dialogShot}`)
      app.quit()
      return
    }

    // The host restarts the runtime before it answers, so the page navigates
    // mid-call: poll until the injected patch is back on a loaded document
    // instead of assuming a fixed delay.
    report.afterReload = { pending: true }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(1000)
      const state = await js(`({
        ready: document.readyState,
        origin: performance.timeOrigin,
        patchInstalled: window.__dshPortableDeleteSession === true,
        rows: document.querySelectorAll('[data-row-key^="session:"]').length,
        titles: [...document.querySelectorAll('[data-row-key^="session:"] [class*="title"]')].map((n) => n.textContent.trim()),
        url: location.href.replace(/token=[^&]+/, 'token=***')
      })`)
      const reloaded = typeof state === 'object' && state.origin !== report.beforeDelete
      if (reloaded && state.patchInstalled === true && state.rows > 0) {
        report.afterReload = state
        break
      }
      report.afterReload = state
    }
    report.sessionsOnDisk = fs.existsSync(path.join(dirs.dshHome, 'sessions'))
      ? fs.readdirSync(path.join(dirs.dshHome, 'sessions'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) =>
            fs.readdirSync(path.join(dirs.dshHome, 'sessions', entry.name)).map((name) => `${entry.name}/${name}`),
          )
      : []
    fs.writeFileSync(deleteProbe, JSON.stringify(report, null, 2), 'utf8')
    log(`wrote delete probe to ${deleteProbe}`)
    app.quit()
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
    installSessionMenu({
      ipcMain,
      dialog,
      getWindow: () => mainWindow,
      dirs,
      log,
      icon: nativeImage.createFromPath(buildAsset('icon.ico')),
      stopRuntime,
      startRuntime: restartRuntime,
    })
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
