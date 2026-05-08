import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canOpenSidebarChunk,
  clampChunkIndex,
  isProjectExportReady,
  projectChunkNumbers,
} from './project-navigation';

test('projectChunkNumbers returns one-based chunk labels for the sidebar', () => {
  assert.deepEqual(projectChunkNumbers(3), [1, 2, 3]);
  assert.deepEqual(projectChunkNumbers(0), []);
});

test('clampChunkIndex keeps sidebar chunk navigation inside project bounds', () => {
  assert.equal(clampChunkIndex(2, 4), 2);
  assert.equal(clampChunkIndex(-1, 4), 0);
  assert.equal(clampChunkIndex(99, 4), 3);
  assert.equal(clampChunkIndex(3, 0), 0);
});

test('canOpenSidebarChunk allows only chunks the user has already reached', () => {
  assert.equal(canOpenSidebarChunk(0, 1, 4), true);
  assert.equal(canOpenSidebarChunk(1, 1, 4), true);
  assert.equal(canOpenSidebarChunk(2, 1, 4), false);
  assert.equal(canOpenSidebarChunk(3, 1, 4), false);
  assert.equal(canOpenSidebarChunk(4, 1, 4), false);
});

test('isProjectExportReady requires every chunk to be approved', () => {
  assert.equal(isProjectExportReady(3, 3), true);
  assert.equal(isProjectExportReady(3, 2), false);
  assert.equal(isProjectExportReady(0, 0), false);
});
