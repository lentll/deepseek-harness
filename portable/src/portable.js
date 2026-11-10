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
 *     documents\           stand-in for the OS Documents folder; dsh creates the
 *                          first-use Workspace underneath it
 *     workspace\           Workspaces that used to live on the host disk
 *     electron\            Chromium profile, HTTP cache, GPU cache, session data
 *     logs\                shell.log, server.log, migration records
 *     tmp\                 TEMP/TMP for the shell and the agent runtime
 *   portable.marker        marks a valid portable root
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
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
 * Rewrite a Windows path so it can be handed to a shell.
 *
 * A shell treats `F:\data\home` as one literal file name, so every path that
 * crosses into `bash` uses forward slashes. Node accepts either form.
 * @param {string} value - absolute Windows path.
 * @returns {string} the same path with `/` separators.
 */
function toUnixPath(value) {
  return value.replace(/\\/g, '/')
}

/**
 * Copy the host's Git identity into the portable home, once.
 *
 * Redirecting `$HOME` moves every `~` lookup onto the stick, Git included, so
 * `data\home\.gitconfig` is what a commit reads now. Seeding it from the host
 * keeps `git commit` working on a fresh machine; an existing file on the stick
 * is never overwritten, so edits made there survive.
 *
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @param {{hostHome?: string}} [options] - overridable host home for tests.
 * @returns {string[]} the file names that were copied.
 */
function seedPortableHome(dirs, { hostHome = os.homedir() } = {}) {
  const copied = []
  for (const name of ['.gitconfig']) {
    const target = path.join(dirs.home, name)
    const source = path.join(hostHome, name)
    if (fs.existsSync(target) || !fs.existsSync(source)) continue
    try {
      fs.copyFileSync(source, target)
      copied.push(name)
    } catch {
      // A missing identity only affects commits; it must not block startup.
    }
  }
  return copied
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
    // A portable `$HOME`. SkillHub and the tools the agent runs treat `~` as
    // the user profile, which is the host disk unless it is redirected here.
    home: path.join(data, 'home'),
    documents: path.join(data, 'documents'),
    workspace: path.join(data, 'workspace'),
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
    dirs.home,
    dirs.documents,
    dirs.workspace,
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
  // Shells and the tools they start derive `~` from HOME. Pointing it at the
  // stick is what keeps a skill install inside `data\home\.skillhub` instead of
  // the machine's user profile. Git also reads this path, so a portable
  // identity lives in `data\home\.gitconfig`.
  env.HOME = toUnixPath(dirs.home)
  env.DSH_HOME = dirs.dshHome
  env.DSH_AGENTS_HOME = dirs.agentsHome
  env.DSH_PORTABLE_ROOT = dirs.root
  env.TEMP = dirs.temp
  env.TMP = dirs.temp
  env.TMPDIR = dirs.temp
  // The native addon loader keeps a compiled-loader cache under
  // `%LOCALAPPDATA%` unless this variable redirects it.
  env.NARB_NATIVE_CACHE_DIR = path.join(dirs.electron, 'native-cache')
  // Plugin and skill installs run through pnpm, whose store and HTTP cache
  // default to the host profile. Both are redirected so an install done on the
  // stick leaves nothing behind on the machine it ran on.
  env.PNPM_HOME = path.join(dirs.data, 'pnpm', 'home')
  env.npm_config_store_dir = path.join(dirs.data, 'pnpm', 'store')
  env.npm_config_cache = path.join(dirs.data, 'pnpm', 'cache')
  env.XDG_CACHE_HOME = path.join(dirs.data, 'cache')
  env.XDG_CONFIG_HOME = path.join(dirs.home, '.config')
  // SkillHub's installer hardcodes `$HOME/.skillhub`, `$HOME/.local/bin` and
  // `$HOME/.openclaw`; its CLI honours these two overrides for the parts it
  // resolves itself, so both halves land on the stick.
  env.SKILLHUB_CONFIG_PATH = toUnixPath(path.join(dirs.home, '.skillhub', 'config.json'))
  env.OPENCLAW_CONFIG_PATH = toUnixPath(path.join(dirs.home, '.openclaw', 'openclaw.json'))
  env.OPENCLAW_WORKSPACE = toUnixPath(path.join(dirs.home, '.openclaw', 'workspace'))
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Marker line that keeps the profile overlay injection idempotent. */
const PROFILE_OVERLAY_MARKER = '# portable: keep the default Workspace inside the portable data folder'

/** Profile that serves the Web UI. */
const WEB_PROFILE = 'web'

/**
 * Locate the patch layer of the Web profile.
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @returns {string} absolute path to `cordis.patch.yml`.
 */
function profilePatchPath(dirs) {
  return path.join(dirs.dshHome, 'profiles', WEB_PROFILE, 'cordis.patch.yml')
}

/**
 * Pin the first-use Workspace inside the portable root.
 *
 * dsh resolves its default Workspace from the OS Documents folder, which is a
 * host path. The profile patch layer supports a deployment override
 * (`documentsDirectory`), and `!!js` lets that override be computed at load
 * time from `DSH_PORTABLE_ROOT` — so the same patch file keeps working when the
 * stick mounts under another drive letter, without the shell rewriting paths on
 * every start.
 *
 * The patch file only exists once dsh has created the profile, so a missing
 * file is reported rather than created: writing a partial profile would race
 * the runtime's own bootstrap.
 *
 * @param {Record<string, string>} dirs - result of {@link portablePaths}.
 * @returns {{written: boolean, reason: string}} outcome.
 */
function ensureProfileOverlay(dirs) {
  const file = profilePatchPath(dirs)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { written: false, reason: 'no-profile' }
  }
  if (text.includes(PROFILE_OVERLAY_MARKER)) return { written: false, reason: 'present' }

  const overlay = [
    '',
    PROFILE_OVERLAY_MARKER,
    '- id: workspace-controller',
    '  name: "@deepseek-ai/dsh-api-workspace-controller"',
    '  config:',
    // YAML single quotes keep both backslashes; JavaScript then reads `\\` as
    // one separator, which is what `process.env.DSH_PORTABLE_ROOT + '\data\...'`
    // needs to build a real Windows path.
    "    documentsDirectory: !!js process.env.DSH_PORTABLE_ROOT + '\\\\data\\\\documents'",
    '',
  ].join('\n')

  // A profile that was never patched stores the empty flow sequence `[]`.
  // A block entry appended after it is a YAML error ("end of the stream or a
  // document separator is expected"), so the marker has to go first — the rest
  // of the file is comments, which stay.
  const base = text.replace(/^\s*\[\]\s*$/m, '')

  try {
    fs.writeFileSync(file, `${base.replace(/\s*$/, '')}\n${overlay}`, 'utf8')
    return { written: true, reason: 'added' }
  } catch (error) {
    return { written: false, reason: `write-failed: ${error.message}` }
  }
}

/**
 * Remove a directory tree that holds nothing but empty directories.
 *
 * The runtime creates `~/.dsh` (sometimes with an empty `profiles/` inside)
 * before it reads `DSH_HOME`, so a portable run can leave an empty folder on
 * the host. Only provably empty directories are removed: one file anywhere in
 * the tree keeps the whole tree, because it may belong to a non-portable
 * install that shares this machine.
 *
 * @param {string} target - absolute directory.
 * @returns {boolean} whether the tree was removed.
 */
function pruneEmptyDirectory(target) {
  let entries
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return false
  }
  let empty = true
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false
      continue
    }
    if (!pruneEmptyDirectory(path.join(target, entry.name))) empty = false
  }
  if (!empty) return false
  try {
    fs.rmdirSync(target)
    return true
  } catch {
    return false
  }
}

module.exports = {
  MARKER_FILE,
  PROFILE_OVERLAY_MARKER,
  resolvePortableRoot,
  portablePaths,
  ensurePortableDirectories,
  configureElectronPaths,
  portableEnvironment,
  ensureProfileOverlay,
  profilePatchPath,
  pruneEmptyDirectory,
  seedPortableHome,
  toUnixPath,
}
