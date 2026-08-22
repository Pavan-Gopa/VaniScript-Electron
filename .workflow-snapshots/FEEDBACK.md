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
