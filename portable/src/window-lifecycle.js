/**
 * Window close and tray window rules.
 *
 * Every function here is pure: it takes plain values and returns plain values.
 * main.js owns the Electron objects and performs the side effects, which keeps
 * the rules testable without launching a window (see ci/_test-window-lifecycle.mjs).
 */

'use strict'

/**
 * Decide what a close request means: hide into the tray, or really quit.
 *
 * Hiding is only safe when a tray icon exists, otherwise the window would
 * disappear with no way to bring it back. A close that arrives while the app is
 * already quitting must always be allowed through, or the process never exits.
 *
 * @param {{ quitting: boolean, trayReady: boolean }} state - close context.
 * @returns {'hide'|'quit'} the action to take.
 */
function closeAction({ quitting, trayReady }) {
  if (quitting) return 'quit'
  if (!trayReady) return 'quit'
  return 'hide'
}

/**
 * Build the tray context menu.
 *
 * The labels are Chinese on purpose: the whole UI ships in Chinese, and a
 * half-translated native menu looks like a bug. Order is fixed — the window
 * action first, the destructive exit last, separated from the rest.
 *
 * @param {{ onShow: Function, onOpenLogs: Function, onQuit: Function }} handlers - menu callbacks.
 * @returns {Array<object>} Electron menu template.
 */
function trayMenuTemplate({ onShow, onOpenLogs, onQuit }) {
  return [
    { id: 'show', label: '显示主窗口', type: 'normal', click: onShow },
    { id: 'logs', label: '打开日志文件夹', type: 'normal', click: onOpenLogs },
    { type: 'separator' },
    { id: 'quit', label: '退出', type: 'normal', click: onQuit },
  ]
}

/**
 * Tooltip text shown when the pointer rests on the tray icon.
 *
 * @param {{ title: string, version: string }} info - application identity.
 * @returns {string} tooltip text.
 */
function trayTooltip({ title, version }) {
  return `${title} ${version} · 单击图标打开窗口`
}

/**
 * One-time hint after the first hide, so a vanished window is explainable.
 *
 * @param {string} title - application name.
 * @returns {string} notification body.
 */
function hiddenNotice(title) {
  return `${title} 仍在后台运行：单击托盘图标可重新打开，右键托盘图标可退出。`
}

module.exports = { closeAction, trayMenuTemplate, trayTooltip, hiddenNotice }
