# Implementation Plan - Visual Editor Stability & Export Rendering Sync

This plan details the technical steps to stabilize the VaniScript bilingual visual editor and ensure all visual effects (edge feathering, background blur, and gradients) render accurately and in perfect sync in final exports.

## Proposed Changes

### 1. Visual Editor State Resets

#### [MODIFY] [ShortsReelsPanel.tsx](file:///Users/pavan/Documents/smartscribe/VaniScript/src/components/ShortsReelsPanel.tsx)
- Remove `displayLanguage` from the React `key` of `<SubtitleAlignmentEditor>` to prevent the editor component from fully unmounting and remounting when the user toggles between the Source and Target tabs.

#### [MODIFY] [SubtitleAlignmentEditor.tsx](file:///Users/pavan/Documents/smartscribe/VaniScript/src/components/subtitle-alignment/SubtitleAlignmentEditor.tsx)
- Differentiate between a "clip change" (switching to a different clip) and a "language tab change" (switching display languages on the same clip).
- Track the current clip using `clipKey = `${title}|${clipStartSec}|${clipEndSec}``.
- In the initialization `useEffect`, only reset the player playback position (`currentSec = 0`), playing state (`playing = false`), canvas zoom/pan (`frameZoom`, `framePanX`, `framePanY`), timeline zoom, and undo stack if the `clipKey` has actually changed.
- If only the display language has changed (props like `initialSegments`, `initialLogo`, etc. update while `clipKey` remains the same), load the new language data into the editor's state but preserve all playback position, play/pause state, and canvas zoom/pan.
- Temporarily disable the draft/save `useEffect` hooks during the language change (using `initializedRef.current`) to prevent triggering callbacks with initial data during the switch.

---

### 2. Edge Feathering Controls & UI Preview

#### [MODIFY] [SubtitleAlignmentEditor.tsx](file:///Users/pavan/Documents/smartscribe/VaniScript/src/components/subtitle-alignment/SubtitleAlignmentEditor.tsx)
- Add sidebar range inputs (0-100px) for `Left` and `Right` feathering values when edge feathering is enabled.
- Combine vertical (top/bottom) and horizontal (left/right) linear gradients into the `<video>` element's mask styles:
  ```javascript
  WebkitMaskImage: masks.join(', '),
  maskImage: masks.join(', '),
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in'
  ```
  This ensures the preview displays true 4-edge feathering matching the final export.

---

### 3. atomic "Reset" & ClipSyncManager Propagation

#### [MODIFY] [SubtitleAlignmentEditor.tsx](file:///Users/pavan/Documents/smartscribe/VaniScript/src/components/subtitle-alignment/SubtitleAlignmentEditor.tsx)
- Simplify the `resetToInitial()` function to trigger the parent's `onResetAll()` handler atomically, instead of calling 8 separate saving callbacks sequentially. This avoids multiple parallel, asynchronous React state updates that overwrite each other in the parent `App.tsx`.

#### [MODIFY] [ClipSyncManager.ts](file:///Users/pavan/Documents/smartscribe/VaniScript/src/lib/ClipSyncManager.ts)
- Refactor `buildSyncPatch` to check `'fieldName' in appliedPatch` instead of using truthiness checks (`if (appliedPatch.fieldName)`).
- This ensures that fields explicitly cleared or set to `undefined` (such as clearing a logo overlay or resetting values in the Reset command) propagate correctly to the linked partner.

---

### 4. Background Blur & Exporter Rendering Sync

#### [MODIFY] [hyperframes-renderer.js](file:///Users/pavan/Documents/smartscribe/VaniScript/electron/hyperframes-renderer.js)
- In the frame-by-frame rendering loop inside `renderAt(timeSec)`:
  - Synchronize both the main foreground video player and the background blur video player's `currentTime` directly to `timeSec + project.clipStartSec`.
  - Use a fine-grained threshold (0.01s) or set them directly to align the frame times perfectly, eliminating drifting and rendering delays.
- Compile dual-gradient masks (vertical + horizontal) on the exported video stage using CSS `mask-composite: intersect` / `-webkit-mask-composite: source-in`.
- Ensure all mask properties are fully cleared when feathering is disabled or reset.

---

## Verification Plan

### Automated Tests
- Run the node test suite for the `ClipSyncManager` to verify correct sync patch generation:
  ```bash
  npx tsx src/lib/ClipSyncManager.test.ts
  ```
- Run the TypeScript compiler to check for type safety:
  ```bash
  npm run compile
  ```

### Manual Verification
- Launch the application dev server, verify that the SubtitleAlignmentEditor:
  - Preserves playback position, playing state, and canvas zoom/pan when switching between the Source and Target tabs.
  - Allows editing Top, Bottom, Left, and Right feather settings.
  - Clears all fields (keyframes, cuts, logo, styling) on the current plan and its linked partner simultaneously when "Reset" is clicked.
