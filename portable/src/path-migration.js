/**
 * Self-healing paths for a portable install.
 *
 * Sessions, settings, and profile patches store absolute paths. When the USB
 * stick mounts under a different drive letter or folder on another machine,
 * those stored paths still point at the old location. This module rewrites the
 * recorded portable root to the current one, once per move, and records what it
 * touched so the change is auditable.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Text formats that can carry an absolute path. Binary stores are skipped. */
const TEXT_EXTENSIONS = new Set([
  '.json', '.jsonl', '.ndjson', '.yml', '.yaml', '.toml', '.txt', '.md', '.log', '.cfg', '.ini',
])

/** Files larger than this are left untouched; no real path record is that big. */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** Per-file backup ceiling; keeps an accidental migration from duplicating a whole session corpus. */
const MAX_BACKUP_BYTES = 1024 * 1024

/** Total backup ceiling for one migration. */
const MAX_BACKUP_TOTAL_BYTES = 200 * 1024 * 1024

/** Directory names never walked: dependencies and binary caches carry no path records. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'cache', 'backup', 'tmp'])

/**
 * Compare two absolute paths the way Windows does.
 * @param {string} left - first path.
 * @param {string} right - second path.
 * @returns {boolean} whether both name the same location.
 */
function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * Spellings a stored path can take inside a text file. JSON escapes every
 * backslash, YAML and logs usually keep it literal, and forward slashes appear
 * in URLs and POSIX-style tool output.
 * @param {string} root - absolute path to spell.
 * @returns {string[]} the same path in four spellings, JSON-escaped first.
 */
function pathSpellings(root) {
  const absolute = path.resolve(root).replace(/[\\/]+$/, '')
  const escaped = absolute.split('\\').join('\\\\')
  return [escaped, escaped.split('/').join('\\/'), absolute, absolute.split('\\').join('/')]
}

/**
 * Replace every stored spelling of `from` with the matching spelling of `to`.
 * Both sides are spelled in the same order, so a JSON-escaped occurrence keeps
 * its escaping after the rewrite.
 * @param {string} text - file contents.
 * @param {string} from - previous portable root.
 * @param {string} to - current portable root.
 * @returns {{text: string, replacements: number}} rewritten contents and hit count.
 */
function rewriteRoot(text, from, to) {
  const sources = pathSpellings(from)
  const targets = pathSpellings(to)
  let result = text
  let replacements = 0
  for (let index = 0; index < sources.length; index += 1) {
    const needle = sources[index]
    if (needle.length === 0 || !containsFold(result, needle)) continue
    const pattern = new RegExp(escapeRegExp(needle), 'gi')
    const before = result
    result = result.replace(pattern, () => targets[index])
    if (result !== before) replacements += countFold(before, needle)
  }
  return { text: result, replacements }
}

/**
 * Escape a literal for use inside a RegExp.
 * @param {string} value - literal text.
 * @returns {string} escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive containment test.
 * @param {string} haystack - text to search.
 * @param {string} needle - literal to find.
 * @returns {boolean} whether the literal occurs.
 */
function containsFold(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Count case-insensitive occurrences.
 * @param {string} haystack - text to search.
 * @param {string} needle - literal to count.
 * @returns {number} occurrence count.
 */
function countFold(haystack, needle) {
  const lowerHaystack = haystack.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let count = 0
  let index = lowerHaystack.indexOf(lowerNeedle)
  while (index !== -1) {
    count += 1
    index = lowerHaystack.indexOf(lowerNeedle, index + lowerNeedle.length)
  }
  return count
}

/**
 * Collect candidate files below a directory.
 * @param {string} directory - root to walk.
 * @returns {string[]} absolute file paths.
 */
function collectTextFiles(directory) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      found.push(absolute)
    }
  }
  walk(directory)
  return found
}

/**
 * Read and write the portable state record.
 * @param {string} stateFile - absolute path to `portable-state.json`.
 * @returns {{root?: string, lastRunAt?: string, version?: string}} stored state.
 */
function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the portable state record.
 * @param {string} stateFile - absolute path to `portable-state.json`.
 * @param {{root: string, lastRunAt: string, version: string}} state - values to store.
 * @returns {void}
 */
function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Rewrite stale portable roots after the installation moved.
 * @param {Record<string, string>} dirs - result of `portablePaths`.
 * @param {string} version - application version recorded in the state file.
 * @returns {{moved: boolean, from?: string, to?: string, filesChanged?: number, replacements?: number, report?: string}}
 *   summary of the migration; `moved` is false when no rewrite was needed.
 */
function migratePortablePaths(dirs, version) {
  const state = readState(dirs.stateFile)
  const now = new Date().toISOString()
  const previous = typeof state.root === 'string' ? state.root : ''

  if (previous.length === 0 || samePath(previous, dirs.root)) {
    writeState(dirs.stateFile, { root: dirs.root, lastRunAt: now, version })
    return { moved: false }
  }

  const stamp = now.replace(/[:.]/g, '-')
  const backupRoot = path.join(dirs.backup, stamp)
  const changed = []
  let replacements = 0
  let backupBytes = 0
  const previousSpellings = pathSpellings(previous)

  for (const file of collectTextFiles(dirs.dshHome)) {
    let stats
    try {
      stats = fs.statSync(file)
    } catch {
      continue
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) continue

    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Probe with every stored spelling, not only the raw form: a recorded root
    // can carry forward slashes or JSON escaping that the file repeats.
    if (!previousSpellings.some((spelling) => containsFold(text, spelling))) continue

    const rewritten = rewriteRoot(text, previous, dirs.root)
    if (rewritten.replacements === 0) continue

    if (stats.size <= MAX_BACKUP_BYTES && backupBytes + stats.size <= MAX_BACKUP_TOTAL_BYTES) {
      const relative = path.relative(dirs.dshHome, file)
      const target = path.join(backupRoot, relative)
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(file, target)
        backupBytes += stats.size
      } catch {
        // A missing backup must not block the repair; the record still lists the file.
      }
    }

    try {
      fs.writeFileSync(file, rewritten.text, 'utf8')
      changed.push(path.relative(dirs.root, file))
      replacements += rewritten.replacements
    } catch {
      // Locked or read-only files stay at their old spelling and appear in neither count.
    }
  }

  const reportFile = path.join(dirs.logs, `path-migration-${stamp}.json`)
  const report = {
    at: now,
    from: previous,
    to: dirs.root,
    filesChanged: changed.length,
    replacements,
    backup: backupBytes > 0 ? path.relative(dirs.root, backupRoot) : null,
    files: changed.slice(0, 500),
  }
  try {
    fs.mkdirSync(dirs.logs, { recursive: true })
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // The rewrite already happened; a missing report is not fatal.
  }

  writeState(dirs.stateFile, { root: dirs.root, lastRunAt: now, version })
  return {
    moved: true,
    from: previous,
    to: dirs.root,
    filesChanged: changed.length,
    replacements,
    report: reportFile,
  }
}

module.exports = { migratePortablePaths, rewriteRoot, pathSpellings, samePath, readState, writeState }
