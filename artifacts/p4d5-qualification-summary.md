# P4.D5 Release Qualification

| OS | Content checks | Boot smoke | E2E | Findings | Overall |
| --- | --- | --- | --- | --- | --- |
| darwin | 13/13 passed | PASS (1908 ms) | 4/4 passed | 2 (2 warnings) | PASS |

**Overall verdict: PASS**

## Findings

### darwin
- **updater-artifact-type-mismatch** (warning, P5.D1): Updater artifact-type mismatch — expected nsis-web/zip/appimage (test/updatePlatformAdapters.test.js:21-25) vs build nsis + implicit mac defaults (package.json build.win.target/mac).
- **document-project-editor-flow-not-e2e-covered** (warning, follow-up product UI lane): Document-project editor flow is not E2E-covered: the document UI surface is absent from the Electron edition (App.tsx mounts upload/config/processing/review/export only; document engine main-side).
