/**
 * Offline tests for scripts/progress.mjs.
 *
 * The copy used to be a single fs.cpSync, so "did it actually copy everything"
 * was answered by looking at the package afterwards. Splitting it into a walk
 * plus a per-file copy moves that risk into code, so these tests pin the three
 * ways it can go wrong: bytes miscounted (bar reaches 100% early), files skipped
 * (package silently incomplete), and carriage returns flooding a CI log.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { copyTree, copyTreeWithProgress, composeFilter, formatLine, percent, planCopy } from '../scripts/progress.mjs'

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

/**
 * In-memory stand-in for process.stdout.
 * @param {boolean} isTTY - whether to behave like a terminal.
 * @returns {{isTTY: boolean, chunks: string[], write: (chunk: string) => boolean, text: () => string}} fake stream.
 */
function fakeStream(isTTY) {
  return {
    isTTY,
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    text() {
      return this.chunks.join('')
    },
  }
}

/**
 * Build a throwaway source tree with known totals.
 * @returns {{root: string, source: string, bytes: number, files: number}} fixture description.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-progress-'))
  const source = path.join(root, 'src-a')
  fs.mkdirSync(path.join(source, 'nested', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(source, 'one.txt'), 'a'.repeat(1000))
  fs.writeFileSync(path.join(source, 'nested', 'two.txt'), 'b'.repeat(2000))
  fs.writeFileSync(path.join(source, 'nested', 'deep', 'three.txt'), 'c'.repeat(500))
  fs.writeFileSync(path.join(source, 'nested', 'three.txt.map'), 'd'.repeat(4000))
  fs.writeFileSync(path.join(source, 'app.tsbuildinfo'), 'e'.repeat(700))
  fs.writeFileSync(path.join(source, 'default_app.asar'), 'f'.repeat(300))
  return { root, source, bytes: 3500, files: 3 }
}

console.log('percent()')
check('0 of 100 is 0%', () => assert.equal(percent(0, 100), 0))
check('50 of 100 is 50%', () => assert.equal(percent(50, 100), 50))
check('99 of 100 is 99% (never rounds up early)', () => assert.equal(percent(99, 100), 99))
check('100 of 100 is 100%', () => assert.equal(percent(100, 100), 100))
check('overshoot clamps to 100%', () => assert.equal(percent(5000, 100), 100))
check('negative progress clamps to 0%', () => assert.equal(percent(-1, 100), 0))
check('empty total counts as complete', () => assert.equal(percent(0, 0), 100))

console.log('formatLine()')
check('carries percent, MB and file counts', () => {
  const line = formatLine('[build] copying dsh runtime', {
    doneBytes: 623 * 1024 * 1024,
    totalBytes: 1482 * 1024 * 1024,
    doneFiles: 58800,
    totalFiles: 140259,
  })
  assert.match(line, /^\[build\] copying dsh runtime\s+42%/)
  assert.match(line, /623\/1482 MB/)
  assert.match(line, /58800\/140259 files/)
})
check('is pure ASCII so \\r padding stays correct', () => {
  const line = formatLine('copying', { doneBytes: 1, totalBytes: 2, doneFiles: 1, totalFiles: 2 })
  assert.deepEqual([...line].filter((character) => character.charCodeAt(0) > 126), [])
})

console.log('composeFilter()')
check('drops default_app.asar', () => assert.equal(composeFilter()('C:\\x\\default_app.asar'), false))
check('drops .map unless keepMaps', () => {
  assert.equal(composeFilter()('C:\\x\\a.js.map'), false)
  assert.equal(composeFilter({ keepMaps: true })('C:\\x\\a.js.map'), true)
})
check('drops .tsbuildinfo unless keepMaps', () => {
  assert.equal(composeFilter()('C:\\x\\tsconfig.tsbuildinfo'), false)
  assert.equal(composeFilter({ keepMaps: true })('C:\\x\\tsconfig.tsbuildinfo'), true)
})
check('keeps ordinary files and honours the extra predicate', () => {
  assert.equal(composeFilter()('C:\\x\\a.js'), true)
  assert.equal(composeFilter({ filter: () => false })('C:\\x\\a.js'), false)
})

const fixture = makeFixture()

console.log('planCopy()')
check('totals ignore filtered files', () => {
  const plan = planCopy(fixture.source, path.join(fixture.root, 'out-plan'), composeFilter())
  assert.equal(plan.files.length, fixture.files)
  assert.equal(plan.totalBytes, fixture.bytes)
})
check('maps destinations relative to the source root', () => {
  const target = path.join(fixture.root, 'out-plan')
  const plan = planCopy(fixture.source, target, composeFilter())
  const nested = plan.files.find((file) => file.src.endsWith('two.txt'))
  assert.equal(nested.dst, path.join(target, 'nested', 'two.txt'))
})
check('lists every directory including empty ones', () => {
  const empty = path.join(fixture.source, 'empty-dir')
  fs.mkdirSync(empty, { recursive: true })
  const plan = planCopy(fixture.source, path.join(fixture.root, 'out-plan2'), composeFilter())
  assert.ok(plan.dirs.some((directory) => directory.endsWith('empty-dir')))
})

console.log('copyTreeWithProgress()')
check('copies exactly the planned bytes and files', () => {
  const target = path.join(fixture.root, 'out-a')
  const stream = fakeStream(false)
  const result = copyTreeWithProgress(fixture.source, target, { label: '[build] copying', stream, tty: false })
  assert.equal(result.files, fixture.files)
  assert.equal(result.bytes, fixture.bytes)
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'two.txt'), 'utf8').length, 2000)
  assert.equal(fs.existsSync(path.join(target, 'nested', 'three.txt.map')), false)
  assert.equal(fs.existsSync(path.join(target, 'app.tsbuildinfo')), false)
  assert.equal(fs.existsSync(path.join(target, 'default_app.asar')), false)
})
check('can still copy a single file', () => {
  const stream = fakeStream(false)
  const target = path.join(fixture.root, 'out-b', 'package.json')
  copyTreeWithProgress(path.join(fixture.source, 'one.txt'), target, { stream, tty: false })
  assert.equal(fs.statSync(target).size, 1000)
})
check('empty source reports 100% and does not divide by zero', () => {
  const empty = path.join(fixture.root, 'src-empty')
  fs.mkdirSync(empty, { recursive: true })
  const stream = fakeStream(false)
  const result = copyTreeWithProgress(empty, path.join(fixture.root, 'out-empty'), { stream, tty: false })
  assert.equal(result.files, 0)
  assert.match(stream.text(), /100%/)
})

console.log('reporter output')
check('piped stdout prints steps instead of feeding carriage returns', () => {
  const stream = fakeStream(false)
  copyTreeWithProgress(fixture.source, path.join(fixture.root, 'out-c'), {
    label: '[build] copying',
    stream,
    tty: false,
    stepPercent: 10,
  })
  assert.equal(stream.text().includes('\r'), false)
  const lines = stream.text().trimEnd().split('\n')
  assert.ok(lines.length <= 13, `expected <= 13 lines, got ${lines.length}`)
})
check('a terminal gets in-place rewrites and an erase before the summary', () => {
  const stream = fakeStream(true)
  copyTreeWithProgress(fixture.source, path.join(fixture.root, 'out-d'), {
    label: '[build] copying',
    stream,
    tty: true,
    minIntervalMs: 0,
  })
  assert.ok(stream.text().startsWith('\r'))
  assert.match(stream.text(), /\r +\r/, 'live line should be erased before the summary')
  assert.match(stream.text(), /files in \d/)
})
check('progress never goes backwards', () => {
  const seen = []
  const stream = {
    isTTY: true,
    write(chunk) {
      const match = /\s(\d{1,3})%/.exec(chunk)
      if (match) seen.push(Number(match[1]))
      return true
    },
  }
  copyTreeWithProgress(fixture.source, path.join(fixture.root, 'out-e'), {
    label: '[build] copying',
    stream,
    tty: true,
    minIntervalMs: 0,
  })
  assert.ok(seen.length >= 2)
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b))
  assert.equal(seen.at(-1), 100)
})

console.log('copyTree() parity')
check('the non-progress path still filters the same way', () => {
  const target = path.join(fixture.root, 'out-f')
  copyTree(fixture.source, target)
  assert.equal(fs.readFileSync(path.join(target, 'one.txt'), 'utf8').length, 1000)
  assert.equal(fs.existsSync(path.join(target, 'nested', 'three.txt.map')), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
