/**
 * Keeping a copy of enhanced text identical to the author's text.
 *
 * The rendered DOM is not the paragraph the author wrote: lines are separate
 * `.justif-seg` elements joined by literal spaces, word joiners hold shaping
 * together across a segment boundary, and NBSPs stand in for spaces that must
 * not collapse. All of that is layout, and none of it belongs on the
 * clipboard — so a copy that touches a managed paragraph is rebuilt from the
 * cloned selection with the layout scaffolding taken back out.
 *
 * One listener for the whole document, not one per controller: see
 * `joinClipboardCleanup`.
 */

import type { ParagraphScan } from "./read.js";

/** Block-level tags whose boundaries become blank lines in a plain-text copy. */
const BLOCKY_TAGS =
  /^(?:P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|FIGCAPTION)$/;

/**
 * text/plain for a copied fragment. Taken from the cloned nodes rather than
 * Selection.toString(): Firefox's toString() folds NBSP to a plain space,
 * which would drop the very author NBSPs the cleanup guard exists to
 * preserve.
 */
function plainTextOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  let out = "";
  for (let c = node.firstChild; c !== null; c = c.nextSibling) out += plainTextOf(c);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName;
    if (tag === "BR") out += "\n";
    else if (BLOCKY_TAGS.test(tag)) out += "\n\n";
  }
  return out;
}

/** Text nodes that contribute at least one character to a live selection
 * range, in document order. Empty endpoint slices are deliberately omitted:
 * the first non-empty node is the one that determines whether a copied
 * fragment starts with a layout-only joint, even when the range starts at the
 * end of the preceding text node. */
function nonEmptyTextNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  const out: Text[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node as Text;
    if (!range.intersectsNode(text)) return;
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.data.length;
    if (start < end) out.push(text);
  };
  if (root.nodeType === Node.TEXT_NODE) visit(root);
  else {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      visit(node);
    }
  }
  return out;
}

/** The only ordinary whitespace text node the enhanced DOM emits outside a
 * `.justif-seg`: the literal space that carries a real soft-wrap joint.
 * Author whitespace is inside a segment, so this remains safe even when a
 * selection crosses non-enhanced content before or after a managed paragraph.
 */
function isJustifBoundaryJoint(node: Text): boolean {
  const parent = node.parentElement;
  return (
    node.data === " " &&
    parent !== null &&
    parent.closest(".justif-seg") === null &&
    parent.closest("[data-justif]") !== null
  );
}

/** Clone-side counterpart to isJustifBoundaryJoint(). The cloned fragment no
 * longer has the enhanced paragraph ancestor, so only its segment boundary
 * shape can be checked there; the live-node check already established the
 * paragraph provenance. */
function isClonedBoundaryJoint(node: Text): boolean {
  const parent = node.parentElement;
  return node.data === " " && (parent === null || parent.closest(".justif-seg") === null);
}

/** Remove leading/trailing layout-only joints from one copied range. The live
 * range identifies the first and last included text nodes before cloning;
 * cloneContents() may add empty endpoint text clones, so the corresponding
 * clone is found by its first/last NON-EMPTY text position instead. */
function removeCopiedBoundaryJoints(range: Range, fragment: DocumentFragment): void {
  const included = nonEmptyTextNodesInRange(range);
  if (included.length === 0) return;
  const trimLeading = isJustifBoundaryJoint(included[0]!);
  const trimTrailing = isJustifBoundaryJoint(included[included.length - 1]!);
  if (!trimLeading && !trimTrailing) return;

  const cloned = nonEmptyTextNodesInRange(
    // A detached fragment is not a live selection range, so collect its text
    // nodes directly rather than reusing the range helper above.
    (() => {
      const cloneRange = fragment.ownerDocument!.createRange();
      cloneRange.selectNodeContents(fragment);
      return cloneRange;
    })(),
  );
  const remove = new Set<Text>();
  const first = cloned[0];
  const last = cloned[cloned.length - 1];
  if (trimLeading && first !== undefined && isClonedBoundaryJoint(first)) {
    remove.add(first);
  }
  if (trimTrailing && last !== undefined && isClonedBoundaryJoint(last)) {
    remove.add(last);
  }
  for (const node of remove) node.remove();
}
/**
 * Clipboard cleanup is a DOCUMENT-level concern, so all controllers share one
 * listener: registering per controller meant a page that re-justifies without
 * destroying accumulated handlers, each one cloning the whole selection on
 * every copy, and whichever ran last decided the NBSP question for everyone —
 * so an author NBSP in one controller's paragraph could be normalized away by
 * another's handler. One listener, unioning every participant, removes both.
 */
export interface ClipboardParticipant {
  /** Enhanced paragraphs this controller owns, with their scans. */
  enhanced(): Iterable<readonly [HTMLElement, ParagraphScan]>;
}

const clipboardParticipants = new Set<ClipboardParticipant>();

const onDocumentCopy = (e: ClipboardEvent): void => {
  if (e.clipboardData === null) return;
  const sel = document.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return;
  let touches = false;
  let authorNbsp = false;
  for (const participant of clipboardParticipants) {
    for (const [p, scan] of participant.enhanced()) {
      if (!sel.containsNode(p, true)) continue;
      touches = true;
      if (scan.authorHasNbsp) authorNbsp = true;
    }
  }
  if (!touches) return;

  const clean = (v: string): string => {
    const noWj = v.replace(/\u2060/g, "");
    return authorNbsp ? noWj : noWj.replace(/\u00A0/g, " ");
  };
  const html = document.createElement("div");
  let plain = "";
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const frag = range.cloneContents();
    removeCopiedBoundaryJoints(range, frag);
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      n.nodeValue = clean(n.nodeValue ?? "");
    }
    plain += plainTextOf(frag);
    html.append(frag);
  }
  e.clipboardData.setData("text/plain", plain.replace(/\n+$/, ""));
  e.clipboardData.setData("text/html", html.innerHTML);
  e.preventDefault();
};

/** Join the shared copy handler; returns the leave function. The document
 * listener exists only while at least one controller wants cleanup. */
export function joinClipboardCleanup(participant: ClipboardParticipant): () => void {
  if (clipboardParticipants.size === 0) {
    document.addEventListener("copy", onDocumentCopy);
  }
  clipboardParticipants.add(participant);
  return () => {
    if (!clipboardParticipants.delete(participant)) return;
    if (clipboardParticipants.size === 0) {
      document.removeEventListener("copy", onDocumentCopy);
    }
  };
}