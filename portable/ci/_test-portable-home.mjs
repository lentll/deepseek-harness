/**
 * Offline tests for the portable `$HOME`.
 *
 * Redirecting `$HOME` is what keeps a skill install on the stick: SkillHub's
 * installer hardcodes `$HOME/.skillhub`, `$HOME/.local/bin` and
 * `$HOME/.openclaw`, so every one of those paths follows whatever HOME says.
 * These assertions pin the three things that make that work:
 *
 *   1. every path handed to a shell uses forward slashes — a shell treats
 *      `F:\data\home` as one literal name and would create the wrong folder;
 *   2. the directory exists before the runtime starts;
 *   3. the Git identity is seeded once and never clobbered.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { portablePaths, portableEnvironment, ensurePortableDirectories, seedPortableHome, toUnixPath } = require('../src/portable.js')

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

const ROOT = 'F:\\stick'
const dirs = portablePaths(ROOT)

console.log('toUnixPath()')
check('rewrites separators and leaves the rest alone', () => {
  assert.equal(toUnixPath('F:\\stick\\data\\home'), 'F:/stick/data/home')
  assert.equal(toUnixPath('F:/stick/data/home'), 'F:/stick/data/home')
  assert.equal(toUnixPath('/tmp/x'), '/tmp/x')
})

console.log('portablePaths()')
check('the portable home lives under data', () => {
  assert.equal(dirs.home, path.join(ROOT, 'data', 'home'))
})

console.log('ensurePortableDirectories()')
check('creates data\\home before anything writes to it', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
  try {
    const local = portablePaths(sandbox)
    ensurePortableDirectories(local)
    assert.equal(fs.statSync(local.home).isDirectory(), true)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

console.log('portableEnvironment()')
const env = portableEnvironment(dirs)
check('HOME points at the stick with shell-safe separators', () => {
  assert.equal(env.HOME, 'F:/stick/data/home')
  assert.equal(env.HOME.includes('\\'), false)
})
check('SkillHub and OpenClaw resolve under the same home', () => {
  assert.equal(env.SKILLHUB_CONFIG_PATH, 'F:/stick/data/home/.skillhub/config.json')
  assert.equal(env.OPENCLAW_CONFIG_PATH, 'F:/stick/data/home/.openclaw/openclaw.json')
  assert.equal(env.OPENCLAW_WORKSPACE, 'F:/stick/data/home/.openclaw/workspace')
})
check('the caches stay redirected as before', () => {
  assert.equal(env.DSH_HOME, path.join(ROOT, 'data', 'dsh-home'))
  assert.equal(env.DSH_AGENTS_HOME, path.join(ROOT, 'data', 'agents'))
  assert.equal(env.TEMP, path.join(ROOT, 'data', 'tmp'))
  assert.equal(env.npm_config_cache, path.join(ROOT, 'data', 'pnpm', 'cache'))
  assert.equal(env.XDG_CACHE_HOME, path.join(ROOT, 'data', 'cache'))
})
check('the shell keeps working: no inherited run-as-node flags', () => {
  assert.equal('NODE_OPTIONS' in env, false)
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
})

console.log('seedPortableHome()')
check('copies the host .gitconfig once', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'))
  try {
    const local = portablePaths(sandbox)
    ensurePortableDirectories(local)
    const host = path.join(sandbox, 'host-home')
    fs.mkdirSync(host, { recursive: true })
    fs.writeFileSync(path.join(host, '.gitconfig'), '[user]\n\tname = Host User\n', 'utf8')

    const copied = seedPortableHome(local, { hostHome: host })
    assert.deepEqual(copied, ['.gitconfig'])
    assert.match(fs.readFileSync(path.join(local.home, '.gitconfig'), 'utf8'), /Host User/)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('never overwrites an identity that already lives on the stick', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'))
  try {
    const local = portablePaths(sandbox)
    ensurePortableDirectories(local)
    const host = path.join(sandbox, 'host-home')
    fs.mkdirSync(host, { recursive: true })
    fs.writeFileSync(path.join(host, '.gitconfig'), 'host', 'utf8')
    fs.writeFileSync(path.join(local.home, '.gitconfig'), 'stick', 'utf8')

    assert.deepEqual(seedPortableHome(local, { hostHome: host }), [])
    assert.equal(fs.readFileSync(path.join(local.home, '.gitconfig'), 'utf8'), 'stick')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('does nothing when the host has no identity', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'))
  try {
    const local = portablePaths(sandbox)
    ensurePortableDirectories(local)
    const host = path.join(sandbox, 'host-home')
    fs.mkdirSync(host, { recursive: true })

    assert.deepEqual(seedPortableHome(local, { hostHome: host }), [])
    assert.equal(fs.existsSync(path.join(local.home, '.gitconfig')), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
