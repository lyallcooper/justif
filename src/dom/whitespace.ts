/**
 * The renderer normalizes collapsible source whitespace to U+0020. Author
 * no-break spaces (U+00A0/U+202F) remain box text and must never be trimmed
 * by DOM correction code merely because ECMAScript's trim methods classify
 * them as White_Space.
 */
export function leadingCollapsibleSpaces(text: string): number {
  let count = 0;
  while (count < text.length && text.charCodeAt(count) === 0x20) count++;
  return count;
}

export function trailingCollapsibleSpaces(text: string): number {
  let count = 0;
  while (count < text.length && text.charCodeAt(text.length - count - 1) === 0x20) count++;
  return count;
}

export function endWithoutCollapsibleSpaces(text: string): number {
  return text.length - trailingCollapsibleSpaces(text);
}
