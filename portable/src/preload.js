/**
 * Preload for the portable shell window.
 *
 * The Web application ships an "archive" action for a Session but no delete:
 * dsh treats a Session log as the durable record of a run, so the upstream
 * surface never removes one. Deleting has to touch the file system, which the
 * page cannot do, so the menu entry the shell injects calls exactly one narrow
 * channel: an id and the title to show in the confirmation dialog.
 *
 * Only that one method is exposed. Nothing else crosses the boundary, and the
 * renderer cannot name a path — the host resolves the directory itself.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPortable', {
  /**
   * Ask the host to delete one Session record, after it confirms with the user.
   * @param {string} sessionId - id shown in the row's `data-row-key`.
   * @param {string} title - Session title, used only for the dialog text.
   * @returns {Promise<{deleted: boolean, reason?: string}>} host outcome.
   */
  deleteSession: (sessionId, title) => ipcRenderer.invoke('portable:delete-session', { sessionId, title }),
})
