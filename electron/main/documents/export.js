'use strict';

// Document exports (DOC-08, migration plan §10.10).
//
// The exporter is deliberately self-contained: TXT/Markdown are deterministic
// projections, DOCX is a small standards-compliant OOXML package, and PDF is a
// deterministic text-layer document. No export ever reads or mutates the
// immutable source asset; it only reads the current DocumentArchive and an
// optional TranslationArchive from the D2 store.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppError } = require('../../../shared/contracts/errors.ts');
const {
  DOCUMENT_EXPORT_FORMATS,
  normalizeBcp47,
  validateDocumentArchive,
  validateTranslationArchive,
} = require('../../../shared/contracts/documents.ts');
const { DocumentProjectStore } = require('./documentProjectStore.js');

const PDF_PAGE_LINES = 46;
const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_LEFT = 54;
const PDF_TOP = 738;
const PDF_LINE_HEIGHT = 15;

const XML_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createAppError('VALIDATION_FAILED', `${label} must be a non-empty string.`);
  }
  return value;
}

function normalizeExportFormat(value) {
  if (typeof value !== 'string') {
    throw createAppError('VALIDATION_FAILED', 'format must be one of docx, txt, md, or pdf.');
  }
  const format = value.trim().toLowerCase();
  if (!DOCUMENT_EXPORT_FORMATS.includes(format)) {
    throw createAppError('VALIDATION_FAILED', `Unsupported document export format "${value}".`);
  }
  return format;
}

function normalizeLanguage(value, label = 'language') {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw createAppError('VALIDATION_FAILED', `${label} must be a BCP-47 language tag or null.`);
  }
  const normalized = normalizeBcp47(value);
  if (!normalized) {
    throw createAppError('VALIDATION_FAILED', `Invalid BCP-47 language tag "${value}".`);
  }
  return normalized;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    throw createAppError('CORRUPT_DATA', 'Document archive blocks must be an array.');
  }
  const ids = new Set();
  return blocks.map((block, index) => {
    if (!isRecord(block) || typeof block.blockId !== 'string' || block.blockId === '') {
      throw createAppError('CORRUPT_DATA', `Document block ${index} has no valid blockId.`);
    }
    if (ids.has(block.blockId)) {
      throw createAppError('CORRUPT_DATA', `Document archive contains duplicate blockId "${block.blockId}".`);
    }
    ids.add(block.blockId);
    if (typeof block.kind !== 'string' || typeof block.part !== 'string' || typeof block.text !== 'string') {
      throw createAppError('CORRUPT_DATA', `Document block "${block.blockId}" is structurally malformed.`);
    }
    return block;
  });
}

function validateArchiveForExport(raw) {
  const result = validateDocumentArchive(raw);
  if (!result.ok) throw result.error;
  normalizeBlocks(result.value.blocks);
  return result.value;
}

function validateProjectionDocument(raw) {
  if (!isRecord(raw)) {
    throw createAppError('VALIDATION_FAILED', 'document must be an object.');
  }
  const blocks = normalizeBlocks(raw.blocks);
  if (typeof raw.format !== 'string' || typeof raw.title !== 'string') {
    throw createAppError('VALIDATION_FAILED', 'document must carry format and title.');
  }
  return { ...raw, blocks };
}

function sourceTextForBlock(block, translation) {
  if (!translation) return block.text;
  const entry = translation.blocks[block.blockId];
  if (!entry || typeof entry.text !== 'string') {
    throw createAppError(
      'VALIDATION_FAILED',
      `Language "${translation.language}" is missing a translation for block "${block.blockId}".`,
      { language: translation.language, blockId: block.blockId },
    );
  }
  return entry.text;
}

function collectWarnings(archive, translation) {
  if (!translation) return [];
  const warnings = [];
  for (const block of archive.blocks) {
    const entry = translation.blocks[block.blockId];
    if (!entry) continue;
    const stale = entry.sourceHash !== sha256Text(block.text);
    if (stale) {
      warnings.push({
        code: 'STALE_TRANSLATION',
        message: `Translation for block "${block.blockId}" is stale against the current source.`,
        severity: 'warning',
        blockId: block.blockId,
      });
    }
    if (entry.status === 'needs-review') {
      warnings.push({
        code: 'NEEDS_REVIEW',
        message: `Translation for block "${block.blockId}" is marked needs-review.`,
        severity: 'warning',
        blockId: block.blockId,
      });
    }
  }
  return warnings;
}

function buildProjection(archive, translation) {
  const blocks = normalizeBlocks(archive.blocks);
  return {
    ...archive,
    blocks: blocks.map((block) => ({
      source: block,
      text: sourceTextForBlock(block, translation),
      kind: block.kind,
      part: block.part,
      level: block.level,
      index: block.index,
    })),
  };
}

function xmlEscape(value) {
  const raw = String(value);
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw createAppError('VALIDATION_FAILED', 'DOCX export cannot encode unpaired surrogate characters.');
    }
    if (
      codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d
    ) {
      throw createAppError('VALIDATION_FAILED', 'DOCX export cannot encode XML control characters.');
    }
    if (codePoint === 0xfffe || codePoint === 0xffff) {
      throw createAppError('VALIDATION_FAILED', 'DOCX export cannot encode reserved XML code points.');
    }
  }
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlText(value) {
  const text = String(value);
  const attr = /^\s|\s$|\n|\r|\t/.test(text) ? ' xml:space="preserve"' : '';
  return `<w:t${attr}>${xmlEscape(text)}</w:t>`;
}

function runTraitsXml(traits) {
  if (!isRecord(traits)) return '';
  const out = [];
  if (traits.bold) out.push('<w:b/>');
  if (traits.italic) out.push('<w:i/>');
  if (traits.underline) out.push('<w:u w:val="single"/>');
  if (traits.strike) out.push('<w:strike/>');
  if (traits.smallCaps) out.push('<w:smallCaps/>');
  if (traits.color && /^#[0-9a-f]{6}$/i.test(traits.color)) {
    out.push(`<w:color w:val="${traits.color.slice(1)}"/>`);
  }
  if (traits.superScript) out.push('<w:vertAlign w:val="superscript"/>');
  if (traits.subScript) out.push('<w:vertAlign w:val="subscript"/>');
  return out.length === 0 ? '' : `<w:rPr>${out.join('')}</w:rPr>`;
}

function runXml(text, traits = {}) {
  const pieces = String(text).split('\n');
  const body = [];
  for (let i = 0; i < pieces.length; i += 1) {
    if (i > 0) body.push('<w:br/>');
    const piece = pieces[i];
    if (piece.includes('\t')) {
      const tabs = piece.split('\t');
      tabs.forEach((tab, tabIndex) => {
        if (tabIndex > 0) body.push('<w:tab/>');
        if (tab !== '') body.push(xmlText(tab));
      });
    } else if (piece !== '') {
      body.push(xmlText(piece));
    }
  }
  return `<w:r>${runTraitsXml(traits)}${body.join('')}</w:r>`;
}

function renderRuns(block, text) {
  if (text === block.text && Array.isArray(block.spans) && block.spans.length > 0) {
    return block.spans.map((span) => runXml(span.text, span.traits || {})).join('');
  }
  return text === '' ? '' : runXml(text, {});
}

function styleForBlock(block) {
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number.isInteger(block.level) ? block.level : 1));
    return `Heading${level}`;
  }
  if (block.kind === 'quote') return 'Quote';
  if (block.kind === 'verse') return 'Verse';
  if (block.kind === 'list') return 'ListParagraph';
  return 'Normal';
}

function paragraphXml(block, text = block.text) {
  const style = styleForBlock(block);
  const pPr = style === 'Normal' ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${pPr}${renderRuns(block, text)}</w:p>`;
}

function rowCells(text) {
  const line = String(text);
  const cells = line.includes(' | ') ? line.split(' | ') : [line];
  return cells.map((cell) => `<w:tc><w:p>${cell === '' ? '' : runXml(cell, {})}</w:p></w:tc>`).join('');
}

function tableXml(rows) {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows
    .map((row) => `<w:tr>${rowCells(row)}</w:tr>`)
    .join('')}</w:tbl>`;
}

function projectionRows(block, following) {
  const rowBlocks = [];
  for (const candidate of following) {
    if (candidate.kind !== 'row' || candidate.part !== block.part) break;
    rowBlocks.push(candidate.text);
  }
  if (rowBlocks.length > 0) return rowBlocks;
  return String(block.text).split('\n');
}

function contentBlocksForPart(projection, part) {
  return projection.blocks
    .filter((item) => item.part === part)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function buildPartBody(items) {
  const body = [];
  let tableRowEnd = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'row' && i < tableRowEnd) continue;
    if (item.kind === 'table') {
      let end = i + 1;
      while (end < items.length && items[end].kind === 'row' && items[end].part === item.part) end += 1;
      tableRowEnd = end;
      body.push(tableXml(projectionRows(item, items.slice(i + 1, end))));
      continue;
    }
    body.push(paragraphXml(item.source, item.text));
  }
  return body.join('');
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${XML_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Verse"><w:name w:val="Verse"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>' +
    Array.from({ length: 6 }, (_, index) =>
      `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="${index + 1}"/></w:style>`,
    ).join('') +
    '</w:styles>';
}

function partXml(rootName, items) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:${rootName} xmlns:w="${XML_NS}">${buildPartBody(items)}</w:${rootName}>`;
}

function buildDocx(projection) {
  const entries = [];
  const mainItems = contentBlocksForPart(projection, 'main');
  // Textboxes have no stable source package part in the normalized archive. A
  // visible paragraph projection is safer than silently dropping their text.
  const textboxItems = contentBlocksForPart(projection, 'textbox');
  const body = buildPartBody([...mainItems, ...textboxItems]);
  const relationshipEntries = [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: 'styles.xml' },
  ];
  const contentTypeOverrides = [
    { part: '/word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
    { part: '/word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
  ];
  const sectRefs = [];

  for (const part of ['header', 'footer']) {
    const items = contentBlocksForPart(projection, part);
    if (items.length === 0) continue;
    const number = 1;
    const file = `word/${part}${number}.xml`;
    const target = `${part}${number}.xml`;
    const id = `rId${relationshipEntries.length + 1}`;
    entries.push({ name: file, data: Buffer.from(partXml(part === 'header' ? 'hdr' : 'ftr', items), 'utf8') });
    relationshipEntries.push({
      id,
      type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${part}`,
      target,
    });
    contentTypeOverrides.push({
      part: `/${file}`,
      type: `application/vnd.openxmlformats-officedocument.wordprocessingml.${part}+xml`,
    });
    sectRefs.push(`<w:${part}Reference w:type="default" r:id="${id}"/>`);
  }

  for (const part of ['footnote', 'endnote']) {
    const items = contentBlocksForPart(projection, part);
    if (items.length === 0) continue;
    const root = part === 'footnote' ? 'footnotes' : 'endnotes';
    const fileName = part === 'footnote' ? 'footnotes.xml' : 'endnotes.xml';
    const id = `rId${relationshipEntries.length + 1}`;
    const bodyXml = buildPartBody(items);
    const separator = `<w:${part} w:type="separator" w:id="-1"><w:p/></w:${part}>`;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="${XML_NS}">${separator}<w:${part} w:id="1">${bodyXml}</w:${part}></w:${root}>`;
    entries.push({ name: `word/${fileName}`, data: Buffer.from(xml, 'utf8') });
    relationshipEntries.push({
      id,
      type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${root}`,
      target: fileName,
    });
    contentTypeOverrides.push({
      part: `/word/${fileName}`,
      type: `application/vnd.openxmlformats-officedocument.wordprocessingml.${root}+xml`,
    });
  }

  const sectPr = `<w:sectPr>${sectRefs.join('')}</w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${XML_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${sectPr}</w:body></w:document>`;
  const documentRels = `<Relationships xmlns="${REL_NS}">${relationshipEntries
    .map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"/>`)
    .join('')}</Relationships>`;
  const contentTypes = `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypeOverrides
    .map((item) => `<Override PartName="${item.part}" ContentType="${item.type}"/>`)
    .join('')}</Types>`;
  const rootRels = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  entries.unshift(
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
  );
  return makeZip(entries);
}

function crc32(buffer) {
  let value = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    value ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (~value) >>> 0;
}

function makeZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 0xffff) {
    throw createAppError('CORRUPT_DATA', 'DOCX package has an invalid entry count.');
  }
  const local = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      names.has(entry.name) ||
      entry.name.includes('..') ||
      entry.name.startsWith('/') ||
      entry.name.startsWith('\\') ||
      entry.name.includes('\\') ||
      path.isAbsolute(entry.name)
    ) {
      throw createAppError('CORRUPT_DATA', 'DOCX package contains an unsafe or duplicate entry name.');
    }
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    if (name.length > 0xffff || data.length > 0xffffffff) {
      throw createAppError('CORRUPT_DATA', `DOCX package entry "${entry.name}" is too large.`);
    }
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, end]);
}

function markdownInline(block, text) {
  if (text === block.text && Array.isArray(block.spans) && block.spans.length > 0) {
    return block.spans.map((span) => {
      const raw = String(span.text);
      const traits = span.traits || {};
      let value = raw;
      if (traits.strike) value = `~~${value}~~`;
      if (traits.bold) value = `**${value}**`;
      if (traits.italic) value = `*${value}*`;
      return value;
    }).join('');
  }
  return String(text);
}

function markdownTableRows(item, following) {
  const rows = [];
  for (const candidate of following) {
    if (candidate.kind !== 'row' || candidate.part !== item.part) break;
    rows.push(candidate.text);
  }
  return rows.length > 0 ? rows : String(item.text).split('\n');
}

function markdownTable(item, following) {
  const rows = markdownTableRows(item, following).map((row) => String(row).split(' | '));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ''));
  const header = `| ${normalized[0].join(' | ')} |`;
  const separator = `| ${normalized[0].map(() => '---').join(' | ')} |`;
  const body = normalized.slice(1).map((row) => `| ${row.join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function markdownFence(text, language = '') {
  const runs = String(text).match(/`+/g) || [];
  const length = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = '`'.repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

function formatMarkdown(projection) {
  const items = projection.blocks.slice();
  const lines = [];
  let tableRowEnd = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'row' && i < tableRowEnd) continue;
    if (item.kind === 'table') {
      let end = i + 1;
      while (end < items.length && items[end].kind === 'row' && items[end].part === item.part) end += 1;
      tableRowEnd = end;
      lines.push(markdownTable(item, items.slice(i + 1, end)));
      continue;
    }
    if (item.kind === 'heading') {
      const level = Math.max(1, Math.min(6, Number.isInteger(item.level) ? item.level : 1));
      lines.push(`${'#'.repeat(level)} ${markdownInline(item.source, item.text)}`);
    } else if (item.kind === 'quote') {
      lines.push(String(markdownInline(item.source, item.text)).split('\n').map((line) => `> ${line}`).join('\n'));
    } else if (item.kind === 'list') {
      lines.push(String(markdownInline(item.source, item.text)).split('\n').map((line) => `- ${line}`).join('\n'));
    } else if (item.kind === 'verse') {
      lines.push(markdownFence(item.text, 'verse'));
    } else if (item.kind === 'other') {
      lines.push(markdownFence(item.text));
    } else {
      lines.push(markdownInline(item.source, item.text));
    }
  }
  return Buffer.from(lines.join('\n\n'), 'utf8');
}

function formatText(projection) {
  const items = projection.blocks.slice();
  const out = [];
  let tableRowEnd = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'row' && i < tableRowEnd) continue;
    if (item.kind === 'table') {
      let end = i + 1;
      while (end < items.length && items[end].kind === 'row' && items[end].part === item.part) end += 1;
      tableRowEnd = end;
    }
    out.push(String(item.text).replace(/\r\n?/g, '\n'));
  }
  return Buffer.from(out.join('\n\n'), 'utf8');
}

function pdfSafeText(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function pdfLiteral(text) {
  return `(${pdfSafeText(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

function pdfLines(projection) {
  const lines = [];
  for (const item of projection.blocks) {
    const text = String(item.text);
    const rows = text === '' ? [''] : text.split('\n');
    for (const row of rows) lines.push(row);
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

function buildPdf(projection) {
  const allLines = pdfLines(projection);
  const pages = [];
  for (let i = 0; i < allLines.length; i += PDF_PAGE_LINES) pages.push(allLines.slice(i, i + PDF_PAGE_LINES));
  const pageCount = Math.max(1, pages.length);
  const objects = [];
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const firstPageId = 4;
  const firstContentId = firstPageId + pageCount;
  const infoId = firstContentId + pageCount;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const pageRefs = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = firstPageId + index;
    const contentId = firstContentId + index;
    pageRefs.push(`${pageId} 0 R`);
    const contentLines = [
      'BT',
      '/F1 11 Tf',
      `1 0 0 1 ${PDF_LEFT} ${PDF_TOP} Tm`,
    ];
    const page = pages[index] || [''];
    page.forEach((line, lineIndex) => {
      if (lineIndex > 0) contentLines.push(`0 -${PDF_LINE_HEIGHT} Td`);
      contentLines.push(`${pdfLiteral(line)} Tj`);
    });
    contentLines.push('ET');
    const content = contentLines.join('\n');
    objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`;
  objects[infoId - 1] = `<< /Title ${pdfLiteral(projection.title || 'Document')} /Producer (VaniScript) >>`;

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    const body = objects[index] || '<<>>';
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function formatProjection(projection, format) {
  switch (format) {
    case 'docx': return buildDocx(projection);
    case 'txt': return formatText(projection);
    case 'md': return formatMarkdown(projection);
    case 'pdf': return buildPdf(projection);
    default: throw createAppError('VALIDATION_FAILED', `Unsupported document export format "${format}".`);
  }
}

function safeFileName(value, format) {
  const base = String(value || 'document')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '')
    .slice(0, 120) || 'document';
  return `${base}.${format}`;
}

function assertSafeOutputPath(outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.includes('\u0000')) {
    throw createAppError('VALIDATION_FAILED', 'outputPath must be a non-empty absolute path.');
  }
  if (!path.isAbsolute(outputPath) || (/^[A-Za-z]:[\\/]/.test(outputPath) && path.sep !== '\\')) {
    throw createAppError('PERMISSION_DENIED', 'Export outputPath must be an absolute local path.');
  }
  const segments = outputPath.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) {
    throw createAppError('PERMISSION_DENIED', 'Export outputPath must not contain path traversal segments.');
  }
  const target = path.normalize(outputPath);
  const parent = path.dirname(target);
  const root = path.parse(parent).root;
  const relative = path.relative(root, parent);
  const components = relative ? relative.split(path.sep) : [];
  const inspectParent = (allowMissing) => {
    let current = root;
    for (const component of components) {
      current = path.join(current, component);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (allowMissing && error && error.code === 'ENOENT') return;
        throw createAppError('PERMISSION_DENIED', `Cannot inspect export output directory "${current}".`, { cause: error.message });
      }
      if (stat.isSymbolicLink()) {
        // macOS exposes temporary directories through the conventional /var
        // and /tmp aliases. Resolve those OS aliases before continuing the
        // component walk; user-created symlinks remain denied.
        if (current === '/var' || current === '/tmp') {
          try {
            current = fs.realpathSync(current);
            stat = fs.lstatSync(current);
          } catch (error) {
            throw createAppError('PERMISSION_DENIED', `Cannot resolve export output directory "${current}".`, { cause: error.message });
          }
        } else {
          throw createAppError('PERMISSION_DENIED', `Export output directory is not a real directory: "${current}".`);
        }
      }
      if (!stat.isDirectory()) {
        throw createAppError('PERMISSION_DENIED', `Export output directory is not a real directory: "${current}".`);
      }
    }
  };
  inspectParent(true);
  fs.mkdirSync(parent, { recursive: true });
  inspectParent(false);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw createAppError('PERMISSION_DENIED', `Refusing to overwrite symlink export target "${target}".`);
    }
    if (!stat.isFile()) {
      throw createAppError('OUTPUT_COLLISION', `Export target is not a regular file: "${target}".`);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return target;
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw createAppError('PERMISSION_DENIED', `Cannot inspect export target "${target}".`, {
      cause: error && error.message,
    });
  }
  return target;
}

function atomicWrite(target, bytes) {
  const safeTarget = assertSafeOutputPath(target);
  const parent = path.dirname(safeTarget);
  let tempPath = null;
  let fd = null;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = path.join(parent, `.${path.basename(safeTarget)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      try {
        fd = fs.openSync(candidate, 'wx', 0o600);
        tempPath = candidate;
        break;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
    }
    if (fd == null || tempPath == null) throw createAppError('INTERNAL', 'Could not allocate an atomic export temporary file.');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, safeTarget);
    tempPath = null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw createAppError('INTERNAL', `Atomic export write failed for "${safeTarget}".`, { cause: error && error.message });
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* best effort cleanup */ }
    }
    if (tempPath != null) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    }
  }
  return safeTarget;
}

function prepareRequest(request) {
  if (!isRecord(request)) throw createAppError('VALIDATION_FAILED', 'Document export request must be an object.');
  const projectId = request.projectId == null ? undefined : requireNonEmptyString(request.projectId, 'projectId');
  const format = normalizeExportFormat(request.format);
  if (request.overwrite !== undefined && typeof request.overwrite !== 'boolean') {
    throw createAppError('VALIDATION_FAILED', 'overwrite must be a boolean when supplied.');
  }
  if (request.outputPath !== undefined && request.outputPath !== null) assertSafeOutputPath(request.outputPath);
  return {
    ...request,
    projectId,
    format,
    outputPath: request.outputPath == null ? null : request.outputPath,
    language: request.language === undefined ? undefined : normalizeLanguage(request.language),
  };
}

function createDocumentExportService(options = {}) {
  const store = options && options.store ? options.store : new DocumentProjectStore(options);
  if (!store || typeof store.loadDocumentProject !== 'function') {
    throw new TypeError('createDocumentExportService requires a DocumentProjectStore as "store".');
  }

  function exportDocument(rawRequest) {
    const request = prepareRequest(rawRequest);
    let archive;
    let loadedProject = null;
    let translation = null;
    if (request.document || request.archive) {
      archive = request.archive || request.document;
      archive = request.archive ? validateArchiveForExport(archive) : validateProjectionDocument(archive);
      if (request.language != null) {
        if (!request.translation || !isRecord(request.translation)) {
          throw createAppError('VALIDATION_FAILED', 'translation is required when exporting a direct document in a language.');
        }
        const result = validateTranslationArchive(request.translation);
        if (!result.ok) throw result.error;
        translation = result.value;
      }
    } else {
      if (!request.projectId) throw createAppError('VALIDATION_FAILED', 'projectId is required when exporting a stored project.');
      const loaded = store.loadDocumentProject(request.projectId);
      loadedProject = loaded.project;
      archive = validateArchiveForExport(loaded.archive);
      const language = request.language === undefined
        ? (typeof loadedProject.activeTranslationLanguage === 'string' ? normalizeLanguage(loadedProject.activeTranslationLanguage) : null)
        : request.language;
      request.language = language;
      if (language != null) {
        translation = store.getTranslationArchive(request.projectId, language);
        const result = validateTranslationArchive(translation);
        if (!result.ok) throw result.error;
        translation = result.value;
      }
    }
    if (translation && request.projectId && translation.projectId !== request.projectId) {
      throw createAppError('CORRUPT_DATA', 'Translation archive belongs to a different project.', { projectId: request.projectId, language: translation.language });
    }
    if (translation && request.language !== undefined && translation.language !== request.language) {
      throw createAppError('CORRUPT_DATA', 'Translation archive language does not match the export request.', { requested: request.language, actual: translation.language });
    }
    const projection = buildProjection(archive, translation);
    const bytes = formatProjection(projection, request.format);
    let writtenPath = null;
    if (request.outputPath != null) {
      if (request.overwrite === false) {
        const safeTarget = assertSafeOutputPath(request.outputPath);
        try {
          fs.lstatSync(safeTarget);
          throw createAppError('OUTPUT_COLLISION', `Export target already exists: "${safeTarget}".`);
        } catch (error) {
          if (error && error.code !== 'ENOENT') throw error;
        }
      }
      writtenPath = atomicWrite(request.outputPath, bytes);
    }
    const language = translation ? translation.language : (request.language == null ? null : request.language);
    return {
      projectId: request.projectId || archive.projectId || null,
      format: request.format,
      language,
      fileName: writtenPath ? path.basename(writtenPath) : safeFileName(archive.title, request.format),
      outputPath: writtenPath,
      bytes: bytes.length,
      buffer: bytes,
      warnings: collectWarnings(archive, translation),
      revision: loadedProject ? String(loadedProject.revision) : null,
    };
  }

  return { exportDocument };
}

function exportDocument(request, options = {}) {
  return createDocumentExportService(options).exportDocument(request);
}

module.exports = {
  DOCUMENT_EXPORT_FORMATS,
  crc32,
  makeZip,
  buildDocx,
  buildPdf,
  formatMarkdown,
  formatText,
  formatProjection,
  createDocumentExportService,
  exportDocument,
  atomicWrite,
  assertSafeOutputPath,
};
