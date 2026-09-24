'use strict'

// Modern macFUSE integration for fuse-native 2.x.
//
// fuse-native bundles an OSXFUSE 3 dylib on Darwin. That dylib has no arm64
// slice and its setup helper installs an obsolete kernel extension. We never
// install or load it. Instead, when macFUSE is already installed by the user,
// the TAS postinstall hook rebuilds fuse-native against that system library.

const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const MACFUSE_BUNDLE = '/Library/Filesystems/macfuse.fs'

const LIBRARY_CANDIDATES = [
  '/usr/local/lib/libfuse.dylib',
  '/opt/homebrew/lib/libfuse.dylib',
  '/usr/local/lib/libfuse.2.dylib',
  '/opt/homebrew/lib/libfuse.2.dylib',
  '/Library/Frameworks/macfUSE.framework/Versions/Current/lib/libfuse.dylib',
  '/Library/Frameworks/macfUSE.framework/lib/libfuse.dylib'
]

const INCLUDE_ROOTS = [
  '/usr/local/include',
  '/opt/homebrew/include',
  '/Library/Frameworks/macfUSE.framework/Headers'
]

function findMacFuseInstallation ({ exists = fs.existsSync } = {}) {
  if (!exists(MACFUSE_BUNDLE)) {
    return {
      ready: false,
      reason: 'current macFUSE is not installed at /Library/Filesystems/macfuse.fs'
    }
  }

  const library = LIBRARY_CANDIDATES.find(exists)
  if (!library) {
    return {
      ready: false,
      reason: 'macFUSE is installed but its libfuse.dylib was not found'
    }
  }

  const include = findIncludeDirectory(exists)
  if (!include) {
    return {
      ready: false,
      reason: 'macFUSE is installed but its FUSE development headers were not found'
    }
  }

  return { ready: true, bundle: MACFUSE_BUNDLE, library, include }
}

function findIncludeDirectory (exists) {
  for (const root of INCLUDE_ROOTS) {
    for (const candidate of [
      path.join(root, 'fuse.h'),
      path.join(root, 'osxfuse', 'fuse.h'),
      path.join(root, 'fuse', 'fuse.h')
    ]) {
      if (exists(candidate)) return path.dirname(candidate)
    }
  }
  return null
}

function getFuseNativeDirectory (packageRoot) {
  try {
    return path.dirname(require.resolve('fuse-native/package.json', { paths: [packageRoot] }))
  } catch {
    return null
  }
}

function getDarwinLibraryDirectory (packageRoot) {
  try {
    return path.dirname(require.resolve('fuse-shared-library-darwin/package.json', { paths: [packageRoot] }))
  } catch {
    return null
  }
}

function validateMacFuseNativeBinding ({
  packageRoot = path.resolve(__dirname, '..', '..'),
  exists = fs.existsSync,
  execFileSync = childProcess.execFileSync
} = {}) {
  const installation = findMacFuseInstallation({ exists })
  if (!installation.ready) return installation

  const fuseNativeDir = getFuseNativeDirectory(packageRoot)
  if (!fuseNativeDir) {
    return { ready: false, reason: 'fuse-native is not installed' }
  }

  const addon = path.join(fuseNativeDir, 'build', 'Release', 'fuse.node')
  if (!exists(addon)) {
    return {
      ready: false,
      reason: 'the macFUSE native addon was not rebuilt from source; reinstall TAS after installing Xcode Command Line Tools'
    }
  }

  let linkedLibraries
  try {
    linkedLibraries = execFileSync('/usr/bin/otool', ['-L', addon], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return { ready: false, reason: 'could not inspect the macFUSE native addon' }
  }

  if (linkedLibraries.includes('libosxfuse')) {
    return { ready: false, reason: 'the legacy OSXFUSE binary is still loaded; reinstall TAS to rebuild against macFUSE' }
  }
  if (!linkedLibraries.includes('libfuse')) {
    return { ready: false, reason: 'the native addon is not linked to macFUSE libfuse' }
  }

  return { ready: true, ...installation, addon }
}

function macFuseAdapterSource () {
  return `'use strict'
const path = require('path')
const macfuse = require(path.join(__dirname, '..', '..', 'src', 'fuse', 'macfuse.cjs'))
const installation = macfuse.findMacFuseInstallation()

function unavailable () {
  return new Error('Current macFUSE is required for TAS mount: ' + installation.reason)
}

module.exports = {
  get lib () {
    if (!installation.ready) throw unavailable()
    return installation.library
  },
  get include () {
    if (!installation.ready) throw unavailable()
    return installation.include
  },
  beforeMount (cb) { process.nextTick(cb || (() => {})) },
  beforeUnmount (cb) { process.nextTick(cb || (() => {})) },
  configure (cb) { process.nextTick(() => (cb || (() => {}))(installation.ready ? null : unavailable())) },
  unconfigure (cb) { process.nextTick(() => (cb || (() => {}))(new Error('TAS never installs or removes macFUSE'))) },
  isConfigured (cb) { process.nextTick(() => cb(null, installation.ready)) }
}
`
}

function patchFuseSource (fuseNativeDir) {
  const sourcePath = path.join(fuseNativeDir, 'fuse-native.c')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const oldDefine = '#define FUSE_USE_VERSION 29'
  const newDefine = '#ifdef __APPLE__\n#define FUSE_USE_VERSION 26\n#else\n#define FUSE_USE_VERSION 29\n#endif'

  if (source.includes(newDefine)) return
  if (!source.includes(oldDefine)) throw new Error('Unsupported fuse-native source layout')
  fs.writeFileSync(sourcePath, source.replace(oldDefine, newDefine))
}

function addLibraryRpath (addon, library) {
  const result = childProcess.spawnSync(
    '/usr/bin/install_name_tool',
    ['-add_rpath', path.dirname(library), addon],
    { stdio: 'ignore' }
  )
  // A duplicate rpath produces a nonzero exit code and is already safe.
  return result.status === 0 || result.status === 1
}

function installMacFuseAdapter ({
  packageRoot = path.resolve(__dirname, '..', '..'),
  platform = process.platform,
  log = console
} = {}) {
  if (platform !== 'darwin') return { skipped: true, reason: 'not macOS' }

  const installation = findMacFuseInstallation()
  if (!installation.ready) {
    log.warn(`[tas] macOS FUSE was not built: ${installation.reason}`)
    return { skipped: true, ...installation }
  }

  const fuseNativeDir = getFuseNativeDirectory(packageRoot)
  const darwinLibraryDir = getDarwinLibraryDirectory(packageRoot)
  if (!fuseNativeDir || !darwinLibraryDir) {
    const reason = 'optional fuse-native dependencies are not installed'
    log.warn(`[tas] macOS FUSE was not built: ${reason}`)
    return { ready: false, reason }
  }

  try {
    fs.writeFileSync(path.join(darwinLibraryDir, 'index.js'), macFuseAdapterSource())
    patchFuseSource(fuseNativeDir)

    const npmCli = process.env.npm_execpath
    if (!npmCli) throw new Error('npm did not provide its rebuild executable')

    const rebuild = childProcess.spawnSync(
      process.execPath,
      [npmCli, 'rebuild', 'fuse-native', '--build-from-source', '--foreground-scripts'],
      {
        cwd: packageRoot,
        stdio: 'inherit',
        env: { ...process.env, npm_config_build_from_source: 'true' }
      }
    )
    if (rebuild.status !== 0) throw new Error('fuse-native could not compile against macFUSE')

    const addon = path.join(fuseNativeDir, 'build', 'Release', 'fuse.node')
    addLibraryRpath(addon, installation.library)

    const status = validateMacFuseNativeBinding({ packageRoot })
    if (!status.ready) throw new Error(status.reason)
    log.log(`[tas] macFUSE native addon rebuilt for ${process.arch}`)
    return status
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn(`[tas] macOS FUSE was not built: ${reason}`)
    return { ready: false, reason }
  }
}

module.exports = {
  MACFUSE_BUNDLE,
  findMacFuseInstallation,
  getFuseNativeDirectory,
  validateMacFuseNativeBinding,
  installMacFuseAdapter
}

if (require.main === module) installMacFuseAdapter()
