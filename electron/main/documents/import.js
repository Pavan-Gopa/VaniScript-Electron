'use strict';

// Document import + preflight (DOC-01).
//
// Turns a raw DOCX/PDF/RTF/TXT/MD byte buffer into a normalized
// `NormalizedDocument` (structural blocks + inline spans + preflight report).
// This file is loaded by the Electron main process / document worker
// (CommonJS). It imports the shared TS contract via Node's type-stripping,
// exactly like electron/main/providers/router.js requires shared/contracts.
//
// Dependencies: only Node built-ins (`node:zlib`, `node:crypto`). DOCX is a
// ZIP of XML — we read the ZIP central directory and inflate entries in
// memory. PDF text is extracted with a tolerant object/stream scanner + a
// WinAnsi text decoder. RTF is tokenized by hand. No third-party parser is
// required, which keeps the import path self-contained and deterministic for
// golden import tests.

const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { createAppError } = require('../../../shared/contracts/errors.ts');
const {
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_FORMATS,
  DOCUMENT_SIZE_LIMITS,
  detectFormatFromFileName,
} = require('../../../shared/contracts/documents.ts');

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function traitsEqual(a, b) {
  const keys = ['bold', 'italic', 'underline', 'strike', 'superScript', 'subScript', 'smallCaps', 'color'];
  for (const k of keys) {
    if (!!a[k] !== !!b[k]) return false;
    if (k === 'color' && a.color !== b.color) return false;
  }
  return true;
}

// CP1252 (WinAnsi) byte -> Unicode for the 0x80-0x9F hole.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†',
  0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function cp1252Char(code) {
  if (code < 0x80) return String.fromCharCode(code);
  if (code === 0x7f) return '';
  if (code >= 0xa0) return String.fromCharCode(code);
  return CP1252[code] !== undefined ? CP1252[code] : '�';
}

function decodeCp1252(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += cp1252Char(buf[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Block builder
// ---------------------------------------------------------------------------

function runsToSpans(blockId, runs) {
  const merged = [];
  for (const run of runs || []) {
    const t = run.text || '';
    if (t === '') continue;
    const traits = run.traits || {};
    const last = merged[merged.length - 1];
    if (last && traitsEqual(last.traits, traits)) last.text += t;
    else merged.push({ text: t, traits: { ...traits } });
  }
  const spans = [];
  let offset = 0;
  merged.forEach((m, idx) => {
    const start = offset;
    const end = offset + m.text.length;
    spans.push({
      spanId: `${blockId}-s${idx}`,
      blockId,
      text: m.text,
      start,
      end,
      traits: m.traits,
    });
    offset = end;
  });
  return { spans, text: merged.map((m) => m.text).join('') };
}

function styleFingerprint(kind, level, spans) {
  let s = `${kind}|${level === undefined ? '' : level}`;
  const traitKeys = ['bold', 'italic', 'underline', 'strike', 'superScript', 'subScript', 'smallCaps', 'color'];
  for (const sp of spans) {
    for (const k of traitKeys) if (sp.traits[k]) s += `|${k}`;
  }
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function createBuilder(fileHash) {
  const counters = {};
  let n = 0;
  const blocks = [];
  return {
    /** Collected blocks (read-only). */
    __blocks: blocks,
    addBlock({ kind, part, runs, page, level, sourceHash }) {
      const idx = counters[part] === undefined ? 0 : counters[part];
      counters[part] = idx + 1;
      const blockId = `b${n++}`;
      const { spans, text } = runsToSpans(blockId, runs || []);
      const blk = {
        blockId,
        kind,
        part,
        index: idx,
        page,
        level,
        styleFingerprint: styleFingerprint(kind, level, spans),
        sourceHash: sourceHash || fileHash,
        text,
        spans,
      };
      blocks.push(blk);
      return blk;
    },
  };
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

function parseTxt(buffer, fileHash) {
  const builder = createBuilder(fileHash);
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter((p) => p.length > 0);
  const blocks = paragraphs.map((p) =>
    builder.addBlock({ kind: 'paragraph', part: 'main', runs: [{ text: p, traits: {} }] }),
  );
  return { blocks, pages: undefined, warnings: [], protectedContent: false, extractionAccuracy: 'high' };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MD_FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S+)?\s*$/;
const MD_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const MD_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/;
const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+/;

function inlineMd(text) {
  const patterns = [
    { re: /\*\*(.+?)\*\*/, traits: { bold: true } },
    { re: /__(.+?)__/, traits: { bold: true } },
    { re: /\*(.+?)\*/, traits: { italic: true } },
    { re: /_(.+?)_/, traits: { italic: true } },
    { re: /~~(.+?)~~/, traits: { strike: true } },
  ];
  const runs = [];
  let rest = text;
  for (;;) {
    let best = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.index)) best = { m, traits: p.traits };
    }
    if (!best) {
      if (rest.length > 0) runs.push({ text: rest, traits: {} });
      break;
    }
    if (best.m.index > 0) runs.push({ text: rest.slice(0, best.m.index), traits: {} });
    runs.push({ text: best.m[1], traits: { ...best.traits } });
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return runs;
}

function isMdBlockStart(line) {
  return (
    MD_FENCE.test(line) ||
    MD_HEADING.test(line) ||
    MD_LIST.test(line) ||
    line.trim() === '' ||
    (line.includes('|') && MD_TABLE_SEP.test(line))
  );
}

function parseMd(buffer, fileHash) {
  const builder = createBuilder(fileHash);
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  const push = (kind, runs, level) =>
    blocks.push(builder.addBlock({ kind, part: 'main', runs, level }));

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(MD_FENCE);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = (fence[3] || '').toLowerCase();
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = l.match(MD_FENCE);
        if (close && close[1].length === 0 && close[2][0] === marker && close[2].length >= len) break;
        codeLines.push(l);
        i++;
      }
      i++;
      const kind = lang === 'verse' ? 'verse' : 'other';
      push(kind, [{ text: codeLines.join('\n'), traits: {} }]);
      continue;
    }
    const h = line.match(MD_HEADING);
    if (h) {
      push('heading', inlineMd(h[2]), h[1].length);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      push('quote', inlineMd(q.join('\n')));
      continue;
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      MD_TABLE_SEP.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const header = line;
      i += 2;
      const rows = [header];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(lines[i]);
        i++;
      }
      push('table', [{ text: rows.join('\n'), traits: {} }]);
      rows.forEach((r) => {
        const cells = r
          .split('|')
          .map((c) => c.trim())
          .filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
        push('row', [{ text: cells.join(' | '), traits: {} }]);
      });
      continue;
    }
    if (MD_LIST.test(line)) {
      const items = [];
      while (i < lines.length && MD_LIST.test(lines[i])) {
        items.push(lines[i].replace(MD_LIST, ''));
        i++;
      }
      push('list', inlineMd(items.join('\n')));
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !isMdBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length === 0) {
      i++;
      continue;
    }
    push('paragraph', inlineMd(para.join('\n')));
  }
  return { blocks, pages: undefined, warnings: [], protectedContent: false, extractionAccuracy: 'high' };
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

const RTF_DEST_WORDS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer',
  'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'footnote', 'ftnsep', 'ftnalt', 'ftncn', 'annotations', 'docvar', 'revtbl',
  'idx', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlns', 'background',
  'latentstyles', 'generator', 'themedata', 'colorschememapping', 'datastore',
  'xmlnstbl', 'mmathPr', 'pntext', 'fldinst', 'objdata', 'nonesttables',
]);

function rtfIsAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function rtfIsHex(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function rtfIsSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

// True when the group opening at `braceIdx` ('{') carries content that is not
// body text: a known destination control word, or any starred (`\*`)
// destination, which the spec lets readers discard when unrecognized (we
// recognize none). Pure lookahead — never moves the caller's cursor.
function rtfGroupIsSkippableDest(src, braceIdx) {
  const len = src.length;
  let i = braceIdx + 1;
  while (i < len && rtfIsSpaceChar(src[i])) i++;
  let starred = false;
  if (src[i] === '\\' && src[i + 1] === '*') {
    starred = true;
    i += 2;
    while (i < len && rtfIsSpaceChar(src[i])) i++;
  }
  if (src[i] !== '\\') return starred;
  let e = i + 1;
  while (e < len && rtfIsAlpha(src[e])) e++;
  if (e === i + 1) return starred; // control symbol after `\*` — still starred
  return starred || RTF_DEST_WORDS.has(src.slice(i + 1, e));
}

// Skips one balanced group. `openIdx` points at '{'; returns the index just
// past the matching '}' (or src.length when unterminated). Honors \'hh
// escapes and \bin<N> payloads so brace bytes inside them cannot desync the
// depth count. Iterative and strictly advancing — safe on hostile input.
function rtfSkipGroup(src, openIdx) {
  const len = src.length;
  let depth = 1;
  let i = openIdx + 1;
  while (i < len && depth > 0) {
    const ch = src[i];
    if (ch === '\\') {
      const nxt = src[i + 1];
      if (nxt === "'") {
        i += 4;
        continue;
      }
      if (nxt !== undefined && rtfIsAlpha(nxt)) {
        let e = i + 1;
        while (e < len && rtfIsAlpha(src[e])) e++;
        if (src.slice(i + 1, e) === 'bin') {
          let d = e;
          if (src[d] === '-') d++;
          const digitStart = d;
          while (d < len && src[d] >= '0' && src[d] <= '9') d++;
          let n = d > digitStart ? parseInt(src.slice(digitStart, d), 10) : 0;
          if (!Number.isFinite(n) || n < 0) n = 0;
          if (src[d] === ' ') d++;
          i = d + Math.min(n, len - d);
          continue;
        }
        i = e;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return i;
}

/**
 * RTF → normalized blocks (plan §10.2/§10.4).
 *
 * Single forward pass over the latin1-decoded bytes. Termination guarantee
 * (DOC-01 retry constraint): every branch of the token loop — control words,
 * control symbols, \'hh and \uN escapes, \bin payloads, group enter/skip,
 * ignorable control bytes — advances `pos` by at least one character, so no
 * input can make the parser revisit a position. Trait state is brace-scoped
 * via an explicit stack (no recursion, so nesting depth cannot exhaust the
 * JS call stack).
 */
function parseRtf(buffer, fileHash) {
  const builder = createBuilder(fileHash);
  const src = Buffer.from(buffer).toString('latin1');
  const len = src.length;

  let paraRuns = [];
  let curText = '';
  let pendingLevel;
  let traits = {};
  let ucSkip = 1;
  const groupStack = [];

  // Text accumulates in `curText` and becomes a run only when the active
  // trait set changes (or the paragraph ends), so a uniformly-styled
  // document costs O(1) runs regardless of its byte size.
  const flushRun = () => {
    if (curText !== '') {
      paraRuns.push({ text: curText, traits: { ...traits } });
      curText = '';
    }
  };

  const emit = (text) => {
    curText += text;
  };

  const setTrait = (key, value) => {
    if (!!traits[key] === !!value) return;
    flushRun();
    traits[key] = value;
  };

  const flushParagraph = () => {
    flushRun();
    if (paraRuns.length === 0) {
      builder.addBlock({ kind: 'empty', part: 'main', runs: [] });
      return;
    }
    builder.addBlock({
      kind: pendingLevel === undefined ? 'paragraph' : 'heading',
      part: 'main',
      level: pendingLevel,
      runs: paraRuns,
    });
    paraRuns = [];
    pendingLevel = undefined;
  };

  let pos = 0;

  // Consumes the fallback characters that follow a \uN escape (one per unit
  // configured by \uc). A fallback unit is either an escape (\'hh counts as
  // one) or a single character.
  const skipUtfFallback = () => {
    for (let k = 0; k < ucSkip && pos < len; k++) {
      if (src[pos] === '\\') pos += src[pos + 1] === "'" ? 4 : 2;
      else pos += 1;
    }
  };

  while (pos < len) {
    const ch = src[pos];

    if (ch === '{') {
      if (rtfGroupIsSkippableDest(src, pos)) {
        pos = rtfSkipGroup(src, pos);
      } else {
        groupStack.push({ traits: { ...traits }, ucSkip });
        pos++;
      }
      continue;
    }

    if (ch === '}') {
      const saved = groupStack.pop();
      if (saved) {
        flushRun(); // pending text still carries the inner trait set
        traits = saved.traits;
        ucSkip = saved.ucSkip;
      }
      pos++;
      continue;
    }

    if (ch === '\\') {
      const nxt = pos + 1 < len ? src[pos + 1] : undefined;
      if (nxt === undefined) {
        pos++; // lone trailing backslash
        continue;
      }
      if (rtfIsAlpha(nxt)) {
        // Control word: maximal alphabetic run + optional signed integer +
        // one space delimiter ("\para" is the word "para", never "\par"+"a").
        let e = pos + 1;
        while (e < len && rtfIsAlpha(src[e])) e++;
        const word = src.slice(pos + 1, e);
        let pe = e;
        if (src[pe] === '-') pe++;
        const digitStart = pe;
        while (pe < len && src[pe] >= '0' && src[pe] <= '9') pe++;
        const param = pe > digitStart ? src.slice(e, pe) : null;
        if (pe > digitStart) e = pe;
        if (src[e] === ' ') e++;
        pos = e;

        switch (word) {
          case 'b':
            setTrait('bold', param !== '0');
            break;
          case 'i':
            setTrait('italic', param !== '0');
            break;
          case 'strike':
          case 'striked':
            setTrait('strike', param !== '0');
            break;
          case 'ulnone':
            setTrait('underline', false);
            break;
          case 'super':
            setTrait('superScript', param !== '0');
            break;
          case 'sub':
            setTrait('subScript', param !== '0');
            break;
          case 'nosupersub':
            setTrait('superScript', false);
            setTrait('subScript', false);
            break;
          case 'plain':
            flushRun();
            traits = {};
            break;
          case 'uc': {
            const n = parseInt(param || '1', 10);
            ucSkip = Number.isFinite(n) && n >= 0 ? n : 1;
            break;
          }
          case 'u': {
            const n = parseInt(param || '', 10);
            if (Number.isFinite(n)) {
              const cp = n < 0 ? 0x10000 + n : n;
              emit(cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD');
            }
            skipUtfFallback();
            break;
          }
          case 'bin': {
            let n = parseInt(param || '0', 10);
            if (!Number.isFinite(n) || n < 0) n = 0;
            pos += Math.min(n, len - pos); // raw payload bytes are never markup
            break;
          }
          case 'par':
          case 'sect':
          case 'page':
            flushParagraph();
            break;
          case 'line':
            emit('\n');
            break;
          case 'tab':
            emit('\t');
            break;
          case 'pard':
            pendingLevel = undefined;
            break;
          case 's': {
            const n = parseInt(param || '', 10);
            if (Number.isFinite(n) && n >= 1 && n <= 9) pendingLevel = n;
            break;
          }
          default:
            if (word.startsWith('ul')) setTrait('underline', param !== '0');
            break; // remaining unknown words carry no body text
        }
        continue;
      }

      if (nxt === "'") {
        const h1 = src[pos + 2];
        const h2 = src[pos + 3];
        if (rtfIsHex(h1) && rtfIsHex(h2)) {
          emit(cp1252Char(parseInt(src.slice(pos + 2, pos + 4), 16)));
          pos += 4;
        } else {
          pos += 2; // malformed \'hh — drop the pair, keep scanning
        }
        continue;
      }

      switch (nxt) {
        case '*':
          pos += 2; // extended-destination marker, resolved at the '{' peek
          break;
        case '~':
          emit('\u00a0');
          pos += 2;
          break;
        case '\\':
        case '{':
        case '}':
          emit(nxt);
          pos += 2;
          break;
        case '\r':
        case '\n':
          flushParagraph(); // "\<newline>" is \par per the RTF spec
          pos += 2;
          break;
        default:
          pos += 2; // unknown control symbol
          break;
      }
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      pos++; // raw CR/LF/TAB/NUL are writer line-wrap noise, not content
      continue;
    }

    emit(ch);
    pos++;
  }

  if (curText !== '' || paraRuns.length > 0) flushParagraph();

  return {
    blocks: collectBuilderBlocks(builder),
    pages: undefined,
    warnings: [],
    protectedContent: false,
    extractionAccuracy: 'high',
  };
}


// ---------------------------------------------------------------------------
// DOCX (ZIP of XML)
// ---------------------------------------------------------------------------

function readZipEntries(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw createAppError('CORRUPT_DATA', 'Not a valid ZIP/OOXML package (no end-of-central-directory).');
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdCount = buffer.readUInt16LE(eocd + 10);
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const lh = localOffset;
    const lNameLen = buffer.readUInt16LE(lh + 26);
    const lExtraLen = buffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const comp = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw createAppError('CORRUPT_DATA', `Unsupported ZIP method ${method} in ${name}.`);
    entries.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlLocalName(s) {
  const c = s.indexOf(':');
  return c === -1 ? s : s.slice(c + 1);
}

function xmlParseAttrs(attrStr) {
  const attrs = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) attrs[xmlLocalName(m[1])] = m[2];
  return attrs;
}

function xmlDecodeText(t) {
  return t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function* xmlEvents(xml) {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const t = xml.slice(i);
      if (t) yield { type: 'text', text: xmlDecodeText(t) };
      return;
    }
    if (lt > i) yield { type: 'text', text: xmlDecodeText(xml.slice(i, lt)) };
    const gt = xml.indexOf('>', lt);
    if (gt === -1) return;
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('?') || tag.startsWith('!')) {
      i = gt + 1;
      continue;
    }
    if (tag.startsWith('/')) {
      yield { type: 'close', name: xmlLocalName(tag.slice(1)) };
      i = gt + 1;
      continue;
    }
    let selfClose = false;
    let t = tag;
    if (t.endsWith('/')) {
      selfClose = true;
      t = t.slice(0, -1);
    }
    const sp = t.search(/\s/);
    const name = xmlLocalName(sp === -1 ? t : t.slice(0, sp));
    const attrStr = sp === -1 ? '' : t.slice(sp + 1);
    yield { type: 'open', name, attrs: xmlParseAttrs(attrStr) };
    if (selfClose) yield { type: 'close', name };
    i = gt + 1;
  }
}

function classifyStyle(id) {
  if (!id) return { kind: 'paragraph' };
  const m = id.match(/^Heading(\d)$/i);
  if (m) return { kind: 'heading', level: parseInt(m[1], 10) };
  if (/^Title$/i.test(id)) return { kind: 'heading', level: 1 };
  if (/^Subtitle$/i.test(id)) return { kind: 'heading', level: 2 };
  if (/Quote/i.test(id)) return { kind: 'quote' };
  if (/List/i.test(id)) return { kind: 'list' };
  if (/Verse/i.test(id)) return { kind: 'verse' };
  if (/Heading/i.test(id)) return { kind: 'heading', level: 1 };
  return { kind: 'paragraph' };
}

function parseOoxmlPart(xml, part, partHash, builder) {
  let inParagraph = false;
  let paragraphRuns = [];
  let paragraphStyleId = null;
  let inRun = false;
  let runText = '';
  let runTraits = {};
  let inTextRun = false;
  let paraPropsActive = false;
  let runPropsActive = false;

  const finishParagraph = () => {
    if (!inParagraph) return;
    inParagraph = false;
    const runs = paragraphRuns;
    paragraphRuns = [];
    if (runs.length === 0) {
      builder.addBlock({ kind: 'empty', part, runs: [] });
      return;
    }
    const cls = classifyStyle(paragraphStyleId);
    builder.addBlock({ kind: cls.kind, part, level: cls.level, runs });
  };

  for (const ev of xmlEvents(xml)) {
    if (ev.type === 'open') {
      switch (ev.name) {
        case 'p':
          inParagraph = true;
          paragraphRuns = [];
          paragraphStyleId = null;
          break;
        case 'pPr':
          paraPropsActive = true;
          break;
        case 'rPr':
          if (inRun) runPropsActive = true;
          break;
        case 'pStyle':
          if (paraPropsActive) paragraphStyleId = ev.attrs.val || null;
          break;
        case 'r':
          inRun = true;
          runText = '';
          runTraits = {};
          break;
        case 't':
        case 'delText':
          if (ev.name === 't') inTextRun = true;
          break;
        case 'tab':
          if (inRun) runText += '\t';
          break;
        case 'br':
        case 'cr':
          if (inRun) runText += '\n';
          break;
        case 'b':
        case 'i':
        case 'u':
        case 'strike':
        case 'smallCaps': {
          // Normalize OOXML element names to the contract trait names
          // (`traitsEqual`/`styleFingerprint` compare the latter).
          const traitNames = { b: 'bold', i: 'italic', u: 'underline', strike: 'strike', smallCaps: 'smallCaps' };
          if (runPropsActive && inRun) {
            runTraits[traitNames[ev.name]] = ev.attrs.val
              ? ev.attrs.val !== '0' && ev.attrs.val !== 'false'
              : true;
          }
          break;
        }
        case 'color':
          if (runPropsActive && inRun && ev.attrs.val && ev.attrs.val !== 'auto') runTraits.color = `#${ev.attrs.val}`;
          break;
        case 'vertAlign':
          if (runPropsActive && inRun) {
            if (ev.attrs.val === 'superscript') runTraits.superScript = true;
            else if (ev.attrs.val === 'subscript') runTraits.subScript = true;
          }
          break;
        default:
          break;
      }
    } else if (ev.type === 'text') {
      if (inRun && inTextRun) runText += ev.text;
    } else if (ev.type === 'close') {
      switch (ev.name) {
        case 't':
        case 'delText':
          inTextRun = false;
          break;
        case 'r':
          if (inRun) {
            if (runText.length > 0) paragraphRuns.push({ text: runText, traits: { ...runTraits } });
            inRun = false;
            runPropsActive = false;
          }
          break;
        case 'pPr':
          paraPropsActive = false;
          break;
        case 'p':
          finishParagraph();
          break;
        default:
          break;
      }
    }
  }
}

function parseDocx(buffer, fileHash) {
  const entries = readZipEntries(buffer);
  const documentXml = entries.get('word/document.xml');
  if (!documentXml) throw createAppError('CORRUPT_DATA', 'DOCX is missing word/document.xml.');
  let protectedContent = false;
  for (const [name, buf] of entries) {
    if (/settings\.xml$/.test(name) && buf.toString('utf8').includes('documentProtection')) protectedContent = true;
  }
  const builder = createBuilder(fileHash);
  const partSpecs = [
    ['word/document.xml', 'main'],
    [/^word\/header\d*\.xml$/, 'header'],
    [/^word\/footer\d*\.xml$/, 'footer'],
    [/^word\/footnotes\.xml$/, 'footnote'],
    [/^word\/endnotes\.xml$/, 'endnote'],
  ];
  for (const [spec, part] of partSpecs) {
    if (spec instanceof RegExp) {
      for (const [name, buf] of entries) {
        if (spec.test(name)) parseOoxmlPart(buf.toString('utf8'), part, sha256Hex(buf), builder);
      }
    } else if (entries.has(spec)) {
      parseOoxmlPart(entries.get(spec).toString('utf8'), part, sha256Hex(entries.get(spec)), builder);
    }
  }
  return { blocks: collectBuilderBlocks(builder), pages: undefined, warnings: [], protectedContent, extractionAccuracy: 'high' };
}

// The builder keeps no public block list; we read it via a small accessor.
function collectBuilderBlocks(builder) {
  return builder.__blocks || [];
}

// ---------------------------------------------------------------------------
// PDF (tolerant object/stream scan + WinAnsi text decode)
// ---------------------------------------------------------------------------

function pdfHexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length + 1; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (!Number.isNaN(b)) out.push(b);
  }
  return Buffer.from(out);
}

function pdfLiteralToBytes(inner) {
  const out = [];
  let k = 0;
  while (k < inner.length) {
    const ch = inner[k];
    if (ch === '\\') {
      const nxt = inner[k + 1];
      if (nxt === 'n') out.push(10);
      else if (nxt === 'r') out.push(13);
      else if (nxt === 't') out.push(9);
      else if (nxt === 'b') out.push(8);
      else if (nxt === 'f') out.push(12);
      else if (nxt === '(' || nxt === ')' || nxt === '\\') out.push(nxt.charCodeAt(0));
      else if (/[0-7]/.test(nxt)) {
        let oct = '';
        let m = 0;
        while (m < 3 && /[0-7]/.test(inner[k + 1 + m])) {
          oct += inner[k + 1 + m];
          m++;
        }
        out.push(parseInt(oct, 8) & 0xff);
        k += 1 + m;
        continue;
      } else out.push(nxt.charCodeAt(0));
      k += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
      k++;
    }
  }
  return Buffer.from(out);
}

function pdfByteChar(code, encoding) {
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d ? ' ' : '';
  if (code < 0x80) return String.fromCharCode(code);
  if (encoding === 'WinAnsiEncoding' || encoding === 'MacRomanEncoding') {
    const c = CP1252[code];
    if (c !== undefined) return c;
  }
  return String.fromCharCode(code);
}

function pdfDecodeBytes(buf, encoding) {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += pdfByteChar(buf[i], encoding);
  return out;
}

function parsePdfDict(s) {
  let i = 0;
  function skipWs() {
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  function parseValue() {
    skipWs();
    const c = s[i];
    if (c === '<') {
      if (s[i + 1] === '<') {
        i += 2;
        return parseDictBody();
      }
      i += 2;
      const start = i;
      while (i < s.length && s[i] !== '>') i++;
      const hex = s.slice(start, i);
      i += 2;
      return pdfHexToBytes(hex);
    }
    if (c === '(') {
      i++;
      const start = i;
      let depth = 1;
      while (i < s.length && depth > 0) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        if (depth === 0) break;
        i++;
      }
      const lit = s.slice(start, i);
      i++;
      return pdfLiteralToBytes(lit);
    }
    if (c === '[') {
      i++;
      const arr = [];
      skipWs();
      while (s[i] !== ']') {
        arr.push(parseValue());
        skipWs();
      }
      i++;
      return arr;
    }
    if (c === '/') {
      i++;
      const start = i;
      while (i < s.length && !/[\s[\]()<>]/.test(s[i])) i++;
      return s.slice(start, i);
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
      const n1 = parseInt(s.slice(start, i), 10);
      skipWs();
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (j > i) {
        const n2 = parseInt(s.slice(i, j), 10);
        let k2 = j;
        while (k2 < s.length && /\s/.test(s[k2])) k2++;
        if (s[k2] === 'R') {
          i = k2 + 1;
          return { ref: [n1, n2] };
        }
        i = j;
      }
      return n1;
    }
    if (c === 't' && s.slice(i, i + 4) === 'true') {
      i += 4;
      return true;
    }
    if (c === 'f' && s.slice(i, i + 5) === 'false') {
      i += 5;
      return false;
    }
    if (c === 'n' && s.slice(i, i + 4) === 'null') {
      i += 4;
      return null;
    }
    i++;
    return undefined;
  }
  function parseDictBody() {
    const obj = {};
    skipWs();
    while (i < s.length) {
      if (s[i] === '>') {
        if (s[i + 1] === '>') {
          i += 2;
          break;
        }
        i++;
        continue;
      }
      if (s[i] !== '/') {
        i++;
        continue;
      }
      i++;
      const ks = i;
      while (i < s.length && !/[\s[\]()<>]/.test(s[i])) i++;
      const key = s.slice(ks, i);
      skipWs();
      obj[key] = parseValue();
    }
    return obj;
  }
  if (s.includes('<<')) {
    i = s.indexOf('<<');
    i += 2;
    return parseDictBody();
  }
  return {};
}

function parsePdf(buffer, fileHash) {
  const bytes = Buffer.from(buffer);
  const src = bytes.toString('latin1');
  const warnings = [];
  let protectedContent = false;
  const objects = new Map();
  const objRe = /(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = objRe.exec(src)) !== null) {
    const body = m[2];
    const si = body.search(/stream\r?\n/);
    let dictStr;
    let streamBuf = null;
    if (si !== -1) {
      dictStr = body.slice(0, si);
      const streamIdx = body.indexOf('stream');
      const nl = body.indexOf('\n', streamIdx);
      const es = body.lastIndexOf('endstream');
      let streamStr = body.slice(nl + 1, es).replace(/\r?\n$/, '');
      streamBuf = Buffer.from(streamStr, 'latin1');
    } else {
      dictStr = body;
    }
    objects.set(m[1], { dict: parsePdfDict(dictStr), stream: streamBuf });
  }
  if (objects.size === 0) throw createAppError('CORRUPT_DATA', 'Not a valid PDF (no objects found).');
  if (/\/Encrypt/.test(src)) {
    protectedContent = true;
    warnings.push({ code: 'ENCRYPTED_PDF', message: 'PDF is encrypted; text extraction may be unavailable.', severity: 'warning' });
  }

  // Callers pass either the `{ ref: [num, gen] }` dict value itself or the
  // bare `[num, gen]` array — accept both.
  const deref = (ref) => {
    const r = ref && ref.ref ? ref.ref : Array.isArray(ref) ? ref : null;
    return r ? objects.get(String(r[0])) || null : null;
  };

  let catalog = null;
  for (const [, obj] of objects) {
    if (obj.dict && obj.dict.Type === 'Catalog') {
      catalog = obj;
      break;
    }
  }
  if (!catalog) throw createAppError('CORRUPT_DATA', 'PDF has no Catalog object.');

  const collectPages = (nodeRef) => {
    const node = deref(nodeRef);
    if (!node) return [];
    const t = node.dict.Type;
    if (t === 'Page') return [node];
    if (t === 'Pages') {
      const kids = node.dict.Kids || [];
      let out = [];
      for (const kid of kids) if (kid && kid.ref) out = out.concat(collectPages(kid.ref));
      return out;
    }
    return [];
  };
  const pages = collectPages(catalog.dict.Pages ? catalog.dict.Pages.ref : null);

  function decodeStream(obj) {
    let data = obj.stream;
    const filter = obj.dict.Filter;
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') {
        data = zlib.inflateRawSync(data);
      } else {
        warnings.push({ code: 'UNSUPPORTED_FILTER', message: `PDF stream filter ${f} not decoded; text may be partial.`, severity: 'warning' });
      }
    }
    return data;
  }

  function fontEncoding(fontObj) {
    if (!fontObj || !fontObj.dict) return 'WinAnsiEncoding';
    const enc = fontObj.dict.Encoding;
    if (typeof enc === 'string') return enc.replace(/^\//, '');
    if (enc && typeof enc === 'object') {
      const be = enc.BaseEncoding;
      if (typeof be === 'string') return be.replace(/^\//, '');
      return 'StandardEncoding';
    }
    return 'WinAnsiEncoding';
  }

  function extractSegment(seg, fontMap) {
    const tokens = [];
    const tokRe = /(\[|\])|(\(((?:\\.|[^\\()])*)\))|(<[0-9A-Fa-f\s]*>)|(\/[A-Za-z0-9+\-#]+)|(-?\d+(?:\.\d+)?)|([A-Za-z\*\'\"]+)/g;
    let tm;
    while ((tm = tokRe.exec(seg)) !== null) {
      if (tm[1] !== undefined) tokens.push({ type: tm[1] === '[' ? 'arropen' : 'arrclose' });
      else if (tm[2] !== undefined) tokens.push({ type: 'str', value: tm[3] });
      else if (tm[4] !== undefined) tokens.push({ type: 'hex', value: tm[4] });
      else if (tm[5] !== undefined) tokens.push({ type: 'name', value: tm[5] });
      else if (tm[6] !== undefined) tokens.push({ type: 'num', value: parseFloat(tm[6]) });
      else if (tm[7] !== undefined) tokens.push({ type: 'op', value: tm[7] });
    }
    let pageText = '';
    let lineMoved = false;
    let x = 0;
    let y = 0;
    let currentFont = '';
    let unknownEnc = false;
    const operands = [];
    const arrayStack = [];
    const pop = () => operands.pop();
    const showToken = (tok) => {
      if (!tok) return;
      let b;
      if (tok.type === 'str') b = pdfLiteralToBytes(tok.value);
      else if (tok.type === 'hex') b = pdfHexToBytes(tok.value);
      else return;
      const enc = fontMap[currentFont] || 'WinAnsiEncoding';
      if (enc !== 'WinAnsiEncoding' && enc !== 'MacRomanEncoding') unknownEnc = true;
      const str = pdfDecodeBytes(b, enc);
      if (lineMoved) {
        pageText += '\n';
        lineMoved = false;
      }
      pageText += str;
    };
    for (const tok of tokens) {
      if (tok.type === 'arropen') {
        arrayStack.push([]);
        continue;
      }
      if (tok.type === 'arrclose') {
        const arr = arrayStack.pop();
        operands.push({ type: 'array', items: arr });
        continue;
      }
      if (arrayStack.length > 0) {
        if (tok.type === 'str' || tok.type === 'hex' || tok.type === 'num') arrayStack[arrayStack.length - 1].push(tok);
        continue;
      }
      if (tok.type === 'op') {
        switch (tok.value) {
          case 'Tf': {
            const size = pop();
            const font = pop();
            if (font && font.type === 'name') currentFont = font.value.replace(/^\//, '');
            break;
          }
          case 'Td':
          case 'TD': {
            const ty = pop();
            const tx = pop();
            y -= ty ? ty.value : 0;
            x += tx ? tx.value : 0;
            if (ty && ty.value < 0) lineMoved = true;
            break;
          }
          case 'Tm': {
            pop();
            pop();
            pop();
            pop();
            const f = pop();
            const e = pop();
            y = f ? f.value : 0;
            x = e ? e.value : 0;
            lineMoved = true;
            break;
          }
          case 'T*':
            lineMoved = true;
            break;
          case 'Tj':
            showToken(pop());
            break;
          case 'TJ': {
            const arr = pop();
            if (arr && arr.type === 'array') for (const it of arr.items) if (it.type === 'str' || it.type === 'hex') showToken(it);
            break;
          }
          case "'":
            lineMoved = true;
            showToken(pop());
            break;
          case '"':
            pop();
            pop();
            lineMoved = true;
            showToken(pop());
            break;
          default:
            break;
        }
        operands.length = 0;
        continue;
      }
      operands.push(tok);
    }
    return { text: pageText, unknownEnc };
  }

  const pageTexts = [];
  let unknownEncSeen = false;
  for (const page of pages) {
    const fontMap = {};
    const res = page.dict.Resources;
    if (res && res.Font && typeof res.Font === 'object') {
      for (const key of Object.keys(res.Font)) {
        const entry = res.Font[key];
        const fontObj = entry && entry.ref ? deref(entry.ref) : entry;
        if (fontObj && fontObj.dict) fontMap[key.replace(/^\//, '')] = fontEncoding(fontObj);
      }
    }
    const contents = page.dict.Contents;
    const refs = [];
    if (contents && contents.ref) refs.push(contents.ref);
    else if (Array.isArray(contents)) for (const c of contents) if (c && c.ref) refs.push(c.ref);
    let combined = '';
    for (const ref of refs) {
      const obj = deref(ref);
      if (!obj) continue;
      const data = decodeStream(obj);
      const str = data.toString('latin1');
      const btRe = /BT([\s\S]*?)ET/g;
      let bt;
      while ((bt = btRe.exec(str)) !== null) {
        const r = extractSegment(bt[1], fontMap);
        if (r.unknownEnc) unknownEncSeen = true;
        combined += r.text;
      }
    }
    pageTexts.push(combined);
  }

  const builder = createBuilder(fileHash);
  let totalChars = 0;
  for (const pt of pageTexts) {
    totalChars += pt.replace(/\s/g, '').length;
    const lines = pt.split('\n');
    let para = [];
    const flush = () => {
      if (para.length === 0) return;
      const text = para.join(' ').trim();
      if (text.length > 0) builder.addBlock({ kind: 'paragraph', part: 'main', runs: [{ text, traits: {} }] });
      para = [];
    };
    for (const line of lines) {
      if (line.trim() === '') flush();
      else para.push(line.trim());
    }
    flush();
  }

  let extractionAccuracy = 'high';
  if (unknownEncSeen) extractionAccuracy = 'partial';
  if (totalChars < 4) {
    extractionAccuracy = 'low';
    warnings.push({
      code: 'OCR_REQUIRED',
      message: 'PDF has no usable text layer; OCR is required before import.',
      severity: 'error',
    });
  }

  return {
    blocks: collectBuilderBlocks(builder),
    pages: pageTexts.length,
    warnings,
    protectedContent,
    extractionAccuracy,
    canImport: totalChars >= 4,
  };
}

// ---------------------------------------------------------------------------
// Top-level import
// ---------------------------------------------------------------------------

async function importDocument({ buffer, fileName, assetRef, format } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const fmt = format || detectFormatFromFileName(fileName || '');
  if (!fmt || !DOCUMENT_FORMATS.includes(fmt)) {
    throw createAppError('VALIDATION_FAILED', `Unsupported document format for "${fileName || '<none>'}".`);
  }
  const sizeLimit = DOCUMENT_SIZE_LIMITS[fmt];
  const warnings = [];
  const exceeded = buf.length > sizeLimit;
  if (exceeded) {
    warnings.push({
      code: 'SIZE_LIMIT_EXCEEDED',
      message: `Document exceeds the ${fmt} size limit (${buf.length} > ${sizeLimit} bytes).`,
      severity: 'error',
    });
  }
  const hash = sha256Hex(buf);
  const sourceAsset = {
    ref: assetRef || `asset://${fileName || 'document'}`,
    hash,
    sizeBytes: buf.length,
    fileName: fileName || 'document',
  };

  let parsed;
  switch (fmt) {
    case 'docx':
      parsed = parseDocx(buf, hash);
      break;
    case 'pdf':
      parsed = parsePdf(buf, hash);
      break;
    case 'rtf':
      parsed = parseRtf(buf, hash);
      break;
    case 'txt':
      parsed = parseTxt(buf, hash);
      break;
    case 'md':
      parsed = parseMd(buf, hash);
      break;
    default:
      throw createAppError('VALIDATION_FAILED', `Unhandled document format: ${fmt}.`);
  }

  const allWarnings = [...warnings, ...(parsed.warnings || [])];
  const ocrBlocked = allWarnings.some((w) => w.severity === 'error' && w.code === 'OCR_REQUIRED');
  const canImport = !exceeded && parsed.canImport !== false && !ocrBlocked;

  let words = 0;
  for (const b of parsed.blocks) {
    const t = b.text.trim();
    if (t) words += t.split(/\s+/).filter(Boolean).length;
  }
  const sections = parsed.blocks.filter((b) => b.kind === 'heading').length;

  const title = deriveTitle(parsed.blocks, fileName);

  const preflight = {
    format: fmt,
    sizeBytes: buf.length,
    sourceHash: hash,
    pages: parsed.pages,
    words,
    sections,
    blocks: parsed.blocks.length,
    canImport,
    protectedContent: !!parsed.protectedContent,
    extractionAccuracy: parsed.extractionAccuracy || 'unknown',
    warnings: allWarnings,
    limits: { sizeBytesLimit: sizeLimit, exceeded },
  };

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    format: fmt,
    title,
    sourceAsset,
    preflight,
    blocks: parsed.blocks,
    chunkPlans: [],
    translations: {},
  };
}

function deriveTitle(blocks, fileName) {
  const heading = blocks.find((b) => b.kind === 'heading' && b.text.trim().length > 0);
  if (heading) return heading.text.trim();
  const para = blocks.find((b) => b.text.trim().length > 0);
  if (para) return para.text.trim().slice(0, 120);
  return (fileName || 'document').replace(/\.[^.]+$/, '');
}

// Public API (CommonJS). Imported by the document worker, the document
// coordinator, and the golden import tests.
module.exports = {
  importDocument,
  detectFormatFromFileName,
  parseTxt,
  parseMd,
  parseRtf,
  parseDocx,
  parsePdf,
  createBuilder,
  validateNormalizedDocument:
    require('../../../shared/contracts/documents.ts').validateNormalizedDocument,
};
