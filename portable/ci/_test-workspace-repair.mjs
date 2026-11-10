/**
 * Offline tests for src/workspace-repair.js.
 *
 * The bug these cover: dsh derives its first-use Workspace from the OS
 * Documents folder, so the "default" Workspace — and anything the agent or the
 * skill store writes into it — landed on the host disk instead of the USB
 * stick. The repair must move the automatic Workspace onto the stick and
 * re-point dead paths, while leaving a folder the user picked by hand exactly
 * where it is.
 *
 * Plan rules are tested without touching a disk; the apply path runs in a
 * throwaway directory so a bug cannot reach a real installation.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  MAX_COPY_BYTES,
  DEFAULT_WORKSPACE_TITLE,
  planWorkspaceRepair,
  repairWorkspaces,
  safeName,
  isInside,
} from '../src/workspace-repair.js'

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

const ROOT = 'F:\\AI\\deepseek-harness-portable'
const WORKSPACE_ROOT = path.join(ROOT, 'data', 'workspace')

/**
 * Build a storage document shaped like dsh's workspace.json.
 * @param {Array<{id: string, path: string, title: string}>} entries - Workspaces to record.
 * @returns {object} storage document.
 */
function doc(entries) {
  const workspaces = {}
  for (const entry of entries) {
    workspaces[entry.id] = { path: entry.path, title: entry.title, sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: entries.map((entry) => entry.id), defaultWorkspaceId: entries[0]?.id },
    tables: { workspaces },
  }
}

/**
 * Plan with a scripted filesystem.
 * @param {object} document - storage document.
 * @param {{exists?: string[], sizes?: Record<string, number>}} facts - scripted facts.
 * @returns {ReturnType<typeof planWorkspaceRepair>} plan.
 */
function plan(document, facts = {}) {
  const existing = new Set((facts.exists ?? []).map((item) => item.toLowerCase()))
  const sizes = facts.sizes ?? {}
  return planWorkspaceRepair(document, {
    workspaceRoot: WORKSPACE_ROOT,
    root: ROOT,
    isDirectory: (target) => existing.has(path.resolve(target).toLowerCase()),
    sizeOf: (target) => sizes[path.resolve(target)] ?? 0,
  })
}

console.log('planWorkspaceRepair()')
check('the automatic Workspace moves off the host disk even when it exists', () => {
  const host = 'D:\\Users\\Documents\\deepseek-harness\\default-workspace'
  const result = plan(doc([{ id: 'a', path: host, title: DEFAULT_WORKSPACE_TITLE }]), { exists: [host] })
  assert.equal(result.moves.length, 1)
  assert.equal(result.moves[0].from, host)
  assert.equal(result.moves[0].to, path.join(WORKSPACE_ROOT, DEFAULT_WORKSPACE_TITLE))
  assert.equal(result.document.tables.workspaces.a.path, path.join(WORKSPACE_ROOT, DEFAULT_WORKSPACE_TITLE))
})
check('the automatic Workspace already on the stick stays put', () => {
  const inside = path.join(ROOT, 'data', 'workspace', 'default-workspace')
  const result = plan(doc([{ id: 'a', path: inside, title: DEFAULT_WORKSPACE_TITLE }]), { exists: [inside] })
  assert.equal(result.moves.length, 0)
  assert.equal(result.unchanged, 1)
})
check('a dead path from another machine is re-pointed', () => {
  const dead = 'E:\\Users\\someone\\Documents\\deepseek-harness\\default-workspace'
  const result = plan(doc([{ id: 'a', path: dead, title: 'my-project' }]), { exists: [] })
  assert.equal(result.moves.length, 1)
  assert.equal(result.moves[0].to, path.join(WORKSPACE_ROOT, 'my-project'))
})
check('a folder the user picked by hand is never moved', () => {
  const chosen = 'D:\\work\\client-a'
  const result = plan(doc([{ id: 'a', path: chosen, title: 'client-a' }]), { exists: [chosen] })
  assert.equal(result.moves.length, 0)
  assert.equal(result.document.tables.workspaces.a.path, chosen)
})
check('the input document is not mutated', () => {
  const host = 'D:\\Users\\Documents\\deepseek-harness\\default-workspace'
  const original = doc([{ id: 'a', path: host, title: DEFAULT_WORKSPACE_TITLE }])
  const snapshot = JSON.stringify(original)
  plan(original, { exists: [host] })
  assert.equal(JSON.stringify(original), snapshot)
})
check('a name clash gets a numeric suffix', () => {
  const host = 'D:\\Users\\Documents\\deepseek-harness\\default-workspace'
  const taken = path.join(WORKSPACE_ROOT, 'default-workspace')
  const result = plan(doc([{ id: 'a', path: taken, title: DEFAULT_WORKSPACE_TITLE }, { id: 'b', path: host, title: DEFAULT_WORKSPACE_TITLE }]), {
    exists: [host],
  })
  assert.equal(result.moves.length, 1)
  assert.equal(result.moves[0].to, path.join(WORKSPACE_ROOT, 'default-workspace-2'))
})
check('content above the copy budget is re-pointed but not copied', () => {
  const host = 'D:\\Users\\Documents\\deepseek-harness\\default-workspace'
  const result = plan(doc([{ id: 'a', path: host, title: DEFAULT_WORKSPACE_TITLE }]), {
    exists: [host],
    sizes: { [path.resolve(host)]: MAX_COPY_BYTES + 1 },
  })
  assert.equal(result.moves[0].copies, false)
  assert.ok(result.moves[0].bytes > MAX_COPY_BYTES)
})
check('content within the budget is copied', () => {
  const host = 'D:\\Users\\Documents\\deepseek-harness\\default-workspace'
  const result = plan(doc([{ id: 'a', path: host, title: DEFAULT_WORKSPACE_TITLE }]), {
    exists: [host],
    sizes: { [path.resolve(host)]: 1024 },
  })
  assert.equal(result.moves[0].copies, true)
})
check('a document without a workspace table is returned untouched', () => {
  const empty = { unit: { name: 'workspace', version: 2 } }
  const result = plan(empty)
  assert.equal(result.document, empty)
  assert.equal(result.moves.length, 0)
})
check('an entry without a usable path is preserved', () => {
  const original = doc([{ id: 'a', path: '', title: 'x' }])
  const result = plan(original)
  assert.equal(result.moves.length, 0)
  assert.equal(result.document.tables.workspaces.a.path, '')
})

console.log('safeName() / isInside()')
check('unsafe characters are replaced', () => {
  assert.equal(safeName('a<b>c:d/e\\f|g?h*i'), 'a-b-c-d-e-f-g-h-i')
})
check('trailing dots and spaces are trimmed', () => {
  assert.equal(safeName('  report.  '), 'report')
})
check('an empty title falls back', () => {
  assert.equal(safeName('   ', 'workspace'), 'workspace')
})
check('device names get a suffix', () => {
  assert.equal(safeName('CON'), 'CON-dir')
  assert.equal(safeName('com1'), 'com1-dir')
})
check('isInside accepts descendants and rejects siblings', () => {
  assert.equal(isInside(ROOT, path.join(ROOT, 'data', 'workspace')), true)
  assert.equal(isInside(ROOT, ROOT), false)
  assert.equal(isInside(ROOT, 'D:\\Users\\Documents'), false)
})

console.log('repairWorkspaces()')
check('a real repair rewrites the record, copies content and leaves the original alone', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wsrepair-'))
  try {
    const root = path.join(sandbox, 'root')
    const dshHome = path.join(root, 'data', 'dsh-home')
    const hostWorkspace = path.join(sandbox, 'host', 'default-workspace')
    fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
    fs.mkdirSync(path.join(hostWorkspace, 'skillhub-kit'), { recursive: true })
    fs.writeFileSync(path.join(hostWorkspace, 'skillhub-kit', 'cli.txt'), 'kit', 'utf8')

    const storage = path.join(dshHome, 'storages', 'workspace.json')
    fs.writeFileSync(
      storage,
      JSON.stringify(doc([{ id: 'a', path: hostWorkspace, title: DEFAULT_WORKSPACE_TITLE }]), null, 2),
      'utf8',
    )

    const dirs = {
      root,
      dshHome,
      workspace: path.join(root, 'data', 'workspace'),
      backup: path.join(root, 'data', 'backup'),
      logs: path.join(root, 'data', 'logs'),
    }

    const first = repairWorkspaces(dirs)
    assert.equal(first.changed, true)
    assert.equal(first.moves.length, 1)
    assert.equal(first.moves[0].copied, true)

    const written = JSON.parse(fs.readFileSync(storage, 'utf8'))
    const target = path.join(dirs.workspace, DEFAULT_WORKSPACE_TITLE)
    assert.equal(written.tables.workspaces.a.path, target)
    assert.equal(fs.readFileSync(path.join(target, 'skillhub-kit', 'cli.txt'), 'utf8'), 'kit')
    // The host folder keeps the original: nothing is deleted by a migration.
    assert.equal(fs.existsSync(path.join(hostWorkspace, 'skillhub-kit', 'cli.txt')), true)

    const backups = fs.readdirSync(dirs.backup).filter((name) => name.startsWith('workspace-'))
    assert.equal(backups.length, 1)
    const reports = fs.readdirSync(dirs.logs).filter((name) => name.startsWith('workspace-repair-'))
    assert.equal(reports.length, 1)

    // Second start: the record now points inside the root, so nothing moves.
    const second = repairWorkspaces(dirs)
    assert.equal(second.changed, false)
    assert.equal(second.reason, 'nothing-to-move')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
check('a missing storage is not an error', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wsrepair-missing-'))
  try {
    const result = repairWorkspaces({
      root: sandbox,
      dshHome: path.join(sandbox, 'data', 'dsh-home'),
      workspace: path.join(sandbox, 'data', 'workspace'),
      backup: path.join(sandbox, 'data', 'backup'),
      logs: path.join(sandbox, 'data', 'logs'),
    })
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'no-storage')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

console.log(`\npassed ${passed}, failed ${failed}`)
if (failed > 0) process.exit(1)
