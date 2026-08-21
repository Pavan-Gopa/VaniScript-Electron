'use strict';

// Deterministic byte fixtures for DOC-01 golden import tests.
//
// Each builder returns a real, well-formed document in the target format so
// the import pipeline is exercised end-to-end (ZIP/XML for DOCX, object/stream
// scan for PDF, RTF tokenization, MD/TXT line parsing). Fixtures are produced
// by hand (no external generator) so the golden outputs are reproducible.

const zlib = require('node:zlib');

// --- Minimal stored (uncompressed) ZIP writer --------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method 0 (stored)
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, eocd]);
}

// --- Format builders ---------------------------------------------------------

function buildDocx() {
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>This is bold.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>This is italic.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Plain with </w:t></w:r><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>bold italic</w:t></w:r><w:r><w:t> tail.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
    'utf8',
  );
  const headerXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>',
    'utf8',
  );
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/header1.xml', data: headerXml },
  ]);
}

function buildPdf() {
  const content =
    'BT /F1 12 Tf 72 720 Td (Hello from PDF.) Tj 0 -18 Td (Second line here.) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  // Minimal xref (not used by our tolerant scanner, but keeps it a valid-ish PDF).
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((o) => {
    pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function buildRtf() {
  return Buffer.from(
    '{\\rtf1\\ansi{\\fonttbl\\f0\\fnil Helvetica;}\\viewkind4\\doc\\para' +
      '{\\b Bold line.\\b0}\\par' +
      '{\\i Italic line.\\i0}\\par ' +
      'Plain line.\\par}',
    'latin1',
  );
}

function buildTxt() {
  return Buffer.from('Hello world.\n\nSecond paragraph here.\n', 'utf8');
}

function buildMd() {
  return Buffer.from(
    '# Title Heading\n' +
      '\n' +
      'A **bold** and *italic* sentence.\n' +
      '\n' +
      '> A quoted block.\n' +
      '\n' +
      '- one\n' +
      '- two\n' +
      '\n' +
      '| Col1 | Col2 |\n' +
      '| --- | --- |\n' +
      '| a | b |\n' +
      '\n' +
      '```js\n' +
      'code here\n' +
      '```\n',
    'utf8',
  );
}

const BUILDERS = {
  docx: buildDocx,
  pdf: buildPdf,
  rtf: buildRtf,
  txt: buildTxt,
  md: buildMd,
};

/** @returns {{ buffer: Buffer, fileName: string, assetRef: string }} */
function getFixture(format) {
  const builder = BUILDERS[format];
  if (!builder) throw new Error(`unknown fixture format: ${format}`);
  return {
    buffer: builder(),
    fileName: `sample.${format}`,
    assetRef: `asset://golden/${format}`,
  };
}

module.exports = { getFixture, makeZip, BUILDERS };
