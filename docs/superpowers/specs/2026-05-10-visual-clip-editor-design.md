# Visual Clip Editor Design

## Goal

Build a focused visual editor for Shorts/Reels clips selected by the user after AI moment discovery. The editor is not a full video editor for entire lectures. It works only with short approved moments and lets the user correct subtitle timing, subtitle text, and vertical video framing before final MP4 export.

## User Flow

1. AI finds candidate Shorts/Reels moments from the transcript.
2. User reviews candidate cards.
3. Each card offers `Details`, `Replace`, `Delete`, and `Edit Clip`.
4. The `Caption Style` area also offers `Open in Visual Editor` for the currently selected clip.
5. `Edit Clip` or `Open in Visual Editor` means the user approves that moment for real production work.
6. VaniScript creates or references a working clip range with video and audio.
7. The visual editor opens for that one clip.
8. User adjusts subtitles and framing.
9. User saves edits and exports the final short/reel.

## Scope

This feature is clip-level only. It does not edit a full 1-4 hour lecture timeline.

The existing transcription, translation, AI clip planning, and FFmpeg export systems remain in place. The new editor consumes their output and stores manual overrides.

## Card-Level Actions

Candidate clip cards should expose:

- `Details`: opens metadata, title, hook, description, source transcript, target transcript, and rendered caption lines.
- `Replace`: asks AI for a replacement candidate.
- `Delete`: removes the candidate from the list.
- `Edit Clip`: approves the candidate and opens the full visual clip editor.

`Edit Clip` should be the only action that turns a candidate into an editable production clip.

The `Caption Style` section should have a matching `Open in Visual Editor` button. It opens the same editor for the same selected clip as the card-level `Edit Clip` action. Both buttons must stay synchronized and point to the currently selected clip/language.

## Visual Clip Editor Layout

The editor opens as a large modal or full-screen overlay.

Required sections:

1. Video preview with vertical 9:16 framing.
2. Play/pause/seek controls.
3. Audio waveform for the selected clip.
4. Subtitle block timeline.
5. Subtitle text and word editor.
6. Frame/crop keyframe controls.

The editor should keep the UI simple. Users are not expected to be professional video editors.

## Subtitle Editing

Each subtitle segment contains:

- `id`
- `start`
- `end`
- `text`
- optional word-level timing data

Supported actions:

- drag a subtitle block left/right;
- resize the start edge;
- resize the end edge;
- edit text;
- split subtitle;
- merge adjacent subtitles;
- move words to previous or next subtitle when word timing data is available or inferred.

The editor should use AI-generated subtitles as the first draft. Manual edits override the generated cues.

## Word-Level Handling

If real word timestamps are available, the editor uses them.

If real word timestamps are not available, VaniScript may infer provisional word timings inside each subtitle cue. These inferred timings are only an editing aid. The user can still reassign words between subtitle blocks.

## Playback Sync

When the clip plays:

- video playback advances;
- waveform playhead advances;
- subtitle timeline playhead advances;
- active subtitle block highlights;
- text editor follows the active subtitle.

All timing inside the editor is local to the clip. Export converts local clip time to absolute source time by adding the clip start offset.

## Frame / Crop Animation

The editor supports simple vertical framing animation.

Each clip stores frame keyframes:

```ts
type FrameKeyframe = {
  id: string;
  time: number;
  x: number;
  y: number;
  zoom: number;
};
```

The user can:

- move the 9:16 crop/framing position;
- adjust zoom;
- add or update a keyframe at the current playhead;
- delete a keyframe;
- move between keyframes.

Between keyframes, movement is interpolated smoothly. The primary use case is keeping the speaker in frame when they move left or right.

## Caption Style Preview

The existing `Caption Style` mini-preview should no longer be treated as final output preview.

It remains only for quick style visualization:

- font;
- text color;
- box color;
- opacity;
- softness/blur;
- line spacing;
- uppercase/bold behavior.

The mini-preview should not include a playback audio/video player. It may keep manual previous/next subtitle controls so the user can inspect a few caption lines visually, but playback validation belongs in the full editor.

Final sync and framing validation happen only in the visual clip editor.

## Data Model

Manual clip edits should be stored in the project session:

```ts
type ClipEditProject = {
  clipId: string;
  sourceVideoPath: string;
  clipStartSec: number;
  clipEndSec: number;
  language: 'source' | 'target';
  subtitles: AlignedSubtitleSegment[];
  frameKeyframes: FrameKeyframe[];
  updatedAt: string;
  version: 1;
};

type AlignedSubtitleSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  words: AlignedWord[];
};

type AlignedWord = {
  id: string;
  text: string;
  start: number;
  end: number;
};
```

For bilingual clips, source and target edits should be stored separately, because source and target captions may need different line breaks and wording.

## Export Rules

Export uses manual edits when available.

Fallback order:

1. manually aligned subtitles;
2. AI-generated caption lines;
3. deterministic subtitle generation from transcript text.

MP4 export must use:

- selected source video range;
- frame keyframes;
- caption style;
- manually aligned subtitles.

The preview and final FFmpeg render must read from the same edit data so the exported result matches what the user saw in the editor.

## Performance

The editor works on short selected clips, not full lectures, so waveform rendering and timeline interactions should stay responsive.

Long lecture support remains in the earlier transcript/review pipeline. Visual clip editing only loads the selected clip range.

## First Implementation Slice

The first implementation should build:

1. `Edit Clip` button on clip cards.
2. Visual editor shell.
3. Video preview synced to clip local time.
4. Subtitle alignment data model.
5. Basic subtitle timeline with drag and resize.
6. Text editing for selected subtitle.
7. Save manual subtitle edits into the session.
8. Export using manual subtitle overrides.

Frame keyframes should be the second slice, immediately after subtitle timing works reliably.
