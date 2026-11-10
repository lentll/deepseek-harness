/**
 * Offline tests for pruneEmptyDirectory() in src/portable.js.
 *
 * The runtime creates `~/.dsh` before it reads `DSH_HOME`, so a portable run
 * leaves an empty folder on the host. The cleanup is only safe if it can never
 * take a file with it — including when a non-portable dsh install shares the
 * same machine and its data lives in exactly that folder.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pruneEmptyDirectory } from '../src/portable.js'

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
 * Run a body against a throwaway directory, then clean it up.
 * @param {(sandbox: string) => void} body - test body.
 * @returns {void}
 */
function withSandbox(body) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'))
  try {
    body(sandbox)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('pruneEmptyDirectory()')
check('a tree of empty folders is removed', () => {
  withSandbox((sandbox) => {
    const target = path.join(sandbox, '.dsh')
    fs.mkdirSync(path.join(target, 'profiles', 'web'), { recursive: true })
    assert.equal(pruneEmptyDirectory(target), true)
    assert.equal(fs.existsSync(target), false)
  })
})
check('one file anywhere keeps the whole tree', () => {
  withSandbox((sandbox) => {
    const target = path.join(sandbox, '.dsh')
    fs.mkdirSync(path.join(target, 'profiles', 'web'), { recursive: true })
    fs.writeFileSync(path.join(target, 'profiles', 'web', 'settings.yaml'), 'x', 'utf8')
    assert.equal(pruneEmptyDirectory(target), false)
    assert.equal(fs.existsSync(path.join(target, 'profiles', 'web', 'settings.yaml')), true)
  })
})
check('a file at the root keeps it', () => {
  withSandbox((sandbox) => {
    const target = path.join(sandbox, '.dsh')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, '.anonymous-user-id'), 'x', 'utf8')
    assert.equal(pruneEmptyDirectory(target), false)
    assert.equal(fs.existsSync(target), true)
  })
})
check('a missing directory is not an error', () => {
  withSandbox((sandbox) => {
    assert.equal(pruneEmptyDirectory(path.join(sandbox, 'absent')), false)
  })
})
check('empty siblings are removed and the kept parent stays', () => {
  withSandbox((sandbox) => {
    const target = path.join(sandbox, '.dsh')
    fs.mkdirSync(path.join(target, 'profiles'), { recursive: true })
    fs.mkdirSync(path.join(target, 'cache', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(target, 'profiles', 'keep.txt'), 'x', 'utf8')
    assert.equal(pruneEmptyDirectory(target), false)
    assert.equal(fs.existsSync(path.join(target, 'cache')), false)
    assert.equal(fs.existsSync(path.join(target, 'profiles', 'keep.txt')), true)
  })
})

console.log(`\npassed ${passed}, failed ${failed}`)
if (failed > 0) process.exit(1)
