/**
 * DOM emission via native soft wrap: each line's content is one or more
 * INLINE `white-space: nowrap` segments carrying that line's word-spacing /
 * font-stretch, with the real break space (or a zero-width break span at
 * hyphen points) left between lines. Because every justified line fills the measure exactly, the
 * browser's own greedy wrap is forced to break at precisely the chosen
 * points — and because the flow stays inline:
 *   - assistive tech reads one continuous paragraph (no block boundaries),
 *     and hyphenated word fragments rejoin seamlessly;
 *   - original inline elements (links!) are cloned once and wrap across
 *     lines whole — one element, one tab stop, one accessible name;
 *   - find-in-page matches phrases across line breaks;
 *   - selection copies with spaces, not hard newlines.
 * Mid-line spaces live inside the segments, so line boundaries are the only
 * soft-wrap opportunities regardless of sub-pixel rounding. Hyphens render
 * as pseudo-content, invisible to the clipboard and accessibility tree.
 *
 * This is the write half only: it installs the segment DOM and reads no
 * layout at all, which is what lets a whole batch of paragraphs cost one
 * forced layout instead of one each. Reading the result back and correcting
 * the model's drift against it is ./line-corrections.js, which every written
 * paragraph is handed to as a `PendingParagraph`.
 */

import { graphemes } from "../core/cjk.js";

export interface RenderSegment {
  text: string;
  /** Source prefix rendered outside the nowrap span because it belongs to
   * the paragraph's floated `::first-letter`. Keeping it in the author's
   * inline ancestor chain, but out of `.justif-seg`, preserves the native
   * float line box and keeps correction reads limited to normal-flow text. */
  floatedPrefix?: string;
  /** Computed ::first-letter longhands for the real floated source span. */
  floatedStyle?: readonly (readonly [property: string, value: string])[];
  /** Source-run styling restored on this fragment inside the one real
   * first-letter float. Anonymous spans preserve styling without cloning
   * semantic descendants (and their links/ids) a second time. */
  floatedInnerStyle?: readonly (readonly [property: string, value: string])[];
  /** Source inline elements to clone around this text, outermost first. */
  ancestors: readonly Element[];
  /** Absolute word-spacing for this segment's own spaces (px). */
  wordSpacingPx: number;
  /** Number of rendered source-space characters in this segment that came
   * from core Glue and therefore receive measured word-spacing correction.
   * Includes synthetic NBSP used to keep run-boundary glue unbreakable;
   * excludes author U+00A0/U+202F, which remain fixed box content. */
  adjustableSpaceCount: number;
  /** False for an own-segment fixed-space box. A correction to the segment's
   * inherited letter-spacing would change the separator's authored advance,
   * so drift must be absorbed by other segments on the line. */
  allowLetterCorrection: boolean;
  /** Prevent the browser inventing a wrap after a fixed-space segment when
   * the line model kept the following box on this same line. */
  weldEnd?: boolean;
  /** Absolute letter-spacing (author's + letterfit tracking), or null to
   * inherit the author's value untouched (tracking inactive on this line). */
  letterSpacingPx: number | null;
  /** Resolved value represented by `letterSpacingPx` (including inherited
   * author spacing when the declaration itself is omitted). */
  resolvedLetterSpacingPx: number;
  /** Portion of the terminal glyph's advance physically removed so a
   * nowrap line can fit beside a float without moving the glyph itself. A
   * line ending in a fixed-separator run carries this on EVERY separator it
   * hangs — each gives up only its own advance — so a line's total removal
   * is the sum over its segments. */
  physicalEndHangPx?: number;
  /** Same removal for a line ending in an inserted hyphen, taken out of
   * the pseudo-hyphen's advance instead: the fit test beside a float
   * ignores the negative end margin that ordinarily encodes hyphen
   * protrusion, so a margined hyphen line drops below the float. Set on
   * the line's final text segment; the writer moves it onto the following
   * hyphen span. */
  hyphenEndHangPx?: number;
  /** The wrap-safety pad in the one form that works beside a float: advance
   * removed from the line's terminal cluster (or its pseudo-hyphen) instead
   * of carried in the end margin, which the fit test does not read. Unlike
   * the hang removals above this is not intentional protrusion — no glyph
   * moves, so the line paints exactly where it would without it — it is the
   * slack that keeps model drift from dropping a whole line under the float
   * while its correction is deferred or parked. Bounded by what that cluster
   * can actually give up, so the model never claims a removal the DOM did
   * not make. */
  physicalPadPx?: number;
  /** Absolute letter-spacing emitted on that hyphen span (the run's own
   * letter-spacing minus hyphenEndHangPx): spacing after the "-" shrinks
   * its advance while the ink still paints past the shortened line box. */
  hyphenLetterSpacingPx?: number;
  /**
   * The kern between the segment's terminal cluster and the cluster before it
   * (negative for the usual tight pair), which the hang carrier's own span
   * would otherwise drop: a span with its own letter-spacing is a shaping
   * boundary, so the pair is shaped in two runs and the adjustment never
   * applies. The measured line then comes out wider than the model and the
   * corrective pass takes the difference out of its word spaces — leaving the
   * closing mark visibly detached from the stop it follows while the line
   * still reads flush.
   *
   * Restored as a negative start margin on the carrier, which moves its box
   * (and so its glyph) back to where an unbroken run would have put it while
   * leaving the shed advance shed. The carrier also declares
   * `font-kerning: none`, which is what makes the compensation sound: Chromium
   * and WebKit drop the kern whatever the span carries, but Firefox shapes
   * across the boundary whenever the segment itself has a letter-spacing, and
   * a compensation may only answer a loss that is certain. The carrier holds
   * one grapheme cluster, so it has no kerning of its own to give up.
   *
   * Unset when the pair does not kern, and when the terminal cluster opens its
   * segment: the boundary before it is then the segment's own, which this
   * feature did not introduce and cannot speak for.
   */
  terminalKernPx?: number;
  /** Feature settings to emit when tracking needs to retain common
   * ligatures. Includes the author's low-level settings so this declaration
   * never replaces their stylistic sets or variant choices. */
  fontFeatureSettings?: string;
  /** Keep context-sensitive positional variants within the same shaping
   * unit used for measurement. CSS bidi isolation creates that boundary
   * without changing inline layout or adding DOM text. */
  isolateShaping?: boolean;
  /** The line's expansion; 100 = natural (declaration omitted). */
  fontStretchPct: number;
  /** Negative line-start protrusion on a line's first segment; 0 otherwise.
   * LOGICAL: emitted as margin-inline-start, which the browser resolves to
   * the left edge in LTR and the right edge in RTL — line starts hang into
   * the correct margin in both directions. */
  marginStartPx: number;
  /** Painted source inline whose clone receives `marginStartPx`, moving its
   * halo into the margin along with its contents. */
  marginStartOwner?: Element;
  /** Negative line-end protrusion + wrap-safety margin on a line's last
   * segment (shrinks layout advance only; glyphs paint unchanged). LOGICAL:
   * emitted as margin-inline-end (right in LTR, left in RTL), so the
   * corrective trailing margin always shrinks the line's advance at its
   * END edge. */
  marginEndPx: number;
  /** Intended optical protrusion of this line's final glyph. Assigned only
   * to the actual final text segment. */
  rightHangPx?: number;
  /** Deliberate excess after all configured shrink resources are exhausted.
   * Unlike DOM/canvas drift, this remains visibly overfull. */
  overflowPx?: number;
  /** Painted source inline whose clone receives `marginEndPx`. */
  marginEndOwner?: Element;
  /** Edge spaces excluded from corrective measurement (position-dependent
   * rendering) and re-added as exact model widths. */
  edgeTrim: { lead: number; trail: number; modelPx: number };
  /**
   * This segment's `text-transform` renders a different NUMBER of characters
   * than the source holds (`ß`→`SS`), so source offsets no longer index the
   * glyph run. Widths are unaffected — those come from a probe carrying the
   * property — but a Range measured by source offset is: WebKit resolves such
   * offsets against the untransformed glyph count and reports a line short by
   * the extra glyphs. Corrective reads therefore avoid Range on these
   * segments, and skip the line outright where they cannot.
   */
  transformChangesLength?: boolean;
  /** Inline padding/border px of cloned ancestors that open/close at this
   * segment. Layout width the text rects can't see (it sits on the clone,
   * outside the segment span) — added to the corrective model like the
   * edge-trim widths. */
  decorPx?: number;
  /** Clone whose painted border edge closes `decorPx` on this segment. */
  decorEndOwner?: Element;
  /** Contains CJK text: rendered with `font-kerning: none` (and Chromium's
   * text-spacing-trim disabled) so DOM advances equal the model's isolated
   * cluster advances. Engines disagree between canvas and DOM on kana
   * kerning — Chromium's DOM kerns pairs its canvas never measures, WebKit
   * is the inverse — so cross-cluster kerning cannot be measured
   * consistently; the model assumes solid setting (bete-gumi) and the
   * renderer matches it. */
  cjk?: boolean;
  /**
   * What separates this segment from the previous one:
   * "none" — same-line continuation (no break opportunity),
   * "space" — line boundary at a space (bare text node, hangs at wrap),
   * "hyphen" — line boundary at a hyphenation point (pseudo-hyphen +
   *   zero-width break span),
   * "wbr" — zero-width line boundary (dash break or CJK), rendered as
   *   a break span whose ::after is a generated ZWSP.
   */
  joint: "none" | "space" | "hyphen" | "wbr";
  /**
   * Write that space joint with no advance of its own: it closes a line the
   * float intrudes on. The character stays in the DOM — copies, find, and
   * the accessibility tree read the same text — only the box it renders in
   * is zero-width.
   *
   * Chromium hangs a break space that overflows the band, as the other
   * engines do, UNLESS a negative margin on the box opening the next line
   * pulls the running position back inside: the space then counts against
   * the band, the nowrap line after it cannot fit, and the whole line is set
   * below the float at its narrow measure. Measured, a line is refused
   * exactly when the room left in its band falls in `(space − |start
   * margin|, space]` — never above, never below. Line starts protrude by
   * precisely such a margin, and the room a line leaves beside a float is
   * near a space often enough to matter: the safety pad and the closing
   * glyph's hang both come out of its advance, and a line with no glue to
   * stretch keeps whatever the model could not fill besides. A dropped line
   * also stays dropped — the correction that would rescue it measures a line
   * already as wide as its own narrow band asked for. A space with no
   * advance to spend cannot open the window at any width.
   */
  jointFlat?: true;
}

/** A mandatory source break between independently laid-out segments. The
 * writer clones the real element so selection, copying, accessibility, and
 * inline ancestry retain native <br> semantics. */
export interface RenderHardBreak {
  kind: "hard-break";
  source: Element;
  ancestors: readonly Element[];
}

export type RenderContent = RenderSegment | RenderHardBreak;

/**
 * Advance shed from a segment's terminal cluster: the terminal glyph's
 * physical hang, plus the wrap-safety pad unless a pseudo-hyphen carries that
 * instead (`hyphenLetterSpacingPx` already holds it, and the cluster must not
 * shed it twice). Positive means the writer gives that cluster a span of its
 * own — the one place the shed can live as reduced letter advance.
 */
export function hangCarrierShed(seg: RenderSegment): number {
  return (
    (seg.physicalEndHangPx ?? 0) +
    (seg.hyphenLetterSpacingPx === undefined ? (seg.physicalPadPx ?? 0) : 0)
  );
}

/**
 * How the writer divides a segment that sheds advance from its terminal
 * cluster: the text before that cluster, the cluster carrying the shed, the
 * cluster right before it (whose pair kern the split drops), and the rest.
 *
 * Only collapsible source spaces are layout glue, so they are never the
 * carrier. Fixed-width Unicode separators are real box glyphs and can
 * themselves be the character whose full advance hangs at the line end — as
 * can the collapsible space hung with a trailing separator run, which is a
 * segment of its own and sits INSIDE the line box, ahead of the run it hangs
 * with. `terminal` is undefined only for an empty segment.
 */
export function terminalSplit(text: string): {
  before: string;
  prev: string | undefined;
  terminal: string | undefined;
  after: string;
} {
  const clusters = graphemes(text);
  let end = clusters.length - 1;
  while (end > 0 && clusters[end] === " ") end--;
  const terminal = clusters[end];
  if (terminal === undefined) return { before: "", prev: undefined, terminal, after: "" };
  return {
    before: clusters.slice(0, end).join(""),
    prev: end > 0 ? clusters[end - 1] : undefined,
    terminal,
    after: clusters.slice(end + 1).join(""),
  };
}

/**
 * Provisional trailing-margin pad (px) each line carries from write time
 * until its measured correction runs: covers model drift (expansion
 * responds per glyph; canvas vs DOM variance, ≤ ~1.3px observed) so a
 * line can never re-wrap while its correction is deferred/parked.
 */
export const WRAP_SAFETY_PAD_PX = 1.5;
/** Correct every line measuring above this window; lines shorter than it
 * are ragged by design (paragraph endings) and keep their provisional
 * margins. Wide enough to re-capture set lines sitting on the safety pad. */
export const CORRECTION_WINDOW_PX = -(2 * WRAP_SAFETY_PAD_PX);
/** Physical slack retained beside a float. Firefox can reject an
 * exactly-equal later nowrap fragment after device-pixel rounding. */
export const FLOAT_WRAP_SPARE_PX = 0.25;
const STYLE_ID = "justif-style";
export const px = (v: number): string => `${Math.round(v * 1000) / 1000}px`;

const SHEET_TEXT =
  // Emergency-break licences are neutralized on the paragraph too, but
  // Firefox resolves them from the element AT the break point, so the
  // paragraph reset alone leaves it breaking whenever an author rule grants
  // one closer in — `!important`, or a nested inline the segments are cloned
  // into (`a{overflow-wrap:break-word}`). This rule is what covers Firefox
  // in those cases; Chromium consults the block container and ignores it.
  ".justif-seg,.justif-hyphen,.justif-break{overflow-wrap:normal;word-break:normal;line-break:auto}" +
  ".justif-seg{white-space:nowrap}" +
  // The break space beside a float, written with neither advance nor
  // leading (see RenderSegment.jointFlat). It still breaks: a space is a
  // break opportunity whatever it measures.
  ".justif-joint{font-size:0;line-height:0}" +
  // Once the source letter is a real float, Firefox retargets the
  // paragraph pseudo to the first normal-flow letter. Neutralize that
  // second pseudo; the real float carries the snapshotted author styles.
  "[data-justif-dropcap]::first-letter{all:unset!important}" +
  // nowrap on the hyphen carrier too, and it is the broadest of these
  // defenses: it is the only one that stops Chromium breaking between a
  // segment and the hyphen glyph ending the same line when the licence
  // reaches the break point past the resets above — an author `!important`,
  // or a rule on a nested inline. The wanted break stays on the following
  // `.justif-break`, outside this element.
  '.justif-hyphen{white-space:nowrap}.justif-hyphen::after{content:"-"}' +
  // Applied around a re-read, which has to read author values back the moment it
  // writes them — and a transitioning property computes as its OLD value until
  // its transition ends (see suppressTransitions). A class, not an inline
  // declaration: this must not touch the style attribute justif saves and
  // restores on the author's behalf.
  ".justif-no-transition{transition-property:none!important}" +
  // Zero-width joints carry their break opportunity as a generated ZWSP
  // instead of a <wbr>: DOM-walking annotation tools treat unrecognized
  // elements as word separators, splitting the hyphenated word a quote
  // must match. A bare hyphen-letter boundary is NOT sufficient in its
  // place: Firefox follows UAX14 in refusing to break a hyphen-digit
  // pair, so the ZWSP stays load-bearing.
  '.justif-break::after{content:"\u200B"}' +
  // A generated WORD JOINER preserves source text while suppressing the
  // fixed separator's native break at an unchosen same-line boundary.
  '.justif-weld-end::after{content:"\u2060"}' +
  '@supports (content:"-" / ""){.justif-hyphen::after{content:"-" / ""}' +
  '.justif-break::after{content:"\u200B" / ""}' +
  '.justif-weld-end::after{content:"\u2060" / ""}}';

/**
 * Pin rendered text to the CSS font size. iOS Safari's automatic text
 * autosizing is a post-CSS multiplier that can change after measurement and
 * can differ between the nowrap fragments that make up adjacent lines.
 * Inline !important is intentional: these metrics are as load-bearing as the
 * emitted px spacing, and neither a more-specific host rule nor a declaration
 * on an intervening cloned element may change them after measurement.
 */
/**
 * The pair, as data. Both spellings are the same property where each is
 * recognized, so a caller that records what it writes over has to read the
 * author's values for both BEFORE writing either (see maskAuthorStyles).
 */
export const TEXT_AUTOSIZING_DECLARATIONS = [
  ["-webkit-text-size-adjust", "100%"],
  ["text-size-adjust", "100%"],
] as const;

export function disableTextAutosizing(el: HTMLElement): void {
  for (const [property, value] of TEXT_AUTOSIZING_DECLARATIONS) {
    el.style.setProperty(property, value, "important");
  }
}

/** Roots (documents and shadow roots) that already carry the sheet. */
const styledRoots = new WeakSet<Document | ShadowRoot>();

/**
 * Install the segment rules at the paragraph's ROOT — the document, or the
 * shadow root it lives in (document-level styles don't pierce shadow
 * boundaries; without `.justif-seg{white-space:nowrap}` the entire line
 * model silently collapses). Constructable stylesheets are preferred: they
 * also work under a strict Content-Security-Policy, where an injected
 * inline `<style>` element is blocked by `style-src` without
 * 'unsafe-inline'. The `<style>` element is only the legacy fallback
 * (pre-2023 engines without adoptedStyleSheets).
 */
function ensureStylesheet(root: Document | ShadowRoot): void {
  if (styledRoots.has(root)) return;
  // Duck-typed, not instanceof: an iframe's document is another realm's
  // Document and instanceof would misclassify it.
  const isDoc = root.nodeType === 9; /* DOCUMENT_NODE */
  const doc = isDoc ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const win = doc.defaultView;
  if (win !== null && "adoptedStyleSheets" in root) {
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(SHEET_TEXT);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      styledRoots.add(root);
      return;
    } catch {
      /* same-realm constraint or frozen list: fall through to <style> */
    }
  }
  if (isDoc && doc.getElementById(STYLE_ID) !== null) {
    styledRoots.add(root);
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHEET_TEXT;
  (isDoc ? doc.head : (root as ShadowRoot)).append(style);
  styledRoots.add(root);
}

export interface LineEntry {
  el: HTMLElement;
  seg: RenderSegment | null;
  marginEndEl: HTMLElement;
  /** Closing decorated-inline clone, when its border edge is the line's
   * physical painted end even though it carries no protrusion margin. */
  paintEndEl?: HTMLElement;
}

/**
 * A paragraph whose segments are in the DOM but whose measured wrap
 * guarantee has not run yet — the handle this module hands to
 * ./line-corrections.js. Produce with `writeParagraph`, then batch any number
 * of these through `measureCorrections` (reads) + `applyCorrections`
 * (writes): interleaving the phases per paragraph would force a full layout
 * per paragraph, batching costs one for the whole flush.
 */
export interface PendingParagraph {
  doc: Document;
  paragraph: HTMLElement;
  lineElements: LineEntry[][];
  /** Target width per line (index-aligned with lineElements): lines under
   * a text-indent have a different measure than the rest. */
  lineWidths: readonly number[];
  /** Content width the paragraph had before its segment DOM was installed.
   * Enhancement may change line breaks and height, never its own measure. */
  contentWidth: number;
  /** Leading lines whose coordinate edge depends on a float. Correct these
   * from their measured physical width rather than the paragraph edge. */
  physicalFitLines: number;
  /** Live deep clone of an authored leading float, when present. */
  renderedFloat: Element | null;
}


/** Write phase: build and install the segment DOM. No layout reads. */
export function writeParagraph(
  p: HTMLElement,
  contents: readonly RenderContent[],
  lineWidths: readonly number[],
  contentWidth: number,
  physicalFitLines = 0,
  leadingFloat?: { source: Element; leadingTrivia: readonly Node[] },
  /** The float this paragraph is already rendering, from the previous patch.
   * Kept in place rather than re-cloned: a resize drag patches once per
   * frame, and a fresh clone each time would restart the float's CSS
   * transitions and image decode, drop listeners the page attached to it,
   * and blur anything focused inside it. */
  previousFloat?: Element | null,
): PendingParagraph {
  const doc = p.ownerDocument;
  const root = p.getRootNode();
  ensureStylesheet(
    root.nodeType === 9 || (root.nodeType === 11 && "host" in root)
      ? (root as Document | ShadowRoot)
      : doc,
  );
  /** Per intended line: its visual elements (with their segment data);
   * the last one takes the corrective margin. */
  const lineElements: LineEntry[][] = [[]];

  const fragment = doc.createDocumentFragment();
  let renderedFloat: Element | null = null;
  /** The reused float, still attached to `p` — so the install below has to
   * replace its FOLLOWING siblings rather than every child. */
  let keptFloat: Element | null = null;
  if (leadingFloat !== undefined) {
    // The enhanced DOM always opens with the trivia then the float, so a
    // still-attached float from the previous patch is already in position
    // together with its trivia: only what follows needs rewriting.
    if (previousFloat != null && previousFloat.parentNode === p) {
      keptFloat = previousFloat;
      renderedFloat = previousFloat;
    } else {
      for (const node of leadingFloat.leadingTrivia) fragment.append(node.cloneNode(true));
      renderedFloat = leadingFloat.source.cloneNode(true) as Element;
      fragment.append(renderedFloat);
    }
  }
  // One clone per source element for the whole paragraph: segments of the
  // same source element are contiguous, so a plain stack suffices and
  // elements never need duplicating (ids, tab stops, and accessible names
  // stay singular).
  const stack: Array<{ src: Element; clone: Element }> = [];
  const containerAt = (depth: number): ParentNode =>
    depth === 0 ? fragment : stack[depth - 1]!.clone;

  const commonDepth = (chain: readonly Element[]): number => {
    let i = 0;
    while (i < stack.length && i < chain.length && stack[i]!.src === chain[i]) i++;
    return i;
  };

  const containerFor = (chain: readonly Element[]): ParentNode => {
    let depth = commonDepth(chain);
    stack.length = depth;
    for (; depth < chain.length; depth++) {
      const src = chain[depth]!;
      const clone = src.cloneNode(false) as Element;
      containerAt(depth).append(clone);
      stack.push({ src, clone });
    }
    return containerAt(chain.length);
  };

  const cloneFor = (
    src: Element | undefined,
    chain: readonly Element[],
  ): HTMLElement | undefined => {
    if (src === undefined) return undefined;
    const depth = chain.indexOf(src);
    return depth < 0 ? undefined : (stack[depth]?.clone as HTMLElement | undefined);
  };

  let prevContainer: ParentNode = fragment;
  let floatSource: HTMLElement | null = null;
  const segments = contents.filter(
    (content): content is RenderSegment => !("kind" in content),
  );
  const floatBaseStyle = new Map(
    segments.find((segment) => segment.floatedStyle !== undefined)?.floatedStyle ?? [],
  );
  const floatInnerProperties = new Set(
    segments.flatMap((segment) =>
      (segment.floatedInnerStyle ?? []).map(([property]) => property),
    ),
  );
  let lastWasHardBreak = false;
  for (const content of contents) {
    if ("kind" in content) {
      const container = containerFor(content.ancestors);
      container.append(content.source.cloneNode(false));
      prevContainer = container;
      lineElements.push([]);
      lastWasHardBreak = true;
      continue;
    }
    const segment = content;
    lastWasHardBreak = false;
    if (segment.joint === "hyphen") {
      const hyphen = doc.createElement("span");
      hyphen.className = "justif-hyphen";
      disableTextAutosizing(hyphen);
      // The line's trailing protrusion margin must sit AFTER the hyphen —
      // on the preceding text segment it would pull the hyphen glyph back
      // into the word it belongs to. (RTL paragraphs never hyphenate, so
      // this path is LTR-only in practice; logical margins keep it
      // direction-correct regardless.)
      const entries = lineElements[lineElements.length - 1]!;
      const prevEntry = entries[entries.length - 1];
      if (prevEntry !== undefined && prevEntry.marginEndEl.style.marginInlineEnd !== "") {
        hyphen.style.marginInlineEnd = prevEntry.marginEndEl.style.marginInlineEnd;
        prevEntry.marginEndEl.style.marginInlineEnd = "";
      }
      // Beside a float the hyphen's optical hang is removed from its
      // physical advance rather than carried in the margin above (see
      // RenderSegment.hyphenEndHangPx).
      if (prevEntry?.seg?.hyphenLetterSpacingPx !== undefined) {
        hyphen.style.letterSpacing = px(prevEntry.seg.hyphenLetterSpacingPx);
      }
      prevContainer.append(hyphen);
      entries.push({ el: hyphen, seg: null, marginEndEl: hyphen });
    }
    if (segment.joint !== "none") {
      lineElements.push([]);
      // The joint lives at the deepest container common to both sides, so a
      // break inside a link keeps its space/wbr inside the link.
      const depth = Math.min(commonDepth(segment.ancestors), stack.length);
      stack.length = depth;
      const container = containerAt(depth);
      if (segment.joint === "space") {
        const space = doc.createTextNode(" ");
        if (segment.jointFlat !== true) container.append(space);
        else {
          // Beside a float the break space is written without an advance
          // (see RenderSegment.jointFlat). Its leading goes with it: a
          // zero-size box still takes the inherited line-height, half of it
          // below a baseline it has nothing hanging under, which would
          // deepen every line box on the float's side of the paragraph.
          const flat = doc.createElement("span");
          flat.className = "justif-joint";
          flat.append(space);
          container.append(flat);
        }
      } else {
        // Zero-width break opportunity via generated content, not a <wbr>
        // element and not a ZWSP text node (see SHEET_TEXT): the text
        // layer — selection, clipboard, find-in-page — stays byte-identical
        // to the source.
        const brk = doc.createElement("span");
        brk.className = "justif-break";
        container.append(brk);
      }
    }

    const container = containerFor(segment.ancestors);
    if (segment.floatedPrefix !== undefined) {
      if (floatSource === null) {
        floatSource = doc.createElement("span");
        floatSource.className = "justif-float-source";
        disableTextAutosizing(floatSource);
        for (const [property, value] of segment.floatedStyle ?? []) {
          floatSource.style.setProperty(property, value);
        }
        container.append(floatSource);
      }
      if (floatInnerProperties.size === 0) {
        floatSource.append(doc.createTextNode(segment.floatedPrefix));
      } else {
        const innerStyle = new Map(segment.floatedInnerStyle ?? []);
        const fragment = doc.createElement("span");
        fragment.className = "justif-float-fragment";
        // The real float is nested under the first source run's cloned
        // ancestors. For every property any floated run overrides, later
        // fragments must either apply their own override or reset to the
        // snapshotted pseudo value instead of inheriting that first run.
        for (const property of floatInnerProperties) {
          const value = innerStyle.get(property) ?? floatBaseStyle.get(property);
          if (value !== undefined) fragment.style.setProperty(property, value);
        }
        fragment.append(doc.createTextNode(segment.floatedPrefix));
        floatSource.append(fragment);
      }
    }
    // A first-letter range can consume a whole styling run. Its source text
    // still belongs in the cloned DOM, but there is no normal-flow segment
    // to measure or correct for that run.
    if (segment.text.length === 0) {
      prevContainer = container;
      continue;
    }
    const el = doc.createElement("span");
    el.className =
      segment.weldEnd === true ? "justif-seg justif-weld-end" : "justif-seg";
    disableTextAutosizing(el);
    // Always written (even "0px"): an inherited word-spacing from ancestor
    // CSS must not leak into a segment whose computed adjustment is zero.
    el.style.wordSpacing = px(segment.wordSpacingPx);
    if (segment.letterSpacingPx !== null) {
      el.style.letterSpacing = px(segment.letterSpacingPx);
      if (segment.fontFeatureSettings !== undefined) {
        el.style.fontFeatureSettings = segment.fontFeatureSettings;
      }
    }
    if (segment.isolateShaping === true) el.style.unicodeBidi = "isolate";
    if (segment.fontStretchPct !== 100) {
      el.style.fontStretch = `${Math.round(segment.fontStretchPct * 100) / 100}%`;
    }
    const marginStartEl = cloneFor(segment.marginStartOwner, segment.ancestors) ?? el;
    const marginEndEl = cloneFor(segment.marginEndOwner, segment.ancestors) ?? el;
    const paintEndEl = cloneFor(segment.decorEndOwner, segment.ancestors);
    if (segment.marginStartPx !== 0) {
      marginStartEl.style.marginInlineStart = px(segment.marginStartPx);
    }
    if (segment.marginEndPx !== 0) marginEndEl.style.marginInlineEnd = px(segment.marginEndPx);
    if (segment.cjk === true) {
      // Match the measurement model (isolated cluster advances, no
      // cross-cluster kerning — see RenderSegment.cjk).
      el.style.fontKerning = "none";
      // Chromium-only: its DOM trims fullwidth punctuation pairs by
      // default (text-spacing-trim: normal) while its canvas doesn't;
      // space-all disables the trim. A no-op in other engines.
      el.style.setProperty("text-spacing-trim", "space-all");
    }
    const shedPx = hangCarrierShed(segment);
    if (shedPx > 0) {
      const { before, terminal, after } = terminalSplit(segment.text);
      if (terminal === undefined) el.textContent = segment.text;
      else {
        el.append(before);
        const span = doc.createElement("span");
        span.className = "justif-hanging-end";
        span.style.letterSpacing = px(segment.resolvedLetterSpacingPx - shedPx);
        // Take the pair kern this boundary costs out of the engine's hands
        // and put it back as layout (see RenderSegment.terminalKernPx).
        if (segment.terminalKernPx !== undefined) {
          span.style.fontKerning = "none";
          span.style.marginInlineStart = px(segment.terminalKernPx);
        }
        span.textContent = terminal;
        el.append(span, after);
      }
    } else el.textContent = segment.text;
    container.append(el);
    prevContainer = container;
    lineElements[lineElements.length - 1]!.push({
      el,
      seg: segment,
      marginEndEl,
      paintEndEl,
    });
  }

  // A trailing <br> terminates the current line but does not create another
  // line box after itself. Consecutive breaks retain all preceding empty
  // entries, so <br><br> still contributes two native-height lines.
  if (lastWasHardBreak) lineElements.pop();
  if (keptFloat === null) p.replaceChildren(fragment);
  else {
    while (keptFloat.nextSibling !== null) keptFloat.nextSibling.remove();
    p.append(fragment);
  }
  return {
    doc,
    paragraph: p,
    lineElements,
    lineWidths,
    contentWidth,
    physicalFitLines,
    renderedFloat,
  };
}
