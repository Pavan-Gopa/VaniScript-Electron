const test = require('node:test');
const assert = require('node:assert/strict');

const loadStore = () => import('../src/stores/paneStore.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('view modes are a frozen constant map', async () => {
  const { VIEW_MODES } = await loadStore();
  assert.equal(VIEW_MODES.SOURCE, 'source');
  assert.equal(VIEW_MODES.TRANSLATED, 'translated');
  assert.equal(VIEW_MODES.DUAL, 'dual');
  assert.ok(Object.isFrozen(VIEW_MODES));
});

test('pane store initializes with default layout state', async () => {
  const { paneStore } = await loadStore();
  const state = paneStore.getState();
  assert.equal(state.showChatSidebar, false);
  assert.equal(state.projectSidebarOpen, false);
  assert.equal(state.projectSidebarClosing, false);
  assert.equal(state.viewMode, 'dual');
});

test('createPaneStore accepts explicit initial state', async () => {
  const { createPaneStore } = await loadStore();
  const store = createPaneStore({
    showChatSidebar: true,
    projectSidebarOpen: true,
    projectSidebarClosing: true,
    viewMode: 'source',
  });
  const state = store.getState();
  assert.equal(state.showChatSidebar, true);
  assert.equal(state.projectSidebarOpen, true);
  assert.equal(state.projectSidebarClosing, true);
  assert.equal(state.viewMode, 'source');
});

test('createPaneStore throws on an invalid initial view mode', async () => {
  const { createPaneStore } = await loadStore();
  assert.throws(() => createPaneStore({ viewMode: 'sideways' }), /Invalid initial view mode/);
});

test('setChatSidebar toggles and reflects in state', async () => {
  const { paneStore } = await loadStore();
  assert.equal(paneStore.setChatSidebar(true), true);
  assert.equal(paneStore.getState().showChatSidebar, true);
  assert.equal(paneStore.setChatSidebar(true), false);
  assert.equal(paneStore.setChatSidebar(false), true);
  assert.equal(paneStore.getState().showChatSidebar, false);
});

test('toggleChatSidebar flips the chat sidebar', async () => {
  const { paneStore } = await loadStore();
  const before = paneStore.getState().showChatSidebar;
  assert.equal(paneStore.toggleChatSidebar(), !before);
  assert.notEqual(paneStore.getState().showChatSidebar, before);
});

test('setViewMode switches mode and validates input', async () => {
  const { paneStore } = await loadStore();
  assert.equal(paneStore.setViewMode('source'), true);
  assert.equal(paneStore.getState().viewMode, 'source');
  assert.equal(paneStore.setViewMode('source'), false);
  assert.equal(paneStore.setViewMode('translated'), true);
  assert.equal(paneStore.getState().viewMode, 'translated');
  assert.throws(() => paneStore.setViewMode('sideways'), /Invalid view mode/);
});

test('openProjectSidebar opens without closing flag', async () => {
  const { paneStore } = await loadStore();
  assert.equal(paneStore.openProjectSidebar(), true);
  const state = paneStore.getState();
  assert.equal(state.projectSidebarOpen, true);
  assert.equal(state.projectSidebarClosing, false);
});

test('closeProjectSidebar marks closing then fully closes after the delay', async () => {
  const { paneStore } = await loadStore();
  paneStore.openProjectSidebar();
  assert.equal(paneStore.closeProjectSidebar(5), true);
  // Immediately after close the panel is still mounted but animating out.
  let state = paneStore.getState();
  assert.equal(state.projectSidebarOpen, true);
  assert.equal(state.projectSidebarClosing, true);
  await wait(20);
  state = paneStore.getState();
  assert.equal(state.projectSidebarOpen, false);
  assert.equal(state.projectSidebarClosing, false);
});

test('openProjectSidebar cancels a pending close animation', async () => {
  const { paneStore } = await loadStore();
  paneStore.openProjectSidebar();
  paneStore.closeProjectSidebar(50);
  // Re-open before the close timer fires. This must cancel the timer.
  assert.equal(paneStore.openProjectSidebar(), true);
  const mid = paneStore.getState();
  assert.equal(mid.projectSidebarOpen, true);
  assert.equal(mid.projectSidebarClosing, false);
  await wait(80);
  // Because the timer was cancelled, the panel stays open.
  const after = paneStore.getState();
  assert.equal(after.projectSidebarOpen, true);
  assert.equal(after.projectSidebarClosing, false);
});

test('closeProjectSidebar rejects an invalid delay', async () => {
  const { paneStore } = await loadStore();
  assert.throws(() => paneStore.closeProjectSidebar(-1), /non-negative number/);
  assert.throws(() => paneStore.closeProjectSidebar('fast'), /non-negative number/);
});

test('createPaneStore produces independent stores', async () => {
  const { createPaneStore } = await loadStore();
  const a = createPaneStore();
  const b = createPaneStore();
  a.setChatSidebar(true);
  assert.equal(a.getState().showChatSidebar, true);
  assert.equal(b.getState().showChatSidebar, false);
});

test('subscribe fires on change and stops after unsubscribe', async () => {
  const { paneStore } = await loadStore();
  // Force a known starting state so this assertion is deterministic and not
  // affected by mutations left on the shared singleton by earlier tests.
  paneStore.setChatSidebar(false);
  paneStore.setViewMode('dual');
  let calls = 0;
  const unsubscribe = paneStore.subscribe(() => {
    calls += 1;
  });
  paneStore.setChatSidebar(true);
  paneStore.setViewMode('source');
  assert.equal(calls, 2);
  unsubscribe();
  paneStore.setChatSidebar(false);
  assert.equal(calls, 2);
});
