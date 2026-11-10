/**
 * Host half of the "delete Session" entry.
 *
 * dsh keeps a Session as a directory of JSONL logs under
 * `<DSH_HOME>/sessions/<workspace-key>/<session-id>/`. The application can
 * archive one, which only adds its id to a hidden set, and it can delete a
 * *Workspace*, which merely unlists it — neither removes a log. So the file
 * system part lives here, behind one IPC channel, and the renderer never
 * supplies a path.
 *
 * The lookup is deliberately narrow: the id must be a well-formed Session id,
 * it must be found as a direct child of a group directory *inside*
 * `sessions/`, and nothing else is ever removed. A confirmed delete removes
 * that one directory; the group stays, because another Session may live there
 * and an empty group is harmless.
 */
const fs = require('node:fs')
const path = require('node:path')

const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * How long the host waits before restarting dsh after answering a delete.
 *
 * Long enough for the renderer to paint the row as gone (one frame would do,
 * but a slow machine needs margin), short enough that nobody wonders whether
 * the click registered.
 */
const DELETE_FEEDBACK_MS = 500

/**
 * Whether a string is a Session id this host is willing to act on.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true for a canonical `session-<uuid>` id.
 */
function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Resolve the directory that holds one Session, without touching the file system.
 * @param {object} options - lookup inputs.
 * @param {string} options.sessionsRoot - absolute `sessions/` directory.
 * @param {string} options.sessionId - id to resolve.
 * @param {(root: string) => string[]} options.listGroups - reads one level of group names.
 * @param {(candidate: string) => boolean} options.isDirectory - directory probe.
 * @returns {{ok: true, directory: string, group: string}|{ok: false, reason: string}} the plan.
 */
function planSessionDeletion({ sessionsRoot, sessionId, listGroups, isDirectory }) {
  if (!isSessionId(sessionId)) return { ok: false, reason: 'invalid-id' }

  let groups
  try {
    groups = listGroups(sessionsRoot)
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error.message}` }
  }

  const root = path.resolve(sessionsRoot)
  for (const group of groups) {
    const candidate = path.resolve(root, group, sessionId)
    // A group name comes from the disk, not from the renderer, but the
    // containment check keeps a symlinked or hand-edited tree from aiming the
    // delete outside `sessions/`.
    if (!candidate.startsWith(`${root}${path.sep}`)) continue
    if (isDirectory(candidate)) return { ok: true, directory: candidate, group }
  }
  return { ok: false, reason: 'not-found' }
}

/**
 * Delete one Session directory after resolving it through {@link planSessionDeletion}.
 * @param {object} options - lookup inputs plus the remover.
 * @param {object} options.sessionsRoot - see above.
 * @param {string} options.sessionId - id to delete.
 * @param {(root: string) => string[]} options.listGroups - see above.
 * @param {(candidate: string) => boolean} options.isDirectory - see above.
 * @param {(directory: string) => void} options.remove - removes one directory tree.
 * @returns {{ok: true, directory: string, group: string}|{ok: false, reason: string}} the outcome.
 */
function deleteSessionRecord(options) {
  const plan = planSessionDeletion(options)
  if (!plan.ok) return plan
  try {
    options.remove(plan.directory)
  } catch (error) {
    return { ok: false, reason: `remove-failed: ${error.message}` }
  }
  return plan
}

/** Default file-system adapters, kept injectable for tests. */
const disk = {
  listGroups: (root) =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  isDirectory: (candidate) => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  },
  remove: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
}

/**
 * Drop every reference to one Session from the Workspace state document.
 *
 * The archived and pinned sets live at the top level; the accounting slots live
 * per Workspace. A deleted Session must leave both, otherwise the next start
 * still lists a row whose log no longer exists. Pure: the input is not mutated,
 * so the caller can compare identity to detect a no-op.
 *
 * @param {object} document - parsed `storages/workspace.json`.
 * @param {string} sessionId - id to forget.
 * @returns {{document: object, changed: boolean}} the cleaned document and whether anything moved.
 */
function purgeSessionReferences(document, sessionId) {
  if (typeof document !== 'object' || document === null) return { document, changed: false }
  let changed = false

  const global = { ...document.global }
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    const current = global[key]
    if (!Array.isArray(current) || !current.includes(sessionId)) continue
    global[key] = current.filter((id) => id !== sessionId)
    changed = true
  }

  const tables = { ...document.tables }
  if (typeof tables.workspaces === 'object' && tables.workspaces !== null) {
    const workspaces = {}
    for (const [id, entry] of Object.entries(tables.workspaces)) {
      if (Array.isArray(entry?.sessionIds) && entry.sessionIds.includes(sessionId)) {
        workspaces[id] = { ...entry, sessionIds: entry.sessionIds.filter((item) => item !== sessionId) }
        changed = true
      } else {
        workspaces[id] = entry
      }
    }
    tables.workspaces = workspaces
  }

  return changed ? { document: { ...document, global, tables }, changed } : { document, changed: false }
}

/**
 * Apply {@link purgeSessionReferences} to the Workspace state file, atomically.
 * @param {string} file - absolute `storages/workspace.json`.
 * @param {string} sessionId - id to forget.
 * @returns {boolean} whether the file was rewritten.
 */
function purgeStateFile(file, sessionId) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  const { document, changed } = purgeSessionReferences(parsed, sessionId)
  if (!changed) return false
  const temporary = `${file}.portable-tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
  return true
}

/**
 * Wire the IPC channel that the injected menu entry calls.
 *
 * The dialog is native and defaults to Cancel, because deleting a log cannot be
 * undone and Enter should not confirm a destructive action by accident.
 *
 * The runtime is stopped before the directory goes away and started again
 * afterwards: dsh indexes Session headers in memory at boot, so a running
 * process would keep serving the row it can no longer read. Only a restart
 * makes the list match the disk; a page reload alone cannot, because the server
 * answers from that index.
 *
 * The answer, however, is not held back until the restart finishes. dsh takes
 * several seconds to rebuild its plugin tree, and making the user stare at a
 * splash screen to learn that a click worked is the wrong trade: the handler
 * answers as soon as the directory is gone, the renderer drops the row, and the
 * restart runs behind that answer.
 *
 * @param {object} options - host wiring.
 * @param {Electron.IpcMain} options.ipcMain - main-process IPC hub.
 * @param {Electron.Dialog} options.dialog - native dialog module.
 * @param {() => Electron.BrowserWindow|undefined} options.getWindow - window for the dialog.
 * @param {{dshHome: string}} options.dirs - portable directories.
 * @param {(line: string) => void} options.log - shell log sink.
 * @param {Electron.NativeImage} [options.icon] - window icon for the dialog.
 * @param {() => Promise<void>} options.stopRuntime - stops the dsh server, if running.
 * @param {() => Promise<void>} options.restartRuntime - starts it again and reloads the window.
 * @returns {void}
 */
function installSessionMenu({ ipcMain, dialog, getWindow, dirs, log, icon, stopRuntime, restartRuntime }) {
  const sessionsRoot = path.join(dirs.dshHome, 'sessions')
  const stateFile = path.join(dirs.dshHome, 'storages', 'workspace.json')
  let restartTimer

  /**
   * Start the runtime again once the renderer has had a moment to drop the row.
   *
   * The short delay is what makes the feedback land first: the row disappears,
   * then the splash screen takes over, so the click visibly did something
   * instead of the window blanking out before the list changes. One timer at a
   * time, so deleting two Sessions in a row cannot start two servers.
   */
  function scheduleRestart() {
    if (restartTimer !== undefined) return
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      void Promise.resolve(restartRuntime()).catch((error) => {
        log(`delete session: runtime restart failed (${error.message})`)
      })
    }, DELETE_FEEDBACK_MS)
  }

  ipcMain.handle('portable:delete-session', async (_event, payload) => {
    const sessionId = payload?.sessionId
    const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
    if (!isSessionId(sessionId)) return { deleted: false, reason: 'invalid-id' }

    // Verification runs pass DSH_PORTABLE_DELETE_TEST=1 so an automated driver
    // can walk the whole path without a human clicking the dialog.
    if (process.env.DSH_PORTABLE_DELETE_TEST !== '1') {
      const window = getWindow()
      // Cancel is both the default and the cancel button, so Enter, Escape and
      // the dialog's close box all land on "keep the session". Deleting is a
      // deliberate click on the second button and nothing else.
      const options = {
        type: 'warning',
        noLink: true,
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        title: '删除会话',
        message: title.length > 0 ? `删除会话「${title}」？` : '删除这个会话？',
        detail: '会话记录会从 U 盘上永久删除，无法恢复。会话里的文件本身不受影响；如果这个会话还在运行，正在进行的任务会被中断。',
        ...(icon !== undefined && !icon.isEmpty() ? { icon } : {}),
      }
      const answer = window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options)
      if (answer.response !== 1) return { deleted: false, reason: 'cancelled' }
    }

    try {
      await stopRuntime()
    } catch (error) {
      log(`delete session: could not stop the runtime (${error.message})`)
    }

    const outcome = deleteSessionRecord({
      sessionsRoot,
      sessionId,
      listGroups: disk.listGroups,
      isDirectory: disk.isDirectory,
      remove: disk.remove,
    })

    if (outcome.ok && purgeStateFile(stateFile, sessionId)) log(`delete session: dropped ${sessionId} from workspace state`)

    if (!outcome.ok) {
      log(`delete session: ${sessionId} not deleted (${outcome.reason})`)
      // The runtime is already down. Bring it back before answering, so a
      // failed delete does not leave the window pointing at a dead server.
      try {
        await restartRuntime()
      } catch (error) {
        log(`delete session: runtime restart failed (${error.message})`)
        return { deleted: false, reason: outcome.reason, reloaded: false }
      }
      return { deleted: false, reason: outcome.reason, reloaded: true }
    }

    log(`delete session: removed ${outcome.directory}`)
    scheduleRestart()
    return { deleted: true, directory: outcome.directory, restarting: true }
  })
}

module.exports = {
  SESSION_ID_PATTERN,
  DELETE_FEEDBACK_MS,
  isSessionId,
  planSessionDeletion,
  deleteSessionRecord,
  purgeSessionReferences,
  installSessionMenu,
}
