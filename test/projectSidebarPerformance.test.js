'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ReactDOMClient = require('react-dom/client');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const { ProjectSidebar } = require('../src/components/ProjectSidebar.tsx');
const { getChunkRowWindow, getVariableVirtualWindow, includeIndexInVirtualWindow } = require('../src/lib/virtual-window.ts');
const { createProjectSummaries } = require('./fixtures/p4d3-fixtures.js');

function sidebarProps(overrides = {}) {
  return {
    projects: createProjectSummaries(100),
    expandedProjectId: 'project-0000',
    activeProjectId: 'project-0000',
    total: 100,
    onClose() {},
    onImport() {},
    onExportAll() {},
    onToggleProject() {},
    onDeleteProject() {},
    onExportProject() {},
    onOpenProjectChunk() {},
    onOpenProjectExport() {},
    onClearArchive() {},
    onOpenMediaInfo() {},
    ...overrides,
  };
}

function renderSidebar(overrides = {}) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSidebar, sidebarProps(overrides)));
}

test('100-project/500-chunk sidebar keeps outer and inner DOM windows bounded', () => {
  const markup = renderSidebar();
  const outerRoots = (markup.match(/class="project-item-slot/g) || []).length;
  const chunkButtons = (markup.match(/class="project-chunk-btn/g) || []).length;
  assert.ok(outerRoots <= 32, `outer project roots must stay <=32, got ${outerRoots}`);
  assert.ok(chunkButtons <= 56, `expanded chunk buttons must stay <=56, got ${chunkButtons}`);
  assert.equal(markup.includes('projectChunkNumbers'), false);
  assert.match(markup, /aria-setsize="100"/);
  assert.match(markup, /aria-posinset="1"/);
  assert.match(markup, /aria-label="Chunk 1/);
  assert.match(markup, /aria-expanded="true"/);
});

test('active project outside the scroll window is materialized without widening the range', () => {
  const markup = renderSidebar({ activeProjectId: 'project-0099', expandedProjectId: null });
  const outerRoots = (markup.match(/class="project-item-slot/g) || []).length;
  assert.ok(outerRoots <= 32);
  assert.match(markup, /aria-posinset="100"/);
});

test('scrolled chunk viewport uses absolute rows and keeps Home/End/Arrow focus reachable', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ProjectSidebar.tsx'), 'utf8');
  assert.match(source, /includeIndexInVirtualWindow\(rawChunkWindow, focusRow\)/);
  assert.match(source, /top: Math\.floor\(chunkIndex \/ 2\) \* CHUNK_ROW_HEIGHT/);
  assert.equal(source.includes('Math.floor(localIndex / 2) * CHUNK_ROW_HEIGHT'), false);

  const scrolled = getChunkRowWindow(500, 720, 224, 36, 4);
  assert.equal(scrolled.start, 16);
  assert.equal(scrolled.end, 31);
  const visibleRows = includeIndexInVirtualWindow(scrolled, 20);
  assert.equal(visibleRows.start, 16);
  assert.equal(visibleRows.end, 31);
  const rowTops = Array.from({ length: (visibleRows.end - visibleRows.start) * 2 }, (_, index) => (
    Math.floor((visibleRows.start * 2 + index) / 2) * 36
  ));
  assert.equal(rowTops[0], 576);
  assert.ok(rowTops.every((top) => top >= 576));

  const endRows = includeIndexInVirtualWindow(scrolled, Math.floor(499 / 2));
  assert.equal(endRows.end, 250);
  assert.ok(endRows.start <= 249);
  const arrowRows = includeIndexInVirtualWindow(endRows, Math.floor(498 / 2));
  assert.ok(arrowRows.start <= 249 && arrowRows.end > 249);
  const homeRows = includeIndexInVirtualWindow(arrowRows, 0);
  assert.equal(homeRows.start, 0);
  assert.ok(homeRows.end > 0);

  const variable = getVariableVirtualWindow(100_000, 50, 0, 600, 96, 430, 10, 2);
  assert.equal('offsets' in variable, false);
  assert.equal(variable.offsetAt(51), 51 * 106 + (440 - 106));
});

test('locked-tail End keeps the roving tab stop on an enabled chunk', async () => {
  const project = {
    ...createProjectSummaries(1)[0],
    id: 'locked-tail',
    currentIndex: 498,
    totalChunks: 500,
    approvedChunks: 0,
  };
  const dom = new JSDOM('<!doctype html><main id="fixture"></main>', { url: 'http://localhost' });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
  try {
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const root = ReactDOMClient.createRoot(dom.window.document.querySelector('#fixture'));
    let opened = 0;
    await React.act(async () => {
      root.render(React.createElement(ProjectSidebar, sidebarProps({
        projects: [project],
        expandedProjectId: project.id,
        activeProjectId: project.id,
        total: 1,
        onOpenProjectChunk() {
          opened += 1;
        },
      })));
    });

    const buttons = () => Array.from(dom.window.document.querySelectorAll('.project-chunk-btn'));
    const current = buttons().find((button) => button.getAttribute('aria-posinset') === '499');
    const lockedTail = buttons().find((button) => button.getAttribute('aria-posinset') === '500');
    assert.ok(current, 'current chunk must be materialized');
    assert.ok(lockedTail, 'locked tail chunk must be materialized');
    assert.equal(current.disabled, false);
    assert.equal(current.tabIndex, 0);
    assert.equal(lockedTail.disabled, true);
    await React.act(async () => {
      current.focus();
    });

    await React.act(async () => {
      current.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
        cancelable: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const enabledTabStops = buttons().filter((button) => !button.disabled && button.tabIndex === 0);
    assert.equal(enabledTabStops.length, 1, 'End must leave one enabled roving tab stop');
    assert.equal(enabledTabStops[0].getAttribute('aria-posinset'), '499');
    assert.equal(lockedTail.tabIndex, -1);
    assert.equal(dom.window.document.activeElement, enabledTabStops[0], 'focus must remain on the enabled chunk');
    assert.equal(opened, 0, 'keyboard navigation must not open a locked chunk');

    await React.act(async () => {
      root.unmount();
    });
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousActEnvironment === undefined) delete global.IS_REACT_ACT_ENVIRONMENT;
    else global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
