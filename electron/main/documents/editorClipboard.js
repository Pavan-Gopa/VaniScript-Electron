'use strict';

// Editorial editor core — clipboard sanitization (DOC-05, plan §10.7).
//
// Editor invariant #6: clipboard operations must strip PRIVATE internal IDs —
// blockId/spanId must never leak into pasted text or a clipboard payload.
// This module is the serialization half of the MANDATORY paste boundary (the
// trust half — stripping foreign identity and reminting destination-trusted
// IDs — lives in editorCore.preparePasteFragment, wired into
// EditorBinding.applyPaste; there is no unsanitized paste path):
//
//   copy  — `clipboardPayload` serializes a ProseMirror slice/fragment/node
//           into a payload that carries only PUBLIC information: plain text
//           plus the public span traits (bold, italic, ...). The `span` mark
//           (spanId/policy/note) and every node attr (blockId, fingerprints,
//           hashes) are dropped here, so nothing private can leave the doc
//           through this path.
//   paste — `fragmentFromPayload` rebuilds a ProseMirror fragment from such
//           a payload. By construction it contains NO id-bearing attribute
//           or mark; trusted stable IDs are minted afterwards by the editor
//           core (`EditorCore.preparePasteFragment`, editor invariant #3 —
//           the clipboard never supplies identity).
//
// Pure and DOM-free: testable headlessly with node:test.

const { EDITOR_SCHEMA, TRAIT_MARKS } = require('./editorSchema.js');
const { Fragment, Slice } = require('prosemirror-model');

const BLOCK_SEPARATOR = '\n\n';

/**
 * Serialize clipboard content into `{ text, segments }`.
 *
 * - `text`: plain text; top-level blocks are joined with a blank line.
 * - `segments`: public trait runs that concatenate to exactly `text` —
 *   separators appear as their own trait-less segments, so
 *   `text === segments.map(s => s.text).join('')` always holds.
 *
 * Accepts a PM Slice, Fragment or Node (including bare text nodes). Never
 * reads or emits any id-bearing attribute or mark.
 */
function clipboardPayload(content) {
  const fragment = toFragment(content);
  const segments = [];
  fragment.forEach((child, _offset, index) => {
    if (index > 0) segments.push({ text: BLOCK_SEPARATOR, traits: {}, blockBreak: true });
    serializeInline(child, segments);
  });
  return { text: segments.map((s) => s.text).join(''), segments };
}

/**
 * PM value → its content Fragment. Text nodes (and other leaves) have EMPTY
 * `.content`, so they are wrapped as themselves — dropping their text would
 * silently lose pasted content. Slices contribute their open content;
 * nodes their children; fragments pass through.
 */
function toFragment(content) {
  if (!content) throw new TypeError('clipboardPayload requires a Slice, Fragment or Node.');
  if (content.isText || content.isLeaf) return Fragment.fromArray([content]);
  if (content instanceof Slice) return content.content;
  if (content.type) return content.content;
  return content;
}

function serializeInline(node, out) {
  if (node.isText) {
    out.push({ text: node.text, traits: traitsOfMarks(node.marks) });
    return;
  }
  node.content.forEach((child) => serializeInline(child, out));
}

/** Public traits only: the boolean marks + color, never ids or policies. */
function traitsOfMarks(marks) {
  const traits = {};
  for (const mark of marks) {
    if (TRAIT_MARKS.includes(mark.type.name)) traits[mark.type.name] = true;
    else if (mark.type.name === 'color' && mark.attrs.color) traits.color = mark.attrs.color;
  }
  return traits;
}

// --- Paste side: payload → id-free fragment ----------------------------------

/**
 * Rebuild a ProseMirror fragment from a `clipboardPayload`. The result is
 * id-FREE BY CONSTRUCTION: text nodes carry only the public trait marks —
 * never the `span` mark, never any node attr. Block breaks in the payload
 * become separate paragraph nodes; an inline-only payload becomes one
 * paragraph. Trusted stable IDs are minted later by
 * `EditorCore.preparePasteFragment` (editor invariant #3).
 */
function fragmentFromPayload(payload) {
  if (!payload || !Array.isArray(payload.segments)) {
    throw new TypeError('fragmentFromPayload requires a clipboardPayload.');
  }
  const schema = EDITOR_SCHEMA;
  const paragraphs = [];
  let inline = [];
  const flush = () => {
    if (inline.length === 0) return;
    paragraphs.push(schema.nodes.paragraph.create({ blockId: '' }, inline));
    inline = [];
  };
  for (const segment of payload.segments) {
    if (!segment || typeof segment.text !== 'string') {
      throw new TypeError('clipboardPayload segments must carry text.');
    }
    if (segment.blockBreak) {
      flush();
      // The separator itself is structure, not content: never copy its
      // characters into the rebuilt document.
      continue;
    }
    if (segment.text.length === 0) continue;
    const marks = marksForTraits(schema, segment.traits);
    inline.push(marks.length ? schema.text(segment.text, marks) : schema.text(segment.text));
  }
  flush();
  // An empty payload still yields one empty paragraph so a paste handler
  // always receives insertable block-level content.
  if (paragraphs.length === 0) {
    paragraphs.push(schema.nodes.paragraph.create({ blockId: '' }));
  }
  return Fragment.fromArray(paragraphs);
}

/** Trait-object → mark array, in schema order; no span mark, no ids. */
function marksForTraits(schema, traits) {
  if (!traits || typeof traits !== 'object') return [];
  const marks = [];
  for (const k of TRAIT_MARKS) if (traits[k]) marks.push(schema.marks[k].create());
  if (traits.color) marks.push(schema.marks.color.create({ color: traits.color }));
  return marks;
}

/**
 * Defensive helper for tests and IPC boundaries: true when a payload carries
 * no id-bearing key anywhere in its serialized form.
 */
function payloadIsPrivateIdFree(payload) {
  const serialized = JSON.stringify(payload);
  return !/"(spanId|blockId|policy|note|styleFingerprint|sourceHash)"\s*:/.test(serialized);
}


module.exports = {
  clipboardPayload,
  fragmentFromPayload,
  payloadIsPrivateIdFree,
  toFragment,
  BLOCK_SEPARATOR,
};
