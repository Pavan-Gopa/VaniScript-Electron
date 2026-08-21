# Attempt History

## DOC-01
- **Attempt 1 (workflow-coder)**: Failed due to runtime timeout (30 minutes).
  - **Approach**: Implemented document preflighting for DOCX/PDF/RTF/TXT/MD.
  - **Failure**: The RTF parser entered an infinite loop on complex fixture data. The agent attempted to rewrite the state machine with a linear walk but timed out before completing the replacement and verifying tests.
  - **Next Step**: Use a standard robust regex or third-party parser for RTF, or ensure the `parseRtf` loop has strict advancement guarantees (`pos` strictly increases).
- **Attempt 2 (workflow-coder + workflow-reviewer)**: Coder fixed RTF infinite loop (all tests pass). Reviewer requested changes.
  - **Reviewer Findings**: 
    1. Malformed PDF dict `<< /Type /Catalog /Pages [ >>` hangs in `parsePdfDict` due to missing EOF guard in array loop.
    2. PDF `FlateDecode` uses `inflateRawSync` but should use standard inflate, failing valid compressed PDFs.
    3. DOCX parser loses table/textbox metadata, emitting them as regular paragraphs.
    4. PDF block construction loses page index metadata despite plan requirements.
    5. PDF preflight checks size but fails to enforce 2000-page limit.
  - **Next Step**: Fix PDF and DOCX edge cases identified by Reviewer, add regression tests, and route back to Reviewer.

## P3A.D1 (legacy DOC-01) — Attempt 3
- **Attempt 3 (workflow-coder `P3AD1CoderFix`)**: Fixed all 5 attempt-2 findings.
  - PDF dict EOF guards + MAX_PDF_DICT_DEPTH=64 -> CORRUPT_DATA; FlateDecode now zlib inflateSync; DOCX table/textbox parts; PDF page index on blocks; DOCUMENT_PAGE_LIMIT enforcement.
  - Main verified: target-only diff, npm test 208/208 pass, tsc clean.
- **Review (`P3AD1Reviewer2`)**: interrupted by harness runtime limit (30 min) after 57 requests — no final verdict. Interim findings (file:line), each verified by Main in source:
  1. `collectPages` recursion overflows stack on deep acyclic /Pages chain (~12k levels) at import.js:1269-1281 — cycle guard exists, depth guard does not.
  2. Malformed PDF literal `(abc\)` trailing escape reaches pdfLiteralToBytes and throws TypeError (nxt.charCodeAt on undefined) at import.js:1034-1058 instead of CORRUPT_DATA.
  3. readZipEntries trusts central-directory cdOffset/localOffset/compSize without bounds checks (import.js:642-674): compSize=0xffffffff accepted with truncated entry; bad localOffset -> ERR_OUT_OF_RANGE.
  4. xmlEvents accepts malformed unclosed XML document; canImport = totalChars >= 4 (import.js:704+, :1516) silently drops text.
  5. Nested textbox inside table folds into table cell paras (finishParagraph tableStack priority, import.js:813-825) instead of part=textbox.
  6. parseOoxmlPart receives partHash but never uses it; DOCX blocks carry whole-file hash, violating contract sourceHash-per-part (§10.4).
- **Next Step**: fresh Coder fixes residuals 1-6 + regression tests (deep pages chain, trailing escape, mutated ZIP offsets, unclosed XML, textbox-in-table, per-part sourceHash); keep 208 tests green.

## P3A.D1 — Attempt 4
- **Attempt 4 (workflow-coder `P3AD1CoderFix2`)**: Fixed all 6 attempt-3 residual blockers (tree depth cap, trailing escape safe byte, ZIP bounds/signature, XML EOF guard, textbox-in-table routing, sourceHash-per-part). Main verified: target-only diff, npm test 214/214, tsc clean.
- **Review (`P3AD1Reviewer3`, 12 min)**: changes_requested.
  - PASS with evidence: A1, A3-A6 residuals; B1-B5 originals unregressed; P3A.J1 (no source mutation) and P3A.J3.
  - **Blocker (single, test-only)**: A2 regression at test/documentImport.test.js:479-498 does not discriminate. L487 `\)` is an unknown JS escape -> zero backslashes at runtime; L490 `\\\\` becomes an escaped pair consumed by the decoder, so no lone trailing backslash ever reaches pdfLiteralToBytes. Neutering the import.js guard would not fail this test.
  - Required change: build the dict fixture with String.raw or explicit Buffer bytes so the PDF dictionary contains exactly one backslash before `)`; keep a valid text stream for successful import; assert defined-safe result and no raw TypeError; correct the comment; rerun focused regression + full suite.
  - Note: Graphify graph was stale (returned AppleSilicon symbols); verdict based on targeted real-source inspection.
- **Next Step**: attempt 5 = test-only fix of the A2 fixture per required change; then re-review.

## P3A.D1 — Attempt 5 close-out and QA
- **Attempt 5 (workflow-coder `P3AD1CoderFix3`)**: test-only A2 fixture fix per Reviewer3 required change (byte-exact lone trailing backslash). Main verified: focused 1/1, 214/214, tsc clean.
- **Review (`P3AD1Reviewer4`, delta)**: approved — all 4 checklist items with byte-level evidence (0x5c before 0x29 in fixture; guard discrimination confirmed). Full checklist A1-A6/B1-B5/J1/J3 green across attempts 4-5.
- **QA (`P3AD1Tester3`, 4m21s)**: suite 214/214 but status=bugs — one verified defect, zero coverage-gap tests added:
  1. **PDF hex strings garbled** (blocker): content-stream `<48656C6C6F20576F726C64> Tj` decodes to `†VÆÆòv÷&Æ` instead of `Hello World`. Same for hex inside `[<...> n <...>] TJ`. Main confirmed root cause in source: token regex group 4 at import.js:1401 captures angle brackets, pushed verbatim at :1406, passed to `pdfHexToBytes` at :1424; the helper (:1070-1078) strips only whitespace → `'<4'`=NaN drops a byte, pairs shift, trailing `4>` parses as 0x04. Dictionary-path caller (:1167-1169) slices brackets off, so only the content-stream path is broken. No regression test covers hex Tj/TJ forms.
- **Next Step**: fresh Coder fixes hex normalization (single canonical point + hardened helper) and adds regression pack (hex Tj, hex in TJ array, odd-nibble, intra-hex whitespace, dict-path non-regression, unterminated-hex still CORRUPT_DATA); then Reviewer delta; then deep Tester pass.

## P3A.D1 — Attempt 6
- **Attempt 6 (workflow-coder `P3AD1CoderFix4`, 11m)**: closed the Tester3 hex blocker.
  - Token regex group 5 now captures the hex payload WITHOUT `<`/`>` (name/num/op shifted to groups 6/7/8, import.js:1407-1417).
  - `pdfHexToBytes` hardened: strips `[<>\s]`, so raw-bracket tokens and dict-path slices are both safe by construction (:1070-1074).
  - Regression pack (6): hex Tj; hex across TJ positioning operands; odd-length nibble rule per PDF 32000-1 §7.3.4.3; intra-hex whitespace; dict-path scalar + space-separated array forms; unterminated hex still CORRUPT_DATA.
  - Main verified in source + independent run: npm test **220/220** (214 baseline + 6), `npm run compile` exit 0. Diff confined to import.js hex handling + test file.
- **Flagged pre-existing (untouched)**: `parsePdfDict` hex branch over-consumes one char after `>` (`i += 2`), so the no-space form `/ID [<hex>]` fails CORRUPT_DATA ("unterminated array") today. Routed to Reviewer5 for severity adjudication (blocker vs follow-up) — real-world PDFs commonly write `/ID [<...><...>]` without spaces.
- **Next Step**: Reviewer5 delta on the Fix4 diff; then deep Tester round.

## P3A.D1 — Review 6 (delta)
- **Review (`P3AD1Reviewer5`, 7m18s)**: **approved**; prior approvals unregressed, no regressions found.
  - Source-verified: helper strips `[<>\s]` + pads odd high nibble (:1070-1083); regex group 5 payload with groups 6/7/8 remapped (:1407-1417); content-stream call :1432; six regressions (:376-459) discriminate.
  - **Adjudication**: pre-existing `parsePdfDict` `i += 2` over-consumption (:1174-1175) = **minor, non-blocking follow-up**. Blast radius limited to hex arrays inside object bodies scanned by parsePdf (:1291-1308); ordinary trailer IDs outside the scan; current O1 fixtures use scalar and space-separated forms (:424-447), all 220 pass. Valid-form rejection is loud typed CORRUPT_DATA — no hang, no mutation — while J3 covers malformed/hostile input. Follow-up closure requires: advancement fix (without touching Fix4 normalization) + no-space/multi-hex regression fixture.
  - Graphify stale (AppleSilicon symbols); verdict based on real-source inspection.
- **Next Step**: deep Tester round per Human mandate (broad adversarial batches, packs of tests); follow-up tracked in STATE.yaml notes for broad PDF-compat closure.

## P3A.D1 — QA deep round
- **QA (`P3AD1Tester4`, 12m43s)**: 231/231 (220 + 11 new deep-QA packs: J1 buffer immutability across formats, PDF hex sweeps, literal escapes, TJ mixes, Flate valid/truncated/garbage, page-tree & dict-depth caps, hostile truncations, DOCX nested tables/zip anomalies, RTF bin/unicode/braces, TXT/MD edges, J3 hostile corpus). status=bugs — 3 findings, Main-verified in source:
  1. **parsePdfDict hex branch doubly broken (blocker; supersedes the Reviewer5 follow-up ruling)**: :1169 `i += 2` after `<` drops the first nibble → scalar `<< /ID <414243> >>` silently decodes `14 24 30` ("142430") instead of `41 42 43`; :1174 `i += 2` after `>` eats the next char → any hex inside `[...]` fails "unterminated array" except a lone element followed by whitespace (Reviewer5's `[<...> ]` fixture passed by accident). Valid input produces both silent wrong decode AND loud false corrupt. Escalated into P3A.D1 scope.
  2. **Content-stream nested literal parens unsupported (major)**: token regex literal alternative cannot match balanced unescaped nesting (PDF spec allows ≤32 levels); `(outer (inner) more) Tj` drops the operand → empty blocks → OCR_REQUIRED / canImport false. Real-world PDFs lose text.
  3. **Dict literal depth ignores escapes (latent)**: :1181-1186 counts `\(` / `\)` as real nesting → unbalanced escaped-paren cases can mis-parse.
- **Next Step**: Coder Fix5 — hex advancement `i += 1` at both sites + scalar/array regressions; balanced, escape-aware literal scanning shared by dict path and tokenizer (depth cap 32 per spec, hostile input defined-safe); keep 231 green; tsc clean.

## P3A.D1 — Attempt 7
- **Attempt 7 (workflow-coder `P3AD1CoderFix5`, 25m)**: closed all three Tester4 defects.
  - New `scanPdfLiteralEnd(s, openIdx, maxDepth)` — shared escape-aware balanced-paren scanner (`\(` `\)` `\\` octal skip nesting); `MAX_PDF_LITERAL_DEPTH=32` on content stream, Infinity cap on dict path (balance required, depth tolerant).
  - parsePdfDict hex branch: `i += 1` at BOTH delimiter sites — scalar nibble-drop and array `]`-eating fixed.
  - Content-stream tokenizer: literal alternative anchors `\(` and dispatches the scanner; hostile literals consume through the balancing paren or segment end (regex cannot re-anchor at an inner paren); capture remap hex whole/payload → 3/4, name/num/op → 5/6/7.
  - `parsePdfDict` exported for exact-value golden asserts (test-only consumer).
  - **A2-area flag**: lone `\` before `)` on the dict path is now spec-correct CORRUPT_DATA (unterminated string); the defined-safe survivor fixture uses the escaped-backslash tail built via String.fromCharCode(92), still exercising pdfLiteralToBytes' trailing-0x5c decode; essence of A2 (never raw TypeError, typed safe outcomes) preserved. Semantics change submitted for Reviewer6 adjudication.
  - Main verified independently: npm test **234/234** (231+3), tsc exit 0, diff confined to import.js PDF dict/tokenizer + tests.
  - Discrimination evidence: pre-fix replica reversing exactly the three fixes fails the 4 affected assertions; post-fix passes.
- **Next Step**: Reviewer6 delta incl. A2-semantics adjudication; then focused Tester confirmation of Tester4 repros; then closure decision.

## P3A.D1 — Review 7 (delta)
- **Review (`P3AD1Reviewer6`, 12m32s)**: **approved**, zero findings.
  - Verified: both dict-hex delimiter advances exactly one char (adjacent/array/nested/EOF); scanner `-1` contract + depth semantics; iterative (100k-deep nested literal parsed ~4ms, no stack risk); tokenizer capture remap + `lastIndex` recovery sound; hostile depth-33 followed by valid tail does not mask the tail.
  - **A2 adjudication**: acceptable spec-correct evolution — exact one-backslash-before-`)` is unterminated per PDF spec (`\)` escapes the closer), typed CORRUPT_DATA satisfies J3 and the original A2 intent (never raw TypeError); the escaped-backslash pair still yields trailing 0x5c through the defined-safe path.
  - Own focused documentImport run 48/48; Reviewer5's Fix4 approval and all prior J1/J3 evidence unregressed; scope confined to import.js + tests. `git diff --check`: one trailing blank line at test EOF only (non-functional).
- **Next Step**: focused Tester confirmation of the original Tester4 repros; on PASS close P3A.D1, push backup, continue to P3A.D2 without pause.

## P3A.D1 — CLOSED
- **Confirmation (`P3AD1Tester5`, 2m6s)**: qa_green — npm test 234/234, fail 0; the three Tester4 repros are pinned by passing discriminating QA2 tests.
- **Full cycle**: Coder attempts 1-7 approved -> Reviewer4/5/6 deltas approved (final: zero findings) -> deep adversarial QA (11 packs) -> focused confirmation green. Suite grew 208 -> 234 across the item; tsc clean throughout.
- **Closure transaction**: STEPS.md `[x] P3A.D1`; backup push = product diff + adapted product-repo `.github/workflows/electron-ci.yml` + `.workflow-snapshots/{STATE.yaml,STEPS.md,FEEDBACK.md}` mirror per Human policy.
- **Next Step**: P3A.D2 Document project persistence (archive/languages/freshness) — continuous pipeline, no pause.
