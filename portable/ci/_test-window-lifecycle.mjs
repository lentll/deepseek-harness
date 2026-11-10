/**
 * Offline tests for src/window-lifecycle.js.
 *
 * The close button used to quit the app outright, and the fix is only correct
 * if two things hold: a normal close hides the window (so the session survives),
 * and every other case still allows the process to exit. The second half is the
 * dangerous one — a close that hides while the app is already quitting leaves a
 * windowless process holding the runtime, which is precisely the bug this screen
 * is meant to prevent. No Electron import here on purpose: these rules must be
 * checkable without launching a window.
 */

import fs from 'node:fs'
import assert from 'node:assert/strict'
import { closeAction, trayMenuTemplate, trayTooltip, hiddenNotice } from '../src/window-lifecycle.js'

let passed = 0
let failed = 0

/**
 * Run one assertion block and record the outcome.
 * @param {string} name - test name.
 * @param {() => void} body - assertions.
 * @returns {void}
 */
function check(name, body) {
  try {
    body()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message.split('\n')[0]}`)
  }
}

console.log('closeAction()')
check('a normal close hides into the tray', () => {
  assert.equal(closeAction({ quitting: false, trayReady: true }), 'hide')
})
check('no tray icon means the close quits', () => {
  assert.equal(closeAction({ quitting: false, trayReady: false }), 'quit')
})
check('a close during shutdown always quits', () => {
  assert.equal(closeAction({ quitting: true, trayReady: true }), 'quit')
  assert.equal(closeAction({ quitting: true, trayReady: false }), 'quit')
})
check('hide is never returned while quitting', () => {
  for (const trayReady of [true, false]) {
    assert.notEqual(closeAction({ quitting: true, trayReady }), 'hide')
  }
})
check('hide requires a tray in every combination', () => {
  for (const quitting of [true, false]) {
    assert.equal(closeAction({ quitting, trayReady: false }), 'quit')
  }
})

console.log('trayMenuTemplate()')
const handlers = { onShow() {}, onOpenLogs() {}, onQuit() {} }
check('menu order is show, logs, separator, quit', () => {
  const ids = trayMenuTemplate(handlers).map((item) => item.id ?? item.type)
  assert.deepEqual(ids, ['show', 'logs', 'separator', 'quit'])
})
check('exactly one separator', () => {
  const separators = trayMenuTemplate(handlers).filter((item) => item.type === 'separator')
  assert.equal(separators.length, 1)
})
check('the exit item is last, so it cannot be clicked by accident', () => {
  const menu = trayMenuTemplate(handlers)
  assert.equal(menu[menu.length - 1].id, 'quit')
  assert.equal(menu[menu.length - 1].label, '退出')
})
check('every visible item is clickable and labelled', () => {
  for (const item of trayMenuTemplate(handlers)) {
    if (item.type === 'separator') continue
    assert.equal(typeof item.label, 'string')
    assert.ok(item.label.length > 0, 'empty label')
    assert.equal(typeof item.click, 'function', `${item.id} has no handler`)
  }
})
check('callbacks are wired to the matching items', () => {
  const menu = trayMenuTemplate(handlers)
  const byId = Object.fromEntries(menu.filter((item) => item.id).map((item) => [item.id, item]))
  assert.equal(byId.show.click, handlers.onShow)
  assert.equal(byId.logs.click, handlers.onOpenLogs)
  assert.equal(byId.quit.click, handlers.onQuit)
})

console.log('trayTooltip() / hiddenNotice()')
check('tooltip names the app, the version and the double-click', () => {
  const text = trayTooltip({ title: 'DeepSeek Harness', version: '1.2.3' })
  assert.ok(text.includes('DeepSeek Harness'))
  assert.ok(text.includes('1.2.3'))
  assert.ok(text.includes('双击'))
})
check('the one-time notice explains both ways back', () => {
  const text = hiddenNotice('DeepSeek Harness')
  assert.ok(text.includes('托盘'))
  assert.ok(text.includes('退出'))
  assert.ok(text.includes('DeepSeek Harness'))
})

console.log('main.js wiring')
const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
// Comments explain the old bug and mention the wrong helper on purpose.
const mainCode = mainSource.replace(/\/\*[\s\S]*?\*\//g, '')
check('icons load from build/, never from src/build/', () => {
  assert.ok(mainCode.includes("buildAsset('icon.ico')"), 'icon must come from buildAsset()')
  assert.equal(
    mainCode.includes("appFile('build'"),
    false,
    "appFile('build') resolves to src/build/ and silently finds nothing",
  )
})
check('the close handler consults closeAction()', () => {
  assert.ok(mainCode.includes('closeAction({ quitting, trayReady })'))
})
check('the tray menu is built from the shared template', () => {
  assert.ok(mainCode.includes('trayMenuTemplate({'))
})

console.log(`\npassed ${passed}, failed ${failed}`)
if (failed > 0) process.exit(1)
