#!/usr/bin/env node
//
// Offline assertions for scripts/check-secrets.mjs.
//
// Each case builds a throwaway tree and runs the real CLI as a child process,
// so what is verified is the exit code and the report - the two things CI acts
// on - rather than an internal function that could drift from the CLI.
//
// Sample credentials are assembled from fragments on purpose: a literal key in
// this file would be caught by the very scanner it tests.
//
// Usage: node ci/_test-secrets.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scanner = path.resolve(here, '..', 'scripts', 'check-secrets.mjs')

const liveOpenAiKey = `sk-${'a1b2c3d4'.repeat(4)}`
const liveGithubToken = `gh${'o'}_${'B7k9'.repeat(9)}`
const pemHeader = `-----BEGIN ${'RSA PRIVATE KEY-----'}`

let passed = 0
let failed = 0

/**
 * Run the scanner against a throwaway directory.
 * @param {Record<string, string|Buffer>} files - relative path to contents.
 * @returns {{code: number, stdout: string, stderr: string}} process result.
 */
function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-secrets-'))
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    const result = spawnSync(process.execPath, [scanner, '--root', root], {
      encoding: 'utf8',
    })
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Assert one expectation.
 * @param {string} label - what is being checked.
 * @param {boolean} condition - expected outcome.
 * @param {string} detail - context printed on failure.
 * @returns {void}
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL ${label} :: ${detail}`)
}

const cases = [
  {
    label: 'clean source tree passes',
    files: { 'src/main.js': "const key = process.env.DEEPSEEK_API_KEY\n" },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: '.env is rejected',
    files: { '.env': 'DEEPSEEK_API_KEY=whatever\n' },
    wantCode: 1,
    wantIn: 'env file',
  },
  {
    label: '.env.example is allowed',
    files: { '.env.example': 'DEEPSEEK_API_KEY=\n' },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: 'live sk- key is rejected',
    files: { 'src/config.js': `const k = '${liveOpenAiKey}'\n` },
    wantCode: 1,
    wantIn: 'openai-style key',
  },
  {
    label: 'sk-xxxx placeholder is allowed',
    files: { 'README.md': '找到 sk-xxxxxxxxxxxxxxxx 这样的占位符\n' },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: 'sk-your-key placeholder is allowed',
    files: { 'docs/note.md': 'fill in sk-your-key-here-000000000 before running\n' },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: 'github token is rejected',
    files: { 'src/gh.js': `const t = '${liveGithubToken}'\n` },
    wantCode: 1,
    wantIn: 'github token',
  },
  {
    label: 'private key block is rejected',
    files: { 'certs/readme.txt': `${pemHeader}\nMIIE...\n` },
    wantCode: 1,
    wantIn: 'private key block',
  },
  {
    label: 'pfx file is rejected',
    files: { 'sign/sign.pfx': Buffer.from('30 82 0a', 'utf8') },
    wantCode: 1,
    wantIn: 'private key file',
  },
  {
    label: 'node_modules is skipped',
    files: { 'node_modules/pkg/.env': 'X=1\n' },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: 'binary file is skipped',
    files: { 'assets/blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(liveOpenAiKey)]) },
    wantCode: 0,
    wantIn: null,
  },
  {
    label: 'match text is not echoed',
    files: { 'src/config.js': `const k = '${liveOpenAiKey}'\n` },
    wantCode: 1,
    wantIn: 'src/config.js:1',
    wantNotIn: liveOpenAiKey,
  },
]

for (const item of cases) {
  const result = run(item.files)
  const output = `${result.stdout}${result.stderr}`
  check(`${item.label} (exit ${item.wantCode})`, result.code === item.wantCode, `got exit ${result.code} :: ${output.trim()}`)
  if (item.wantIn !== null) {
    check(`${item.label} - names the rule`, output.includes(item.wantIn), `missing "${item.wantIn}" in: ${output.trim()}`)
  }
  if (item.wantNotIn) {
    check(`${item.label} - hides the credential`, !output.includes(item.wantNotIn), 'matched text leaked into the report')
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed > 0 ? 1 : 0)
