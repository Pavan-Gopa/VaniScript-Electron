'use strict';

/**
 * BAT-02 folder access boundary.
 *
 * Every path is resolved through realpath, checked as a directory, and
 * permission-probed before it is returned for persistence or watching. macOS
 * does not require a security-scoped bookmark in this app: the main process
 * is unsandboxed (`sandbox: false` for the main process) and directory paths
 * come from the Electron open-directory dialog. The adapter remains
 * injectable so a future sandboxed build can add bookmark start/stop without
 * changing watcher/domain contracts.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createAppError } = require('../../../shared/contracts/errors.ts');

function errorDetails(error) {
  return {
    cause: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
  };
}

function assertSafePathSyntax(folderPath, label = 'Path') {
  if (typeof folderPath !== 'string' || folderPath.length === 0) {
    throw createAppError('VALIDATION_FAILED', `${label} must be a non-empty string.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(folderPath)) {
    throw createAppError('VALIDATION_FAILED', `${label} must not contain NUL or control characters.`);
  }
  if (path.sep === '/' && folderPath.includes('\\')) {
    throw createAppError('PERMISSION_DENIED', `${label} must not contain backslash path separators on POSIX.`);
  }
  if (path.sep !== '\\' && /^[A-Za-z]:[\\/]/.test(folderPath)) {
    throw createAppError('PERMISSION_DENIED', `${label} must not contain a Windows absolute path.`);
  }
  if (folderPath.replace(/\\/g, '/').split('/').some((component) => component === '..')) {
    throw createAppError('PERMISSION_DENIED', `${label} must not contain path traversal segments.`);
  }
  return folderPath;
}

function isCaseInsensitivePlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function isRelativePath(relative) {
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function isWithinRoot(rootPath, targetPath, platform = process.platform) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (isRelativePath(relative)) return true;
  if (!isCaseInsensitivePlatform(platform)) return false;
  const foldedRoot = root.normalize('NFC').toLocaleLowerCase('en-US');
  const foldedTarget = target.normalize('NFC').toLocaleLowerCase('en-US');
  return isRelativePath(path.relative(foldedRoot, foldedTarget));
}


function canonicalRootForConfinement(rootPath) {
  assertSafePathSyntax(rootPath, 'Profile root');
  const absoluteRoot = path.resolve(rootPath);
  let rootStat;
  try {
    rootStat = fs.lstatSync(absoluteRoot);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw createAppError(code === 'ENOENT' ? 'NOT_FOUND' : 'PERMISSION_DENIED', `Profile root could not be inspected: ${absoluteRoot}`, errorDetails(error));
  }
  if (rootStat.isSymbolicLink()) {
    throw createAppError('PERMISSION_DENIED', `Profile root must not be replaced by a symlink: ${absoluteRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw createAppError('VALIDATION_FAILED', `Profile root is not a directory: ${absoluteRoot}`);
  }
  try {
    return fs.realpathSync.native(absoluteRoot);
  } catch (error) {
    throw createAppError('PERMISSION_DENIED', `Profile root could not be resolved: ${absoluteRoot}`, errorDetails(error));
  }
}

function assertNoSymlinkComponents(rootPath, targetPath, allowMissingLeaf = false) {
  const relative = path.relative(rootPath, targetPath);
  if (!isRelativePath(relative)) {
    throw createAppError('PERMISSION_DENIED', `Path escapes profile root: ${targetPath}`);
  }
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && error && error.code === 'ENOENT' && index === components.length - 1) return;
      throw createAppError('PERMISSION_DENIED', `Cannot inspect profile path component "${current}".`, errorDetails(error));
    }
    if (stat.isSymbolicLink()) {
      throw createAppError('PERMISSION_DENIED', `Refusing symlink path component "${current}".`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw createAppError('PERMISSION_DENIED', `Profile path component is not a directory: "${current}".`);
    }
  }
}

function resolvePathWithinRoot(rootPath, candidatePath, options = {}) {
  const root = canonicalRootForConfinement(rootPath);
  assertSafePathSyntax(candidatePath, 'Candidate path');
  if (options.relativeOnly && path.isAbsolute(candidatePath)) {
    throw createAppError('PERMISSION_DENIED', 'Candidate path must be relative to the profile root.');
  }
  const absolutePath = path.isAbsolute(candidatePath)
    ? path.normalize(candidatePath)
    : path.resolve(root, candidatePath);

  let probe = absolutePath;
  const missing = [];
  let existing = null;
  while (true) {
    try {
      existing = fs.lstatSync(probe);
      break;
    } catch (error) {
      if (error && error.code === 'ENOENT' && path.dirname(probe) !== probe) {
        missing.unshift(path.basename(probe));
        probe = path.dirname(probe);
        continue;
      }
      if (options.allowMissing && error && error.code === 'ENOENT') break;
      throw createAppError('PERMISSION_DENIED', `Cannot inspect candidate path "${probe}".`, errorDetails(error));
    }
  }

  if (missing.length > 0) {
    const canonicalParent = fs.realpathSync.native(probe);
    if (!isWithinRoot(root, canonicalParent)) {
      throw createAppError('PERMISSION_DENIED', `Candidate path escapes profile root: ${candidatePath}`);
    }
    if (!options.allowMissing) {
      throw createAppError('NOT_FOUND', `Candidate path does not exist: ${absolutePath}`);
    }
    const lexicalParentRelative = path.relative(root, probe);
    if (isRelativePath(lexicalParentRelative) && lexicalParentRelative !== '') {
      assertNoSymlinkComponents(root, probe);
    }
    const canonicalPath = path.join(canonicalParent, ...missing);
    return {
      rootPath: root,
      absolutePath,
      canonicalPath,
      relativePath: path.relative(root, canonicalPath).split(path.sep).join('/').normalize('NFC'),
      exists: false,
    };
  }

  if (existing.isSymbolicLink()) {
    throw createAppError('PERMISSION_DENIED', `Refusing symlink candidate path "${absolutePath}".`);
  }
  const lexicalTargetRelative = path.relative(root, absolutePath);
  if (isRelativePath(lexicalTargetRelative) && lexicalTargetRelative !== '') {
    assertNoSymlinkComponents(root, absolutePath);
  }
  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync.native(absolutePath);
  } catch (error) {
    throw createAppError('PERMISSION_DENIED', `Cannot resolve candidate path "${absolutePath}".`, errorDetails(error));
  }
  if (!isWithinRoot(root, canonicalPath)) {
    throw createAppError('PERMISSION_DENIED', `Candidate path resolves outside profile root: ${candidatePath}`);
  }
  return {
    rootPath: root,
    absolutePath,
    canonicalPath,
    relativePath: path.relative(root, canonicalPath).split(path.sep).join('/').normalize('NFC'),
    exists: true,
  };
}

function assertPathWithinRoot(rootPath, candidatePath, options = {}) {
  return resolvePathWithinRoot(rootPath, candidatePath, options);
}

function assertFolderInput(folderPath) {
  assertSafePathSyntax(folderPath, 'Folder path');
}

function probeFolderPermission(canonicalPath) {
  try {
    fs.accessSync(canonicalPath, fs.constants.R_OK | fs.constants.X_OK);
    // accessSync alone can be optimistic on some network/ACL providers. A
    // small directory read verifies that the watcher can enumerate children.
    fs.readdirSync(canonicalPath, { withFileTypes: true });
  } catch (error) {
    throw createAppError('PERMISSION_DENIED', `Folder access denied: ${canonicalPath}`, errorDetails(error));
  }
}

function canonicalFolderPath(folderPath) {
  assertFolderInput(folderPath);
  const absolutePath = path.resolve(folderPath);
  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync.native(absolutePath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      throw createAppError('PERMISSION_DENIED', `Folder access denied: ${absolutePath}`, errorDetails(error));
    }
    throw createAppError('NOT_FOUND', `Folder does not exist: ${absolutePath}`, errorDetails(error));
  }

  let stats;
  try {
    stats = fs.statSync(canonicalPath);
  } catch (error) {
    throw createAppError('PERMISSION_DENIED', `Folder could not be inspected: ${canonicalPath}`, errorDetails(error));
  }
  if (!stats.isDirectory()) {
    throw createAppError('VALIDATION_FAILED', `Folder path is not a directory: ${canonicalPath}`);
  }
  probeFolderPermission(canonicalPath);
  return canonicalPath;
}

function opaquePathReference(platform, canonicalPath) {
  // This reference is deliberately non-authoritative and contains no path.
  return `${platform}:folder:${crypto.createHash('sha256').update(canonicalPath).digest('hex')}`;
}

class FolderAccessAdapter {
  constructor({ platform = process.platform, accessReferenceFactory = null } = {}) {
    this.platform = platform;
    this.accessReferenceFactory = typeof accessReferenceFactory === 'function'
      ? accessReferenceFactory
      : null;
  }

  createAccessReference(canonicalPath) {
    if (this.accessReferenceFactory) {
      const reference = this.accessReferenceFactory(canonicalPath);
      if (reference !== null && reference !== undefined && typeof reference !== 'string') {
        throw createAppError('VALIDATION_FAILED', 'Folder access reference must be a string or null.');
      }
      return reference === undefined ? null : reference;
    }
    return null;
  }

  resolve(folderPath) {
    const canonicalPath = canonicalFolderPath(folderPath);
    return {
      canonicalPath,
      accessRef: this.createAccessReference(canonicalPath),
      platform: this.platform,
    };
  }

  probe(canonicalPath) {
    const resolved = canonicalFolderPath(canonicalPath);
    return { canonicalPath: resolved, platform: this.platform };
  }
}

class MacOSFolderAccessAdapter extends FolderAccessAdapter {
  constructor(options = {}) {
    super({ platform: 'darwin', ...options });
  }

  createAccessReference(canonicalPath) {
    // The packaged app's main process is unsandboxed and receives paths from
    // Electron's open-directory dialog, so a canonical path is sufficient.
    // Keep the factory seam for a future sandboxed build that needs a
    // security-scoped bookmark.
    return super.createAccessReference(canonicalPath);
  }
}

class WindowsFolderAccessAdapter extends FolderAccessAdapter {
  constructor(options = {}) {
    super({ platform: 'win32', ...options });
  }

  createAccessReference(canonicalPath) {
    if (this.accessReferenceFactory) return super.createAccessReference(canonicalPath);
    return opaquePathReference(this.platform, canonicalPath);
  }
}

class LinuxFolderAccessAdapter extends FolderAccessAdapter {
  constructor(options = {}) {
    super({ platform: 'linux', ...options });
  }

  createAccessReference(canonicalPath) {
    if (this.accessReferenceFactory) return super.createAccessReference(canonicalPath);
    return opaquePathReference(this.platform, canonicalPath);
  }
}

function createFolderAccessAdapter(platform = process.platform, options = {}) {
  if (platform === 'darwin') return new MacOSFolderAccessAdapter(options);
  if (platform === 'win32') return new WindowsFolderAccessAdapter(options);
  return new LinuxFolderAccessAdapter({ ...options, platform: platform || 'linux' });
}

function resolveFolderAccess(folderPath, options = {}) {
  return createFolderAccessAdapter(options.platform, options).resolve(folderPath);
}

function isPermissionError(error) {
  return Boolean(error && (error.code === 'PERMISSION_DENIED' || error.code === 'EACCES' || error.code === 'EPERM'));
}

module.exports = {
  FolderAccessAdapter,
  LinuxFolderAccessAdapter,
  MacOSFolderAccessAdapter,
  WindowsFolderAccessAdapter,
  canonicalFolderPath,
  assertPathWithinRoot,
  assertSafePathSyntax,
  resolvePathWithinRoot,
  createFolderAccessAdapter,
  isPermissionError,
  probeFolderPermission,
  resolveFolderAccess,
};
