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

## P3A.D2 — Attempt 1
- **Attempt 1 (workflow-coder `P3AD2Coder1`, 42m)**: NEW documentProjectStore.js (821 ln), documents.ts contract +405 (DocumentArchive/TranslationArchive v1, normalizeBcp47, validators), projectStore.js +6 additive exports, 20 tests (732 ln). Main verified: **254/254**, tsc clean, diff scoped. Initial yield lacked the structured report; obtained via DM.
- **Design**: `<id>/document.json` + `<id>/translations/<normalized-BCP-47>.json` siblings of project.json; ProjectV3 revision = single optimistic-concurrency lease (pre-validate -> bump via saveProject -> atomic temp+fsync+rename rewrite); freshness computed from sha256(block.text) stored per translation entry vs current text — computed on demand, never persisted authoritative; exact span-tiling validation; removeLanguage does byte-faithful backup before unlink (aborts on backup failure).
- **Deviations (justified)**: (a) freshness basis = per-block text hash — D1's part-level Block.sourceHash cannot detect per-block edits; (b) removal confirmation/export UX is D4/UI scope, store exposes backupDir hook; (c) saveTranslationArchive deliberately write-through (repairs corrupt / restores deleted variants; managed creation stays addLanguage CONFLICT); (d) rejected mutations do not burn the revision; (e) §10.11 undo recovery boundary persisted as monotonic editEpoch + once-only editBaselines (stack reconstruction = DOC-05); (f) archives as sibling files give byte-wise language isolation + automatic bundle manifest/checksum coverage.
- **Next Step**: P3AD2Reviewer1 in flight — crash-window analysis, language isolation, freshness edges, contract surface quality, J2 gate.

## P3A.D2 — Review 1
- **Review (`P3AD2Reviewer1`, 13m35s)**: **changes_requested** — 10 findings; J2 explicitly failed (layout directionally right, but sibling schema validation not wired into bundle/reopen and revision/content split lacks serialized crash recovery). D1 unregressed.
  1. **[blocker]** `_mutate` releases the revision lease after saveProject, then writes archive content unlocked — fresh-revision writer can interleave; crash after revision write leaves no durable intent → stale content may commit later. Required: per-project lock/CAS covering revision+rename, durable intent/replay path.
  2. **[major]** `validateDocumentArchive` declared `DocumentValidationResult` (NormalizedDocument) but returns DocumentArchive — contract type error INVISIBLE because repo tsc excludes shared/contracts. Required: dedicated archive result type + wire contracts into a type-check target.
  3. **[major]** Exact span tiling enforced only in private updateBlockText helper; shared create/save/load path accepts fractional offsets, gaps, overlaps, foreign blocks, empty/duplicate spans, non-covering text; UTF-16 boundary policy unstated. Malformed persisted archives validate and reopen.
  4. **[blocker]** Validation classification/exhaustiveness: parseable-but-invalid archives leak VALIDATION_FAILED instead of CORRUPT_DATA; listLanguages swallows readdir errors → []; reopen never validates translation siblings; bundle import validates only project.json before promoting staging → checksum-valid bundle can import malformed siblings.
  5. **[major]** Translation reads ignore projectId/filename identity — foreign project payload or stem mismatch accepted; listLanguages trusts payload language over filename.
  6. **[major]** §10.5 provenance incomplete: model/profile/promptVersion/glossaryRevision optional and written undefined by addLanguage; variant sourceHash not validated as canonical SHA-256.
  7. Freshness default contradicts docs: text update without explicit sourceHash carries the PREVIOUS hash → legitimate retranslation stays stale; arbitrary non-SHA hashes accepted.
  8. editEpoch/sourceAsset immutability unenforced on wholesale saveDocumentArchive; header's "undo recovery epoch" is aspirational — either enforce or narrow wording to epoch marker owned by DOC-05.
  9. **[minor]** BCP-47 normalization not context-aware (`en-u-ca-gregory` → uppercase extension key); grandfathered/private-use forms unrepresented; underscore alias policy undocumented.
  10. **[minor]** Tests don't discriminate the critical paths above (concurrency/crash interleaves, semantically invalid archives, identity mismatches, incomplete metadata, retranslation transitions, unicode spans, epoch/immutability, corrupt-sibling bundle import).
- **Next Step**: Coder Fix (attempt 2) — blockers 1+4 first, then 2/3/5/6/7/8, minors 9/10; add discriminating tests per finding 10; keep 254 baseline green.

## P3A.D2 — Attempt 2
- **Attempt 2 (workflow-coder `P3AD2CoderFix1`, 56m)**: closed all 10 Reviewer1 findings.
  - F1: `_mutate` = one serialized per-project transaction — in-process mutex (`runProjectExclusive`) spans revision bump AND content rename; write-ahead intent file before lease; CAS#2 recheck before commit; crash-before-lease discards intent, crash-after-lease rolls forward idempotently; covers document.json, translations/*, project.json patches.
  - F2: `DocumentArchiveValidationResult` introduced; shared/contracts wired into type-check via tsconfig include (minimal: documents.ts+errors.ts clean; wiring ALL surfaces 4 PRE-EXISTING projects.ts errors — out of scope, documented in tsconfig comment).
  - F3: exact span tiling enforced in shared validateBlock (create/save/load/reopen); UTF-16 code-unit rule documented on Span.
  - F4: CORRUPT_DATA classification on all read paths; listLanguages ENOENT→[] vs I/O→CORRUPT_DATA; reopen validates all translation siblings; bundle.js validates document.json + every translations/*.json (semantics+identity) BEFORE staging promotion.
  - F5: translation identity enforced (projectId + stem-as-naming-authority); F6: provenance sentinels ('unknown') + canonical 64-hex SHA-256 validation; F7: text commits hash current source unless explicit canonical snapshot hash; status-only keeps hash; F8: load-compare editEpoch non-decreasing + sourceAsset immutable (repair path when unreadable); header aligned to implementation; F9: context-aware BCP-47 state machine; F10: 14 new discriminating tests (20→34).
  - Main verified independently: **268/268**, tsc exit 0 incl. contracts coverage, diff confined to allowed files (projectStore.js +6 is attempt-1's pre-existing export diff).
  - Discrimination: 8/8 pre-fix replica probes fail (interrupted mutation dropped, gapped tiling accepted, corrupt-sibling bundle promoted, foreign projectId accepted, stale hash inherited, epoch regression accepted, BCP-47 uppercase bug).
- **Next Step**: P3AD2Reviewer2 delta re-review of the 10 resolutions.

## P3A.D2 — Review 2 (delta)
- **Review (`P3AD2Reviewer2`, 17m49s)**: **changes_requested** — 7/10 CLOSED (F2 contract typing, F3 shared tiling, F5 identity, F6 provenance, F7 freshness, F8 epoch guards, F9 BCP-47, F10 tests); two PARTIALLY closed + one new gap; **J2 still failed**.
  - R1 **[blocker]** `addLanguage` checks target-file absence BEFORE `_mutate` runs recovery (:609-616 vs :1123-1179): crashed post-lease addLanguage leaves intent without file → fresh-revision retry replays recovered archive then overwrites it with the new skeleton = lost mutation. Required: existence precondition inside runProjectExclusive after recovery + crash/retry CONFLICT regression.
  - R2 **[major]** `createDocumentProject` is outside mutex/WAL/CAS (:346-355): saves project.json then writes document.json — crash between leaves valid type=document project with no archive and no intent. Required: journaled/staged creation covering the pair (or explicitly narrowed contract) + pinned crash test.
  - R3 **[major]** bundle `assertValidDocumentLane` makes document.json optional (:341-343): checksum-valid type=document bundle with translations but no document.json promotes; reopen fails only later. Required: require document.json for type=document, reject translations lane without its archive, pre-promotion regression.
  - Closed verifications cited with file:line for all seven (contract typing :676-680/:810-812 + tsconfig :17-23; tiling :325-370/:98-105; classification :681-697/:928-980 + bundle :312-395; identity :950-980/:357-393; provenance :667-673/:884-934; freshness :752-803; epoch/header :404-430/:33-38).
- **Next Step**: Coder Fix2 (attempt 3) — the three residual transaction-boundary gaps + regressions; keep 268 green.

## P3A.D2 — Attempt 3
- **Attempt 3 (workflow-coder `P3AD2CoderFix2`, 22m)**: closed all three Reviewer2 residuals.
  - R1: target-existence precondition moved into the exclusive section as a new optional `_mutate(..., precondition)` parameter, invoked right after `_recoverPendingMutation` and before CAS#1 — replayed archive surfaces CONFLICT instead of overwrite. Regression injects a genuine post-lease crash (intent durable, de.json absent, revision burned), retries with fresh revision → CONFLICT + byte-wise preserved replay.
  - R2: createDocumentProject rewritten as journaled two-commit transaction under runProjectExclusive — creation intent → saveProject lease → _applyContentPlan(document.json) → clear intent; recovery classifies action 'create' (project.json absent → discard; present → roll forward verbatim); crash-between-commits completes the pair on next access; project.json-without-archive-without-intent = documented CORRUPT_DATA. Three regressions incl. fresh-store reopen stability.
  - R3: assertValidDocumentLane(projectDir, projectId, projectType) receives validated type; document.json REQUIRED for type=document; translations lane without its archive rejected for every type — all BEFORE safeMoveDirectory. Regression: hand-built checksum-genuine zips without document.json rejected pre-promotion, nothing promoted.
  - Main verified independently: **273/273** (268+5), tsc exit 0 incl. contracts coverage, diff confined to the three allowed files.
- **Next Step**: P3AD2Reviewer3 delta re-review of R1-R3; on approved -> QA -> closure.

## P3A.D2 — Review 3 (delta)
- **Review (`P3AD2Reviewer3`, 9m36s)**: **changes_requested** — R3 CLOSED (validated type reaches assertValidDocumentLane, gate before safeMoveDirectory); R1 PARTIALLY closed (addLanguage hook order correct :1191-1197/:661-675); R2 NOT closed; **J2 failed**. Prior 7 settled findings and D1 untouched by Fix2; 273/273 + tsc accepted.
  - N1 **[major]** removeLanguage still observes/backups target before the exclusive recovery section (:687-700): pending post-lease write intent → absent target returns NOT_FOUND without consuming intent; existing target → backup captures stale bytes, then recovery replays newer archive which the subsequent unlink removes. Required: existence+backup inside the exclusive path after recovery (preserve backup-failure atomicity) + regression asserting backup contains RECOVERED bytes.
  - N2 **[major]** create-intent recovery cannot distinguish pre-lease from post-lease (:371-407, :1109-1151): `isCreate || current != expected` treats ANY existing project.json as leased → duplicate create crashing before saveProject overwrites existing document.json or adds one to a media project. Reviewer reproduced equivalent durable state: ORIGINAL→NEW overwrite + intent cleared. Required: fail duplicate creation BEFORE writing a create intent under project-exclusive section, or persist an unambiguous lease/staging phase marker in the intent that recovery requires; discard pre-lease duplicates without touching the existing project; crash regressions for existing document AND media projects.
  - N3 **[minor]** claimed zero-residue discard only unlinks the intent (:1123-1134): real crash after writeTempAtomic created projectDir/temp project.json but before rename leaves them behind (projectStore.js :140-149); the new test monkeypatches saveProject before any FS work so it never exercises this branch. Required: stage outside final dir or record/remove creation-owned residue on pre-lease discard + crash-state test (intent + pre-lease temp → discard removes all, same-id retry succeeds).
- **Next Step**: Coder Fix3 (attempt 4) — three transaction-machinery edges; keep 273 green.

## P3A.D2 — Attempt 4
- **Attempt 4 (workflow-coder `P3AD2CoderFix3`, 37m)**: closed all three Reviewer3 findings.
  - N1: removeLanguage existence/backup/patch computation moved into the exclusive precondition AFTER recovery; precondition may return a value and plan may be a function of it (backup data computed post-replay; durable intent records backupFile). Backup failure aborts before any intent/lease/unlink. Regressions: backup === replayed intent payload byte-wise; pending-unlink-intent consumed before NOT_FOUND; ENOTDIR backup abort leaves archive/revision/intent untouched.
  - N2: duplicate detection under runProjectExclusive BEFORE any intent (project.json present / non-empty target dir / colliding staging path → CONFLICT); create intents carry durable phase prepared→leased (flipped only after saveProject succeeds in staging); recovery rolls forward ONLY on 'leased'; MUTATION_INTENT_VERSION 1→2 — legacy ambiguous intents are loud CORRUPT_DATA, never guessed. Crash regressions over existing document project (byte-unchanged, intent+residue discarded, retry CONFLICT) and media project (no document.json ever appears).
  - N3: creation stages BOTH files in sibling `<id>.create-staging` recorded in the intent; promotion = ONE atomic directory rename; pre-lease discard removes staging tree then intent (mid-discard crash self-heals). Regressions with real FS states incl. half-written staging (.pid4711.tmp). loadDocumentProject now recovers BEFORE observing state (reader-recovers guarantee restored).
  - Discrimination: mutation-testing against the real suite (recovery neutered, gates removed, phase-guessing reintroduced, residue kept → targeted tests FAIL; files restored md5-identical).
  - Main verified independently: **282/282** (273+9), tsc exit 0 incl. contracts coverage, diff confined to documentProjectStore.js + test file.
- **Next Step**: P3AD2Reviewer4 re-review of N1-N3.

## P3A.D2 — Review 4 (delta)
- **Review (`P3AD2Reviewer4`, 13m42s)**: **changes_requested** — N1 CLOSED (post-recovery precondition/function-plan composition correct, backup journaled); N2/N3 PARTIALLY; **J2 failed**. Prior scope unregressed; targeted N1-N3 tests pass 11/11.
  - A1 **[major]** staging-path confinement is LEXICAL only (:1310-1349): path.resolve equality does not reject symlinked stagingDir/stagedProjectDir — leased intent can write intent.content through a symlink to an EXTERNAL directory, then promote that external directory into the project root. Reproduced with real leased intent + staging-root symlink. Required: lstat/realpath staging root + staged project dir before any read/write/delete/rename; reject symlinked components/non-directories as CORRUPT_DATA/CONFLICT without following; real-FS symlinked-root and symlinked-child regressions.
  - A2 **[major]** pre-lease discard does not guarantee intent-before-residue ordering (:505-516): _discardCreationResidue catches rmSync error/partial cleanup then UNCONDITIONALLY unlinks the intent — chmod probe left staging root behind while intent was deleted; same-id retry hits a staging collision and cannot self-heal. Required: remove intent only after verifying the ENTIRE recorded staging tree is gone; retain intent + propagate cleanup failure otherwise; cleanup-failure regression proving intent+retry path remain.
  - A3 **[major]** leased-recovery collision assumes any existing final project.json proves own promotion (:1329-1333): a FOREIGN document/media project appearing at the final path while a leased staged pair exists → intent cleared + staged pair recursively discarded without conflict/replay (reproduced with foreign final project + complete leased staging tree). Required: distinguish own post-promotion state from foreign collision (staged dir absent + final bytes/durable creation identity verified against intent) else CONFLICT/CORRUPT_DATA preserving intent+residue; document-project and media-project collision regressions.
- **Next Step**: Coder Fix4 (attempt 5) — three adversarial recovery cases; keep 282 green.

## P3A.D2 — Attempt 5
- **Attempt 5 (workflow-coder `P3AD2CoderFix4`, 25m)**: closed all three Reviewer4 adversarial findings.
  - A1: `_assertRealDirectoryBelow` lstat-walks EVERY component below the store root along staging root and staged project dir before any staged op; symlink/non-directory → CORRUPT_DATA with intent+residue retained, nothing followed; `_promoteStagedCreation` guards the final project path too; roll-forward rejects symlinked/non-regular staged document.json. Reviewer repro defeated: external dir unmoved, intent byte-identical.
  - A2: `_discardCreationResidue` rewritten — rm failure OR post-rm verification of the whole recorded tree still present → CORRUPT_DATA, intent RETAINED (next recovery retries); intent unlinked only after verified-gone. chmod-probe repro defeated: residue + intent survive together, next recovery completes discard, same-id create succeeds.
  - A3: leased recovery distinguishes ownership — staged-present AND final-present → CONFLICT (own promotion atomically removes staged dir); staged-absent + final-present counts as own promotion ONLY when final document.json is byte-identical to intent.content (`_finalArchiveMatchesIntent`); else CONFLICT preserving intent+staged pair+foreign bytes. Both reviewer repros defeated (document + media collisions); after foreign occupant removal, next access rolls forward.
  - Discrimination: mutation checks against pre-fix replicas per finding (component-lstat neutered / residue-verification removed / any-final-json-is-own → targeted tests FAIL); fixed file restored md5-identical.
  - Main verified independently: **289/289** (282+7), tsc exit 0 incl. contracts coverage, diff confined to documentProjectStore.js + test file.
- **Next Step**: P3AD2Reviewer5 re-review of A1-A3.

## P3A.D2 — Review 5 (delta)
- **Review (`P3AD2Reviewer5`, 9m35s)**: **changes_requested** — A2 CLOSED (chmod repro passes, intent+residue retained, retry heals); A1/A3 PARTIAL; **J2 failed**. Updated idempotent-promotion test judged LEGITIMATE (journals exact stamped bytes; negative collision tests not weakened). 289/289 + tsc consistent; focused store suite 55/55; scope accepted.
  - B1 **[major]** live create path (saveProject/_applyContentPlan/_promoteStagedCreation) never invokes `_assertRealDirectoryBelow`; preflight `fs.existsSync(stagingDir)` follows links and misses dangling staging-root symlinks; promotion guards destination but not staged SOURCE; ops are synchronous (no event-loop interleave) but each lstat/write/rename is a separate syscall an external process can race — reviewer suggests descriptor/no-follow primitives if concurrent FS mutators are in the threat model.
  - B2 **[major]** leased recovery with NO staged dir reads the final path unguarded (`fileExists` + read-through): a final project SYMLINK to an external dir with matching document.json is accepted as own promotion; a FIFO/non-regular final document.json can be read without the regular-file guard (potential hang).
  - B3 **[major]** `_finalArchiveMatchesIntent` proves ownership from document.json UTF-8 bytes ALONE — no project.json byte check, no type/projectId validation: foreign media project carrying a matching document.json sidecar (or foreign doc project with identical archive bytes but different metadata) → intent discarded as completed promotion.
- **Escalation**: third consecutive round of same-class edges in the recovery machinery (R3: 3 edges → R4: 3 adversarial repros → R5: 3 deeper adversarial edges incl. multi-process FS-racer assumptions). Per retry-guard philosophy Main escalates scope/threat-model decision to Human instead of dispatching Fix5 automatically.

## P3A.D2 — Scope decision (Human)
- **Human decision (~16:40Z, option "Fix5 + boundary")**: one final Fix5 closes B1-B3; then J2 carries an explicit threat-model boundary — single-process Electron main IS the contract; a multi-process adversarial filesystem mutator transfers to the P3B.J1 / P4 hardening backlog. Reviewer6 is the FINAL in-scope round: approved -> QA -> close; any NEW same-class edges found there are auto-transferred to the P4 backlog WITHOUT further fix rounds (pre-authorized by Human).
- **Next Step**: P3AD2CoderFix5 (attempt 6) — B1-B3 + module-header threat-model statement.

## P3A.D2 — Attempt 6
- **Attempt 6 (workflow-coder `P3AD2CoderFix5`, 27m)**: closed B1-B3 + boundary documentation.
  - B1: lstatSafe preflight (dangling staging-root symlink → typed CONFLICT, nothing followed); `_assertCreationStagingIntegrity` gate before EVERY live staged op; promotion validates SOURCE as well as destination. Threat-model paragraph in module header verbatim per Human decision.
  - B2: leased no-staging branch observes the final path ONLY through lstatSafe (symlink/non-dir → CONFLICT, intent retained); all final-node reads via `_readRegularFileGuarded` (no-follow; FIFO/symlink/non-regular → CORRUPT_DATA without opening — no hang); fileExists eliminated from the branch.
  - B3: MUTATION_INTENT_VERSION 2→3 — leased intents carry canonical SHA-256 of staged project.json; ownership = projectSha256 match AND document.json Buffer-equality AND parsed type==='document' && projectId match (`_finalStateMatchesIntent`); anything less → CONFLICT preserving intent.
  - Regressions: dangling-root live create; planted source symlink at promotion; symlinked final project with fully-matching bytes refused (old code accepted it); FIFO archive fails typed instead of hanging; foreign doc project with byte-identical sidecar → CONFLICT; media project with forged sidecar → CONFLICT via listLanguages recovery, nothing fabricated. v3 migrations of prior crash tests assert real journaled digests; no test weakened.
  - Main verified independently: **296/296** (289+7), tsc exit 0 incl. contracts coverage, diff confined to documentProjectStore.js + test file.
- **Next Step**: P3AD2Reviewer6 — FINAL round per Human decision: approved -> QA -> close; new same-class edges auto-transfer to P4 backlog.

## P3A.D2 — Review 6 (FINAL round)
- **Review (`P3AD2Reviewer6`, 10m58s)**: **changes_requested** on exactly ONE item — B2 CLOSED, B3 CLOSED, **J2 MET under the documented boundary** (module header accurately scopes single-process main; hostile content typed; external mutator transferred to P3B.J1/P4), v3 intent strictness confirmed (no silent v2 acceptance), prior scope + 296/296 consistent.
  - C1 [B1 partial]: the claimed every-live-operation gate is missing immediately before the staged project.json lease-identity read (:513-515; live gatesites only 497/505/520/539) — header claim inaccurate until fixed. Required: invoke `_assertCreationStagingIntegrity` right before that read (or equivalent gate) + a discriminating live-create regression that fails when the callsite is removed; keep header aligned with resulting callsites.
  - Non-blocking notes routed to P4 backlog: recovery-side staged-op re-gating granularity (initial gate at :1587 covers the section under the no-external-mutator boundary); 'phase-less legacy' test pins the current constant rather than literal version:2 (test-hardening).
- **Decision**: mechanical single-gate fix per the reviewer's explicit recipe -> Main verifies implementation against the stated requirement; then Tester confirmation; then closure (no additional full review round for a one-line mechanical change already adjudicated by Reviewer6).
- **Next Step**: P3AD2CoderFix6 micro-fix -> Main verify -> Tester confirm -> close D2 -> backup push.

## P3A.D2 — CLOSED
- **Micro-fix (`P3AD2CoderFix6`, 7m)**: gate at :513 immediately before the staged identity read per Reviewer6's exact recipe; regression plants a real symlink swap in the only uncovered window; mutation-verified (CUT callsite → FAIL, restored → PASS).
- **Confirmation (`P3AD2Tester1`)**: qa_green — npm test 297/297, focused store suite green, tsc clean.
- **Full cycle**: 7 coder attempts, 6 reviewer rounds; findings converged 10 → 3 → 3 → 3 → 3 → 1; final verdict path: B2/B3 closed, J2 MET under the Human-approved threat-model boundary, single mechanical C1 fixed + Main-verified. Suite grew 234 → 297 across the item.
- **P4 backlog transfers**: recovery-side re-gating granularity nuance; literal version:2 intent pin in tests; the multi-process adversarial FS-mutator class (per Human boundary decision → P3B.J1 / P4 hardening).
- **Next Step**: P3A.D3 Semantic chunk planner — continuous pipeline, no pause.

## P3A.D3 — Attempt 1
- **Attempt 1 (workflow-coder `P3AD3Coder1`, 31m)**: NEW chunkPlanner.js (491 ln), documents.ts contract +217 (ChunkPlan v1), NEW test/documentChunkPlanner.test.js (668 ln, 23 tests). Main verified: **320/320**, tsc clean, diff scoped to the 3 files. Structured report requested via DM (initial yield lacked it).
- **Design**: pure function of document.blocks + options (no timestamps/randomness/order-dependence); 8 documented grouping rules — tables+rows atomic, headings bind forward (never end a chunk), prose-only sentence splitting with exact-concatenation guarantee, budget exception for unsplittable atomic units, part changes close chunks, zero-block/zero-token edge rules; token estimate = ceil(chars/4) documented; chunkId = "c-" + first 16 hex of SHA-256 over "schema|blockId:start:end,..." — membership+range-derived, ordinal-independent; rolling context bounded by chars, crossing chunk borders; options defaults 800/400 with TypeError validation.
- **Next Step**: P3AD3Reviewer1 full review.

## P3A.D3 — Review 1
- **Review (`P3AD3Reviewer1`, 15m39s)**: **changes_requested** — 9 findings (4 major / 5 minor). Determinism real for validated inputs; 64-bit id truncation risk negligible (~2.7e-12 @10k chunks); P3A.J2 untouched; D1/D2 unregressed.
  1. **[major]** Heading at full budget flushed as heading-only chunk instead of binding forward (:30-33/:421-436) — repro: heading `abcd` + `a. b.` at budget 1 → `[heading]`,`[slice]`. Required: heading binding precedence over flush + exact-budget/over-budget tests.
  2. **[major]** chunkId seed serialization not injective — unescaped `,`/`:` in legal blockIds collide deterministically (`A:0:1,B` full-slice ≡ two slices). TSDoc overstates wording-edit stability (length edits change ranges → new ids). Required: unambiguous canonical encoding or enforced delimiter-free blockId grammar; align TSDoc; collision regression.
  3. **[major]** Duplicate blockIds accepted — buildUnits tolerates, Map last-write-wins resolves wrong text with plausible ranges/tokens. Required: reject duplicates before planning (+ grouped-row identity), fail-closed test.
  4. **[minor]** Table grouping ignores `part` (main-table + footer-row folded) vs rule 7. Required: same-part folding or explicit precedence + fixture.
  5. **[minor]** All-empty rule violated across parts (two zero-token chunks vs documented one) — rules 7/8 precedence conflict. Required: explicit exception or documented precedence + test.
  6. **[minor]** Context partial-cut can split surrogate pairs (`\uDE00` alone). Required: code-point-safe cuts or documented provider contract + emoji boundary test.
  7. **[major]** `validateChunkPlan` shape-only — accepts arbitrary chunkId and out-of-document slices; TSDoc overstates strictness; no downstream source-aware callsite. Required: source-aware validation path or explicit DOC-04 rederivation contract, minimum id-shape enforcement, negative tests.
  8. **[minor]** DEFAULT_CHUNK_PLANNER_OPTIONS mutable at runtime by JS callers. Required: runtime freeze + mutation test.
  9. **[minor]** Abbreviation dots (`Dr.`, `U.S.`) split as boundaries; Unicode closers untested. Required: deterministic abbreviation rules or narrowed docs + focused tests.
- **Next Step**: Coder Fix1 (attempt 2) — all nine; keep 320 green.

## P3A.D3 — Attempt 2
- **Attempt 2 (workflow-coder `P3AD3CoderFix1`, 28m)**: closed all nine Reviewer1 findings.
  - F1: `cur.contentTokens` tracking — prose-split flushes only when real content exists; heading-only chunks impossible; exact-budget/over-budget/reviewer-repro tests.
  - F2: `canonicalChunkSeed` (length-prefixed fields → injective) + `deriveChunkPlanId` exported from documents.ts; local hashing deleted (clean cutover); TSDoc rewritten to range-based stability; reviewer's exact collision pair now yields disjoint id sets.
  - F3: duplicate blockIds → fail-closed TypeError before planning (rows included, identity-validated); 3 dup fixtures.
  - F4: same-part table folding; cross-part fixture. F5: rule 8 documented per-part precedence; spanning-parts test. F6: code-point-safe `cutHead`/`cutTail` (whole code point omitted at budget edge); emoji tests + no-unpaired-surrogate invariants.
  - F7: `validateChunkPlanAgainstSource` (+ `isChunkPlanForSource`) — id shape AND re-derivation, block existence, UTF-16 bounds, ordered gapless full coverage, recomputed estimates; mismatches → CORRUPT_DATA; `validateChunkPlan` TSDoc narrowed to structural-only; 9 negative tests incl. compensated-estimate tamper and post-planning source mutation.
  - F8: defaults Object.freeze + strict/sloppy mutation tests. F9: deterministic abbreviation list (single-letter initials + {mr,mrs,ms,dr,prof,sr,jr,st}), documented trade-off; `Dr. Smith`/`U.S. Army`/Unicode-closer fixtures.
  - Main verified independently: **333/333** (320+13), tsc exit 0 incl. contracts coverage, diff confined to the three allowed files.
  - Discrimination: pre-fix probes reproduced all nine repros; post-fix mutation checks (contentTokens guard revert → 3 FAIL; freeze removal → FAIL); files restored md5-identical.
- **Next Step**: P3AD3Reviewer2 delta re-review.

## P3A.D3 — Review 2 (delta)
- **Review (`P3AD2Reviewer2`-style delta `P3AD3Reviewer2`, 13m48s)**: **changes_requested** — F2-F6, F8, F9 CLOSED; F1/F7 partial. Determinism + range-stability sound; §10.6 fit confirmed; no D1/D2 regression; scope clean.
  1. **[minor]** Heading handler still tests `cur.tokens > 0` (:447-478): nonempty heading + zero-token separator + next heading → contentless non-final chunk `[h,e]`, contradicting rule 2 (empties stay in pending prefix). Required: content-vs-prefix state (or defer separator draining) + h1/empty/h2/prose regression.
  2. **[major]** `validateChunkPlanAgainstSource` indexes blocks in a plain Record (:1305-1324): legal blockIds `__proto__`/`constructor`/`toString` collide with inherited properties → valid planner output rejected as false duplicate. Required: `Map<string, number>` or `Object.create(null)` + prototype-property acceptance tests, retaining true-duplicate rejection.
  3. **[major]** Coverage check accepts degenerate zero-length slices on nonempty blocks (:1340-1386): standalone `[0,0]` chunk + `[0,len]` returns ok (expectedStart never advances on zero-length). Required: reject zero-length slices on nonempty blocks and >1 zero-length slice on empty blocks (planner's legitimate empty slice stays legal); re-derived duplicate-prefix/suffix + valid split coverage tests.
- **Next Step**: Coder Fix2 (attempt 3) — three residuals; keep 333 green.

## P3A.D3 — Attempt 3
- **Attempt 3 (workflow-coder `P3AD3CoderFix2`, 17m)**: closed all three Reviewer2 residuals.
  - R1: heading handler closes only on `cur.contentTokens > 0`; prefix+separator-only chunks fold back into the pending prefix — h1/empty/h2/prose stays pending until section content. Regression: budget 2 → [['h0','e0','h1','p0'(0,4)],['p0'(4,7)]].
  - R2: indexById → `Map<string, number>`; prototype-property blockIds (`__proto__`/`constructor`/`toString`/`hasOwnProperty`/`valueOf`) validate end-to-end; true `__proto__` duplicates still rejected.
  - R3: zero-length slices on nonempty blocks rejected; >1 zero-length slice on empty blocks rejected (legitimate single empty slice legal); four-facet regression incl. suffix duplicate and valid split coverage.
  - Main verified independently: **336/336** (333+3), tsc exit 0 incl. contracts coverage; mutation run against all-three pre-fix replicas → exactly the 3 new tests fail; files restored md5-identical.
- **Next Step**: P3AD3Reviewer3 delta re-review of R1-R3.

## P3A.D3 — Review 3 (delta)
- **Review (`P3AD3Reviewer3`, 7m28s)**: **approved**, zero findings.
  - R1 closed: contentTokens tracking + prefix fold (:426-462/:472-534); h1/empty/h2/prose regression passes; exhaustive same-part sweeps found no orphan headings or nondeterminism; trailing heading-only document emits a valid final chunk.
  - R2 closed: Map index with index-0-safe `!== undefined` dup check (:1311-1329); planner-side lookups also Maps; all five prototype-property ids validated end-to-end; true `__proto__` duplicate still rejected.
  - R3 closed: cross-chunk slice flattening, per-block zero-length counter reset, nonempty-block and second-empty-slice rejection (:1346-1399); four-facet regression passes; direct boundary probes pass.
  - Focused planner suite 39/39; determinism + range-based id stability intact; §10.6-compatible boundary; D1/D2 and settled F-findings untouched; scope confined.
- **Next Step**: QA confirmation -> close D3 -> backup push -> P3A.D4.

## P3A.D3 — CLOSED
- **Confirmation (`P3AD3Tester1`, 1m27s)**: qa_green — npm test 336/336, tsc clean.
- **Full cycle**: 3 coder attempts, 3 reviewer rounds; findings converged 9 → 3 → 0; final verdict approved with zero issues; determinism/stability and §10.6 fit explicitly confirmed.
- **Closure transaction**: STEPS `[x] P3A.D3`; backup push #3 (product diff + snapshot mirror refresh).
- **Next Step**: P3A.D4 Translation coordinator (pause/repair/commit) — continuous pipeline, no pause.

## P3A.D4 — Attempts 1-4
- **Attempts 1-3 (provider deaths)**: Coder1 died pre-write (15m); Coder2 wrote the coordinator (924 ln) + contract (+142), self-fixed a partial-block commit defect, died repairing its own edit damage (29m); Coder3 audited the full draft against §10.6 and applied fixes (943 ln, +144), died writing tests (21m). Zero product progress lost; runtime failures only.
- **Attempt 4 (`P3AD4Coder4`, 22m, single-purpose test session)**: NEW test/translationCoordinator.test.js — 14 tests covering §10.6: tiling-strict validateChunkResponse units; suspicion/approval classification; automatic batch with per-chunk commits + token reconciliation + D2 freshness integration; pause/resume without retranslation; cancel; repair flow with corrective context; provider-error isolation; repair exhaustion; targeted-failure previous-variant preservation; whole-block coverage guard (fragment cannot clobber block); stale SOURCE_CHANGED CAS; external-writer CONFLICT CAS; listener observability + ended-run guard. ZERO product-code changes needed — the audited coordinator passed every scenario as-is.
  - INTERPRETATION FLAG for review: assignment suggested '>2 repairs → needs-review terminal'; the audited contract makes exhaustion FAILED(PROVIDER_ERROR), reserving needs-review for suspicious-but-valid commits in automatic mode. Tested as implemented; reviewer to adjudicate against §10.6 wording.
  - Main verified independently: **350/350**, tsc exit 0, diff = coordinator + contracts + new test file.
- **Next Step**: P3AD4Reviewer1 full review.

## P3A.D4 — Review 1
- **Review (`P3AD4Reviewer1`, 21m31s)**: **changes_requested** — 6 findings (5 major + 1 minor/TSDoc). Most §10.6 mechanics present; exhaustion adjudicated CONFORMING as FAILED(PROVIDER_ERROR) (exhausted response never valid → not a Needs Review candidate; D6 can surface retryable failure); CAS interpretation conforming to D2 architecture (global ProjectV3 revision guards target+source mutations; no separate target-archive revision exists). Prior scope clean.
  1. **[major]** validateChunkResponse not tiling-strict for REPEATED same-block slices (:140-174/:538-547): provider reverses segments omitting optional offsets → accepted {ok:true}; _recordPiece assigns by array position → wrong whole-block translation committed approved with fresh sourceHash. Required: unambiguous per-slice identity for repeated blockIds (require echoed charStart/charEnd or segment ordinal); contract TSDoc + same-block reversal regression.
  2. **[major]** Cancellation not authoritative across failure/retry boundaries (:375-386/:499-535/:698-704): rejection after cancel → _failChunk without checking _cancelRequested (cancelled run ends with failed chunk); cancel during repairing dispatches another repair request; unknown rejection (null) crashes err.message deref leaving run promise unresolved. Required: centralized in-flight cancellation checked in provider catch and at top of every repair iteration; normalize unknown throws preserving AppError codes; rejection-after-cancel / cancel-during-repair / unknown-rejection tests.
  3. **[major]** Non-stale commit/storage errors treated as ordinary per-chunk failures (:595-610/:654-661): D2 post-lease FS throw leaves WAL intent → next chunk's load recovers it while coordinator holds stale _revision → failed→stale cascade with durable archive entry from the failed chunk. Required: commit/storage failures TERMINAL (stop pending work, surface typed error) or explicit intent recovery + revision reconciliation; post-lease _applyContentPlan failure regression asserting no later dispatch + correct accounting.
  4. **[major/semantic gap]** startManualChunk selects one plan chunk (:570-679/:892-900): for a D3-split long block that chunk is partial → _coversWholeBlock rejects → 'committed' chunk with 'uncommitted' block, archive unchanged. Required: choose and document a safe policy (expand manual run to all slices of touched blocks, OR define manual partial chunks as explicitly non-durable) + split-block integration test.
  5. **[major/test coverage]** Missing coverage: startManualChunk never tested; repeated same-block slices; split-block buffering/revision counts; protected block/span policies; suspicious automatic output landing needs-review; per-successful-chunk revision assertion. Required per list.
  6. **[minor/TSDoc]** TranslationProgressSnapshot documents tokensTotal as processed-chunk sum; implementation sums ALL chunks (tokensDone = successful sum). Required: align TSDoc to full-plan total (or change impl) + partial/failed progress assertion.
- **Next Step**: Coder Fix1 (attempt 5) — all six; keep 350 green.

## P3A.D4 — Attempt 5
- **Attempt 5 (workflow-coder `P3AD4CoderFix1`, 28m)**: closed all six Reviewer1 findings.
  - F1: validateChunkResponse REQUIRES exact charStart/charEnd echoes for every repeated-block segment (omission/mismatch → repairable failure); reviewer's reversal probe fails validation, never commits.
  - F2: `_settleCancelledInFlight` is the authoritative check — top of every repair iteration, provider catch (cancel wins over failure), commit catch; `normalizeThrown`/`describeThrownValue` normalize any thrown value without deref (AppError codes preserved); run promise always resolves.
  - F3: POLICY — commit/storage failures TERMINAL (`_abortOnStorageFailure`): failing chunk failed, pending swept failed, typed error surfaced; documented in header + _commitPhase TSDoc. Stale SOURCE_CHANGED/CONFLICT and exhaustion semantics untouched (adjudicated conforming).
  - F4: POLICY — manual-chunk EXPANDS to every plan chunk carrying a slice of a touched block; merged drafts commit via normal path; documented in prepare/startManualChunk TSDoc + header.
  - F5: coverage added per list (manual expansion end-to-end, repeated-slice full commit path, needs-review landing, protected policies, revision chain +1 per chunk).
  - F6: tokensTotal TSDoc corrected (full plan estimate; tokensDone = committed+needs-review+skipped); partial/failed snapshot assertions added.
  - Discrimination: /tmp reverted-tree mutation runs per finding (noF1 → exactly 2 F1 tests fail; noF2 → all 3 fail incl. hang on extra dispatch; noF3 → storage-terminal test fails; noF4 → manual test fails).
  - Main verified independently: **361/361** (350+11), tsc exit 0, diff confined to the three allowed files.
- **Next Step**: P3AD4Reviewer2 delta re-review.

## P3A.D4 — Review 2 (delta)
- **Review (`P3AD4Reviewer2`, 16m30s)**: **changes_requested** — F1/F3/F4/F5/F6 CLOSED (with file:line verification); F2 PARTIAL + two new findings. §10.6 not yet complete; prior scope clean.
  1. **[F2 residual, major]** `_settleCancelledInFlight` runs after the provider await but NOT after the validating transition / before accepting a valid response → sync listener can cancel during 'validating'/'committing' updates and the response still commits (:610-621/:698-713). Also commit-catch classifies SOURCE_CHANGED/CONFLICT stale BEFORE the cancellation check → cancel+stale ends failed instead of authoritative cancelled. Required: one cancellation precedence — settle after validating transition and before commit; cancellation checked before stale classification; regressions for cancel-from-validating/committing updates and cancel-plus-stale.
  2. **[major, new contract finding]** `TranslationBlockStatus` union (:1473-1484) omits runtime-emitted `approved`/`draft` (statusForBlock :233-235, _commitChunk :773-774) while including unused `committed` — typed progress contract cannot represent asserted runtime snapshots. Required: align union with emitted values (or map output), plus a JS-output-vs-TS-shape drift assertion.
  3. **[minor, new edge]** fail-then-cancel leaves non-null `error` in a state=cancelled snapshot, contradicting TSDoc 'null unless run failed' (:494-502/:827-833). Required: clear fatal error on cancelled terminal (or revise TSDoc to preserve prior failures) + fail-then-cancel regression.
- **Next Step**: Coder Fix2 (attempt 6) — three residuals; keep 361 green.

## P3A.D4 — Attempt 6
- **Attempt 6 (workflow-coder `P3AD4CoderFix2`, 16m)**: closed all three Reviewer2 residuals.
  - R1: cancellation precedence enforced at FOUR points — after 'validating' transition, at _commitPhase entry, immediately after 'committing' transition (before _commitChunk dispatch), and FIRST in the commit catch before stale classification (cancel beats stale). Regressions: cancel-from-validating discards response; cancel-from-committing lets no write land; cancel+SOURCE_CHANGED ends cancelled with error null.
  - R2: TranslationBlockStatus realigned to emitted universe ('approved'|'buffered'|'draft'|'failed'|'needs-review'|'protected'|'uncommitted', dead 'committed' removed); drift assertion parses the union from documents.ts source and set-equality-checks it against all seven end-to-end emitters.
  - R3: _finish clears this.error on 'cancelled' terminal; fail-then-cancel regression asserts error null with no second dispatch.
  - Discrimination: four coordinator fixes temporarily reverted → the 4 behavior regressions fail 0/4; restored → all 30 coordinator tests pass.
  - Main verified independently: **366/366** (361+5), tsc exit 0 incl. contracts coverage, diff confined to the three allowed files.
- **Next Step**: P3AD4Reviewer3 delta re-review of R1-R3.

## P3A.D4 — Review 3 (delta)
- **Review (`P3AD4Reviewer3`, 7m26s)**: **changes_requested** on ONE item — R1 CLOSED (four-point cancellation precedence verified :628-635/:723-750; _commitChunk sync after final gate, no listener window), R3 CLOSED (error cleared :504-515), runtime §10.6 conforming; prior scope clean.
  - D1 [major/test-only]: the R2 drift guard is not exhaustive — `observed` collects only 7 hand-picked final snapshots vs a hard-coded universe; cancellation/stale/storage-failure paths (:485-499/:739-741) and intermediate update snapshots are never driven/observed, so a new status added only on an omitted path passes silently. Required: guard enumerates EVERY runtime producer — collect every update+terminal snapshot, add cancel/stale/storage-failure fixtures (or source-derived enumeration); keep exact declared-union equality so missing AND dead members fail.
- **Next Step**: Coder Fix3 (attempt 7, test-only) — exhaustive drift guard; keep 366 green.

## P3A.D4 — Attempt 7
- **Attempt 7 (workflow-coder `P3AD4CoderFix3`, 14m, test-only)**: drift guard made exhaustive.
  - Observed universe accumulated from EVERY update snapshot (listener attached at every start* handle) AND every terminal snapshot; nine fixtures drive all producer paths — approved, needs-review, manual-expanded buffered rows + merged draft, targeted draft written/uncommitted reporting, protected block+span rows, failed rows, cancel discard+sweep rows, stale sweep rows, post-lease storage failure rows. Each fixture carries sanity asserts so a broken fixture fails loudly instead of silently narrowing the universe.
  - Exact two-direction equality: runtime⊆contract loop names undeclared emissions; deepEqual(sorted declared, sorted observed) replaces the hand-written mirror list — dead members fail against real observation.
  - Discrimination: product mutations [A1] fake status on the previously-unobserved cancel/stale path → guard FAILS naming it; [A2] swept-row status mutation → FAILS; [B] union member removal → FAILS. Files restored byte-exact (sha256 verified).
  - Main verified independently: **366/366** (count unchanged — one test replaced), tsc exit 0, diff test-file only.
- **Next Step**: P3AD4Reviewer4 delta re-review of D1; on approved -> QA -> close D4 -> backup push.

## P3A.D4 — Review 4 (delta)
- **Review (`P3AD4Reviewer4`, 9m59s)**: **changes_requested** — D1 PARTIAL: runtime parsing/listener timing/terminal collection/two-direction equality confirmed; focused drift test passes; 366/366 consistent. BUT per-fixture sanity assertions are missing or too weak where producers overlap: approved/needs-review fixtures have no output assertion; targeted-partial asserts only state; provider-failure asserts only state=failed (not _failChunk's failed rows). Since approved/failed/uncommitted are emitted by MULTIPLE fixtures, a path-specific mutation can leave the global observed set exactly equal — the guard does not independently establish every producer path. Also the pause-cancel call site (:436-448) is not directly driven.
  Required: exact block-row sanity assertions per overlapping producer (at minimum approved, needs-review, manual buffered+merged draft, targeted full draft + partial uncommitted, provider-throw failed rows); a paused-cancel fixture (or source-derived enumeration of status-producing call sites) so a status emitted only by the paused/preparing sweep path cannot pass silently.
- **Next Step**: Coder Fix4 (attempt 8, test-only) — per-path sanity + paused-cancel coverage.

## P3A.D4 — Attempt 8
- **Attempt 8 (workflow-coder `P3AD4CoderFix4`, 7m, test-only)**: closed the Reviewer4 finding.
  - Per-path pins added for ALL overlapping producers: drift-approved pins [{blockId,'approved'}]; drift-needs-review pins needs-review; drift-manual-split pins buffered rows on EVERY intermediate expansion chunk AND draft on the last-touching chunk (buffering vs merged write asserted separately); drift-targeted asserts full-fragment draft and partial-fragment uncommitted as separate assertions; drift-failed pins _failChunk's failed rows specifically (distinguished from _abortOnStorageFailure's). Existing exact pins untouched; both global equality directions intact.
  - PAUSED-CANCEL fixture drives cancel() from state 'paused' directly (:436-448 sweep site): parked after chunk1 commit (calls===1 asserted), final cancelled/error-null, statuses [committed,cancelled,cancelled], per-blockId swept uncommitted rows join observed.
  - Discrimination: two product mutations — A (_failChunk failed→uncommitted) fails exactly 'provider throw marks rows failed'; B (_commitChunk buffered ternary→uncommitted) fails exactly 'intermediate expansion chunks report buffered rows'. Coordinator md5 byte-identical after restores.
  - Main verified independently: **366/366** (unchanged), tsc exit 0, diff test-file only.
- **Next Step**: P3AD4Reviewer5 delta re-review of the per-path pins + paused-cancel coverage.

## P3A.D4 — Review 5 (delta)
- **Review (`P3AD4Reviewer5`, 8m10s)**: **changes_requested** — two precise uncovered rows remain (attempt-8 scope test-only confirmed; 366/366 unchanged).
  1. drift-cancel fixture pins only pending sweep rows (final.chunks[2]); the IN-FLIGHT cancelled chunk (final.chunks[1], two blocks) has no exact assertion → isolated mutation of _settleCancelledInFlight row assignment (:486 → failed) passes. Required: exact per-block uncommitted pins for final.chunks[1].blocks.
  2. drift-stale fixture pins only pending sweep rows (final.chunks[1]); the stale in-flight chunk's rows (final.chunks[0], two blocks, _uncommittedRows at :740) unasserted → isolated mutation :740 → failed passes. Required: exact per-block uncommitted pins for final.chunks[0].blocks.
- **Next Step**: Coder Fix5 (attempt 9, test-only) — four exact pins per the reviewer's line recipe.

## P3A.D4 — Attempt 9
- **Attempt 9 (workflow-coder `P3AD4CoderFix5`, 8m, test-only)**: closed both Reviewer5 findings with the exact recipe.
  - drift-cancel: exact deepEqual pin on final.chunks[1].blocks (two uncommitted discard rows from _settleCancelledInFlight), distinct from chunks[2] pending-sweep assertion.
  - drift-stale: exact deepEqual pin on final.chunks[0].blocks (two uncommitted discard rows from commit-catch _uncommittedRows), in addition to chunks[1] sweep assertion.
  - Discrimination: isolated mutation :486→failed fails ONLY the cancel pin (stale pin not entered — no cancel in that fixture); isolated :740→failed fails ONLY the stale pin. Coordinator md5 byte-exact after restores.
  - Main verified independently: **366/366** (unchanged), tsc exit 0, diff test-file only.
- **Next Step**: P3AD4Reviewer6 delta re-review of the two pins; on approved -> QA -> close D4 -> backup push.

## P3A.D4 — Review 6 (delta)
- **Review (`P3AD4Reviewer6`, 4m42s)**: **approved**, zero findings.
  - drift-cancel pin verified at test :1491-1497 (exact blocks[2]/blocks[3] uncommitted rows, names _settleCancelledInFlight); drift-stale pin at :1596-1602 (names commit-catch _uncommittedRows).
  - Mental mutation replay: :486 → failed fails only the cancel pin; :740 → failed fails only the stale pin (other fixture never enters that path; global set already contains failed).
  - Attempt-9 scope test-file-only vs attempt 8; 366/366 and tsc unchanged; prior path pins and exhaustive equality intact. Graphify stale — live source used.
- **Next Step**: QA confirmation -> close D4 -> backup push -> P3A.D5.

## P3A.D4 — CLOSED
- **Confirmation (`P3AD4Tester1`, 3m57s)**: qa_green — npm test 366/366, tsc clean.
- **Full cycle**: 9 coder attempts (incl. 2 pre-write provider deaths + 1 audit session + 2 test-only micro-fixes), 6 reviewer rounds; findings converged 6 → 3 → 1 → 1 → 2 → 0; final approved zero-findings; exhaustion/CAS interpretations adjudicated conforming.
- **Closure transaction**: STEPS `[x] P3A.D4`; backup push #4 (product diff + snapshot mirror refresh).
- **Next Step**: P3A.D5 Editorial editor core (ProseMirror schema/transactions/undo) — continuous pipeline, no pause.

## P3A.D5 — Attempts 1-4
- **Attempts 1-3 (provider deaths + split sessions)**: Coder1 installed prosemirror deps (model/state/transform/history), wrote editorSchema.js (458 ln) + editorClipboard.js (143 ln), died writing core; Coder2 audited clipboard, died writing core again; Coder3 wrote editorCore.js (715 ln) with death-safe incremental workflow, died before tests.
- **Attempt 4 (`P3AD5Coder4`, 47m, test session)**: NEW test/editorCore.test.js — 15 headless tests on real importer fixtures + real DocumentProjectStore: projection fidelity across all 9 D1 kinds; TypeError batteries; tiling-exact user typing with CAS/epoch/revision chain; selection-only no-op; span-policy flip; tr.split wholesale path with id reminting; atomic multi-block ai-replace (one revision, one undo); undo bottom no-op; stale CAS conflict + reload recovery; selectionGuard precedence incl. fail-closed null-revision; paste fragment minting; freshness integration (edit flips fresh→stale, translations never deleted); log-safety static+runtime; 13-case precondition battery; fingerprint-correction save semantics.
  - PRODUCT FIXES REQUIRED BY TESTS: (1) editorSchema.js called createAppError at 14 sites WITHOUT importing it — every typed-error path threw ReferenceError; import added. (2) editorCore.js projection divergence after minting commits (persisted b0,b1,b2 vs projected b0,b1,b1) — fixed by rewriting the committed transaction as one whole-document ReplaceStep carrying canonical content (selection remapped via Mapping, origin/history metas preserved); naive alternatives disproven by tests (raw replay diverges; addToHistory:false swamps undo inversion).
  - Main verified independently: **381/381**, tsc exit 0, diff confined to allowed files.
- **Next Step**: P3AD5Reviewer1 full review.

## P3A.D5 — Review 1
- **Review (`P3AD5Reviewer1`, 19m27s)**: **changes_requested** — 10 findings (2 CRITICAL / 4 HIGH / 3 MEDIUM / 1 LOW). Invariants 3/4/8 held; 1/2/5/6 violated; 7 partial. J2 untouched; D1-D4 unregressed.
  1. **[CRITICAL]** Persistence cascade non-atomic (:675-698): updateBlockText×N + fingerprint save + setSpanPolicy×N as independent mutations — mid-failure leaves disk/binding/projection divergent; §10.8 all-or-nothing violated. Required: ONE validated candidate through one CAS/WAL mutation or real batch primitive; failure-injection tests per phase.
  2. **[CRITICAL]** `_commitProjection` never checks tr.before == current state; writes store BEFORE _advance → retained old transaction persists stale/reverted doc then throws mismatched-transaction. Required: reject tr.before ≠ current before ANY store call; preflight state application; stale-tr zero-write test.
  3. **[HIGH]** `setMeta('closeHistory', true)` ineffective (library reads private closeHistory$ key); adjacent typing + programmatic op group into one undo event (masked by distant-block test). Required: library closeHistory(tr) everywhere incl. rewrites; adjacent grouping test.
  4. **[HIGH]** Empty AI text accepted but EDITOR_SCHEMA.text('') throws RangeError — deletion impossible. Required: delete/empty-fragment representation; whole-block and partial empty tests + undo/freshness.
  5. **[HIGH]** Clipboard sanitizer has NO production callsite; foreign IDs survive stamped fast-path; raw paste bypasses sanitizer; Node-input drops text-node content. Required: mandatory sanitize/remint at paste boundary with destination context; round-trip no-private-ID tests.
  6. **[HIGH]** blockContentEqual ignores span ids AND structural attrs → identity-only transactions advance RAW without persisting (divergence, foreign ids accepted). Required: canonicalize/reject identity+attrs changes pre-no-op; ID-only and attrs-only tests.
  7. **[MEDIUM]** Minted spans hard-code translate policy — protected split/paste loses protection. Required: preserve effective policy on split/copy; destination policy for external paste; tests.
  8. **[MEDIUM]** selectionGuard lacks blockId/chunkId/range anchor check — identical text elsewhere passes. Required: structural anchor in contract or documented integration-layer enforcement; moved-range tests.
  9. **[MEDIUM/test]** Suite non-discriminating for findings 1-7 (no clipboard tests, empty replacement, mid-commit failure, stale tr.before, adjacent grouping, protected split/paste, identity-only). Required per list.
  10. **[LOW]** loadDocumentIntoEditor accepts translation-only tblock kind. Required: BLOCK_KINDS gate + hostile-kind test.
- **Next Step**: Coder Fix1 (attempt 5) — all ten; keep 381 green.

## P3A.D5 — Attempts 5-7
- **Attempt 5 (`P3AD5CoderFix1`, 38m, provider death)**: landed only the clipboard-module half of F5 (toFragment text-node bug fixed; module now 154 ln); died before the core rewrite.
- **Attempt 6 (`P3AD5CoderFix2`, 60m, runtime-limit abort)**: rewrote editorCore.js (994 ln) — atomic candidate-commit via saveDocumentArchive replacing the mutation cascade; stale-tr.before rejection before any store call; library closeHistory(tr); empty replacement via delete/fragment; sanitizer wired into applyPaste with destination-policy reminting (stamped fast-path removed); identity/attrs change detection before the no-op branch; BLOCK_KINDS source gate; assumeChanged option for authorized identity retiles. Smoke-green across all ten findings; aborted while updating tests — five old tests left failing on stale cascade expectations.
- **Attempt 7 (`P3AD5CoderFix3`, 13m, test-only)**: all five failures were stale expectations rewritten for atomic semantics (one candidate saveDocumentArchive; policy deltas folded into one save; mandatory remint). Eight new tests: save-seam failure injection (CAS/disk/validation throws) asserting disk/binding/projection/revision invariants; stale tr.before typed CONFLICT zero-interaction; adjacent same-block closeHistory undo separation; empty whole/partial replacements + undo/freshness; real applyPaste sanitizer + destination protection + bare-text preservation; identity-only canonicalized retile / attrs-only typed rejection; universal persisted==projection checks; protected split policy preservation. Anchor and tblock hostile checks folded into existing tests.
  - Main verified independently: **389/389**, tsc exit 0 incl. contracts coverage.
- **Next Step**: P3AD5Reviewer2 full re-review of the ten resolutions.

## P3A.D5 — Review 2 (delta)
- **Review (`P3AD5Reviewer2`, 5m30s)**: **approved**, zero findings.
  - All ten findings verified closed on the rewritten core: atomic single-candidate CAS/WAL persistence; stale-tr rejection; library closeHistory helper; empty-delete representation; mandatory sanitizer with destination reminting; identity-drift detection; policy inheritance; structural selection guard; discriminating test pack; BLOCK_KINDS gate.
  - Invariants 1-8 held. 389/389 + tsc consistent; scope confined to D5 files. Graphify stale (0 edges for editorCore) — real-source inspection used.
- **Next Step**: QA confirmation -> close D5 -> backup push -> P3A.D6.

## P3A.D5 — CLOSED
- **Confirmation (`P3AD5Tester1`)**: PASS — npm test 389/389; focused editor suite 23/23; tsc exit 0; representative regressions confirmed by name (atomic save-seam injection, stale tr.before rejection, adjacent closeHistory separation, sanitizer/remint round-trip incl. destination policy, identity-only canonicalization, BLOCK_KINDS hostile gate).
- **Full cycle**: 7 coder attempts across split sessions (survived 2 provider deaths + 1 runtime-limit abort with zero progress loss via incremental/split strategy); findings converged 10 → 0 on the rewritten atomic core; Reviewer2 approved zero-findings; invariants 1-8 held.
- **Closure transaction**: STEPS `[x] P3A.D5`; backup push #5 (product diff + snapshot mirror refresh).
- **Next Step**: P3A.D6 Multi-language/review — continuous pipeline, no pause.

## P3A.D6 — Attempt 1
- **Attempt 1 (workflow-coder `P3AD6Coder1`)**: NEW reviewService.js (537 ln) + test/reviewService.test.js (6 broad tests, 319 ln) + documents.ts D6 types. APIs: createDocumentReviewService, approveBlock/revokeBlock/setBlockNeedsReview (CAS), pure filterReviewBlocks/queryReviewBlocks/filterReviewBlockIds, getReviewProgress (D3 token reconciliation), language state/provenance exposure, active-language view wrapper, removeLanguage confirmation+backup contract. Main verified: **395/395**, tsc clean, diff scoped to 3 files.
- **Next Step**: P3AD6Reviewer1 full review.

## P3A.D6 — Review 1
- **Review (`P3AD6Reviewer1`, 1m39s)**: **approved**, zero blockers. §10.5/§10.9 correctly implemented over D2 primitives: revision-guarded transition matrix (approve/revoke/needs-review with CAS-first ordering, idempotent no-op), pure deterministic filters orthogonalizing stale(freshness) vs status, plan-reconciled token progress without cross-language copies, isolated per-language archives. Scope clean three-file diff.
  - Advisory (non-blocking): (a) JSDoc on filterReviewBlocks/matchesFilter — filters are orthogonal predicates, stale+approved may appear in both sets, 'all' is union; (b) document in planTokenProgress that done is per-slice reconciling against per-slice total (relies on D3 canonical equality); (c) additive test gaps: revoke/setNeedsReview/removeLanguage CAS conflicts, approve-on-approved VALIDATION_FAILED, unknown-filter TypeError, language-keyed plans in listLanguageReviewStates; (d) ReviewProgress dual-boxing noted harmless/additive.
  - Advisories (a)-(c) transferred to the P4/D6-hardening backlog; (d) no action.
- **Next Step**: QA confirmation -> close D6 -> backup push -> P3A.D7.

## P3A.D6 — CLOSED
- **Confirmation (`P3AD6Tester1`, 2m11s)**: PASS — npm test 395/395; focused reviewService suite 6/6; tsc exit 0; named spot gate 5/5 (lifecycle CAS, filters determinism, byte-wise isolation, removal confirmation/backup, progress reconciliation).
- **Full cycle**: 1 coder attempt, 1 review round — **approved zero blockers** on first pass; advisories (JSDoc orthogonality, planTokenProgress invariant, additive test gaps) transferred to P4/D6-hardening backlog. Suite grew 389 → 395.
- **Closure transaction**: STEPS `[x] P3A.D6`; backup push #6 (product diff + snapshot mirror refresh).
- **Next Step**: P3A.D7 Selection/find/replace/proofread — continuous pipeline, no pause.

## P3A.D6 — CLOSED
- **Confirmation (`P3AD6Tester1`, 2m11s)**: PASS — npm test 395/395; focused reviewService suite 6/6; named spot gate 5/5 (lifecycle CAS, filters, byte-wise isolation, removal confirmation/backup, progress reconciliation).
- **Full cycle**: 1 coder attempt, 1 review round — approved zero blockers first pass. Suite grew 389 → 395.
- **Closure transaction**: STEPS `[x] P3A.D6`; backup push #6.
- **Next Step**: P3A.D7 Selection/find/replace/proofread.

## P3A.D7 — Attempt 1
- **Attempt 1 (workflow-coder `P3AD7Coder1`, 18m)**: NEW selectionOps.js (345 ln: captureSelectionSnapshot/createSelectionSnapshot, guardSelection, applySelectionResponse via D5 applyProgrammaticReplace), findReplace.js (263 ln: scanMatches/previewReplaceAll pure scan + protected-span exclusion, replaceAll as ONE applyUserTransaction transaction), proofread.js (327 ln: D3/D6 alignment, sentence/counterpart highlights, sourceRefreshMergeReport); documents.ts SelectionBlockFragment + expanded SelectionSnapshot; test/documentD7.test.js 9 tests incl. real createEditorBinding+DocumentProjectStore integration and undo. Main verified: **404/404**, tsc clean, diff scoped to 5 files.
- **Next Step**: P3AD7Reviewer1 full review.

## P3A.D7 — Review 1
- **Review (`P3AD7Reviewer1`, 3m19s)**: **changes_requested** — 7 findings (1 CRITICAL / 2 MAJOR / 4 MINOR). §10.8 snapshot/guarded-replace largely correct (atomic D5 binding, zero-write denials, exact range, protected exclusion, one-transaction replaceAll); §10.9 alignment/freshness/refresh-report correct; real D5+D2 integration proven. Scope clean.
  1. **[CRITICAL]** SelectionSnapshot contract omits operationId (:1618-1630) while runtime requires it (capture/validate/D5 meta) — §10.8 completeness broken, typed consumers would build invalid snapshots.
  2. **[MAJOR]** Same root: code/contract divergence — preferred fix: restore operationId to the contract (matches D5 telemetry).
  3. **[MAJOR]** computeHighlightRanges counterpart not proportional on split slices (:203-218): selecting 0..5 of a 0..19 slice highlights the entire 0..20 counterpart. Required: proportional sub-range within the counterpart interval; split-block test with partial selection crossing slice boundary (two tight highlight entries).
  4. **[MINOR]** Whole-block source-hash mismatch denies as selection-changed instead of source-revision-moved (:198-220). Required: document chosen reason or remap when binding revision moved; pin with comment+test.
  5. **[MINOR]** findReplace branch coverage gaps: caseSensitive, wholeWord, regex groups, overlapping non-overlap handling, empty replacement. Required targeted tests.
  6. **[MINOR]** replaceAll rollback test asserts archive but not PM state (binding.state.doc) after failure. Required: assert both unchanged; optional real-binding store-proxy failure injection.
  7. **[MINOR]** Missing-translation row (missing/null-freshness/0..0) and sentence-tail null handling unasserted in alignment/highlights. Required tests.
- **Next Step**: Coder Fix1 (attempt 2) — all seven; keep 404 green.

## P3A.D7 — Attempt 2
- **Attempt 2 (workflow-coder `P3AD7CoderFix1`)**: closed all seven Reviewer1 findings.
  - F1/F2: SelectionSnapshot.operationId restored to the contract + runtime docs aligned; test proves missing-opId invalid, valid passes guard+apply end-to-end.
  - F3: proofread counterpartRangeForSelection projects proportional subranges per row; split-cross-boundary regression asserts two tight highlight entries.
  - F4: whole-block hash mismatch documented as selection-changed (revision move remains source-revision-moved); unrelated-edit test pins the reason.
  - F5: matcher branch tests — caseSensitive both ways, wholeWord boundaries, regex $1/$&, aaa/aaaa overlap, protected edge, empty replacement. findReplace implementation UNCHANGED (coverage was the gap).
  - F6: fake rollback asserts PM state unchanged; real D2 store-proxy save failure asserts PM/archive/disk unchanged.
  - F7: missing-translation row/status/freshness/0..0, empty/null counterpart, sentence-tail null tests.
  - Main verified independently: **409/409** (+5), tsc exit 0 incl. contracts coverage; diff confined to four allowed files (findReplace untouched).
- **Next Step**: P3AD7Reviewer2 delta re-review.

## P3A.D7 — Review 2 (delta)
- **Review (`P3AD7Reviewer2`, 4m3s)**: **changes_requested** — F3-F7 CLOSED; F1/F2 PARTIAL. §10.8 guard/apply atomic + protected-exclusion correct; §10.9 proportional projection correct; D1-D6 untouched; tests additive.
  1. **[major]** Contract now drops `language: string` and `chunkId: string|null` that runtime still requires (selectionOps :110-114/:166/:172; editorCore :386/:401) — typed consumers omit required fields → always invalid-snapshot deny. Inverse of the original F1/F2.
  2. **[major]** Two divergent runtime validators: editorCore.isValidSelectionSnapshot (:383-405) checks only old scalar shape (never blockFragments/sourceHashes) while selectionOps.validateSnapshot (:165-192) checks the new full shape — malformed snapshots can pass one and fail the other. Required: align editorCore with contract+selectionOps (full structural validation) OR explicitly delegate and fix its TSDoc claim.
  3. **[major]** operationId not propagated into D5 transaction meta/audit despite TSDoc claim (:540-620 applyProgrammaticReplace stamps only origin; selectionOps :321 passes {origin, operationId}). Required: stamp operationId meta + include in commit audit, or narrow TSDoc to returned-to-caller; regression asserting propagation.
- **Next Step**: Coder Fix2 (attempt 3) — coherent SelectionSnapshot contract/validator/meta alignment; keep 409 green.

## P3A.D7 — Attempt 3
- **Attempt 3 (workflow-coder `P3AD7CoderFix2`)**: closed all three Reviewer2 residuals with ONE coherent SelectionSnapshot alignment.
  - R1: contract now includes/documented operationId, language, chunkId, blockId, textHash/textLength, blockFragments/sourceHashes, optional char range, source/target revisions, createdAt — exact runtime mirror.
  - R2: editorCore.isValidSelectionSnapshot lazy-requires selectionOps.validateSelectionSnapshot (single canonical validator; divergent copy deleted).
  - R3: applyProgrammaticReplace stamps `vaniscript/operationId`; _recommitWithResolved preserves it; _commitProjection returns audit {origin, operationId}.
  - Tests: missing language/chunk rejected; malformed fragments/hashes rejected by BOTH paths; valid full shape accepted end-to-end; audit propagation asserted. Main-authorized exception: editorCore.test.js legacy guard fixture migrated to full shape (only extra file).
  - Main verified independently: **410/410** (+1), tsc exit 0 incl. contracts coverage.
- **Next Step**: P3AD7Reviewer3 delta re-review of R1-R3.

## P3A.D7 — Review 3 (delta)
- **Review (`P3AD7Reviewer3`, 2m26s)**: **approved**, zero findings.
  - R1 closed: contract carries the exact runtime mirror (operationId/language/chunkId/blockId/textHash/textLength/blockFragments/sourceHashes/optional char range/both revisions/createdAt).
  - R2 closed: single canonical validator in selectionOps, lazily delegated from editorCore (divergent copy deleted); both-path regressions.
  - R3 closed: operationId stamped, preserved through canonical rewrite, observably returned in commit audit; guarded end-to-end regression.
  - Suite 410/410 (+1) and tsc clean.
- **Next Step**: QA confirmation -> close D7 -> backup push #7 -> PAUSE per Human directive.

## P3A.D7 — CLOSED
- **Confirmation (`P3AD7Tester1`)**: PASS — npm test 410/410; focused documentD7 suite 15/15; tsc exit 0; spot confirmations by name (operationId end-to-end guard/apply, real D5+D2 apply/audit/undo, proportional counterpart across split slices, hash-move pin, matcher branches, rollback PM+archive+disk, missing-translation alignment).
- **Full cycle**: 3 coder attempts, 3 reviewer rounds; findings converged 7 → 3 → 0; final approved zero-findings. Suite grew 395 → 410 across the item.
- **Closure transaction**: STEPS `[x] P3A.D7`; backup push #7 (product diff + snapshot mirror refresh).
- **PIPELINE PAUSED** per Human directive (~18:20Z): D8..P5 deferred until explicit Human command.

## P3A.D8 — Attempt 1
- **Attempt 1 (workflow-coder `P3AD8Coder1`, 19m)**: NEW export.js (872 ln) — self-contained DOC-08 exporter over derived DocumentArchive + optional TranslationArchive (source asset untouched): deterministic TXT/MD projections, standards-shaped stored-ZIP OOXML DOCX (headings/lists/tables/textboxes/styles/header/footer/notes), readable text-layer PDF; atomic `wx`+`rename` output writes, component-walk symlink deny (only `/var`,`/tmp` OS aliases resolved), `..`-segment traversal rejection, ZIP entry-name guard (dup/`..`), XML unpaired-surrogate/control/reserved codepoint rejection, dynamic Markdown fences, stale/NEEDS_REVIEW export warnings; safeFileName sanitization. documents.ts +55 (DOCUMENT_EXPORT_FORMATS, request/result contracts); ipc/index.mts +34 typed handler factory/default route; preload/index.mts +19 typed exportDocument bridge. 11 tests (+244 ln documentExport.test.js): canonical TXT/MD bytes + round-trips through the D1 import parser (TXT/MD/DOCX/PDF), language isolation + NEEDS_REVIEW, traversal/symlink denial, IPC route. No new deps. Known limitations (declared): DOCX rebuilt from normalized derived blocks (archive carries no raw OOXML package); non-WinAnsi chars normalize deterministically to '?'.
- **Main verification (final source, post-hardening)**: npm test **421/421** (baseline 410 +11), focused documentExport 11/11, `tsc --noEmit` exit 0; git scope exactly 5 files (+108 tracked insertions, 2 new files); J1 immutability and J3 fail-safe guards confirmed in source (:169-181 XML rejection, :672-714 path walk, :732-748 atomic write, :418-420 zip guard).
- **Next Step**: `P3AD8Reviewer1` full review (Judgment Gates J2/J3 focus).

## P3A.D8 — Review 1
- **Review (`P3AD8Reviewer1`, 4m9s)**: **approved** — zero CRITICAL/MAJOR; 3 MINOR hardening notes. All 5 changed files read end-to-end; suite reproduced independently (421/421, focused 11/11, tsc exit 0).
  - J2 PASS: export consumes DocumentArchive/TranslationArchive strictly via D2 store contracts (loadDocumentProject/getTranslationArchive + validators); direct document/archive injection is an in-memory test seam only; no parallel persisted state.
  - J3 PASS within declared scope: traversal/symlink component-walk deny (/var,/tmp alias exception), ZIP entry guard, XML surrogate/control rejection, dynamic fences, atomic wx+rename with cleanup — present and tested.
  - O1-export PASS: deterministic TXT/MD bytes, stored-ZIP OOXML, text-layer PDF (?-fallback), round-trips through D1 importer; language isolation + warning propagation verified. Declared limitations accepted for DOC-08.
  Findings (all MINOR):
  1. ipc/index.mts :296-299 — handler forwards raw args cast to DocumentExportRequest; renderer generic invoke('documents:export', {...document}) passes registry validation (projectId/format only) and would bypass the store path, creating renderer-reachable parallel in-memory state. Fix: whitelist {projectId, format, language, outputPath, overwrite}.
  2. export.js assertSafeOutputPath :670-695 — fs.mkdirSync(recursive) precedes lstat walk; pre-planted parent symlink causes observable FS side-effect before PERMISSION_DENIED. Fix: string-validate -> lstat walk existing prefix -> mkdir -> re-walk (mirror D2 staged-path confinement).
  3. export.js makeZip :405-420 — entry-name guard rejects `..`/duplicates but not absolute or backslash names (internally generated today; future-proofing). Fix: extend name check.
- **Main routing**: findings 1-2 sit on the new IPC trust boundary (J2/J3) — one bounded fix round `P3AD8CoderFix1` before Tester; then Reviewer delta confirm; then Tester QA.

## P3A.D8 — Attempt 2 (fix round)
- **Fix round (`P3AD8CoderFix1`, 6m15s)**: closed all three Reviewer1 minors, scoped to export.js / ipc/index.mts / documentExport.test.js.
  - F1: IPC handler now whitelists {projectId, format, language, outputPath, overwrite} into a fresh request (index.mts:299-303); regression test:278-311 proves injected document/archive/translation are ignored and store projection/revision is used.
  - F2: assertSafeOutputPath reordered to staged confinement (export.js:674-740): string validation (NUL/absolute/'..') -> lstat walk of existing prefix -> mkdir -> re-walk full parent -> target symlink/regular-file check (/var,/tmp alias exception preserved); regression test:237-257 denies pre-planted parent symlink with zero outside side-effect.
  - F3: makeZip entry guard extended (':422-426'): '..', leading '/', leading '\\', embedded '\\', path.isAbsolute; regression test:137-144.
- **Main verification**: npm test **424/424** (+3), focused **14/14**, `tsc --noEmit` exit 0; git scope exactly 3 files (ipc/index.mts +4 net); fix sites confirmed in source at the cited lines.
- **Next Step**: `P3AD8Reviewer2` delta confirm of F1-F3, then Tester QA.

## P3A.D8 — Review 2 (delta)
- **Review (`P3AD8Reviewer2`, 1m34s)**: **approved**, zero findings. F1 (IPC whitelist) / F2 (staged output confinement) / F3 (zip entry guard) all verified CLOSED in real source; fix round introduced no new issues. Focused 14/14 + full 424/424 + tsc 0 reproduced.
- **Next Step**: `P3AD8Tester1` QA confirmation -> close D8 -> backup push #8.

## P3A.D8 — CLOSED
- **Confirmation (`P3AD8Tester1`)**: PASS — npm test **424/424** fail 0; focused documentExport **14/14**; `tsc --noEmit` exit 0; named spots confirmed with file:line: (a) IPC whitelist index.mts:299-303 + injected-fields regression test:278-307; (b) staged confinement export.js:674-740 + zero-outside-side-effect test:237-252; (c) deterministic second-export bytes test:78-90, TXT/MD equivalence :93-116, DOCX main/header structure :118-135, PDF %PDF/%%EOF + re-import equivalence :146-158; (d) selected-archive projection + German-only output + NEEDS_REVIEW test:160-198; (e) atomic wx/fsync/rename + finally-cleanup export.js:742-775. Scope exactly the five authorized files.
- **Full cycle**: 1 coder attempt (19m) + 1 bounded fix round (6m); findings 3 MINOR -> 0; Reviewer approved twice (full 4m9s + delta 1m34s). Suite grew 410 -> 424 across the item; tsc clean throughout.
- **Gate closure evidence**: O1 — golden import fixtures D1 (DOCX/PDF/RTF/TXT/MD) + golden export round-trips D8 (TXT/MD byte-determinism, DOCX structure re-import, PDF header/parser equivalence; RTF export out of §20 DOC-08 scope by plan); O2 — D2 persistence/restart/corruption suite + D8 language-isolation regressions; O3 — D5 mutation/undo suites + D7 stale-response guards; J1/J2/J3 — reviewer-verified source immutability, v3 archive alignment (store contracts only, no parallel persisted state; IPC seam closed), hostile-input fail-safe (traversal/symlink/ZIP/XML guards + staged confinement).
- **Closure transaction**: STEPS `[x] P3A.D8` + gates O1-O3/J1-J3 -> card **P3A CLOSED** (D1-D8); backup push #8 executes now (product diff + .workflow-snapshots mirror refresh).
- **Next Step**: pipeline awaits explicit Human decision for **P3B.D1** (Batch lane).

## P3B.D1 — Attempt 1
- **Attempt 1 (workflow-coder `P3BD1Coder1`, 20m)**: NEW batchDomain.js (1033 ln) — SQLite WAL domain per BAT-01/§11.3-11.4: schema_migrations + folder_profiles/batch_jobs/job_checkpoints/job_events (output_receipts deferred to BAT-05, watcher_generations to D2), forward-only versioned migrations applied in transactions, WAL + busy_timeout 5000 + foreign_keys, append-only triggers on job_events, transactional multi-write mutations with failure-injection coverage, checkpoints upsert + job.checkpointSaved events, maxAttempts default 3, query projections (limit/offset). Driver seams: better-sqlite3 (runtime) / node:sqlite (system-Node tests) / injected. shared/contracts/batch.ts (498 ln): BATCH_JOB_STATES/PHASES + validators mirroring documents.ts style. test/batchDomain.test.js (304 ln, 10 tests): migrations fresh+upgrade, transaction atomicity via injected failure, reopen/resume from checkpoint, append-only enforcement, CRUD/state edges. Dep justified: better-sqlite3 ^12.11.1 (Electron 34 = Node 20, node:sqlite unavailable; electron-rebuild bridges ABI).
- **Main verification**: npm test **434/434** (+10), focused 10/10, `tsc --noEmit` exit 0; npm ls better-sqlite3 OK; git scope exactly 5 files (batch module + contract + tests + package.json/-lock); source confirms pragmas :376-379, migrations :384-404, append-only triggers :109-117, checkpoint upsert+event :946-993.
- **Pre-flagged for Reviewer (plan-parity)**: state vocabulary — implementation pending/running/done/failed/cancelled vs §11.3 pending/processing/completed/failed/cancelled/blockedOutputCollision, while §11.2 UI filters themselves say running/completed (plan internally inconsistent); blockedOutputCollision absence vs BAT-05 timing.
- **Next Step**: `P3BD1Reviewer1` full review with vocabulary adjudication focus.

## P3B.D1 — Review 1
- **Review (`P3BD1Reviewer1`, 2m20s)**: **approved**, zero findings. Pragmas active and verified at runtime (WAL, FK=1, busy=5000); forward-only migrations with future/downgrade CORRUPT_DATA guard (future v99 and v-1 rejected); job_events UPDATE/DELETE abort via triggers verified; failure-injection proves rollback on enqueue; checkpoints durable across reopen with ordered events; contracts mirror runtime exactly (no D7-style divergence); driver seam honest — tests exercise real SQL. Scope clean.
- **Adjudication (binding for P3B lane)**: BATCH_JOB_STATES = pending/running/done/failed/cancelled is canonical from D1 onward; blockedOutputCollision lands with BAT-05 companion writer. UI (D6) consumes these states directly.
- **Next Step**: `P3BD1Tester1` QA confirmation -> close D1 -> backup push #9.

## P3B.D1 — CLOSED
- **Confirmation (`P3BD1Tester1`, 5m57s)**: PASS — npm test **434/434** fail 0; focused batchDomain **10/10**; `tsc --noEmit` exit 0. Named spots confirmed: pragmas on real DB file (WAL/FK=1/busy=5000), job_events UPDATE/DELETE abort, injected-failure rollback test named, close+reopen restores jobs/checkpoints with exactly one job.checkpointSaved per save, future-schema-version CORRUPT_DATA guard, contracts↔runtime single source of truth. Scope = the five authorized files.
- **Full cycle**: 1 coder attempt (20m); Reviewer approved zero-findings with binding vocabulary adjudication; Tester green first pass. Suite grew 424 -> 434.
- **Closure transaction**: STEPS `[x] P3B.D1`; backup push #9 (product diff incl. better-sqlite3 dep + snapshot mirror refresh).
- **Next Step**: `P3B.D2` Folder access/watchers — continuous pipeline.

## P3B.D2 — Attempt 1
- **Attempt 1 (workflow-coder `P3BD2Coder1`, ~25m)**: batchDomain.js extended (+116/-36, 1113 ln): forward migration adds watcher_generations (PK profile_id, CHECK generation>0; idempotent IF NOT EXISTS bootstrap for live v2 DBs), recordWatcherGeneration upsert, NEW transactional enqueueJobIfFingerprintMissing (dedupe by profile_id + source_fingerprint_json). NEW folderAccess.js (171 ln): canonical realpath + permission probe, isPermissionError classifier; Darwin bookmark seam stubbed explicitly, Win/Linux thin adapters behind one interface. NEW batchWatcher.js (538 ln): portable fs.watch tree watcher — generation guards on every entry point, per-profile:path debounce + in-flight coalescing, stability probe (>=2 unchanged size/mtime samples then SHA-256 verified by re-read; unstable -> not enqueued), ignore rules (dotfiles, .tmp/.partial/.part/.crdownload/.download, trailing '~', symlinks), recursive directory refresh after enqueue, periodic reconciliation sweep (unref'd interval), permission-loss/folder-unavailable/watcher-error issues surfaced, enqueue ONLY via domain API (no raw SQL). test/batchWatchers.test.js (205 ln, 7 tests): event-duplication acceptance, stale-generation ignore, stability, ignore rules, reconciliation-once, permission-loss, generation persistence. No deps.
- **Main verification**: npm test **441/441** (+7), combined batch suites **17/17**, `tsc --noEmit` exit 0; git scope exactly 4 files (domain modified, folderAccess/batchWatcher/tests new, zero package changes); all §11.5 mechanisms confirmed at cited lines.
- **Next Step**: `P3BD2Reviewer1` full review.

## P3B.D2 — Review 1
- **Review (`P3BD2Reviewer1`, 2m16s)**: **approved**, zero blocking findings. All six focus areas PASS: lifecycle races guarded (generation = max(persisted, in-memory)+1 monotonic across restarts, batchWatcher.js:318-326; stop() clears generation first + allSettled in-flight); dedupe profile-scoped by design (cross-profile collision NOT deduped); stability probe hashes once per stable candidate with TOCTOU retry x2; ignore rules cover .txt companions case-insensitive per §11.7 parity; Darwin bookmark stub is explicit seam for D3, not fake support; scope clean. Minor coverage gaps noted non-blocking: cross-profile fingerprint isolation, concurrent in-flight race, Windows/Linux opaque paths.
- **Environment note (non-blocking)**: running the suite from repo ROOT (not Electron/) yields 4 unrelated app-boot failures — cwd-dependent path resolution in the characterization harness. Canonical invocation remains `cd Electron && npm test` (441/441). Transferred to P4 hardening backlog.
- **Next Step**: `P3BD2Tester1` QA confirmation -> close D2 -> backup push #10.

## P3B.D2 — CLOSED
- **Confirmation (`P3BD2Tester1`)**: PASS — npm test **441/441** fail 0; combined batch suites **17/17**; `tsc --noEmit` exit 0. Six named spots confirmed: duplicate events -> one job (test:71-85; domain dedupe :831-845); retired generation ignored + generation > persisted max on fresh process (test:89-102; batchWatcher.js:233/:312-326); changing file never enqueued, stable hashed once SHA-256 (:104-143; :148-205); ignore rules incl. nested hidden dirs and symlinks (:145-155; :22-51/:100-145); permission-lost issue carries PERMISSION_DENIED (:178-193; mapping :64-79); zero SQL in watcher — grep clean, domain-only enqueue (:490-496). Scope exactly the four authorized files.
- **Process note**: Tester initially exceeded its read-only mandate by editing test/batchWatchers.test.js; reverted under direct Main order within the same session (restoration independently verified: 205 ln as delivered, suites green, scope intact). Recorded for TEAM_CONTRACT compliance; zero product impact.
- **Full cycle**: 1 coder attempt (~25m); Reviewer approved zero-blocking. Suite grew 434 -> 441 across the item.
- **Closure transaction**: STEPS `[x] P3B.D2`; backup push #10 (product diff + snapshot mirror refresh).
- **Next Step**: `P3B.D3` Stability/path safety — continuous pipeline.

## P3B.D3 — Attempt 1
- **Attempt 1 (workflow-coder `P3BD3Coder1`)**: batchDomain.js (+23/-6), batchWatcher.js (+218/-47), folderAccess.js (+194/-12), NEW test/batchSafety.test.js (277 ln, 8 tests). folderAccess: assertSafePathSyntax (NUL/control reject :32-33, POSIX backslash reject :35-36, traversal both separators :41-42), case-insensitive confinement NFC+toLocaleLowerCase for darwin/win32 (:47-66), component lstat walk w/ allowMissingLeaf + realpath root/candidate + escape PERMISSION_DENIED (:70-190); resolvePathWithinRoot returns canonical+relative (NFC) paths. batchWatcher: symlink refusal at fingerprint/walks (:64-67/:142-145/:183-186), O_NOFOLLOW|O_RDONLY hash fd (:205-208), SOURCE_CHANGED/source-unavailable issue types, observer isolation (:343-348). Fuzz: seeded 0xD3A55EED LCG, 96 adversarial entries (symlinks outside root, case variants, NFC/NFD, controls/newlines, depth 24) — invariant every enqueued job realpath inside canonical root, path-violations surfaced. Mutation: rename/delete-during-probe/hash/permission-flip fail safe. Dedupe decision (binding, preserves D2): identical complete fingerprint within one profile shares ONE job (test sets equal mtimes, asserts scanned 2/enqueued 1/duplicate 1); cross-profile independent. Darwin stays opaque canonical path (no bookmarks): main process unsandboxed, dialog-granted folders only — rationale documented, injectable factory retained.
- **Main verification**: npm test **449/449** (+8), focused batchSafety **8/8**, `tsc --noEmit` exit 0; git scope exactly the four claimed files; all mechanisms confirmed at cited lines.
- **Next Step**: `P3BD3Reviewer1` full review — focus: confinement completeness vs TOCTOU, fuzz determinism/infectiousness, dedupe decision soundness.

## P3B.D3 — Review 1
- **Review (`P3BD3Reviewer1`, 2m47s)**: **approved**, zero blocking findings; metrics reproduced independently. Confinement complete within declared single-process boundary: syntax filter, NFC case-fold, lstat-per-component + realpath deny, symlink refusal everywhere, O_NOFOLLOW fd + verified double-snapshot mitigates final-component TOCTOU; fs-event filenames validated before scheduling (:498-513); fuzz deterministic/non-flaky; dedupe binding defensible; no scope leakage.
  Informational MINORs (both self-assessed "no blocking change", transferred to P4 hardening backlog):
  1. Fuzz case-variant signal weak on Linux CI (case-sensitive FS does not exercise isWithinRoot fold) -> P4 may add explicit isWithinRoot('darwin') unit tests independent of filesystem.
  2. Intermediate-directory symlink TOCTOU not fully closed by O_NOFOLLOW (final-component only); current discard-on-verified-mismatch keeps it fail-safe; fd-anchored verification optional future hardening.
- **Next Step**: `P3BD3Tester1` QA confirmation -> close D3 -> backup push #11.

## P3B.D3 — CLOSED
- **Confirmation (`P3BD3Tester1`)**: PASS — npm test **449/449** fail 0; combined batch suites **25/25**; `tsc --noEmit` exit 0; fuzz run twice with identical 8-name pass set (determinism proven). Spots confirmed with citations: syntax filter codes (:28-44), fuzz escape invariant (:120-167), symlink refusals + O_NOFOLLOW fd (:60-67/:135-151/:176-196/:202-218), dedupe scanned 2/enqueued 1/duplicates 1 (:169-185), rename fail-safe -> 0 jobs + source issue (:187-207), fs-event validation + observer isolation runtime-verified ({handled:true, observerErrorContained:true}) (:495-513/:343-356). Scope exact. Read-only honored.
- **Full cycle**: 1 coder attempt (18m); Reviewer approved zero-blocking (2 informational MINORs -> P4 backlog). Suite grew 441 -> 449 across the item.
- **Closure transaction**: STEPS `[x] P3B.D3`; backup push #11.
- **Next Step**: `P3B.D4` Scheduler/recovery — continuous pipeline.

## P3B.D4 — Attempt 1
- **Attempt 1 (workflow-coder `P3BD4Coder1`)**: batchDomain.js (+163/-2): transactional claimNextJob (pending->running, attempt+1, job.claimed+stateChanged events :903-951); recoverRunningJobs (policy retry|fail, liveJobIds exclusion, retryable -> job.retryScheduled else job.failed w/ reason crash-recovery :968-1030); ALLOWED_TRANSITIONS running->pending added (retry path, no new states — D1 adjudication intact). NEW batchScheduler.js (560 ln): injected runner/readiness seams, single-flight claim (_active/_claimPromise), checkpoint resume token -> runner -> save, retry bounded by maxAttempts (terminal failed), pause / pause-after-current / resume / drain modes, cooperative cancel + partial cleanup, generation-normalized restart. NEW test/batchScheduler.test.js (312 ln, 10 tests): crash/restart exactly-once recovery + resume token, max-attempts terminal, single-active invariant, readiness denial, controls matrix, cancel, generation restart.
- **Main verification**: npm test **459/459** (+10), combined batch suites **35/35**, `tsc --noEmit` exit 0; git scope exactly 3 authorized files; claim/recovery mechanics confirmed at cited lines.
- **Next Step**: `P3BD4Reviewer1` full review — focus: exactly-once recovery under double-boot, cancel races mid-runner, drain semantics vs in-flight watcher enqueues, transition-matrix completeness.

## P3B.D4 — Review 1
- **Review (`P3BD4Reviewer1`, 3m25s)**: **changes_requested** — final source re-verified (460/460, tsc 0, scheduler 11/11); single-process claim guard and single-flight correct; two MAJOR cross-process hardening gaps:
  1. [MAJOR] claimNextJob :948-985 — deferred transaction + separate SELECT running guard allows double-claim across OS processes (both pass empty SELECT before either UPDATE); wrapBetterSqlite uses raw DEFERRED while wrapNodeSqlite uses BEGIN IMMEDIATE. Required: IMMEDIATE transaction or single-statement atomic claim with changes==0 check.
  2. [MAJOR] recoverRunningJobs :1015-1060 — concurrent double-boot emits duplicate job.retryScheduled/job.failed events; UPDATE result.changes ignored. Required: only emit/return rows actually transitioned; concurrent-recovery test with two domain handles on one file.
  3. [MINOR] batchScheduler cancel :425-448/:470-530 — double-cancel may invoke cooperative hook twice; guard by cancelRequested/cancelHookInvoked.
  Otherwise sound: retry bounds, readiness per-claim, transition matrix, cancel idempotency at state level, scope clean.
- **Main routing**: bounded fix round `P3BD4CoderFix1` for all three findings; then Reviewer delta confirm; then Tester QA.

## P3B.D4 — Attempt 2 (fix round)
- **Fix round (`P3BD4CoderFix1`)**: closed all three Reviewer1 findings, scoped to batchDomain.js / batchScheduler.js / test/batchScheduler.test.js.
  - F1: better-sqlite3 transactions promoted to .immediate() (:213; wrapNodeSqlite already BEGIN IMMEDIATE :243); claimNextJob now single-statement atomic UPDATE with NOT EXISTS running-guard subquery and explicit changes==0 -> no-claim return BEFORE injector/events (:931-957).
  - F2: recoverRunningJobs checks updateResult.changes — 0 skips events and recovered entry (:1034); NEW concurrent-recovery regression test/batchScheduler.test.js:203-262 — two separate BatchDomain handles on one DB via worker_threads/barrier, asserts event/recovered unions duplicate-free.
  - F3: cancel guard active.cancelRequested set before abort/hook (batchScheduler.js:373-374), initialized in active record (:397), consulted at completion/failure paths (:455/:464); double-cancel regression asserts hook count 1.
- **Main verification**: npm test **461/461** (+1 concurrent regression), focused scheduler **12/12**, `tsc --noEmit` exit 0; git scope exactly 3 files; all three fix sites confirmed at cited lines.
- **Next Step**: `P3BD4Reviewer2` delta confirm of F1-F3.

## P3B.D4 — Review 2 (delta)
- **Review (`P3BD4Reviewer2`, 2m32s)**: **approved**, zero findings. F1 (immediate tx + atomic NOT EXISTS claim with changes==0 guard before side-effects), F2 (recovery idempotent via changes==0 skip; two-handle worker_threads regression duplicate-free), F3 (cancelRequested before abort/hook with double-cancel dedup) — all CLOSED in real source. Fix round introduced no new issues; scope 3 files.
- **Next Step**: `P3BD4Tester1` QA confirmation -> close D4 -> backup push #12.

## P3B.D4 — CLOSED
- **Confirmation (`P3BD4Tester1`, 4m16s)**: PASS — npm test **461/461** fail 0; combined batch suites **37/37**; focused scheduler **12/12**; `tsc --noEmit` exit 0. Spots confirmed: two-handle worker_threads/barrier recovery duplicate-free (test:73-97/:203-262); atomic claim UPDATE/NOT EXISTS/changes==0 prevents double-running (:931-957); immediate tx both adapters (:213/:243); recovery changes==0 before events (:1008-1054); retry bound attempt==max -> failed (:264-314); double-cancel hook exactly once (:388-418; guard :373-398). Scope exact, read-only honored.
- **Full cycle**: 1 coder attempt (23m) + 1 fix round (8m53s); Reviewer1 changes_requested (2 MAJOR cross-process, 1 MINOR) -> all closed -> Reviewer2 delta approved zero-findings. Suite grew 449 -> 461.
- **Gate evidence**: P3B.O1 now fully covered (D1 migration/transaction + D4 crash/restart recovery) — checked in STEPS; P3B.J1 covered by D3 seeded fuzz — checked.
- **Closure transaction**: STEPS `[x] P3B.D4` + `[x] P3B.O1` + `[x] P3B.J1`; backup push #12.
- **Next Step**: `P3B.D5` Atomic companion writer — continuous pipeline.

## P3B.D5 — Attempt 1 (network-aborted, not counted)
- **`P3BD5Coder1`** aborted at 14m by provider-side network failure (`getaddrinfo ENOTFOUND chatgpt.com`) — transient infrastructure fault per failover policy; does NOT increment product attempts. Partial work preserved in tree per Human resume order: NEW batchCompanionWriter.js, batchDomain.js +194/-6 (migration 3 + integration), shared/contracts/batch.ts +5/-1 (enum); tests NOT started.
- **Main authorization during attempt**: output_receipts = forward migration 3 (no speculative v4 no-op); batchDomain.test.js opened STRICTLY for migration-version assertion updates ([1,2]->[1,2,3], upgrade path) after coder flagged hard baseline assertions — all other assertions untouchable.
- **Next Step**: fresh session `P3BD5Coder2` — assess preserved partials, complete implementation + tests per original assignment.

## P3B.D5 — Attempt 2
- **Continuation (`P3BD5Coder2`)**: completed from preserved partials after dual-writer incident resolved (Coder1 hard-stopped after surviving its failed session; its migration-3 restoration and /var diagnosis credited). Salvage summary per coder: kept writer/domain/enum partials; canonicalized source/output derivation fixing /var->/private/var mismatch (realpath-canonical once at derivation, alias-tolerant receipt lookup :1232-1243); NEW batchCompanionWriter.js finalized (temp wx -> fsync -> rename -> completeJobWithOutputReceipt single-transaction pairing, rollback of renamed bytes on post-rename failure, beforeCommit/beforeReceipt injection hooks); blockedOutputCollision landed per binding adjudication (enum + running->blocked + blocked->pending transitions, terminal-with-error semantics); migration 3 output_receipts (PK output_path, FK cascade, index); scheduler untouched.
- **Main verification**: npm test **472/472** (+11), focused batchCompanion **11/11**, `tsc --noEmit` exit 0; git scope exactly the five authorized files (incl. batchDomain.test.js limited 4-line assertion update [1,2]->[1,2,3]); all mechanisms confirmed at cited lines.
- **Next Step**: `P3BD5Reviewer1` full review — focus: collision matrix soundness, rename/receipt transactional pairing under injected failures, cleanup semantics vs prior-generated outputs, confinement reuse correctness.

## P3B.D5 — Review 1
- **Review (`P3BD5Reviewer1`, 2m49s)**: **approved**, zero findings; 5-file surface read end-to-end, metrics reproduced. All six focus areas PASS: rename/receipt pairing sound (fsync+rename+single-tx; created vs replacedGenerated compensation preserving foreign bytes); collision matrix complete (alias-tolerant lookup, empty-allow, same-fingerprint replace, double-inspect re-check); cleanup correct for cancelled/failed; confinement via folderAccess realpath-canonical with symlink refusal; migration forward-only; tests discriminating via injection hooks.
- **Next Step**: `P3BD5Tester1` QA confirmation -> close D5 -> backup push #13.

## P3B.D5 — CLOSED
- **Confirmation (`P3BD5Tester1`)**: PASS — npm test **472/472** fail 0; combined batch suites **48/48**; `tsc --noEmit` exit 0. Spots confirmed: external bytes preserved + blocked/retry transitions (:92-104; :39-45; contracts :20-29); same-fingerprint replaceGenerated with receipt ownership update (:107-131; writer :405-479); receipt-insert failure -> output absent/receipt null/job running/temp clean + prior restored (:195-253); /var alias runtime + alias-tolerant lookup (:17-27/:58-74; writer :351-356; domain :1221-1243); traversal/override/hidden/symlink rejections (:156-193); migration 3 fresh+upgrade ([1,2,3] both paths). Scope exact 5 files. Read-only honored.
- **Full cycle**: attempt 1 network-aborted (not counted) -> Coder2 continuation salvaging preserved partials after dual-writer incident resolved; Reviewer approved zero-findings. Suite grew 461 -> 472.
- **Gate evidence**: P3B.J2 (companion .txt collision-safe and receipted) fully covered by D5 + this QA — checked in STEPS.
- **Closure transaction**: STEPS `[x] P3B.D5` + `[x] P3B.J2`; backup push #13.
- **Next Step**: `P3B.D6` Separate Batch workspace — final item of card P3B.

## P3B.D6 — Attempt 1
- **Attempt 1 (workflow-coder `P3BD6Coder1`)**: 8 scoped files (+502/-7): batch contract extensions; IPC factory batch handlers over domain/scheduler/watcher APIs only; typed preload wrappers; NEW src/components/BatchWorkspace.tsx (separate workspace per §11.1 — no auto-start, no project auto-create, drag-and-drop add-folder); NEW src/stores/batchStore.ts (pure state machine: filters incl. collision<->blockedOutputCollision mapping, badge running/paused/failed w/ failed escalation, control states scan/start/pause-after/resume/drain/retry/cancel, getVirtualRows windowing); App.tsx route + badge button; tests: NEW test/batchWorkspace.test.js jsdom suite incl. 10k-row virtualization proof (18 rendered rows of 10000, bounded window) + preload-ipc.test.js extensions. Vite build clean.
- **Main verification**: npm test **478/478** (+6), focused 15/15, `tsc --noEmit` exit 0, `npm run vite-build` success; git scope exactly the 8 files; virtualization/badge/collision-filter mechanisms confirmed at cited lines.
- **Coder-noted limitation**: production window-manager still boots legacy preload.js/main.js (pre-existing P1 legacy-adapter condition, NOT a D6 regression); typed bridge factory tested/injected — global preload cutover is a cross-cutting candidate for P4.
- **Next Step**: `P3BD6Reviewer1` full review — focus: §11.2 semantics compliance, IPC surface minimality, virtualization correctness at boundaries, legacy-preload deferral adjudication.

## P3B.D6 — Review 1
- **Review (`P3BD6Reviewer1`, 2m37s)**: **approved**, zero findings; 8-file surface verified end-to-end, metrics reproduced (478/478, tsc 0, vite-build clean). §11.1-11.2 separate-workspace semantics met; virtualization proof bounded and non-tautological with DOM check; IPC strictly over domain/scheduler/watcher APIs with typed bridge + local validation, no raw SQL; store pure/injectable, no localStorage/Node; controls FSM prevents impossible combinations. **Adjudication**: legacy preload cutover correctly deferred to P4 (cross-cutting, pre-existing P1 condition).
- **Next Step**: `P3BD6Tester1` QA confirmation -> close D6 + O2 -> card P3B COMPLETE -> backup push #14.

## P3B.D6 — CLOSED
- **Confirmation (`P3BD6Tester1`, 7m38s)**: PASS — npm test **478/478** fail 0; focused **15/15**; tsc/vite-build clean. Six spots confirmed incl. non-tautological 10k virtualization proof, badge escalation FSM impossibility checks, no-auto-start path, IPC discipline (no direct Node from renderer), project-state-preserving route. Scope exact 8 files. Read-only honored.
- **Card P3B — COMPLETE**: D1-D6 closed across 5 cycles (one changes_requested round at D4); suite grew 424 -> 478 (+54 in lane; 208 -> 478 overall). Gates: O1 (D1+D4), O2 (D6 proof), J1 (D3 fuzz), J2 (D5 receipts) — all evidence-backed. Binding adjudications recorded (states, blockedOutputCollision@BAT-05, fingerprint dedupe). Deferred to P4: legacy-preload cutover, Linux fuzz case-fold units, fd-anchored TOCTOU hardening, root-cwd harness fix.
- **Closure transaction**: STEPS `[x] P3B.D6` + `[x] P3B.O2` -> card **P3B COMPLETE**; backup push #14.
- **Next Step**: `P3C.D1` Loopback MCP server/auth/audit — continuous pipeline continues into card P3C.

## P3C.D1 — Attempt 1
- **Attempt 1 (workflow-coder `P3CD1Coder1`)**: NEW electron/main/mcp/mcpServer.js (968 ln) per §13.1: loopback-only bind (127.0.0.1/::1 enforced, BIND_REJECTED otherwise; per-request loopback origin check), Bearer tokens = crypto.randomBytes(32) stored as vault refs + registry (SET-02), SHA-256-digest timingSafeEqual with full-registry scan (no count-dependent early return), revoked/expired/unavailable typed errors, fail-closed on locked vault, rotate/revoke w/ rollback; initialize protocol/version negotiation; request size (413)/timeout (408)/concurrency (429) limits + graceful drain stop/restart; bounded redacted audit projection (timestamp/peer/route/outcome/tokenId — no payloads) w/ once-per-request guard; response envelope carries projectId/projectRevision for D2/D3 tools. NEW shared/contracts/mcp.ts (221 ln): MCP error codes->app taxonomy/status mapping, handshake/envelope types. NEW test/mcpServer.test.js (354 ln, 13 tests): external-bind rejection, token matrix (invalid/expired/revoked/vault-fail), negotiation, size/timeout/concurrency limits, audit redaction assertions, rotation flows, drain.
- **Main verification**: npm test **491/491** (+13), focused mcpServer **13/13**, `tsc --noEmit` exit 0; git scope exactly 3 new files; all §13.1 mechanisms confirmed at cited lines. (Coder's parent-gitignore note N/A — product repo is Electron/.)
- **Next Step**: `P3CD1Reviewer1` full review — focus: trust-boundary completeness (origin vs proxy tricks), token lifecycle races, limit bypass vectors, audit redaction sufficiency.

## P3C.D1 — Review 1
- **Review (`P3CD1Reviewer1`, 3m9s)**: **approved**, zero findings; full read of all three files, metrics reproduced. All §13.5/§13.6 mechanisms verified in source: bind enforcement pre-listen, Origin empty->allow-native/loopback-only reflect, vault Bearer tokens with digest timingSafeEqual full-scan, typed 401/503 token errors, fail-closed, rotate/revoke rollback, version negotiation (2024-11-05/2025-03-26), 413/408/429 + global timeout + socket-set drain, bounded once-per-request redacted audit with hash(tokenId), envelope passthrough. **Adjudication**: standalone-module-without-wiring sound for D1 scope.
- **Next Step**: `P3CD1Tester1` QA confirmation -> close D1 -> backup push #15.

## P3C.D1 — QA 1
- **QA (`P3CD1Tester1`, 6m56s)**: **FAIL** — audit redaction leak. Runtime repro: POST initialize with payload requestId='payload-manuscript-secret-72491' -> 200, then getAuditLog() contains that exact payload text. Client controls ctx.requestId via x-request-id header (mcpServer.js:718) AND payload.requestId (:802); _recordAudit persists it verbatim (:609). Sanitizer strips control chars + truncates 128 but keeps arbitrary user text — violates §13.1 "audit record без пользовательского текста по умолчанию". All other probes PASS: npm test 491/491, focused 13/13, tsc 0, scope 3 files, bind/IPv6/token matrix/full-scan/limits/counter-cleanup green. Existing audit test checked only params.secret (reviewer gap). Read-only honored.
- **Main verification**: confirmed at cited lines; envelope echo (:639) and handler-context passthrough (:699) judged acceptable (caller's own data / D2-D3 seam).
- **Adjudication**: replace audit field with requestIdHash = sha256(ctx.requestId) (pattern of existing tokenIdHash); extend redaction test to assert no client-controlled text (header + payload paths).
- **Next Step**: `P3CD1CoderFix1` fix round -> Reviewer2 delta -> Tester2 re-confirm.

## P3C.D1 — Fix Round
- **Fix (`P3CD1CoderFix1`, 5m10s)**: adjudicated redaction fix applied exactly — audit record field requestId -> requestIdHash = sha256(ctx.requestId) (pattern of tokenIdHash); envelope echo + handler-context passthrough untouched; tests extended dual-path (payload-manuscript-secret-* AND header-manuscript-secret-* markers) with hash stability/difference assertions and !('requestId' in record); mcp.ts audit type+validator renamed (string|null). Diff +1/-1 server, +61/-24 tests, +6/-3 contract.
- **Main verification**: npm test **491/491**, focused **13/13**, tsc exit 0; source confirmed at :609; scope unchanged (same 3 files).
- **Next Step**: `P3CD1Reviewer2` delta review of the fix diff -> Tester2 re-confirm QA.

## P3C.D1 — Review 2
- **Review (`P3CD1Reviewer2`, 2m13s)**: **approved**, zero findings — delta verified in real source: leak closed via requestIdHash=sha256 at :609 with tokenIdHash parity; envelope echo (:639)/handler context (:699) preserved as transient correlation; BOTH capture sites (:718 header, :802 payload) now hashed; contract validator/type renamed; dual-path test exercises both sites with stability/difference asserts and no raw marker leak; sha256 helper reused (no new crypto); no remaining record.requestId consumer; scope confined. §13.6 diagnostics-without-leak met.
- **Next Step**: `P3CD1Tester2` QA re-confirm -> close D1 + gate O1 -> backup push #15.

## P3C.D1 — CLOSED
- **Confirmation (`P3CD1Tester2`, 7m14s)**: PASS — npm test **491/491** fail 0; focused **13/13**; tsc exit 0. Original-defect repro clean: payload/header requestId markers absent from serialized audit (hash-only, stable/different asserts); record inventory exactly timestamp/peer/route/tool/outcome/tokenIdHash/requestIdHash; loopback 127.0.0.1 + ::1 initialize 200 with counters drained to 0; bind rejection, token matrix, 413/408/429 limits all green; activeRequests/connections 0 after stop. Scope exact 3 files. Read-only honored.
- **Gate note**: P3C.O1 ("Network/auth and tool schema tests") — network/auth half proven here; tool schema tests land with D2, gate check deferred to D2 closure (P3B.O1 precedent).
- **Cycle summary**: 1 coder attempt + 1 fix round (QA-caught requestId leak, adjudicated to hash-only audit) + Reviewer2 delta approve + Tester2 PASS. Suite 478 -> 491 (+13).
- **Closure transaction**: STEPS `[x] P3C.D1`; backup push #15.
- **Next Step**: `P3CD2Coder1` Read tool catalog (MCP-02: project/transcript/document/help reads, schema tests).

## P3C.D2 — Attempt 1
- **Attempt 1 (workflow-coder `P3CD2Coder1`)**: read tool catalog per §13.3 read families + §20 MCP-02. NEW electron/main/mcp/mcpTools/readCatalog.js — 36 read-only tool definitions (project/transcript/glossary/document/help + read-only shorts/export/settings projections), each with scope:'read'/risk:'read'/capability mcp.read/input+result JSON schemas/readOnlyHint annotations/confirmationText:null; deterministic envelope schemaVersion/tool/scope/risk/projectId/projectRevision/data; real adapters over ProjectStore (default store + baseDir injection), glossary from project/settings, bounded help catalog; unknown tool -> MCP_METHOD_NOT_FOUND. mcpServer.js: auto-registration, tools/list + tools/call over D1 seam (additive). contracts/mcp.ts: risk/schema/catalog/result-envelope types (+64). NEW test/mcpReadCatalog.test.js (+4): schemas, live loopback e2e, envelope, METHOD_NOT_FOUND, audit-without-payload, no-mutation spot.
- **Main verification**: npm test **495/491→495** (+4), focused readCatalog+mcpServer **17/17**, tsc exit 0; git scope exactly 4 files; mechanisms confirmed at cited lines.
- **Flagged for review adjudication**: (1) documented "harmless empty projections" for shorts/export-domain tools until P3E adapters exist — acceptable interim vs stub policy; (2) list_export_options returns txt/markdown/srt/vtt while D8 shipped docx/txt/md/pdf — factual alignment check.
- **Next Step**: `P3CD2Reviewer1` full review.

## P3C.D2 — Review 1
- **Review (`P3CD2Reviewer1`, 7m22s)**: **approved** with 1 MINOR hardening note. Full read of all 4 files + runtime probes + metrics reproduced (495/495, tsc 0). No mutation/file/network/destructive leakage; no audit payload leak; no aliasing leak; registration seam additive/reversible over D1 auth/limits.
- **Adjudications**: (1) empty projections for shorts/export-domain tools accepted as documented interim until P3E adapters; (2) list_export_options transcriptFormats txt/markdown/srt/vtt = canonical TRANSCRIPT export family, distinct from D8's DOCUMENT family (contracts/documents.ts:1735-1741 docx/txt/md/pdf); alignment of Electron transcript exporters lands in P3E.D3 parity item.
- **MINOR**: safeClone (:300-315) checks secret-key regex only after !isObject early return -> leaf string secrets bypass filtering (synthetic injection verified: apiKey/token/password leak through get_safe_settings). NOT live — prod secrets are vault-isolated keyRefs, ProjectV3 carries no plaintext. Fix: move SECRET_RE guard before primitive return + regression test.
- **Next Step**: `P3CD2CoderFix1` fix round -> Reviewer2 delta -> Tester.

## P3C.D2 — Fix Round
- **Fix (`P3CD2CoderFix1`, 3m6s)**: adjudicated MINOR applied exactly — safeClone secret-key regex guard moved to function ENTRY before array/primitive returns; filePath denylist + deep-clone isolation untouched; regression added (apiKey/token/password primitives at nested depth dropped, non-secret siblings survive).
- **Main verification**: npm test **496/496** (+1), focused **18/18**, tsc exit 0; source confirmed at :300-315; scope confined to readCatalog.js + test file.
- **Next Step**: `P3CD2Reviewer2` delta review -> Tester QA re-confirm.

## P3C.D2 — Review 2
- **Review (`P3CD2Reviewer2`, 3m7s)**: **approved**, zero findings — delta verified in real source: entry-position guard drops all secret-named primitives at any depth incl. arrays; denylist/deep-clone/stableClone untouched; regression discriminating (fails on pre-fix ordering). Over-redaction on substrings ('tokens'/'secretariat'/'passport') adjudicated fail-safe and acceptable — no canonical read-projection field matches per settings.ts; dropping beats leaking. Scope intact.
- **Next Step**: `P3CD2Tester1` QA confirmation -> close D2 + gate O1 -> backup push #16.

## P3C.D2 — CLOSED
- **Confirmation (`P3CD2Tester1`, 6m)**: PASS — npm test **496/496** fail 0; focused **18/18**; tsc exit 0. Gate **P3C.O1 GREEN** (network/auth half from D1 + tool-schema half from D2).
- **Cycle summary**: coder attempt (36-tool read catalog over D1 seam) -> Reviewer1 approved w/ 1 MINOR (safeClone leaf-secret bypass) + 2 adjudications (empty projections = documented interim until P3E; transcript vs document export format families distinct, alignment at P3E.D3) -> fix round (entry-position secret guard + discriminating regression) -> Reviewer2 delta approved zero-findings -> Tester PASS. Suite 491 -> 496 (+5).
- **Closure transaction**: STEPS `[x] P3C.D2` + `[x] P3C.O1`; backup push #16.
- **Next Step**: `P3CD3Coder1` Mutation/processing tools w/ permissions/confirmation/revision guards (MCP-03; gates O2/J1 close with it).

## P3C.D3 — Attempt 1
- **Attempt 1 (workflow-coder `P3CD3Coder1`, 35m42s)**: mutation/processing catalog per §13.2/§13.5 + §20 MCP-03. NEW electron/main/mcp/mcpTools/mutationCatalog.js — 12 bounded tools (update_chunk_text/update_cue_text/update_cue_timestamps, glossary CRUD, approve_chunk/batch approve+revoke, retranslate/reprocess/cancel_processing processing-scope, read-risk get_processing_status). Architecture: permission scopes default-deny w/ injectable settings matrix (403 before handler invoke); one-time TTL confirmation challenges (120s default) bound to bearer tokenId + tool + projectId + expectedProjectRevision + stable args hash — consume() burns token BEFORE validation so any mismatch/expiry/replay invalidates; typed STALE_REVISION 409 with double-check inside per-project lock (withProjectLock finally-release + map cleanup); revision bump atomic via ProjectStore.saveProject(expectedRevision); real batch/scheduler/settings adapters; redacted audit; deterministic envelopes w/ confirmationText. mcpServer.js: seam registration + error mapping (428 challenge/invalid, 409 stale, 403 denied). contracts/mcp.ts +43 policy/challenge/mutation types. NEW test/mcpMutationCatalog.test.js (8): deny/stale/TTL/token-identity/exact-args/serialized-concurrency/adapters/redaction.
- **Main verification**: npm test **504/504** ×4 consecutive runs (+8), focused **8/8**, tsc exit 0; git scope exactly 4 files; mechanisms confirmed at cited lines. One anomalous early Main run showed 481 tests / 3 fail (not reproducible in 4 subsequent runs incl. coder's) — classified transient environment flake; REVIEWER/TESTER: watch scheduler/lock/vault timing sensitivity.
- **Next Step**: `P3CD3Reviewer1` full review — gates O2/J1 close on this item.

## P3C.D3 — Review 1
- **Review (`P3CD3Reviewer1`, 6m45s)**: **changes_requested** — 1 CRITICAL + 4 MAJOR + 3 MINOR. Gates O2/J1 NOT closed.
- **[CRITICAL] §13.5 violation**: confirmationToken returned to the agent inside 428 error.details -> agent self-confirms on next tools/call (runtime-proven: single tokenId executed update_chunk_text with no other channel; tests encoded this as success path). Fix adjudicated: challenge response = challengeId+confirmationText+requiresHumanConfirmation ONLY; approval lives server-side behind a Main-only confirm endpoint (IPC channel the agent bearer cannot call); mutation executes only when challenge is human-approved, binding-matched, unexpired; consumed on first execution; confirmationToken removed from input schema/contract; tests rewritten so echoing any details token fails.
- **[MAJOR] audit codes**: challenge/invalid/stale all logged as undifferentiated 'rejected' — add redacted mcpCode (+reason enum) to audit records; tests assert CONFIRMATION_REQUIRED/INVALID, STALE_REVISION, PERMISSION_DENIED present, token/payload absent (J1 evidence).
- **[MAJOR] adapter arity**: default cancel wired to scheduler.cancel/batchDomain.cancelJob(jobId: string) but invoked with raw args object — runtime probe: token burned then VALIDATION_FAILED; BatchScheduler lacks status() for get_processing_status. Wrap real signatures; never bind raw methods of unknown arity.
- **[MAJOR] path leak**: mutation get_processing_status overwrites D2 path-safe reader; custom/scheduler status results cloned not safeClone'd — probe returned sourcePath/outputPath. safeClone every status payload (§13.5).
- **[MAJOR] O2 store gap**: 8 tests exercise in-memory draft.revision path; store.saveProject(draft, expectedRevision) CAS never proven on real store; CONFLICT must map to STALE_REVISION before any in-memory replaceObject; add stale-vs-real-store test (disk+memory unchanged).
- **[MINOR] x3**: glossary text/variants bounds missing (3 of 12 tools); approve_chunk hard-codes approved=true (honor args.approved); un-awaited async stop() in test teardown (flake-watch: plausible cross-suite FD/listen interaction; TTL/scheduler cleared as flake sources).
- **Next Step**: `P3CD3CoderFix1` fix round (all 8) -> Reviewer2 full re-review -> Tester.

## P3C.D3 — Fix Round
- **Fix (`P3CD3CoderFix1`)**: all 8 findings resolved. CRITICAL redesign landed: challenge 428 details = challengeId/confirmationText/requiresHumanConfirmation/expiresAt ONLY (secret internal); input schema challengeId replaces confirmationToken everywhere incl. contracts; approval server-side via ConfirmationStore.approve(challengeId) exposed as McpServer.confirmChallenge -> NEW IPC channel mcp:confirmChallenge (separate Main-only seam w/ sender-validator requirement; agent bearer cannot invoke); consume() requires approved else typed 'not_approved', deletes on success. MAJORs: audit records gain redacted mcpCode + reason enum ('required'/'unknown_or_expired'/'challenge_mismatch'/'not_approved'); cancel adapter wraps real jobId-string arity; status payloads safeClone'd (sourcePath/filePath/outputPath stripped); store CAS — persist always via saveProject(draft, expectedRevision), CONFLICT->STALE before in-memory replace, stale-vs-store test proves disk+memory unchanged. MINORs: glossary bounds+variants cap; approve_chunk honors args.approved; async stop() awaited in teardowns.
- **Main verification**: npm test **508/508** (+4), focused **12/12**, tsc exit 0; scope exactly 5 authorized files; mechanisms confirmed at cited lines (mutationCatalog :422-479/:799/:710, mcpServer :649-657/:683-706, ipc :227-seam, tests :194/:412/:457).
- **Next Step**: `P3CD3Reviewer2` full re-review (gates O2/J1) -> Tester.

## P3C.D3 — Review 2
- **Review (`P3CD3Reviewer2`, 17m1s)**: **approved**, zero blocking findings — gates **O2 PASS**, **J1 PASS**. Adversarial runtime probes clean: 428 details expose only challengeId/confirmationText/expiresAt/requiresHumanConfirmation (no token/secret/payload echo); NO tool executes with bearer-only access; concurrent double-consume of one approved challenge -> exactly one 200; challenge binding (tool/argsHash/tokenId/projectId/revision) verified at execute time; confirmChallenge/approveChallenge absent from HTTP method set and tools/list (Main-class + IPC only); real createProjectStore probe: stale -> 409 with byte-identical disk file, fresh+approve persists and bumps. O2 evidence incl. serialization (one 200 + one 409 on same-revision pair) and mock-store CONFLICT mapping; J1 evidence: default-deny matrix, redacted mcpCode + bounded reason enum, payload/bearer absence. All 8 per-fix confirmations LANDED. Flake watch clear (injected now(), no catalog timers, teardowns awaited).
- **Residuals (non-blocking, recorded)**: (1) mutation get_processing_status supersedes D2's project-derived reader with a sanitized scheduler stub — parity to revisit at D4 wiring; (2) mcp:confirmChannel validateSender omission is fail-open by existing ipc convention (registerIpcRouter precedent) — footgun for UI wiring lane, NOT an agent bypass; add to P4 hardening backlog alongside legacy-preload cutover.
- **Next Step**: `P3CD3Tester1` QA confirmation -> close D3 + O2/J1 -> backup push #17.

## P3C.D3 — CLOSED
- **Confirmation (`P3CD3Tester1`)**: PASS — npm test **508/508** fail 0; focused **12/12**; tsc exit 0; named-probe filter 7/7. Human-only repro independent: 428 exactly {challengeId, confirmationText, expiresAt, requiresHumanConfirmation}; echo-all -> 428 challenge_mismatch; Main approve -> one execution; replay -> unknown_or_expired (:194-259/:420-471/:645-657). Stale/deny 403-before-handler + 409 memory+disk unchanged (:173-192/:279-295/:483-520); audit distinguishes all 4 mcpCodes + not_approved, sole write path redacted-only; status strips paths; cancel passes plain jobId string. Scope exact 5 files. Gates **O2 GREEN**, **J1 GREEN**. No product bugs. Read-only honored.
- **Cycle summary**: coder attempt -> Reviewer1 changes_requested (CRITICAL self-confirmable token + 4 MAJOR) -> fix round w/ binding human-approval redesign (server-side approval, Main-only IPC seam) -> Reviewer2 approved w/ adversarial probes -> Tester PASS. Suite 496 -> 508 (+12). Two non-blocking residuals -> P4 backlog.
- **Closure transaction**: STEPS `[x] P3C.D3` + `[x] P3C.O2` + `[x] P3C.J1`; backup push #17.
- **Next Step**: `P3CD4Coder1` Agent clients Codex/Grok/Qwen stream/cancel (MCP-04).

## P3C.D4 — Attempt 1
- **Attempt 1 (workflow-coder `P3CD4Coder1`)**: NEW electron/main/agents/agentClients.js — three profiles (codex=OpenAI Responses, grok=xAI Chat Completions, qwen=DashScope compatible-mode) over injectable fetch; SSE/JSONL StreamParser w/ typed malformed-stream errors; AgentStream w/ AbortController, idempotent cancel, reader.cancel+body drain in finally (no orphaned readers/timers); tokens redacted against the stream's own secret; vault-only credentials (PERMISSION_DENIED when missing); network allowlist policy (loopback + configured hosts); AgentHistoryStore — sha256(profile+projectId) keyed entries, ring limit 20, atomic 0600 writes OUTSIDE project JSON (userData/agents fallback ~/.vaniscript), redaction on append AND read (secret-shaped strings, absolute paths, manuscript-key markers). NEW test/agentClients.test.js (5): mock-server streaming order/malformed/mid-stream-abort/cancel-idempotency/vault-leak/history-bounds-redaction.
- **Main verification**: npm test **513/513** (+5), focused **5/5**, tsc exit 0; git scope exactly 2 new files; mechanisms confirmed at cited lines.
- **Flagged for review**: (1) coverage depth — 5 tests across large surface; (2) user input redactString'd BEFORE provider send (:879) — legitimate absolute paths in prompts get mangled (safe-direction but usability tradeoff); adjudicate intended semantics.
- **Next Step**: `P3CD4Reviewer1` full review.

## P3C.D4 — Review 1
- **Review (`P3CD4Reviewer1`, 18m34s)**: **changes_requested** — 3 MAJOR + 1 MEDIUM. Scope/cancel primitive/scope hygiene pass; J2 preview POSITIVE (cancel-before-fetch/during-vault/mid-stream/double-cancel/listener-throw all clean; stays open until D5 wires UI cancel).
- **Adjudications**: (1) outbound redactString INTENDED for paths (§13.5) but DEFECT as implemented — silent rewrite + SECRET_SHAPED key/token heuristic mangles legitimate prompts (`token_budget_exceeded_warning` -> `[REDACTED]`) and inbound tokens; fix = drop heuristic from outbound/tokens (keep exact vault-secret substitution), document path stripping on start(), surface redactions array on done/error/status for D5. (2) Coverage not blocking; probed non-blockers work (SSE split chunks, non-ok redaction, corruption fallback, cancel-during-secret fetchCalled=0, allowlist); blocking gaps = the failing paths below.
- **[MAJOR] Codex parser**: official response.output_text.annotation.added throws unknown_event killing live streams; response.incomplete throws; ANY string delta (reasoning summaries, function-call args) emitted as visible output. Fix: ignore unknown non-error events; tokens only from output_text/text deltas; failed/error/incomplete -> PROVIDER_ERROR; mock test incl. annotation event.
- **[MAJOR] truncated stream**: body end without terminal event settles done + persists history (partial turn replays next start()). Fix: PROVIDER_ERROR reason=incomplete_stream, no history persist; test.
- **[MEDIUM] reasoning_content**: Grok/Qwen flatten thinking into tokens/history/output. Fix: ignore/separate channel; persist only answer content; test.
- **Next Step**: `P3CD4CoderFix1` fix round -> Reviewer2 delta -> Tester.

## P3C.D4 — Fix Round
- **Fix (`P3CD4CoderFix1`, 7m20s)**: all 4 findings resolved. Outbound/inbound text now via sanitizeOutboundText/sanitizeInboundText — SECRET_SHAPED heuristic removed from prompts and tokens (exact vault-secret substitution kept); §13.5 path strip documented + redactions report [{kind,count}] surfaced on done/error/status; Codex parser: visible-delta whitelist (output_text/text), unknown non-error events ignored (annotation.added survives), failed/error/incomplete -> PROVIDER_ERROR(reason); truncated body without terminal event -> incomplete_stream error, historyPersisted false; reasoning_content no longer flattened (content-only tokens/history). Tests +5 incl. token_budget survival, path-strip-with-report, annotation-event completion, truncated-stream error, reasoning separation.
- **Main verification**: npm test **518/518** (+5), focused **10/10**, tsc exit 0; source confirmed at cited lines (:309-341/:354-356/:514/:691-811); scope exactly 2 files.
- **Next Step**: `P3CD4Reviewer2` delta review -> Tester.

## P3C.D4 — Review 2
- **Review (`P3CD4Reviewer2`, 10m10s)**: **approved**, zero blocking findings — all 4 fixes verified in source + independent runtime probes; no §13.5 regression (vault-secret substituted inbound/outbound; history/errors still scrubbed via retained redactString on append AND read); whitelist covers official Responses spellings + bare proxied forms; incomplete_stream semantics match provider conventions ([DONE]/finish_reason/usage frames terminal); redactions report stable fixed-shape w/ accurate shared accumulator; all 5 new tests empirically discriminating.
- **Residuals (non-blocking)**: (1) response.refusal.delta silently ignored — refusal = empty-output success; surface in D5 UI backlog; (2) per-chunk inbound secret substitution can miss a vault secret split across chunk boundaries in the LIVE stream (persisted history still redacts) — adjudicated tradeoff of dropping shape heuristics from tokens; revisit if needed at D5.
- **Next Step**: `P3CD4Tester1` QA confirmation -> close D4 -> backup push #18.

## P3C.D4 — CLOSED
- **Confirmation (`P3CD4Tester1`, 5m57s)**: PASS — npm test **518/518** fail 0; focused **10/10**; tsc exit 0. Read-only honored.
- **Cycle summary**: coder attempt -> Reviewer1 changes_requested (3 MAJOR: over-broad silent outbound redaction incl. key/token heuristic; Codex parser killed live streams on official annotation events + leaked non-text deltas; truncated stream settled done with history persist; MEDIUM reasoning_content flattened) -> fix round (sanitizer split w/ redactions report, delta whitelist, incomplete_stream, content-only) -> Reviewer2 delta approved w/ runtime probes (tests empirically discriminating) -> Tester PASS. Suite 508 -> 518 (+10). Non-blocking residuals for D5 backlog: refusal.delta silence, per-chunk secret substitution tradeoff.
- **Closure transaction**: STEPS `[x] P3C.D4`; backup push #18.
- **Next Step**: `P3CD5Coder1` Assistant UI/integrations (MCP-05: sidebar/dictation/send selection; acceptance E2E/tool confirmation; gate J2 closes).

## P3C.D5 — Attempt 1
- **Attempt 1 (workflow-coder `P3CD5Coder1`, 12m37s)**: NEW src/stores/assistantStore.ts (619) + src/components/AssistantSidebar.tsx (259) + test/assistantSidebar.test.js (11 tests); integration touchpoints +73/-9 across App.tsx (sidebar replaces ChatSidebar mount), TextPanel.tsx (transcript menu), ShortsReelsPanel.tsx (clip modal title/hook/summary), SubtitleAlignmentEditor.tsx (selected overlay/segment). Architecture: injectable AssistantBridge over D4 API (listProfiles/start/cancel); FSM idle/starting/streaming/done/error/cancelled w/ stale-event runId guards; cancel -> AgentStream.cancel (J2 test: state cancelled, active=0, streamId null, late tokens ignored); profile/model/reasoning selectors (Grok reasoning hidden); running-tool indicator; copy/retry-last; bounded send-to-assistant (4000 chars, 280 preview) w/ explicit source label; attachments/screenshot via OPAQUE handles only — fs-path-like handles rejected; mutation challenges listed + approved strictly via mcp:confirmChallenge bridge (never auto-accepted); redactions report displayed on done/error; dictation UI-state only w/ honest DICTATION_DEFERRED when seam absent (no invented transcript); conversation messages stay in store, not project JSON. Production window bridge optional — absent seams error honestly (AGENT_STREAM_SEAM_DEFERRED).
- **Main verification**: npm test **529/529** (+11), focused **11/11**, tsc exit 0, vite build clean (1.28s); scope exactly 7 files; mechanisms confirmed at cited lines.
- **Flagged for review**: ChatSidebar.tsx left unmounted-but-present — dead code removal vs intentional keep (clean-cutover rule); production preload seam absence (startAgentStream etc. not yet exposed) — acceptable defer-with-contract per assignment?
- **Next Step**: `P3CD5Reviewer1` full review (gate J2 closes here; card P3C completes after QA).

## P3C.D5 — Review 1
- **Review (`P3CD5Reviewer1`, 15m42s)**: **approved**, zero blocking findings — gate **P3C.J2 PASS** (cancel path driven through REAL D4 transport over local HTTP mock: AgentStream.cancel reached, active empty, late tokens unobservable, rapid send/cancel/send clean, retry-after-cancel safe, all four terminal paths clear stream state). §13.4/§13.5 verified in source+probes: approvals count 0 before human click, challenge state bounded {challengeId, confirmationText}, fs-path-like attachment handles rejected (drive/UNC/leading-/), selections bounded 4000/280, dictation honest deferred; 4 integration touchpoints purely additive.
- **Adjudications**: (1) ChatSidebar.tsx = intentional keep under target-file discipline (zero importers, unbundled, shared CSS reused by AssistantSidebar); standalone removal micro-item -> P4 backlog (.tsx only). (2) preload seam absence = defer-with-contract ACCEPTABLE (honest degradation runtime-verified; consistent w/ D1/D6/D3 precedents); tracked follow-up -> P4: expose startAgentStream/confirmMcpChallenge/pickers/dictation + registerMcpConfirmationChannel callsite via dedicated api.confirmMcpChallenge (NOT dispatch facade).
- **Non-blocking notes**: cancel() without active stream spuriously flips phase (store-API misuse only); void-ed async actions may raise unhandled rejections on injected bridges; memory-only history cap advisable at persistence design; manual-cancel partial-loss cosmetic inconsistency.
- **Next Step**: `P3CD5Tester1` QA confirmation -> close D5 + J2 -> CARD P3C COMPLETE -> backup push #19.

## P3C.D5 — CLOSED / CARD P3C COMPLETE
- **Confirmation (`P3CD5Tester1`)**: PASS — npm test **529/529** fail 0; focused **11/11**; tsc exit 0; vite build 1908 modules; named spots 5/5 w/ runtime probes (J2 active=0 + late-token ignored; approvals 0->1 on click, challenge removed; drive/UNC/-path handles rejected honestly; exact deferred strings; panel bounds+labels). Scope exact 7 files. Read-only honored.
- **Gate note**: **P3C.J2 GREEN** (closes with D5 per plan).
- **CARD P3C SUMMARY**: 5 items, 3 fix rounds (D3 CRITICAL self-confirmable token -> human-only approval redesign; D4 redaction/parser/truncation/reasoning; D1 requestId leak), suite **478 -> 529** in card (+51). Gates O1/O2/J1/J2 ALL GREEN. Loopback MCP server/auth/audit + read catalog (36) + mutation catalog (12) w/ human-only confirmation + agent clients (Codex/Grok/Qwen) + assistant UI/integrations. Backlog carried to P4: ChatSidebar.tsx removal micro-item; preload agent/challenge/picker/dictation seam + registerMcpConfirmationChannel callsite (dedicated api.confirmMcpChallenge, not dispatch facade); mcp:confirm validateSender fail-open footgun; refusal.delta surfacing; per-chunk secret substitution tradeoff; mutation get_processing_status parity vs D2 reader.
- **Closure transaction**: STEPS `[x] P3C.D5` + `[x] P3C.J2`; backup push #19.
- **Next Step**: `P3DD1Coder1` Update state/readiness (UPD-01) — continuous pipeline into card P3D.

## P3D.D1 — Attempt 1
- **Attempt 1 (workflow-coder `P3DD1Coder1`, 12m58s)**: NEW electron/main/updates/updateService.js (+796) — §12.1 FSM idle->checking->upToDate|available->downloading->verifying->readyToInstall->installing->idle|failed w/ CONFLICT on illegal moves; user actions only (checkNow/downloadNow/installNow/skipVersion/remindLater/cancelDownload/retry); autoDownload/autoInstall hard-false even if requested (documented explicit-action gate); injected feed (requireFeedSignature/assertFeedIntegrity D2 tamper seams); collectBlockers() live-aggregates all 9 §12.3 categories (aliases collapsed; batchScheduler.activeJob reused); installNow RE-COLLECTS blockers -> UPDATE_BLOCKED{kind:blockers,reasons}, quit-prep failure -> {kind:quit-prep}; critical only changes presentation.emphasis; prepareForUpdateTermination(bounded) flushes settings/projects/sqlite(checkpointWal)/recovery; receipts validated+atomic outside project JSON incl. failure receipts. NEW shared/contracts/updates.ts (+498): states/actions/channels/blocker categories/transitions tables/descriptor/feed/snapshot/blocker/receipt/quit types + validators. NEW test/updateService.test.js (+21): FSM matrix, illegal transitions, auto-gate proof, per-category blocker aggregation, blocked->clear->install, critical presentation-only, quit-prep timeout/failure not-ready, receipts success/failure, skip/remind/cancel/retry.
- **Main verification**: npm test **550/550** (+21), focused **21/21**, tsc exit 0; git scope exactly 3 new files; mechanisms confirmed at cited lines (:4-9/:508-525/:621-622/:743-763).
- **Next Step**: `P3DD1Reviewer1` full review.

## P3D.D1 — Review 1
- **Review (`P3DD1Reviewer1`, 13m53s)**: **changes_requested** — 1 MAJOR + 3 MINOR. FSM complete vs §12.1 (9 states, 11 descriptor fields, illegal->CONFLICT); explicit-action gate solid incl. critical-presentation-only; blocker engine 9/9 w/ live re-collection + real batchScheduler integration; quit-prep global-budget slicing sound; receipts both-direction validated w/ artifactHash groundwork; scope clean.
- **[MAJOR]** shared/contracts/updates.ts ships 6 strict-mode TS2322 errors AND is excluded from repo tsc target (tsconfig include lacks it) — exact P3A.D2-R1-F2 defect class ('contract errors invisible'). Fix per precedent: total assignments (?? null) at :389/:391/:395/:396/:437/:491; standalone `tsc --strict --noEmit` exit 0; add to tsconfig include (P3AD2Fix1 pattern).
- **[MINOR]** _rethrow leaks foreign codes (runtime-probe: EISDIR surfaces as snapshot.error.code) — gate passthrough on isErrorCode; foreign -> INTERNAL w/ originalCode detail; regression test (PROVIDER_ERROR passthrough unaffected).
- **[MINOR]** blocker normalization fail-open: malformed truthy probe objects silently read as ready-to-install (throw path is fail-closed but untested). Fix: unrecognized shapes -> blockers; discriminating tests for probe-throw + malformed-object.
- **[MINOR]** 4 pinning gaps (probe-verified correct today): installer {outcome:'failed'} without throw; quit-prep budget starvation; feed array/bare-descriptor normalize forms; requireFeedSignature happy path. One test each.
- **Next Step**: `P3DD1CoderFix1` fix round -> Reviewer2 delta -> Tester.

## P3D.D1 — Fix Round
- **Fix (`P3DD1CoderFix1`)**: all 4 findings resolved. Contract totals applied at the six TS2322 sites; updates.ts added to tsconfig include (:22) so repo tsc now covers it; standalone strict gate per Main adjudication — bare invocation's TS5097/parse5 noise ruled environment (NOT contract defect; no import-style/deps workaround authorized), working command `npx tsc --strict --noEmit --skipLibCheck --allowImportingTsExtensions --moduleResolution bundler --module ESNext --noErrorTruncation shared/contracts/updates.ts` exit 0 w/o any TS2322 (Main independently reproduced). _rethrow gated on isErrorCode -> foreign codes map to INTERNAL w/ originalCode detail; blocker normalization fail-closed (unrecognized_shape -> blocker); +6 tests incl. 4 pinning branches + error-gate + malformed-probe regressions.
- **Main verification**: npm test **556/556** (+6), focused **27/27**, tsc exit 0, standalone strict exit 0 (own run); scope = 3 files + tsconfig include.
- **Next Step**: `P3DD1Reviewer2` delta review -> Tester.

## P3D.D1 — Review 2
- **Review (`P3DD1Reviewer2`, 7m31s)**: **approved**, zero findings — all 4 fixes closed in real source; decisive coverage proof: sandbox-reverting one total assignment reproduces TS2322 exactly at :395/:491 under repo-style strict project, proving tsconfig include genuinely catches the P3A.D2-R1-F2 defect class; own runs: repo tsc exit 0 + adjudicated standalone strict exit 0, no new strict issues. Error-gate end-to-end (real EISDIR through installNow -> INTERNAL + originalCode, thrown+snapshot deepEqual, single normalization pass, no double-wrapping); PROVIDER_ERROR passthrough green. Fail-closed normalization preserves all recognized shapes (false/null clear, arrays recurse, block-objects w/ alias-resolved category); unrecognized -> unrecognized_shape; dedupe/aliases/batchScheduler fallback intact. Pinning tests discriminating (starvation test would catch global-budget slicing regression). Scope exact.
- **Next Step**: `P3DD1Tester1` QA confirmation -> close D1 -> backup push #20.

## P3D.D1 — QA 1
- **QA (`P3DD1Tester1`, 5m52s)**: FAIL on one boundary spot — `prepareForUpdateTermination(0)` returns {ready:false, timedOut:true, timeoutMs:0} (immediate timeout -> install aborts) while -1 throws VALIDATION_FAILED; no boundary test pins it. Main spot wording derived from Reviewer1 summary line 'zero/negative budgets rejected' — imprecise. Spots a/b/d/e PASS (explicit gate, live blockers clear-to-install, receipts+artifactHash, tsconfig include); metrics 556/556, 27/27, tsc 0, standalone strict 0; scope exact. Read-only honored.
- **Adjudication**: behavior CORRECT and fail-safe (negative = invalid input; zero = valid hopeless budget -> not-ready, install refused) — keep semantics, pin with zero-budget boundary test + one doc line on prepareForUpdateTermination; record correction: Reviewer1 summary line imprecise, source never rejected zero.
- **Next Step**: `P3DD1CoderFix2` micro fix (test + doc only) -> Reviewer2 delta confirm -> Tester2.

## P3D.D1 — Micro Fix
- **Fix (`P3DD1CoderFix2`, 3m40s)**: adjudicated micro applied exactly — zero/negative boundary test pins 0 -> {ready:false,timedOut:true,timeoutMs:0} w/o flusher side effects + installNow UPDATE_BLOCKED{quit-prep}, -1 -> VALIDATION_FAILED; one doc line states boundary semantics. No behavior changes.
- **Main verification**: npm test **557/557** (+1), focused **28/28**, tsc exit 0; test :522/:554, doc :372 confirmed.
- **Next Step**: `P3DD1Reviewer3` delta confirm -> Tester2 re-confirm -> close D1 -> push #20.

## P3D.D1 — Review 3
- **Review (`P3DD1Reviewer3`, 8m10s)**: **approved**, zero findings — micro-delta confirmed: boundary test discriminating w/ counting flushers proving zero side effects, verbatim match to QA-1 adjudication; doc line accurate vs validation gate (:374-377) + zero fallthrough; no behavior change (inert JSDoc only); independent runs reproduce Main evidence (557/557, 28/28, tsc 0, standalone strict 0); scope confined to test + comment.
- **Next Step**: `P3DD1Tester2` QA re-confirm -> close D1 -> backup push #20.

## P3D.D1 — CLOSED
- **Confirmation (`P3DD1Tester2`)**: PASS — npm test **557/557** fail 0; focused **28/28**; tsc exit 0; standalone strict exit 0. Boundary repro green (0 -> not-ready w/o flushes, installNow quit-prep; -1 VALIDATION_FAILED); explicit gate + critical presentation-only; live blockers clear-to-install; receipts validated atomic; tsconfig include effective. Scope exact. Read-only honored.
- **Cycle summary**: coder attempt -> Reviewer1 changes_requested (MAJOR invisible strict-mode contract errors — P3A.D2-R1-F2 class; 3 MINOR) -> fix round (totals + include, isErrorCode gate, fail-closed probes, pinning tests) -> Reviewer2 approved w/ decisive sandbox-revert coverage proof -> QA-1 boundary FAIL (adjudicated keep-semantics, record corrected) -> micro fix -> Reviewer3 confirmed -> Tester2 PASS. Suite 529 -> 557 (+28).
- **Closure transaction**: STEPS `[x] P3D.D1`; backup push #20.
- **Next Step**: `P3DD2Coder1` Platform updater adapters mac/win/linux (UPD-02).

## P3D.D2 — Attempt 1
- **Attempt 1 (workflow-coder `P3DD2Coder1`)**: NEW electron/main/updates/platformAdapters.js — per-platform policies as auditable data (darwin zip+json ed25519-or-dsa hook / win32 nsis-web-squirrel authenticode-or-hash / linux appimage-deb-rpm format-dependent); MANDATORY feed signature (unsigned -> TAMPERED; missing verifier -> TAMPERED; caller cannot disable via options — requireFeedSignature hardwired true at service seam); install REFUSES unverified artifacts (verified-descriptor WeakSet); artifact hash mismatch -> TAMPERED, no-verifier-no-hash fail-closed; channel/platform/arch matching enforced at feed and descriptor level w/ typed mismatch errors incl. index; linux policy matrix AppImage=in-app vs deb/rpm=manual-or-repo w/ CAPABILITY_UNAVAILABLE on install attempt; feed normalization tolerant of array/bare/descriptor forms; D1 composition via fetchFeed/download/verify/requireFeedSignature/assertFeedIntegrity seams. Extended contracts/updates.ts (artifactType) + errors.ts (TAMPERED) + shared-contracts test.
- **Main verification**: npm test **571/571** (+14), focused **14/14**, tsc exit 0, standalone strict exit 0 (own run); scope = 2 new + 2 contract extensions + shared-contracts test.
- **Next Step**: `P3DD2Reviewer1` full review.

## P3D.D2 — Review 1 (session failure)
- **`P3DD1Reviewer1`-style session failure (`P3DD2Reviewer1`, 3m54s)**: exited without yield after reading only TEAM_CONTRACT; Main's delta-IRC interrupted its initial wait and the session never resumed tool calls (3x3 idle reminders, zero review work performed). Classified provider/session failure — does NOT increment product attempts (failover policy). No verdict produced.
- **Next Step**: `P3DD2Reviewer2` fresh full-review session w/ delta notice baked into assignment.

## P3D.D2 — Review 1
- **Review (`P3DD2Reviewer2`, 16m45s)**: **changes_requested** — 3 MAJOR + 2 MINOR; gate O1 FAILS pending fixes. Verification ORDERING sound everywhere; linux matrix matches plan; D1 composition intact; TAMPERED taxonomy proper.
- **[MAJOR] declared-hash-wins** (probe-proven): verify() trusts download-result declared artifactHash over actual bytes -> {artifact:evil, artifactHash:expected} verifies ok without hashing bytes; transport metadata is unsigned so this defeats §12.5 exactly under tampering. Fix: when bytes AND expected present ALWAYS compute digest from bytes and compare vs expected; declared hashes only corroborate; declared-vs-computed disagreement -> TAMPERED. Regressions (a) lying hash + tampered bytes -> TAMPERED, (b) honest bytes w/o declared hash -> verified via compute.
- **[MAJOR] verified-set identity reuse** (probe-proven): plain Set of identity strings excludes url/infoUrl and allows nullable artifactHash -> verify(hashless A) then install(same-identity B, different infoUrl) succeeds unverified. Public seam risk for UPD-03/REL-02. Fix: bind verification to exact descriptor object (WeakSet + key+identity required at install) or refuse hook-only verification for hashless descriptors.
- **[MAJOR] zero coverage of claimed tamper defenses**: byte-level hash-mismatch path (computeArtifactHash/hashesMatch) and no-verifier-no-hash fail-closed never invoked by any test; feed-normalization forms also unexercised — reviewer had to probe to confirm they work. O1 evidence incomplete until pinned. Fix: tests for findings 1-2 + no-hook-hashless TAMPERED + corrupt-bytes-no-declared-hash TAMPERED + array-form and bare-object feeds end-to-end.
- **[MINOR]** darwin dmg reported in-app-installable vs §12.4 (ZIP = auto-update vehicle, DMG manual) + 'dmg' absent from UPDATE_ARTIFACT_TYPES union -> explicit manual policy or drop; add to union if retained; focused assertion. Array-form feeds structurally unsignable -> guaranteed TAMPERED dead end: document + pin test.
- **Next Step**: `P3DD2CoderFix1` fix round -> Reviewer3 delta -> Tester.

## P3D.D2 — Fix Round
- **Fix (`P3DD2CoderFix1`, 13m30s)**: all 5 findings resolved. Bytes-first digest: when bytes+expected present — always computeArtifactHash(bytes), compute-fail -> TAMPERED, mismatch -> TAMPERED w/ actual, EVERY declared hash must corroborate computed else TAMPERED 'declaration does not match verified artifact bytes'; dual-declared disagreement -> TAMPERED; expected-without-bytes falls back to declared-match only. Verified-state binding: WeakSet(object) + WeakMap(descriptor->key), install requires BOTH identity and key match. darwin dmg -> manual installPolicy mirroring linux split + dmg added to UPDATE_ARTIFACT_TYPES. Array-feed unsigned documented + direct TAMPERED guard. +9 discriminating tests (lying-declared, honest-undeclared, identity-reuse refusal, byte-mismatch, no-hook-hashless, corrupt-bytes, feed forms, dmg policy).
- **Main verification**: npm test **580/580** (+9), focused **23/23**, tsc exit 0, standalone strict exit 0 (own run); verify() logic confirmed at :511-576, install gate :579-591; scope = 3 authorized files (+82/+209/+1 lines).
- **Next Step**: `P3DD2Reviewer3` delta review -> Tester.

## P3D.D2 — Review 2
- **Review (`P3DD2Reviewer3`, 17m44s)**: **approved**, zero findings — gate **P3D.O1 PASS**. MAJOR-1 closed w/ probes: declared can never outrank bytes (compute-fail/mismatch/corroboration-failure/dual-disagreement all TAMPERED); foreign-algorithm declarations fail closed; hashesMatch normalization keeps legitimate different-format-equal digests verifiable. MAJOR-2 closed: verify(A)/install(B-distinct) refused; post-verify mutation of same object -> key mismatch refused; same-object service flow unbroken incl. hashless+hook. MAJOR-3 closed: all defense paths pinned (:183-373). MINORs closed: dmg manual policy e2e-proven (installs=0, CAPABILITY_UNAVAILABLE), array feeds fail-closed documented. Ordering signature->download->install holds everywhere; requireFeedSignature hardwired past caller options.
- **Next Step**: `P3DD2Tester1` QA confirmation -> close D2 + O1 -> backup push #21.

## P3D.D2 — CLOSED
- **Confirmation (`P3DD2Tester1`)**: PASS — npm test **580/580** fail 0; focused **23/23**; tsc exit 0; standalone strict exit 0. Independent probes: tamper repro TAMPERED w/ install calls 0; honest-undeclared verified via computed sha256; identity binding refused/accepted correctly; requireFeedSignature non-disableable (caller false + unsigned -> TAMPERED); channel/platform/arch mismatches typed at both levels; linux AppImage success vs deb/rpm+dmg CAPABILITY_UNAVAILABLE w/ installer never invoked. Scope exact. Read-only honored.
- **Gate note**: **P3D.O1 GREEN** (state/failure half closed at D1; fake feed/tamper half here).
- **Cycle summary**: coder attempt -> reviewer session crash (no product cost) -> Reviewer2 changes_requested (3 MAJOR probe-proven: declared-hash-wins, verified-set reuse, zero tamper-path coverage; 2 MINOR) -> fix round (bytes-first digest + corroboration, WeakSet+WeakMap binding, dmg manual policy, array-feed guard, +9 tests) -> Reviewer3 approved zero-findings -> Tester PASS. Suite 557 -> 580 (+23).
- **Note**: tester reported root Graphify graph stale for the Electron surface (returned unrelated nodes); source-based verification used instead — graphify rebuild queued post-card.
- **Closure transaction**: STEPS `[x] P3D.D2` + `[x] P3D.O1`; backup push #21.
- **Next Step**: `P3DD3Coder1` Updates Settings/UI: check/download/install UX (UPD-03) — card final item.

## P3D.D3 — Attempt 1
- **Attempt 1 (workflow-coder `P3DD3Coder1`, 18m31s)**: NEW src/stores/updatesStore.ts + src/components/UpdatesPanel.tsx + test/updatesPanel.test.js (5 tests); M src/components/SettingsModal.tsx (Updates tab mount). Architecture: injectable UpdateBridge over D1 API (direct methods OR invoke-command fallback); FSM-mirror snapshot w/ per-state action map — installNow gated on blockers.length===0 AND state legality; PRE-COLLECT blockers inside installNow (never pretends critical bypasses readiness); presentation emphasis critical/informational w/ autoDownload/autoInstall hard-false in renderer view; typed error surfacing incl. UPDATE_BLOCKED reasons -> blocker list refresh + TAMPERED redaction of feed metadata; descriptor/receipt summaries sanitized (hashes stay in Main); skip/remind/cancel/retry wired 1:1; capabilities projection per artifactType; honest UPDATE_BRIDGE_DEFERRED when Main seam absent. Tests: FSM mirror + illegal-action disabling, critical+blockers second-press flow, TAMPERED surfacing w/o metadata leak, explicit actions one-to-one, deferred honesty.
- **Main verification**: npm test **585/585** (+5), focused **5/5**, tsc exit 0, vite build clean 1.25s; scope exactly 4 files; mechanisms confirmed at cited lines. NOTE: moving-candidate incident #3 — Main caught intermediate state failing (full-suite 1 fail + focused 1 fail) before coder's final hardening pass; final tree verified green across all gates.
- **Next Step**: `P3DD3Reviewer1` full review (gate O2 closes here; card P3D completes after QA).

### P3D.D3 Reviewer — Attempt 1
- **Reviewer (`P3DD3Reviewer2`, fresh re-dispatch after session restart)**: **APPROVED_WITH_RESIDUALS**. Scope conforms exactly to the four declared files. J1 PASS: `updateService.installNow()` re-collects blockers and awaits quit preparation before the `installing` transition or installer invocation. J2 PASS: signed-feed enforcement remains authoritative in Main; renderer preserves `TAMPERED`, redacts sensitive details, and exposes no install action from `failed`. O2 component half is green; E2E/error-path half moves to Tester.
- **Main verification**: Electron worktree is exactly `SettingsModal.tsx` plus three new files (`UpdatesPanel.tsx`, `updatesStore.ts`, `updatesPanel.test.js`). Confirmed authoritative blocker/quit-prep ordering at `electron/main/updates/updateService.js:514-547`, legality guard at `:640-646`, renderer action gating at `updatesStore.ts:442-451`, tamper redaction at `:185-202`, and distinct `role=alert` tamper surface with disabled install path at `UpdatesPanel.tsx:268-306`.
- **Contained residuals**: (1) `busyAction` is committed after the asynchronous pre-install blocker collection, allowing a rapid double-click to issue two bridge calls; Main legality/generation guards contain safety impact, but Tester must exercise serialization/error behavior. (2) Generic typed-preload `invoke` would appear ready before `updates:*` Main routes exist; current production uses legacy preload, so track the seam under P4. (3) stale blocker display after successful check is cosmetic.
- **Tester checklist for P3D.O2**: `UPDATE_BLOCKED` reason resync; quit-prep failure labels; `{ok:false,error}` invoke envelope; rapid double install; stale refresh token; long-download/live-progress behavior.
- **Next Step**: `P3DD3Tester1` QA. P3D.D3 and card gates remain open until Main verifies Tester evidence.

### P3D.D3 Tester — Attempt 1
- **Tester (`P3DD3Tester1`)**: **CHANGES_REQUIRED**. Added six focused observable-behavior cases to `test/updatesPanel.test.js`. Complete focused file: **11 total, 10 passed, 1 failed**. Passing evidence covers Main `UPDATE_BLOCKED` blocker resync, quit-prep reason labels/no receipt, `{ok:false,error}` unwrapping, stale-refresh suppression, explicit progress snapshots, and strengthened TAMPERED/no-install behavior.
- **Deterministic bug**: two `store.installNow()` calls started while asynchronous `collectBlockers()` is pending both pass the renderer guard and both invoke the bridge. Expected one bridge command; observed two.
- **Main reproduction**: `cd Electron && node --test --test-name-pattern "rapid double install" test/updatesPanel.test.js` — **1 test, 0 passed, 1 failed**, assertion `2 !== 1` at `test/updatesPanel.test.js:535`. Source cause confirmed: `updatesStore.ts:586` checks `busyAction`, but `:611` sets it only after the pre-install await.
- **Gate status**: P3D.O2 FAIL pending fix. P3D.J1 PASS (quit-prep refusal remains visible and cannot complete install). P3D.J2 PASS (TAMPERED stays redacted, install disabled, zero install bridge calls).
- **Required fix**: establish the busy/serialization guard synchronously before blocker collection; clear it on blockers-present and collection-error early returns. Preserve Tester's test additions and all existing behavior.
- **Next Step**: `P3DD3Coder2` focused fix, `ponytail_mode: lite`; then focused Main verification, Reviewer re-check, and Tester rerun.

### P3D.D3 Coder — Attempt 2
- **Coder (`P3DD3Coder2`, `ponytail_mode: lite`)**: moved the existing `busyAction` claim synchronously before `collectBlockers()` and clears it on blockers-present and blocker-collection-error early returns. No new symbol/API/abstraction; only `src/stores/updatesStore.ts` edited by this attempt. Tester’s six added tests remain untouched.
- **Main verification**: source ordering confirmed at `updatesStore.ts:586-615`. Isolated race command now **1/1 PASS** (previously deterministic `2 !== 1`); complete `node --test test/updatesPanel.test.js` now **11/11 PASS**, including J1 quit-prep refusal and J2 TAMPERED redaction/no-install cases. Worktree remains the original four product files; attempt-2 delta is confined to `updatesStore.ts`.
- **Objective Gate runner**: `workflow_gates.py list --step P3D --json` reports P3D.O1/O2 as manual gates with no embedded commands; O2 manual evidence is the focused 11/11 result and still awaits Reviewer + Tester closure.
- **Next Step**: `P3DD3Reviewer3` focused re-check of serialization fix and early-return invariants.

### P3D.D3 Reviewer — Attempt 2
- **Reviewer (`P3DD3Reviewer3`)**: **APPROVED**, no findings. Under JavaScript run-to-completion, the synchronous `busyAction` commit at `updatesStore.ts:590` occurs before the first await at `:595`; the second invocation sees both `busyAction` and `EMPTY_ACTIONS` and returns before blocker collection or bridge install.
- **Invariant review**: blockers-present and collect-error early returns release the slot; the empty-blocker intermediate commit intentionally retains it; unchanged success, bridge-failure/`UPDATE_BLOCKED`, state-resync, and receipt paths release/retain correctly. J1 quit-prep refusal and J2 TAMPERED redaction/no-install semantics are unchanged.
- **Main adjudication**: Reviewer evidence matches inspected source and Main’s 1/1 race + 11/11 focused results. Attempt-2 review is accepted.
- **Next Step**: `P3DD3Tester2` final focused O2 rerun; no product or test edits unless a new deterministic defect is found.

### P3D.D3 Tester — Attempt 2 / Card Closure
- **Tester (`P3DD3Tester2`)**: **PASS_WITH_RESIDUALS**, no bugs and no file writes. Isolated rapid-double-install regression **1/1 PASS**; complete focused `updatesPanel.test.js` **11/11 PASS**. Before/after hashes for all four P3D.D3 worktree files were identical.
- **Gate closure evidence**: P3D.O2 PASS (check/download/install, blockers, envelopes, stale refresh, explicit progress, serialization). P3D.J1 PASS (quit-prep SQLite/WAL failure remains labeled, install disabled, receipt unchanged). P3D.J2 PASS (TAMPERED details redacted, install disabled, zero install bridge calls). Bounded residual: real signed-network/platform-installer execution remains deferred to the platform/bridge integration plan and is not claimed here.
- **Main final verification**: `npm test` **591/591 PASS** across 42 Electron test files; `npm run compile` exit 0; `npm run vite-build` clean (1911 modules, 1.40s). Existing Rollup chunk-size warning only. Objective Gate runner has no embedded P3D commands; manual O2 evidence above is accepted.
- **Closure transaction**: `[x] P3D.D3`, `[x] P3D.O2`, `[x] P3D.J1`, `[x] P3D.J2`; `completed_steps += P3D`; canonical pointer advanced to `P3E.D1`.
- **Next Step**: mirror canonical STATE/STEPS/FEEDBACK into `Electron/.workflow-snapshots/`, commit/push the nested Electron repository, then dispatch fresh P3E.D1 Coder.

## P3E.D1 — Attempt 1
- **Coder (`P3ED1Coder1`, `ponytail_mode: full`)**: extracted `App.tsx` startup media preparation into NEW `src/services/media-processing-coordinator.ts`; App retains provider-key alerts, UI screens/error timeout, session ownership, and first-transcription handoff. Moved `SessionConfig` from `ConfigPanel.tsx` into shared `types.ts` with clean caller migration. NEW `test/mediaProcessingCoordinator.test.js` adds 7 parity cases.
- **Coordinator contract**: dependency-injected narrow Electron bridge + ordered `{stage?,progress?}` reporter + warning sink; returns a typed prepared-session core. Preserves video/audio FFmpeg selection, conversion fallback, duration fallback, silence/fixed cut points, slice fallback quirks, chunk bounds/status, best-effort media info, exact messages/milestones, and no-bridge behavior.
- **Main verification**: scope exactly five allowed files. Real source confirms App orchestration-only cutover and removal of smart-slicer/media-source mechanics; no transcription/translation/review/shorts/export movement. Focused coordinator tests **7/7 PASS**; full suite **598/598 PASS** across 43 files; `npm run compile` exit 0; `npm run vite-build` clean (1912 modules, 1.29s). Existing Rollup chunk-size warning only.
- **Objective Gate runner**: P3E.O1/O2 are manual gates with no embedded commands. D1 contributes coordinator parity evidence toward O1; card gates remain open for later P3E items.
- **Review focus**: exact startup parity including progress-100 ordering, bridge optionality/types, preserved fallback quirks, clean SessionConfig cutover, no hidden App/global coupling, and adequacy of failure-path tests.
- **Next Step**: `P3ED1Reviewer1` full review.

### P3E.D1 Reviewer — Attempt 1
- **Reviewer (`P3ED1Reviewer1`)**: **APPROVED**, no findings; scope conforms. Compared committed pre-extraction `handleStartEngine` line-for-line against coordinator + App orchestration. P3E.J1 slice PASS: FFmpeg choices, warnings/fallbacks, duration/cut/slice quirks, chunk output, media info, alerts, error timeout, and first-transcription handoff remain equivalent.
- **Ordering adjudication**: progress-100 moving immediately before coordinator return is unobservable on the production Electron path under React 18 batching; no fix required. `byteOffset ?? 0` matches typed-array default semantics. SessionConfig relocation is clean with no remaining component import/re-export.
- **Bounded residual**: no-bridge development path can paint a one-frame 100% processing screen because the extracted async function introduces an await boundary; production Electron always takes FFmpeg awaits. Card J1 remains open until P3E.D2-D5.
- **Tester gaps**: duration false/non-positive fallback; video without extract method using generic converter; convert/duration/slice thrown errors propagating; source-media-info null without warning; exact conversion-failure snapshot ordering.
- **Next Step**: `P3ED1Tester1` focused QA/gap-hunt; test-file edits only.

### P3E.D1 Tester — Attempt 1 / Item Closure
- **Tester (`P3ED1Tester1`)**: **PASS_WITH_RESIDUALS**, bugs 0. Expanded the focused file from 7 to **11 tests**, adding duration false/zero/negative fallback, video-without-extract converter selection, thrown convert/duration/slice propagation, null media-info/no-warning, and exact conversion-fallback snapshot ordering. Only `test/mediaProcessingCoordinator.test.js` changed.
- **P3E.J1 slice**: PASS. Original seven parity cases remain green; no deterministic media-startup regression found. Bounded residual remains the non-production no-bridge React scheduling paint; no fake test added.
- **Main final verification**: focused **11/11 PASS**; full suite **602/602 PASS** across 43 files. Product code is unchanged since Main’s compile exit 0 and clean vite build; test-only QA additions do not invalidate those gates.
- **Closure transaction**: `[x] P3E.D1`. P3E.O1/O2/J1/J2 remain open for the rest of the media lane. Canonical pointer advanced to `P3E.D2`.
- **Next Step**: mirror closure memory, commit/push nested Electron repo, then discover and dispatch P3E.D2.

### P3E.D2 Architect — Attempt 1
- **Architect (`P3ED2Architect1`)**: binding clean-cut decision accepted by Main. Canonical runtime/session selection is `activeTranslationLanguage`, matching Apple SessionState and ProjectV3. Legacy `selectedTranslationLanguage` is accepted only during load normalization and stripped; MCP keeps its published selected-named response key sourced from canonical active.
- **Archive authority**: `chunks[].translationsByLanguage` with exact Apple-compatible TranslationVariant fields. Legacy `translated`, `translatedCues`, and `translatedFormats` remain eagerly synchronized active-language projections for current Review/export consumers. One shared pure normalizer/resolver serves Main importer, renderer coordinator, and read-only MCP.
- **Stale contract**: one renderer media-review coordinator owns every source/translation mutation and transient generation ledger. Late async results require session, chunk identity, source baseline/generation, language/variant baseline/generation, and operation-lane freshness; stale completions are deep no-ops. No Electron-only persisted source hash/stale flag.
- **User contract**: Review can select existing variants and add a target from the existing Config language catalog. Add Translation commits progressively; switching language never projects a late result into the current view. Autosave remains unchanged and persists canonical JSON.
- **Main scope adjustment**: repository tests run only from `test/**/*.test.js`; therefore coordinator/shared migration behavior tests belong under `Electron/test/`, not the Architect-suggested excluded `src/**/*.test.ts` path. Existing excluded source-regex review test is not deleted in this attempt.
- **Next Step**: `P3ED2Coder1`, `ponytail_mode: full`.

## P3E.D2 — Coder Attempt 1
- **Coder (`P3ED2Coder1`, `ponytail_mode: full`)**: completed the Architect-approved 13-file canonical archive/coordinator/App/import/MCP implementation. Assigned focused gate **44/44 PASS** across media-review, project-session, MCP-read, and existing media-processing tests. Scope conforms.
- **Main verification failure**: `npm run compile` exit 2. Exact root issues: `App.tsx:901/902/925` uses missing `keyRepeatRef`; `types.ts` replaced instead of retained `SessionState.targetLang`, breaking ChunkReview/WorkspaceView callers; `media-review-coordinator.ts:167/168/182/183` passes optional active language through a declaration that returns boolean rather than a TypeScript type predicate.
- **Adjudication**: behavior tests remain valid, but implementation is not reviewable until compile is clean. No symptom suppression and no caller widening: restore the missing existing ref, restore required `targetLang`, and make the truthful shared language guard declaration narrow to string (or equivalently narrow once locally). Three-file fix only.
- **Next Step**: fresh `P3ED2Coder2`, `ponytail_mode: lite`; focused 44/44 plus compile required.

## P3E.D2 — Coder Attempt 2 / Main Gates
- **Coder (`P3ED2Coder2`, `ponytail_mode: lite`)**: restored `keyRepeatRef`, required `SessionState.targetLang`, and a truthful `isRealTranslationLanguage(...): language is string` declaration. Main confirmed exact four-line root diff.
- **Main gates**: compile exit 0; focused D2 **44/44 PASS**; full suite **630/630 PASS** across 45 files.
- **Build failure**: `npm run vite-build` fails before bundling: `normalizeMediaSessionTranslations` is not exported by `shared/media-translations.js`. The module is intentionally CommonJS for synchronous Electron Main `require`; Vite did not run its local `.js` file through CommonJS transform. Tests/tsc use the `.d.ts` and Node CJS successfully, so they did not expose the bundler seam.
- **Adjudication**: preserve one shared implementation and synchronous Main loading. Do not duplicate an ESM renderer implementation. Add the exact local shared module to Vite’s CommonJS transform include while retaining node_modules coverage.
- **Next Step**: fresh `P3ED2Coder3`, config-only `ponytail_mode: lite`; build, compile, focused required.

## P3E.D2 — Coder Attempt 3 / Main Verification
- **Coder (`P3ED2Coder3`, config-only `ponytail_mode: lite`)**: added a separator-safe Vite CommonJS include for exactly `shared/media-translations.js` while retaining node_modules coverage. No implementation duplication or import/module rewrite.
- **Main verification**: scoped config is correct; Vite build clean (1915 modules, 1.21s; existing chunk warning only); compile exit 0; focused D2 **44/44 PASS**. Full suite from the immediately preceding code state is **630/630 PASS**; attempt 3 changed only build configuration and cannot alter test runtime behavior.
- **Objective Gate runner**: P3E.O1/O2 remain manual with no embedded commands. D1+D2 provide extraction/review parity evidence toward O1; card gates remain open for D3-D5.
- **Integrated review scope**: 14 files total (13 Architect-approved implementation/test files plus scoped `vite.config.ts`). Required judgment: canonical single ownership, migration data preservation, stale-result no-op matrix, App/TextPanel effect boundaries, Add Translation behavior, MCP language correctness/immutability, exact current-media parity, and no D3-D5 leakage.
- **Next Step**: `P3ED2Reviewer1` full review.

## P3E.D2 — Reviewer Attempt 1
- **Reviewer (`P3ED2Reviewer1`)**: **CHANGES_REQUIRED**, scope conforms. Coordinator stale matrix, MCP immutability/exact-language reads, canonical field ownership in renderer, and Vite CJS integration pass. P3E.J1 slice fails on three reachable data-correctness holes.
- **Major 1 — competing importer resolver**: `electron/project-session.js` re-resolves/seeds/projects variants before the shared normalizer. With `targetLang='same'`, real `config.targetLang`, first archive in another language, and leftover translated*, it can activate/project the wrong language and invent a variant. Main verified the duplicate pre-pass and truthy `same` chain. Fix: restore assets/index only, then let the shared normalizer own precedence/seeding/projection; default to `same` only after normalization when no real active exists.
- **Major 2 — cross-language undo/edit**: TextPanel local undo/edit/selection state survives chunk/language switches. Cmd+Z after Russian→French can write stored Russian text through the French active variant. Main verified no key/reset identity. Fix: remount/reset by source chunk identity and translated chunk+active-language identity.
- **Major 3 — glossary contamination**: App applies `entry.translation` to every archived variant. A Russian default can replace terms inside French/English variants. Main verified the archive-wide rewrite. Fix: active variant may use active/default replacement; inactive variants require a language-specific `entry.translations[variant.language]`, otherwise remain byte-identical. Keep coordinator commit/generation bump and projection.
- **Required tests**: sentinel `same` importer precedence/no invented variant; two-language glossary inactive preservation/language-specific replacement; identity-switch undo/edit reset (component/runtime proof or exact remount contract plus Tester UI exercise).
- **Next Step**: `P3ED2Coder4`, `ponytail_mode: lite`, followed by Main gates and focused re-review.

## P3E.D2 — Coder Attempt 4 / Main Verification
- **Coder (`P3ED2Coder4`, review-retry `ponytail_mode: lite`)**: fixed all three Reviewer1 majors in exactly five allowed paths.
- **Importer fix**: deleted competing language resolution/seeding/projection. Assets/index restore first; exactly one shared normalization pass receives unmasked base/config targets; `same` compatibility default applies only after no real language resolves. New sentinel fixture pins Russian-over-first-French precedence and no importer-created replacement.
- **TextPanel identity fix**: App keys source panel by exact chunk identity and translated panel by chunk identity + canonical active language. Chunk/language switch remounts and clears undo/edit/selection; same identity preserves undo. `TextPanel.tsx` untouched.
- **Glossary fix**: `MediaReviewCoordinator.applyGlossaryEntry` owns rewrite/generation/projection. Active variant may use generic fallback; inactive variants require explicit case-insensitive language mapping or remain byte-identical. Two-language test pins text/cues/formats/provider/time and projection behavior.
- **Main gates**: focused D2 **46/46 PASS**; full suite **632/632 PASS** across 45 files; compile exit 0; Vite build clean (1915 modules, 1.28s; existing chunk warning only). Source inspection confirms touched indexes are array positions and each generation bumps once.
- **Next Step**: `P3ED2Reviewer2` focused re-check, then Tester/UI QA if approved.

## P3E.D2 — Reviewer Attempt 2 / Main Adjudication
- **Reviewer (`P3ED2Reviewer2`)**: **APPROVED_WITH_RESIDUALS**. All three Reviewer1 majors CLOSED; P3E.J1 slice PASS. Importer has one shared resolver; exact TextPanel keys isolate undo/edit state; glossary rewrites are language-scoped with generation invalidation.
- **Residual finding**: incomplete untranslated imports with `targetLang='same'` and missing `config.targetLang` leave config target undefined. Reviewer classified minor because well-formed Electron sessions include it.
- **Main verification/adjudication**: source confirms `handleRetry` and `handleApproveAndNext` spread `session.config`; `shouldTranslateChunk(targetLang: string)` immediately calls `targetLang.trim()`. Thus the incomplete imported fixture has a deterministic Retry/Approve-next TypeError. This is reachable compatibility behavior, not a hypothetical residual, and must be fixed before Tester.
- **Required fix**: after the single shared normalization pass, when no real active language exists, independently default any missing/non-real session target and config target to `same`; create/select no variant and do not restate precedence. Pin `plain.config.targetLang === 'same'`.
- **Next Step**: `P3ED2Coder5` one-source/one-test fix, Main verification, focused Reviewer3, then Tester.

## P3E.D2 — Coder Attempt 5 / Main Verification
- **Coder (`P3ED2Coder5`, `ponytail_mode: lite`)**: fixed the post-normalize compatibility guard in `electron/project-session.js` and extended the untranslated fixture only.
- **Behavior**: with no real active language, session and config targets are independently sanitized to `same` when missing/non-real; real values are defensively preserved. Other config fields survive. No variant is created/selected and shared precedence/seeding/projection is untouched.
- **Main verification**: exact guard confirmed; fixture asserts active absent, both targets `same`, no archive invented, and JSON-round-trip normalization deep-idempotent. Focused D2 **46/46 PASS**; compile exit 0.
- **Next Step**: `P3ED2Reviewer3` final focused check, then Tester runtime/UI QA.

## P3E.D2 — Reviewer Attempt 3
- **Reviewer (`P3ED2Reviewer3`)**: **APPROVED_WITH_RESIDUALS**, findings 0. Coder5 guard runs after the sole shared normalizer, independently defaults missing/non-real targets only when no active resolved, preserves config fields, creates no active/variant, and leaves all three prior major closures intact.
- **Crash closure**: untranslated fixture would fail the old two-condition guard; `config.targetLang` now remains safe for Retry/Approve-next. Variant precedence and idempotence pass.
- **Tester requirements**: actual TextPanel undo/edit remount across chunk/language changes; same-identity undo still works; importer sentinel + untranslated Retry safety; two-language glossary/default/explicit mapping; active-language Add Translation availability including an initially `same` session; progressive archive commits and language-switch stale no-ops; MCP exact-language reads/immutability.
- **Carry residuals for evidence, not automatic failure**: cross-lane over-invalidation, first-save autosave without adopt, regional-prefix collapse, source originalCues glossary behavior, no search language argument, stale excluded regex test. Do not open D3-D5.
- **Next Step**: `P3ED2Tester1` final behavior + actual Electron/UI QA.

## P3E.D2 — Tester Runtime Interruption
- **Tester (`P3ED2Tester1`)**: no QA result. Worker failed before execution with provider/network error `[openai-codex/gpt-5.6-sol] getaddrinfo ENOTFOUND chatgpt.com`.
- **Classification**: provider DNS failure; no product attempt, no test evidence, no QA verdict, no retry-guard increment.
- **Human instruction**: «Продолжай». Main interprets this as authorization to retry the primary Tester fresh. It is not explicit authorization for `workflow-tester-backup`; automatic cross-model fallback remains disabled.
- **Next Step**: fresh primary `P3ED2Tester2` with the same D2 behavior/UI assignment.

## P3E.D2 — Tester Attempt 2 / Human Launch Evidence
- **Tester (`P3ED2Tester2`)**: **CHANGES_REQUIRED**. Baseline focused matrix **46/46 PASS**. Added one observable MCP binding test; `mcpReadCatalog.test.js` is now **6/7**, failing because handlers read `args.language` but public schemas omit it. Same-target importer no-throw probe passes.
- **Blocker — actual Electron startup**: Human supplied ground-truth launch screenshot: Main-process `SyntaxError: Unexpected identifier 'as'`; isolated temporary-profile Electron smoke also exits before `firstWindow`, so no UI/screenshot can be claimed. Main source diagnosis: startup provider router/settings store runtime-require `shared/contracts/errors.ts`, `providers.ts`, and `settings.ts`; Electron’s embedded Node cannot parse TS assertions (`errors.ts:27` is the first `as const`). Plain Node 26 tests hide this because their loader strips TypeScript. Root fix must establish a real JavaScript runtime contract boundary; no runtime Main `require(.ts)` on the startup graph.
- **Major — MCP binding**: `get_chunk` and `search_transcript` handlers accept explicit `language`, but their published input schemas omit it. Hidden handler behavior passes; real clients cannot advertise/validate the selector.
- **Major — first target unreachable**: App computes `hasTranslation=false` for `same`, then nests the entire Add Translation selector/button under `hasTranslation`. An initially untranslated Review session cannot add its first target, violating the binding D2 user contract.
- **Deterministic coordinator debts promoted to fixes**: shared cross-lane content generation can invalidate a source operation on translation-only edit (and vice versa); a stale retry can leave already-published `status='processing'`; source glossary rewrites original/formats but not originalCues, leaving karaoke spelling stale. First-save autosave without adopt remains accepted because same-semantic-session assignment intentionally preserves the epoch.
- **QA environment**: temp profile/fixture removed; Human data untouched; no provider call. `test/mcpReadCatalog.test.js` is Tester-owned failing evidence and must be preserved.
- **Next Step**: `P3ED2Coder6` fixes startup runtime boundary + four D2 bugs, then Main launch/gates, focused Reviewer, and fresh actual-UI Tester.

## P3E.D2 — Coder Attempt 6 / Packaged Launch Gate
- **Coder (`P3ED2Coder6`, QA-retry `ponytail_mode: lite`)**: fixed real Electron20 runtime loading through one-runtime-source JS modules + typed façades; MCP language schemas; first-target Add control; invalidated-operation processing settlement; source glossary cues/mapping precedence. Tester-owned MCP failing test preserved and now green.
- **Main automated gates**: exact Electron 34 / Node 20 router require prints `router ok`; focused **58/58 PASS**; full suite **644/644 PASS** across 46 files; compile exit 0; Vite build clean (1916 modules). `npm run pack` rebuilt and distribution-signed `release/mac-arm64/VaniScript-Electron.app`; notarization skipped by existing config.
- **Artifact clarification**: earlier dyld crash report came from incomplete local `build/VScript.app` lacking Electron Framework; that artifact is excluded. Complete `release/mac-arm64` package contains the framework and launches Main.
- **New Human ground-truth blocker**: rebuilt complete package reaches `electron/main.js:3422` then throws `ReferenceError: registerAppLifecycle is not defined`. Main verified `electron/main/bootstrap/app-lifecycle.js` exports the function and main.js invokes it but has no import. This is a missing clean-cut callsite migration, not a lifecycle implementation defect.
- **Required fix**: import the existing lifecycle function at Main startup; add an active regression that executes the bootstrap binding far enough to fail on an undefined symbol without opening a display. No duplicate lifecycle implementation.
- **Next Step**: `P3ED2Coder7` one-import fix; Main rebuild/actual package launch; Reviewer + UI Tester.

## P3E.D2 — Coder Attempt 7 / Actual Package Security Gate
- **Coder (`P3ED2Coder7`)**: added the single missing `registerAppLifecycle` import in `electron/main.js`; one-file/one-line diff. Main verified source, Node syntax, app-boot 4/4, full suite **644/644**, compile 0, and rebuilt the complete signed directory package.
- **Actual package result**: lifecycle binding is fixed; Main proceeds into `app-lifecycle.js` and then Human/tool window shows `TypeError: Session can only be received when app is ready` at `security/index.js:110`, called from `registerSecurityHandlers` at app-lifecycle line 27.
- **Root**: lifecycle invokes combined app+session security registration before `app.whenReady()`. `registerSecurityHandlers` dereferences `session.defaultSession`; Electron forbids that pre-ready. No renderer window is created.
- **Required fix**: move the existing combined registration into the `whenReady` continuation, before display capture/menu/tray/window creation. This still registers web-contents protection before any app window and installs CSP only when defaultSession is legal. Do not weaken/remove security controls.
- **Coverage**: add lifecycle-order behavior test proving security registration occurs after ready callback begins and before window creation.
- **Next Step**: `P3ED2Coder8`, then Main full gates/repack/actual window.

## P3E.D2 — Coder Attempt 8 / Main Package Success
- **Coder (`P3ED2Coder8`)**: moved combined security registration to the first statement of `app.whenReady()` and added a mutation-verified lifecycle-order test. CSP + popup/navigation guards remain installed before display/menu/tray/window/MCP setup.
- **Main full gates**: after restoring Node ABI for tests, full suite **645/645 PASS** across 46 files; compile exit 0. `npm run pack` rebuilt the complete signed `release/mac-arm64/VaniScript-Electron.app` with Electron 34.5.8; notarization remains skipped by existing configuration.
- **Actual package launch**: fresh temp profile starts Main, creates temp dir, loads `app.asar/dist/index.html`, starts authenticated MCP SSE, reaches renderer DOM ready/finished/ready-to-show, and reveals a visible focused 1536×984 main window. CDP attached to title `VaniScript`; accessibility tree exposed onboarding controls. Screenshot: `/var/folders/x0/5c_9ph9s67bd4vplgt29f_sh0000gn/T/omp-sshots-1563d174d00cb5ac.webp`.
- **Warnings only**: Google Fonts stylesheet is blocked by the strict CSP; bundled local Cuprum fonts render the app. Existing Rollup chunk warning and skipped notarization remain unchanged.
- **Objective Gate runner**: P3E.O1/O2 remain manual/no embedded commands. D1+D2 automated/package/UI evidence contributes to O1; card gates remain open through D3-D5.
- **Next Step**: `P3ED2Reviewer4` reviews integrated Coder6-8 fixes, then fresh Tester performs D2 Review UI scenarios on the working complete package.

## P3E.D2 — Reviewer Attempt 4
- **Reviewer (`P3ED2Reviewer4`)**: **APPROVED_WITH_RESIDUALS**. Runtime contract boundary, lifecycle/security startup, MCP language binding, first-target Add control, stale-processing settlement, and glossary cue/mapping behavior all PASS. P3E.J1 D2 slice PASS.
- **Findings**: two nits only — typed façade comments still say CommonJS although runtime modules are ESM loaded synchronously through Node20 require(esm); settings runtime declaration is not self-contained under stricter declaration checking. No runtime/product fix required before QA.
- **Security/startup judgment**: complete package empirically supports require(esm); AppError identity/defaults/migrations preserved; CSP and popup/navigation guards remain pre-window; actual renderer smoke closes prior launch blockers.
- **Known residual boundary**: other non-D2 Main modules still directly require unrelated `.ts` contracts and may fail under Electron Node20 when those lanes are entered. Not on D2 startup graph; carry to the owning future work, do not hide it.
- **Next Step**: `P3ED2Tester3` actual Review UI with temp same/two-language fixtures, no Human data/provider calls.

## P3E.D2 — Tester Attempt 3 (Actual Signed Package)
- **Tester (`P3ED2Tester3`)**: **CHANGES_REQUIRED**, product/test writes 0. Launched the signed package with isolated HOME/userData/Documents; codesign valid; Main/renderer/window stable; no Human data/provider calls. Automated evidence retained from Main.
- **Green actual UI**: onboarding isolation; exact Russian/French variants on two chunks; declared missing German projects blank; same-identity Cmd+Z; cross-language and cross-chunk undo/edit/selection/menu reset; duplicate/`same` Add exclusions; first-target Add visible for untranslated session; selection alone makes no network/provider request; viewport/focus/navigation stable.
- **Major — stale structured cues after manual edit**: Save Revision updates source/variant plain text and TXT format, but leaves old `originalCues` / variant `cues`. TextPanel prioritizes cues, so Review continues rendering pre-edit text after autosave/navigation. Reproduced independently on source and French translation. Evidence: `/tmp/vaniscript-p3e-d2-evidence-8aDFjz/fixture-a-stale-cues-after-edits.png` and `stale-cue-persisted-state.json`.
- **Minor — Add draft identity leak**: selecting Spanish without Add in Fixture B, then opening Fixture A, leaves Spanish selected and Add enabled. No provider call, but transient draft crosses session identity.
- **Required semantics**: arbitrary manual/AI selection rewrite cannot truthfully retain timed cues/SRT/VTT. Invalidate structured cues and timed formats while preserving edited plain text/TXT; Review must render edited text. Deterministic glossary replacement remains cue-reconcilable and keeps its existing rewrite. Reset Add target draft when session/project identity changes.
- **Packaging residual**: Main log emitted missing `Contents/Resources/parakeet.worker.js` during automatic local worker attempt. Non-fatal and outside D2 text path, but must be carried to the owning local-AI/packaging work; Google Fonts CSP refusal remains known.
- **Next Step**: `P3ED2Coder9`, then Main package gates, focused Reviewer, and actual UI Tester4.

## P3E.D2 — Coder Attempt 9 / Main Invariant Check
- **Coder (`P3ED2Coder9`)**: arbitrary direct and selection-based source/translation replacements now invalidate cues and timed formats, retain TXT-only canonical text, preserve inactive variants, and keep deterministic glossary/provider commits structured. Add-target draft resets on stable project/source identity. Focused coordinator **28/28**, compile 0, Vite clean.
- **Main source verification**: representation policy is centralized and uses canonical `LanguageResult.TXT` key; source/active archive paths and tests match Tester3’s corruption. Add identity effect excludes chunk/language/content/autosave revision dependencies.
- **Additional same-invariant defect**: `failTranscription()` writes `original = Error: ...` but retains prior `originalCues`/timed formats. TextPanel prioritizes cues, so a cue-backed retry failure can continue showing old transcript and hide the error. This is reachable P3E.D2 reprocess/error parity.
- **Required fix**: route failure error text through the same source untimed policy, then set status error; keep stale-failure no-op/generation behavior. Pin cue-backed failure: error visible canonical/TXT, cues and SRT/VTT absent.
- **Next Step**: `P3ED2Coder10`, then Main full/package actual checks.

## P3E.D2 — Coder Attempts 9–10 / Main Final Gates
- **Coder9**: arbitrary direct/selection source and translation edits now collapse only the touched lane to TXT-only canonical text, deleting stale cues/SRT/VTT; inactive variants remain byte-identical; deterministic glossary/provider commits retain structured timing. Add-target draft resets on stable project/source identity. Coordinator 28/28, compile 0, Vite clean.
- **Coder10**: `failTranscription` now uses the same source untimed policy before status `error`, preventing cue-backed retry failures from hiding `Error: ...`. Mutation test failed against old spread behavior, then passed **29/29**.
- **Main full gates**: after Node ABI restore, full suite **650/650 PASS** across 46 files; compile exit 0. `npm run pack` built/signed Electron 34 package; Vite clean (1916 modules, 1.24s; known chunk warning only).
- **Actual package startup**: fresh temp profile reaches Main ready, renderer DOM ready, renderer finished loading, ready-to-show, visible/focused 1536×984 window; no JS error dialog. Known Google Fonts CSP refusal only.
- **Next Step**: `P3ED2Reviewer5` focused representation review, then `P3ED2Tester4` reruns persisted manual-edit + draft identity scenarios.

## P3E.D2 — Reviewer Attempt 5
- **Reviewer (`P3ED2Reviewer5`)**: **APPROVED_WITH_RESIDUALS**, findings 0. Source/translation manual edits, selection rewrites, structured glossary/provider commits, failure surface, and Add draft identity all PASS. P3E.J1 D2 honest-untimed slice PASS.
- **Representation judgment**: arbitrary writes delete stale cues/timed formats and keep exact TXT; active projection follows; inactive variants remain byte-identical; provider metadata survives. Undo restores plain text without inventing timing. Transcription failure is visible TXT-only error; translation failure preserves prior variant.
- **Known residuals**: first projectId mint can clear a draft; same-source unsaved restart can retain one; glossary intentionally does not rewrite `cue.words[].text`. None block the tested loaded-project D2 flow.
- **Next Step**: `P3ED2Tester4` actual packaged persistence/UI rerun, then close D2 if green.

## P3E.D2 — Human Visual Feedback / Designer Escalation
- **Human screenshot**: top-right controls appear as an unintelligible overlapping cluster; Human asks what the button/icon pile is.
- **Main identification**: intended controls are Help Tour, AI Assistant, Projects, Batch workspace/status, and Settings. This is not intentional visual grouping.
- **Root source**: Batch launcher is a standalone fixed `.settings-btn` with inline `right:62`, while `.corner-actions` is another fixed flex row at `right:16` containing four buttons. Their independent positioning overlaps Batch across Assistant/Projects at the packaged viewport.
- **Design decision**: direct bounded implementation. Move Batch into the single corner-actions flow; give it a readable `Batch · <status>` compact pill with a distinct hit area; preserve Help/Assistant/Projects/Settings behavior, native drag exclusion, active/error states, accessibility names, light/dark themes, and narrow-window behavior. No backend/navigation/state changes.
- **Next Step**: `P3ED2TopbarDesigner1`, Main packaged visual inspection, Reviewer/Tester, then Human visual acceptance.
- **Designer runtime interruption**: `P3ED2TopbarDesigner1` wrote a coherent two-file candidate, then stalled after reporting pre-existing Vite blank-render failure (`displayTranslationLanguage` ESM export mismatch). Main stopped out-of-scope shim work and cancelled the stalled session. This is runtime interruption, not a product-attempt failure. Fresh Designer will reconcile the existing candidate before Main package verification.
- **Designer reconciliation (`P3ED2TopbarDesigner2`)**: COMPLETE with no additional edits. Confirmed the interrupted two-file candidate has one flex-owned Batch action per mutually exclusive surface, visible title-cased status, independent hit areas, preserved handlers/data-tour hooks, and focus/theme/error states.
- **Main packaged verification**: `npm run pack` succeeded (Vite 1916 modules; Electron 34.5.8 arm64 package signed; notarization skipped by existing config). `npm run compile` exited 0.
- **Actual package**: launched `release/mac-arm64/VaniScript-Electron.app` with a disposable `/tmp` profile. Accessibility tree exposes five distinct controls: Enable Help Tour, AI Assistant, Projects, Batch workspace · Idle, Settings.
- **Measured geometry**: five rectangles are 32×32, 32×32, 32×32, 92.8×32, 32×32 with exact 8px gaps; automated pairwise intersection list is empty. Product enforces a minimum resizable window, so `resizeTo(598,416)` clamps above the Human screenshot crop; the minimum-window capture remains collision-free.
- **Screenshot**: `/var/folders/x0/5c_9ph9s67bd4vplgt29f_sh0000gn/T/omp-sshots-1563e8f43326706d.webp`.
- **Next Step**: bounded Reviewer judgment on `App.tsx`/`index.css`, then final packaged Tester rerun and Human visual acceptance.
- **Topbar Review (`P3ED2TopbarReviewer1`)**: **APPROVED**, findings 0, judgment gates 7/7 PASS. Root cause removed (one flex owner per surface, `.batch-action` static), Batch reads `Batch` + title-cased live state, handlers/`data-tour` hooks/ARIA preserved, geometry clean (32px targets, 8px gaps, no intersections at product min window 900×640 per `window-manager.js`), focus-visible and light/failed states token-correct, scope confined to the two files.
- **Main re-verification of Review claims**: confirmed `App.tsx:2700-2710/2917-2927`, `index.css:119-135/717-770/156-160/4316-4356`, and `window-manager.js:201-202` (minWidth 900, minHeight 640) match the cited evidence.
- **Next Step**: `P3ED2Tester4` final packaged cue/draft/topbar rerun, then Human visual acceptance.

## P3E.D2 — Final Tester and Closure
- **Tester (`P3ED2Tester4`)**: **PASS_WITH_RESIDUALS**. All requested packaged checks passed using disposable HOME/profile/fixtures: startup; non-Review and Review topbar geometry; source edit TXT-only persistence; active translation TXT-only persistence; inactive French byte identity; same-language undo without timing resurrection; cross-project Add-target reset; exact Russian/French switching.
- **Topbar evidence**: at 1536×984 and product minimum 900×640, exactly five controls are exposed. Rectangles are 32×32, 32×32, 32×32, 92.8×32, 32×32; every adjacent gap is 8px; all ten pairwise intersection areas are 0; none is clipped. Review Batch precedes Settings and New Session with zero intersections.
- **Persistence evidence**: source edit survives reload as exact TXT with no original cues/SRT/VTT. Active Russian becomes TXT-only/cueless. Inactive French remains 522 bytes with identical SHA-256 `84133f2931ff8e7c3476a35eb3bbb74141994e1a15bdf530918f72f0749c3d8e`. Undo restores plain text without timings. Project A/B draft switches reset to empty.
- **Evidence directory**: `/tmp/vaniscript-p3e-d2-tester4-evidence-MIaAON`.
- **Main verification**: independently read geometry, persisted JSON, SHA-256, draft-reset, and minimum-window artifacts. Binding D2 assertions match Tester result.
- **Non-binding residual**: main source chooser at supported 900×640 spans y=-99..833 while document scrollHeight equals clientHeight 640, making top/bottom cards unreachable. This is a real medium UI defect, unrelated to D2 review/multi-language and the corrected topbar. Recorded for later UI ownership; not silently added to D2.
- **Human acceptance**: after the corrected packaged capture, Human instructed «Продолжай». Main treats this as authorization to advance.
- **Closure**: P3E.D2 checked complete; canonical pointer advanced to P3E.D3. Mandatory nested Electron product + workflow-snapshot backup follows.
- **Nested product backup**: commit `6b80f3a` (`feat: complete review language parity`) pushed `240d85d..6b80f3a` to `origin/codex/v2-swift-import-compat`. Commit includes the integrated D2 product diff and byte-identical closure-time `STATE.yaml`, `STEPS.md`, and `FEEDBACK.md` mirrors under `Electron/.workflow-snapshots/`.
- **Repository boundary**: authoritative workflow files remain local in the outer VaniScript workspace. Post-push checkpoint hash `6b80f3a` will enter the next closure mirror; the mixed outer workspace was not pushed.

## P3E.D3 — Export/Project Parity Discovery
- **Graphify**: existing graph query was stale/noisy for Electron and resolved mostly Apple nodes; used only as navigation evidence.
- **Scout (`P3ED3ExportScout`)**: Electron already has correct full-session TXT/SRT/VTT/Markdown generation and D2 active-language projection. DOCX/PDF belong to the separate document-project family and are not media D3 scope.
- **Confirmed live-path defects**: unbounded/unvalidated streaming `.vaniscript` import; missing active MCP transcript/project export boundary; component-unsafe project-root prefix containment; same-basename restored assets overwrite; missing V2 asset SHA-256 manifest verification; metadata-based filenames diverge from Apple source-stem naming; Blob URLs are not revoked.
- **Architecture conflict**: live media IPC uses private streaming V2 helpers in `electron/main.js`; secure `electron/main/projects/bundle.js` is a separate ProjectV3 ZIP/document store and is not a drop-in replacement. D3 must preserve `.vaniscript` compatibility without creating a third format or migrating all storage.
- **Next Step**: Architect binds exact D3 contract, slicing, MCP inclusion, compatibility/rollback behavior, target files, and gates before Coder.
- **Architect (`P3ED3Architect1`) binding decision**: D3 is the complete live media-export parity cutover, including active MCP exports. Implementation is serialized into four slices: S1 canonical transcript bytes/naming; S2 isolated hardened streaming bundle service; S3 live project-store/native-dialog cutover and old-helper deletion; S4 protected MCP exports/real preflight.
- **Canonical transcript contract**: one full-session TXT/SRT/VTT/Markdown API; explicit translated language wins, otherwise D2 active language; missing variant fails; filename is sanitized NFC source stem + `_original` or resolved-language suffix; no lecturer/location/date; UI paths share exact bytes/name; Blob URL revoked; App AI post-format alternate export path removed.
- **Bundle contract**: preserve streaming project/library V2 headers and legacy `assetMeta`/JSON-v1 reads; new writes use Apple-compatible SHA-256 assetManifest; strict bounded framing/UTF-8/integer/marker/EOF validation; component-aware containment; deterministic key-qualified restored names; same-filesystem staging; atomic project promotion and journaled all-or-nothing library recovery.
- **MCP contract**: active main server must expose `export_transcript`, `export_project_bundle`, `reveal_export`; filesystem effects remain under userData/MCP Exports in unique protected directories; responses disclose no absolute paths; transcript generation stays renderer-owned through the existing bridge; real preflight replaces unconditional success.
- **Non-goals**: media DOCX/PDF, ProjectV3 migration, third archive format, D4/D5, new TS/CommonJS build system, retry/telemetry.
- **Next Step**: `P3ED3CoderS1` with Ponytail full, then Main focused verification before S2.
- **Coder S1 runtime interruption (`P3ED3CoderS1`)**: session exited without required yield after reminders. Main verified no changes in the five assigned target files. No product attempt/failure increment; fresh primary Coder retry uses the same binding S1 contract.
- **Coder S1 runtime interruption 2 (`P3ED3CoderS1Retry`)**: identical exit-without-yield; Main again verified no target diff. Repeated runtime signature count 2. Per retry guard, one final fresh primary Coder attempt is allowed; no automatic backup model.
- **Coder S1 primary session 3 (`P3ED3CoderS1Final`)**: returned BLOCKED with no diff after Main prematurely steered it to return before its first edit. This is an Orchestrator interruption, not a product or provider failure. The session delivered a verified implementation map and pre-change focused baseline 7/7. Fresh implementation-only primary Coder will apply that map without repeating research; Main will not interrupt it.
- **Primary Coder runtime failure threshold reached**: `P3ED3CoderS1Apply` was given the verified implementation-only map, but again exited without yield and wrote no target diff. Across `P3ED3CoderS1`, `P3ED3CoderS1Retry`, and `P3ED3CoderS1Apply`, the materially identical primary-runtime signature reached 3. Product source remains unchanged for S1.
- **Routing pause**: automatic cross-model failover is prohibited. P3E.D3-S1 is paused pending explicit Human task-specific authorization to invoke `workflow-coder-backup`; Main will not implement product code after worker failures.

## P3E.D3-S1 — Backup Coder and Main Verification
- **Backup authorization**: Human instruction «Продолжай» explicitly authorized `workflow-coder-backup` for `P3E.D3-S1` after the primary runtime no-diff threshold.
- **Coder (`P3ED3CoderBackupS1`)**: returned `waiting_review`; scope was exactly the five assigned files and introduced the canonical transcript artifact path, deterministic source-stem naming, exact variant resolver, UI cutover, Blob URL cleanup, and AI post-format removal.
- **Main focused verification**: **FAIL 13/17** (`npx tsx --test src/lib/review-format.test.ts src/lib/export-filename.test.ts`). Four failures: `makeSectionTitle` was accidentally deleted, breaking Markdown at runtime; and `targetLang` was repurposed from metadata localization to exact archive selection, breaking three established projection fixtures with `Missing requested translation variant`.
- **Adjudication**: keep `targetLang` as the established formatting/localization option and add a distinct exact-selection option (for example `translationLanguage`). UI supplies the active D2 language to exact selection. Missing-variant regression must exercise that distinct option. Replace the overload-heavy artifact API with one explicit input object while fixing the failures.
- **Next Step**: fresh backup Coder fix, then repeat focused tests before any Reviewer dispatch.
- **Backup fix (`P3ED3CoderBackupS1Fix1`)**: restored Markdown section titles, separated `translationLanguage` exact selection from `targetLang` localization, and replaced the artifact overload with one object input; changed only `App.tsx`, `review-format.ts`, and its test within the existing five-file candidate.
- **Main re-verification**: focused export suite **17/17 PASS**; full Electron suite **650/650 PASS**; `npm run compile` exit 0; `npm run vite-build` clean (1915 modules, 1.34s; existing chunk-size warning only). Product diff remains exactly the five authorized S1 files.
- **Objective Gate runner**: `P3E.O1` and `P3E.O2` are manual and remain card-open. S1 contributes deterministic golden byte/name and exact-language evidence; Shorts fixtures land later in D4/D5.
- **Security scope script**: returned `offer_scoped` solely for unrelated outer-workspace `Bolabol/.../HotkeySessionOverlayManager.swift`, which is outside the nested Electron diff and P3E scope; no P3E security escalation recorded.
- **S1 result**: Main-verified complete. Per the Architect serialization, proceed to S2 isolated hardened streaming bundle service before Reviewer/Tester on the complete D3 candidate.

## P3E.D3-S2 — Hardened Streaming Bundle Discovery
- **Scout (`P3ED3S2Scout`)**: verified private streaming V2 helpers in `electron/main.js:346-742`, live IPC callers at `:2486-2577`, and no existing Electron streaming-bundle tests/fixtures. The adjacent `main/projects/bundle.js` is an incompatible ProjectV3 ZIP service.
- **S2 boundary**: create only `electron/main/projects/streamingBundle.js` plus `test/streamingBundle.test.js`; leave `main.js` definitions/callers untouched until S3. Service factory exports project/library V2 writers/importers and directly supports JSON-v1 without S3 temporary files.
- **Compatibility**: preserve exact 21-byte V2 headers, 12-digit metadata framing, schema 3, `assetMeta`, legacy manifest-less V2 and JSON-v1 reads. New writes add Apple-shaped `assetManifest.entries` verified against `ProjectAssetManifest.swift:3-90`.
- **Hardening bindings**: 2 GiB archive/50 MiB metadata+JSON ceilings; 4 KiB fatal-UTF8 text lines; canonical safe integers; exact markers and physical EOF; component-aware containment; deterministic sanitized key + `--` + basename restore names; `originalVideoPath` role `auxiliary`; SHA-256/size enforcement when a manifest exists.
- **Atomicity**: sibling temp+fsync+rename exports; same-filesystem staged project imports with one visibility rename; library imports use a durable transaction journal and deterministic startup/before-import rollback. Fault injection is an internal test seam, not a public product API.
- **Next Step**: primary Coder implements the isolated two-file S2 service/tests; S3 alone performs live cutover and old-helper deletion.
- **Coder (`P3ED3CoderS2`)**: returned `waiting_review` with exactly the two assigned new files. Main focused **19/19 PASS**, full suite **669/669 PASS**, compile exit 0, Vite build clean (1915 modules, 1.32s); `main.js` remains untouched.
- **Main source review — reopen S2**: successful library completion ignores failure to unlink its live journal (`streamingBundle.js:1515-1520`) and still returns imported projects. A later recovery would interpret that surviving journal as incomplete and delete already-reported-successful finals. Success must not return while a rollback journal survives.
- **Main source review — recovery/temp durability**: `ensureRecovered` reuses only the creation-time promise (`:1300-1304`) rather than rerunning recovery before each import as bound; journal durable-write failures can leave `.tmp-*` files because `persistJournal` has no failure cleanup (`:1064-1075`) and recovery does not sweep journal temp files (`:1122-1153`).
- **Next Step**: fresh primary Coder fix adds discriminating failure-injection tests and fixes journal completion, per-import recovery, and journal-temp cleanup without broadening the two-file scope.
- **Coder fix (`P3ED3CoderS2Fix1`)**: added three durability regressions; Main focused suite **22/22 PASS**.
- **Main source review — reopen S2 again**: creation-time recovery is launched detached while the first import immediately starts a second recovery (`streamingBundle.js:1334-1339`), so the two recovery passes can race over the same journal/stage despite the comment claiming serialization.
- **Rollback safety defect**: transaction-error paths use best-effort deletion and then unlink the journal regardless of deletion success (`:1535-1544`, mirrored JSON-v1 path). A failed `rm` can therefore leave a promoted final after its only recovery marker is deleted.
- **Finalization ambiguity**: after journal unlink succeeds but strict directory fsync fails, the catch best-effort deletes finals without durably syncing those deletions or recreating the journal (`:1547-1558`). A crash can recover finals with no journal. Bound invariant requires the journal to survive until final/stage removals are durably synced.
- **Next Step**: fresh primary fix chains the startup recovery barrier into the import queue and replaces best-effort transaction rollback with one strict, journal-preserving rollback protocol plus fault-injection coverage.
- **Coder strict rollback fix (`P3ED3CoderS2Fix2`)**: unified both library bodies behind `runLibraryTransaction`, chained startup recovery into the serialized import barrier, and made rollback/recovery journal-preserving and strict. Five discriminating regressions added.
- **Main final S2 verification**: focused streaming bundle suite **27/27 PASS**; full Electron suite **677/677 PASS**; compile exit 0; Vite build clean (1915 modules, 1.28s; existing chunk-size warning only). Real source confirms valid journals are removed only after listed paths are strictly removed and root synced; failed finalization recreates the marker before rollback; first import awaits startup recovery.
- **S2 result**: Main-verified complete with exactly the two authorized new files; live `main.js` still does not import the service. Proceed to S3 live project/native-dialog cutover and old-helper deletion.

## P3E.D3-S3 — Live Cutover Discovery
- **Scout (`P3ED3S3Scout`)**: verified live handlers in `electron/main.js:2489-2575`, obsolete private streaming block `:337-742`, unchanged preload/type/renderer contracts, and no required renderer/preload changes.
- **Resolved API gap**: S2 exposes format-specific imports that reject the opposite header. To make routing service-owned, S3 adds one `importBundle(filePath)` that routes both V2 headers and both JSON-v1 formats inside the existing queue/recovery boundary and returns an array.
- **Cutover boundary**: `main.js` imports/constructs one service with `{projectsRootDir,newProjectId}`, awaits project/library writes and unified import, preserves exact dialogs/cancellation/result/error objects, deletes the private helpers and old header/JSON/temp routing. Existing canonical project helpers and normalizer remain.
- **Target files**: `electron/main.js`, `electron/main/projects/streamingBundle.js`, `test/streamingBundle.test.js`, and new focused `test/mainProjectBundleIpc.test.js`. No `preload.js`, renderer, ProjectV3, or dependency changes.
- **Next Step**: primary Coder performs the clean live cutover and adds four-route service plus bounded main-handler wiring coverage.
- **Coder (`P3ED3CoderS3`) runtime exit after edits**: wrote the expected cumulative four-file S3 candidate but exited without structured yield. Main verified syntax for `main.js`, service, and IPC test; scope is exact.
- **Main focused verification**: **FAIL 32/33**. All five IPC wiring assertions and prior 27 service tests pass. The new unified-router test over-asserts that every JSON-v1 library project has a restored `sourceFile`; its second fixture intentionally contains only `chunk:0`, so canonical normalization correctly leaves the unavailable source path unchanged while restoring the chunk.
- **Adjudication**: fix the fixture, not production semantics—add a `sourceFile` asset to the second JSON-v1 library bundle (retaining its chunk asset) so `assertPlacedUnderFinalDir` tests an actually supplied source. No fallback synthesis or normalizer change.
- **Next Step**: fresh primary Coder test-only correction, then repeat focused and full gates.
- **Coder test fix (`P3ED3CoderS3Fix1`)**: added the missing second-bundle source asset as directed, but Main focused verification remains **32/33 FAIL** on the same observable assertion.
- **Root cause correction**: the test exposed a real S2 defect. `importJsonV1LibraryBody` materializes assets in each stage and passes the stage paths directly to `assembleImportedProject` (`streamingBundle.js:1681-1694`) without the `rebaseAssetMap(stageDir,finalDir)` step used by project-v1 and streaming V2. Returned/persisted sessions therefore point at renamed-away stage paths.
- **Adjudication**: retain the stronger fixture/assertion. Production must rebase each library JSON-v1 asset map to its final directory before normalization/persistence; no test weakening or fallback.
- **Next Step**: fresh primary Coder service-only fix, then repeat focused and full gates.
- **Coder service fix (`P3ED3CoderS3Fix2`)**: inserted the missing per-project `rebaseAssetMap`; Main focused S3 suite now **33/33 PASS**. Adjacent IPC/session suites **41/41 PASS**; full Electron suite **683/683 PASS**; compile and Vite build green.
- **Main source review — reopen S3**: live unified JSON routing peeks through its open bounded `FileHandle` but then parses `io.readFile(filePath)` (`streamingBundle.js:1758-1811`). That performs a second path-based open/read, contradicts the one-open contract, wastes I/O, and creates a TOCTOU swap window between content classification and imported bytes.
- **Required fix**: after the archive and JSON ceilings are checked, consume exactly `stat.size` bytes from the already-open bounded reader and fatal-decode those bytes. Add a regression whose injected `io.readFile` fails while unified JSON import still succeeds, proving the live router never reopens by path. Format-specific legacy methods remain unchanged.
- **Next Step**: fresh primary service/test fix, then final S3 gates.
## P3E.D3-S4 — Discovery Complete (`P3ED3S4Scout`)
- Production MCP is the hand-written SSE transport in `main.js:2355-2631` (9 tools, renderer-forwarded); the modular `mcpServer.js` is tested but not wired. Modular catalogs already expose stub `list_export_options`/`validate_export` (`readCatalog.js:219-223,991-992`); no `export_transcript`/`export_project_bundle`/`reveal_export` exist anywhere.
- Native references pinned: catalog scopes (`McpExpandedToolCatalog.swift:25-26,124-144`), handlers (`WorkflowStore.swift:6415-6428,8194-8279`), protected store (`McpExportStore.swift:5-52`). Native transcript bytes/names intentionally differ from Electron S1 canon; Electron MUST ship its own `buildTranscriptArtifact` output unchanged.
- **Architecture decision (Main)**: hybrid dispatch. Keep the production SSE transport; add the five export/preflight tools as Main-process dispatch backed by the SAME modular catalog modules (single source of truth, typed error mapping localized once). Renderer-forwarded tools stay byte-for-byte unchanged. Full modular-server cutover is explicitly out of S4 scope. Renderer/preload gain two read-only compute bridges (`mcp:build-transcript-artifact`, `mcp:active-project`); Main keeps all path/write authority; responses never contain absolute paths.
- Wire-format note: Electron streaming service pins metadata `schemaVersion: 3`; current Apple exporter emits 4. Output stays importer-compatible; v4 convergence is a separate future migration decision, out of S4.
- Slice plan (serialized under concurrency cap): **S4-A** foundation — new `electron/main/projects/mcpExportStore.js` + `electron/main/mcp/mcpTools/exportCatalog.js` with injected seams and typed failures, plus focused tests; **S4-B** — real transcript options/preflight in `readCatalog.js` via reader injection + tests; **S4-C** — production composition in `main.js` (protected root under userData, singleton service delegation, renderer bridges, transport dispatch) + preload/types/App.tsx seams + composition tests.
- **Main verification S4-A (`P3ED3CoderS4A`) PASS**: syntax clean; focused **20/20** (`node --test test/mcpExportStore.test.js test/mcpExportCatalog.test.js`). Source review confirms protected registry projection hides absolute paths, atomic temp+rename writes, typed INVALID_REQUEST/PERMISSION_DENIED/CAPABILITY_UNAVAILABLE/NOT_FOUND mapping, and exact three-tool schemas mirroring native `.files` scope. Minor accepted deviation: bundle export directories use the sanitized project stem as label instead of native's constant `project`; labels never leave the protected root and stay ASCII-collapsed by design.
- **Next Step**: dispatch S4-B — real nested `list_export_options` and transcript/shorts preflight in `readCatalog.js` behind an injected readiness-snapshot reader; legacy stub assertions in `mcpReadCatalog.test.js` get replaced by the new contract.
## P3E.D3-S4-B — Implementation & Verification
- **Coder (`P3ED3CoderS4B`)**: replaced `list_export_options`/`validate_export` stubs in `readCatalog.js` with real nested options and transcript+shorts preflight behind the injected `exportReadiness` dependency; typed errors reuse canonical MCP codes via `error.mcpCode`. Stub assertions in `mcpReadCatalog.test.js` replaced with fake-reader branch coverage.
- **Main verification**: first focused run 48/49 — one test expected a single issue for shortsVideos when plans AND media are both missing, but native (`WorkflowStore.swift:8227-8237`) accumulates NO_SHORTS_PLANS then SOURCE_MEDIA_MISSING before its early return. Production was native-correct; Main corrected the test expectation to the pinned reference (verification-driven test repair, recorded here). Re-run: MCP suites **49/49 PASS**; full Electron suite **713/713 PASS**; compile + Vite build green.
- **Next Step**: dispatch S4-C production composition (protected root, singleton service delegation, renderer bridges, SSE-transport main-side dispatch) plus preload/types/App.tsx seams and composition tests.
## P3E.D3-S4-C — Implementation & Verification
- **Coder (`P3ED3CoderS4C`)**: production composition landed — one `createMcpExportStore` (root `userData/MCP Exports`) + one `createExportCatalog` + one readiness-injected read catalog in `main.js`; five tools dispatched in Main ahead of the window guard; legacy nine renderer-forwarded tools untouched; three renderer compute bridges (`mcp:build-transcript-artifact`, `mcp:get-active-project`, `mcp:get-export-readiness`) across preload/types/App.tsx; deterministic JSON-RPC code table with known-root redaction.
- **Main verification**: focused MCP+bundle suites **94/94 PASS**; full suite **724/724 PASS**; compile and Vite build green. Source review found one parity defect: the transcript bridge ignored explicit `args.language` and always fell back to the session's active/target language, contradicting native (`WorkflowStore.swift:8265`) and the S1 exact-variant contract. First fix session died to a provider 429 before editing (no product attempt recorded); fresh primary re-dispatch applied the two-line passthrough fix (`P3ED3CoderS4CFix2`). Post-fix gates re-run: full suite **724/724**, compile, Vite build — all green.
- **Next Step**: S4 is implementation-complete. Dispatch card-level Reviewer over the whole P3E.D3 diff (S1–S4), then Tester.
## P3E.D3 — Card-Level Review (`P3ED3Reviewer`)
- **Verdict: `changes_requested`.** J1 fails on three contracts; everything else (format bytes, store projections, unified router, singleton wiring, token auth, legacy tools) approved as sound.
- Blockers: (1) translated artifact filenames use localization `targetLang` instead of the resolved translation variant — French bytes would land in `stem_Russian.md`; O1 lacks a `translationLanguage≠targetLang` golden; (2) MCP `export_transcript` rejects an omitted language up front instead of native fallback to the active D2 language (`arguments.language ?? session.selectedTranslationLanguage`); (3) `validate_export` shortsVideos never stats the source — audio-only projects mis-code as SOURCE_MEDIA_MISSING and deleted videos still validate; must distinguish missing-file vs present-non-video with a real existence check. Same-cut security hardening: reject `'.'/'..'/separator` basenames and contain write/reveal strictly under the protected exports root (bundle-style safe-basename rule); stale "not wired yet" comments removed.
- **Next Step**: fresh primary coder fix round over review-format/exportCatalog/readCatalog/mcpExportStore/App.tsx/main.js plus their suites; then Main re-verification and Reviewer re-adjudication.
## P3E.D3 — Review-Blocker Fix Round (`P3ED3CoderD3Fix1`)
- All five findings implemented: (1) `buildTranscriptArtifact` now suffixes filenames with the resolved translation variant (`translationLanguage || targetLang`), golden test pins French-bytes/Russian-target → `Test_Audio_French.txt`; (2) omitted translated-side language reaches the builder as null so the renderer falls back to the active D2 language, typed INVALID_REQUEST only for non-string values, and unresolvable fallback surfaces as typed NO_TRANSLATION_LANGUAGE; (3) readiness snapshot gained Main-computed `sourceVideoExists` (fs.existsSync in main.js wrapper) — shortsVideos now distinguishes missing media (SOURCE_MEDIA_MISSING) from existing non-video (VIDEO_REQUIRED), fail-closed when the field is absent; (4) containment: basename-first safety validation (empty/'.'/'..'/separators rejected on the RESULT), destPath relative-containment check, and store-level register validation rejecting any path outside the protected exportsRoot before registry mutation; (5) stale wiring comments removed.
- **Main verification**: one intermediate failure caught and repaired via IRC steering — the raw-separator check ran BEFORE basename, breaking native lastPathComponent parity in the production-shaped fixture; corrected to validate only the post-basename result. Final gates: full Electron suite **729/729 PASS**, compile green, Vite build green.
- **Next Step**: Reviewer re-adjudication of J1/O1 over the fixed diff; Tester after approval.
## P3E.D3 — Re-Adjudication (`P3ED3Reviewer2`)
- **Verdict: `approved`.** J1 holds on all three previously failing contracts (translated variant naming with French/Russian golden, omitted-language native fallback, shortsVideos existence-based codes). Focused suites: review-format+filename 18/18 incl. the new naming golden; MCP catalog/read/store/composition 52/52.
- **Gates**: O1 evidence sufficient for D3 (export/naming goldens complete); O2 shorts-plan fixture coverage explicitly deferred to D4/D5 — does not block D3.
- **Pause**: Human directed «Остановись после ревью» — workflow pauses here. Resume pointer: next_actor=tester (P3E.D3 Tester cycle), then card closure and P3E.D4 discovery.

## P3E.D3 — Final Tester and Closure (`P3ED3Tester1`)
- **Tester (`P3ED3Tester1`)**: **qa_green**. Added two tests to `test/mainMcpExports.test.js`: a production SSE loopback that exports the active French transcript through the real export store/catalog and canonical transcript builder under token auth — asserting `Leçon_French.txt` resolved-variant naming (never Russian bytes), omitted-language fallback to the active D2 language, zero absolute paths in RPC responses, exports confined to `userData/MCP Exports`, contained reveal; and renderer Blob-URL revocation including failed clicks.
- **Main verification**: independent full-suite run **731 pass / 0 fail**; `npm run compile` exit 0; `npm run vite-build` green (1.28s, pre-existing chunk-size warning only). Test diff inspected: genuine observable-behavior coverage, no weakened assertions.
- **Gates**: D3-scoped O1 runtime evidence complete; card gates O1/O2/J1/J2 intentionally stay open until D5 completes per card-level policy.
- **Next Step**: pointer advanced to P3E.D4 discovery; product commit with `.workflow-snapshots/` mirror follows closure.
