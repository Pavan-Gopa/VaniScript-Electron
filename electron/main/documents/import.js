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
  DOCUMENT_PAGE_LIMIT,
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
  // Bounds-check every offset before reading through it: mutated/hostile
  // offsets must fail CORRUPT_DATA instead of surfacing as raw
  // ERR_OUT_OF_RANGE reads or silently truncated entries.
  if (cdOffset < 0 || cdOffset + 4 > buffer.length) {
    throw createAppError('CORRUPT_DATA', `ZIP central directory offset (${cdOffset}) lies outside the file.`);
  }
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buffer.length) {
      throw createAppError('CORRUPT_DATA', 'ZIP central directory entry extends past end of file.');
    }
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > buffer.length) {
      throw createAppError('CORRUPT_DATA', 'ZIP central directory entry extends past end of file.');
    }
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    // The local header must exist, sit inside the buffer, and carry the real
    // local-header signature before its length fields can be trusted.
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw createAppError('CORRUPT_DATA', `ZIP local header for "${name}" is missing or out of range.`);
    }
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    // 0xffffffff is the unsupported ZIP64 size placeholder; any size running
    // past EOF is a truncated/mutated entry. Both must fail loudly rather
    // than yield silently truncated entry bytes.
    if (compSize === 0xffffffff || dataStart + compSize > buffer.length) {
      throw createAppError('CORRUPT_DATA', `ZIP entry "${name}" has an invalid compressed size.`);
    }
    const comp = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(comp);
      } catch (err) {
        throw createAppError('CORRUPT_DATA', `ZIP entry "${name}" failed to inflate (${err.message}).`);
      }
    } else throw createAppError('CORRUPT_DATA', `Unsupported ZIP method ${method} in ${name}.`);
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

// Tokenizes an OOXML part into open/close/text events. Malformed documents
// fail loudly here: an unterminated tag, or elements still open at EOF
// (truncated XML), throws CORRUPT_DATA instead of yielding a partial event
// stream whose unclosed tail would be silently dropped on import.
function* xmlEvents(xml) {
  let i = 0;
  let depth = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const t = xml.slice(i);
      if (t) yield { type: 'text', text: xmlDecodeText(t) };
      break;
    }
    if (lt > i) yield { type: 'text', text: xmlDecodeText(xml.slice(i, lt)) };
    const gt = xml.indexOf('>', lt);
    if (gt === -1) throw createAppError('CORRUPT_DATA', 'Malformed XML: tag not closed before end of document.');
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('?') || tag.startsWith('!')) {
      i = gt + 1;
      continue;
    }
    if (tag.startsWith('/')) {
      if (depth > 0) depth--; // tolerate stray closes; only open-at-EOF is fatal
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
    depth++;
    yield { type: 'open', name, attrs: xmlParseAttrs(attrStr) };
    if (selfClose) {
      depth--;
      yield { type: 'close', name };
    }
    i = gt + 1;
  }
  if (depth > 0) {
    throw createAppError('CORRUPT_DATA', `Malformed XML: ${depth} element(s) left open at end of document.`);
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

// Serialize one table cell: its paragraphs joined by newlines. Runs keep
// their inline traits so bold/italic inside cells survives into spans.
function ooxmlCellRuns(cell) {
  const runs = [];
  cell.paras.forEach((paraRuns, pi) => {
    if (pi > 0) runs.push({ text: '\n', traits: {} });
    runs.push(...paraRuns);
  });
  return runs;
}

// One table row: cells joined by " | " (same convention as Markdown rows).
function ooxmlRowRuns(row) {
  const runs = [];
  row.cells.forEach((cell, ci) => {
    if (ci > 0) runs.push({ text: ' | ', traits: {} });
    runs.push(...ooxmlCellRuns(cell));
  });
  return runs;
}

function ooxmlRowText(row) {
  return ooxmlRowRuns(row)
    .map((r) => r.text)
    .join('');
}

function parseOoxmlPart(xml, part, partHash, builder) {
  // `partHash` is the SHA-256 of this part's own XML bytes; every block
  // emitted below carries it (contract §10.4 sourceHash-per-part) instead of
  // falling back to the whole-file hash.
  // Paragraph and run state are stacks: OOXML nests them (a textbox lives
  // inside `<w:p>`/`<w:r>` through a drawing), and a nested element must not
  // clobber its parent's in-flight state.
  const paraFrames = []; // { runs, styleId, propsActive }
  const runFrames = []; // { text, traits, propsActive, inText }
  // Table context stack: while a table is open, paragraphs are captured into
  // the innermost cell instead of being emitted as standalone blocks.
  // `</w:tbl>` emits one `table` block plus one `row` block per row (the
  // Markdown convention), preserving the grid instead of flattening it.
  const tableStack = [];
  // Textbox paragraphs route to the dedicated `textbox` part (contract
  // §10.4) rather than being folded into `main`.
  let textboxDepth = 0;
  // `mc:Fallback` repeats the `mc:Choice` markup for legacy readers; skipping
  // it keeps textbox/table content from being emitted twice.
  let fallbackDepth = 0;

  const activePart = () => (textboxDepth > 0 ? 'textbox' : part);
  const curPara = () => paraFrames[paraFrames.length - 1];
  const curRun = () => runFrames[runFrames.length - 1];
  const ensureRow = () => {
    const frame = tableStack[tableStack.length - 1];
    if (!frame.row) frame.row = { cells: [] };
    return frame.row;
  };
  const ensureCell = () => {
    const row = ensureRow();
    if (!row.cell) row.cell = { paras: [] };
    return row.cell;
  };

  const finishParagraph = (frame) => {
    // Route by part first: a paragraph inside `txbxContent` belongs to the
    // `textbox` part even when the shape sits inside a table cell — folding
    // it into cell runs would leak box text into the serialized table.
    if (textboxDepth === 0 && tableStack.length > 0) {
      if (frame.runs.length > 0) ensureCell().paras.push(frame.runs);
      return;
    }
    if (frame.runs.length === 0) {
      builder.addBlock({ kind: 'empty', part: activePart(), runs: [], sourceHash: partHash });
      return;
    }
    const cls = classifyStyle(frame.styleId);
    builder.addBlock({ kind: cls.kind, part: activePart(), level: cls.level, runs: frame.runs, sourceHash: partHash });
  };

  for (const ev of xmlEvents(xml)) {
    if (fallbackDepth > 0) {
      if (ev.type === 'open' && ev.name === 'Fallback') fallbackDepth++;
      else if (ev.type === 'close' && ev.name === 'Fallback') fallbackDepth--;
      continue;
    }
    if (ev.type === 'open') {
      switch (ev.name) {
        case 'p':
          paraFrames.push({ runs: [], styleId: null, propsActive: false });
          break;
        case 'pPr':
          if (curPara()) curPara().propsActive = true;
          break;
        case 'rPr':
          if (curRun()) curRun().propsActive = true;
          break;
        case 'pStyle':
          if (curPara() && curPara().propsActive) curPara().styleId = ev.attrs.val || null;
          break;
        case 'r':
          runFrames.push({ text: '', traits: {}, propsActive: false, inText: false });
          break;
        case 't':
        case 'delText':
          if (curRun() && ev.name === 't') curRun().inText = true;
          break;
        case 'tab':
          if (curRun()) curRun().text += '\t';
          break;
        case 'br':
        case 'cr':
          if (curRun()) curRun().text += '\n';
          break;
        case 'txbxContent':
          textboxDepth++;
          break;
        case 'Fallback':
          fallbackDepth++;
          break;
        case 'tbl':
          tableStack.push({ rows: [], row: null });
          break;
        case 'tr':
          if (tableStack.length > 0) tableStack[tableStack.length - 1].row = { cells: [] };
          break;
        case 'tc':
          if (tableStack.length > 0) ensureRow().cell = { paras: [] };
          break;
        case 'b':
        case 'i':
        case 'u':
        case 'strike':
        case 'smallCaps': {
          // Normalize OOXML element names to the contract trait names
          // (`traitsEqual`/`styleFingerprint` compare the latter).
          const traitNames = { b: 'bold', i: 'italic', u: 'underline', strike: 'strike', smallCaps: 'smallCaps' };
          const rf = curRun();
          if (rf && rf.propsActive) {
            rf.traits[traitNames[ev.name]] = ev.attrs.val
              ? ev.attrs.val !== '0' && ev.attrs.val !== 'false'
              : true;
          }
          break;
        }
        case 'color': {
          const rf = curRun();
          if (rf && rf.propsActive && ev.attrs.val && ev.attrs.val !== 'auto') rf.traits.color = `#${ev.attrs.val}`;
          break;
        }
        case 'vertAlign': {
          const rf = curRun();
          if (rf && rf.propsActive) {
            if (ev.attrs.val === 'superscript') rf.traits.superScript = true;
            else if (ev.attrs.val === 'subscript') rf.traits.subScript = true;
          }
          break;
        }
        default:
          break;
      }
    } else if (ev.type === 'text') {
      if (curRun() && curRun().inText) curRun().text += ev.text;
    } else if (ev.type === 'close') {
      switch (ev.name) {
        case 't':
        case 'delText':
          if (curRun()) curRun().inText = false;
          break;
        case 'r': {
          const rf = runFrames.pop();
          if (rf && rf.text.length > 0 && curPara()) {
            curPara().runs.push({ text: rf.text, traits: { ...rf.traits } });
          }
          break;
        }
        case 'pPr':
          if (curPara()) curPara().propsActive = false;
          break;
        case 'p': {
          const pf = paraFrames.pop();
          if (pf) finishParagraph(pf);
          break;
        }
        case 'txbxContent':
          if (textboxDepth > 0) textboxDepth--;
          break;
        case 'tc': {
          if (tableStack.length === 0) break;
          const row = tableStack[tableStack.length - 1].row;
          if (row && row.cell) {
            row.cells.push(row.cell);
            row.cell = null;
          }
          break;
        }
        case 'tr': {
          if (tableStack.length === 0) break;
          const frame = tableStack[tableStack.length - 1];
          const row = frame.row;
          frame.row = null;
          if (row) {
            if (row.cell) {
              row.cells.push(row.cell); // tolerate a missing </w:tc>
              row.cell = null;
            }
            if (row.cells.length > 0) frame.rows.push(ooxmlRowRuns(row));
          }
          break;
        }
        case 'tbl': {
          const frame = tableStack.pop();
          if (!frame) break;
          // Tolerate a missing </w:tr> before the table closes.
          if (frame.row) {
            if (frame.row.cell) frame.row.cells.push(frame.row.cell);
            if (frame.row.cells.length > 0) frame.rows.push(ooxmlRowRuns(frame.row));
            frame.row = null;
          }
          if (frame.rows.length === 0) break;
          if (tableStack.length > 0) {
            // Nested table folds into the enclosing cell as serialized text.
            ensureCell().paras.push([{ text: frame.rows.map((rr) => rr.map((r) => r.text).join('')).join('\n'), traits: {} }]);
            break;
          }
          const tableRuns = [];
          frame.rows.forEach((rowRuns, idx) => {
            if (idx > 0) tableRuns.push({ text: '\n', traits: {} });
            tableRuns.push(...rowRuns);
          });
          builder.addBlock({ kind: 'table', part: activePart(), runs: tableRuns, sourceHash: partHash });
          for (const rowRuns of frame.rows) builder.addBlock({ kind: 'row', part: activePart(), runs: rowRuns, sourceHash: partHash });
          break;
        }
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
  // Tolerate stray angle brackets — a caller may pass the raw `<...>` token —
  // alongside whitespace, which PDF allows inside hex strings. The dict path
  // slices between the brackets before calling; this keeps both sites safe.
  const clean = hex.replace(/[<>\s]/g, '');
  // Odd-length hex: the final nibble is the high one followed by an implicit
  // trailing 0 (PDF 32000-1 §7.3.4.3), so <A> decodes as 0xA0, not 0x0A.
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const out = [];
  for (let i = 0; i < padded.length; i += 2) {
    const b = parseInt(padded.slice(i, i + 2), 16);
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
      if (nxt === undefined) {
        // Unterminated trailing escape (e.g. `(abc\)`): defined-safe byte
        // handling — emit the backslash literally rather than crash on the
        // missing escape character.
        out.push(0x5c);
        k += 1;
        continue;
      }
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

// PDF literal strings may nest unescaped parens to 32 levels (32000-1
// §7.3.4.2). Scan from the opening '(' at `openIdx`, treating a backslash
// escape (\( \) \\ octal…) as content so escaped characters never count
// toward nesting. Returns the index of the balancing ')' or -1 when the
// string is unterminated or nests deeper than maxDepth (hostile input).
function scanPdfLiteralEnd(s, openIdx, maxDepth) {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2; // escaped pair: never a nesting paren
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > maxDepth) return -1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
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

// Hard cap on `<<..>>`/`[..]` nesting: hostile deep-nesting input must fail
// with CORRUPT_DATA instead of exhausting the JS call stack.
const MAX_PDF_DICT_DEPTH = 64;

// Content-stream literal strings honor the spec's paren-nesting cap
// (§7.3.4.2): deeper input is hostile and yields no string token, the same
// defined-safe fragment behavior as an unbalanced string. The dict path
// stays fully tolerant of depth (balance is still required).
const MAX_PDF_LITERAL_DEPTH = 32;

// Page-tree walks get their own cap: a deep acyclic /Pages chain is legal
// enough to dodge the cycle guard yet still overflows the JS stack (~12k
// levels). No legitimate tree needs more levels than the page limit, so
// anything deeper fails CORRUPT_DATA instead of RangeError.
const MAX_PDF_TREE_DEPTH = DOCUMENT_PAGE_LIMIT;

function parsePdfDict(s) {
  let i = 0;
  function skipWs() {
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  function corrupt(what) {
    throw createAppError('CORRUPT_DATA', `Malformed PDF dictionary: ${what}.`);
  }
  function parseValue(depth) {
    skipWs();
    const c = s[i];
    if (c === '<') {
      if (s[i + 1] === '<') {
        i += 2;
        return parseDictBody(depth);
      }
      i += 1;
      const start = i;
      while (i < s.length && s[i] !== '>') i++;
      if (s[i] !== '>') corrupt('unterminated hex string'); // EOF guard
      const hex = s.slice(start, i);
      i += 1;
      return pdfHexToBytes(hex);
    }
    if (c === '(') {
      // Escape-aware scan (Defect 3): \( \) \\ are content, not nesting.
      const end = scanPdfLiteralEnd(s, i, Number.POSITIVE_INFINITY);
      if (end === -1) corrupt('unterminated literal string'); // EOF guard
      const lit = s.slice(i + 1, end);
      i = end + 1;
      return pdfLiteralToBytes(lit);
    }
    if (c === '[') {
      if (depth > MAX_PDF_DICT_DEPTH) corrupt('array nesting too deep');
      i++;
      const arr = [];
      skipWs();
      // Bounds-checked: an unterminated array must terminate with
      // CORRUPT_DATA, never spin past EOF (where `s[i]` is undefined and
      // `undefined !== ']'` would loop forever).
      while (i < s.length && s[i] !== ']') {
        arr.push(parseValue(depth + 1));
        skipWs();
      }
      if (s[i] !== ']') corrupt('unterminated array');
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
  function parseDictBody(depth) {
    if (depth > MAX_PDF_DICT_DEPTH) corrupt('dictionary nesting too deep');
    const obj = {};
    skipWs();
    let closed = false;
    while (i < s.length) {
      if (s[i] === '>') {
        if (s[i + 1] === '>') {
          i += 2;
          closed = true;
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
      obj[key] = parseValue(depth + 1);
    }
    if (!closed) corrupt('unterminated dictionary'); // EOF guard
    return obj;
  }
  if (s.includes('<<')) {
    i = s.indexOf('<<');
    i += 2;
    return parseDictBody(0);
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

  // Cycle- and depth-guarded page-tree walk: a hostile Pages graph must not
  // recurse forever (kid pointing at an ancestor) or exhaust the stack (deep
  // acyclic chain); each object participates at most once, and nesting past
  // MAX_PDF_TREE_DEPTH fails CORRUPT_DATA.
  const collectPages = (nodeRef, seen, depth) => {
    if (depth > MAX_PDF_TREE_DEPTH) {
      throw createAppError('CORRUPT_DATA', 'PDF page tree is nested too deep.');
    }
    const node = deref(nodeRef);
    if (!node || seen.has(node)) return [];
    seen.add(node);
    const t = node.dict.Type;
    if (t === 'Page') return [node];
    if (t === 'Pages') {
      const kids = node.dict.Kids || [];
      let out = [];
      for (const kid of kids) if (kid && kid.ref) out = out.concat(collectPages(kid.ref, seen, depth + 1));
      return out;
    }
    return [];
  };
  const pages = collectPages(catalog.dict.Pages ? catalog.dict.Pages.ref : null, new Set(), 0);

  // Preflight page-count gate (plan §10.2): reject beyond the shared page
  // limit before spending time on stream extraction.
  if (pages.length > DOCUMENT_PAGE_LIMIT) {
    warnings.push({
      code: 'PAGE_LIMIT_EXCEEDED',
      message: `PDF exceeds the ${DOCUMENT_PAGE_LIMIT}-page import limit (${pages.length} pages).`,
      severity: 'error',
    });
    return {
      blocks: [],
      pages: pages.length,
      warnings,
      protectedContent,
      extractionAccuracy: 'unknown',
      canImport: false,
    };
  }

  function decodeStream(obj) {
    let data = obj.stream;
    const filter = obj.dict.Filter;
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') {
        // PDF Flate is RFC 1950 (zlib wrapper). Raw deflate is only correct
        // for the DOCX ZIP container (readZipEntries method 8).
        try {
          data = zlib.inflateSync(data);
        } catch (err) {
          throw createAppError('CORRUPT_DATA', `PDF FlateDecode stream is corrupt (${err.message}).`);
        }
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
    // Group 2 anchors only the opening '(' of a literal string; the shared
    // escape-aware scanner finds its true end, since raw nested parens are
    // legal (§7.3.4.2) and the previous single-alternative regex dropped the
    // whole operand whenever one appeared. Group 4 still captures the hex
    // payload WITHOUT its < > delimiters; name/num/op shift to 5/6/7.
    const tokRe = /(\[|\])|(\()|(<([0-9A-Fa-f\s]*)>)|(\/[A-Za-z0-9+\-#]+)|(-?\d+(?:\.\d+)?)|([A-Za-z\*\'\"]+)/g;
    let tm;
    while ((tm = tokRe.exec(seg)) !== null) {
      if (tm[1] !== undefined) tokens.push({ type: tm[1] === '[' ? 'arropen' : 'arrclose' });
      else if (tm[2] !== undefined) {
        const end = scanPdfLiteralEnd(seg, tm.index, MAX_PDF_LITERAL_DEPTH);
        if (end !== -1) {
          tokens.push({ type: 'str', value: seg.slice(tm.index + 1, end) });
          tokRe.lastIndex = end + 1;
        } else {
          // Hostile literal (unbalanced, or nested deeper than the
          // §7.3.4.2 cap): emit no string token and consume through its
          // balancing ')' when one exists — otherwise the regex would
          // re-anchor at an inner paren and resurrect a shallower phantom
          // string. Truly unterminated input swallows the rest of the
          // segment (defined-safe, typed via the OCR path, never a crash).
          const raw = scanPdfLiteralEnd(seg, tm.index, Number.POSITIVE_INFINITY);
          tokRe.lastIndex = raw === -1 ? seg.length : raw + 1;
        }
      }
      else if (tm[3] !== undefined) tokens.push({ type: 'hex', value: tm[4] });
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
  for (const [pageIndex, pt] of pageTexts.entries()) {
    totalChars += pt.replace(/\s/g, '').length;
    const lines = pt.split('\n');
    let para = [];
    const flush = () => {
      if (para.length === 0) return;
      const text = para.join(' ').trim();
      // Contract §10.4: `page` is the 1-based source page of the block.
      if (text.length > 0) builder.addBlock({ kind: 'paragraph', part: 'main', runs: [{ text, traits: {} }], page: pageIndex + 1 });
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
  // Exported for the golden tests that pin exact decoded dict values
  // (dict values never surface in blocks/preflight).
  parsePdfDict,
  createBuilder,
  validateNormalizedDocument:
    require('../../../shared/contracts/documents.ts').validateNormalizedDocument,
};
