/**
 * Portable layout: every path the application writes is derived from the folder
 * that holds the executable, so the whole installation can move between USB
 * sticks and drive letters without leaving anything behind on the host machine.
 *
 * Layout (all relative to the executable's folder):
 *
 *   DeepSeek Harness.exe   program
 *   resources\             program (Electron payload + dsh runtime)
 *   data\                  everything this application writes
 *     dsh-home\            $DSH_HOME: profiles, sessions, settings, credentials
 *     agents\              $DSH_AGENTS_HOME
 *     electron\            Chromium profile, HTTP cache, GPU cache, session data
 *     logs\                shell.log, server.log, migration records
 *     tmp\                 TEMP/TMP for the shell and the agent runtime
 *   portable.marker        marks a valid portable root
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** File that identifies a valid portable root. */
const MARKER_FILE = 'portable.marker'

/**
 * Resolve the portable root from the shell environment or the executable path.
 * @param {string} execPath - `process.execPath`, or `app.getPath('exe')`.
 * @returns {string} absolute portable root.
 */
function resolvePortableRoot(execPath) {
  const fromEnv = process.env.DSH_PORTABLE_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv)

  const exeDir = path.dirname(execPath)
  // The executable normally sits at the package root; tolerate the case where
  // the payload was nested one level down (for example `app\`).
  if (!fs.existsSync(path.join(exeDir, MARKER_FILE))) {
    const parent = path.resolve(exeDir, '..')
    if (fs.existsSync(path.join(parent, MARKER_FILE))) return parent
  }
  return exeDir
}

/**
 * Derive every data location from the portable root.
 * @param {string} root - absolute portable root.
 * @returns {Record<string, string>} absolute directories and files.
 */
function portablePaths(root) {
  const data = path.join(root, 'data')
  const electron = path.join(data, 'electron')
  return {
    root,
    marker: path.join(root, MARKER_FILE),
    data,
    dshHome: path.join(data, 'dsh-home'),
    agentsHome: path.join(data, 'agents'),
    electron,
    userData: path.join(electron, 'user-data'),
    sessionData: path.join(electron, 'session-data'),
    cache: path.join(electron, 'cache'),
    crashDumps: path.join(electron, 'crash-dumps'),
    logs: path.join(data, 'logs'),
    temp: path.join(data, 'tmp'),
    backup: path.join(data, 'backup'),
    stateFile: path.join(data, 'portable-state.json'),
    serverLog: path.join(data, 'logs', 'server.log'),
    shellLog: path.join(data, 'logs', 'shell.log'),
  }
}

/**
 * Create every directory the application writes to.
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @returns {void}
 */
function ensurePortableDirectories(dirs) {
  for (const directory of [
    dirs.data,
    dirs.dshHome,
    dirs.agentsHome,
    dirs.electron,
    dirs.userData,
    dirs.sessionData,
    dirs.cache,
    dirs.crashDumps,
    dirs.logs,
    dirs.temp,
  ]) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

/**
 * Point every Electron-managed path at the portable data folder. Chrome's
 * profile, HTTP cache, GPU cache, crash dumps, and logs otherwise land in
 * `%APPDATA%` and `%LOCALAPPDATA%`, which is the residue this build avoids.
 * @param {import('electron').App} app - the Electron app instance.
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @returns {void}
 */
function configureElectronPaths(app, dirs) {
  app.setName('DeepSeek Harness')
  app.setPath('userData', dirs.userData)
  app.setPath('sessionData', dirs.sessionData)
  app.setPath('cache', dirs.cache)
  app.setPath('crashDumps', dirs.crashDumps)
  app.setPath('logs', dirs.logs)
  app.setPath('temp', dirs.temp)
  app.setAppLogsPath(dirs.logs)
}

/**
 * Build the environment handed to the dsh runtime and to every shell it spawns.
 * Only portable-relevant variables are overridden; the rest of the host
 * environment is inherited so model proxies and toolchains keep working.
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @returns {NodeJS.ProcessEnv} environment for child processes.
 */
function portableEnvironment(dirs) {
  const env = { ...process.env }
  env.DSH_HOME = dirs.dshHome
  env.DSH_AGENTS_HOME = dirs.agentsHome
  env.DSH_PORTABLE_ROOT = dirs.root
  env.TEMP = dirs.temp
  env.TMP = dirs.temp
  env.TMPDIR = dirs.temp
  // The native addon loader keeps a compiled-loader cache under
  // `%LOCALAPPDATA%` unless this variable redirects it.
  env.NARB_NATIVE_CACHE_DIR = path.join(dirs.electron, 'native-cache')
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

module.exports = {
  MARKER_FILE,
  resolvePortableRoot,
  portablePaths,
  ensurePortableDirectories,
  configureElectronPaths,
  portableEnvironment,
}
