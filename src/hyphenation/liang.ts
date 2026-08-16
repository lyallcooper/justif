/**
 * Frank Liang's pattern-based hyphenation (as in TeX), data-agnostic.
 * Patterns compile lazily into a trie on first use, so importing a language
 * module costs nothing until a paragraph actually hyphenates.
 */

export interface PatternData {
  /**
   * Space-separated TeX patterns, e.g. ".ach4 .ad4der 4ab. …".
   * Supply either this or `packed`; `packed` wins if both are present.
   */
  patterns?: string;
  /**
   * The same patterns, sorted and front-coded: tokens are separated by one
   * space, and each starts with a character giving how many leading
   * characters the pattern shares with its predecessor (that count added to
   * `"0"`, capped at 31), followed by the rest of the pattern. Sorting makes
   * those shared prefixes long, so this form is about a third smaller than
   * `patterns` once compressed. The bundled language modules use it; it is
   * otherwise interchangeable, and `tools/gen-hyphenation.mjs` produces it.
   */
  packed?: string;
  /** Space-separated exception words with hyphens at the break points. */
  exceptions?: string;
  /** Minimum letters before the first / after the last break. */
  leftmin?: number;
  rightmin?: number;
}

interface TrieNode {
  /**
   * Keyed by character code rather than a one-character string: the match
   * loop below probes one transition per (start, length) pair, and a numeric
   * key avoids materializing (and hashing) a substring on every probe.
   */
  children: Map<number, TrieNode> | null;
  /** Inter-letter digit values (0-9) for a pattern ending at this node. */
  points: Uint8Array | null;
}

/** Character code of the "." word-boundary sentinel. */
const DOT = 46;

export function createHyphenator(data: PatternData): (word: string) => string[] {
  const leftmin = data.leftmin ?? 2;
  const rightmin = data.rightmin ?? 3;
  let root: TrieNode | null = null;
  let exceptionMap: Map<string, string[]> | null = null;

  function add(pattern: string): void {
    const codes: number[] = [];
    const points: number[] = [0];
    for (const ch of pattern) {
      if (ch >= "0" && ch <= "9") points[points.length - 1] = ch.charCodeAt(0) - 48;
      else {
        codes.push(ch.codePointAt(0)!);
        points.push(0);
      }
    }
    let node = root!;
    for (const code of codes) {
      node.children ??= new Map();
      let next = node.children.get(code);
      if (next === undefined) {
        next = { children: null, points: null };
        node.children.set(code, next);
      }
      node = next;
    }
    node.points = Uint8Array.from(points);
  }

  function compile(): void {
    root = { children: new Map(), points: null };
    if (data.packed !== undefined) {
      // Rebuild each pattern from the tail the token carries plus the number
      // of leading characters it reuses from its predecessor. The patterns
      // arrive sorted rather than in their original order, which the trie
      // does not care about: it holds a set, one point vector per pattern.
      let previous = "";
      for (const token of data.packed.split(" ")) {
        if (token.length === 0) continue;
        previous = previous.slice(0, token.charCodeAt(0) - 48) + token.slice(1);
        add(previous);
      }
    } else if (data.patterns !== undefined) {
      for (const pattern of data.patterns.split(/\s+/)) {
        if (pattern.length !== 0) add(pattern);
      }
    }
    exceptionMap = new Map();
    if (data.exceptions !== undefined) {
      for (const exception of data.exceptions.split(/\s+/)) {
        if (exception.length === 0) continue;
        exceptionMap.set(exception.replace(/-/g, ""), exception.split("-"));
      }
    }
  }

  // Gap accumulator, reused across calls instead of allocated fresh per word;
  // only the prefix the current word needs is cleared before each use.
  let points = new Uint8Array(64);

  return function hyphenate(word: string): string[] {
    if (word.length < leftmin + rightmin) return [word];
    if (root === null) compile();
    const exception = exceptionMap!.get(word);
    if (exception !== undefined) return exception.slice();

    // Walk ".word." without materializing the sentinel string: index j
    // addresses the sentinels at j===0 and j===n-1, and word[j-1] between.
    const n = word.length + 2;
    // points[g] is the accumulated digit for the gap before dotted index g.
    if (points.length < n + 1) points = new Uint8Array(2 * (n + 1));
    else points.fill(0, 0, n + 1);
    for (let i = 0; i < n; i++) {
      let node: TrieNode | null | undefined = root;
      for (let j = i; j < n; j++) {
        const code = j === 0 || j === n - 1 ? DOT : word.charCodeAt(j - 1);
        node = node!.children?.get(code);
        if (node === undefined) break;
        const pts = node.points;
        if (pts !== null) {
          for (let k = 0; k < pts.length; k++) {
            if (pts[k]! > points[i + k]!) points[i + k] = pts[k]!;
          }
        }
      }
    }

    // Break before word[c] when the gap value is odd (gap c+1 in w-space).
    const pieces: string[] = [];
    let startC = 0;
    for (let c = leftmin; c <= word.length - rightmin; c++) {
      if (points[c + 1]! % 2 === 1) {
        pieces.push(word.slice(startC, c));
        startC = c;
      }
    }
    pieces.push(word.slice(startC));
    return pieces;
  };
}
