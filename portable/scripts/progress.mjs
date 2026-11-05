/**
 * Long-copy progress reporting.
 *
 * `fs.cpSync` copies a tree in one call, which is why the 1.5 GB runtime copy
 * used to sit silent for minutes. This module walks the source first to learn
 * the exact byte and file totals, then copies file by file and prints a
 * percentage line, so the console shows movement for the whole phase.
 *
 * The line is pure ASCII on purpose: it is rewritten with `\r`, and CJK glyphs
 * occupy two columns each, which makes the pad-and-erase arithmetic wrong.
 */

import fs from 'node:fs'
import path from 'node:path'

const MIB = 1024 * 1024

/**
 * Integer percentage of `done` within `total`, clamped to 0..100.
 * An empty tree counts as complete, so a zero-byte source prints 100%.
 * @param {number} done - bytes copied so far.
 * @param {number} total - bytes to copy in total.
 * @returns {number} 0-100.
 */
export function percent(done, total) {
  if (!Number.isFinite(total) || total <= 0) return 100
  const value = Math.floor((done / total) * 100)
  if (value < 0) return 0
  return value > 100 ? 100 : value
}

/**
 * One progress line, fixed-width enough to be safely overwritten in place.
 * @param {string} label - phase name, e.g. `[build] copying dsh runtime`.
 * @param {{doneBytes: number, totalBytes: number, doneFiles: number, totalFiles: number}} totals - counters.
 * @returns {string} ASCII line without a trailing newline.
 */
export function formatLine(label, totals) {
  const pct = String(percent(totals.doneBytes, totals.totalBytes)).padStart(3)
  const doneMb = Math.floor(totals.doneBytes / MIB)
  const totalMb = Math.floor(totals.totalBytes / MIB)
  const files = `${totals.doneFiles}/${totals.totalFiles}`
  return `${label} ${pct}%  ${doneMb}/${totalMb} MB  ${files} files`
}

/**
 * Build the copy filter shared by every copy in the build.
 *
 * Excluded content is filtered before it is written, never written and then
 * deleted: an interrupted build must not leave a stray `default_app.asar` or
 * source map behind for the next run to inherit.
 * @param {{keepMaps?: boolean, filter?: (source: string) => boolean}} [options] - build flags.
 * @returns {(source: string) => boolean} predicate over absolute source paths.
 */
export function composeFilter(options = {}) {
  const keepMaps = options.keepMaps === true
  const extra = options.filter
  return (source) => {
    const name = path.basename(source)
    if (name === 'default_app.asar') return false
    if (!keepMaps && (name.endsWith('.map') || name.endsWith('.tsbuildinfo'))) return false
    return extra === undefined || extra(source)
  }
}

/**
 * Walk a source tree and list what will be copied.
 *
 * Symlinks are followed (`dereference`), matching the previous `fs.cpSync`
 * behaviour: the runtime ships links into node_modules that must arrive as real
 * files, because the target machine has no such link target.
 * @param {string} from - source file or directory.
 * @param {string} to - destination path.
 * @param {(source: string) => boolean} filter - predicate over source paths.
 * @returns {{dirs: string[], files: {src: string, dst: string, size: number, mode: number}[], totalBytes: number}} plan.
 */
export function planCopy(from, to, filter) {
  const plan = { dirs: [], files: [], totalBytes: 0 }
  const stat = fs.statSync(from)

  if (!stat.isDirectory()) {
    plan.files.push({ src: from, dst: to, size: stat.size, mode: stat.mode })
    plan.totalBytes += stat.size
    return plan
  }

  plan.dirs.push(to)
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (!filter(absolute)) continue
      // statSync follows symlinks, so a link to a directory is walked as one.
      let entryStat
      try {
        entryStat = fs.statSync(absolute)
      } catch {
        continue // Broken link: nothing to copy.
      }
      const target = path.join(to, path.relative(from, absolute))
      if (entryStat.isDirectory()) {
        plan.dirs.push(target)
        stack.push(absolute)
        continue
      }
      plan.files.push({ src: absolute, dst: target, size: entryStat.size, mode: entryStat.mode })
      plan.totalBytes += entryStat.size
    }
  }
  return plan
}

/**
 * Copy a tree with `fs.cpSync` semantics; used for the small payloads.
 * @param {string} from - source file or directory.
 * @param {string} to - destination path.
 * @param {{keepMaps?: boolean, filter?: (source: string) => boolean}} [options] - same options as the build flags.
 * @returns {void}
 */
export function copyTree(from, to, options = {}) {
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    dereference: true,
    filter: composeFilter(options),
  })
}

/**
 * Progress reporter sized for a terminal that is also written to logs.
 *
 * On a TTY the line is rewritten in place; when stdout is a pipe (CI, redirected
 * log) it prints every `stepPercent` instead, so a workflow log stays readable
 * instead of holding 140k carriage returns.
 * @param {string} label - phase name shown at the start of the line.
 * @param {number} totalBytes - bytes to copy.
 * @param {{stream?: NodeJS.WriteStream, tty?: boolean, minIntervalMs?: number, stepPercent?: number}} [options] - overrides, mainly for tests.
 * @returns {{update: (doneBytes: number, doneFiles: number, totalFiles: number) => void, finish: (summary: string) => void}} reporter.
 */
export function createProgressReporter(label, totalBytes, options = {}) {
  const stream = options.stream ?? process.stdout
  const tty = options.tty ?? Boolean(stream.isTTY)
  const minIntervalMs = options.minIntervalMs ?? 100
  const stepPercent = options.stepPercent ?? 10

  let lastPaint = 0
  let lastWidth = 0
  let lastPercent = -1
  let lastPrintedPercent = -1
  let totals = { doneBytes: 0, totalBytes, doneFiles: 0, totalFiles: 0 }

  const paint = () => {
    const line = formatLine(label, totals)
    if (tty) {
      const padding = ' '.repeat(Math.max(0, lastWidth - line.length))
      stream.write(`\r${line}${padding}`)
      lastWidth = line.length
      return
    }
    stream.write(`${line}\n`)
  }

  return {
    /**
     * @param {number} doneBytes - bytes copied so far.
     * @param {number} doneFiles - files copied so far.
     * @param {number} totalFiles - files to copy in total.
     * @returns {void}
     */
    update(doneBytes, doneFiles, totalFiles) {
      totals = { doneBytes, totalBytes, doneFiles, totalFiles }
      const pct = percent(doneBytes, totalBytes)
      if (pct === lastPercent) return
      if (!tty) {
        // A log gets one line per `stepPercent` of real progress. Counting the
        // delta rather than landing on round numbers keeps a five-minute copy
        // from going silent just because no file ended exactly on 10%.
        if (lastPrintedPercent >= 0 && pct !== 100 && pct - lastPrintedPercent < stepPercent) return
        lastPercent = pct
        lastPrintedPercent = pct
        paint()
        return
      }
      const now = Date.now()
      if (now - lastPaint < minIntervalMs && pct !== 100) return
      lastPaint = now
      lastPercent = pct
      paint()
    },
    /**
     * Erase the live line and print the closing summary instead.
     * @param {string} summary - e.g. `[build] copied 1482 MB in 180.4s`.
     * @returns {void}
     */
    finish(summary) {
      if (tty) {
        stream.write(`\r${' '.repeat(lastWidth)}\r`)
      } else if (lastPercent !== 100) {
        stream.write(`${formatLine(label, totals)}\n`)
      }
      stream.write(`${summary}\n`)
    },
  }
}

/**
 * Copy a tree file by file, reporting byte progress on the way.
 * @param {string} from - source file or directory.
 * @param {string} to - destination path.
 * @param {{label?: string, keepMaps?: boolean, filter?: (source: string) => boolean, stream?: NodeJS.WriteStream, tty?: boolean, minIntervalMs?: number, stepPercent?: number}} [options] - copy and reporter options.
 * @returns {{bytes: number, files: number, seconds: number}} what was copied.
 */
export function copyTreeWithProgress(from, to, options = {}) {
  const label = options.label ?? '[build] copying'
  const plan = planCopy(from, to, composeFilter(options))
  const reporter = createProgressReporter(label, plan.totalBytes, options)
  const started = Date.now()

  // A directory source maps onto `to` itself; a single file maps into `to`'s parent.
  if (plan.dirs.length === 0) fs.mkdirSync(path.dirname(to), { recursive: true })
  for (const directory of plan.dirs) fs.mkdirSync(directory, { recursive: true })

  let doneBytes = 0
  let doneFiles = 0
  let lastDir = ''
  for (const file of plan.files) {
    const directory = path.dirname(file.dst)
    if (directory !== lastDir) {
      fs.mkdirSync(directory, { recursive: true })
      lastDir = directory
    }
    fs.copyFileSync(file.src, file.dst)
    // copyFileSync drops the mode; node.exe and the CLI shims need it kept.
    if ((file.mode & 0o111) !== 0) fs.chmodSync(file.dst, file.mode & 0o777)
    doneBytes += file.size
    doneFiles += 1
    reporter.update(doneBytes, doneFiles, plan.files.length)
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  reporter.finish(`${label}: ${Math.floor(doneBytes / MIB)} MB, ${doneFiles} files in ${seconds}s`)
  return { bytes: doneBytes, files: doneFiles, seconds: Number(seconds) }
}
