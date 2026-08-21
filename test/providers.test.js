'use strict';

// PRV-01 — Main-process cloud provider router (secure proxy) tests.
//
// The Renderer must never receive API keys. These tests prove that:
//   1. The key is resolved from the vault (getSecret) inside Main and injected
//      into the outgoing HTTP request — it is never taken from the Renderer's
//      request payload and never echoed back in the result/error.
//   2. A missing key throws a structured AppError (PERMISSION_DENIED).
//   3. Unknown/disabled providers and HTTP failures throw structured errors
//      (PROVIDER_ERROR / CAPABILITY_UNAVAILABLE) without leaking secrets.
//   4. Self-hostable baseUrl overrides are honored for Ollama but ignored for
//      cloud providers.

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../electron/main/providers/router.js');

const API_KEY = 'sk-secret-from-vault-ABC123';

function providerConfig(overrides = {}) {
  return {
    id: 'openai',
    enabled: true,
    keyRef: 'vault:openai',
    model: 'gpt-4o-mini',
    transcriptionModel: 'whisper-1',
    translationModel: 'gpt-4o-mini',
    budget: {},
    ...overrides,
  };
}

function makeSettings(providers) {
  return { api: { providers } };
}

// Build test seams: readSettings returns the raw settings document, getSecret
// hands back the vault key only for the known ref, and fetch is a controllable
// mock that records its single call.
function makeDeps({ settings, fetchImpl }) {
  return {
    readSettings: () => settings,
  getSecret: (ref) => (ref === 'vault:openai' || ref === 'vault:gemini' || ref === 'vault:custom' ? API_KEY : null),
    fetch: fetchImpl,
  };
}

function makeFetch({ ok = true, status = 200, jsonBody = null, textBody = '' } = {}) {
  const call = {};
  const impl = async (url, init) => {
    call.url = url;
    call.init = init;
    return {
      ok,
      status,
      json: async () => jsonBody,
      text: async () => textBody,
    };
  };
  impl.call = call;
  return impl;
}

// A realistic OpenAI chat completion shape (normalizeOpenAI passes json through).
const OPENAI_JSON = {
  id: 'chatcmpl-1',
  choices: [{ message: { role: 'assistant', content: 'Hello from the model' } }],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
};

test('secure routing: key is injected from vault into headers, never echoed', async () => {
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = makeDeps({
    settings: makeSettings({ openai: providerConfig() }),
    fetchImpl,
  });

  // Renderer request carries NO key — only providerId + prompt.
  const request = { providerId: 'openai', prompt: 'Translate this', purpose: 'translation' };
  const result = await router.invokeProvider(request, deps);

  // fetch was called exactly once, to the canonical OpenAI endpoint.
  assert.equal(fetchImpl.call.url, 'https://api.openai.com/v1/chat/completions');
  const headers = fetchImpl.call.init.headers;
  assert.equal(headers.Authorization, `Bearer ${API_KEY}`);

  // The key must NOT appear anywhere in the request body or messages.
  assert.ok(!fetchImpl.call.init.body.includes(API_KEY), 'key must not be in request body');

  // The normalized result must carry the model payload and usage, and must not
  // leak the key anywhere in its serialized form.
  assert.equal(result.providerId, 'openai');
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.purpose, 'translation');
  assert.deepEqual(result.data, OPENAI_JSON);
  assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  assert.ok(!JSON.stringify(result).includes(API_KEY), 'result must not leak the key');
});

test('secure routing: key source is the vault, not the Renderer request', async () => {
  let secretCalls = 0;
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = {
    readSettings: () => makeSettings({ openai: providerConfig() }),
    getSecret: (ref) => {
      secretCalls += 1;
      return ref === 'vault:openai' ? API_KEY : null;
    },
    fetch: fetchImpl,
  };

  // Even with a malicious/ignored attempt to supply a key, the router ignores it
  // and resolves the key solely from getSecret.
  const request = { providerId: 'openai', prompt: 'hi', key: 'attacker-key' };
  await router.invokeProvider(request, deps);

  assert.equal(secretCalls, 1, 'key must be resolved from the vault exactly once');
  assert.equal(fetchImpl.call.init.headers.Authorization, `Bearer ${API_KEY}`);
});

test('missing key throws PERMISSION_DENIED AppError', async () => {
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = {
    readSettings: () => makeSettings({ openai: providerConfig() }),
    getSecret: () => null, // vault has no key
    fetch: fetchImpl,
  };

  await assert.rejects(
    () => router.invokeProvider({ providerId: 'openai', prompt: 'hi' }, deps),
    (err) => {
      assert.ok(router.isAppError(err), 'expected an AppError');
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.equal(fetchImpl.call.url, undefined, 'no HTTP call should be made without a key');
      return true;
    }
  );
});

test('unknown provider throws PROVIDER_ERROR', async () => {
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = makeDeps({ settings: makeSettings({}), fetchImpl });

  await assert.rejects(
    () => router.invokeProvider({ providerId: 'does-not-exist', prompt: 'hi' }, deps),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'PROVIDER_ERROR');
      return true;
    }
  );
});

test('disabled provider throws CAPABILITY_UNAVAILABLE', async () => {
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = makeDeps({
    settings: makeSettings({ openai: providerConfig({ enabled: false }) }),
    fetchImpl,
  });

  await assert.rejects(
    () => router.invokeProvider({ providerId: 'openai', prompt: 'hi' }, deps),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'CAPABILITY_UNAVAILABLE');
      assert.equal(fetchImpl.call.url, undefined, 'no HTTP call for a disabled provider');
      return true;
    }
  );
});

test('HTTP failure redacts the key even when the provider echoes it back', async () => {
  // A hostile/buggy provider returns the API key verbatim inside its error body.
  // The router must scrub it before it reaches the Renderer.
  const echoed = `401 Unauthorized: the key ${API_KEY} is invalid`;
  const fetchImpl = makeFetch({ ok: false, status: 401, textBody: echoed });
  const deps = makeDeps({
    settings: makeSettings({ openai: providerConfig() }),
    fetchImpl,
  });

  await assert.rejects(
    () => router.invokeProvider({ providerId: 'openai', prompt: 'hi' }, deps),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'PROVIDER_ERROR');
      // The leaked key must be gone from the message, snippet, and any detail.
      assert.ok(!JSON.stringify(err).includes(API_KEY), 'error must not leak the key');
      // And it must have been replaced by the redaction marker, not merely absent.
      assert.ok(JSON.stringify(err).includes('***'), 'redaction marker should be present');
      return true;
    }
  );
});

test('redactSecret replaces every occurrence of the secret', () => {
  assert.equal(router.redactSecret('key sk-secret-from-vault-ABC123 end', API_KEY), 'key *** end');
  assert.equal(
    router.redactSecret(`a ${API_KEY} b ${API_KEY}`, API_KEY),
    'a *** b ***'
  );
  // Non-string text or null secret is a safe no-op.
  assert.equal(router.redactSecret('plain', null), 'plain');
  assert.equal(router.redactSecret(null, API_KEY), null);
});

test('resolveRoute returns an inspectable route with the key in headers', async () => {
  const deps = makeDeps({ settings: makeSettings({ openai: providerConfig() }) });
  const route = await router.resolveRoute({ providerId: 'openai', prompt: 'hi' }, deps);

  assert.equal(route.providerId, 'openai');
  assert.equal(route.model, 'gpt-4o-mini');
  assert.equal(route.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(route.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(route.body.model, 'gpt-4o-mini');
  assert.deepEqual(route.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('gemini routing uses the x-goog-api-key header and generateContent URL', async () => {
  const deps = makeDeps({
    settings: makeSettings({ gemini: providerConfig({ id: 'gemini', model: 'gemini-1.5-flash' }) }),
  });
  const route = await router.resolveRoute({ providerId: 'gemini', prompt: 'hi' }, deps);

  assert.equal(route.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent');
  assert.equal(route.headers['x-goog-api-key'], API_KEY);
});

test('cloud provider baseUrl override is ignored (security: no host redirection)', async () => {
  const deps = makeDeps({ settings: makeSettings({ openai: providerConfig() }) });
  const route = await router.resolveRoute(
    { providerId: 'openai', prompt: 'hi', baseUrl: 'https://evil.attacker.com' },
    deps
  );
  assert.equal(route.url, 'https://api.openai.com/v1/chat/completions');
});

test('ollama (self-hostable) honors a baseUrl override and needs no key', async () => {
  const fetchImpl = makeFetch({
    jsonBody: { message: { content: 'local' }, prompt_eval_count: 1, eval_count: 2 },
  });
  const deps = {
    readSettings: () =>
      makeSettings({
        ollama: { id: 'ollama', enabled: true, model: 'llama3', budget: {} },
      }),
    getSecret: () => null,
    fetch: fetchImpl,
  };

  const request = { providerId: 'ollama', prompt: 'hi', baseUrl: 'http://192.168.1.50:11434' };
  const route = await router.resolveRoute(request, deps);
  assert.equal(route.url, 'http://192.168.1.50:11434/api/chat');

  const result = await router.invokeProvider(request, deps);
  assert.equal(result.providerId, 'ollama');
  assert.deepEqual(result.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
});

test('request with no prompt and no messages is rejected (VALIDATION_FAILED)', async () => {
  const deps = makeDeps({ settings: makeSettings({ openai: providerConfig() }) });
  await assert.rejects(
    () => router.invokeProvider({ providerId: 'openai' }, deps),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    }
  );
});

test('explicit modelId overrides the configured model', async () => {
  const deps = makeDeps({ settings: makeSettings({ openai: providerConfig() }) });
  const route = await router.resolveRoute(
    { providerId: 'openai', prompt: 'hi', modelId: 'gpt-4o' },
    deps
  );
  assert.equal(route.model, 'gpt-4o');
  assert.equal(route.body.model, 'gpt-4o');
});

// --- PRV-01 fix: the `custom` (OpenAI-compatible) provider must be supported ---

function customConfig(overrides = {}) {
  return {
    id: 'custom',
    enabled: true,
    keyRef: 'vault:custom',
    model: 'my-custom-model',
    customBaseUrl: 'https://custom.example.com',
    budget: {},
    ...overrides,
  };
}

test('custom provider is present in the catalog and routes to customBaseUrl', async () => {
  assert.ok(router.PROVIDER_CATALOG.custom, 'custom provider must exist in the catalog');
  const deps = makeDeps({ settings: makeSettings({ custom: customConfig() }) });
  const route = await router.resolveRoute({ providerId: 'custom', prompt: 'hi' }, deps);

  assert.equal(route.providerId, 'custom');
  assert.equal(route.model, 'my-custom-model');
  assert.equal(route.url, 'https://custom.example.com/v1/chat/completions');
  assert.equal(route.headers.Authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(route.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('custom provider invoke succeeds and never leaks the key', async () => {
  const fetchImpl = makeFetch({ jsonBody: OPENAI_JSON });
  const deps = makeDeps({
    settings: makeSettings({ custom: customConfig() }),
    fetchImpl,
  });

  const result = await router.invokeProvider({ providerId: 'custom', prompt: 'Translate this' }, deps);

  assert.equal(fetchImpl.call.url, 'https://custom.example.com/v1/chat/completions');
  assert.equal(fetchImpl.call.init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(result.providerId, 'custom');
  assert.equal(result.model, 'my-custom-model');
  assert.deepEqual(result.data, OPENAI_JSON);
  assert.ok(!JSON.stringify(result).includes(API_KEY), 'result must not leak the key');
});

test('custom provider: request baseUrl override is ignored; only settings.customBaseUrl is used', async () => {
  const deps = makeDeps({ settings: makeSettings({ custom: customConfig() }) });
  const route = await router.resolveRoute(
    { providerId: 'custom', prompt: 'hi', baseUrl: 'https://evil.attacker.com' },
    deps
  );
  assert.equal(route.url, 'https://custom.example.com/v1/chat/completions');
});

test('custom provider rejects a customBaseUrl carrying credentials', async () => {
  const deps = makeDeps({ settings: makeSettings({ custom: customConfig({
    customBaseUrl: 'https://user:p%40ss@custom.example.com',
  }) }) });

  await assert.rejects(
    () => router.invokeProvider({ providerId: 'custom', prompt: 'hi' }, deps),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    }
  );
});

test('custom provider with no customBaseUrl falls back to the default host', async () => {
  const deps = makeDeps({ settings: makeSettings({ custom: customConfig({ customBaseUrl: undefined }) }) });
  const route = await router.resolveRoute({ providerId: 'custom', prompt: 'hi' }, deps);
  assert.equal(route.url, 'https://api.openai.com/v1/chat/completions');
});
