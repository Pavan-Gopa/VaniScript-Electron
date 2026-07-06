import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildChatPolishMessages,
  buildChatTranslationMessages,
  buildUserPrompt,
  buildPlainPolishPrompt,
  buildLlamaCppArgs,
  buildLlamaServerArgs,
  extractChatCompletionText,
  runtimeCandidates,
  runtimeKeyFor,
  resolveLlamaCppBinaryPath,
  sanitizeTranslationOutput,
} = require('../../electron/llamacpp-runtime.js');

test('llamacpp runtime prefers packaged binary and then vendor/system fallbacks', () => {
  const packaged = resolveLlamaCppBinaryPath({
    isPackaged: true,
    resourcesPath: '/app/resources',
    vendorRoot: '/repo/vendor/llamacpp',
    existsSync: (candidate: string) => candidate === '/app/resources/llamacpp/darwin-arm64/llama-cli',
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.deepEqual(packaged, {
    dirPath: '/app/resources/llamacpp/darwin-arm64',
    binaryPath: '/app/resources/llamacpp/darwin-arm64/llama-cli',
  });

  const vendor = resolveLlamaCppBinaryPath({
    isPackaged: false,
    vendorRoot: '/repo/vendor/llamacpp',
    existsSync: (candidate: string) => candidate === '/repo/vendor/llamacpp/linux-x64/llama-cli',
    platform: 'linux',
    arch: 'x64',
  });
  assert.deepEqual(vendor, {
    dirPath: '/repo/vendor/llamacpp/linux-x64',
    binaryPath: '/repo/vendor/llamacpp/linux-x64/llama-cli',
  });
});

test('llamacpp runtime derives platform-specific vendor candidates', () => {
  assert.equal(runtimeKeyFor('darwin', 'arm64'), 'darwin-arm64');
  assert.deepEqual(
    runtimeCandidates({
      isPackaged: true,
      resourcesPath: '/app/resources',
      vendorRoot: '/repo/vendor/llamacpp',
      executableName: 'llama-cli',
      platform: 'darwin',
      arch: 'arm64',
    }).map((entry: { binaryPath: string }) => entry.binaryPath),
    [
      '/app/resources/llamacpp/darwin-arm64/llama-cli',
      '/repo/vendor/llamacpp/darwin-arm64/llama-cli',
      '/repo/vendor/llamacpp/llama-cli',
    ]
  );
});

test('llamacpp runtime uses GPU offload by default for local LLM models', () => {
  const args = buildLlamaCppArgs({
    modelPath: '/models/model.gguf',
    prompt: 'Translate this.',
    ctxSize: 4096,
    maxTokens: 128,
    threads: 4,
    gpuLayers: 'all',
  });

  assert.equal(args.includes('--device'), false);
  assert.equal(args.includes('none'), false);
  assert.equal(args.includes('--no-op-offload'), false);
  assert.equal(args.includes('--gpu-layers'), true);
  assert.equal(args[args.indexOf('--gpu-layers') + 1], 'all');
  assert.equal(args[args.indexOf('--fit') + 1], 'on');
});

test('llamacpp server args keep the model loaded with GPU offload', () => {
  const args = buildLlamaServerArgs({
    modelPath: '/models/model.gguf',
    host: '127.0.0.1',
    port: 48321,
    ctxSize: 8192,
    threads: 4,
    gpuLayers: 'all',
  });

  assert.equal(args.includes('--device'), false);
  assert.equal(args.includes('none'), false);
  assert.equal(args.includes('--no-op-offload'), false);
  assert.equal(args[args.indexOf('--gpu-layers') + 1], 'all');
  assert.equal(args[args.indexOf('--fit') + 1], 'on');
  assert.equal(args[args.indexOf('--port') + 1], '48321');
});

test('llamacpp runtime builds a translation prompt and strips reasoning tags', () => {
  const prompt = buildUserPrompt({
    text: 'Hari bol.',
    targetLang: 'Russian',
    speakerHint: 'Gaudiya lecture',
  });

  assert.match(prompt, /Context: Gaudiya lecture/);
  assert.match(prompt, /Translate the transcript into Russian/);

  const sanitized = sanitizeTranslationOutput('<think>draft</think>\nTranslation: Харе бол.');
  assert.equal(sanitized, 'Харе бол.');
});

test('llamacpp runtime builds polish prompt without requesting a fresh translation label', () => {
  const prompt = buildPlainPolishPrompt({
    text: '[01:39] из конструкции Самадхи, которая была самым большим зданием.',
    targetLang: 'Russian',
    glossaryBlock: 'Glossary terms to preserve:\n- Samadhi => Самадхи',
  });

  assert.match(prompt, /sounds natural, fluent, and literary/i);
  assert.match(prompt, /Do not output labels/i);
  assert.match(prompt, /Do not add new timestamps/i);
  assert.match(prompt, /за строительство/);
  assert.equal(prompt.endsWith('Revised Russian:'), false);
});

test('llamacpp runtime builds chat messages for instruct models', () => {
  const translationMessages = buildChatTranslationMessages({
    text: '[00:00] Life is short.',
    targetLang: 'Russian',
    glossaryBlock: 'Glossary terms to preserve:\n- Krishna => Кришна',
  });
  assert.equal(translationMessages[0].role, 'system');
  assert.match(translationMessages[0].content, /Return only the Russian translation/i);
  assert.match(translationMessages[1].content, /Transcript:/);
  assert.match(translationMessages[1].content, /Krishna/);

  const polishMessages = buildChatPolishMessages({
    text: '[01:39] из конструкции Самадхи',
    targetLang: 'Russian',
    glossaryBlock: '',
  });
  assert.equal(polishMessages[0].role, 'system');
  assert.match(polishMessages[0].content, /literary Russian/i);
  assert.match(polishMessages[1].content, /natural in Russian/i);
});

test('llamacpp runtime extracts text from chat completion payloads', () => {
  const payload = {
    choices: [
      {
        message: {
          content: 'Переведённый текст.',
        },
      },
    ],
  };
  assert.equal(extractChatCompletionText(payload), 'Переведённый текст.');

  const multipartPayload = {
    choices: [
      {
        message: {
          content: [{ text: 'Часть 1 ' }, { text: 'Часть 2' }],
        },
      },
    ],
  };
  assert.equal(extractChatCompletionText(multipartPayload), 'Часть 1 Часть 2');
});

test('llamacpp runtime strips cli banner, echoed prompt, and exit text', () => {
  const raw = `
build      : b9037
model      : Qwen.gguf

available commands:
  /exit or Ctrl+C
  /clear

Context: His Holiness Kadamba Kanana Swami

You are translating a verbatim transcript into Russian.
Transcript:
[00:00] Hari bol.

Russian translation:
[00:00] Харе бол.

Exiting...
`;

  assert.equal(sanitizeTranslationOutput(raw), '[00:00] Харе бол.');
});

test('llamacpp runtime strips llama-completion logs around answer', () => {
  const raw = `
main: llama backend init
llama_model_loader: loaded meta data
generate: n_ctx = 4096, n_batch = 2048, n_predict = 80, n_keep = 0

<think>

</think>

Жизнь коротка.common_perf_print: sampling time = 0.00 ms
common_memory_breakdown_print: | memory breakdown |
`;

  assert.equal(sanitizeTranslationOutput(raw), 'Жизнь коротка.');
});

test('llamacpp runtime removes echoed English source and duplicate labels', () => {
  const raw = `Жизнь коротка.
[00:00] Life is short.
Russian: Жизнь коротка.
[00:00] Life is short.
Russian: Жизнь коротка.`;

  assert.equal(sanitizeTranslationOutput(raw), 'Жизнь коротка.');
});

test('llamacpp runtime strips revised translation labels', () => {
  assert.equal(
    sanitizeTranslationOutput('Revised Russian:\n[01:48] Купол с пролётом 27 метров.'),
    '[01:48] Купол с пролётом 27 метров.'
  );
});
