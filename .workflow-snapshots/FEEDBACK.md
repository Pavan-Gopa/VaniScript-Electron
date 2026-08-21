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
