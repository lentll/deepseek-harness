#!/usr/bin/env node
//
// Refuse to build (or publish) when the repository carries credentials.
//
// This runs against the checked-out source, before any dependency is installed,
// and it is deliberately stricter than the post-build guard: that one only
// looks at the produced package, while this one catches a key that was
// committed and never reached the archive (for example a stray `.env` next to
// the shell sources).
//
// Rules, all of them derived from what actually leaks in practice:
//   * file names: `.env`, `.credentials.yaml`, `credentials.json`,
//     `.git-credentials`, `*.pfx`, `*.p12`, `*.pem`, `*.key`;
//   * contents: OpenAI-style `sk-` keys, GitHub tokens, PEM private key blocks,
//     AWS access key ids.
//
// Matches are reported by rule and line number only - the matched text is never
// printed, so a CI log does not become the leak.
//
// Usage: node scripts/check-secrets.mjs [--root <dir>] [--json]

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** File names that must never exist in a source tree. */
const FORBIDDEN_NAMES = [
  { name: 'env file', re: /^\.env$/i },
  { name: 'env file', re: /^\.env\.(?!example$).+/i },
  { name: 'credentials file', re: /^\.?credentials\.(yaml|json|yml)$/i },
  { name: 'git credentials', re: /^\.git-credentials$/i },
  { name: 'private key file', re: /\.(pfx|p12|pem|key)$/i },
]

/** Content patterns. Every one needs a hit of real entropy, not a placeholder. */
const SECRET_PATTERNS = [
  { name: 'openai-style key', re: /\bsk[-_][A-Za-z0-9_-]{16,}/g },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
]

/** Text that marks a match as an illustration rather than a live credential. */
const PLACEHOLDER = /x{3,}|your|example|placeholder|dummy|redacted|\.\.\.|\u2026|\*{3,}|\$\{|\bxxx/i

/** Directories that are dependencies or build output, never source. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'out',
  'data',
  'dist',
  'coverage',
  '.cache',
])

/** Files above this size are almost certainly generated or binary data. */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * Decide whether a file name alone violates the rules.
 * @param {string} fileName - base name, for example `.env`.
 * @returns {string|null} rule name, or null when the name is acceptable.
 */
export function forbiddenName(fileName) {
  for (const rule of FORBIDDEN_NAMES) {
    if (rule.re.test(fileName)) return rule.name
  }
  return null
}

/**
 * Decide whether one candidate match is a real credential.
 * @param {string} match - the matched text.
 * @returns {boolean} true when the match looks live rather than illustrative.
 */
export function looksLive(match) {
  return !PLACEHOLDER.test(match)
}

/**
 * Scan one blob of text for secret patterns.
 * @param {string} text - file contents.
 * @returns {Array<{rule: string, line: number}>} findings, without the match text.
 */
export function scanText(text) {
  const findings = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // Cheap bail-out: no pattern can match a line with no plausible prefix.
    if (!/sk[-_]|gh[pousr]_|BEGIN |AKIA/.test(line)) continue
    for (const rule of SECRET_PATTERNS) {
      rule.re.lastIndex = 0
      let match = rule.re.exec(line)
      while (match !== null) {
        if (looksLive(match[0])) {
          findings.push({ rule: rule.name, line: index + 1 })
          break
        }
        match = rule.re.exec(line)
      }
    }
  }
  return findings
}

/**
 * Walk a tree and collect every violation.
 * @param {string} root - absolute directory to scan.
 * @returns {{findings: Array<object>, scanned: number, skipped: number}} results.
 */
export function scanTree(root) {
  const findings = []
  let scanned = 0
  let skipped = 0

  const walk = (directory) => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue

      const nameRule = forbiddenName(entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (nameRule) {
        findings.push({ file: relative, rule: nameRule, line: 0 })
        continue
      }

      let stats
      try {
        stats = fs.statSync(absolute)
      } catch {
        continue
      }
      if (stats.size > MAX_FILE_BYTES) {
        skipped += 1
        continue
      }

      let buffer
      try {
        buffer = fs.readFileSync(absolute)
      } catch {
        skipped += 1
        continue
      }
      // A NUL byte in the first block marks binary content; keys live in text.
      if (buffer.subarray(0, 4096).includes(0)) {
        skipped += 1
        continue
      }

      scanned += 1
      for (const hit of scanText(buffer.toString('utf8'))) {
        findings.push({ file: relative, rule: hit.rule, line: hit.line })
      }
    }
  }

  walk(root)
  return { findings, scanned, skipped }
}

/**
 * Turn findings into a report a human can act on.
 * @param {Array<object>} findings - result of {@link scanTree}.
 * @returns {string} multi-line report.
 */
export function formatReport(findings) {
  return findings
    .map((hit) => (hit.line ? `${hit.file}:${hit.line}  ${hit.rule}` : `${hit.file}  ${hit.rule}`))
    .join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const rootIndex = argv.indexOf('--root')
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd())
  const asJson = argv.includes('--json')

  if (!fs.existsSync(root)) {
    console.error(`[check-secrets] no such directory: ${root}`)
    process.exit(2)
  }

  const { findings, scanned, skipped } = scanTree(root)

  if (asJson) {
    console.log(JSON.stringify({ root, scanned, skipped, findings }, null, 2))
  } else if (findings.length > 0) {
    console.error('[check-secrets] credentials found - refusing to continue\n')
    console.error(formatReport(findings))
    console.error(`\n[check-secrets] ${findings.length} finding(s) in ${scanned} text file(s)`)
  } else {
    console.log(`[check-secrets] clean: ${scanned} text file(s), ${skipped} skipped`)
  }

  process.exit(findings.length > 0 ? 1 : 0)
}

// Only act when executed directly, so the unit test can import the helpers
// without the import itself scanning the working directory and calling exit().
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
