/**
 * Start the DeepSeek Harness Web application as a private child process and
 * report the authenticated URL it serves.
 *
 * The child runs on the Electron executable itself with `ELECTRON_RUN_AS_NODE`,
 * so the portable build ships exactly one Node runtime. The Web application
 * keeps owning RPC, streaming, and static assets; this shell only supplies the
 * window, the portable data root, and process lifetime.
 */

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

/** Readiness line printed by the Web application once its tree has settled. */
const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/

/** Candidate ports, tried in order so the Web origin — and its local storage — stays stable. */
const DEFAULT_PORTS = [3080, 3081, 3082, 3090, 3180, 4080, 5080]

/** Give up when the runtime has not announced a URL by then. */
const STARTUP_TIMEOUT_MS = 180_000

/** Keep each log file bounded; the previous file is renamed with a `.1` suffix. */
const MAX_LOG_BYTES = 8 * 1024 * 1024

/**
 * Append a line to the server log, rotating once.
 * @param {string} logFile - absolute log path.
 * @param {string} line - text to append.
 * @returns {void}
 */
function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`)
    } catch {
      // A missing or unreadable log has nothing to rotate.
    }
    fs.appendFileSync(logFile, `${line}\n`, 'utf8')
  } catch {
    // Logging must never take the application down.
  }
}

/**
 * Test whether a TCP port can be bound on the loopback interface.
 * @param {number} port - port to probe.
 * @returns {Promise<boolean>} whether the port is free.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Pick the first free candidate port.
 * @param {number[]} candidates - ports to probe in order.
 * @returns {Promise<number>} a free port, or 0 so the OS chooses one.
 */
async function pickPort(candidates) {
  for (const port of candidates) {
    if (await isPortFree(port)) return port
  }
  return 0
}

/**
 * Locate the dsh CLI entry point inside the packaged runtime.
 * @param {string} resourcesPath - Electron's `process.resourcesPath`.
 * @returns {string} absolute path to `lib/bin.js`.
 */
function resolveRuntimeEntry(resourcesPath) {
  return path.join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Start the Web application.
 * @param {object} options - start options.
 * @param {string} options.resourcesPath - Electron's `process.resourcesPath`.
 * @param {Record<string, string>} options.dirs - result of `portablePaths`.
 * @param {NodeJS.ProcessEnv} options.env - environment from `portableEnvironment`.
 * @param {number[]} [options.ports] - candidate ports.
 * @param {(message: string) => void} [options.onLog] - receives each stderr/stdout line.
 * @returns {Promise<{url: string, port: number, stop: () => Promise<void>}>} a running server handle.
 */
async function startDshServer({ resourcesPath, dirs, env, ports = DEFAULT_PORTS, onLog }) {
  const entry = resolveRuntimeEntry(resourcesPath)
  if (!fs.existsSync(entry)) {
    throw new Error(`dsh runtime is missing: ${entry}`)
  }

  const port = await pickPort(ports)
  const args = [entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)]
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }

  const child = spawn(process.execPath, args, {
    cwd: dirs.root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const log = (line) => {
    const text = line.trim()
    if (text.length === 0) return
    appendLog(dirs.serverLog, text)
    if (onLog !== undefined) onLog(text)
  }

  let exited = false
  let exitCode = null
  let buffered = ''
  let readyUrl = ''

  const stop = async () => {
    if (exited || child.pid === undefined) return
    exited = true
    // The runtime owns spawned shells and terminals; kill the whole tree so a
    // quitting window leaves no orphan on the host machine.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  }

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The Web application did not announce a URL within ${STARTUP_TIMEOUT_MS / 1000}s. See ${dirs.serverLog}`))
    }, STARTUP_TIMEOUT_MS)
    timer.unref()

    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        log(line)
        const match = READY_PATTERN.exec(line)
        if (match !== null && readyUrl.length === 0) {
          readyUrl = match[1]
          clearTimeout(timer)
          resolve({ url: readyUrl, port, stop })
        }
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.once('exit', (code) => {
      exited = true
      exitCode = code
      clearTimeout(timer)
      if (readyUrl.length === 0) {
        reject(new Error(`The Web application exited with code ${String(code)} before becoming ready. See ${dirs.serverLog}`))
      }
    })
  })

  ready.catch(() => stop())
  return ready
}

module.exports = { startDshServer, resolveRuntimeEntry, DEFAULT_PORTS }
