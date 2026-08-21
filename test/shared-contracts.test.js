// FND-01 — Runtime validation tests for the shared contracts (errors + IPC).
//
// These contracts are authored in TypeScript under `shared/contracts/`. Node
// 26's built-in type stripping lets this CommonJS test import the `.ts`
// modules directly, so we exercise the real runtime behavior (not a copy).
const test = require('node:test');
const assert = require('node:assert/strict');

const REQUIRED_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_UNAVAILABLE',
  'SOURCE_CHANGED',
  'OUTPUT_COLLISION',
  'UPDATE_BLOCKED',
  'CORRUPT_DATA',
  'INTERNAL',
];

test('ERROR_CODES is the canonical set from migration plan §4.3', async () => {
  const { ERROR_CODES } = await import('../shared/contracts/errors.ts');
  assert.deepEqual([...ERROR_CODES].sort(), [...REQUIRED_CODES].sort());
  assert.equal(ERROR_CODES.length, REQUIRED_CODES.length);
});

test('isErrorCode accepts only known codes', async () => {
  const { isErrorCode } = await import('../shared/contracts/errors.ts');
  assert.equal(isErrorCode('NOT_FOUND'), true);
  assert.equal(isErrorCode('internal'), false);
  assert.equal(isErrorCode('BOGUS'), false);
  assert.equal(isErrorCode(42), false);
});

test('AppError carries code/message and behaves like Error', async () => {
  const { AppError } = await import('../shared/contracts/errors.ts');
  const err = new AppError('CONFLICT', 'revision mismatch', { expected: 'a', actual: 'b' });
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.message, 'revision mismatch');
  assert.deepEqual(err.details, { expected: 'a', actual: 'b' });
  assert.equal(err.name, 'AppError');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof AppError);
  assert.equal(typeof err.stack, 'string');
});

test('AppError.toJSON is a clean serializable projection', async () => {
  const { AppError, createAppError } = await import('../shared/contracts/errors.ts');
  const withDetails = createAppError('INTERNAL', 'boom', { step: 3 });
  assert.deepEqual(withDetails.toJSON(), { code: 'INTERNAL', message: 'boom', details: { step: 3 } });
  const withoutDetails = new AppError('CANCELLED', 'user aborted');
  assert.deepEqual(withoutDetails.toJSON(), { code: 'CANCELLED', message: 'user aborted' });
});

test('isAppError accepts instances and structurally valid objects', async () => {
  const { AppError, isAppError } = await import('../shared/contracts/errors.ts');
  assert.equal(isAppError(new AppError('NOT_FOUND', 'missing')), true);
  assert.equal(isAppError({ code: 'NOT_FOUND', message: 'missing' }), true);
  assert.equal(isAppError({ code: 'BOGUS', message: 'x' }), false);
  assert.equal(isAppError({ code: 'NOT_FOUND', message: 5 }), false);
  assert.equal(isAppError(null), false);
  assert.equal(isAppError('NOT_FOUND'), false);
});

test('validateAppError normalizes and rejects malformed errors', async () => {
  const { AppError, validateAppError } = await import('../shared/contracts/errors.ts');
  const okInstance = validateAppError(new AppError('CONFLICT', 'x'));
  assert.equal(okInstance.ok, true);
  assert.ok(okInstance.ok && okInstance.value instanceof AppError);

  const okStruct = validateAppError({ code: 'NOT_FOUND', message: 'gone' });
  assert.equal(okStruct.ok, true);
  assert.ok(okStruct.ok && okStruct.value instanceof AppError);

  assert.equal(validateAppError(null).ok, false);
  assert.equal(validateAppError({ code: 'BOGUS', message: 'x' }).ok, false);
  assert.equal(validateAppError({ code: 'NOT_FOUND', message: 5 }).ok, false);
});

test('createRequest builds a correct envelope', async () => {
  const { createRequest, PROTOCOL_VERSION, isRequestEnvelope } = await import(
    '../shared/contracts/ipc.ts'
  );
  const full = createRequest({ cmd: 'ping' }, {
    requestId: 'r1',
    projectId: 'p1',
    expectedRevision: 'rev-2',
  });
  assert.equal(full.protocolVersion, PROTOCOL_VERSION);
  assert.equal(full.requestId, 'r1');
  assert.equal(full.projectId, 'p1');
  assert.equal(full.expectedRevision, 'rev-2');
  assert.deepEqual(full.payload, { cmd: 'ping' });

  const minimal = createRequest(123);
  assert.equal(minimal.protocolVersion, 1);
  assert.equal(typeof minimal.requestId, 'string');
  assert.equal(minimal.requestId.length > 0, true);
  assert.equal('projectId' in minimal, false);
  assert.equal('expectedRevision' in minimal, false);
  assert.equal(minimal.payload, 123);

  assert.equal(isRequestEnvelope(minimal), true);
});

test('isRequestEnvelope and validateRequest reject malformed frames', async () => {
  const { validateRequest, isRequestEnvelope } = await import(
    '../shared/contracts/ipc.ts'
  );
  assert.equal(isRequestEnvelope({ protocolVersion: 1, requestId: 'r', payload: {} }), true);
  assert.equal(isRequestEnvelope(null), false);
  assert.equal(isRequestEnvelope({ protocolVersion: 2, requestId: 'r', payload: {} }), false);
  assert.equal(isRequestEnvelope({ protocolVersion: 1, payload: {} }), false);

  assert.equal(validateRequest({ protocolVersion: 1, requestId: 'r', payload: {} }).ok, true);

  const wrongVersion = validateRequest({ protocolVersion: 99, requestId: 'r', payload: {} });
  assert.equal(wrongVersion.ok, false);

  const emptyId = validateRequest({ protocolVersion: 1, requestId: '', payload: {} });
  assert.equal(emptyId.ok, false);

  const noPayload = validateRequest({ protocolVersion: 1, requestId: 'r' });
  assert.equal(noPayload.ok, false);

  const custom = validateRequest(
    { protocolVersion: 1, requestId: 'r', payload: { a: 1 } },
    (p) => typeof p === 'object' && p !== null && 'a' in p,
  );
  assert.equal(custom.ok, true);

  const customFail = validateRequest(
    { protocolVersion: 1, requestId: 'r', payload: { b: 2 } },
    (p) => typeof p === 'object' && p !== null && 'a' in p,
  );
  assert.equal(customFail.ok, false);
});

test('ResultEnvelope success/failure discriminate correctly', async () => {
  const { AppError } = await import('../shared/contracts/errors.ts');
  const {
    createSuccess,
    createFailure,
    isResultEnvelope,
    isSuccess,
    isFailure,
  } = await import('../shared/contracts/ipc.ts');
  const ok = createSuccess('r1', { id: 7 });
  assert.deepEqual(ok, { ok: true, requestId: 'r1', value: { id: 7 } });
  assert.equal(isResultEnvelope(ok), true);
  assert.equal(isSuccess(ok), true);
  assert.equal(isFailure(ok), false);

  const okRev = createSuccess('r1', { id: 7 }, 'rev-9');
  assert.deepEqual(okRev, { ok: true, requestId: 'r1', value: { id: 7 }, revision: 'rev-9' });

  const fail = createFailure('r1', new AppError('NOT_FOUND', 'missing', { key: 'x' }));
  assert.equal(fail.ok, false);
  assert.equal(fail.requestId, 'r1');
  assert.equal(fail.error instanceof AppError, true);
  assert.equal(fail.error.code, 'NOT_FOUND');
  assert.equal(isResultEnvelope(fail), true);
  assert.equal(isSuccess(fail), false);
  assert.equal(isFailure(fail), true);

  // Narrowed branches are reachable without type errors.
  if (isFailure(fail)) {
    assert.equal(fail.error.message, 'missing');
  } else {
    assert.fail('isFailure should have narrowed to the failure branch');
  }
  if (isSuccess(ok)) {
    assert.deepEqual(ok.value, { id: 7 });
  } else {
    assert.fail('isSuccess should have narrowed to the success branch');
  }

  // Malformed frames are rejected.
  assert.equal(isResultEnvelope({ ok: true, requestId: 'r' }), false); // missing value
  assert.equal(isResultEnvelope({ ok: false, requestId: 'r', error: {} }), false); // bad error
  assert.equal(isResultEnvelope({ ok: 'maybe', requestId: 'r' }), false); // bad discriminant
});
