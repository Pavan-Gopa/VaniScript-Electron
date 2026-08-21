const test = require('node:test');
const assert = require('node:assert/strict');

const loadStore = () => import('../src/stores/navigationStore.js');

test('navigation routes are a frozen constant map', async () => {
  const { NAVIGATION_ROUTES } = await loadStore();
  assert.equal(NAVIGATION_ROUTES.HOME, 'home');
  assert.equal(NAVIGATION_ROUTES.PROJECT, 'project');
  assert.equal(NAVIGATION_ROUTES.BATCH, 'batch');
  assert.equal(NAVIGATION_ROUTES.SETTINGS, 'settings');
  assert.ok(Object.isFrozen(NAVIGATION_ROUTES));
});

test('valid routes contain exactly the four known routes', async () => {
  const { VALID_ROUTES } = await loadStore();
  assert.deepEqual(
    VALID_ROUTES.slice().sort(),
    ['batch', 'home', 'project', 'settings'].sort()
  );
  assert.ok(Object.isFrozen(VALID_ROUTES));
});
test('navigation store initializes at the home route', async () => {
  const { navigationStore } = await loadStore();
  navigationStore.reset();
  assert.equal(navigationStore.route, 'home');
});

test('navigate moves to a valid route and returns true', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  const changed = navigationStore.navigate(NAVIGATION_ROUTES.PROJECT);
  assert.equal(changed, true);
  assert.equal(navigationStore.route, NAVIGATION_ROUTES.PROJECT);
});

test('navigate to the current route is a no-op returning false', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  navigationStore.navigate(NAVIGATION_ROUTES.PROJECT);
  const changed = navigationStore.navigate(NAVIGATION_ROUTES.PROJECT);
  assert.equal(changed, false);
  assert.equal(navigationStore.route, NAVIGATION_ROUTES.PROJECT);
});

test('navigate to an invalid route throws', async () => {
  const { navigationStore } = await loadStore();
  assert.throws(() => navigationStore.navigate('unknown-route'), /Invalid navigation route/);
});

test('back returns to the previous route', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  navigationStore.navigate(NAVIGATION_ROUTES.PROJECT);
  navigationStore.navigate(NAVIGATION_ROUTES.SETTINGS);
  const wentBack = navigationStore.back();
  assert.equal(wentBack, true);
  assert.equal(navigationStore.route, NAVIGATION_ROUTES.PROJECT);
});

test('back returns false when history is empty', async () => {
  const { createNavigationStore } = await loadStore();
  const store = createNavigationStore();
  assert.equal(store.back(), false);
});

test('canNavigate reports valid, non-current routes', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  assert.equal(navigationStore.canNavigate(NAVIGATION_ROUTES.PROJECT), true);
  assert.equal(navigationStore.canNavigate(NAVIGATION_ROUTES.HOME), false);
  assert.equal(navigationStore.canNavigate('bad'), false);
});

test('reset clears history and returns to home by default', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  navigationStore.navigate(NAVIGATION_ROUTES.PROJECT);
  navigationStore.navigate(NAVIGATION_ROUTES.BATCH);
  navigationStore.reset();
  const state = navigationStore.getState();
  assert.equal(state.route, NAVIGATION_ROUTES.HOME);
  assert.deepEqual(state.history, []);
});

test('createNavigationStore accepts an explicit initial route', async () => {
  const { createNavigationStore, NAVIGATION_ROUTES } = await loadStore();
  const store = createNavigationStore(NAVIGATION_ROUTES.SETTINGS);
  assert.equal(store.route, NAVIGATION_ROUTES.SETTINGS);
});

test('createNavigationStore throws on an invalid initial route', async () => {
  const { createNavigationStore } = await loadStore();
  assert.throws(() => createNavigationStore('nope'), /Invalid initial navigation route/);
});

test('createNavigationStore produces independent stores', async () => {
  const { createNavigationStore, NAVIGATION_ROUTES } = await loadStore();
  const a = createNavigationStore();
  const b = createNavigationStore();
  a.navigate(NAVIGATION_ROUTES.PROJECT);
  assert.equal(a.route, NAVIGATION_ROUTES.PROJECT);
  assert.equal(b.route, NAVIGATION_ROUTES.HOME);
});

test('subscribe fires when the route changes and stops after unsubscribe', async () => {
  const { navigationStore, NAVIGATION_ROUTES } = await loadStore();
  navigationStore.reset();
  let calls = 0;
  const unsubscribe = navigationStore.subscribe(() => {
    calls += 1;
  });
  navigationStore.navigate(NAVIGATION_ROUTES.BATCH);
  assert.equal(calls, 1);
  unsubscribe();
  navigationStore.navigate(NAVIGATION_ROUTES.SETTINGS);
  assert.equal(calls, 1);
});
