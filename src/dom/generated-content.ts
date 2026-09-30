/** Generated text stays on the author's pseudo-element. Only its fixed
 * advance enters the model; source text and cloned ancestry remain intact. */
export interface GeneratedText {
  text: string;
  spec: number;
  insetPx: number;
  /** Computed values that determine the generated box measured above. */
  style: readonly string[];
}

/** Layout-affecting generated-content values pinned onto reconstructed
 * pseudo-elements. Content is included because selector state may change
 * after the paragraph has been scanned. */
export const GENERATED_STYLE_PROPERTIES = [
  "content",
  "unicode-bidi",
  "white-space",
  "padding-left",
  "padding-right",
  "border-left-width",
  "border-left-style",
  "border-right-width",
  "border-right-style",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-variation-settings",
  "font-feature-settings",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "letter-spacing",
  "word-spacing",
  "line-height",
] as const;

/** Decode one CSS string, rejecting token lists, functions and alternative
 * text. Computed CSS content is CSS serialization, not a JSON string. */
export function contentString(value: string): string | null {
  if (!/^"(?:[^"\\\n\r]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\n\r]))*"$/.test(value)) {
    return null;
  }
  return value.slice(1, -1).replace(
    /\\([0-9a-fA-F]{1,6}\s?|.)/g,
    (_, escaped: string) => {
      if (!/^[0-9a-fA-F]/.test(escaped)) return escaped;
      const code = parseInt(escaped.trim(), 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(code);
    },
  );
}

export function readGeneratedText(
  style: CSSStyleDeclaration,
  parent: CSSStyleDeclaration,
  indexSpec: (style: CSSStyleDeclaration) => number,
): GeneratedText | string | null {
  if (
    style.display === "none" ||
    style.content === "none" ||
    style.content === "normal"
  ) {
    return null;
  }
  if (style.position === "absolute" || style.position === "fixed") {
    return "unsupported generated layout";
  }
  const text = contentString(style.content);
  if (text === null) return "unsupported generated content";
  if (
    style.display !== "inline" ||
    style.float !== "none" ||
    style.position !== "static" ||
    style.direction !== parent.direction ||
    style.writingMode !== "horizontal-tb" ||
    (style.unicodeBidi !== "normal" && style.unicodeBidi !== "isolate") ||
    style.verticalAlign !== "baseline" || style.textTransform !== "none" ||
    (style.whiteSpace !== "normal" && style.whiteSpace !== "nowrap") ||
    style.transform !== "none" ||
    ["scale", "rotate", "translate"].some((prop) => {
      const value = style.getPropertyValue(prop);
      return value !== "" && value !== "none";
    })
  ) return "unsupported generated layout";
  if (
    [style.marginLeft, style.marginRight].some((value) => (parseFloat(value) || 0) !== 0)
  ) {
    return "generated content has a horizontal margin";
  }
  const insetPx = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ]
    .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  if (text === "") return "empty generated box";
  // A single symbol or a Latin identifier has no internal line opportunity.
  // Whitespace, soft hyphens, CJK sequences and other contextual breaking
  // need actual content items rather than a fixed edge advance.
  if (
    !/^[\p{Script=Latin}\p{M}\p{N}_]+$/u.test(text) &&
    [...text].length !== 1
  ) {
    return "breakable generated content";
  }
  if (/^\p{M}/u.test(text)) return "contextual generated text";
  if (/[\s\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069]/u.test(text)) {
    return "breakable generated content";
  }
  return {
    text,
    spec: indexSpec(style),
    insetPx,
    style: GENERATED_STYLE_PROPERTIES.map((property) => style.getPropertyValue(property)),
  };
}
