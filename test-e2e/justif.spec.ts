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

test("lastLineMinWidth: 1 justifies paragraph endings flush (rectangular paragraphs)", async ({ page }) => {
  // Control: with the option explicitly OFF (it defaults to 0.33 now) at
  // least one fixture ending must be genuinely short, or the flush
  // assertions below would pass vacuously.
  await enhance(page, {
    hyphenate: true,
    protrusion: false,
    expansion: false,
    lastLineMinWidth: 0,
  });
  const before = await readGeometry(page);
  const shortEndings = before.filter(
    (p) => p.contentRight - p.lines[p.lines.length - 1]!.right > 20,
  );
  expect(shortEndings.length).toBeGreaterThan(0);

  // A roomier stretch pool keeps the floor REACHABLE for these endings:
  // the render floor is capped at TeX's underfull threshold (~2.15× the
  // glue's stretch), and at default spacing the fixture endings stop just
  // short of flush at that bound (the cap mechanics are unit-tested
  // symbolically; this test proves the flush rendering end to end).
  await enhance(page, {
    hyphenate: true,
    protrusion: false,
    expansion: false,
    lastLineMinWidth: 1,
    spacing: { stretch: 1, shrink: 1 / 3 },
  });
  await waitForQuiescence(page);
  const after = await readGeometry(page);
  expect(after.length).toBe(2);
  for (const para of after) {
    for (const line of para.lines) {
      expect
        .soft(Math.abs(line.right - para.contentRight), `${para.paragraph}: "${line.text.slice(0, 40)}"`)
        .toBeLessThan(0.5);
    }
  }
});

test("one-line elements stay native unless full-width justification is requested and reachable", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const text = "If you ever feel stuck…";
    const make = (id: string, extraWidth: number, justifyAll = false) => {
      const p = document.createElement("p");
      p.id = id;
      p.textContent = text;
      p.style.cssText = "width: 1000px; text-align: justify;";
      host.append(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      const natural = range.getBoundingClientRect().width;
      p.style.width = `${natural + extraWidth}px`;
      // Applying this before the natural-width read would make the native
      // browser justify the probe line to its temporary 1000px measure.
      if (justifyAll) p.style.textAlignLast = "justify";
      return p;
    };

    // All four fit naturally on one line. Five extra pixels are reachable
    // from their word-space pool; 100px deliberately is not.
    const ordinary = make("single-ordinary", 5);
    const rectangular = make("single-rectangle", 5);
    const nearRectangle = make("single-near-rectangle", 5);
    const unreachable = make("single-unreachable", 100);
    const justifyAll = make("single-justify-all", 5, true);
    const ordinaryBefore = ordinary.outerHTML;
    const nearBefore = nearRectangle.outerHTML;
    const unreachableBefore = unreachable.outerHTML;
    const opts = {
      protrusion: false,
      expansion: false,
      tracking: false,
      spacing: { stretch: 1, shrink: 1 / 3 },
    };
    const controllers = [
      window.__justif.justify(ordinary, opts),
      window.__justif.justify(rectangular, { ...opts, lastLineMinWidth: 1 }),
      window.__justif.justify(nearRectangle, { ...opts, lastLineMinWidth: 0.99 }),
      window.__justif.justify(unreachable, { ...opts, lastLineMinWidth: 1 }),
      window.__justif.justify(justifyAll, opts),
    ];
    await Promise.all(controllers.map((c) => c.ready));

    const out = {
      ordinaryNative: !ordinary.hasAttribute("data-justif"),
      ordinaryUntouched: ordinary.outerHTML === ordinaryBefore,
      rectangularEnhanced: rectangular.hasAttribute("data-justif"),
      rectangularLines: rectangular.querySelectorAll(":scope > .justif-seg").length,
      nearRectangleNative: !nearRectangle.hasAttribute("data-justif"),
      nearRectangleUntouched: nearRectangle.outerHTML === nearBefore,
      unreachableNative: !unreachable.hasAttribute("data-justif"),
      unreachableUntouched: unreachable.outerHTML === unreachableBefore,
      justifyAllEnhanced: justifyAll.hasAttribute("data-justif"),
      justifyAllLines: justifyAll.querySelectorAll(":scope > .justif-seg").length,
    };
    for (const controller of controllers) controller.destroy();
    for (const p of [ordinary, rectangular, nearRectangle, unreachable, justifyAll]) p.remove();
    return out;
  });

  expect(result).toEqual({
    ordinaryNative: true,
    ordinaryUntouched: true,
    rectangularEnhanced: true,
    rectangularLines: 1,
    nearRectangleNative: true,
    nearRectangleUntouched: true,
    unreachableNative: true,
    unreachableUntouched: true,
    justifyAllEnhanced: true,
    justifyAllLines: 1,
  });
});

test("one-line native elements promote and demote as their measure changes", async ({ page }) => {
  const initial = await page.evaluate(async () => {
    const wrapper = document.createElement("div");
    wrapper.style.width = "1000px";
    const p = document.createElement("p");
    p.id = "responsive-single-line";
    p.style.textAlign = "justify";
    p.innerHTML =
      "A responsive paragraph stays native while it fits, then uses total-fit breaking " +
      "at a narrow measure.";
    wrapper.append(p);
    document.getElementById("host")!.append(wrapper);
    const before = { html: p.innerHTML, style: p.getAttribute("style") };
    let relayouts = 0;
    const controller = window.__justif.justify(p, {
      protrusion: false,
      expansion: false,
      onRelayout: () => relayouts++,
    });
    await controller.ready;
    Object.assign(window, { __singleLineCase: { wrapper, p, controller, before, relayouts: () => relayouts } });
    return {
      enhanced: p.hasAttribute("data-justif"),
      html: p.innerHTML,
      style: p.getAttribute("style"),
      before,
      relayouts,
    };
  });
  expect(initial.enhanced).toBe(false);
  expect({ html: initial.html, style: initial.style }).toEqual(initial.before);
  expect(initial.relayouts).toBe(0);

  await page.evaluate(() => {
    const c = (window as unknown as { __singleLineCase: { wrapper: HTMLElement } }).__singleLineCase;
    c.wrapper.style.width = "230px";
  });
  await page.waitForFunction(() =>
    document.getElementById("responsive-single-line")!.hasAttribute("data-justif"),
  );
  const narrow = await page.evaluate(() => {
    const p = document.getElementById("responsive-single-line")!;
    return {
      lines: window.__justifLines(p).lines.length,
      relayouts: (
        window as unknown as { __singleLineCase: { relayouts(): number } }
      ).__singleLineCase.relayouts(),
    };
  });
  expect(narrow.lines).toBeGreaterThan(1);
  expect(narrow.relayouts).toBe(1);

  await page.evaluate(() => {
    const c = (window as unknown as { __singleLineCase: { wrapper: HTMLElement } }).__singleLineCase;
    c.wrapper.style.width = "1000px";
  });
  await page.waitForFunction(
    () => !document.getElementById("responsive-single-line")!.hasAttribute("data-justif"),
  );
  const wideAgain = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __singleLineCase: {
          wrapper: HTMLElement;
          p: HTMLElement;
          controller: { destroy(): void };
          before: { html: string; style: string | null };
          relayouts(): number;
        };
      }
    ).__singleLineCase;
    const out = {
      html: c.p.innerHTML,
      style: c.p.getAttribute("style"),
      before: c.before,
      relayouts: c.relayouts(),
    };
    c.controller.destroy();
    c.wrapper.remove();
    return out;
  });
  expect({ html: wideAgain.html, style: wideAgain.style }).toEqual(wideAgain.before);
  expect(wideAgain.relayouts).toBe(2);
});

test("lastLineMinWidth never renders a shorter ending than OFF (real-text sweep)", async ({ page }) => {
  // Regression for the bounded-fallback plateau inversion: capped ending
  // costs tie, and before the compare-and-pick fallback the tie resolved
  // against a different candidate set than OFF's, sometimes choosing
  // strictly shorter endings (found by review at exactly these widths —
  // mock-measure unit sweeps never reproduced it, real fonts required).
  const results = await page.evaluate(async () => {
    const text = document.querySelectorAll("#host p")[1]!.textContent!;
    const host = document.getElementById("host")!;
    const endingWidth = async (widthPx: number, opts: object) => {
      const p = document.createElement("p");
      p.textContent = text;
      p.style.cssText = `width: ${widthPx}px; text-align: justify;`;
      host.append(p);
      const ctl = window.__justif.justify(p, {
        hyphenate: window.__justif.hyphenateEnUS,
        protrusion: false,
        expansion: false,
        ...opts,
      });
      await ctl.ready;
      const g = window.__justifLines(p);
      const last = g.lines[g.lines.length - 1]!;
      const w = last.right - last.left;
      ctl.destroy();
      p.remove();
      return w;
    };
    const out: Array<{ label: string; off: number; on: number }> = [];
    for (const { w, tracking } of [
      { w: 340, tracking: true },
      { w: 460, tracking: false },
      { w: 520, tracking: false },
    ]) {
      for (const v of [0.5, 0.75, 1]) {
        // Explicit 0: the option now DEFAULTS to 0.33, so an empty options
        // object is not an off baseline.
        const off = await endingWidth(w, { tracking, lastLineMinWidth: 0 });
        const on = await endingWidth(w, { tracking, lastLineMinWidth: v });
        out.push({ label: `w=${w} tracking=${tracking} v=${v}`, off, on });
      }
    }
    return out;
  });
  for (const { label, off, on } of results) {
    expect.soft(on, label).toBeGreaterThanOrEqual(off - 0.5);
  }
});

test("models inline padding (enhances); still bails on margins and box-decoration-break: clone", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const attempt = async (style: string) => {
      const p = document.createElement("p");
      p.innerHTML =
        `Some prose with <code style="${style}">padded(code)</code> in the model, ` +
        "repeated long enough that the paragraph would certainly wrap across several lines.";
      document.getElementById("host")!.append(p);
      const ctl = window.__justif.justify(p);
      await ctl.ready;
      const took = p.hasAttribute("data-justif");
      ctl.destroy();
      p.remove();
      return took;
    };
    return {
      padding: await attempt("padding: 0 4px"),
      border: await attempt("border: 1px solid"),
      margin: await attempt("margin: 0 4px"),
      clone: await attempt(
        "padding: 0 4px; box-decoration-break: clone; -webkit-box-decoration-break: clone",
      ),
    };
  });
  expect(results.padding).toBe(true);
  expect(results.border).toBe(true);
  expect(results.margin).toBe(false);
  expect(results.clone).toBe(false);
});

test("onSkip reports one reason per declined paragraph", async ({ page }) => {
  const reasons = await page.evaluate(async () => {
    const cases: Array<[string, () => HTMLElement]> = [
      [
        "margin",
        () => {
          const p = document.createElement("p");
          p.innerHTML = 'Text with a <code style="margin: 0 4px">chip</code> that has margins.';
          return p;
        },
      ],
      [
        "transform",
        () => {
          const p = document.createElement("p");
          p.style.textTransform = "uppercase";
          p.textContent = "Transformed paragraph text renders different glyphs.";
          return p;
        },
      ],
      [
        "stretch",
        () => {
          const p = document.createElement("p");
          p.style.fontStretch = "75%";
          p.textContent = "A condensed paragraph is outside the expansion model.";
          return p;
        },
      ],
      [
        "br",
        () => {
          const p = document.createElement("p");
          p.innerHTML = "Line one<br>line two.";
          return p;
        },
      ],
      [
        "fine",
        () => {
          const p = document.createElement("p");
          p.textContent = "A perfectly ordinary paragraph of justified prose.";
          return p;
        },
      ],
    ];
    const host = document.getElementById("host")!;
    const byId = new Map<string, HTMLElement>();
    for (const [id, make] of cases) {
      const el = make();
      el.style.width = "300px";
      host.append(el);
      byId.set(id, el);
    }
    const skips: Record<string, string> = {};
    const ctl = window.__justif.justify([...byId.values()], {
      onSkip: (el: HTMLElement, reason: string) => {
        for (const [id, candidate] of byId) if (candidate === el) skips[id] = reason;
      },
    } as object);
    await ctl.ready;
    const enhancedFine = byId.get("fine")!.hasAttribute("data-justif");
    ctl.destroy();
    for (const el of byId.values()) el.remove();
    return { skips, enhancedFine };
  });
  expect(reasons.enhancedFine).toBe(true);
  expect(reasons.skips["fine"]).toBeUndefined();
  expect(reasons.skips["margin"]).toContain("margin");
  expect(reasons.skips["transform"]).toContain("text-transform");
  expect(reasons.skips["stretch"]).toContain("font-stretch");
  expect(reasons.skips["br"]).toContain("<br>");
});

test("padded inline chips justify flush, and the padding actually renders", async ({ page }) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "chipflush";
    p.style.width = "260px";
    p.innerHTML =
      'Inside the <code style="font-family: \'Courier New\'; padding: 0 4px">.git/magritte</code> directory you will find the ' +
      'state files, and the <code style="font-family: \'Courier New\'; padding: 0 6px">config.toml</code> file besides holds ' +
      "every option the tool understands, written plainly for people.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#chipflush");
  const r = await page.evaluate(() => {
    const p = document.getElementById("chipflush")!;
    const g = window.__justifLines(p);
    const chips = [...p.querySelectorAll("code")].map((code) => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const box = code.getBoundingClientRect();
      return {
        boxTop: box.top,
        boxRight: box.right,
        boxWidth: box.width,
        textWidth: range.getBoundingClientRect().width,
        pad: parseFloat(getComputedStyle(code).paddingLeft) * 2,
      };
    });
    return { enhanced: p.hasAttribute("data-justif"), g, chips };
  });
  expect(r.enhanced).toBe(true);
  expect(r.g.lines.length).toBeGreaterThan(3);
  for (let i = 0; i < r.g.lines.length - 1; i++) {
    const line = r.g.lines[i]!;
    // Text rects exclude a chip's trailing padding: a line ending in a chip
    // is flush at the chip's BORDER box (within the corrective ~1px spare,
    // realized inside the clone). Lines ending in plain text keep the
    // standard sub-0.5px flushness.
    const chipRights = r.chips
      .filter((c) => Math.abs(c.boxTop - line.top) < 6)
      .map((c) => c.boxRight);
    const endsInChip = chipRights.some((cr) => cr > line.right);
    const right = Math.max(line.right, ...chipRights);
    const deficit = r.g.contentRight - right;
    expect
      .soft(deficit, `line ${i}: "${line.texts.join(" ").slice(0, 40)}"`)
      .toBeLessThan(endsInChip ? 2.0 : 0.5);
    expect.soft(deficit, `line ${i} overflow`).toBeGreaterThan(-0.5);
  }
  // Each chip's border box exceeds its glyph run by its horizontal padding
  // (less the ≤~2px corrective end margin when the chip closes a line).
  expect(r.chips.length).toBe(2);
  for (const chip of r.chips) {
    expect(chip.boxWidth - chip.textWidth).toBeGreaterThan(chip.pad - 2.5);
    expect(chip.boxWidth - chip.textWidth).toBeLessThan(chip.pad + 0.5);
  }
});

test("spaces at font-family boundaries never shrink below natural width", async ({ page }) => {
  // Sweep measures so at least one chip line lands on a SHRUNKEN line
  // (glueRatio < 0): plain gaps there compress, but the gaps flanking the
  // chip must hold their natural width (boundaryShrink 0 default). The
  // chip is styled halo-only (no padding), like sites that predate the
  // padding support.
  const out = await page.evaluate(async () => {
    const results: Array<{
      width: number;
      natural: number;
      shrunkPlainGaps: number;
      minBoundaryGap: number;
    }> = [];
    const p = document.createElement("p");
    p.id = "rigidgaps";
    document.getElementById("host")!.append(p);
    for (const width of [200, 215, 230, 245, 260, 275]) {
      p.style.width = `${width}px`;
      p.innerHTML =
        "Something in the manner of the <code style=\"font-family: 'Courier New'\">.git/magritte</code> directory holds the whole " +
        "recorded state of the machinery, and everything else follows from it plainly.";
      const ctl = window.__justif.justify(p, {
        protrusion: false,
        expansion: false,
        tracking: false,
      });
      await ctl.ready;
      // Natural space width in the paragraph's own font context.
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      probe.textContent = "x x";
      p.append(probe);
      const t = probe.firstChild as Text;
      const range = document.createRange();
      range.setStart(t, 1);
      range.setEnd(t, 2);
      const natural = range.getBoundingClientRect().width;
      probe.remove();

      // Word rects, grouped into lines, with their source element noted.
      const rects: Array<{ mono: boolean; top: number; left: number; right: number }> = [];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode()); ) {
        const text = n.textContent ?? "";
        const mono = (n.parentElement?.closest("code") ?? null) !== null;
        for (const m of text.matchAll(/[^\s\u2060]+/g)) {
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const b = range.getBoundingClientRect();
          if (b.width > 0) rects.push({ mono, top: b.top, left: b.left, right: b.right });
        }
      }
      rects.sort((a, b) => (Math.abs(a.top - b.top) < 4 ? a.left - b.left : a.top - b.top));
      let shrunkPlainGaps = 0;
      let minBoundaryGap = Infinity;
      for (let i = 1; i < rects.length; i++) {
        const prev = rects[i - 1]!;
        const cur = rects[i]!;
        if (Math.abs(prev.top - cur.top) >= 4) continue;
        const gap = cur.left - prev.right;
        if (prev.mono !== cur.mono) minBoundaryGap = Math.min(minBoundaryGap, gap);
        else if (gap < natural - 0.3) shrunkPlainGaps++;
      }
      results.push({ width, natural, shrunkPlainGaps, minBoundaryGap });
      ctl.destroy();
    }
    p.remove();
    return results;
  });
  // The sweep must actually exercise shrink somewhere, or this proves nothing.
  expect(out.some((r) => r.shrunkPlainGaps > 0)).toBe(true);
  for (const r of out) {
    if (!Number.isFinite(r.minBoundaryGap)) continue; // chip sat at a line edge
    expect
      .soft(r.minBoundaryGap, `boundary gap at width ${r.width}`)
      .toBeGreaterThan(r.natural - 0.3);
  }
});

test("white-space: nowrap inline elements never break across lines", async ({ page }) => {
  const out = await page.evaluate(async () => {
    const results: number[] = [];
    const p = document.createElement("p");
    document.getElementById("host")!.append(p);
    for (const width of [170, 200, 230, 260]) {
      p.style.width = `${width}px`;
      p.innerHTML =
        'Press <kbd style="font-family: \'Courier New\'; white-space: nowrap; padding: 0 3px">ctrl shift comma</kbd> or else ' +
        "choose from among the common options offered in the menu just below it.";
      const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
      await ctl.ready;
      const kbd = p.querySelector("kbd")!;
      const range = document.createRange();
      range.selectNodeContents(kbd);
      const tops = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      results.push(tops.size);
      ctl.destroy();
    }
    p.remove();
    return results;
  });
  for (const lineCount of out) expect(lineCount).toBe(1);
});

test("a padded element breaking across lines keeps slice semantics and flush lines", async ({ page }) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "slicepad";
    p.style.width = "240px";
    p.innerHTML =
      'The phrase <span style="padding: 0 5px; background: #eee">wraps across several rendered ' +
      "lines happily</span> while the paragraph itself keeps every full line flush at the margin.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#slicepad");
  const r = await page.evaluate(() => {
    const p = document.getElementById("slicepad")!;
    // The padded source span is cloned ONCE and wraps whole; its segment
    // children tell us which lines it fragments across. (getClientRects on
    // the clone itself under-reports fragments in Chromium.)
    const span = [...p.querySelectorAll("span")].find(
      (s) => !s.classList.contains("justif-seg") && !s.classList.contains("justif-hyphen"),
    )!;
    const fragmentTops = new Set(
      [...span.querySelectorAll(".justif-seg")].map((s) =>
        Math.round(s.getBoundingClientRect().top),
      ),
    );
    return {
      enhanced: p.hasAttribute("data-justif"),
      spanClones: [...p.querySelectorAll("span")].filter(
        (s) => !s.classList.contains("justif-seg") && !s.classList.contains("justif-hyphen"),
      ).length,
      fragments: fragmentTops.size,
      g: window.__justifLines(p),
    };
  });
  expect(r.enhanced).toBe(true);
  expect(r.spanClones).toBe(1); // one element, one tab stop — never duplicated
  expect(r.fragments).toBeGreaterThan(1); // it really did break inside
  for (let i = 0; i < r.g.lines.length - 1; i++) {
    const line = r.g.lines[i]!;
    expect
      .soft(Math.abs(line.right - r.g.contentRight), `line ${i}: "${line.texts.join(" ").slice(0, 40)}"`)
      .toBeLessThan(0.5);
  }
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

test("small-caps runs don't poison later measurements", async ({ page }) => {
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
  // WebKit has no canvas fontVariantCaps, so it reaches the DOM measurement
  // path; Chromium and Firefox can keep using their canvas caps support.
  expect(r.enhanced).toBe(true);
  expect(r.worst).toBeLessThan(1.5);
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

test("handles arbitrary font variants and feature settings", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const j = window.__justif;
    const face = new FontFace("JunicodeVariants", 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(await face.load());
    const out: Array<{ css: string; enhanced: boolean; worst: number }> = [];
    for (const css of [
      "font-variant-ligatures: none",
      'font-feature-settings: "smcp" 1, "ss01" 1',
      "font-variant-numeric: oldstyle-nums proportional-nums",
      "font-variant-caps: all-small-caps",
      "font-variant-alternates: historical-forms",
      "font-variant-east-asian: ruby",
      "font-variant-position: super",
      "font-variant-emoji: text",
    ]) {
      const p = document.createElement("p");
      p.setAttribute("style", `width:340px;font-family:JunicodeVariants;${css}`);
      p.textContent =
        "An afflicted official fills office 1927 efficiently. Historical figures 314159 " +
        "repeat with difficult affiliations and enough varied prose to wrap over many lines.";
      document.getElementById("host")!.append(p);
      const ctl = j.justify(p, { expansion: false, tracking: false, protrusion: false });
      await ctl.ready;
      const enhanced = p.hasAttribute("data-justif");
      let worst = Infinity;
      if (enhanced) {
        const g = window.__justifLines(p);
        worst = 0;
        for (const line of g.lines.slice(0, -1)) {
          worst = Math.max(worst, Math.abs(g.contentRight - line.right));
        }
      }
      out.push({ css, enhanced, worst });
      ctl.destroy();
      p.remove();
    }
    return out;
  });
  for (const result of results) {
    expect.soft(result.enhanced, result.css).toBe(true);
    expect.soft(result.worst, result.css).toBeLessThan(1.5);
  }
});

test("tracking preserves an author's ligature and low-level feature choices", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const face = new FontFace("JunicodeFeatureTracking", 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(await face.load());
    const host = document.getElementById("host")!;
    const inspect = async (css: string) => {
      const p = document.createElement("p");
      p.setAttribute("style", `width:337px;font-family:JunicodeFeatureTracking;${css}`);
      p.textContent =
        "An afflicted official fills a difficult office efficiently, while affiliated " +
        "figures finish fitting into sufficiently irregular lines of repeated prose.";
      host.append(p);
      const ctl = window.__justif.justify(p, { expansion: false, tracking: true });
      await ctl.ready;
      const tracked = [...p.querySelectorAll<HTMLElement>(".justif-seg")].find(
        (el) => el.style.letterSpacing !== "",
      );
      const value = tracked
        ? {
            inlineFeatures: tracked.style.fontFeatureSettings,
            features: getComputedStyle(tracked).fontFeatureSettings,
            ligatures: getComputedStyle(tracked).fontVariantLigatures,
          }
        : null;
      ctl.destroy();
      p.remove();
      return value;
    };
    return {
      disabled: await inspect("font-variant-ligatures:none"),
      custom: await inspect('font-feature-settings:"ss01" 1, "liga" 0'),
    };
  });

  expect(result.disabled).not.toBeNull();
  expect(result.disabled!.ligatures).toBe("none");
  expect(result.disabled!.inlineFeatures).toBe("");
  expect(result.custom).not.toBeNull();
  expect(result.custom!.features).toContain("ss01");
  expect(result.custom!.features).toMatch(/"liga"(?: 0| off)/);
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

test("internal slices of painted inline halos retain glyph protrusion", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const text =
      "Alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, lambda, " +
      "mu, nu, xi, omicron, pi, rho, sigma, tau, upsilon, phi, chi, psi, omega.";
    const variants = [
      ["halo-bare", ""],
      ["halo-background", "background: rgb(230, 230, 230); border-radius: 4px"],
      ["halo-shadow", "box-shadow: 0 0 0 3px rgb(230, 230, 230); border-radius: 4px"],
      ["halo-right-shadow", "box-shadow: 3px 0 0 rgb(230, 230, 230)"],
      ["halo-transparent-shadow", "box-shadow: 0 0 0 3px transparent"],
      ["halo-inset-shadow", "box-shadow: inset 0 0 0 3px rgb(80, 80, 80)"],
      ["halo-underline-shadow", "box-shadow: 0 1px 0 rgb(80, 80, 80)"],
    ] as const;
    const paragraphs: HTMLElement[] = [];
    for (const [id, style] of variants) {
      const p = document.createElement("p");
      p.id = id;
      p.style.width = "210px";
      p.innerHTML = `<code style="font-family: Georgia, serif; ${style}">${text}</code>`;
      host.append(p);
      paragraphs.push(p);
    }
    const ctl = window.__justif.justify(paragraphs, {
      protrusion: true,
      expansion: false,
      tracking: false,
    });
    await ctl.ready;
    return variants.map(([id]) => id);
  });
  await waitForQuiescence(page, "#host");

  const out = await page.evaluate((paragraphIds) => {
    const result: Record<string, number[]> = {};
    for (const id of paragraphIds) {
      const p = document.getElementById(id)!;
      const geometry = window.__justifLines(p);
      result[id] = geometry.lines
        .slice(0, -1)
        .filter((line) => /[.,]$/.test(line.texts.at(-1) ?? ""))
        .map((line) => line.right - geometry.contentRight);
    }
    return result;
  }, ids);

  for (const id of ids) {
    expect(out[id]!.length).toBeGreaterThan(1);
    expect(Math.min(...out[id]!), id).toBeGreaterThan(0.5);
  }
});

test("only visible real halo closes replace terminal glyph protrusion", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const variants = [
      ["close-bare", ""],
      ["close-background", "background: rgb(230, 230, 230); border-radius: 4px"],
      ["close-shadow", "box-shadow: 0 0 0 3px rgb(230, 230, 230)"],
      ["close-right-shadow", "box-shadow: 3px 0 0 rgb(230, 230, 230)"],
      ["close-transparent-shadow", "box-shadow: 0 0 0 3px transparent"],
      ["close-inset-shadow", "box-shadow: inset 0 0 0 3px rgb(80, 80, 80)"],
      ["close-underline-shadow", "box-shadow: 0 1px 0 rgb(80, 80, 80)"],
      ["close-retracted-shadow", "box-shadow: 2px 0 0 -5px rgba(0, 0, 0, .3)"],
    ] as const;
    const paragraphs: HTMLElement[] = [];
    for (const [id, style] of variants) {
      const p = document.createElement("p");
      p.id = id;
      p.innerHTML =
        `Alpha beta <code style="font-family: Georgia, serif; ${style}">edge,</code>` +
        " suffix words continue onto another line.";
      host.append(p);
      const prefix = p.firstChild as Text;
      const codeText = p.querySelector("code")!.firstChild as Text;
      const range = document.createRange();
      range.setStart(prefix, 0);
      range.setEnd(codeText, codeText.length);
      p.style.width = `${range.getBoundingClientRect().width - 1}px`;
      paragraphs.push(p);
    }
    const ctl = window.__justif.justify(paragraphs, {
      protrusion: true,
      expansion: false,
      tracking: false,
      lastLineMinWidth: 0,
    });
    await ctl.ready;
    return variants.map(([id]) => id);
  });
  await waitForQuiescence(page, "#host");

  const out = await page.evaluate((paragraphIds) => {
    const result: Record<string, number> = {};
    for (const id of paragraphIds) {
      const p = document.getElementById(id)!;
      const geometry = window.__justifLines(p);
      const line = geometry.lines.find((candidate) =>
        candidate.texts.join("").trimEnd().endsWith(","),
      )!;
      result[id] = line.right - geometry.contentRight;
    }
    return result;
  }, ids);

  for (const id of [
    "close-bare",
    "close-transparent-shadow",
    "close-inset-shadow",
    "close-underline-shadow",
    "close-retracted-shadow",
  ] as const) {
    expect(out[id], id).toBeGreaterThan(0.5);
  }
  for (const id of ["close-background", "close-shadow", "close-right-shadow"] as const) {
    expect(Math.abs(out[id]!), id).toBeLessThan(0.5);
  }
});

test("a line-end painted inline box hangs its end inset outside the margin", async ({ page }) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "halo-insets";
    p.innerHTML =
      'prefix <code style="font-family: Georgia, serif; background: #ddd; padding: 0 7px">justify()</code>';
    document.getElementById("host")!.append(p);
    const prefix = p.firstChild as Text;
    const codeText = p.querySelector("code")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(prefix, 0);
    range.setEnd(codeText, codeText.length);
    p.style.width = `${range.getBoundingClientRect().width - 1}px`;
    p.style.textAlignLast = "justify";
    const ctl = window.__justif.justify(p, {
      protrusion: true,
      expansion: false,
      tracking: false,
      lastLineMinWidth: 1,
    });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#halo-insets");

  const geometry = await page.evaluate(() => {
    const p = document.getElementById("halo-insets")!;
    const code = p.querySelector<HTMLElement>("code")!;
    const seg = code.querySelector<HTMLElement>(".justif-seg")!;
    const paragraphStyle = getComputedStyle(p);
    const contentRight =
      p.getBoundingClientRect().right -
      parseFloat(paragraphStyle.paddingRight) -
      parseFloat(paragraphStyle.borderRightWidth);
    const halo = code.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(seg);
    const glyphs = range.getBoundingClientRect();
    return {
      contentRight,
      haloRight: halo.right,
      glyphRight: glyphs.right,
    };
  });

  expect.soft(geometry.haloRight - geometry.glyphRight).toBeCloseTo(7, 0);
  // The measured wrap guarantee deliberately keeps ~1px of safety slack;
  // tolerate that correction while requiring the full painted inset to sit
  // beyond the glyph edge and materially outside the paragraph measure.
  expect.soft(Math.abs(geometry.glyphRight - geometry.contentRight)).toBeLessThan(1.5);
  expect(geometry.haloRight - geometry.contentRight).toBeGreaterThan(5.5);
});

test("protrusion: false keeps a line-start halo inside the measure", async ({ page }) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "halo-protrusion-off";
    p.style.width = "210px";
    p.innerHTML =
      '<code style="font-family: Georgia, serif; background: #ddd; padding: 0 7px">justify()</code> ' +
      "treats the paragraph as one problem and compares feasible sets of breaks.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, {
      protrusion: false,
      expansion: false,
      tracking: false,
    });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#halo-protrusion-off");

  const geometry = await page.evaluate(() => {
    const p = document.getElementById("halo-protrusion-off")!;
    const code = p.querySelector<HTMLElement>("code")!;
    const seg = code.querySelector<HTMLElement>(".justif-seg")!;
    const paragraphStyle = getComputedStyle(p);
    const contentLeft =
      p.getBoundingClientRect().left +
      parseFloat(paragraphStyle.paddingLeft) +
      parseFloat(paragraphStyle.borderLeftWidth);
    const range = document.createRange();
    range.selectNodeContents(seg);
    return {
      contentLeft,
      haloLeft: code.getBoundingClientRect().left,
      glyphLeft: range.getBoundingClientRect().left,
      marginStart: parseFloat(code.style.marginInlineStart) || 0,
    };
  });

  expect(geometry.marginStart).toBe(0);
  expect(Math.abs(geometry.haloLeft - geometry.contentLeft)).toBeLessThan(0.5);
  expect(geometry.glyphLeft - geometry.contentLeft).toBeCloseTo(7, 0);
});

test("painted starts follow NBSP boxes and padding outside the painter", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const nbsp = document.createElement("p");
    nbsp.id = "halo-nbsp-start";
    nbsp.style.width = "210px";
    nbsp.innerHTML =
      '<code style="background:#ddd;padding:0 7px"><span>&nbsp;</span>justify()</code> ' +
      "treats the paragraph as one problem with several feasible breaks.";
    const nested = document.createElement("p");
    nested.id = "halo-ancestor-start";
    nested.style.width = "210px";
    nested.innerHTML =
      '<a style="padding:0 4px"><code style="background:#ddd;padding:0 6px">justify()</code></a> ' +
      "treats the paragraph as one problem with several feasible breaks.";
    const nestedZero = document.createElement("p");
    nestedZero.id = "halo-zero-inset-ancestor-start";
    nestedZero.style.width = "210px";
    nestedZero.innerHTML =
      '<a style="padding:0 4px"><code style="background:#ddd">justify()</code></a> ' +
      "treats the paragraph as one problem with several feasible breaks.";
    host.append(nbsp, nested, nestedZero);
    const ctl = window.__justif.justify([nbsp, nested, nestedZero], {
      protrusion: true,
      expansion: false,
      tracking: false,
    });
    await ctl.ready;
    return [nbsp.id, nested.id, nestedZero.id];
  });
  await waitForQuiescence(page, "#host");

  const geometry = await page.evaluate((paragraphIds) =>
    paragraphIds.map((id) => {
      const p = document.getElementById(id)!;
      const code = p.querySelector<HTMLElement>("code")!;
      const paragraphStyle = getComputedStyle(p);
      const contentLeft =
        p.getBoundingClientRect().left +
        parseFloat(paragraphStyle.paddingLeft) +
        parseFloat(paragraphStyle.borderLeftWidth);
      const range = document.createRange();
      range.selectNodeContents(code);
      return {
        id,
        contentLeft,
        haloLeft: code.getBoundingClientRect().left,
        glyphLeft: range.getBoundingClientRect().left,
        cloneMargin: parseFloat(code.style.marginInlineStart) || 0,
      };
    }), ids);

  const nbsp = geometry.find((entry) => entry.id === "halo-nbsp-start")!;
  expect(nbsp.cloneMargin).toBeCloseTo(-7, 1);
  expect(nbsp.contentLeft - nbsp.haloLeft).toBeCloseTo(7, 0);
  expect(Math.abs(nbsp.glyphLeft - nbsp.contentLeft)).toBeLessThan(0.5);

  const nested = geometry.find((entry) => entry.id === "halo-ancestor-start")!;
  expect(nested.cloneMargin).toBeCloseTo(-10, 1);
  expect(nested.contentLeft - nested.haloLeft).toBeCloseTo(6, 0);
  expect(Math.abs(nested.glyphLeft - nested.contentLeft)).toBeLessThan(0.5);

  const nestedZero = geometry.find(
    (entry) => entry.id === "halo-zero-inset-ancestor-start",
  )!;
  expect(nestedZero.cloneMargin).toBeCloseTo(-4, 1);
  expect(Math.abs(nestedZero.haloLeft - nestedZero.contentLeft)).toBeLessThan(0.5);
  expect(Math.abs(nestedZero.glyphLeft - nestedZero.contentLeft)).toBeLessThan(0.5);
});

test("an ending NBSP carries a painted halo's end owner", async ({ page }) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "halo-nbsp-end";
    p.innerHTML =
      'prefix <code style="background:#ddd;padding:0 7px">justify()<span>&nbsp;</span></code>';
    document.getElementById("host")!.append(p);
    const prefix = p.firstChild as Text;
    const nbspText = p.querySelector("span")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(prefix, 0);
    range.setEnd(nbspText, nbspText.length);
    p.style.width = `${range.getBoundingClientRect().width - 1}px`;
    p.style.textAlignLast = "justify";
    const ctl = window.__justif.justify(p, {
      protrusion: true,
      expansion: false,
      tracking: false,
      lastLineMinWidth: 1,
    });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#halo-nbsp-end");

  const geometry = await page.evaluate(() => {
    const p = document.getElementById("halo-nbsp-end")!;
    const code = p.querySelector<HTMLElement>("code")!;
    const segments = [...code.querySelectorAll<HTMLElement>(".justif-seg")];
    const range = document.createRange();
    range.selectNodeContents(code);
    return {
      haloRight: code.getBoundingClientRect().right,
      glyphRight: range.getBoundingClientRect().right,
      cloneMargin: parseFloat(code.style.marginInlineEnd) || 0,
      segmentMargin: parseFloat(segments[segments.length - 1]!.style.marginInlineEnd) || 0,
    };
  });

  expect(geometry.haloRight - geometry.glyphRight).toBeCloseTo(7, 0);
  expect(geometry.cloneMargin).toBeLessThan(-6);
  expect(geometry.segmentMargin).toBe(0);
});

test("an unpadded painted close keeps wrap-safety margin outside its halo", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "halo-unpadded-close";
    p.style.width = "210px";
    p.innerHTML =
      'Alpha beta gamma delta epsilon zeta eta theta iota kappa <code style="background:#ddd">justify()</code>';
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, {
      protrusion: true,
      expansion: false,
      tracking: false,
    });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#halo-unpadded-close");

  const margins = await page.evaluate(() => {
    const p = document.getElementById("halo-unpadded-close")!;
    const code = p.querySelector<HTMLElement>("code")!;
    const seg = code.querySelector<HTMLElement>(".justif-seg")!;
    return {
      enhanced: p.hasAttribute("data-justif"),
      clone: parseFloat(code.style.marginInlineEnd) || 0,
      segment: parseFloat(seg.style.marginInlineEnd) || 0,
    };
  });

  expect(margins.enhanced).toBe(true);
  expect(margins.clone).toBeLessThan(0);
  expect(margins.segment).toBe(0);
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

test("coalesces JSX-style literal-space text nodes", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const paragraphs: HTMLElement[] = [];
    const originals = new Map<string, string>();
    const link = (): HTMLAnchorElement => {
      const a = document.createElement("a");
      a.href = "https://magit.vc/";
      a.textContent = "Magit";
      return a;
    };
    const add = (p: HTMLElement): void => {
      p.style.width = "280px";
      host.append(p);
      paragraphs.push(p);
      originals.set(p.id, p.textContent ?? "");
    };

    for (const comments of [false, true]) {
      const p = document.createElement("p");
      p.id = comments ? "jsx-space-comment" : "jsx-space-adjacent";
      p.append(
        document.createTextNode(
          "Magritte is a fast, keyboard-first git client imbued with the spirit of",
        ),
      );
      // Server-rendered JSX may delimit adjacent text children with comments.
      if (comments) p.append(document.createComment(""));
      // JSX's {" "} is emitted as its own text node.
      p.append(
        document.createTextNode(" "),
        link(),
        document.createTextNode(", no Emacs required."),
      );
      add(p);
    }

    // Exercise the mirrored form too. At a real element boundary the
    // renderer may still need NBSP for deterministic wrapping, but splitting
    // the following prose into JSX text children must not create another run.
    for (const explicit of [false, true]) {
      const p = document.createElement("p");
      p.id = explicit ? "jsx-space-after-explicit" : "jsx-space-after-merged";
      p.append(
        document.createTextNode(
          "Magritte is a fast, keyboard-first git client inspired by ",
        ),
        link(),
      );
      const suffix = "and designed for fast work without requiring Emacs.";
      if (explicit) {
        p.append(
          document.createComment(""),
          document.createTextNode(" "),
          document.createTextNode(suffix),
        );
      } else {
        p.append(document.createTextNode(` ${suffix}`));
      }
      add(p);
    }

    const controller = window.__justif.justify(paragraphs, {
      expansion: false,
      protrusion: false,
    });
    await controller.ready;
    return paragraphs.map((p) => ({
      id: p.id,
      enhanced: p.hasAttribute("data-justif"),
      original: originals.get(p.id),
      rendered: p.textContent,
      linkText: p.querySelector("a")?.textContent,
      lines: window.__justifLines(p).lines.length,
      segments: [...p.querySelectorAll<HTMLElement>(".justif-seg")].map((s) => s.textContent),
    }));
  });

  for (const result of results) {
    expect(result.enhanced, result.id).toBe(true);
    expect(result.lines, result.id).toBeGreaterThan(1);
    expect(result.linkText, result.id).toBe("Magit");
  }

  const adjacent = results.find((r) => r.id === "jsx-space-adjacent")!;
  const comment = results.find((r) => r.id === "jsx-space-comment")!;
  expect(adjacent.rendered).toBe(adjacent.original);
  expect(comment.rendered).toBe(comment.original);
  expect(comment.segments).toEqual(adjacent.segments);

  const mergedAfter = results.find((r) => r.id === "jsx-space-after-merged")!;
  const explicitAfter = results.find((r) => r.id === "jsx-space-after-explicit")!;
  expect(explicitAfter.rendered?.replace(/\u00a0/g, " ")).toBe(explicitAfter.original);
  expect(explicitAfter.rendered).toBe(mergedAfter.rendered);
  expect(explicitAfter.segments).toEqual(mergedAfter.segments);
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

test("text autosizing is disabled before scanning and author styles are restored", async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.replaceChildren();

    const p = document.createElement("p");
    p.style.cssText =
      "width:340px;font:17px/1.45 Georgia,serif;text-align:justify;color:rgb(1,2,3)";
    p.style.setProperty("-webkit-text-size-adjust", "145%", "important");
    p.style.setProperty("text-size-adjust", "145%", "important");
    p.innerHTML =
      "In <strong>olden times</strong> <em>wishing still helped one</em>, there lived a king whose daughters " +
      "were all beautiful, and the youngest astonished the sun whenever it shone in her face.";
    const strong = p.querySelector<HTMLElement>("strong")!;
    const em = p.querySelector<HTMLElement>("em")!;
    em.style.color = "rgb(4, 5, 6)";
    em.style.setProperty("-webkit-text-size-adjust", "160%", "important");
    em.style.setProperty("text-size-adjust", "160%", "important");

    const skipped = document.createElement("p");
    skipped.style.cssText =
      "width:340px;font:17px/1.45 Georgia,serif;text-align:justify;text-transform:uppercase";
    skipped.textContent = "This unsupported paragraph must remain byte-identical.";
    host.append(p, skipped);

    const original = {
      pStyle: p.getAttribute("style"),
      strongStyle: strong.getAttribute("style"),
      emStyle: em.getAttribute("style"),
      markup: p.innerHTML,
      skippedStyle: skipped.getAttribute("style"),
    };
    const supportedProperties = ["text-size-adjust", "-webkit-text-size-adjust"].filter(
      (property) => CSS.supports(property, "100%"),
    );
    const adjustments = (el: HTMLElement) =>
      supportedProperties.map((property) => ({
        property,
        value: el.style.getPropertyValue(property),
        priority: el.style.getPropertyPriority(property),
      }));

    let pAtFirstRead: ReturnType<typeof adjustments> | null = null;
    let strongAtFirstRead: ReturnType<typeof adjustments> | null = null;
    let emAtFirstRead: ReturnType<typeof adjustments> | null = null;
    const nativeGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      if (element === p && pAtFirstRead === null) pAtFirstRead = adjustments(p);
      if (element === strong && strongAtFirstRead === null) {
        strongAtFirstRead = adjustments(strong);
      }
      if (element === em && emAtFirstRead === null) emAtFirstRead = adjustments(em);
      return nativeGetComputedStyle.call(window, element, pseudo);
    }) as typeof window.getComputedStyle;

    let skippedStyleSeenByCallback: string | null = null;
    let controller: ReturnType<typeof window.__justif.justify>;
    try {
      controller = window.__justif.justify([p, skipped], {
        protrusion: false,
        expansion: false,
        onSkip(el: HTMLElement) {
          if (el === skipped) skippedStyleSeenByCallback = el.getAttribute("style");
        },
      });
    } finally {
      window.getComputedStyle = nativeGetComputedStyle;
    }
    await controller.ready;

    const rendered = {
      pAdjustments: adjustments(p),
      segmentAdjustments: [...p.querySelectorAll<HTMLElement>(".justif-seg")].map(adjustments),
      strongStyle: p.querySelector("strong")?.getAttribute("style") ?? null,
      skippedStyle: skipped.getAttribute("style"),
    };
    controller.destroy();

    return {
      supportedProperties,
      pAtFirstRead,
      strongAtFirstRead,
      emAtFirstRead,
      skippedStyleSeenByCallback,
      rendered,
      restored: {
        pStyle: p.getAttribute("style"),
        strongStyle: strong.getAttribute("style"),
        emStyle: em.getAttribute("style"),
        markup: p.innerHTML,
        skippedStyle: skipped.getAttribute("style"),
      },
      original,
    };
  });

  const pinned = r.supportedProperties.map((property) => ({
    property,
    value: "100%",
    priority: "important",
  }));
  expect(r.pAtFirstRead).toEqual(pinned);
  expect(r.strongAtFirstRead).toEqual(pinned);
  expect(r.emAtFirstRead).toEqual(pinned);
  expect(r.skippedStyleSeenByCallback).toBe(r.original.skippedStyle);
  expect(r.rendered.pAdjustments).toEqual(pinned);
  expect(r.rendered.segmentAdjustments.length).toBeGreaterThan(0);
  for (const adjustments of r.rendered.segmentAdjustments) expect(adjustments).toEqual(pinned);
  expect(r.rendered.strongStyle).toBeNull();
  expect(r.rendered.skippedStyle).toBe(r.original.skippedStyle);
  expect(r.restored).toEqual(r.original);
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
    const paragraph = document.querySelector<HTMLElement>("#host [data-justif]");
    const paragraphStyle = paragraph === null ? null : getComputedStyle(paragraph);
    return {
      segs: document.querySelectorAll("#host .justif-seg").length,
      // The load-bearing assertion: the nowrap rule genuinely applies —
      // without it the line model silently collapses.
      whiteSpace: seg === null ? null : getComputedStyle(seg).whiteSpace,
      // Mobile Safari's text autosizing runs after justif has measured and
      // can independently boost the nowrap fragments. Active output opts
      // out without changing the host page's text-sizing policy.
      supportsTextSizeAdjust:
        CSS.supports("text-size-adjust", "100%") ||
        CSS.supports("-webkit-text-size-adjust", "100%"),
      textSizeAdjust: paragraphStyle === null
        ? []
        : [
            paragraphStyle.getPropertyValue("text-size-adjust"),
            paragraphStyle.getPropertyValue("-webkit-text-size-adjust"),
          ],
      adopted: document.adoptedStyleSheets.length,
    };
  });
  expect(r.segs).toBeGreaterThan(0);
  expect(r.whiteSpace).toBe("nowrap");
  if (r.supportsTextSizeAdjust) expect(r.textSizeAdjust).toContain("100%");
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

test("auto drop-in: enhances justified text only, language-gated hyphenation", async ({ page }) => {
  const leftBefore = "This paragraph is left aligned";
  await page.goto("/test-e2e/fixture-auto.html");
  // Await `booted`: it settles only after every language group — including
  // controllers pushed later by dynamic pattern-module imports — has
  // committed and converged. A snapshot of `controllers` taken when
  // window.justif appears would miss the dynamic groups.
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });
  // Both computed-justify paragraphs enhanced; the left-aligned one untouched.
  expect(await page.locator("#en-just .justif-seg").count()).toBeGreaterThan(0);
  expect(await page.locator("#de-just .justif-seg").count()).toBeGreaterThan(0);
  expect(await page.locator("#en-left .justif-seg").count()).toBe(0);
  expect(await page.evaluate(() => document.getElementById("en-left")!.hasAttribute("data-justif"))).toBe(false);
  expect(await page.evaluate(() => document.getElementById("en-left")!.textContent)).toContain(leftBefore);
  // Language detection: en-US patterns hyphenate the English paragraph;
  // the lang="de" paragraph hyphenates too — via the German pattern module
  // loaded on demand from a sibling file, never via English patterns
  // (verified below with a German-only break). The lang="cs" paragraph
  // (no bundled patterns) enhances with spacing only: wrong-language
  // hyphenation is worse than none.
  expect(await page.locator("#en-just .justif-hyphen").count()).toBeGreaterThan(0);
  expect(await page.locator("#de-just .justif-hyphen").count()).toBeGreaterThan(0);
  expect(await page.locator("#cs-just .justif-seg").count()).toBeGreaterThan(0);
  expect(await page.locator("#cs-just .justif-hyphen").count()).toBe(0);
  // The de hyphenator really is German: its module hyphenates a word the
  // en-US patterns leave whole.
  const isGerman = await page.evaluate(async () => {
    const url = "/dist/hyphenate/de.js";
    const m = (await import(url)) as { hyphenateDe(w: string): string[] };
    return m.hyphenateDe("silbentrennung").join("-");
  });
  expect(isGerman).toBe("sil-ben-tren-nung");
});

test("auto drop-in: booted awaits delayed pattern modules", async ({ page }) => {
  // The German patterns arrive by dynamic import; delay them well past the
  // initial commit. `booted` must not settle before that group's final
  // controller exists and has hyphenated its paragraph.
  await page.route("**/dist/hyphenate/de.js", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  await page.goto("/test-e2e/fixture-auto.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  const controllers = await page.evaluate(async () => {
    const g = window as Window & { justif?: { booted: Promise<void>; controllers: unknown[] } };
    await g.justif!.booted;
    return g.justif!.controllers.length;
  });
  expect(controllers).toBe(3); // en-US, de, and the unbundled-language group
  expect(await page.locator("#de-just .justif-hyphen").count()).toBeGreaterThan(0);
});

test("unicode-range subset fonts are awaited and converge without refresh()", async ({ page }) => {
  // A Greek-only face: font readiness must be judged with the content's own
  // characters — document.fonts.load()'s default U+0020 never matches this
  // face, and a fixed Latin probe cannot see its arrival. The paragraph
  // leads with 300+ DISTINCT Latin code points so any sample cap that
  // discards later content would drop the Greek and regress silently.
  await page.route("**/Junicode-Roman.ttf", async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  const r = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `@font-face {
      font-family: "GreekSubset";
      src: url("/demo/fonts/Junicode-Roman.ttf") format("truetype");
      unicode-range: U+0370-03FF, U+1F00-1FFF;
    }`;
    document.head.append(style);
    const uniques: string[] = [];
    for (const [a, b] of [
      [0x21, 0x7e],
      [0xa1, 0x17e],
    ] as const) {
      for (let c = a; c <= b; c++) uniques.push(String.fromCodePoint(c));
    }
    const latinNoise = uniques.join("").replace(/(.{8})/g, "$1 ");
    const greek =
      "Η στοίχιση του κειμένου απαιτεί ακριβείς μετρήσεις των γλυφών, και οι μετρήσεις πρέπει να γίνονται στη γραμματοσειρά που πράγματι αποδίδεται στην οθόνη, αλλιώς οι γραμμές δεν γεμίζουν το πλάτος της στήλης.";
    const p = document.createElement("p");
    p.style.cssText = "width: 320px; font: 18px/1.5 GreekSubset, serif; text-align: justify;";
    p.textContent = latinNoise + " " + greek;
    document.getElementById("host")!.append(p);
    // Independent witness that the face actually changed Greek metrics.
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;font:18px GreekSubset, serif;";
    probe.textContent = "γραμματοσειρά μετρήσεις";
    document.body.append(probe);
    const widthBefore = probe.getBoundingClientRect().width;

    let relayouts = 0;
    const t0 = performance.now();
    const ctl = window.__justif.justify(p, {
      protrusion: false,
      expansion: false,
      onRelayout: () => relayouts++,
    });
    const relayoutsAtCommit = relayouts;
    await ctl.ready;
    const readyAfter = performance.now() - t0;
    const widthAfter = probe.getBoundingClientRect().width;
    const loaded = [...document.fonts].some(
      (f) => f.family.replace(/["']/g, "") === "GreekSubset" && f.status === "loaded",
    );
    const g = window.__justifLines(p);
    const maxDev = Math.max(
      ...g.lines.slice(0, -1).map((l) => Math.abs(l.right - g.contentRight)),
    );
    ctl.destroy();
    p.remove();
    probe.remove();
    style.remove();
    return {
      readyAfter,
      loaded,
      relayoutsAtCommit,
      relayouts,
      fontDelta: Math.abs(widthAfter - widthBefore),
      lines: g.lines.length,
      maxDev,
    };
  });
  expect(r.loaded).toBe(true);
  expect(r.readyAfter).toBeGreaterThan(400); // ready awaited the subset face, not just U+0020
  expect(r.relayoutsAtCommit).toBeGreaterThan(0); // interim committed synchronously
  expect(r.fontDelta).toBeGreaterThan(1); // the face genuinely changed Greek metrics…
  expect(r.relayouts).toBeGreaterThan(r.relayoutsAtCommit); // …and that triggered a re-measure
  expect(r.lines).toBeGreaterThan(2);
  expect(r.maxDev).toBeLessThan(1); // converged to the real font without refresh()
});

test("auto drop-in: teardown before pattern arrival stays torn down", async ({ page }) => {
  await page.route("**/dist/hyphenate/de.js", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  // Keep the page contentless-unpainted (test-owned CSS, no library
  // contract): with no paint entries at boot, the de group
  // deterministically commits an interim controller that teardown can
  // reach before its pattern module lands.
  await page.addInitScript(() => {
    const arm = (): void => {
      const style = document.createElement("style");
      style.textContent = "body { visibility: hidden; }";
      document.documentElement.append(style);
    };
    if (document.documentElement !== null) arm();
    else {
      new MutationObserver((_, obs) => {
        if (document.documentElement !== null) {
          obs.disconnect();
          arm();
        }
      }).observe(document, { childList: true });
    }
  });
  await page.goto("/test-e2e/fixture-auto.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  // Tear down through unjustify() — the public route that bypasses any
  // controller-level hook, so cancellation must key off element state.
  await page.evaluate(() => {
    const g = window as Window & { justif?: { unjustify: (t: Iterable<Element>) => void } };
    g.justif!.unjustify(document.querySelectorAll("p"));
  });
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });
  expect(await page.locator("#de-just .justif-seg").count()).toBe(0);
  expect(
    await page.evaluate(() => document.getElementById("de-just")!.hasAttribute("data-justif")),
  ).toBe(false);
});

test("destroy() before font convergence does not poison later controllers", async ({ page }) => {
  // A controller destroyed while its face is still loading must not leave
  // fallback-font metrics in the module-level measure caches: a later
  // justify() over the same specs would reuse them against the loaded
  // face and lay out permanently mis-fit lines.
  await page.route("**/Junicode-Roman.ttf", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  const r = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `@font-face {
      font-family: "GreekLate";
      src: url("/demo/fonts/Junicode-Roman.ttf") format("truetype");
      unicode-range: U+0370-03FF, U+1F00-1FFF;
    }`;
    document.head.append(style);
    const p = document.createElement("p");
    p.style.cssText = "width: 320px; font: 18px/1.5 GreekLate, serif; text-align: justify;";
    p.textContent =
      "Η στοίχιση του κειμένου απαιτεί ακριβείς μετρήσεις των γλυφών, και οι μετρήσεις πρέπει να γίνονται στη γραμματοσειρά που πράγματι αποδίδεται στην οθόνη, αλλιώς οι γραμμές δεν γεμίζουν το πλάτος της στήλης.";
    document.getElementById("host")!.append(p);
    const first = window.__justif.justify(p, { protrusion: false, expansion: false });
    first.destroy(); // face still in flight
    await document.fonts.load('18px "GreekLate"', "γλ");
    const ctl = window.__justif.justify(p, { protrusion: false, expansion: false });
    await ctl.ready;
    const g = window.__justifLines(p);
    const maxDev = Math.max(
      ...g.lines.slice(0, -1).map((l) => Math.abs(l.right - g.contentRight)),
    );
    ctl.destroy();
    p.remove();
    style.remove();
    return { maxDev, lines: g.lines.length };
  });
  expect(r.lines).toBeGreaterThan(2);
  expect(r.maxDev).toBeLessThan(1); // measured with the loaded face, not stale cache
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
  // Body-level paragraph (not #host): default 16px font-SIZE, so 2em =
  // 32px — but the font FACE is pinned: on Linux WebKit the generic
  // `serif` resolves differently in canvas than in DOM rendering, which
  // sets every line a few px short (CI-only failure; macOS agrees with
  // itself). A deterministic face keeps this a text-indent test.
  const text =
    "the quick brown fox jumps over the lazy dog while the small grey cat " +
    "watches from the garden wall and the old man walks slowly down the long " +
    "dusty road toward the quiet village where the children play beside the " +
    "river under the tall green trees until the evening sun drops behind the " +
    "far hills and the fields grow dark and still and the last light fades " +
    "from the evening sky.";
  for (const c of [
    { name: "positive indent", style: "width:416px; text-indent: 2em; font-family: Georgia, serif", delta: 32 },
    // The classic hanging-indent idiom — padding-left gives the negative
    // indent room to start left of the other lines' edge.
    { name: "hanging indent", style: "width:416px; text-indent: -24px; padding-left: 24px; font-family: Georgia, serif", delta: -24 },
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
