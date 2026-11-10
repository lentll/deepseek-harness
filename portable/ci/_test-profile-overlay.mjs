/**
 * Offline tests for the profile overlay in src/portable.js.
 *
 * The overlay is the only thing that stops dsh from creating its first Workspace
 * on the host disk: it overrides `documentsDirectory` with a path computed from
 * `DSH_PORTABLE_ROOT`. Two failure modes matter, and both are silent without
 * these tests:
 *
 *   - appending a block entry to a profile that still holds the empty flow
 *     sequence `[]` produces an unparseable YAML file, and the whole Web
 *     application refuses to boot;
 *   - appending twice produces duplicate entries instead of one override.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ensureProfileOverlay, PROFILE_OVERLAY_MARKER } from '../src/portable.js'

const require = createRequire(import.meta.url)
// The runtime ships js-yaml, but `runtime/node_modules` is not committed, so a
// fresh clone only has the shell dependencies. Parsing is skipped there and the
// text assertions still catch the failure mode that matters (`[]` left in
// place, or no override written at all).
let yaml = null
try {
  yaml = require('js-yaml')
} catch {
  try {
    yaml = require('../runtime/node_modules/js-yaml')
  } catch {
    console.log('note: js-yaml is unavailable; structural assertions only')
  }
}

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
 * Create a portable layout holding one profile patch file.
 * @param {string} patchText - contents to write, or null to leave the profile absent.
 * @returns {{dirs: Record<string, string>, file: string, sandbox: string}} fixture.
 */
function fixture(patchText) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'))
  const dshHome = path.join(sandbox, 'data', 'dsh-home')
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  if (patchText !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, patchText, 'utf8')
  }
  return { dirs: { root: sandbox, dshHome }, file, sandbox }
}

/**
 * Parse a patch file, ignoring the `!!js` tag js-yaml does not know.
 * @param {string} text - patch contents.
 * @returns {Array<object>|null} parsed entries, or null when no parser is available.
 */
function parse(text) {
  if (yaml === null) return null
  const entries = yaml.load(text.replace(/!!js\s+/g, ''))
  assert.ok(Array.isArray(entries), 'patch must parse to a sequence')
  return entries
}

console.log('ensureProfileOverlay()')
check('an unpached profile with [] becomes a valid block sequence', () => {
  const { dirs, file, sandbox } = fixture('# comment line\n[]\n')
  try {
    const result = ensureProfileOverlay(dirs)
    assert.equal(result.written, true)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(/^\s*\[\]\s*$/m.test(text), false, 'the empty flow sequence must be removed')
    assert.ok(text.includes('# comment line'), 'existing comments are kept')
    assert.ok(text.includes('- id: workspace-controller'), 'the override entry is written')
    const entries = parse(text)
    if (entries === null) return
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'workspace-controller')
    assert.equal(entries[0].name, '@deepseek-ai/dsh-api-workspace-controller')
    assert.ok(String(entries[0].config.documentsDirectory).includes('data'))
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('an already patched profile keeps its entries and gains one', () => {
  const original = '# my patch\n- id: agent-default-model\n  config:\n    provider: tokenrhythm\n'
  const { dirs, file, sandbox } = fixture(original)
  try {
    ensureProfileOverlay(dirs)
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.indexOf('- id: agent-default-model') < text.indexOf('- id: workspace-controller'))
    const entries = parse(text)
    if (entries === null) return
    assert.equal(entries.length, 2)
    assert.equal(entries[0].id, 'agent-default-model')
    assert.equal(entries[1].id, 'workspace-controller')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('the override is computed from DSH_PORTABLE_ROOT, not baked in', () => {
  const { dirs, file, sandbox } = fixture('[]\n')
  try {
    ensureProfileOverlay(dirs)
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.includes('process.env.DSH_PORTABLE_ROOT'))
    assert.equal(/documentsDirectory: [A-Za-z]:/.test(text), false, 'no drive letter may be frozen into the file')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('a second run writes nothing', () => {
  const { dirs, file, sandbox } = fixture('[]\n')
  try {
    ensureProfileOverlay(dirs)
    const first = fs.readFileSync(file, 'utf8')
    const second = ensureProfileOverlay(dirs)
    assert.equal(second.written, false)
    assert.equal(second.reason, 'present')
    assert.equal(fs.readFileSync(file, 'utf8'), first)
    assert.equal(first.split(PROFILE_OVERLAY_MARKER).length - 1, 1)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('a missing profile is reported, not created', () => {
  const { dirs, sandbox } = fixture(null)
  try {
    const result = ensureProfileOverlay(dirs)
    assert.equal(result.written, false)
    assert.equal(result.reason, 'no-profile')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

console.log(`\npassed ${passed}, failed ${failed}`)
if (failed > 0) process.exit(1)
