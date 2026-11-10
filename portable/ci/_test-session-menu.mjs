/**
 * Offline tests for the delete-Session entry.
 *
 * Two things must hold, and neither can be checked by launching a window:
 *
 *   1. the host only ever removes a directory it resolved itself, under
 *      `sessions/`, for a well-formed id — a renderer-supplied path must be
 *      impossible, because this is the only place in the shell that deletes
 *      user data;
 *   2. the injected fragment keys off the row that opened the menu and off the
 *      archive entry that already exists, so it cannot target another Session
 *      and cannot invent styling that drifts from the menu.
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isSessionId, planSessionDeletion, deleteSessionRecord, purgeSessionReferences } = require('../src/session-menu.js')

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

const ID = 'session-b5cd046d-9b6c-4d0c-b84e-7408b2eccfb1'
const ROOT = 'C:\\stick\\data\\dsh-home\\sessions'

console.log('isSessionId()')
check('accepts a canonical id', () => {
  assert.equal(isSessionId(ID), true)
})
check('refuses a traversal, a bare uuid and a non-string', () => {
  assert.equal(isSessionId('..\\..\\Windows'), false)
  assert.equal(isSessionId('b5cd046d-9b6c-4d0c-b84e-7408b2eccfb1'), false)
  assert.equal(isSessionId(`${ID}\\..\\..`), false)
  assert.equal(isSessionId(undefined), false)
  assert.equal(isSessionId(42), false)
})

console.log('planSessionDeletion()')
check('finds the id inside whichever group holds it', () => {
  const groups = ['--D-Users-Documents-x--', '--F-AI-stick-data-workspace-default-workspace--']
  const plan = planSessionDeletion({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => groups,
    isDirectory: (candidate) => candidate.includes('F-AI-stick'),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.group, groups[1])
  assert.ok(plan.directory.endsWith(path.join(groups[1], ID)))
})
check('reports not-found without touching anything', () => {
  const plan = planSessionDeletion({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => ['--group--'],
    isDirectory: () => false,
  })
  assert.deepEqual(plan, { ok: false, reason: 'not-found' })
})
check('reports invalid-id before reading the disk', () => {
  let read = false
  const plan = planSessionDeletion({
    sessionsRoot: ROOT,
    sessionId: '../../etc',
    listGroups: () => {
      read = true
      return []
    },
    isDirectory: () => true,
  })
  assert.deepEqual(plan, { ok: false, reason: 'invalid-id' })
  assert.equal(read, false)
})
check('a group name cannot escape the sessions folder', () => {
  const plan = planSessionDeletion({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => ['..', '..\\..'],
    isDirectory: () => false,
  })
  assert.equal(plan.ok, false)
})
check('an unreadable root is reported, not thrown', () => {
  const plan = planSessionDeletion({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => {
      throw new Error('EACCES')
    },
    isDirectory: () => true,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /^unreadable/)
})

console.log('deleteSessionRecord()')
check('removes exactly one directory and returns it', () => {
  const removed = []
  const outcome = deleteSessionRecord({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => ['--group--'],
    isDirectory: () => true,
    remove: (directory) => removed.push(directory),
  })
  assert.equal(outcome.ok, true)
  assert.equal(removed.length, 1)
  assert.equal(removed[0], outcome.directory)
})
check('a failed removal is reported as a reason', () => {
  const outcome = deleteSessionRecord({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => ['--group--'],
    isDirectory: () => true,
    remove: () => {
      throw new Error('EBUSY')
    },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /^remove-failed: EBUSY/)
})
check('a missing id removes nothing', () => {
  let removed = 0
  deleteSessionRecord({
    sessionsRoot: ROOT,
    sessionId: ID,
    listGroups: () => [],
    isDirectory: () => false,
    remove: () => {
      removed += 1
    },
  })
  assert.equal(removed, 0)
})

console.log('purgeSessionReferences()')
check('drops the id from the archive set, the pin set and every Workspace', () => {
  const document = {
    global: { archivedSessionIds: [ID, 'session-other'], pinnedSessionIds: [ID], workspaceIds: ['w1'] },
    tables: {
      workspaces: {
        w1: { path: 'p', sessionIds: [ID, 'session-other'] },
        w2: { path: 'q', sessionIds: ['session-third'] },
      },
    },
  }
  const { document: next, changed } = purgeSessionReferences(document, ID)
  assert.equal(changed, true)
  assert.deepEqual(next.global.archivedSessionIds, ['session-other'])
  assert.deepEqual(next.global.pinnedSessionIds, [])
  assert.deepEqual(next.tables.workspaces.w1.sessionIds, ['session-other'])
  assert.deepEqual(next.tables.workspaces.w2.sessionIds, ['session-third'])
  // The caller's document is untouched.
  assert.deepEqual(document.global.pinnedSessionIds, [ID])
  assert.deepEqual(document.tables.workspaces.w1.sessionIds, [ID, 'session-other'])
})
check('reports a no-op when nothing mentions the id', () => {
  const document = { global: { archivedSessionIds: [] }, tables: { workspaces: { w1: { sessionIds: [] } } } }
  const result = purgeSessionReferences(document, ID)
  assert.equal(result.changed, false)
  assert.equal(result.document, document)
})
check('survives a document without a workspace table', () => {
  const result = purgeSessionReferences({ global: { pinnedSessionIds: [ID] }, tables: {} }, ID)
  assert.equal(result.changed, true)
  assert.deepEqual(result.document.global.pinnedSessionIds, [])
})
check('a non-object document is returned unchanged', () => {
  assert.equal(purgeSessionReferences(null, ID).changed, false)
})

console.log('the injected fragment')
const injected = fs.readFileSync(new URL('../src/session-menu-injected.js', import.meta.url), 'utf8')
check('targets the row that opened the menu', () => {
  assert.ok(injected.includes('[data-context-menu-trigger]'))
  assert.ok(injected.includes('data-row-key'))
  assert.ok(injected.includes("SESSION_PREFIX = 'session:'"))
})
check('clones the archive entry instead of inventing markup', () => {
  assert.ok(injected.includes('归档会话'))
  assert.ok(injected.includes('cloneNode(true)'))
  assert.ok(injected.includes('[class*="itemLabel"]'))
})
check('uses the sprite that exists in the shipped theme', () => {
  assert.ok(injected.includes('dsw-icon-trash-outline-regular'))
})
check('calls the bridge and reloads only after a confirmed delete', () => {
  assert.ok(injected.includes('bridge.deleteSession'))
  assert.ok(injected.includes('outcome?.deleted === true'))
  assert.ok(injected.includes('location.reload()'))
})
check('is idempotent and only decorates Session menus', () => {
  assert.ok(injected.includes('__dshPortableDeleteSession'))
  assert.ok(injected.includes('[role="menu"][data-context-menu]'))
  assert.ok(injected.includes('dataset.portableDelete'))
})

console.log('the bridge and the wiring')
const preload = fs.readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
check('the preload exposes deleteSession and nothing else', () => {
  const exposed = preload.match(/deleteSession/g) ?? []
  assert.ok(exposed.length >= 1)
  assert.equal(/exposeInMainWorld\([^)]*\)/s.test(preload), true)
  const methods = preload.match(/^\s{2}[a-zA-Z]+:/gm) ?? []
  assert.equal(methods.length, 1)
})
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
check('the window carries the preload and the load hook re-injects', () => {
  assert.ok(main.includes("preload: appFile('preload.js')"))
  assert.ok(main.includes("webContents.on('did-finish-load'"))
  assert.ok(main.includes("appFile('session-menu-injected.js')"))
  assert.ok(main.includes('installSessionMenu({'))
  assert.ok(main.includes('stopRuntime,'))
  assert.ok(main.includes('startRuntime: restartRuntime'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
