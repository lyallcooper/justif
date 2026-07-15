/**
 * Frank Liang's pattern-based hyphenation (as in TeX), data-agnostic.
 * Patterns compile lazily into a trie on first use, so importing a language
 * module costs nothing until a paragraph actually hyphenates.
 */

export interface PatternData {
  /** Space-separated TeX patterns, e.g. ".ach4 .ad4der 4ab. …". */
  patterns: string;
  /** Space-separated exception words with hyphens at the break points. */
  exceptions?: string;
  /** Minimum letters before the first / after the last break. */
  leftmin?: number;
  rightmin?: number;
}

interface TrieNode {
  children: Map<string, TrieNode> | null;
  /** Inter-letter digit values for a pattern ending at this node. */
  points: number[] | null;
}

export function createHyphenator(data: PatternData): (word: string) => string[] {
  const leftmin = data.leftmin ?? 2;
  const rightmin = data.rightmin ?? 3;
  let root: TrieNode | null = null;
  let exceptionMap: Map<string, string[]> | null = null;

  function compile(): void {
    root = { children: new Map(), points: null };
    for (const pattern of data.patterns.split(/\s+/)) {
      if (pattern.length === 0) continue;
      const chars: string[] = [];
      const points: number[] = [0];
      for (const ch of pattern) {
        if (ch >= "0" && ch <= "9") points[points.length - 1] = ch.charCodeAt(0) - 48;
        else {
          chars.push(ch);
          points.push(0);
        }
      }
      let node = root;
      for (const ch of chars) {
        node.children ??= new Map();
        let next = node.children.get(ch);
        if (next === undefined) {
          next = { children: null, points: null };
          node.children.set(ch, next);
        }
        node = next;
      }
      node.points = points;
    }
    exceptionMap = new Map();
    if (data.exceptions !== undefined) {
      for (const exception of data.exceptions.split(/\s+/)) {
        if (exception.length === 0) continue;
        exceptionMap.set(exception.replace(/-/g, ""), exception.split("-"));
      }
    }
  }

  return function hyphenate(word: string): string[] {
    if (word.length < leftmin + rightmin) return [word];
    if (root === null) compile();
    const exception = exceptionMap!.get(word);
    if (exception !== undefined) return exception.slice();

    const w = "." + word + ".";
    const n = w.length;
    // points[g] is the accumulated digit for the gap before w[g].
    const points = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let node: TrieNode | null | undefined = root;
      for (let j = i; j < n; j++) {
        node = node!.children?.get(w[j]!);
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
