'use strict';

/**
 * BAT-02 folder access boundary.
 *
 * Main owns this adapter; renderer paths are inputs only. Every path is
 * resolved through realpath, checked as a directory, and permission-probed
 * before it is returned for persistence or watching. macOS bookmark creation
 * is intentionally a thin, null-returning seam for parity; security-scoped
 * bookmark hardening belongs to the platform hardening pass.
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

function assertFolderInput(folderPath) {
  if (typeof folderPath !== 'string' || folderPath.length === 0) {
    throw createAppError('VALIDATION_FAILED', 'Folder path must be a non-empty string.');
  }
  if (folderPath.includes('\0')) {
    throw createAppError('VALIDATION_FAILED', 'Folder path must not contain NUL bytes.');
  }
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
    // Security-scoped bookmark persistence is intentionally a stub seam for
    // parity. D3 hardening can inject a real bookmark factory without changing
    // watcher/domain contracts.
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
  createFolderAccessAdapter,
  isPermissionError,
  probeFolderPermission,
  resolveFolderAccess,
};
