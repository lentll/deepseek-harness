/**
 * Keep the default Workspace inside the portable root.
 *
 * dsh derives its first-use Workspace from the operating system's Documents
 * folder, so on a normal Windows machine it lands in
 * `%USERPROFILE%\Documents\deepseek-harness\default-workspace` — the host disk,
 * not the USB stick. Anything the agent writes there (including skills pulled
 * from the skill store, which install into the Workspace) stays behind when the
 * stick is unplugged, and a Workspace recorded on another machine points at a
 * path that no longer exists.
 *
 * Two repairs run on every start:
 *
 *   1. a Workspace whose directory is gone is re-pointed at the portable
 *      `data\workspace` folder, so a stick mounted under a new drive letter or
 *      plugged into a new machine still opens something;
 *   2. the automatic `default-workspace` is moved onto the stick even when its
 *      host folder still exists, because that folder is the residue this build
 *      exists to avoid.
 *
 * Content is copied, never deleted: the host folder is left exactly as it was
 * and the report names it, so a failed or unwanted migration can be undone by
 * hand.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Title dsh gives the Workspace it creates on first use. */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace'

/** Content above this size is re-pointed but not copied; a full copy could fill the stick. */
const MAX_COPY_BYTES = 64 * 1024 * 1024

/** Characters Windows refuses in a directory name, plus the reserved device names' shape. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Turn a Workspace title into a directory name that is safe on Windows.
 * @param {string} title - Workspace title.
 * @param {string} fallback - name to use when the title carries nothing usable.
 * @returns {string} a single path segment.
 */
function safeName(title, fallback = 'workspace') {
  const cleaned = String(title ?? '')
    .replace(UNSAFE_NAME, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  if (cleaned.length === 0) return fallback
  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are device names, not files.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}-dir`
  return cleaned
}

/**
 * Whether a path already lives under the portable root.
 * @param {string} root - portable root.
 * @param {string} target - path to test.
 * @returns {boolean} true when the path is inside the root.
 */
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Measure a directory tree without following links.
 * @param {string} directory - root to measure.
 * @returns {number} total bytes, or 0 when unreadable.
 */
function directorySize(directory) {
  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) walk(absolute)
        else if (entry.isFile()) total += fs.statSync(absolute).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  walk(directory)
  return total
}

/**
 * Decide where each Workspace should live.
 *
 * Pure: the caller supplies the two filesystem facts this needs, so the rules
 * can be tested without a disk.
 *
 * @param {object} document - parsed `storages/workspace.json`.
 * @param {object} facts - filesystem facts.
 * @param {string} facts.workspaceRoot - portable folder that holds re-pointed Workspaces.
 * @param {string} facts.root - portable root, used to recognise paths already inside it.
 * @param {(target: string) => boolean} facts.isDirectory - whether a directory exists.
 * @param {(target: string) => number} [facts.sizeOf] - directory size, for the copy budget.
 * @returns {{document: object, moves: Array<object>, ensure: string[], unchanged: number}} the
 *   repaired document (a new object; the input is not mutated), the moves to carry out, and
 *   in-root folders that should exist but may have been deleted.
 */
function planWorkspaceRepair(document, { workspaceRoot, root, isDirectory, sizeOf = () => 0 }) {
  const table = document?.tables?.workspaces
  if (typeof table !== 'object' || table === null) {
    return { document, moves: [], ensure: [], unchanged: 0 }
  }

  const used = new Set()
  for (const entry of Object.values(table)) {
    if (typeof entry?.path === 'string') used.add(path.resolve(entry.path).toLowerCase())
  }

  const moves = []
  const ensure = []
  let unchanged = 0
  const next = { ...document, tables: { ...document.tables, workspaces: {} } }

  for (const [id, entry] of Object.entries(table)) {
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string' || entry.path.length === 0) {
      next.tables.workspaces[id] = entry
      unchanged += 1
      continue
    }

    const original = entry.path
    const exists = isDirectory(original)
    const automatic = entry.title === DEFAULT_WORKSPACE_TITLE
    // Already on the stick: nothing to move, but the folder may have been
    // deleted, so it is recreated rather than migrated a second time.
    if (isInside(root, original)) {
      if (automatic && !exists) ensure.push(original)
      next.tables.workspaces[id] = entry
      unchanged += 1
      continue
    }
    // A folder the user picked by hand is left alone.
    if (exists && !automatic) {
      next.tables.workspaces[id] = entry
      unchanged += 1
      continue
    }

    const base = automatic ? DEFAULT_WORKSPACE_TITLE : safeName(entry.title ?? path.basename(original))
    let name = base
    let counter = 2
    while (used.has(path.resolve(path.join(workspaceRoot, name)).toLowerCase())) {
      name = `${base}-${counter}`
      counter += 1
    }
    const target = path.join(workspaceRoot, name)
    used.add(path.resolve(target).toLowerCase())

    const bytes = exists ? sizeOf(original) : 0
    moves.push({
      id,
      title: entry.title ?? name,
      from: original,
      to: target,
      copies: exists && bytes <= MAX_COPY_BYTES,
      bytes,
    })
    next.tables.workspaces[id] = { ...entry, path: target }
  }

  return { document: next, moves, ensure, unchanged }
}

/**
 * Apply the plan to disk: create the target folders, copy small content across,
 * rewrite the storage document, and leave a report next to the logs.
 *
 * @param {Record<string, string>} dirs - result of `portablePaths`.
 * @returns {{changed: boolean, moves: Array<object>, report: string|null, reason?: string}}
 *   what happened.
 */
function repairWorkspaces(dirs) {
  const storageFile = path.join(dirs.dshHome, 'storages', 'workspace.json')
  let text
  try {
    text = fs.readFileSync(storageFile, 'utf8')
  } catch {
    // No storage yet: the profile has never started, nothing to repair.
    return { changed: false, moves: [], report: null, reason: 'no-storage' }
  }

  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { changed: false, moves: [], report: null, reason: 'unreadable' }
  }

  const plan = planWorkspaceRepair(document, {
    workspaceRoot: dirs.workspace,
    root: dirs.root,
    isDirectory: (target) => {
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    sizeOf: directorySize,
  })
  if (plan.moves.length === 0) {
    // In-root folders can disappear on their own (the user cleaned up, or a
    // sync tool removed an empty directory); recreate them so opening the
    // Workspace does not fail.
    for (const target of plan.ensure) {
      try {
        fs.mkdirSync(target, { recursive: true })
      } catch {
        // A folder that cannot be created is reported by the runtime, not here.
      }
    }
    return { changed: false, moves: [], report: null, reason: 'nothing-to-move' }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const results = []

  for (const move of plan.moves) {
    const record = { ...move, copied: false, copyError: null }
    try {
      fs.mkdirSync(move.to, { recursive: true })
    } catch (error) {
      record.copyError = error.message
      results.push(record)
      continue
    }
    if (move.copies) {
      try {
        fs.cpSync(move.from, move.to, { recursive: true, force: true, errorOnExist: false })
        record.copied = true
      } catch (error) {
        // A partial copy still leaves the Workspace usable on the stick; the
        // host folder keeps the original either way.
        record.copyError = error.message
      }
    }
    results.push(record)
  }

  const backupFile = path.join(dirs.backup, `workspace-${stamp}.json`)
  try {
    fs.mkdirSync(dirs.backup, { recursive: true })
    fs.copyFileSync(storageFile, backupFile)
  } catch {
    // The rewrite below is still safe: the original text is in memory.
  }

  try {
    fs.writeFileSync(storageFile, `${JSON.stringify(plan.document, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { changed: false, moves: results, report: null, reason: `write-failed: ${error.message}` }
  }

  const reportFile = path.join(dirs.logs, `workspace-repair-${stamp}.json`)
  const report = {
    at: new Date().toISOString(),
    workspaceRoot: dirs.workspace,
    moves: results.map((move) => ({
      title: move.title,
      from: move.from,
      to: move.to,
      bytes: move.bytes,
      copied: move.copied,
      copyError: move.copyError,
      // The host folder is never deleted; this is what the person may remove.
      leftover: move.copied ? move.from : null,
    })),
  }
  try {
    fs.mkdirSync(dirs.logs, { recursive: true })
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // A missing report does not undo a finished repair.
  }

  return { changed: true, moves: results, report: reportFile }
}

module.exports = {
  DEFAULT_WORKSPACE_TITLE,
  MAX_COPY_BYTES,
  planWorkspaceRepair,
  repairWorkspaces,
  safeName,
  isInside,
  directorySize,
}
