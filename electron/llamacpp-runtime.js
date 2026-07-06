'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runtimeKeyFor(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function runtimeCandidates({ isPackaged, resourcesPath, vendorRoot, executableName, platform, arch }) {
  const runtimeKey = runtimeKeyFor(platform, arch);
  return [
    isPackaged ? path.join(resourcesPath, 'llamacpp', runtimeKey) : null,
    path.join(vendorRoot, runtimeKey),
    path.join(vendorRoot),
  ].filter(Boolean).map((dirPath) => ({
    dirPath,
    binaryPath: path.join(dirPath, executableName),
  }));
}

function resolveLlamaCppBinaryPath(options = {}) {
  const {
    existsSync = fs.existsSync,
    isPackaged = false,
    resourcesPath = '',
    vendorRoot = path.join(__dirname, '..', 'vendor', 'llamacpp'),
    platform = process.platform,
    arch = process.arch,
  } = options;
  const runtimeKey = runtimeKeyFor(platform, arch);

  const executableName = platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
  const bundled = runtimeCandidates({ isPackaged, resourcesPath, vendorRoot, executableName, platform, arch })
    .find((candidate) => existsSync(candidate.binaryPath));
  if (bundled) {
    return bundled;
  }

  const fallbackBinaryPath = [
    platform === 'darwin' ? '/opt/homebrew/bin/llama-cli' : null,
    platform === 'linux' ? '/usr/local/bin/llama-cli' : null,
    platform === 'linux' ? '/usr/bin/llama-cli' : null,
  ].filter(Boolean).find((candidate) => existsSync(candidate));

  if (!fallbackBinaryPath) {
    throw new Error(`llama.cpp runtime was not found for ${runtimeKey}. Install a bundled runtime into vendor/llamacpp/${runtimeKey} or provide a system llama-cli.`);
  }

  return {
    dirPath: path.dirname(fallbackBinaryPath),
    binaryPath: fallbackBinaryPath,
  };
}

function buildUserPrompt({ text, targetLang, speakerHint, glossaryBlock }) {
  const preface = speakerHint?.trim()
    ? `Context: ${speakerHint.trim()}\n\n`
    : '';
  const glossary = glossaryBlock?.trim() ? `${glossaryBlock.trim()}\n\n` : '';
  return `${preface}Translate the transcript into ${targetLang}.
Return only the ${targetLang} translation.
Do not explain. Do not think step by step. Do not output analysis, notes, markdown, or English copies.
${glossary}Use the glossary spellings and translations exactly when those terms appear.
Preserve every [MM:SS] timestamp exactly.
Preserve paragraph breaks.

Transcript:
${text}

${targetLang} translation:`;
}

function buildPlainCompletionPrompt({ text, targetLang, glossaryBlock }) {
  const glossary = glossaryBlock?.trim() ? `${glossaryBlock.trim()}\n` : '';
  return `Translate to ${targetLang}. Output only ${targetLang}. Preserve [MM:SS] timestamps.
${glossary}Use glossary terms exactly.
${text}
${targetLang}:`;
}

function buildPlainPolishPrompt({ text, targetLang, glossaryBlock }) {
  const glossary = glossaryBlock?.trim() ? `${glossaryBlock.trim()}\n` : '';
  const russianRule = String(targetLang || '').toLowerCase().includes('russian')
    ? 'For Russian, use natural Russian syntax, correct cases, and correct noun/adjective agreement. Avoid literal calques such as "из конструкции" when the natural phrase is "за строительство".\n'
    : '';
  return `Revise this ${targetLang} translation so it sounds natural, fluent, and literary.
Return only the revised ${targetLang} text.
Do not output labels, headings, explanations, markdown, or phrases like "Revised Russian:".
Preserve existing [MM:SS] timestamps exactly. Do not add new timestamps.
Do not change the meaning. Do not summarize.
${russianRule}${glossary}Use glossary terms exactly.
Fragment:
${text}
<<<RESULT>>>`;
}

function buildChatTranslationMessages({ text, targetLang, glossaryBlock }) {
  const glossary = glossaryBlock?.trim() ? `${glossaryBlock.trim()}\n\n` : '';
  return [
    {
      role: 'system',
      content: `You are a precise translation engine. Translate into ${targetLang}. Return only the ${targetLang} translation. Preserve timestamps and paragraph breaks exactly. Do not output notes, labels, markdown, or source-language copies.`,
    },
    {
      role: 'user',
      content: `${glossary}Transcript:\n${text}`,
    },
  ];
}

function buildChatPolishMessages({ text, targetLang, glossaryBlock }) {
  const glossary = glossaryBlock?.trim() ? `${glossaryBlock.trim()}\n\n` : '';
  const russianRule = String(targetLang || '').toLowerCase().includes('russian')
    ? 'For Russian, use natural Russian syntax, correct cases, and correct noun/adjective agreement. Avoid literal calques.\n\n'
    : '';
  return [
    {
      role: 'system',
      content: `You revise translations into natural, fluent, literary ${targetLang} while preserving exact meaning. Preserve timestamps exactly. Return only the revised text with no labels, headings, notes, markdown, or commentary.`,
    },
    {
      role: 'user',
      content: `${russianRule}${glossary}Revise this fragment so it sounds natural in ${targetLang}, but keep the meaning exact:\n${text}`,
    },
  ];
}

function buildLlamaCppArgs({
  modelPath,
  prompt,
  ctxSize,
  maxTokens,
  threads,
  gpuLayers = 'all',
}) {
  return [
    '--model', modelPath,
    '--prompt', prompt,
    '-no-cnv',
    '--no-display-prompt',
    '--no-perf',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--temperature', '0.2',
    '--top-p', '0.9',
    '--ctx-size', String(ctxSize),
    '--n-predict', String(maxTokens),
    '--threads', String(threads),
    '--gpu-layers', String(gpuLayers),
    '--op-offload',
    '--fit', 'on',
  ];
}

function buildLlamaServerArgs({
  modelPath,
  host = '127.0.0.1',
  port,
  ctxSize,
  threads,
  gpuLayers = 'all',
}) {
  return [
    '--model', modelPath,
    '--host', host,
    '--port', String(port),
    '--ctx-size', String(ctxSize),
    '--threads', String(threads),
    '--gpu-layers', String(gpuLayers),
    '--op-offload',
    '--fit', 'on',
    '--parallel', '1',
    '--no-webui',
    '--no-perf',
    '--timeout', '600',
    '--log-disable',
  ];
}

function serverBinaryPathFor(binaryPath) {
  const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(path.dirname(binaryPath), executable);
}

function sanitizeTranslationOutput(rawText) {
  let text = String(rawText ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*?(?=(?:\[\d{2}:\d{2}\]|[А-ЯЁа-яё]))/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^[\s\S]*?generate:[^\n]*\n+/i, '')
    .replace(/common_perf_print:[\s\S]*$/i, '')
    .replace(/common_memory_breakdown_print:[\s\S]*$/i, '')
    .replace(/\s*\[end of text\]\s*/gi, '')
    .replace(/[\s\S]*?available commands:\s*[\s\S]*?(?=\n\s*(?:Context:|You are translating|Transcript:|[А-ЯЁа-яё]|\[\d{2}:\d{2}\]))/i, '')
    .replace(/[\s\S]*?You are translating a verbatim transcript into [^\n]+\.?/i, '')
    .replace(/[\s\S]*?Transcript:\s*/i, '')
    .replace(/^[\s\S]*?\n\s*[A-Za-z][A-Za-z -]+ translation:\s*/i, '')
    .replace(/\bExiting\.\.\.\s*$/i, '')
    .replace(/^\s*(assistant|translation|(?:revised|polished|improved|edited|final)\s+(?:russian|translation)|russian|русский|перевод)\s*:\s*/i, '')
    .trim();
  const marked = text.match(/<<<RESULT>>>\s*([\s\S]*?)(?:<<<END>>>|$)/i);
  if (marked?.[1]) text = marked[1].trim();
  const explicit = text.match(/(?:^|\n)\s*(?:Russian|Русский|Translation|Перевод)\s*:\s*([\s\S]*)$/i);
  if (explicit?.[1]) text = explicit[1].trim();
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:(?:Revised|Polished|Improved|Edited|Final)\s+)?(?:Russian|Русский|Translation|Перевод)\s*:\s*/i, '').trim())
    .filter((line) => !/^\s*(?:(?:Revised|Polished|Improved|Edited|Final)\s+)?(?:Russian|Русский|Translation|Перевод)\s*:?\s*$/i.test(line))
    .filter((line) => line && !(/^\[\d{2}:\d{2}\]/.test(line) && /[A-Za-z]/.test(line) && !/[А-ЯЁа-яё]/.test(line)));

  const deduped = [];
  for (const line of cleanedLines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }

  return deduped.join('\n').trim();
}

function extractChatCompletionText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => typeof part?.text === 'string' ? part.text : '')
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function runLlamaCppTranslation({
  binaryPath,
  runtimeDir,
  modelPath,
  text,
  targetLang,
  speakerHint,
  glossaryBlock,
  systemPrompt,
  ctxSize = 8192,
  maxTokens = 4096,
  maxOutputChars = 120000,
  gpuLayers = 'all',
  threads = Math.max(1, Math.min(8, os.cpus().length || 1)),
}) {
  const resolvedSystemPrompt = systemPrompt
    || 'You are a precise translation engine. Return only the translated text. Do not summarize or rewrite the source. Preserve timestamps and paragraph breaks.';

  const prompt = buildPlainCompletionPrompt({ text, targetLang, glossaryBlock });
  const runtimeBinaryPath = path.basename(binaryPath) === 'llama-cli'
    ? path.join(path.dirname(binaryPath), process.platform === 'win32' ? 'llama-completion.exe' : 'llama-completion')
    : binaryPath;
  const resolvedBinaryPath = fs.existsSync(runtimeBinaryPath) ? runtimeBinaryPath : binaryPath;
  const args = buildLlamaCppArgs({ modelPath, prompt, ctxSize, maxTokens, threads, gpuLayers });

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(resolvedBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(process.platform === 'darwin' && runtimeDir ? { DYLD_LIBRARY_PATH: runtimeDir } : {}),
        ...(process.platform === 'linux' && runtimeDir ? { LD_LIBRARY_PATH: runtimeDir } : {}),
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString();
      if (stdout.length > maxOutputChars) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`llama.cpp output exceeded ${maxOutputChars} characters. Split the translation into smaller chunks.`));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 20000) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        return reject(new Error(`llama.cpp exited with code ${code}: ${stderr.trim() || stdout.trim() || 'Unknown error'}`));
      }

      const cleaned = sanitizeTranslationOutput(stdout);
      if (!cleaned) {
        return reject(new Error(`llama.cpp returned empty output.${stderr.trim() ? ` ${stderr.trim()}` : ''}`));
      }

      resolve({
        text: cleaned,
        backendName: path.basename(binaryPath),
        runtimeName: path.basename(resolvedBinaryPath),
      });
    });
  });
}

module.exports = {
  buildLlamaCppArgs,
  buildChatPolishMessages,
  buildChatTranslationMessages,
  buildLlamaServerArgs,
  buildPlainCompletionPrompt,
  buildPlainPolishPrompt,
  buildUserPrompt,
  extractChatCompletionText,
  runtimeCandidates,
  runtimeKeyFor,
  resolveLlamaCppBinaryPath,
  runLlamaCppTranslation,
  sanitizeTranslationOutput,
  serverBinaryPathFor,
};
