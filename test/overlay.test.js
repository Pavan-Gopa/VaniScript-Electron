const test = require('node:test');
const assert = require('node:assert/strict');

const loadStore = () => import('../src/stores/overlayStore.js');

test('overlay store starts with no active overlays', async () => {
  const { overlayStore } = await loadStore();
  assert.deepEqual(overlayStore.getActive(), []);
  assert.equal(overlayStore.getState().openCount, 0);
  assert.equal(overlayStore.isOpen('modal'), false);
});

test('open adds an overlay and close removes it', async () => {
  const { overlayStore } = await loadStore();
  const opened = overlayStore.open('modal', { title: 'Hi' });
  assert.equal(opened, true);
  assert.equal(overlayStore.isOpen('modal'), true);
  const closed = overlayStore.close('modal');
  assert.equal(closed, true);
  assert.equal(overlayStore.isOpen('modal'), false);
});

test('open rejects an empty id and non-object props', async () => {
  const { overlayStore } = await loadStore();
  assert.throws(() => overlayStore.open(''), /non-empty string/);
  assert.throws(() => overlayStore.open('modal', 'bad'), /plain object/);
});

test('getActive returns the current open overlay ids', async () => {
  const { overlayStore } = await loadStore();
  overlayStore.open('a', {});
  overlayStore.open('b', {});
  assert.deepEqual(overlayStore.getActive().slice().sort(), ['a', 'b']);
  overlayStore.close('a');
  assert.deepEqual(overlayStore.getActive(), ['b']);
});

test('toggle opens then closes an overlay', async () => {
  const { overlayStore } = await loadStore();
  assert.equal(overlayStore.toggle('pop'), true);
  assert.equal(overlayStore.isOpen('pop'), true);
  assert.equal(overlayStore.toggle('pop'), false);
  assert.equal(overlayStore.isOpen('pop'), false);
});

test('closeAll clears every overlay', async () => {
  const { overlayStore } = await loadStore();
  overlayStore.open('a', {});
  overlayStore.open('b', {});
  assert.equal(overlayStore.closeAll(), true);
  assert.deepEqual(overlayStore.getActive(), []);
  assert.equal(overlayStore.getState().openCount, 0);
});

test('createOverlayStore returns a fresh independent store', async () => {
  const { createOverlayStore } = await loadStore();
  const a = createOverlayStore();
  const b = createOverlayStore();
  a.open('x', {});
  assert.equal(a.isOpen('x'), true);
  assert.equal(b.isOpen('x'), false);
});

test('subscribe fires on open and close and stops after unsubscribe', async () => {
  const { overlayStore } = await loadStore();
  let calls = 0;
  const unsubscribe = overlayStore.subscribe(() => {
    calls += 1;
  });
  overlayStore.open('modal', {});
  overlayStore.close('modal');
  assert.equal(calls, 2);
  unsubscribe();
  overlayStore.open('modal2', {});
  assert.equal(calls, 2);
});
