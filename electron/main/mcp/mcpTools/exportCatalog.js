'use strict';

/**
 * P3E.D3-S4-A file-export catalogue: `export_transcript`,
 * `export_project_bundle`, and `reveal_export` against the protected MCP
 * Exports store. Scope and risk classification mirror the canonical Swift
 * catalogue (`McpExpandedToolCatalog`: all three are `.files` tools).
 *
 * The catalogue is standalone and fully injectable — every capability arrives
 * through `options` (during wiring these bind to `createMcpExportStore`
 * methods plus the shell and content producers), so unit tests drive handlers
 * with fakes:
 *
 * - filePermissionEnabled: gate switch, default true; when false every tool
 *   fails typed PERMISSION_DENIED.
 * - buildTranscriptArtifact(args) -> {content, fileName}: transcript builder.
 * - createExportDirectory(label) -> {id, dir}: protected store makeDirectory.
 * - writeFile(filePath, utf8String): atomic store write.
 * - registerFiles(id, files) -> projection: store register.
 * - fileSize(path) -> bytes|null: store stat, bound for wiring symmetry (the
 *   projections handlers consume already carry sizes from registerFiles).
 * - resolveProject(projectId?) -> {id, name}|null: explicit id else active.
 * - bundleWriter(project, destPath): project archive producer.
 * - revealRecord(id) -> {files}: store reveal lookup (typed not-found).
 * - shellReveal(path): Finder/shell activation of one exported file.
 *
 * Handlers orchestrate exactly the recorded flows and never surface absolute
 * paths in their results; failures are typed ExportCatalogError objects with
 * machine codes shared with the rest of the MCP surface.
 */

const path = require('node:path');

const FILES_SCOPE = 'files';
const FILES_CAPABILITY = 'mcp.files';

const TRANSCRIPT_SIDES = Object.freeze(['original', 'translated']);
const TRANSCRIPT_FORMATS = Object.freeze(['txt', 'markdown', 'srt', 'vtt']);

// Bundle stems keep Cyrillic letters on purpose (project names frequently are
// Russian); every other unsafe run collapses to '-' like the store labels do.
const UNSAFE_STEM_RUN = /[^A-Za-z0-9\u0410-\u044F_-]+/g;
const STEM_MAX_CHARS = 80;
const DEFAULT_STEM = 'VaniScript-Project';
const BUNDLE_EXTENSION = '.vaniscript';
const TRANSCRIPT_DIRECTORY_LABEL = 'Transcript';
// Machine code thrown by McpExportStoreError for unknown/empty exports.
const STORE_NOT_FOUND_CODE = 'MCP_EXPORT_NOT_FOUND';

const EXPORT_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'MCP_INVALID_REQUEST',
  NOT_FOUND: 'MCP_NOT_FOUND',
  PERMISSION_DENIED: 'MCP_PERMISSION_DENIED',
  CAPABILITY_UNAVAILABLE: 'MCP_CAPABILITY_UNAVAILABLE',
});

const CATALOG_HTTP_STATUS = Object.freeze({
  [EXPORT_ERROR_CODES.INVALID_REQUEST]: 400,
  [EXPORT_ERROR_CODES.NOT_FOUND]: 404,
  [EXPORT_ERROR_CODES.PERMISSION_DENIED]: 403,
  [EXPORT_ERROR_CODES.CAPABILITY_UNAVAILABLE]: 503,
});

// The three flows return heterogeneous payloads (projections, reveal shape),
// so the result contract stays permissive by design.
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
});

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const string = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const enumString = (values, description) => ({
  type: 'string',
  enum: values,
  ...(description ? { description } : {}),
});

function definition(name, description, inputSchema, annotations = {}) {
  return Object.freeze({
    name,
    description,
    risk: FILES_SCOPE,
    riskLevel: FILES_SCOPE,
    scope: FILES_SCOPE,
    capabilityRequirements: Object.freeze([FILES_CAPABILITY]),
    requiredCapabilities: Object.freeze([FILES_CAPABILITY]),
    capabilities: Object.freeze([FILES_CAPABILITY]),
    confirmationText: null,
    inputSchema,
    resultSchema: RESULT_SCHEMA,
    outputSchema: RESULT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: false,
      idempotentHint: annotations.idempotentHint === true,
      openWorldHint: false,
    }),
  });
}

const EXPORT_TOOL_DEFINITIONS = Object.freeze([
  definition(
    'export_transcript',
    "Export a transcript into VaniScript's protected MCP Exports folder.",
    objectSchema(
      {
        side: enumString(TRANSCRIPT_SIDES, 'Which cue side to export.'),
        format: enumString(TRANSCRIPT_FORMATS, 'Output format.'),
        language: string('Optional translation language for the translated side.'),
      },
      ['side', 'format'],
    ),
  ),
  definition(
    'export_project_bundle',
    "Export one project bundle into VaniScript's protected MCP Exports folder.",
    objectSchema({
      projectId: string('Optional project identifier; defaults to the active project.'),
    }),
  ),
  definition(
    'reveal_export',
    'Reveal a completed MCP export in Finder by exportId.',
    objectSchema(
      {
        exportId: string('Opaque export identifier from a previous export.'),
      },
      ['exportId'],
    ),
    { readOnlyHint: true, idempotentHint: true },
  ),
]);

const EXPORT_TOOL_NAMES = Object.freeze(EXPORT_TOOL_DEFINITIONS.map((tool) => tool.name));

class ExportCatalogError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'ExportCatalogError';
    this.code = code;
    this.mcpCode = code;
    this.status = status || CATALOG_HTTP_STATUS[code] || 500;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, ExportCatalogError.prototype);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

/** Unsafe runs collapse to '-', edges trim, Cyrillic survives, fallback applies. */
function sanitizeStem(value) {
  const clean = String(value ?? '')
    .replace(UNSAFE_STEM_RUN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STEM_MAX_CHARS);
  return clean.length > 0 ? clean : DEFAULT_STEM;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.filePermissionEnabled]
 * @param {Function} [options.buildTranscriptArtifact]
 * @param {Function} [options.createExportDirectory]
 * @param {Function} [options.writeFile]
 * @param {Function} [options.registerFiles]
 * @param {Function} [options.fileSize]
 * @param {Function} [options.resolveProject]
 * @param {Function} [options.bundleWriter]
 * @param {Function} [options.revealRecord]
 * @param {Function} [options.shellReveal]
 */
function createExportCatalog(options = {}) {
  const opts = asObject(options);
  const filePermissionEnabled = opts.filePermissionEnabled !== false;

  const dependency = (name) => (typeof opts[name] === 'function' ? opts[name] : null);

  function requireFilePermission(toolName) {
    if (!filePermissionEnabled) {
      throw new ExportCatalogError(
        EXPORT_ERROR_CODES.PERMISSION_DENIED,
        `File permission is disabled; "${toolName}" cannot run.`,
      );
    }
  }

  function requireCapabilities(names) {
    const missing = names.filter((name) => dependency(name) === null);
    if (missing.length > 0) {
      throw new ExportCatalogError(
        EXPORT_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Missing injected dependencies: ${missing.join(', ')}.`,
        { missingCapabilities: missing },
      );
    }
  }

  /** validate args -> build artifact -> empty+name checks -> mkdir -> containment check -> write -> register */
  async function exportTranscript(args = {}) {
    const params = asObject(args);
    requireFilePermission('export_transcript');

    const side = params.side;
    if (!TRANSCRIPT_SIDES.includes(side)) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, '"side" must be "original" or "translated".');
    }
    const format = params.format;
    if (!TRANSCRIPT_FORMATS.includes(format)) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, '"format" must be one of txt, markdown, srt, vtt.');
    }
    let language = null;
    if (params.language !== undefined && params.language !== null) {
      if (typeof params.language !== 'string' || params.language.trim().length === 0) {
        throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, '"language" must be a non-empty string when provided.');
      }
      language = params.language;
    }
    requireCapabilities(['buildTranscriptArtifact', 'createExportDirectory', 'writeFile', 'registerFiles']);
    const artifact = await dependency('buildTranscriptArtifact')({ side, format, language });
    const content = artifact && typeof artifact.content === 'string' ? artifact.content : '';
    if (content.length === 0) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.NOT_FOUND, 'The requested transcript has no content to export.');
    }
    if (!artifact || typeof artifact.fileName !== 'string' || artifact.fileName.length === 0) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, 'The transcript builder returned no usable file name.');
    }

    const fileName = path.basename(artifact.fileName);
    // Native lastPathComponent parity: basename first, then the RESULT is
    // safety-checked — raw separator presence alone must not reject.
    if (
      fileName.length === 0 ||
      fileName === '.' ||
      fileName === '..' ||
      fileName.includes('/') ||
      fileName.includes('\\')
    ) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, 'The transcript builder returned an unsafe file name.');
    }

    const { id, dir } = await dependency('createExportDirectory')(TRANSCRIPT_DIRECTORY_LABEL);
    const destPath = path.join(dir, fileName);
    const outsideDest = path.relative(path.resolve(dir), path.resolve(destPath));
    if (
      outsideDest.length === 0 ||
      outsideDest.split(path.sep)[0] === '..' ||
      path.isAbsolute(outsideDest)
    ) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, 'The transcript destination must stay inside the protected export directory.');
    }
    await dependency('writeFile')(destPath, content);
    return dependency('registerFiles')(id, [destPath]);
  }

  /** resolve project -> sanitized stem -> writer -> register */
  async function exportProjectBundle(args = {}) {
    const params = asObject(args);
    requireFilePermission('export_project_bundle');

    let projectId;
    if (params.projectId !== undefined && params.projectId !== null) {
      if (typeof params.projectId !== 'string' || params.projectId.length === 0) {
        throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, '"projectId" must be a non-empty string when provided.');
      }
      projectId = params.projectId;
    }

    requireCapabilities(['resolveProject', 'createExportDirectory', 'bundleWriter', 'registerFiles']);
    const project = await dependency('resolveProject')(projectId);
    if (!isObject(project)) {
      throw new ExportCatalogError(
        EXPORT_ERROR_CODES.NOT_FOUND,
        projectId === undefined ? 'No active project is available to export.' : 'Unknown project.',
      );
    }

    const stem = sanitizeStem(project.name);
    const { id, dir } = await dependency('createExportDirectory')(stem);
    const destPath = path.join(dir, `${stem}${BUNDLE_EXTENSION}`);
    await dependency('bundleWriter')(project, destPath);
    return dependency('registerFiles')(id, [destPath]);
  }

  /** registered-record lookup -> shell reveal of the first completed file */
  async function revealExport(args = {}) {
    const params = asObject(args);
    requireFilePermission('reveal_export');

    const exportId = params.exportId;
    if (typeof exportId !== 'string' || exportId.length === 0) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.INVALID_REQUEST, '"exportId" is required.');
    }

    requireCapabilities(['revealRecord', 'shellReveal']);
    let record = null;
    try {
      record = await dependency('revealRecord')(exportId);
    } catch (error) {
      if (error && error.code === STORE_NOT_FOUND_CODE) {
        throw new ExportCatalogError(EXPORT_ERROR_CODES.NOT_FOUND, 'Unknown exportId or no completed files.');
      }
      throw error;
    }
    const files = record && Array.isArray(record.files) ? record.files : [];
    if (files.length === 0) {
      throw new ExportCatalogError(EXPORT_ERROR_CODES.NOT_FOUND, 'Unknown exportId or no completed files.');
    }

    const firstFile = String(files[0]);
    await dependency('shellReveal')(firstFile);
    return { success: true, exportId, fileName: path.basename(firstFile) };
  }

  const handlers = Object.freeze({
    export_transcript: exportTranscript,
    export_project_bundle: exportProjectBundle,
    reveal_export: revealExport,
  });

  return {
    tools: EXPORT_TOOL_DEFINITIONS,
    definitions: EXPORT_TOOL_DEFINITIONS,
    names: EXPORT_TOOL_NAMES,
    handlers,
    scope: FILES_SCOPE,
    requiresFilePermission: true,
    execute: async (name, args, context = {}) => {
      const handler = handlers[name];
      if (typeof handler !== 'function') {
        throw new ExportCatalogError(EXPORT_ERROR_CODES.NOT_FOUND, `Unknown export tool: ${name}`);
      }
      return handler(args, context);
    },
    get: (name) => (typeof handlers[name] === 'function' ? handlers[name] : null),
  };
}

function registerExportTools(server, options = {}) {
  if (!server || typeof server.registerToolCatalog !== 'function') {
    throw new TypeError('registerExportTools requires an MCP server with registerToolCatalog().');
  }
  const catalog = options && options.handlers && options.tools ? options : createExportCatalog(options);
  server.registerToolCatalog(catalog);
  return catalog;
}

module.exports = {
  FILES_SCOPE,
  EXPORT_ERROR_CODES,
  EXPORT_TOOL_DEFINITIONS,
  EXPORT_TOOL_NAMES,
  RESULT_SCHEMA,
  ExportCatalogError,
  createExportCatalog,
  registerExportTools,
};
