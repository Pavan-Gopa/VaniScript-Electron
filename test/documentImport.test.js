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

const { getFixture } = require('./fixtures/document-fixtures.js');
const {
  importDocument,
  parseRtf,
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
