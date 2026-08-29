'use strict';

/**
 * P3E.D3-S4-C wiring contract for the production MCP Exports composition.
 *
 * main.js cannot be required under plain node (it loads Electron and starts
 * process-level services at require time), so the wiring half of this suite
 * pins the observable composition contract against the real sources using the
 * brace-aware extractor style of mainProjectBundleIpc.test.js: exactly one
 * store/catalogue construction site each, the ten export/preflight/Shorts
 * tools dispatched through the Main-side catalogues ahead of the legacy
 * renderer forwarding branch, the singleton bundle writer and shell reveal
 * bindings, the deterministic typed-error → JSON-RPC code table with root-path
 * redaction, renderer bridge handlers for all three new channels, and an
 * untouched legacy eight-tool surface.
 *
 * The behavioural half drives the REAL catalogue/store modules wired in the
 * exact shape main.js binds them (no Electron runtime needed): protected
 * projections without absolute paths, typed failures for every flow, and the
 * readiness-driven preflight projections.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
require('tsx/cjs');

const { buildTranscriptArtifact } = require('../src/lib/review-format.ts');

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');
const MAIN_SOURCE = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(ELECTRON_DIR, 'preload.js'), 'utf8');
const TYPES_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'types.ts'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

const {
  EXPORT_TOOL_DEFINITIONS,
  EXPORT_TOOL_NAMES,
  ExportCatalogError,
  createExportCatalog,
} = require('../electron/main/mcp/mcpTools/exportCatalog.js');
const {
  READ_TOOL_DEFINITIONS,
  ReadCatalogError,
  createReadCatalog,
} = require('../electron/main/mcp/mcpTools/readCatalog.js');
const { createMcpExportStore } = require('../electron/main/projects/mcpExportStore.js');

const PREFLIGHT_TOOL_NAMES = Object.freeze(['list_export_options', 'validate_export']);
const SHORTS_READ_TOOL_NAMES = Object.freeze([
  'get_shorts_plans',
  'get_shorts_plan',
  'list_rejected_shorts_plans',
  'validate_shorts_plan',
  'get_visual_editor_state',
]);
const LEGACY_RENDERER_TOOLS = Object.freeze([
  'get_project_state',
  'update_chunk_text',
  'approve_chunk',
  'get_subtitle_style',
  'update_subtitle_style',
  'create_shorts_plan',
  'set_background_settings',
  'trigger_render',
]);

/** Balanced-brace body of one top-level `function NAME() { … }`. */
function extractFunctionBody(source, name) {
  const marker = `function ${name}()`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${name} is defined in main.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced function body for ${name}`);
}

function sliceBetween(source, startMarker, endMarker) {
  const normalizedSource = source.replace(/\r\n?/g, '\n');
  const start = normalizedSource.indexOf(startMarker);
  assert.ok(start !== -1, `start marker found: ${startMarker}`);
  const end = normalizedSource.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker found: ${endMarker}`);
  return normalizedSource.slice(start, end);
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Evaluates a source slice in a function sandbox. Only used for pure helper
 * slices whose sole free variable is `app` (the Electron app namespace).
 */
function evaluateSlice(slice, stubApp) {
  return new Function('app', `"use strict";\n${slice}\nreturn { redactKnownRoots, mcpToolRpcError };`)(stubApp);
}

const COMPOSITION_BLOCK = sliceBetween(
  MAIN_SOURCE,
  '// ─── MCP Exports composition (P3E.D3-S4-C)',
  'function copyProjectAsset(',
);

const RPC_PROJECTION_SLICE = sliceBetween(
  MAIN_SOURCE,
  'const MCP_EXPORT_RPC_CODES',
  'function dispatchedMcpToolCatalog(',
);

// ─── Singleton composition ────────────────────────────────────────────────────

test('main builds exactly one export store and one catalogue per lane, once at startup', () => {
  for (const symbol of ['createMcpExportStore', 'createExportCatalog', 'createReadCatalog']) {
    assert.equal(
      occurrences(MAIN_SOURCE, symbol),
      2,
      `${symbol}: exactly one import binding plus one construction`,
    );
  }

  assert.match(
    COMPOSITION_BLOCK,
    /\bconst\s+mcpExportStore\s*=\s*createMcpExportStore\(\{\s*exportsRoot:\s*\(\)\s*=>\s*path\.join\(app\.getPath\('userData'\),\s*'MCP Exports'\),\s*\}\)/,
    'store built once at module scope over the protected userData exports root',
  );
  assert.match(COMPOSITION_BLOCK, /\bconst\s+exportCatalog\s*=\s*createExportCatalog\(/);
  assert.match(COMPOSITION_BLOCK, /\bconst\s+exportPreflightCatalog\s*=\s*createReadCatalog\(/);

  const startupIndex = MAIN_SOURCE.indexOf('function startMcpServer()');
  for (const constructionSite of [COMPOSITION_BLOCK]) {
    assert.ok(
      MAIN_SOURCE.indexOf(constructionSite) < startupIndex,
      'composition is built before the MCP server starts',
    );
  }

  // Per-call handler bodies must never rebuild the composition.
  for (const channel of ['project:export', 'project:import']) {
    const handlerStart = MAIN_SOURCE.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(handlerStart !== -1, `${channel} handler exists`);
    assert.equal(
      occurrences(MAIN_SOURCE.slice(handlerStart, handlerStart + 1200), 'createExportCatalog'),
      0,
      `${channel} never constructs the catalogue per call`,
    );
  }
});

test('catalogue bindings: singleton writer, shell reveal, store seams, renderer compute bridges', () => {
  assert.match(
    COMPOSITION_BLOCK,
    /bundleWriter:\s*\(project,\s*destPath\)\s*=>\s*streamingBundleService\.writeProjectBundle\(project,\s*destPath\)/,
    'bundleWriter is bound to the one streaming-bundle service singleton',
  );
  assert.match(
    COMPOSITION_BLOCK,
    /shellReveal:\s*\(p\)\s*=>\s*\{\s*shell\.showItemInFolder\(p\);\s*\}/,
    'reveal goes through shell.showItemInFolder',
  );
  assert.match(COMPOSITION_BLOCK, /filePermissionEnabled:\s*true/);

  const seamBindings = [
    'createExportDirectory: (label) => mcpExportStore.makeDirectory(label)',
    'writeFile: (filePath, content) => mcpExportStore.writeFile(filePath, content)',
    'registerFiles: (id, files) => mcpExportStore.register(id, files)',
    'revealRecord: (id) => mcpExportStore.reveal(id)',
  ];
  for (const binding of seamBindings) {
    assert.ok(COMPOSITION_BLOCK.includes(binding), `store seam bound: ${binding}`);
  }

  const bridgeBindings = [
    "buildTranscriptArtifact: (args) => rendererBridge.buildTranscriptArtifact(args)",
    "resolveProject: (projectId) => rendererBridge.resolveProject(projectId)",
    'exportReadiness: () => rendererBridge.readiness()',
  ];
  for (const binding of bridgeBindings) {
    assert.ok(COMPOSITION_BLOCK.includes(binding), `renderer bridge bound: ${binding}`);
  }

  assert.equal(
    occurrences(MAIN_SOURCE, "streamingBundleService.writeProjectBundle"),
    2,
    'singleton writer used by the UI IPC route and the MCP bundleWriter binding only',
  );
});

// ─── Renderer compute bridges ────────────────────────────────────────────────

test('three request/response renderer bridges mirror the pendingMcpRequests pattern', () => {
  const bridgeChannels = [
    ['mcp:build-transcript-artifact', 'mcp:build-transcript-artifact-response'],
    ['mcp:get-active-project', 'mcp:get-active-project-response'],
    ['mcp:get-export-readiness', 'mcp:get-export-readiness-response'],
  ];
  for (const [eventChannel, replyChannel] of bridgeChannels) {
    assert.equal(
      occurrences(MAIN_SOURCE, `'${replyChannel}'`),
      1,
      `${replyChannel} reply handler registered exactly once in main`,
    );
    assert.equal(
      occurrences(PRELOAD_SOURCE, `ipcRenderer.on('${eventChannel}', handler)`),
      1,
      `preload subscribes to ${eventChannel}`,
    );
    assert.equal(
      occurrences(PRELOAD_SOURCE, `ipcRenderer.invoke('${replyChannel}', payload)`),
      1,
      `preload answers via ${replyChannel}`,
    );
  }

  assert.ok(COMPOSITION_BLOCK.includes('pendingMcpBridgeRequests'), 'bridge round-trips use a pending map');
  assert.ok(
    COMPOSITION_BLOCK.includes('windowManager.getMainWindow()'),
    'requests go to the focused main window',
  );

  // Typed renderer rejection: NO_ACTIVE_PROJECT becomes NOT_FOUND.
  assert.match(
    COMPOSITION_BLOCK,
    /if\s*\(error\.message\.startsWith\('NO_ACTIVE_PROJECT'\)\)\s*\{\s*error\.code\s*=\s*'MCP_NOT_FOUND';/,
  );

  // Types mirror the preload surface.
  for (const api of [
    'onMcpBuildTranscriptArtifact?',
    'mcpBuildTranscriptArtifactResponse?',
    'onMcpGetActiveProject?',
    'mcpGetActiveProjectResponse?',
    'onMcpGetExportReadiness?',
    'mcpGetExportReadinessResponse?',
  ]) {
    assert.ok(TYPES_SOURCE.includes(api), `types.ts declares electronAPI.${api}`);
  }
});

test('renderer implements all three compute handlers over the live session state', () => {
  // Build artifact via the existing review-format builder, NO_ACTIVE_PROJECT when idle.
  assert.ok(APP_SOURCE.includes('onMcpBuildTranscriptArtifact'), 'artifact handler subscribed');
  assert.ok(APP_SOURCE.includes('NO_ACTIVE_PROJECT'), 'idle session raises the typed prefix');
  assert.ok(APP_SOURCE.includes('buildTranscriptArtifact({'), 'handler calls the existing builder');
  assert.ok(APP_SOURCE.includes('options: { targetLang: language }'), 'builder receives target language options');

  // Active project resolves to the current projectId or null.
  assert.ok(APP_SOURCE.includes('onMcpGetActiveProject'), 'active-project handler subscribed');
  assert.ok(APP_SOURCE.includes('result: sessionRef.current?.projectId ?? null'), 'returns projectId | null');

  // Readiness snapshot computed from sessionRef + shortsPlans state.
  assert.ok(APP_SOURCE.includes('onMcpGetExportReadiness'), 'readiness handler subscribed');
  for (const field of [
    'sessionAvailable:',
    'chunkCount:',
    'originalNonEmptyCount:',
    'shortsPlanCount:',
    'sourceVideoPath:',
  ]) {
    assert.ok(APP_SOURCE.includes(field), `readiness snapshot computes ${field}`);
  }
  for (const responder of [
    'mcpBuildTranscriptArtifactResponse?.(',
    'mcpGetActiveProjectResponse?.(',
    'mcpGetExportReadinessResponse?.(',
  ]) {
    assert.ok(APP_SOURCE.includes(responder), `handler answers via ${responder}`);
  }
});

// ─── SSE transport integration ───────────────────────────────────────────────

test('tools/list appends the ten catalog-owned definitions instead of retyping them', () => {
  const serverBody = extractFunctionBody(MAIN_SOURCE, 'startMcpServer');

  assert.ok(serverBody.includes('.concat(MCP_MAIN_TOOL_DEFINITIONS)'), 'catalog definitions appended to tools/list');
  assert.ok(
    COMPOSITION_BLOCK.includes('...exportCatalog.tools,'),
    'the three export definitions are the catalogue objects themselves',
  );
  assert.ok(
    COMPOSITION_BLOCK.includes('MCP_PREFLIGHT_TOOL_NAMES.includes(tool.name)')
      && COMPOSITION_BLOCK.includes('MCP_SHORTS_READ_TOOL_NAMES.includes(tool.name)'),
    'preflight and Shorts definitions are filtered from the read catalogue objects',
  );

  // No definition payload is retyped inside the composition block.
  assert.equal(occurrences(COMPOSITION_BLOCK, 'inputSchema'), 0, 'no inline schema retyping');
  assert.equal(occurrences(COMPOSITION_BLOCK, 'description:'), 0, 'no inline description retyping');

  // The ten names exist exactly once as the Main-dispatch set, sourced from the catalogues.
  const expectedNames = [...EXPORT_TOOL_NAMES, ...PREFLIGHT_TOOL_NAMES, ...SHORTS_READ_TOOL_NAMES];
  assert.equal(expectedNames.length, 10);
  assert.equal(new Set(expectedNames).size, 10, 'ten unique tool names');
  assert.ok(COMPOSITION_BLOCK.includes('...exportCatalog.names'));
  assert.match(COMPOSITION_BLOCK, /Object\.freeze\(\['list_export_options',\s*'validate_export'\]\)/);

  // Reference identity: preflight definitions really are read-catalogue objects.
  for (const name of PREFLIGHT_TOOL_NAMES) {
    const def = READ_TOOL_DEFINITIONS.find((tool) => tool.name === name);
    assert.ok(def, `${name} published by the read catalogue`);
  }
  assert.deepEqual([...EXPORT_TOOL_NAMES], ['export_transcript', 'export_project_bundle', 'reveal_export']);
});

test('tools/call dispatches the ten names through Main ahead of the renderer-forwarding branch', () => {
  const serverBody = extractFunctionBody(MAIN_SOURCE, 'startMcpServer');

  const callIndex = serverBody.indexOf("rpc.method === 'tools/call'");
  const guardIndex = serverBody.indexOf('if (!windowManager.getMainWindow()) {');
  const forwardIndex = serverBody.indexOf(".webContents.send('mcp:call-tool'");
  const dispatchIndex = serverBody.indexOf('dispatchedMcpToolCatalog(name)');
  assert.ok(callIndex !== -1 && guardIndex !== -1 && forwardIndex !== -1 && dispatchIndex !== -1);

  assert.ok(dispatchIndex > callIndex, 'dispatch lives inside the tools/call branch');
  assert.ok(dispatchIndex < guardIndex, 'dispatch runs before the window-active guard');
  assert.ok(guardIndex < forwardIndex, 'legacy guard stays ahead of the forwarding send');

  // The router resolves export, preflight, and Shorts reads through the
  // catalogue-owned name lists.
  assert.match(
    COMPOSITION_BLOCK,
    /function dispatchedMcpToolCatalog\(name\) \{\s*if \(exportCatalog\.names\.includes\(name\)\) return exportCatalog;\s*if \(MCP_PREFLIGHT_TOOL_NAMES\.includes\(name\) \|\| MCP_SHORTS_READ_TOOL_NAMES\.includes\(name\)\) return exportPreflightCatalog;\s*return null;/,
  );
  for (const name of expectedDispatchNames()) {
    assert.ok(expectedDispatchNames().includes(name), `Main dispatch covers ${name}`);
  }
  assert.deepEqual(new Set(expectedDispatchNames()).size, 10, 'exactly ten Main-executed names');
});

function expectedDispatchNames() {
  return [...EXPORT_TOOL_NAMES, ...PREFLIGHT_TOOL_NAMES, ...SHORTS_READ_TOOL_NAMES];
}


test('legacy eight tools keep their exact entries and forwarding path', () => {
  const serverBody = extractFunctionBody(MAIN_SOURCE, 'startMcpServer');
  const listIndex = serverBody.indexOf("rpc.method === 'tools/list'");
  const callIndex = serverBody.indexOf("rpc.method === 'tools/call'");
  const listSection = serverBody.slice(listIndex, callIndex);

  let cursor = 0;
  for (const name of LEGACY_RENDERER_TOOLS) {
    const at = listSection.indexOf(`name: '${name}'`, cursor);
    assert.ok(at !== -1, `legacy tool ${name} still listed`);
    assert.equal(occurrences(listSection, `name: '${name}'`), 1, `legacy tool ${name} listed exactly once`);
    cursor = at;
  }
  assert.equal(occurrences(listSection, 'inputSchema'), 8, 'exactly the eight legacy schemas remain inline');

  assert.ok(
    serverBody.includes("pendingMcpRequests.set(requestId"),
    'legacy forwarding still registers into pendingMcpRequests',
  );
  assert.ok(
    serverBody.includes(".webContents.send('mcp:call-tool', { name, arguments: args, requestId });"),
    'forwarding payload unchanged',
  );

  // The renderer's historical case is unreachable for the Main-owned
  // get_shorts_plans route; the other newly Main-owned names have no case.
  for (const name of expectedDispatchNames().filter((candidate) => candidate !== 'get_shorts_plans')) {
    assert.equal(
      occurrences(APP_SOURCE, `case '${name}':`),
      0,
      `${name} is not handled by the legacy renderer switch`,
    );
  }
});

// ─── Error projection ────────────────────────────────────────────────────────

function buildRpcProjection(stubApp) {
  return evaluateSlice(RPC_PROJECTION_SLICE, stubApp);
}

test('typed failures map onto the deterministic JSON-RPC code table with redaction', () => {
  const stubApp = { getPath: (name) => `/stub/${name}` };
  const { redactKnownRoots, mcpToolRpcError } = buildRpcProjection(stubApp);

  const table = {
    MCP_INVALID_REQUEST: -32602,
    MCP_NOT_FOUND: -32001,
    MCP_PERMISSION_DENIED: -32002,
    MCP_CAPABILITY_UNAVAILABLE: -32003,
  };
  for (const [code, rpcCode] of Object.entries(table)) {
    assert.deepEqual(
      mcpToolRpcError({ code, message: `failure ${code}` }),
      { code: rpcCode, message: `failure ${code}` },
    );
  }
  // ReadCatalogError carries its machine code as .mcpCode only — still mapped.
  assert.deepEqual(
    mcpToolRpcError({ mcpCode: 'MCP_NOT_FOUND', message: 'NO_ACTIVE_PROJECT: No project is open' }),
    { code: -32001, message: 'NO_ACTIVE_PROJECT: No project is open' },
  );

  // Unknown codes collapse to the generic internal failure — never raw text.
  assert.deepEqual(
    mcpToolRpcError(Object.assign(new TypeError('secret /stub/userData/leak'), { code: 'SOMETHING_ELSE' })),
    { code: -32603, message: 'MCP tool call failed.' },
  );
  assert.deepEqual(
    mcpToolRpcError(new TypeError('plain error')),
    { code: -32603, message: 'MCP tool call failed.' },
  );

  // Known-code messages have every known absolute root stripped.
  const redacted = redactKnownRoots('missing /stub/userData/MCP Exports/a-123/file.txt under /stub/home/x');
  assert.equal(redacted, 'missing [path]/MCP Exports/a-123/file.txt under [path]/x');
  assert.ok(!redacted.includes('/stub/userData'));
  assert.ok(!redacted.includes('/stub/home'));
});

// ─── Behavioural: production-shaped wiring against the real modules ─────────

function makeProductionShapedWiring(rootDir) {
  const revealed = [];
  const builderCalls = [];
  const bundleCalls = [];
  const store = createMcpExportStore({ exportsRoot: () => rootDir });

  const catalog = createExportCatalog({
    filePermissionEnabled: true,
    createExportDirectory: (label) => store.makeDirectory(label),
    writeFile: (filePath, content) => store.writeFile(filePath, content),
    registerFiles: (id, files) => store.register(id, files),
    revealRecord: (id) => store.reveal(id),
    shellReveal: (p) => { revealed.push(p); },
    buildTranscriptArtifact: async (args) => {
      builderCalls.push(args);
      if (!wiring.project) throw new Error('NO_ACTIVE_PROJECT: Open a project before exporting a transcript.');
      return wiring.artifact;
    },
    resolveProject: async (projectId) => {
      if (projectId !== undefined && projectId !== null && projectId !== wiring.project.id) return null;
      return wiring.project;
    },
    bundleWriter: async (project, destPath) => {
      bundleCalls.push({ project, destPath });
      await store.writeFile(destPath, JSON.stringify(project));
    },
  });

  const wiring = {
    store,
    catalog,
    revealed,
    builderCalls,
    bundleCalls,
    artifact: { content: 'hello transcript', fileName: '/absent/dir/transcript.txt' },
    project: { id: 'vs-1', name: 'Проект/тест', session: {} },
  };
  return wiring;
}

test('production-shaped export flows project file names and sizes, never absolute paths', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-mcp-exports-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const wiring = makeProductionShapedWiring(rootDir);

  const result = await wiring.catalog.execute('export_transcript', { side: 'original', format: 'txt' });
  assert.deepEqual(result.files.map((file) => file.fileName), ['transcript.txt']);
  assert.ok(Number.isFinite(result.files[0].sizeBytes) && result.files[0].sizeBytes > 0);
  assert.ok(!JSON.stringify(result).includes(rootDir), 'no exports-root path leaks in projections');

  const bundleResult = await wiring.catalog.execute('export_project_bundle', {});
  assert.equal(bundleResult.fileCount, 1);
  assert.match(bundleResult.files[0].fileName, /^Проект-тест\.vaniscript$/);

  // Reveal answers for the registered exports only, and reveals the stored file.
  const reveal = await wiring.catalog.execute('reveal_export', { exportId: result.exportId });
  assert.deepEqual(reveal, { success: true, exportId: result.exportId, fileName: 'transcript.txt' });
  assert.equal(wiring.revealed.length, 1);
  assert.ok(wiring.revealed[0].startsWith(rootDir), 'shell reveal receives the internal absolute path');

  await assert.rejects(
    () => wiring.catalog.execute('reveal_export', { exportId: 'missing' }),
    (error) => error instanceof ExportCatalogError && error.code === 'MCP_NOT_FOUND',
  );

  // Builder errors propagate verbatim once mapped across the bridge boundary.
  wiring.project = null;
  await assert.rejects(
    () => wiring.catalog.execute('export_transcript', { side: 'original', format: 'txt' }),
    (error) => error.message.startsWith('NO_ACTIVE_PROJECT'),
  );
  await assert.rejects(
    () => wiring.catalog.execute('export_project_bundle', {}),
    (error) => error instanceof ExportCatalogError && error.code === 'MCP_NOT_FOUND',
  );
});

test('preflight reads execute through the readiness-injected read catalogue', async () => {
  let snapshot = {
    sessionAvailable: true,
    chunkCount: 3,
    originalNonEmptyCount: 2,
    shortsPlanCount: 1,
    sourceVideoPath: '/media/source.mp4',
  };
  const catalog = createReadCatalog({ exportReadiness: async () => snapshot });

  const options = await catalog.execute('list_export_options', {});
  assert.equal(options.data.transcript.available, true);
  assert.deepEqual(options.data.transcript.formats, ['txt', 'markdown', 'srt', 'vtt']);
  assert.equal(options.data.shortsVideos.available, true);
  assert.ok(!JSON.stringify(options).includes('/media/source.mp4'), 'projections stay path-free');

  const validation = await catalog.execute('validate_export', { kind: 'transcript' });
  assert.equal(validation.data.valid, true);

  snapshot = { sessionAvailable: false, chunkCount: 0, originalNonEmptyCount: 0, shortsPlanCount: 0, sourceVideoPath: null };
  await assert.rejects(
    () => catalog.execute('validate_export', { kind: 'transcript' }),
    (error) => error instanceof ReadCatalogError
      && error.mcpCode === 'MCP_NOT_FOUND'
      && error.message.startsWith('NO_ACTIVE_PROJECT'),
  );
});

test('every typed catalogue failure code has a row in the pinned RPC table', async () => {
  const tableSource = sliceBetween(MAIN_SOURCE, 'const MCP_EXPORT_RPC_CODES', 'function redactKnownRoots');
  const pinnedCodes = new Set();
  for (const match of tableSource.matchAll(/(MCP_[A-Z_]+):\s*(-?\d+)/g)) {
    pinnedCodes.add(match[1]);
    assert.ok([-32602, -32001, -32002, -32003].includes(Number(match[2])), `${match[1]} maps deterministically`);
  }
  assert.deepEqual(
    [...pinnedCodes].sort(),
    ['MCP_CAPABILITY_UNAVAILABLE', 'MCP_INVALID_REQUEST', 'MCP_NOT_FOUND', 'MCP_PERMISSION_DENIED'],
  );

  const failing = createExportCatalog({});
  for (const [name, args] of [['reveal_export', { exportId: '' }]]) {
    await assert.rejects(
      () => failing.execute(name, args),
      (error) => {
        const emittedCode = error.mcpCode || error.code;
        assert.ok(pinnedCodes.has(emittedCode), `${emittedCode} emitted by the catalogue is table-covered`);
        return true;
      },
    );
  }

  const unavailable = createReadCatalog({});
  await assert.rejects(
    () => unavailable.execute('list_export_options', {}),
    (error) => {
      const emittedCode = error.mcpCode || error.code;
      assert.ok(pinnedCodes.has(emittedCode), `${emittedCode} emitted by the read catalogue is table-covered`);
      return true;
    },
  );
});

function startProductionSseHarness(mainCatalog) {
  let actualServer = null;
  const requireSeam = (specifier) => {
    if (specifier === 'http') {
      return {
        createServer(handler) {
          actualServer = http.createServer(handler);
          const listen = actualServer.listen.bind(actualServer);
          actualServer.listen = (_productionPort, host, callback) => listen(0, host, callback);
          return actualServer;
        },
      };
    }
    if (specifier === 'url') return require('node:url');
    throw new Error(`Unexpected production transport dependency: ${specifier}`);
  };
  const authHelpers = sliceBetween(
    MAIN_SOURCE,
    'function isMcpAuthorized',
    'function startMcpServer',
  );
  const startBody = extractFunctionBody(MAIN_SOURCE, 'startMcpServer');
  const buildHarness = new Function(
    'require',
    'crypto',
    'log',
    'MCP_MAIN_TOOL_DEFINITIONS',
    'dispatchedMcpToolCatalog',
    'mcpToolRpcError',
    'windowManager',
    `"use strict";
let mcpHttpServer = null;
const activeSseConnections = new Map();
const pendingMcpRequests = new Map();
let mcpAccessToken = '';
${authHelpers}
function startMcpServer() {
${startBody}
}
startMcpServer();
return {
  get server() { return mcpHttpServer; },
  get token() { return mcpAccessToken; },
};`,
  );
  const harness = buildHarness(
    requireSeam,
    crypto,
    { info() {}, error() {} },
    EXPORT_TOOL_DEFINITIONS,
    (name) => EXPORT_TOOL_NAMES.includes(name) ? mainCatalog : null,
    (error) => ({ code: -32603, message: error.message || String(error) }),
    { getMainWindow: () => null },
  );
  assert.equal(harness.server, actualServer, 'the exact production handler owns the loopback server');
  return harness;
}

function makeSseEventReader(response) {
  let buffer = '';
  const queued = [];
  const waiters = [];

  function publish(event) {
    const waiterIndex = waiters.findIndex((waiter) => !waiter.name || waiter.name === event.name);
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(event);
      return;
    }
    queued.push(event);
  }

  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split('\n');
      const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      publish({ name, data });
      boundary = buffer.indexOf('\n\n');
    }
  });

  return {
    next(name) {
      const queuedIndex = queued.findIndex((event) => !name || event.name === name);
      if (queuedIndex !== -1) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      }
      return new Promise((resolve) => waiters.push({ name, resolve }));
    },
  };
}

async function connectProductionSse(server, token) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/sse',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    request.on('error', reject);
    request.on('response', async (response) => {
      try {
        assert.equal(response.statusCode, 200);
        const events = makeSseEventReader(response);
        const endpoint = await events.next('endpoint');
        resolve({ response, events, endpoint: endpoint.data, port: address.port });
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.end();
  });
}

function postProductionRpc(client, token, rpc) {
  const body = JSON.stringify(rpc);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: client.port,
      path: client.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function callProductionTool(client, token, id, name, args) {
  const responseEvent = client.events.next('message');
  const status = await postProductionRpc(client, token, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.equal(status, 202);
  const response = JSON.parse((await responseEvent).data);
  assert.equal(response.id, id);
  assert.equal(response.error, undefined);
  return {
    rpc: response,
    result: JSON.parse(response.result.content[0].text),
  };
}

test('production SSE exports the active French transcript only inside userData/MCP Exports', async (t) => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-p3e-d3-profile-'));
  t.after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));
  const userData = path.join(profileRoot, 'UserData');
  const exportsRoot = path.join(userData, 'MCP Exports');
  const revealed = [];
  const store = createMcpExportStore({ exportsRoot: () => exportsRoot });
  const session = {
    sourceFileName: 'Lec\u0327on.wav',
    activeTranslationLanguage: 'French',
    targetLang: 'Russian',
    chunks: [{
      index: 0,
      startSec: 0,
      endSec: 1,
      original: 'First line',
      translated: 'Première ligne',
      translationsByLanguage: {
        french: { language: 'French', text: 'Première ligne' },
        russian: { language: 'Russian', text: 'Первая строка' },
      },
    }],
  };
  const formats = { txt: 'TXT', markdown: 'Markdown', srt: 'SRT', vtt: 'VTT' };
  const catalog = createExportCatalog({
    filePermissionEnabled: true,
    createExportDirectory: (label) => store.makeDirectory(label),
    writeFile: (filePath, content) => store.writeFile(filePath, content),
    registerFiles: (id, files) => store.register(id, files),
    revealRecord: (id) => store.reveal(id),
    shellReveal: (filePath) => { revealed.push(filePath); },
    buildTranscriptArtifact: async (args) => {
      const which = args.side === 'original' ? 'original' : 'translated';
      const language = which === 'translated'
        ? (args.language || session.activeTranslationLanguage || session.targetLang)
        : undefined;
      return buildTranscriptArtifact({
        which,
        format: formats[args.format],
        chunks: session.chunks,
        sourceFileName: session.sourceFileName,
        translationLanguage: language,
        options: { targetLang: language },
      });
    },
  });
  const harness = startProductionSseHarness(catalog);
  await new Promise((resolve, reject) => {
    if (harness.server.listening) {
      resolve();
      return;
    }
    harness.server.once('listening', resolve);
    harness.server.once('error', reject);
  });
  const client = await connectProductionSse(harness.server, harness.token);
  t.after(async () => {
    client.response.destroy();
    await new Promise((resolve) => harness.server.close(resolve));
  });

  const exported = await callProductionTool(
    client,
    harness.token,
    'export-fr',
    'export_transcript',
    { side: 'translated', format: 'txt' },
  );
  assert.equal(exported.result.files[0].fileName, 'Leçon_French.txt');
  assert.ok(!exported.result.files[0].fileName.includes('Russian'));
  assert.ok(!JSON.stringify(exported.rpc).includes(profileRoot), 'SSE response never exposes an absolute path');
  assert.deepEqual(fs.readdirSync(userData), ['MCP Exports'], 'profile receives no export outside the protected root');
  const exportDirectories = fs.readdirSync(exportsRoot);
  assert.equal(exportDirectories.length, 1);
  const artifactPath = path.join(exportsRoot, exportDirectories[0], 'Leçon_French.txt');
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'Première ligne');

  const revealedResult = await callProductionTool(
    client,
    harness.token,
    'reveal-fr',
    'reveal_export',
    { exportId: exported.result.exportId },
  );
  assert.deepEqual(revealedResult.result, {
    success: true,
    exportId: exported.result.exportId,
    fileName: 'Leçon_French.txt',
  });
  assert.deepEqual(revealed, [artifactPath]);
  assert.ok(!JSON.stringify(revealedResult.rpc).includes(profileRoot), 'reveal response also stays path-free');
});

test('renderer download revokes every transcript Blob URL, including failed clicks', () => {
  const typescript = require('typescript');
  const downloadSource = sliceBetween(
    APP_SOURCE,
    '  const download = ',
    '\n\n  const updateShortsSettings',
  );
  const executable = typescript.transpileModule(downloadSource, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.None,
    },
  }).outputText;

  function makeDownload(failClick) {
    const calls = [];
    const body = {
      appendChild(anchor) {
        calls.push('append');
        anchor.parentNode = body;
      },
      removeChild(anchor) {
        calls.push('remove');
        anchor.parentNode = null;
      },
    };
    const anchor = {
      parentNode: null,
      click() {
        calls.push('click');
        if (failClick) throw new Error('injected click failure');
      },
    };
    class BlobStub {
      constructor(parts, options) {
        calls.push(['blob', parts, options]);
      }
    }
    const urlStub = {
      createObjectURL() {
        calls.push('create-url');
        return 'blob:transcript';
      },
      revokeObjectURL(url) {
        calls.push(['revoke', url]);
      },
    };
    const documentStub = {
      body,
      createElement(tag) {
        assert.equal(tag, 'a');
        return anchor;
      },
    };
    const download = new Function(
      'Blob',
      'URL',
      'document',
      `"use strict";\n${executable}\nreturn download;`,
    )(BlobStub, urlStub, documentStub);
    return { download, calls, anchor };
  }

  const success = makeDownload(false);
  success.download('Première ligne', 'Leçon_French.txt');
  assert.deepEqual(success.calls, [
    ['blob', ['Première ligne'], { type: 'text/plain;charset=utf-8' }],
    'create-url',
    'append',
    'click',
    'remove',
    ['revoke', 'blob:transcript'],
  ]);
  assert.equal(success.anchor.parentNode, null);

  const failure = makeDownload(true);
  assert.throws(
    () => failure.download('Première ligne', 'Leçon_French.txt'),
    /injected click failure/,
  );
  assert.deepEqual(failure.calls.slice(-2), [
    'remove',
    ['revoke', 'blob:transcript'],
  ]);
  assert.equal(failure.anchor.parentNode, null);
});
