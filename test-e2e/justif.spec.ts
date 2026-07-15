import { expect, type Page, test } from "@playwright/test";
import { kinsokuNotAtLineEnd, kinsokuNotAtLineStart } from "../src/core/cjk.js";

declare global {
  interface Window {
    __justif: {
      justify: (
        t: Iterable<Element> | Element,
        o?: object,
      ) => { ready: Promise<void>; refresh(): void; destroy(): void };
      unjustify: (t: Iterable<Element>) => void;
      hyphenateEnUS: (w: string) => string[];
      /** The hanging-punctuation protrusion table object. */
      hangingPunctuation: Readonly<Record<string, unknown>>;
      controller: { ready: Promise<void>; refresh(): void; destroy(): void } | null;
    };
    /**
     * Fixture-defined line reader (see fixture.html): reconstructs visual
     * lines from rendered word rects + .justif-hyphen rects. Each line's
     * `texts` are ordered by left position — rect tops carry sub-pixel
     * noise (WebKit reports a line's first word ~0.006px lower than its
     * siblings), so top order is not reading order. `contentRight` is the
     * true content edge (border-box right minus padding/border). Hyphen
     * entries appear in `texts` as "-".
     */
    __justifLines: (root: Element) => {
      contentRight: number;
      lines: Array<{ top: number; left: number; right: number; texts: string[] }>;
    };
    __ready: boolean;
    /** Nonstandard find-in-page (all three engines implement it). */
    find(
      needle: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrap?: boolean,
    ): boolean;
  }
}

async function openFixture(page: Page): Promise<void> {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);
}

async function enhance(page: Page, options: object, selector = "#host p"): Promise<void> {
  await page.evaluate(
    async ([opts, sel]) => {
      const j = window.__justif;
      j.controller?.destroy();
      j.controller = j.justify(document.querySelectorAll(sel as string), {
        ...(opts as object),
        hyphenate: (opts as { hyphenate?: boolean }).hyphenate ? j.hyphenateEnUS : undefined,
        protrusion:
          (opts as { protrusion?: unknown }).protrusion === "hanging"
            ? j.hangingPunctuation
            : (opts as { protrusion?: boolean }).protrusion,
      });
      await j.controller.ready;
    },
    [options, selector] as const,
  );
}

/**
 * Visual lines of the fixture paragraphs, reconstructed on the page by
 * window.__justifLines (defined in fixture.html — see its doc comment for
 * the sub-pixel-top / left-ordering lesson and the content-edge math).
 */
interface LineGeometry {
  paragraph: string;
  contentRight: number;
  lines: Array<{ right: number; text: string; last: boolean }>;
}

async function readGeometry(page: Page): Promise<LineGeometry[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#host p")].map((p) => {
      const g = window.__justifLines(p);
      return {
        paragraph: p.id,
        contentRight: g.contentRight,
        lines: g.lines.map((l, i) => ({
          right: l.right,
          text: l.texts.join(" "),
          last: i === g.lines.length - 1,
        })),
      };
    }),
  );
}

/**
 * Resolve once `selector`'s subtree has stopped mutating: its innerHTML is
 * unchanged across two samples ~120ms apart. The measured wrap-guarantee
 * corrections land in trailing rAF slices, promoted by IntersectionObservers
 * (deferred off the interactive path), so "settled" is a fact about the DOM,
 * not a fixed delay. Bounded: proceeds after ~2s even if the DOM never goes
 * quiet — the assertions that follow then judge whatever state it is in.
 */
async function waitForQuiescence(page: Page, selector = "#host"): Promise<void> {
  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return;
    // Two frames head start: lets already-queued observer/rAF slices begin,
    // so the first sample doesn't read a pre-correction DOM as "settled".
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const deadline = performance.now() + 2000;
    let prev = el.innerHTML;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const cur = el.innerHTML;
      if (cur === prev) return;
      prev = cur;
    }
  }, selector);
}

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test("enhances paragraphs into inline nowrap segments", async ({ page }) => {
  await enhance(page, { hyphenate: true });
  const segs = await page.locator(".justif-seg").count();
  expect(segs).toBeGreaterThan(10);
  // Inline flow: no block-level wrappers inside the paragraphs.
  const blocks = await page.evaluate(() =>
    [...document.querySelectorAll("#host p .justif-seg")].filter(
      (el) => getComputedStyle(el).display !== "inline",
    ).length,
  );
  expect(blocks).toBe(0);
});

test("justified lines end flush within 0.5px (no protrusion/expansion)", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false, expansion: false });
  const paragraphs = await readGeometry(page);
  expect(paragraphs.length).toBe(2);
  for (const para of paragraphs) {
    expect(para.lines.length).toBeGreaterThan(3);
    for (const line of para.lines) {
      if (line.last) continue;
      expect
        .soft(Math.abs(line.right - para.contentRight), `${para.paragraph}: "${line.text.slice(0, 40)}"`)
        .toBeLessThan(0.5);
    }
  }
});

test("bails to native rendering on inline elements with horizontal box extras", async ({ page }) => {
  const enhanced = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "padded";
    p.innerHTML =
      "Some prose with <code style=\"padding: 0 4px\">padded(code)</code> the model cannot measure, " +
      "repeated long enough that the paragraph would certainly wrap across several lines.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p);
    await ctl.ready;
    const took = p.hasAttribute("data-justif");
    ctl.destroy();
    p.remove();
    return took;
  });
  expect(enhanced).toBe(false);
});

test("tracking's letter-spacing does not cost ligatures", async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Georgia has no common ligatures; use Junicode (fi/ffi/ffl) so the
    // width comparison actually detects ligation.
    const face = new FontFace("Junicode", 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(await face.load());
    const p = document.createElement("p");
    p.style.fontFamily = "Junicode";
    p.textContent =
      "An afflicted official fills a difficult office efficiently, and the affliction " +
      "of officialdom fills every difficult office with efficient officials again.";
    document.getElementById("host")!.append(p);
    // expansion: false — a line set at font-stretch ≠ 100% would widen the
    // measured word relative to any 100%-stretch reference.
    const ctl = window.__justif.justify(p, { tracking: true, expansion: false, hyphenate: undefined });
    await ctl.ready;
    // Find a tracked segment containing an ffi word and measure the word.
    const seg = [...p.querySelectorAll<HTMLElement>(".justif-seg")].find(
      (el) => el.style.letterSpacing !== "" && /difficult|official|affliction|office/.test(el.textContent ?? ""),
    );
    let out: { ls: number; features: string; word: number; unligated: number } | null = null;
    if (seg) {
      const m = /difficult|official|affliction|office/.exec(seg.textContent ?? "")!;
      const range = document.createRange();
      const node = seg.firstChild as Text;
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const word = range.getBoundingClientRect().width;
      // Unligated reference measured in the DOM with the segment's own
      // letter-spacing. (A canvas with ctx.letterSpacing is NOT a portable
      // reference: Chromium's canvas drops ligatures under letter-spacing,
      // but Firefox's and WebKit's keep them.)
      const ref = document.createElement("span");
      ref.style.cssText =
        `position:absolute;left:-9999px;white-space:pre;font:17px Junicode;` +
        `letter-spacing:${seg.style.letterSpacing};font-variant-ligatures:none;`;
      ref.textContent = m[0];
      document.body.append(ref);
      const unligated = ref.getBoundingClientRect().width;
      ref.remove();
      out = { ls: parseFloat(seg.style.letterSpacing), features: seg.style.fontFeatureSettings, word, unligated };
    }
    ctl.destroy();
    p.remove();
    return out;
  });
  expect(r).not.toBeNull();
  expect(r!.features).toContain('"liga"'); // Chromium serializes `"liga" 1` → `"liga"`
  // Ligated rendering is narrower than the unligated canvas equivalent.
  expect(r!.word).toBeLessThan(r!.unligated - 0.1);
});

test("small-caps runs don't poison later measurements", async ({ page, browserName }) => {
  // Regression: Firefox's OffscreenCanvas 2D context kept SHAPING in
  // small-caps after fontVariantCaps was reset to "normal", inflating every
  // word measured after an smcp run by ~4-11% — lines then rendered ragged.
  const r = await page.evaluate(async () => {
    // Junicode has TRUE small caps (smcp), so canvas and DOM shape alike;
    // synthesized small caps are a separate concern this test avoids.
    const face = new FontFace("Junicode", 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(await face.load());
    const p = document.createElement("p");
    p.style.fontFamily = "Junicode";
    p.innerHTML =
      '<span style="font-variant-caps: small-caps">Chapter I.</span> Down the ' +
      "Rabbit-Hole, in which Alice follows a large white rabbit with pink eyes " +
      "down a very deep well and wonders how many miles she has fallen by this " +
      "time, for she is beginning to get very tired of considering everything.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, { expansion: false });
    await ctl.ready;
    const enhanced = p.hasAttribute("data-justif");
    let worst = 0;
    if (enhanced) {
      const g = window.__justifLines(p);
      for (const line of g.lines.slice(0, -1)) {
        worst = Math.max(worst, g.contentRight - line.right);
      }
    }
    ctl.destroy();
    p.remove();
    return { enhanced, worst };
  });
  if (browserName === "webkit") {
    // WebKit's canvas has no fontVariantCaps: the smcp paragraph correctly
    // bails to native rendering instead of guessing widths.
    expect(r.enhanced).toBe(false);
  } else {
    expect(r.enhanced).toBe(true);
    expect(r.worst).toBeLessThan(1.5);
  }
});

test("content-visibility paragraphs get corrected when scrolled into view", async ({ page }) => {
  // A far-below-viewport content-visibility:auto paragraph MAY be
  // layout-skipped at enhance time (headless engines differ, so this test
  // deliberately does not assert that skipping happens). What it verifies:
  // justif parks the measured wrap-guarantee correction for such a
  // paragraph, and the viewport observers promote and measure it as the
  // paragraph is approached — after scrolling it into view, the correction
  // has run and all non-last lines are flush.
  const enhanced = await page.evaluate(async () => {
    const spacer = document.createElement("div");
    spacer.id = "cv-spacer";
    spacer.style.height = "300vh";
    const p = document.createElement("p");
    p.id = "cv-far";
    p.style.cssText = "content-visibility:auto;contain-intrinsic-size:auto 8em;width:416px";
    p.textContent =
      "In olden times when wishing still helped one, there lived a king whose " +
      "daughters were all beautiful; and the youngest was so beautiful that the " +
      "sun itself, which has seen so much, was astonished whenever it shone in " +
      "her face, and the well was deep, so deep that the bottom could not be seen.";
    const host = document.getElementById("host")!;
    host.append(spacer, p);
    const j = window.__justif;
    j.controller?.destroy();
    j.controller = j.justify(p, { expansion: false });
    await j.controller.ready;
    p.scrollIntoView({ block: "center" });
    return p.hasAttribute("data-justif");
  });
  // Reveal → IntersectionObserver → correction slice: wait until the
  // paragraph's DOM stops mutating instead of sleeping a fixed 400ms.
  await waitForQuiescence(page, "#cv-far");
  const r = await page.evaluate(() => {
    const p = document.getElementById("cv-far")!;
    const g = window.__justifLines(p);
    let worst = 0;
    for (const line of g.lines.slice(0, -1)) {
      worst = Math.max(worst, g.contentRight - line.right);
    }
    window.__justif.controller!.destroy();
    window.__justif.controller = null;
    document.getElementById("cv-spacer")!.remove();
    p.remove();
    window.scrollTo(0, 0);
    return { rows: g.lines.length, worst };
  });
  expect(enhanced).toBe(true);
  expect(r.rows).toBeGreaterThan(2);
  // After reveal, non-last lines are flush (correction ran, pad removed).
  expect(r.worst).toBeLessThan(1.5);
});

test("bails on ligature/feature overrides canvas cannot reproduce", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const j = window.__justif;
    const out: boolean[] = [];
    for (const css of [
      "font-variant-ligatures: none",
      'font-feature-settings: "ss01"',
      "font-variant-numeric: oldstyle-nums",
    ]) {
      const p = document.createElement("p");
      p.setAttribute("style", css);
      p.textContent =
        "An afflicted official fills a difficult office efficiently, long enough to wrap.";
      document.getElementById("host")!.append(p);
      const ctl = j.justify(p);
      await ctl.ready;
      out.push(p.hasAttribute("data-justif"));
      ctl.destroy();
      p.remove();
    }
    return out;
  });
  expect(results).toEqual([false, false, false]);
});

test("letterfit tracking applies letter-spacing yet lines stay flush", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false, expansion: false, tracking: true });
  const paragraphs = await readGeometry(page);
  for (const para of paragraphs) {
    for (const line of para.lines) {
      if (line.last) continue;
      expect
        .soft(Math.abs(line.right - para.contentRight), `"${line.text.slice(0, 40)}"`)
        .toBeLessThan(0.5);
    }
  }
  // Stretched/shrunk lines carry per-segment letter-spacing; the ±3% budget
  // caps it at 3% of the average character advance (well under 0.5px here).
  const spacings = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".justif-seg")]
      .map((el) => parseFloat(el.style.letterSpacing))
      .filter((v) => !Number.isNaN(v) && v !== 0),
  );
  expect(spacings.length).toBeGreaterThan(0);
  for (const v of spacings) expect(Math.abs(v)).toBeLessThan(0.5);
});

test("protrusion hangs terminal punctuation past the margin", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: true, expansion: false });
  const paragraphs = await readGeometry(page);
  const punctuated = paragraphs
    .flatMap((p) => p.lines.map((l) => ({ ...l, contentRight: p.contentRight })))
    .filter((l) => !l.last && /[.,;:]$/.test(l.text.trim()));
  expect(punctuated.length).toBeGreaterThan(0);
  for (const line of punctuated) {
    const overhang = line.right - line.contentRight;
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeGreaterThan(0.5);
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeLessThan(10);
  }
});

test("hangingPunctuation preset hangs stops fully past the margin", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: "hanging", expansion: false });
  const paragraphs = await readGeometry(page);
  const advances = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = "17px Georgia, serif";
    return { ",": ctx.measureText(",").width, ".": ctx.measureText(".").width };
  });
  const punctuated = paragraphs
    .flatMap((p) => p.lines.map((l) => ({ ...l, contentRight: p.contentRight })))
    .filter((l) => !l.last && /[.,]$/.test(l.text.trim()));
  expect(punctuated.length).toBeGreaterThan(0);
  for (const line of punctuated) {
    const expected = advances[line.text.trim().slice(-1) as "," | "."];
    const overhang = line.right - line.contentRight;
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeGreaterThan(0.85 * expected);
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeLessThan(expected + 1.5);
  }
});

test("pseudo-hyphens sit after their word, never overlapping it", async ({ page }) => {
  // Narrow measure + no emergency stretch: pass 2 must hyphenate.
  await page.evaluate(() => {
    document.getElementById("host")!.style.width = "230px";
  });
  await enhance(page, { hyphenate: true, protrusion: true, expansion: false, emergencyStretch: 0 });
  const gaps = await page.evaluate(() => {
    const out: Array<{ tail: string; gap: number }> = [];
    for (const h of document.querySelectorAll(".justif-hyphen")) {
      const prev = h.previousSibling;
      if (prev === null) continue;
      const range = document.createRange();
      range.selectNodeContents(prev);
      out.push({
        tail: (prev.textContent ?? "").slice(-12),
        gap: h.getBoundingClientRect().x - range.getBoundingClientRect().right,
      });
    }
    return out;
  });
  expect(gaps.length).toBeGreaterThan(0);
  for (const { tail, gap } of gaps) {
    expect(gap, `hyphen after "${tail}"`).toBeGreaterThan(-0.1);
    expect(gap, `hyphen after "${tail}"`).toBeLessThan(1);
  }
});

test("hyphens render as pseudo-content; words stay whole for AT and find", async ({ page }) => {
  // Narrow measure + no emergency stretch: pass 2 must hyphenate.
  await page.evaluate(() => {
    document.getElementById("host")!.style.width = "230px";
  });
  await enhance(page, { hyphenate: true, emergencyStretch: 0 });
  const hyphens = await page.locator(".justif-hyphen").count();
  expect(hyphens).toBeGreaterThan(0);
  const hyphenTexts = await page.evaluate(() =>
    [...document.querySelectorAll(".justif-hyphen")].map((el) => el.textContent),
  );
  expect(hyphenTexts.every((t) => t === "")).toBe(true);
  // A hyphenated word is findable as one word across the break (<wbr>).
  const found = await page.evaluate(() => {
    const hyphen = document.querySelector(".justif-hyphen")!;
    // The hyphen's previous sibling is the .justif-seg SPAN holding the
    // word's head fragment (not a text node — use textContent).
    const head = (hyphen.previousSibling?.textContent ?? "").split(" ").at(-1) ?? "";
    // Reconstruct the full word from textContent (no hyphen pollutes it).
    // Anchor the head fragment at a word start — a short head like "as"
    // (from "as-tonished") would otherwise match inside an earlier word.
    const text = document.getElementById("p1")!.textContent ?? "";
    const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = new RegExp(`(?:^|\\s)(${escaped}\\S*)`).exec(text)?.[1];
    if (word === undefined || word.length < 4) {
      throw new Error(`failed to reconstruct hyphenated word from fragment "${head}" (got "${word}")`);
    }
    const r = window.find(word, false, false, false);
    getSelection()?.removeAllRanges();
    return { word, found: r };
  });
  expect(found.found, `word "${found.word}" findable across hyphen break`).toBe(true);
  const text = await page.evaluate(() => document.getElementById("p1")!.textContent);
  expect(text!.replace(/\s+/g, " ")).toContain("olden times when wishing still helped");
});

test("find-in-page matches phrases across line breaks", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false, expansion: false });
  const result = await page.evaluate(() => {
    // Build a cross-line phrase from rendered geometry: last word of line 1
    // + first word of line 2 of p1. __justifLines orders each line's texts
    // by left position (sub-pixel top noise makes top order unreliable);
    // "-" entries are pseudo-content hyphen glyphs — not document text, so
    // they can't take part in a find phrase.
    const { lines } = window.__justifLines(document.getElementById("p1")!);
    const lastOf1 = lines[0]!.texts.filter((t) => t !== "-").at(-1);
    const firstOf2 = lines[1]!.texts[0];
    const phrase = `${lastOf1} ${firstOf2}`;
    const found = window.find(phrase, false, false, false);
    getSelection()?.removeAllRanges();
    return { phrase, found };
  });
  expect(result.found, `phrase "${result.phrase}"`).toBe(true);
});

test("links wrap across lines as single elements with exact text", async ({ page }) => {
  await enhance(page, { hyphenate: true });
  const links = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("#p2 a")].map((a) => ({
      href: a.getAttribute("href"),
      id: a.id,
      text: a.textContent,
    })),
  );
  expect(links.length).toBe(2); // never cloned
  expect(links[0]).toEqual({
    href: "#target",
    id: "link1",
    text: "rolled straight into the water",
  });
  // Exact text: no adjacent prose spaces leak into the element (they would
  // extend the underline and the accessible name).
  expect(links[1]).toEqual({ href: "#well", id: "link2", text: "the deep well" });
});

test("selection across a line break copies a space, not a newline", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false });
  const copied = await page.evaluate(() => {
    const p = document.getElementById("p1")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const s = sel.toString();
    sel.removeAllRanges();
    return s;
  });
  expect(copied).not.toContain("\n");
  expect(copied.replace(/\s+/g, " ")).toContain("olden times when wishing still helped");
});

test("copy cleanup strips run-boundary NBSPs and word joiners", async ({ page }) => {
  await enhance(page, { hyphenate: true });
  const r = await page.evaluate(() => {
    const p = document.getElementById("p2")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // DOM truth, not sel.toString(): Firefox's toString folds NBSP to a
    // space, which would make this guard vacuous there.
    const raw = range.cloneContents().textContent ?? "";
    const e = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      cancelable: true,
    });
    document.dispatchEvent(e);
    sel.removeAllRanges();
    return {
      raw,
      prevented: e.defaultPrevented,
      plain: e.clipboardData!.getData("text/plain"),
      html: e.clipboardData!.getData("text/html"),
    };
  });
  // Guard against a vacuous pass: the p2 selection must actually carry a
  // run-boundary NBSP for the cleanup to remove (the <em> boundary).
  expect(r.raw).toContain("\u00A0");
  expect(r.prevented).toBe(true);
  expect(r.plain).not.toMatch(/[\u00A0\u2060]/);
  expect(r.html).not.toMatch(/[\u00A0\u2060]|&nbsp;/);
  expect(r.plain.replace(/\s+/g, " ")).toContain("princess's golden ball");
  expect(r.html).toContain("<em>");
});

test("author NBSPs survive copy cleanup", async ({ page }) => {
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "pnbsp";
    p.innerHTML =
      "See Fig.\u00A07 for the diagram of the <em>golden ball</em> mechanism, " +
      "which the youngest daughter threw up on high and caught while playing " +
      "beside the cool fountain in the great dark forest near the old castle.";
    document.getElementById("host")!.append(p);
  });
  await enhance(page, { hyphenate: true });
  const r = await page.evaluate(() => {
    const p = document.getElementById("pnbsp")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const e = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      cancelable: true,
    });
    document.dispatchEvent(e);
    sel.removeAllRanges();
    p.remove();
    return {
      prevented: e.defaultPrevented,
      plain: e.clipboardData!.getData("text/plain"),
    };
  });
  expect(r.prevented).toBe(true);
  // The author meant that NBSP ("Fig. 7" must not wrap) — cleanup leaves
  // this paragraph's NBSPs alone rather than guess which ones are ours.
  expect(r.plain).toContain("Fig.\u00A07");
  expect(r.plain).not.toContain("\u2060");
});

test("cleanClipboard: false leaves copies untouched", async ({ page }) => {
  await enhance(page, { hyphenate: true, cleanClipboard: false });
  const r = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p2")!);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const e = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      cancelable: true,
    });
    document.dispatchEvent(e);
    sel.removeAllRanges();
    return { prevented: e.defaultPrevented };
  });
  expect(r.prevented).toBe(false);
});

test("enhances under a strict Content-Security-Policy (no inline styles)", async ({ page }) => {
  // fixture-csp.html serves style-src 'self': an injected <style> element
  // is blocked, so the segment rules must arrive via adoptedStyleSheets.
  const cspViolations: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content-Security-Policy") || m.text().includes("Refused to apply")) {
      cspViolations.push(m.text());
    }
  });
  await page.goto("/test-e2e/fixture-csp.html");
  await page.waitForFunction(() => window.__ready === true);
  const r = await page.evaluate(async () => {
    const c = window.__justif.justify(document.querySelectorAll("#host p"));
    await c.ready;
    const seg = document.querySelector<HTMLElement>("#host .justif-seg");
    return {
      segs: document.querySelectorAll("#host .justif-seg").length,
      // The load-bearing assertion: the nowrap rule genuinely applies —
      // without it the line model silently collapses.
      whiteSpace: seg === null ? null : getComputedStyle(seg).whiteSpace,
      adopted: document.adoptedStyleSheets.length,
    };
  });
  expect(r.segs).toBeGreaterThan(0);
  expect(r.whiteSpace).toBe("nowrap");
  expect(r.adopted).toBeGreaterThan(0);
  expect(cspViolations).toEqual([]);
});

test("enhances paragraphs inside shadow DOM (rules reach the shadow root)", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.style.width = "440px";
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const p = document.createElement("p");
    p.style.cssText =
      "font-family: Georgia, serif; font-size: 17px; line-height: 1.45; text-align: justify; margin: 0;";
    p.textContent =
      "In olden times when wishing still helped one, there lived a king " +
      "whose daughters were all beautiful; and the youngest was so beautiful " +
      "that the sun itself, which has seen so much, was astonished whenever " +
      "it shone in her face.";
    root.append(p);
    // Flush is asserted, so no protrusion/expansion (hangs are legitimate
    // deviations), and the deferred wrap-guarantee corrections must settle:
    // poll until the paragraph's DOM is stable across two 120ms samples.
    const c = window.__justif.justify(p, { protrusion: false, expansion: false });
    await c.ready;
    let last = p.innerHTML;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const now = p.innerHTML;
      if (now === last) break;
      last = now;
    }
    const seg = p.querySelector(".justif-seg");
    const g = window.__justifLines(p);
    const out = {
      enhanced: p.hasAttribute("data-justif"),
      whiteSpace: seg === null ? null : getComputedStyle(seg).whiteSpace,
      adoptedOnRoot: root.adoptedStyleSheets.length,
      lines: g.lines.length,
      maxDev: Math.max(
        ...g.lines.slice(0, -1).map((l) => Math.abs(l.right - g.contentRight)),
      ),
    };
    c.destroy();
    host.remove();
    return out;
  });
  expect(r.enhanced).toBe(true);
  expect(r.whiteSpace).toBe("nowrap");
  expect(r.adoptedOnRoot).toBeGreaterThan(0);
  expect(r.lines).toBeGreaterThan(2);
  expect(r.maxDev).toBeLessThan(1);
});

test("destroy() restores the original DOM byte-identically", async ({ page }) => {
  const before = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  await enhance(page, { hyphenate: true });
  const enhanced = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  expect(enhanced).not.toBe(before);
  await page.evaluate(() => window.__justif.controller!.destroy());
  const after = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  expect(after).toBe(before);
});

test("justify() is idempotent and foreign controllers don't hijack state", async ({ page }) => {
  await enhance(page, { hyphenate: true });
  // The measured wrap-guarantee corrections land a few frames after ready
  // (deferred, viewport-promoted); wait for quiescence so both innerHTML
  // snapshots see the settled margins.
  await waitForQuiescence(page);
  const first = await page.locator(".justif-seg").count();
  const html = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  await page.evaluate(async () => {
    const j = window.__justif;
    const c = j.justify(document.querySelectorAll("#host p"), { lastLineMinWidth: 0.33 });
    await c.ready;
    c.destroy();
  });
  const second = await page.locator(".justif-seg").count();
  expect(second).toBe(first);
  const htmlAfter = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  expect(htmlAfter).toBe(html);
});

test("resize re-layouts through the ResizeObserver fast path", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false, expansion: false });
  const before = await readGeometry(page);
  await page.evaluate(() => {
    document.getElementById("host")!.style.width = "340px";
  });
  await page.waitForFunction(() => {
    // First visual line flush again = re-layout landed for the new width.
    const g = window.__justifLines(document.querySelector("#host p")!);
    const first = g.lines[0];
    return first !== undefined && Math.abs(first.right - g.contentRight) < 0.5;
  });
  const after = await readGeometry(page);
  expect(after).not.toEqual(before);
  for (const para of after) {
    for (const line of para.lines) {
      if (line.last) continue;
      expect
        .soft(Math.abs(line.right - para.contentRight), `${para.paragraph}: "${line.text.slice(0, 40)}"`)
        .toBeLessThan(0.5);
    }
  }
});

test("observeResize:false still runs the wrap-guarantee corrections", async ({ page }) => {
  // Regression: the viewport IntersectionObservers were registered only when
  // resize observation was on, so with observeResize: false every correction
  // parked forever — the initial enhancement flush ALWAYS parks (nearViewport
  // is empty until the observers deliver, which happens after ready), and
  // nothing ever promoted the parked entries.
  const provisional = await page.evaluate(async () => {
    const j = window.__justif;
    j.controller?.destroy();
    j.controller = j.justify(document.querySelectorAll("#host p"), {
      hyphenate: j.hyphenateEnUS,
      protrusion: false,
      expansion: false,
      observeResize: false,
    });
    await j.controller.ready;
    // Snapshot synchronously with ready: corrections are promoted by
    // IntersectionObserver tasks, which cannot precede this microtask.
    return document.getElementById("host")!.innerHTML;
  });
  await waitForQuiescence(page);
  // Corrections are visually inert (trailing layout-advance margins only),
  // so "they ran" is a DOM fact: the provisional −1.5px wrap-safety pads
  // were normalized to the measured 1px-spare state after ready.
  const settled = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  expect(settled).not.toBe(provisional);
  const paragraphs = await readGeometry(page);
  expect(paragraphs.length).toBe(2);
  for (const para of paragraphs) {
    expect(para.lines.length).toBeGreaterThan(3);
    for (const line of para.lines) {
      if (line.last) continue;
      expect
        .soft(Math.abs(line.right - para.contentRight), `${para.paragraph}: "${line.text.slice(0, 40)}"`)
        .toBeLessThan(0.5);
    }
  }
});

test("refresh() during queued corrections does not strand stale entries", async ({ page }) => {
  // Regression: a resize queues sliced patches whose corrections drain in
  // trailing rAF slices; refresh() re-patches every paragraph, detaching the
  // queued entries' segment DOM. Stale detached pendings used to survive the
  // re-patch, clobber the fresh entries, and re-park forever (detached nodes
  // measure all-zero rects, classifying as "hidden") — poisoning the
  // correction queue for every later resize.
  await enhance(page, { hyphenate: true, protrusion: false, expansion: false });
  await waitForQuiescence(page);
  await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const before = host.innerHTML;
    host.style.width = "340px";
    // Interpose refresh() in the rAF phase of the frame right AFTER the
    // resize patches land: their corrections are queued for that frame's
    // trailing slice, which runs after this callback (rAF callbacks fire in
    // registration order) — exactly the window the regression needed.
    await new Promise<void>((resolve) => {
      let frames = 0;
      const tick = (): void => {
        if (host.innerHTML !== before || ++frames > 60) {
          window.__justif.controller!.refresh();
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  });
  await waitForQuiescence(page);
  const expectFlush = async (): Promise<void> => {
    for (const para of await readGeometry(page)) {
      expect(para.lines.length).toBeGreaterThan(3);
      for (const line of para.lines) {
        if (line.last) continue;
        expect
          .soft(Math.abs(line.right - para.contentRight), `${para.paragraph}: "${line.text.slice(0, 40)}"`)
          .toBeLessThan(1.5);
      }
    }
  };
  await expectFlush();
  // A second resize must also settle flush: the queue was not poisoned by
  // detached-node entries left over from the interposed refresh.
  await page.evaluate(() => {
    document.getElementById("host")!.style.width = "300px";
  });
  await waitForQuiescence(page);
  await expectFlush();
});

test("text-indent paragraphs: indented first line, all lines flush", async ({ page }) => {
  // Regression: the wrap-guarantee corrections compared an indented first
  // line against the full paragraph measure — positive indents left first
  // lines unprotected, and negative ones were "corrected" by roughly the
  // indent amount, so the browser re-wrapped them mid-line.
  // Body-level paragraph (not #host): default 16px font, so 2em = 32px.
  const text =
    "the quick brown fox jumps over the lazy dog while the small grey cat " +
    "watches from the garden wall and the old man walks slowly down the long " +
    "dusty road toward the quiet village where the children play beside the " +
    "river under the tall green trees until the evening sun drops behind the " +
    "far hills and the fields grow dark and still and the last light fades " +
    "from the evening sky.";
  for (const c of [
    { name: "positive indent", style: "width:416px; text-indent: 2em", delta: 32 },
    // The classic hanging-indent idiom — padding-left gives the negative
    // indent room to start left of the other lines' edge.
    { name: "hanging indent", style: "width:416px; text-indent: -24px; padding-left: 24px", delta: -24 },
  ]) {
    await page.evaluate(
      async ([style, content]) => {
        const p = document.createElement("p");
        p.id = "indented";
        p.setAttribute("style", style!);
        p.textContent = content!;
        document.body.append(p);
        const j = window.__justif;
        j.controller?.destroy();
        j.controller = j.justify(p, { expansion: false });
        await j.controller.ready;
      },
      [c.style, text],
    );
    await waitForQuiescence(page, "#indented");
    const g = await page.evaluate(() => {
      const p = document.getElementById("indented")!;
      const lines = window.__justifLines(p);
      window.__justif.controller!.destroy();
      window.__justif.controller = null;
      p.remove();
      return lines;
    });
    expect(g.lines.length, c.name).toBeGreaterThan(3);
    const indent = g.lines[0]!.left - g.lines[1]!.left;
    expect(indent, `${c.name}: first line vs second line left`).toBeGreaterThan(c.delta - 2);
    expect(indent, `${c.name}: first line vs second line left`).toBeLessThan(c.delta + 2);
    for (const [i, line] of g.lines.entries()) {
      if (i === g.lines.length - 1) continue;
      expect
        .soft(Math.abs(line.right - g.contentRight), `${c.name}: line ${i} "${line.texts.slice(0, 5).join(" ")}"`)
        .toBeLessThan(1.5);
    }
  }
});

test("Japanese: multiple flush lines, bare <wbr> joints, space-free copies", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = document.getElementById("pja")!;
    const original = p.textContent!;
    const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
    await ctl.ready;
    const enhanced = p.hasAttribute("data-justif");
    const g = window.__justifLines(p);
    // Select the whole paragraph across every line break, as a copy would.
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const copied = sel.toString();
    sel.removeAllRanges();
    return {
      original,
      enhanced,
      copied,
      text: p.textContent!,
      wbrs: p.querySelectorAll("wbr").length,
      contentRight: g.contentRight,
      lines: g.lines.map((l) => ({ right: l.right, text: l.texts.join("") })),
    };
  });
  expect(r.enhanced).toBe(true);
  expect(r.lines.length).toBeGreaterThan(3);
  // Justified: every non-last line ends flush at the measure. Tolerance is
  // 1px (vs 0.5 for Latin): the inter-character flex renders as
  // letter-spacing, whose trailing increment engines apply differently.
  for (const [i, line] of r.lines.entries()) {
    if (i === r.lines.length - 1) continue;
    expect
      .soft(Math.abs(line.right - r.contentRight), `line ${i}: "${line.text.slice(0, 14)}"`)
      .toBeLessThan(1);
  }
  // Line joints are bare <wbr>s: the DOM text stays byte-identical to the
  // source — no space, NBSP, or hyphen injected between characters.
  expect(r.wbrs).toBeGreaterThan(0);
  expect(r.text).toBe(r.original);
  // Copies too: selection across the line breaks carries no whitespace.
  expect(r.copied).not.toMatch(/[ \u00A0\u2060\u2010-]/);
  expect(r.copied.replace(/\s+/g, "")).toBe(r.original);
});

test("Japanese: kinsoku characters never start or end a rendered line", async ({ page }) => {
  const lines = await page.evaluate(async () => {
    const p = document.getElementById("pja")!;
    const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
    await ctl.ready;
    return window.__justifLines(p).lines.map((l) => l.texts.join(""));
  });
  expect(lines.length).toBeGreaterThan(3);
  const notStart = new Set(kinsokuNotAtLineStart);
  const notEnd = new Set(kinsokuNotAtLineEnd);
  for (const line of lines) {
    const chars = [...line];
    expect(notStart.has(chars[0]!), `line starts with "${chars[0]}": "${line.slice(0, 14)}"`).toBe(false);
    expect(notEnd.has(chars[chars.length - 1]!), `line ends with "${chars[chars.length - 1]}"`).toBe(false);
  }
});

test("Japanese: destroy() restores the original DOM byte-identically", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const host = document.getElementById("ja-host")!;
    const before = host.innerHTML;
    const ctl = window.__justif.justify(document.getElementById("pja")!, {});
    await ctl.ready;
    const enhanced = host.innerHTML;
    ctl.destroy();
    return { before, enhanced, after: host.innerHTML };
  });
  expect(r.enhanced).not.toBe(r.before);
  expect(r.after).toBe(r.before);
});

test("resize keeps visible text scroll-anchored (no bounce)", async ({ page }) => {
  // Regression: viewport-first slicing lands off-screen patches frames
  // later, changing heights ABOVE the viewport — without per-slice scroll
  // anchoring the visible text bounced by 100+px moments after each width
  // change. (Native browser anchoring can't help: patches replace the
  // anchor node's contents.)
  await page.evaluate(() => {
    // ~40 paragraphs = several viewports tall.
    const host = document.getElementById("host")!;
    const originals = [...host.querySelectorAll("p")];
    for (let i = 0; i < 19; i++) {
      for (const p of originals) {
        const clone = p.cloneNode(true) as HTMLElement;
        clone.removeAttribute("id");
        for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
        host.append(clone);
      }
    }
  });
  await enhance(page, { hyphenate: true });
  await page.evaluate(() =>
    window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) / 2),
  );
  // Scrolling promotes parked far-paragraph corrections; let them settle.
  await waitForQuiescence(page);
  const r = await page.evaluate(async () => {
    // The user-tracked element: first paragraph whose TOP is inside the
    // viewport (the same rule the library's slice anchoring uses).
    const anchor = [...document.querySelectorAll<HTMLElement>("#host p")].find((p) => {
      const top = p.getBoundingClientRect().top;
      return top >= 0 && top < window.innerHeight;
    });
    if (anchor === undefined) throw new Error("no paragraph top inside the viewport");
    const initialTop = anchor.getBoundingClientRect().top;
    const scrolled = window.scrollY;
    document.getElementById("host")!.style.width = "340px";
    let worst = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 800) {
      await new Promise((res) => setTimeout(res, 50));
      worst = Math.max(worst, Math.abs(anchor.getBoundingClientRect().top - initialTop));
    }
    return { scrolled, worst };
  });
  expect(r.scrolled, "test precondition: mid-document scroll position").toBeGreaterThan(1000);
  // A line-height-ish bound: the uncompensated bug produced 100+px jumps.
  expect(r.worst).toBeLessThan(30);
  // Fresh page per test, but leave the fixture as found anyway.
  await page.evaluate(() => {
    document.getElementById("host")!.style.width = "";
    window.scrollTo(0, 0);
  });
});

// ---------------------------------------------------------------------------
// RTL (pure-RTL paragraphs only; mixed bidi bails to native)
// ---------------------------------------------------------------------------

/** Line geometry of one #rtl-host paragraph, plus its LEFT content edge
 * (__justifLines exposes the right edge; RTL lines END at the left). */
async function readRtlGeometry(page: Page, id: string) {
  return page.evaluate((pid) => {
    const p = document.getElementById(pid)!;
    const cs = getComputedStyle(p);
    const contentLeft =
      p.getBoundingClientRect().left +
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.borderLeftWidth);
    const g = window.__justifLines(p);
    return {
      enhanced: p.hasAttribute("data-justif"),
      contentLeft,
      contentRight: g.contentRight,
      lines: g.lines,
    };
  }, id);
}

test("RTL paragraphs justify with lines flush at both edges", async ({ page }) => {
  // hyphenate passed on purpose: it must be ignored for RTL paragraphs.
  await enhance(
    page,
    { hyphenate: true, protrusion: false, expansion: false },
    "#rtl-host p",
  );
  for (const id of ["rtl-he", "rtl-ar"]) {
    const g = await readRtlGeometry(page, id);
    expect(g.enhanced, id).toBe(true);
    expect(g.lines.length, id).toBeGreaterThan(3);
    for (const [i, line] of g.lines.entries()) {
      const label = `${id} line ${i} "${line.texts.slice(-4).join(" ")}"`;
      // A line STARTS at the right edge in RTL: every line (including the
      // ragged last) sets out flush against the right content edge.
      expect.soft(Math.abs(line.right - g.contentRight), `${label} (start/right)`).toBeLessThan(1);
      // A line ENDS at the left edge: flush on all but the last line.
      if (i === g.lines.length - 1) continue;
      expect.soft(Math.abs(line.left - g.contentLeft), `${label} (end/left)`).toBeLessThan(1);
    }
    // No hyphenation artifacts whatsoever.
    expect(await page.locator(`#${id} .justif-hyphen`).count(), id).toBe(0);
  }
  // Visual order is RTL: the paragraph's first word renders at the first
  // line's RIGHT edge (texts are ordered by left position, so it is last).
  const he = await readRtlGeometry(page, "rtl-he");
  expect(he.lines[0]!.texts.at(-1)).toBe("בראשית");
});

test("expansion self-disables on RTL fallback glyphs (script-aware calibration)", async ({ page }) => {
  // #rtl-vf's primary font is Junicode — a wdth-variable Latin font with
  // no Hebrew glyphs, so the text renders in a fallback that ignores
  // font-stretch. Latin-calibrated expansion would make every expanded
  // line ragged by the expansion delta; script-aware calibration must
  // measure ~zero response on the Hebrew sample and disable expansion
  // for these runs (regression: found on the demo's RTL sample, ±2.6px
  // raggedness at the line end with expansion on).
  await page.evaluate(async () => {
    await document.fonts.load("17px Junicode");
    await document.fonts.ready;
  });
  await enhance(page, { protrusion: false }, "#rtl-vf p"); // expansion: library default (ON)
  const g = await readRtlGeometry(page, "rtl-vf-he");
  expect(g.enhanced).toBe(true);
  expect(g.lines.length).toBeGreaterThan(3);
  for (const [i, line] of g.lines.entries()) {
    expect.soft(Math.abs(line.right - g.contentRight), `line ${i} start`).toBeLessThan(1);
    if (i < g.lines.length - 1) {
      expect.soft(Math.abs(line.left - g.contentLeft), `line ${i} end`).toBeLessThan(1);
    }
  }
  // The sharp assertion: no segment carries font-stretch at all.
  const stretched = await page.evaluate(
    () =>
      [...document.querySelectorAll("#rtl-vf .justif-seg")].filter(
        (s) => (s as HTMLElement).style.fontStretch !== "",
      ).length,
  );
  expect(stretched).toBe(0);
});

test("RTL protrusion hangs line-end punctuation past the LEFT edge", async ({ page }) => {
  // Full hangs make the check unambiguous (~a full comma advance).
  await enhance(page, { protrusion: "hanging", expansion: false }, "#rtl-host p");
  const punctuated: Array<{ label: string; overhang: number }> = [];
  for (const id of ["rtl-he", "rtl-ar"]) {
    const g = await readRtlGeometry(page, id);
    for (const [i, line] of g.lines.entries()) {
      if (i === g.lines.length - 1) continue;
      // texts are left-ordered, so texts[0] is the line's LAST (logical)
      // word; its trailing stop renders at the line's left end.
      if (!/[.,،؛]$/.test(line.texts[0] ?? "")) continue;
      punctuated.push({
        label: `${id} line ${i} "${line.texts[0]}"`,
        overhang: g.contentLeft - line.left,
      });
    }
  }
  // Both fixtures are stop-dense; across two paragraphs at least one
  // non-last line ends on punctuation in every engine's break pattern.
  expect(punctuated.length).toBeGreaterThan(0);
  for (const { label, overhang } of punctuated) {
    expect(overhang, label).toBeGreaterThan(0.5);
    expect(overhang, label).toBeLessThan(10);
  }
});

test("mixed-direction paragraphs bail to native rendering", async ({ page }) => {
  await enhance(page, { protrusion: false }, "#rtl-host p");
  // Hebrew + English in one dir="rtl" paragraph: untouched.
  const mixed = await page.evaluate(() => {
    const p = document.getElementById("rtl-mixed")!;
    return {
      enhanced: p.hasAttribute("data-justif"),
      segs: p.querySelectorAll(".justif-seg").length,
    };
  });
  expect(mixed.enhanced).toBe(false);
  expect(mixed.segs).toBe(0);
  // The two pure-RTL siblings enhanced under the same controller.
  expect(await page.locator("#rtl-he .justif-seg").count()).toBeGreaterThan(0);
  // And the converse: an LTR paragraph containing strong-RTL characters
  // also bails (explicitly — not by silent measurement mismatch).
  const ltr = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.textContent =
      "An English paragraph that quotes שלום עולם inline must keep native " +
      "rendering, because bidi reordering is out of scope for the enhancer, " +
      "however long the text runs on and wraps across its lines.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p);
    await ctl.ready;
    const took = p.hasAttribute("data-justif");
    ctl.destroy();
    p.remove();
    return took;
  });
  expect(ltr).toBe(false);
});

test("destroy() restores RTL paragraphs byte-identically", async ({ page }) => {
  const before = await page.evaluate(() => document.getElementById("rtl-host")!.innerHTML);
  await enhance(page, { hyphenate: true }, "#rtl-host p");
  await waitForQuiescence(page, "#rtl-host");
  const enhanced = await page.evaluate(() => document.getElementById("rtl-host")!.innerHTML);
  expect(enhanced).not.toBe(before);
  await page.evaluate(() => window.__justif.controller!.destroy());
  const after = await page.evaluate(() => document.getElementById("rtl-host")!.innerHTML);
  expect(after).toBe(before);
});

test("canvas measureText advances are direction-independent (cache-key guard)", async ({ page }) => {
  // measure.ts deliberately keeps `direction` OUT of the width-cache key:
  // words are measured whole, so joining/reordering stay internal to the
  // string. This guards that assumption in every engine — if it ever
  // fails, direction must join FontSpec.key.
  const diffs = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = "17px Georgia, serif";
    const words = ["בראשית", "וּבְרָכָה", "העולם.", "السلام", "العربية،", "مرحبا", "ב12", "١٢٣", "(שלום)"];
    const out: Array<{ word: string; ltr: number; rtl: number }> = [];
    for (const word of words) {
      ctx.direction = "ltr";
      const ltr = ctx.measureText(word).width;
      ctx.direction = "rtl";
      const rtl = ctx.measureText(word).width;
      if (Math.abs(ltr - rtl) > 1e-6) out.push({ word, ltr, rtl });
    }
    return out;
  });
  expect(diffs).toEqual([]);
});
