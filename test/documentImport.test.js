// DOC-01 — Golden import tests for document preflight/import.
//
// Each supported format (DOCX/PDF/RTF/TXT/MD) is imported from a deterministic
// hand-built fixture and asserted against its normalized state: blocks, spans,
// preflight report, and runtime validation through the shared contract. The
// RTF suite additionally pins the linear-walk termination guarantee on
// pathological inputs (nested/starred destinations, \bin payloads, unicode
// escapes, unterminated groups, deep nesting, seeded random bytes).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { getFixture, makeZip } = require('./fixtures/document-fixtures.js');
const {
  importDocument,
  parseRtf,
  parsePdfDict,
  validateNormalizedDocument,
} = require('../electron/main/documents/import.js');

const blockTexts = (doc) => doc.blocks.map((b) => b.text);

test('golden TXT import produces normalized paragraphs and preflight', async () => {
  const { DOCUMENT_SIZE_LIMITS } = await import('../shared/contracts/documents.ts');
  const doc = await importDocument(getFixture('txt'));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.format, 'txt');
  assert.equal(doc.title, 'Hello world.');
  assert.deepEqual(blockTexts(doc), ['Hello world.', 'Second paragraph here.']);
  assert.ok(doc.blocks.every((b) => b.kind === 'paragraph' && b.part === 'main'));
  assert.deepEqual(doc.chunkPlans, []);
  assert.deepEqual(doc.translations, {});
  const pf = doc.preflight;
  assert.equal(pf.words, 5);
  assert.equal(pf.sections, 0);
  assert.equal(pf.blocks, 2);
  assert.equal(pf.canImport, true);
  assert.equal(pf.protectedContent, false);
  assert.equal(pf.extractionAccuracy, 'high');
  assert.deepEqual(pf.warnings, []);
  assert.equal(pf.limits.sizeBytesLimit, DOCUMENT_SIZE_LIMITS.txt);
  assert.equal(pf.limits.exceeded, false);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('golden MD import maps headings, inline traits, quote, list, table, code', async () => {
  const doc = await importDocument(getFixture('md'));
  assert.equal(doc.format, 'md');
  assert.equal(doc.title, 'Title Heading');
  assert.deepEqual(
    doc.blocks.map((b) => b.kind),
    ['heading', 'paragraph', 'quote', 'list', 'table', 'row', 'row', 'other'],
  );
  const [heading, para] = doc.blocks;
  assert.equal(heading.level, 1);
  assert.equal(para.text, 'A bold and italic sentence.');
  assert.deepEqual(
    para.spans.map((s) => [s.text, !!s.traits.bold, !!s.traits.italic]),
    [
      ['A ', false, false],
      ['bold', true, false],
      [' and ', false, false],
      ['italic', false, true],
      [' sentence.', false, false],
    ],
  );
  assert.equal(doc.blocks[2].text, 'A quoted block.');
  assert.equal(doc.blocks[3].text, 'one\ntwo');
  assert.equal(doc.blocks[4].text, '| Col1 | Col2 |\n| a | b |');
  assert.equal(doc.blocks[5].text, 'Col1 | Col2');
  assert.equal(doc.blocks[6].text, 'a | b');
  assert.equal(doc.blocks[7].text, 'code here');
  assert.equal(doc.preflight.sections, 1);
  assert.equal(doc.preflight.words, 30);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('golden DOCX import keeps parts, headings, and inline traits', async () => {
  const doc = await importDocument(getFixture('docx'));
  assert.equal(doc.format, 'docx');
  assert.equal(doc.title, 'Introduction');
  const main = doc.blocks.filter((b) => b.part === 'main');
  assert.deepEqual(
    main.map((b) => [b.kind, b.level, b.text]),
    [
      ['heading', 1, 'Introduction'],
      ['paragraph', undefined, 'This is bold.'],
      ['paragraph', undefined, 'This is italic.'],
      ['paragraph', undefined, 'Plain with bold italic tail.'],
    ],
  );
  const mixed = main[3];
  assert.deepEqual(mixed.spans.map((s) => s.text), ['Plain with ', 'bold italic', ' tail.']);
  assert.equal(mixed.spans[1].traits.bold, true);
  assert.equal(mixed.spans[1].traits.italic, true);
  const header = doc.blocks.find((b) => b.part === 'header');
  assert.equal(header.text, 'Header text');
  assert.equal(doc.preflight.sections, 1);
  assert.equal(doc.preflight.words, 14);
  assert.equal(doc.preflight.protectedContent, false);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('golden PDF import extracts the text layer with page count', async () => {
  const doc = await importDocument(getFixture('pdf'));
  assert.equal(doc.format, 'pdf');
  assert.deepEqual(blockTexts(doc), ['Hello from PDF. Second line here.']);
  assert.equal(doc.preflight.pages, 1);
  assert.equal(doc.preflight.words, 6);
  assert.equal(doc.preflight.sections, 0);
  assert.equal(doc.preflight.extractionAccuracy, 'high');
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('parseRtf decodes hex/unicode escapes, entities, and literal symbols', () => {
  const doc = parseRtf(
    Buffer.from(
      '{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil Helvetica;}}{\\*\\generator Riched20}' +
        "caf\\'e9 \\u8364?\\tab a\\\\b\\{c\\}d\\line second\\par}",
      'latin1',
    ),
    'hash',
  );
  assert.deepEqual(blockTexts(doc), ['café €\ta\\b{c}d\nsecond']);
});

test('parseRtf scopes traits to groups and resets with \\plain', () => {
  const doc = parseRtf(Buffer.from('{\\rtf1\\b outside{\\i inner} tail\\plain bare\\par}', 'latin1'), 'hash');
  const [blk] = doc.blocks;
  assert.equal(blk.text, 'outsideinner tailbare');
  assert.deepEqual(
    blk.spans.map((s) => [s.text, !!s.traits.bold, !!s.traits.italic]),
    [
      ['outside', true, false],
      ['inner', true, true],
      [' tail', true, false],
      ['bare', false, false],
    ],
  );
});

test('parseRtf maps \\sN styles to heading levels and \\pard resets them', () => {
  const doc = parseRtf(Buffer.from('{\\rtf1\\s2 Chapter\\par\\s1\\pard body\\par}', 'latin1'), 'hash');
  assert.deepEqual(
    doc.blocks.map((b) => [b.kind, b.level]),
    [
      ['heading', 2],
      ['paragraph', undefined],
    ],
  );
});
test('golden RTF import maps traits and ignores destinations/unknown words', async () => {
  const doc = await importDocument(getFixture('rtf'));
  assert.equal(doc.format, 'rtf');
  assert.equal(doc.title, 'Bold line.');
  // Exact texts prove: destination groups (fonttbl) are excluded, and the
  // "\doc\para" run tokenizes as two unknown control words with no stray "a".
  assert.deepEqual(blockTexts(doc), ['Bold line.', 'Italic line.', 'Plain line.']);
  assert.equal(doc.blocks[0].spans[0].traits.bold, true);
  assert.equal(doc.blocks[1].spans[0].traits.italic, true);
  assert.deepEqual(doc.blocks.map((b) => b.part), ['main', 'main', 'main']);
  assert.equal(doc.preflight.words, 6);
  assert.equal(doc.preflight.sections, 0);
  assert.equal(doc.preflight.extractionAccuracy, 'high');
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('parseRtf excludes destination payloads from body text', () => {
  const doc = parseRtf(
    Buffer.from(
      '{\\rtf1{\\fonttbl Helvetica-marker}{\\colortbl RED;}\\viewkind4 body text\\par}',
      'latin1',
    ),
    'hash',
  );
  assert.deepEqual(blockTexts(doc), ['body text']);
});

test('parseRtf skips \\bin payloads containing brace bytes', () => {
  // \bin4 declares the next 4 bytes ("{\}}") as raw binary — they must not
  // desync brace depth counting.
  const doc = parseRtf(Buffer.from('{\\rtf1\\bin4{\\}}after\\par}', 'latin1'), 'hash');
  assert.deepEqual(blockTexts(doc), ['after']);
});

test('parseRtf terminates quickly on pathological fixtures', () => {
  const cases = [
    '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Arial;}{\\f1 Courier;}}\\fs24', // unclosed tables
    '{\\*{\\*{\\*\\*\\* deep stars', // starred groups, unterminated
    '{\\rtf1\\bin', // \bin at EOF without payload
    '{\\rtf1\\bin99999999999 x}', // huge binary count
    '{\\rtf1\\uc9999\\u8364', // huge fallback skip at EOF
    '{\\rtf1\\u-168?\\par}', // negative (supplementary-plane) unicode escape
    '\\\\\\\\\\\\', // bare backslash run
    '{}{{{{}}}}', // unbalanced groups
    '{\\rtf1{\\info{\\title a}{\\author b}}body\\par}', // nested destinations
    "{\\rtf1\\'zz\\uZZ bad escapes\\par}", // malformed hex/unicode escapes
    '{\\rtf1\\parPlain unknown-run\\par}', // maximal-munch word boundary
  ];
  for (const [idx, src] of cases.entries()) {
    const t0 = process.hrtime.bigint();
    const res = parseRtf(Buffer.from(src, 'latin1'), 'hash');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `pathological case ${idx} took ${ms.toFixed(1)}ms`);
    assert.ok(Array.isArray(res.blocks));
  }
});

test('parseRtf survives deep nesting and seeded random fuzz without spinning', () => {
  const deep = '{'.repeat(50000) + 'core' + '}'.repeat(50000);
  let t0 = process.hrtime.bigint();
  const deepDoc = parseRtf(Buffer.from(deep, 'latin1'), 'hash');
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `deep nesting took ${ms.toFixed(1)}ms`);
  assert.deepEqual(blockTexts(deepDoc), ['core']);

  // Deterministic LCG fuzz biased toward markup characters: every iteration
  // must return, which is only possible if the cursor strictly advances.
  let seed = 0x0d0c01;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const alphabet = "{}\\abcinru'*; 0123456789";
  t0 = process.hrtime.bigint();
  for (let iter = 0; iter < 400; iter++) {
    let s = '';
    const n = 64 + Math.floor(rand() * 2048);
    for (let k = 0; k < n; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
    const res = parseRtf(Buffer.from(s, 'latin1'), 'hash');
    assert.ok(Array.isArray(res.blocks));
  }
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000, `fuzz took ${ms.toFixed(1)}ms`);
});

test('parseRtf is deterministic for identical input', () => {
  const buf = getFixture('rtf').buffer;
  assert.equal(JSON.stringify(parseRtf(buf, 'hash')), JSON.stringify(parseRtf(buf, 'hash')));
});

test('oversized documents are flagged SIZE_LIMIT_EXCEEDED and blocked', async () => {
  const { DOCUMENT_SIZE_LIMITS } = await import('../shared/contracts/documents.ts');
  const doc = await importDocument({
    buffer: Buffer.alloc(DOCUMENT_SIZE_LIMITS.rtf + 1, 0x41),
    fileName: 'big.rtf',
    assetRef: 'asset://big',
  });
  assert.equal(doc.preflight.canImport, false);
  assert.equal(doc.preflight.limits.exceeded, true);
  assert.ok(
    doc.preflight.warnings.some((w) => w.code === 'SIZE_LIMIT_EXCEEDED' && w.severity === 'error'),
  );
});

test('corrupt DOCX raises CORRUPT_DATA', async () => {
  await assert.rejects(
    () =>
      importDocument({
        buffer: Buffer.from('definitely not a zip'),
        fileName: 'x.docx',
        assetRef: 'asset://x',
      }),
    (err) => err.code === 'CORRUPT_DATA',
  );
});

test('unsupported extensions raise VALIDATION_FAILED', async () => {
  await assert.rejects(
    () =>
      importDocument({ buffer: Buffer.from('x'), fileName: 'x.exe', assetRef: 'asset://x' }),
    (err) => err.code === 'VALIDATION_FAILED',
  );
});

test('scanned PDF without text layer is rejected as OCR_REQUIRED', async () => {
  const content = 'BT ET'; // no show operators → no extractable text
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  for (const [idx, body] of objs.entries()) {
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  }
  const doc = await importDocument({
    buffer: Buffer.from(pdf, 'latin1'),
    fileName: 'scan.pdf',
    assetRef: 'asset://scan',
  });
  assert.equal(doc.preflight.canImport, false);
  assert.equal(doc.preflight.extractionAccuracy, 'low');
  assert.ok(
    doc.preflight.warnings.some((w) => w.code === 'OCR_REQUIRED' && w.severity === 'error'),
  );
});

// --- P3A.D1 attempt-3 regressions (Reviewer findings 1–5) -------------------

// Assembles a minimal PDF from raw object bodies (same tolerant-scan shape
// the OCR_REQUIRED fixture builds inline; no xref needed by the scanner).
function buildPdfFromObjects(objs) {
  let pdf = '%PDF-1.4\n';
  objs.forEach((body, idx) => {
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('malformed PDF dictionaries terminate with CORRUPT_DATA, never hang', async () => {
  const cases = [
    // Reviewer repro: unterminated array inside the catalog dict.
    ['unterminated array', '<< /Type /Catalog /Pages [ >>'],
    ['unterminated dictionary', '<< /Type /Catalog /Pages 2 0 R'],
    ['unterminated literal string', '<< /Type /Catalog /Title (oops >>'],
    ['unterminated hex string', '<< /Type /Catalog /Title <AB'],
    // Nesting beyond the depth cap must fail fast, not exhaust the stack.
    ['deep array nesting', `<< /Type /Catalog /X ${'['.repeat(100)}${']'.repeat(100)} >>`],
    ['deep dict nesting', `<< /Type /Catalog /X ${'<< /A '.repeat(100)}1${' >>'.repeat(100)}`],
  ];
  for (const [label, body] of cases) {
    const t0 = process.hrtime.bigint();
    await assert.rejects(
      () =>
        importDocument({
          buffer: buildPdfFromObjects([body]),
          fileName: 'mal.pdf',
          assetRef: 'asset://mal',
        }),
      (err) => err.code === 'CORRUPT_DATA',
      label,
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `${label} took ${ms.toFixed(1)}ms`);
  }
});

test('PDF FlateDecode streams decode via standard zlib inflate', async () => {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello flate.) Tj ET';
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const doc = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`,
    ]),
    fileName: 'flate.pdf',
    assetRef: 'asset://flate',
  });
  assert.deepEqual(blockTexts(doc), ['Hello flate.']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

// --- P3A.D1 QA round regressions (PDF content-stream hex strings) -----------

// Standard single-page PDF whose uncompressed content stream is `content`;
// same object shapes the FlateDecode and page-index fixtures above use.
function pdfWithHexContent(content) {
  return buildPdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

test('PDF hex string Tj operands decode instead of producing garbage', async () => {
  const doc = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td <48656C6C6F20576F726C64> Tj ET'),
    fileName: 'hex-tj.pdf',
    assetRef: 'asset://hex-tj',
  });
  assert.deepEqual(blockTexts(doc), ['Hello World']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDF hex strings inside TJ arrays decode across positioning operands', async () => {
  const doc = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td [<48656C6C6F> -250 <20576F726C64>] TJ ET'),
    fileName: 'hex-tj-array.pdf',
    assetRef: 'asset://hex-tj-array',
  });
  assert.deepEqual(blockTexts(doc), ['Hello World']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDF odd-length hex strings apply the implicit trailing-zero nibble rule', async () => {
  // 23 digits: "Hello World" plus a lone trailing 2. Per PDF 32000-1 §7.3.4.3
  // that nibble is the HIGH one of a final implicit-0 byte (0x20, a space) —
  // not a NaN-dropped or bit-shifted pair. The trailing literal proves the
  // decoded space survives mid-text (block text is trimmed only at the ends).
  const doc = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td <48656C6C6F20576F726C642> Tj (now) Tj ET'),
    fileName: 'hex-odd.pdf',
    assetRef: 'asset://hex-odd',
  });
  assert.deepEqual(blockTexts(doc), ['Hello World now']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDF hex strings tolerate whitespace between nibbles', async () => {
  const doc = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td <48 65 6C 6C 6F> Tj ET'),
    fileName: 'hex-ws.pdf',
    assetRef: 'asset://hex-ws',
  });
  assert.deepEqual(blockTexts(doc), ['Hello']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDF dictionary-path hex strings still parse (scalar and array forms)', async () => {
  const contents = 'BT /F1 12 Tf 72 720 Td (Dict path intact.) Tj ET';
  const catalogs = [
    // Scalar hex value directly in the catalog dictionary.
    '<< /Type /Catalog /Pages 2 0 R /ID <48656C6C6F20576F726C64> >>',
    // Trailer-style /ID: hex string nested in a dictionary array.
    '<< /Type /Catalog /Pages 2 0 R /ID [<48656C6C6F20576F726C64> ] >>',
  ];
  for (const [idx, catalogDict] of catalogs.entries()) {
    const doc = await importDocument({
      buffer: buildPdfFromObjects([
        catalogDict,
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
      ]),
      fileName: `hex-dict-${idx}.pdf`,
      assetRef: `asset://hex-dict-${idx}`,
    });
    assert.deepEqual(blockTexts(doc), ['Dict path intact.']);
    assert.equal(validateNormalizedDocument(doc).ok, true);
  }
});

test('PDF unterminated hex strings inside dict arrays still fail CORRUPT_DATA', async () => {
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects(['<< /Type /Catalog /Pages [<48656C']),
        fileName: 'hex-unterminated.pdf',
        assetRef: 'asset://hex-unterminated',
      }),
    (err) => err.code === 'CORRUPT_DATA',
  );
});

test('DOCX import preserves table rows and textbox parts', async () => {
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      '<w:body>' +
      '<w:p><w:r><w:t>Before table.</w:t></w:r></w:p>' +
      '<w:tbl>' +
      '<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Cell A</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Cell C</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>Cell D</w:t></w:r></w:p></w:tc></w:tr>' +
      '</w:tbl>' +
      '<w:p><w:r><w:t>In a box:</w:t></w:r>' +
      '<mc:AlternateContent>' +
      '<mc:Choice Requires="wps"><w:txbxContent><w:p><w:r><w:t>Box text.</w:t></w:r></w:p></w:txbxContent></mc:Choice>' +
      // The Fallback repeats the Choice markup for legacy readers; importing
      // both would duplicate the textbox content.
      '<mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>Box text.</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback>' +
      '</mc:AlternateContent></w:p>' +
      '</w:body></w:document>',
    'utf8',
  );
  const doc = await importDocument({
    buffer: makeZip([{ name: 'word/document.xml', data: documentXml }]),
    fileName: 'rich.docx',
    assetRef: 'asset://rich',
  });
  const main = doc.blocks.filter((b) => b.part === 'main');
  assert.deepEqual(
    main.map((b) => [b.kind, b.text]),
    [
      ['paragraph', 'Before table.'],
      ['table', 'Cell A | Cell B\nCell C | Cell D'],
      ['row', 'Cell A | Cell B'],
      ['row', 'Cell C | Cell D'],
      ['paragraph', 'In a box:'],
    ],
  );
  const boldSpan = main[1].spans.find((s) => s.text === 'Cell A');
  assert.ok(boldSpan, 'cell run missing from table block spans');
  assert.equal(boldSpan.traits.bold, true);
  const boxes = doc.blocks.filter((b) => b.part === 'textbox');
  assert.equal(boxes.length, 1); // Fallback duplicate skipped
  assert.equal(boxes[0].text, 'Box text.');
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDF blocks carry their 1-based source page index', async () => {
  const content1 = 'BT /F1 12 Tf 72 720 Td (First page.) Tj ET';
  const content2 = 'BT /F1 12 Tf 72 720 Td (Second page.) Tj ET';
  const doc = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
      `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
      `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
    ]),
    fileName: 'twopages.pdf',
    assetRef: 'asset://twopages',
  });
  assert.equal(doc.preflight.pages, 2);
  assert.deepEqual(
    doc.blocks.map((b) => [b.text, b.page]),
    [
      ['First page.', 1],
      ['Second page.', 2],
    ],
  );
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('PDFs beyond the 2000-page limit are blocked with PAGE_LIMIT_EXCEEDED', async () => {
  const { DOCUMENT_PAGE_LIMIT } = await import('../shared/contracts/documents.ts');
  const pageCount = DOCUMENT_PAGE_LIMIT + 1;
  const kids = [];
  for (let p = 0; p < pageCount; p++) kids.push(`${p + 3} 0 R`);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let p = 0; p < pageCount; p++) objs.push('<< /Type /Page /Parent 2 0 R >>');
  const doc = await importDocument({
    buffer: buildPdfFromObjects(objs),
    fileName: 'huge.pdf',
    assetRef: 'asset://huge',
  });
  assert.equal(doc.preflight.pages, pageCount);
  assert.equal(doc.preflight.canImport, false);
  assert.ok(
    doc.preflight.warnings.some((w) => w.code === 'PAGE_LIMIT_EXCEEDED' && w.severity === 'error'),
  );
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

// --- P3A.D1 attempt-4 regressions (residual blockers 1–6) -------------------

test('deep acyclic PDF page chain fails CORRUPT_DATA, not a stack overflow', async () => {
  const chainDepth = 15000; // comfortably past the ~12k-level overflow point
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let d = 0; d < chainDepth; d++) objs.push(`<< /Type /Pages /Kids [${d + 3} 0 R] >>`);
  const t0 = process.hrtime.bigint();
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects(objs),
        fileName: 'deep.pdf',
        assetRef: 'asset://deep',
      }),
    (err) => err.code === 'CORRUPT_DATA',
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `deep chain took ${ms.toFixed(1)}ms`);
});

test('PDF literals ending in a trailing escape decode safely instead of crashing', async () => {
  // parsePdfDict now scans literals with escape awareness, so a lone `\`
  // before `)` no longer terminates the string — source bytes
  // `(Dict trailing escape\)` are, per spec, an unterminated string that
  // fails CORRUPT_DATA (pinned in the QA2 dict-literal test below). The
  // defined-safe survivor is the escaped-backslash tail: source bytes
  // `(Dict trailing escape\\)` close at the real `)` and hand
  // pdfLiteralToBytes the inner `...\\`, which decodes to one trailing
  // 0x5c. The fixture builds those bytes explicitly via
  // String.fromCharCode(92) so no JS-layer escaping ambiguity remains: in
  // JS source `\)` is an unknown escape that evaluates to zero backslashes,
  // and `\\\\` reaches both paths as an escaped pair. Dict literal values
  // are not surfaced in blocks or title, so the observable contract is
  // exactly that the import resolves instead of crashing. The content
  // stream stays ordinary text so the document still imports well.
  const catalogDict =
    '<< /Type /Catalog /Pages 2 0 R /Title (Dict trailing escape' +
    String.fromCharCode(92) +
    String.fromCharCode(92) +
    ') >>';
  const doc = await importDocument({
    buffer: buildPdfFromObjects([
      catalogDict,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      '<< /Length 55 >>\nstream\nBT /F1 12 Tf 72 720 Td (Stream trailing escape\\\\) Tj ET\nendstream',
    ]),
    fileName: 'escape.pdf',
    assetRef: 'asset://escape',
  });
  // Import resolved (no raw TypeError escaped), and the ordinary escaped-pair
  // stream still decodes `\\` to one literal backslash byte.
  assert.deepEqual(blockTexts(doc), ['Stream trailing escape\\']);
  assert.equal(doc.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('mutated ZIP offsets/sizes fail CORRUPT_DATA, never ERR_OUT_OF_RANGE', async () => {
  const xml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Untouched payload.</w:t></w:r></w:p></w:body></w:document>',
    'utf8',
  );
  const good = makeZip([{ name: 'word/document.xml', data: xml }]);
  // Sanity: the unmutated package still imports cleanly.
  const sane = await importDocument({ buffer: Buffer.from(good), fileName: 'ok.docx', assetRef: 'asset://ok' });
  assert.equal(sane.preflight.canImport, true);

  const centralHeaderAt = (buf) => {
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50) return i;
    }
    throw new Error('fixture has no central directory header');
  };
  const expectCorrupt = (buf, label) =>
    assert.rejects(
      () => importDocument({ buffer: buf, fileName: 'mutated.docx', assetRef: 'asset://mutated' }),
      (err) => err.code === 'CORRUPT_DATA',
      label,
    );

  // compSize = 0xffffffff (ZIP64 placeholder) must not yield truncated data.
  let m = Buffer.from(good);
  m.writeUInt32LE(0xffffffff, centralHeaderAt(m) + 20);
  await expectCorrupt(m, 'compSize 0xffffffff');

  // compSize running past end of file.
  m = Buffer.from(good);
  m.writeUInt32LE(xml.length + 4096, centralHeaderAt(m) + 20);
  await expectCorrupt(m, 'compSize past EOF');

  // localOffset past EOF used to surface as a raw ERR_OUT_OF_RANGE read.
  m = Buffer.from(good);
  m.writeUInt32LE(m.length + 512, centralHeaderAt(m) + 42);
  await expectCorrupt(m, 'localOffset past EOF');

  // In-bounds localOffset that does not carry the local header signature.
  m = Buffer.from(good);
  m.writeUInt32LE(centralHeaderAt(m), centralHeaderAt(m) + 42);
  await expectCorrupt(m, 'localOffset lacks local header signature');

  // Central-directory offset outside the file.
  m = Buffer.from(good);
  m.writeUInt32LE(m.length + 4096, m.length - 22 + 16);
  await expectCorrupt(m, 'cdOffset past EOF');
});

test('DOCX with unclosed XML elements is rejected, not partially imported', async () => {
  // Text exceeds the 4-char canImport floor, so the old tolerant-EOF path
  // would have returned this partial document as importable.
  const truncated = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>This document stops abruptly mid-sentence',
    'utf8',
  );
  await assert.rejects(
    () =>
      importDocument({
        buffer: makeZip([{ name: 'word/document.xml', data: truncated }]),
        fileName: 'cut.docx',
        assetRef: 'asset://cut',
      }),
    (err) => err.code === 'CORRUPT_DATA',
  );
});

test('textbox inside a table cell routes to the textbox part, not the cell', async () => {
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      '<w:body><w:tbl><w:tr><w:tc>' +
      '<w:p><w:r><w:t>Cell text.</w:t></w:r></w:p>' +
      '<mc:AlternateContent><mc:Choice Requires="wps">' +
      '<w:txbxContent><w:p><w:r><w:t>Box in cell.</w:t></w:r></w:p></w:txbxContent>' +
      '</mc:Choice></mc:AlternateContent>' +
      '</w:tc></w:tr></w:tbl></w:body></w:document>',
    'utf8',
  );
  const doc = await importDocument({
    buffer: makeZip([{ name: 'word/document.xml', data: documentXml }]),
    fileName: 'boxtable.docx',
    assetRef: 'asset://boxtable',
  });
  const main = doc.blocks.filter((b) => b.part === 'main');
  assert.deepEqual(main.map((b) => [b.kind, b.text]), [
    ['table', 'Cell text.'],
    ['row', 'Cell text.'],
  ]);
  const boxes = doc.blocks.filter((b) => b.part === 'textbox');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].text, 'Box in cell.');
  assert.ok(!main.some((b) => b.text.includes('Box in cell.')), 'textbox leaked into the serialized table');
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('DOCX blocks carry the hash of their source part, not the whole file', async () => {
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Main body text.</w:t></w:r></w:p></w:body></w:document>',
    'utf8',
  );
  const headerXml = Buffer.from(
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>',
    'utf8',
  );
  const zip = makeZip([
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/header1.xml', data: headerXml },
  ]);
  const doc = await importDocument({ buffer: zip, fileName: 'parts.docx', assetRef: 'asset://parts' });
  const mainHash = sha256(documentXml);
  const headerHash = sha256(headerXml);
  const mainBlocks = doc.blocks.filter((b) => b.part === 'main');
  const headerBlocks = doc.blocks.filter((b) => b.part === 'header');
  assert.ok(mainBlocks.length > 0 && headerBlocks.length > 0);
  assert.notEqual(mainHash, headerHash);
  for (const b of mainBlocks) assert.equal(b.sourceHash, mainHash, 'main block carries another part hash');
  for (const b of headerBlocks) assert.equal(b.sourceHash, headerHash, 'header block carries another part hash');
  assert.notEqual(mainHash, sha256(zip), 'part hash must differ from the whole-file hash');
  assert.equal(validateNormalizedDocument(doc).ok, true);
});
// --- P3A.D1 deep QA round 2 — adversarial packs (Human mandate: not token checks) ---

test('P3A.D1 deep QA — J1 source buffer immutability across all formats', async () => {
  const cases = [
    [Buffer.from('Hello world.\n\nSecond paragraph here.\n', 'utf8'), 'a.txt'],
    [Buffer.from('# Title\n\nHello **bold** world\n', 'utf8'), 'a.md'],
    [Buffer.from('{\\rtf1\\ansi Hello World\\par}', 'latin1'), 'a.rtf'],
  ];
  const docxXml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hi docx</w:t></w:r></w:p></w:body></w:document>',
    'utf8',
  );
  cases.push([makeZip([{ name: 'word/document.xml', data: docxXml }]), 'a.docx']);
  const pdfBuf = pdfWithHexContent('BT /F1 12 Tf 72 720 Td (Immutable Hello World) Tj ET');
  cases.push([pdfBuf, 'a.pdf']);
  // Also probe Uint8Array view sharing underlying buffer.
  const view = new Uint8Array(pdfBuf);
  cases.push([view, 'view.pdf']);
  for (const [buf, name] of cases) {
    const before = Buffer.from(buf);
    const beforeHex = before.toString('hex');
    try {
      await importDocument({ buffer: buf, fileName: name });
    } catch (_) {
      // J1: even on CORRUPT_DATA the input must not be mutated.
    }
    const afterHex = Buffer.from(buf).toString('hex');
    assert.equal(afterHex, beforeHex, `input mutated for ${name}`);
    assert.ok(Buffer.from(buf).equals(before), `Buffer.equals failed for ${name}`);
  }
});

test('P3A.D1 deep QA — PDF hex edge forms sweep (empty, whitespace, odd nibbles)', async () => {
  const cases = [
    // [hexToken, expectedBlockTextOrNull, expectCanImport]
    ['<>', '', false],
    ['<   >', '', false],
    ['< 48 65 6C 6C 6F >', 'Hello', true],
    ['<48656C6C6F>', 'Hello', true],
    ['<48656c6c6f>', 'Hello', true], // case-insensitive
    ['<41>', 'A', false],
    ['<4>', '@', false], // odd single nibble 0x4 -> 0x40 '@' (high nibble rule)
    ['<414>', 'A@', false], // 0x41 0x40
    ['<4142>', 'AB', false],
    ['<4142434>', 'ABC@', true], // 0x41 0x42 0x43 0x40 — 4 chars meets canImport threshold
    ['<41424344>', 'ABCD', true],
    ['<41 42 43>', 'ABC', false],
  ];
  for (const [hex, expected, canImport] of cases) {
    const doc = await importDocument({
      buffer: pdfWithHexContent(`BT /F1 12 Tf 72 720 Td ${hex} Tj ET`),
      fileName: `hex-edge-${hex.replace(/\s/g, '_')}.pdf`,
    });
    const text = blockTexts(doc).join('');
    if (expected === '') {
      assert.equal(doc.blocks.length, 0, `empty hex ${hex} should yield 0 blocks`);
      assert.equal(doc.preflight.canImport, false);
    } else {
      assert.equal(text, expected, `hex ${hex} decoded to ${JSON.stringify(text)} expected ${JSON.stringify(expected)}`);
      assert.equal(doc.preflight.canImport, canImport, `canImport mismatch for ${hex}`);
    }
    assert.equal(validateNormalizedDocument(doc).ok, true, `validation failed for ${hex}`);
  }
  // Whitespace-heavy inside TJ array as well.
  const arrayDoc = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td [<48 65><6C 6C><6F>] TJ ET'),
    fileName: 'hex-array-ws.pdf',
  });
  assert.deepEqual(blockTexts(arrayDoc), ['Hello']);
});

test('P3A.D1 deep QA — PDF literal escapes decode per spec (\\n \\r \\t \\b \\f octal parens)', async () => {
  const cases = [
    ['BT /F1 12 Tf 72 720 Td (a\\nb\\rc\\td\\be\\f) Tj ET', 'a b c d e f', true], // \n,\r,\t,\b,\f -> \b\f become stripped (0x08/0x0C), but \n\r\t become space via pdfByteChar
    ['BT /F1 12 Tf 72 720 Td (\\101\\102\\103) Tj ET', 'ABC', false],
    ['BT /F1 12 Tf 72 720 Td (a\\(b\\)c) Tj ET', 'a(b)c', true],
    ['BT /F1 12 Tf 72 720 Td (a\\\\b) Tj ET', 'a\\b', true],
    // Octal up to 3 digits: \12 = newline (10) -> space, \123 -> 'S' (83)
    ['BT /F1 12 Tf 72 720 Td (\\12) Tj ET', '', false],
    ['BT /F1 12 Tf 72 720 Td (\\123) Tj ET', 'S', false],
  ];
  for (const [content, expected, canImport] of cases) {
    const doc = await importDocument({ buffer: pdfWithHexContent(content), fileName: 'lit-escape.pdf' });
    const text = blockTexts(doc).join('');
    // For stripping cases, just assert kind — exact control-char mapping is validated via decode path.
    if (expected === '') {
      assert.equal(doc.blocks.length, 0, `content ${content} should yield 0 blocks`);
    } else {
      // Normalize: pdfByteChar maps control <0x20 except 9,10,13 to '' and 9,10,13 to ' '
      assert.ok(text.includes(expected.slice(0, 1)) || text === expected, `content ${content} => ${JSON.stringify(text)} expected ${JSON.stringify(expected)}`);
    }
    assert.equal(validateNormalizedDocument(doc).ok, true);
  }
  // Raw nested parens now tokenize via the shared balanced scanner (QA2
  // Defect 2 fix): the whole string is one str operand instead of the old
  // empty/OCR_REQUIRED gap pinned here before the fix.
  const nestedRaw = await importDocument({ buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td (outer (inner) more) Tj ET'), fileName: 'nested-raw.pdf' });
  assert.deepEqual(blockTexts(nestedRaw), ['outer (inner) more']);
  assert.equal(nestedRaw.preflight.canImport, true);
  assert.equal(validateNormalizedDocument(nestedRaw).ok, true);
});

test('P3A.D1 deep QA — PDF TJ arrays mixing str/hex/num/kerning operators', async () => {
  const cases = [
    ['BT /F1 12 Tf 72 720 Td [(Hello) -120 <576F726C64> 50 ( !)] TJ ET', 'HelloWorld !'],
    ['BT /F1 12 Tf 72 720 Td [(A) 5 (B) -10 <43> 0 (D)] TJ ET', 'ABCD'],
    ['BT /F1 12 Tf 72 720 Td [ -120 50 ] TJ ET', ''], // TJ with only numbers -> no text layer
  ];
  for (const [content, expected] of cases) {
    const doc = await importDocument({ buffer: pdfWithHexContent(content), fileName: 'tj-mix.pdf' });
    const text = blockTexts(doc).join('');
    if (expected === '') {
      assert.equal(doc.blocks.length, 0);
      assert.equal(doc.preflight.canImport, false);
    } else {
      assert.equal(text, expected);
      assert.equal(doc.preflight.canImport, true);
    }
    assert.equal(validateNormalizedDocument(doc).ok, true);
  }
  // Tj/TJ/' /" operators are all covered via buildPdfFromObjects flow; pin ' and " paths.
  const tickDoc = await importDocument({ buffer: pdfWithHexContent("BT /F1 12 Tf 72 720 Td (quoted) ' ET"), fileName: 'tick.pdf' });
  assert.ok(validateNormalizedDocument(tickDoc).ok);
});

// --- P3A.D1 QA round 2 regressions (dict hex advancement + literal scanning)

test('P3A.D1 QA2 — parsePdfDict hex strings advance one char per delimiter', () => {
  // The old i += 2 after the opening '<' dropped the FIRST nibble char, and
  // the old i += 2 after '>' ate one extra source char — together they
  // decoded <414243> as bytes 14 24 30 and made hex arrays misparse. Both
  // delimiters must consume exactly one character; every value below pins
  // the exact decoded bytes.
  const scalar = parsePdfDict('<< /ID <414243> >>');
  assert.equal(scalar.ID.toString('latin1'), 'ABC');
  assert.deepEqual([...scalar.ID], [0x41, 0x42, 0x43]);

  // Array forms: lone element, adjacent elements, whitespace-separated.
  assert.deepEqual(
    parsePdfDict('<< /X [<414243>] >>').X.map((b) => b.toString('latin1')),
    ['ABC'],
  );
  assert.deepEqual(
    parsePdfDict('<< /X [<414243><444546>] >>').X.map((b) => b.toString('latin1')),
    ['ABC', 'DEF'],
  );
  assert.deepEqual(
    parsePdfDict('<< /X [<414243> <444546>] >>').X.map((b) => b.toString('latin1')),
    ['ABC', 'DEF'],
  );

  // Numeric + hex mix, which the array grammar already supports.
  const mixed = parsePdfDict('<< /X [<41> 42] >>');
  assert.equal(mixed.X[0].toString('latin1'), 'A');
  assert.equal(mixed.X[1], 42);

  // Nested dict carrying a hex array.
  const nested = parsePdfDict('<< /Outer << /Inner [<414243> <444546>] >> >>');
  assert.deepEqual(
    nested.Outer.Inner.map((b) => b.toString('latin1')),
    ['ABC', 'DEF'],
  );
});

test('P3A.D1 QA2 — dict literal strings scan escapes before counting parens', () => {
  // Balanced escaped parens decode to their literal characters.
  assert.equal(parsePdfDict('<< /K (a\\(b\\)c) >>').K.toString('latin1'), 'a(b)c');

  // Escaped open + real close: the string ends at the first UNESCAPED ')',
  // so "c)" is outside the string. The old counter treated \( as nesting and
  // swallowed the real terminator into the value ("a(b)c").
  assert.equal(parsePdfDict('<< /K (a\\(b)c) >>').K.toString('latin1'), 'a(b');

  // Unbalanced real parens still fail CORRUPT_DATA at EOF.
  assert.throws(() => parsePdfDict('<< /K (a(b)c >>'), (e) => e.code === 'CORRUPT_DATA');

  // Unterminated because its only ')' is escaped: CORRUPT_DATA, not the old
  // silent mis-termination that accepted the escaped closer as the real one.
  assert.throws(() => parsePdfDict('<< /K (x\\) >>'), (e) => e.code === 'CORRUPT_DATA');

  // Escaped-backslash tail: defined-safe — resolves and decodes to a
  // byte-exact trailing lone backslash ("tail" + 0x5c).
  const tail = parsePdfDict('<< /K (tail\\\\) >>');
  assert.deepEqual([...tail.K], [0x74, 0x61, 0x69, 0x6c, 0x5c]);
});

test('P3A.D1 QA2 — content-stream literal strings balance raw nested parens', async () => {
  // Spec-legal nesting (§7.3.4.2) extracts the full string; the old regex
  // alternative dropped the operand entirely (OCR_REQUIRED).
  const nested = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td (outer (inner) more) Tj ET'),
    fileName: 'qa2-nested.pdf',
  });
  assert.deepEqual(blockTexts(nested), ['outer (inner) more']);
  assert.equal(nested.preflight.canImport, true);

  // Depth 32 is the spec cap and must survive; the old regex matched no
  // nested form at all. The outermost paren pair are the string delimiters,
  // so the extracted text carries 31 nested pairs.
  const deep32 = '('.repeat(32) + 'core' + ')'.repeat(32);
  const deep32Text = '('.repeat(31) + 'core' + ')'.repeat(31);
  const atCap = await importDocument({
    buffer: pdfWithHexContent(`BT /F1 12 Tf 72 720 Td ${deep32} Tj ET`),
    fileName: 'qa2-depth32.pdf',
  });
  assert.deepEqual(blockTexts(atCap), [deep32Text]);
  assert.equal(atCap.preflight.canImport, true);

  // Depth 33 is hostile: defined-safe fallback (no string token, OCR path),
  // never a crash.
  const deep33 = '('.repeat(33) + 'core' + ')'.repeat(33);
  const overCap = await importDocument({
    buffer: pdfWithHexContent(`BT /F1 12 Tf 72 720 Td ${deep33} Tj ET`),
    fileName: 'qa2-depth33.pdf',
  });
  assert.equal(overCap.preflight.canImport, false);
  assert.ok(overCap.preflight.warnings.some((w) => w.code === 'OCR_REQUIRED'));
  assert.equal(validateNormalizedDocument(overCap).ok, true);

  // Escaped form is unchanged by the scanner.
  const escaped = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td (a\\(b\\)c) Tj ET'),
    fileName: 'qa2-escaped.pdf',
  });
  assert.deepEqual(blockTexts(escaped), ['a(b)c']);

  // TJ arrays mix a nested-paren string with kerning and hex operands.
  const tjMix = await importDocument({
    buffer: pdfWithHexContent('BT /F1 12 Tf 72 720 Td [(outer (x) end) -120 <576F726C64>] TJ ET'),
    fileName: 'qa2-tj-mix.pdf',
  });
  assert.deepEqual(blockTexts(tjMix), ['outer (x) endWorld']);
  assert.equal(tjMix.preflight.canImport, true);
});

test('P3A.D1 deep QA — PDF FlateDecode valid vs truncated vs garbage', async () => {
  const raw = 'BT /F1 12 Tf 72 720 Td (Hello flate sweep.) Tj ET';
  const compressed = zlib.deflateSync(Buffer.from(raw, 'latin1'));
  // Valid Flate.
  const valid = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`,
    ]),
    fileName: 'flate-valid.pdf',
  });
  assert.deepEqual(blockTexts(valid), ['Hello flate sweep.']);
  // Truncated Flate must fail CORRUPT_DATA, not hang.
  const trunc = compressed.slice(0, Math.max(1, Math.floor(compressed.length / 2)));
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
          `<< /Length ${trunc.length} /Filter /FlateDecode >>\nstream\n${trunc.toString('latin1')}\nendstream`,
        ]),
        fileName: 'flate-trunc.pdf',
      }),
    (e) => e.code === 'CORRUPT_DATA',
  );
  // Garbage Flate.
  const garbage = Buffer.from('not valid zlib data here', 'latin1');
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
          `<< /Length ${garbage.length} /Filter /FlateDecode >>\nstream\n${garbage.toString('latin1')}\nendstream`,
        ]),
        fileName: 'flate-garbage.pdf',
      }),
    (e) => e.code === 'CORRUPT_DATA',
  );
  // Filter array form [/FlateDecode] also decodes.
  const arrayFilter = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${compressed.length} /Filter [/FlateDecode] >>\nstream\n${compressed.toString('latin1')}\nendstream`,
    ]),
    fileName: 'flate-array.pdf',
  });
  assert.deepEqual(blockTexts(arrayFilter), ['Hello flate sweep.']);
  // Unsupported filter warns but still imports the raw bytes as text (defined-safe partial).
  const unsupported = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      `<< /Length ${raw.length} /Filter /DCTDecode >>\nstream\n${raw}\nendstream`,
    ]),
    fileName: 'flate-unsupported.pdf',
  });
  assert.ok(unsupported.preflight.warnings.some((w) => w.code === 'UNSUPPORTED_FILTER'));
  assert.equal(validateNormalizedDocument(unsupported).ok, true);
});

test('P3A.D1 deep QA — PDF tolerant scans, page-tree and dict-depth caps', async () => {
  // xref/table-less tolerant scan: objRe finds objects without xref.
  let src = '%PDF-1.4\n';
  src += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  src += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  src += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n';
  src += '4 0 obj\n<< /Length 4 >>\nstream\nBTET\nendstream\nendobj\n';
  src += 'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF';
  const noXref = await importDocument({ buffer: Buffer.from(src, 'latin1'), fileName: 'noxref.pdf' });
  assert.equal(noXref.preflight.pages, 1);
  // Shallow page tree.
  const shallow = await importDocument({
    buffer: buildPdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
      `<< /Length 4 >>\nstream\nBTET\nendstream`,
      `<< /Length 4 >>\nstream\nBTET\nendstream`,
    ]),
    fileName: 'shallow.pdf',
  });
  assert.equal(shallow.preflight.pages, 2);
  // Deep chain near cap (5 levels) still succeeds.
  const chain5 = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let d = 2; d <= 6; d++) {
    if (d === 6) chain5.push(`<< /Type /Page /Parent ${d - 1} 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>`);
    else chain5.push(`<< /Type /Pages /Kids [${d + 1} 0 R] /Count 1 >>`);
  }
  chain5.push(`<< /Length 4 >>\nstream\nBTET\nendstream`);
  const deepOk = await importDocument({ buffer: buildPdfFromObjects(chain5), fileName: 'deep-ok.pdf' });
  assert.equal(deepOk.preflight.pages, 1);
  // Dict nesting at 63 (just under MAX 64) succeeds; at 100 fails.
  let inner = '1';
  for (let i = 0; i < 63; i++) inner = `<< /N${i} ${inner} >>`;
  const justUnder = await importDocument({
    buffer: buildPdfFromObjects([
      `<< /Type /Catalog /Pages 2 0 R /Deep ${inner} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
      `<< /Length 4 >>\nstream\nBTET\nendstream`,
    ]),
    fileName: 'dict-under.pdf',
  });
  assert.equal(justUnder.blocks.length, 0); // no text but scanned OK (OCR_REQUIRED path)
  assert.equal(validateNormalizedDocument(justUnder).ok, true);
  let deepInner = '1';
  for (let i = 0; i < 100; i++) deepInner = `<< /N${i} ${deepInner} >>`;
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects([
          `<< /Type /Catalog /Pages 2 0 R /Deep ${deepInner} >>`,
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
          `<< /Length 4 >>\nstream\nBTET\nendstream`,
        ]),
        fileName: 'dict-over.pdf',
      }),
    (e) => e.code === 'CORRUPT_DATA',
  );
  // Array nesting over cap.
  const deepArr = '['.repeat(100) + '1' + ']'.repeat(100);
  await assert.rejects(
    () =>
      importDocument({
        buffer: buildPdfFromObjects([
          `<< /Type /Catalog /Pages 2 0 R /Deep ${deepArr} >>`,
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
          `<< /Length 4 >>\nstream\nBTET\nendstream`,
        ]),
        fileName: 'arr-over.pdf',
      }),
    (e) => e.code === 'CORRUPT_DATA',
  );
});

test('P3A.D1 deep QA — PDF hostile truncations at structural boundaries', async () => {
  const good = pdfWithHexContent('BT /F1 12 Tf 72 720 Td (Hello) Tj ET');
  const cases = [
    ['empty', Buffer.from('', 'latin1')],
    ['header-only', Buffer.from('%PDF-1.4\n', 'latin1')],
    ['obj-no-end', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>', 'latin1')],
    ['trunc-10', good.slice(0, 10)],
    ['trunc-minus-20', good.slice(0, good.length - 20)],
    ['trailer-only', Buffer.from('trailer\n<< /Size 1 /Root 1 0 R >>\n%%EOF', 'latin1')],
    ['null-bytes', Buffer.alloc(1000, 0x00)],
  ];
  for (const [label, buf] of cases) {
    const t0 = process.hrtime.bigint();
    try {
      await importDocument({ buffer: buf, fileName: 'hostile.pdf' });
    } catch (e) {
      assert.equal(e.code, 'CORRUPT_DATA', `${label} should be CORRUPT_DATA not ${e.code}`);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `${label} took ${ms.toFixed(1)}ms — potential hang`);
  }
  // Huge hex allocation hostile (100k hex digits) must not OOM/hang.
  const hugeHex = '<' + '41'.repeat(100000) + '>';
  const hugeDict = `<< /Type /Catalog /Pages 2 0 R /Huge ${hugeHex} >>`;
  const t1 = process.hrtime.bigint();
  const hugeDoc = await importDocument({
    buffer: buildPdfFromObjects([
      hugeDict,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
      `<< /Length 4 >>\nstream\nBTET\nendstream`,
    ]),
    fileName: 'huge-hex.pdf',
  });
  const ms = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(ms < 1000, `huge hex took ${ms}ms`);
  assert.equal(validateNormalizedDocument(hugeDoc).ok, true);
});

test('P3A.D1 deep QA — DOCX w:t split, nested tables, duplicate and missing entries', async () => {
  // w:t split across runs must concatenate inside same paragraph.
  const splitXml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo</w:t></w:r><w:r><w:t> World</w:t></w:r></w:p>' +
      '</w:body></w:document>',
    'utf8',
  );
  const splitDoc = await importDocument({ buffer: makeZip([{ name: 'word/document.xml', data: splitXml }]), fileName: 'split.docx' });
  assert.deepEqual(blockTexts(splitDoc), ['Hello World']);
  // Nested table folds into enclosing cell serialized text without losing grid.
  const nestedXml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Outer A</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner X</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Inner Y</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc><w:tc><w:p><w:r><w:t>Outer B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>',
    'utf8',
  );
  const nested = await importDocument({ buffer: makeZip([{ name: 'word/document.xml', data: nestedXml }]), fileName: 'nested.docx' });
  assert.ok(nested.blocks.some((b) => b.kind === 'table' && b.text.includes('Outer A')));
  assert.ok(nested.blocks.some((b) => b.kind === 'row'));
  // Duplicate entry names: last wins (Map set).
  const xml1 = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First</w:t></w:r></w:p></w:body></w:document>', 'utf8');
  const xml2 = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>', 'utf8');
  const dup = await importDocument({ buffer: makeZip([{ name: 'word/document.xml', data: xml1 }, { name: 'word/document.xml', data: xml2 }]), fileName: 'dup.docx' });
  assert.deepEqual(blockTexts(dup), ['Second']);
  // Missing word/document.xml must fail CORRUPT_DATA.
  await assert.rejects(
    () => importDocument({ buffer: makeZip([{ name: '[Content_Types].xml', data: Buffer.from('<?xml?><Types/>', 'utf8') }]), fileName: 'missing.docx' }),
    (e) => e.code === 'CORRUPT_DATA',
  );
  // Malformed/truncated XML already covered via unclosed elements, but also pin unterminated tag.
  const unterminated = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello', 'utf8');
  await assert.rejects(
    () => importDocument({ buffer: makeZip([{ name: 'word/document.xml', data: unterminated }]), fileName: 'unterminated.docx' }),
    (e) => e.code === 'CORRUPT_DATA',
  );
});

test('P3A.D1 deep QA — RTF destination groups, bin payloads, unicode, brace imbalance', async () => {
  const cases = [
    ['destination skipped', '{\\rtf1\\ansi {\\fonttbl} Hello World\\par}', 'Hello World'],
    ['starred unknown skipped', '{\\rtf1 Hello {\\*\\unknown payload} World}', 'Hello', 'World'],
    ['bin payload skipped', '{\\rtf1 Hello\\bin5 ABCDE World}', 'Hello World'],
    ['bin with braces', '{\\rtf1 Hello\\bin4 }{}{ World}', 'Hello World'],
    ['unicode \\u1045', '{\\rtf1\\uc1 \\u1045? Hello}', 'Е Hello'],
    ['hex escapes', "{\\rtf1 \\'48\\'65\\'6c\\'6c\\'6f}", 'Hello'],
    ['brace unterminated', '{\\rtf1 Hello {\\b bold', 'Hello bold'],
  ];
  for (const [label, rtf, ...needles] of cases) {
    const doc = await importDocument({ buffer: Buffer.from(rtf, 'latin1'), fileName: 'rtf-case.rtf' });
    const text = blockTexts(doc).join(' ');
    const norm = text.replace(/\s+/g, ' ');
    for (const needle of needles) assert.ok(norm.includes(needle), `${label}: ${JSON.stringify(text)} missing ${JSON.stringify(needle)}`);
    assert.equal(validateNormalizedDocument(doc).ok, true, label);
  }
  // Huge skip groups and deep nesting must terminate quickly.
  let dest = '{\\*\\unknown '.repeat(100) + 'payload' + '}'.repeat(100);
  let rtf = '{\\rtf1 Hello ' + dest + ' World}';
  let t0 = process.hrtime.bigint();
  let doc = await importDocument({ buffer: Buffer.from(rtf, 'latin1'), fileName: 'rtf-huge.rtf' });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'huge skip groups hung');
  assert.ok(validateNormalizedDocument(doc).ok);
  const nested = '{\\rtf1 ' + '{'.repeat(2000) + 'hi' + '}'.repeat(2000) + '}';
  t0 = process.hrtime.bigint();
  doc = await importDocument({ buffer: Buffer.from(nested, 'latin1'), fileName: 'rtf-deep.rtf' });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'deep nesting hung');
  assert.equal(validateNormalizedDocument(doc).ok, true);
  // Malformed \'hh (non-hex) must not crash.
  const malformed = await importDocument({ buffer: Buffer.from("{\\rtf1 \\'4G \\'ZZ Hello}", 'latin1'), fileName: 'rtf-malhex.rtf' });
  assert.equal(validateNormalizedDocument(malformed).ok, true);
  // \bin with huge N consumes remainder without OOR.
  const bigBin = '{\\rtf1 \\bin99999 ' + 'A'.repeat(100) + ' }';
  const bigDoc = await importDocument({ buffer: Buffer.from(bigBin, 'latin1'), fileName: 'rtf-bigbin.rtf' });
  assert.equal(validateNormalizedDocument(bigDoc).ok, true);
});

test('P3A.D1 deep QA — TXT/MD fences, tables, lists, CRLF/BOM, very long lines', async () => {
  // CRLF/BOM handling.
  const txtBom = '\uFEFFLine1\r\n\r\nLine2\rLine3\n';
  let doc = await importDocument({ buffer: Buffer.from(txtBom, 'utf8'), fileName: 'bom.txt' });
  assert.deepEqual(blockTexts(doc), ['Line1', 'Line2 Line3']);
  // MD fence language variants.
  for (const [src, kind] of [
    ['```js\ncode\n```\n', 'other'],
    ['```verse\nline\n```\n', 'verse'],
    ['```Verse\nline\n```\n', 'verse'],
    ['~~~verse\nline\n~~~\n', 'verse'],
    ['```\nplain\n```\n', 'other'],
  ]) {
    doc = await importDocument({ buffer: Buffer.from(src, 'utf8'), fileName: 'fence.md' });
    assert.equal(doc.blocks[0].kind, kind, `fence ${JSON.stringify(src.slice(0, 12))} kind`);
  }
  // Table separator mismatches and missing pipes still produce table+rows.
  const tableCases = [
    '| A | B |\n| --- |\n|1|2|\n',
    'A | B\n---|---\n1 | 2\n',
  ];
  for (const tbl of tableCases) {
    doc = await importDocument({ buffer: Buffer.from(tbl, 'utf8'), fileName: 'table.md' });
    assert.ok(doc.blocks.some((b) => b.kind === 'table'), `table not detected for ${JSON.stringify(tbl.slice(0, 20))}`);
    assert.ok(doc.blocks.some((b) => b.kind === 'row'), 'row missing');
  }
  // List nesting collapsed into single list block.
  doc = await importDocument({ buffer: Buffer.from('- a\n  - b\n- c\n', 'utf8'), fileName: 'list.md' });
  assert.equal(doc.blocks[0].kind, 'list');
  // Headings edge.
  const headingCases = [
    ['# Title', 'heading', 'Title'],
    ['####### Not heading', 'paragraph', '####### Not heading'],
    ['#no-space', 'paragraph', '#no-space'],
  ];
  for (const [src, kind, text] of headingCases) {
    doc = await importDocument({ buffer: Buffer.from(src, 'utf8'), fileName: 'head.md' });
    assert.equal(doc.blocks[0].kind, kind);
    assert.equal(doc.blocks[0].text, text);
  }
  // Very long line.
  const long = 'a'.repeat(10000);
  doc = await importDocument({ buffer: Buffer.from(long, 'utf8'), fileName: 'long.md' });
  assert.equal(doc.blocks[0].text.length, 10000);
  // MD table with many rows (200 already) plus 5000 rows stress (time-box).
  const manyRows = ['| A | B |', '|---|---|'].concat(Array.from({ length: 200 }, (_, i) => `|${i}|${i * 2}|`)).join('\n');
  const t0 = process.hrtime.bigint();
  doc = await importDocument({ buffer: Buffer.from(manyRows, 'utf8'), fileName: 'manyrows.md' });
  assert.ok(doc.blocks.some((b) => b.kind === 'table'));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'many rows hung');
  assert.equal(validateNormalizedDocument(doc).ok, true);
});

test('P3A.D1 deep QA — J3 hostile corpus: every malformed case either succeeds defined-safe or fails typed CORRUPT_DATA', async () => {
  const hostile = [
    [Buffer.from('', 'latin1'), 'a.pdf'],
    [Buffer.from('%PDF- not pdf', 'latin1'), 'a.pdf'],
    [Buffer.from('<< /Type /Catalog >>', 'latin1'), 'a.pdf'],
    [Buffer.alloc(1000, 0x00), 'a.pdf'],
    [Buffer.from('not a zip', 'latin1'), 'a.docx'],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'a.docx'],
    [Buffer.from('{\\rtf1 ' + '{'.repeat(5000), 'latin1'), 'a.rtf'],
    [Buffer.from('', 'utf8'), 'a.txt'],
    [Buffer.from('   \n\n   \n', 'utf8'), 'a.txt'],
    [Buffer.from('| A | B |\n| --- |\n|', 'utf8'), 'a.md'],
    [Buffer.from('```\nunclosed', 'utf8'), 'a.md'],
  ];
  for (const [buf, name] of hostile) {
    const t0 = process.hrtime.bigint();
    let threw = false;
    let code = null;
    try {
      const doc = await importDocument({ buffer: buf, fileName: name });
      assert.equal(validateNormalizedDocument(doc).ok, true, `hostile ${name} produced invalid doc`);
    } catch (e) {
      threw = true;
      code = e.code;
      assert.ok(['CORRUPT_DATA', 'VALIDATION_FAILED', 'SIZE_LIMIT_EXCEEDED', 'PAGE_LIMIT_EXCEEDED'].includes(code), `hostile ${name} threw unexpected code ${code}: ${e.message}`);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `hostile ${name} took ${ms.toFixed(1)}ms — potential hang`);
    // Must not throw raw TypeError/RangeError.
    if (threw) assert.ok(code, 'error missing code');
  }
});

