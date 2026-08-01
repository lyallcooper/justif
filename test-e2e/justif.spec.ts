import { expect, type Page, test } from "@playwright/test";
import { kinsokuNotAtLineEnd, kinsokuNotAtLineStart } from "../src/core/cjk.js";

/** The controller surface these tests drive, mirroring `JustifyController`. */
interface TestController {
  ready: Promise<void>;
  refresh(): void;
  applyLayoutOptions(config: object): void;
  destroy(): void;
  readonly managed: readonly Element[];
}

declare global {
  interface Window {
    __justif: {
      justify: (t: Iterable<Element> | Element, o?: object) => TestController;
      unjustify: (t: Iterable<Element>) => void;
      hyphenateEnUS: (w: string) => string[];
      /** The hanging-punctuation protrusion table object. */
      hangingPunctuation: Readonly<Record<string, unknown>>;
      /** Measured protrusion for a font, or undefined when unmeasurable. */
      opticalProtrusion: (spec: {
        family: string;
        style?: string;
        weight?: string;
        variantCaps?: string;
      }) => Record<string, { l?: number; r?: number }> | undefined;
      controller: TestController | null;
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

interface FragmentedGeometry {
  enhanced: boolean;
  rtl: boolean;
  fragments: Array<{ left: number; right: number; width: number }>;
  lines: Array<{
    left: number;
    right: number;
    width: number;
    fragmentLeft: number;
    fragmentRight: number;
  }>;
}

/** Geometry for plain-text multicolumn fixtures (one .justif-seg per line).
 * Match by nearest rectangle in both axes: columns can share line tops,
 * while pagelike fragments can share horizontal coordinates. */
async function readFragmentedGeometry(page: Page, selector: string): Promise<FragmentedGeometry> {
  return page.evaluate((sel) => {
    const p = document.querySelector<HTMLElement>(sel)!;
    const rtl = getComputedStyle(p).direction === "rtl";
    const fragments = [...p.getClientRects()].map((rect) => ({
      left: rect.left,
      right: rect.right,
      width: rect.width,
      top: rect.top,
      bottom: rect.bottom,
    }));
    const lines = [...p.querySelectorAll<HTMLElement>(".justif-seg")].map((line) => {
      const rect = line.getBoundingClientRect();
      const x = rtl ? rect.right : rect.left;
      const y = rect.top + rect.height / 2;
      let fragment = fragments[0]!;
      let bestDistance = Infinity;
      for (const candidate of fragments) {
        const dx =
          x < candidate.left
            ? candidate.left - x
            : x > candidate.right
              ? x - candidate.right
              : 0;
        const dy =
          y < candidate.top
            ? candidate.top - y
            : y > candidate.bottom
              ? y - candidate.bottom
              : 0;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          fragment = candidate;
          bestDistance = distance;
        }
      }
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        fragmentLeft: fragment.left,
        fragmentRight: fragment.right,
      };
    });
    return {
      enhanced: p.hasAttribute("data-justif"),
      rtl,
      fragments: fragments.map(({ left, right, width }) => ({ left, right, width })),
      lines,
    };
  }, selector);
}

/**
 * Resolve once `selector`'s subtree has stopped mutating: its innerHTML is
 * unchanged across two samples ~120ms apart. The measured wrap-guarantee
 * corrections queued by resizes or off-screen content land in trailing rAF
 * slices, so "settled" is a fact about the DOM, not a fixed delay. Bounded:
 * proceeds after ~2s even if the DOM never goes quiet — the assertions that
 * follow then judge whatever state it is in.
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
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("equal-width multicolumn fragments are set against their own LTR and RTL edges", async ({
  page,
}) => {
  const originals = await page.evaluate(async () => {
    document.body.innerHTML = `
      <style>
        .columns {
          width: 761px;
          height: 264px;
          column-count: 3;
          column-gap: 23px;
          column-fill: auto;
          margin-bottom: 24px;
        }
        .columns p {
          margin: 0;
          padding: 0;
          border: 0;
          font: 17px/24px Georgia, serif;
          text-align: justify;
        }
      </style>
      <div class="columns"><p id="columns-ltr"></p></div>
      <div class="columns" dir="rtl"><p id="columns-rtl"></p></div>
    `;
    const ltr = document.getElementById("columns-ltr")!;
    const rtl = document.getElementById("columns-rtl")!;
    ltr.textContent = (
      "In olden times when wishing still helped one, there lived a king whose daughters " +
      "were all beautiful, and the youngest was so beautiful that the sun itself was " +
      "astonished whenever it shone in her face. "
    ).repeat(8);
    rtl.textContent = (
      "בראשית ברא אלהים את השמים ואת הארץ, והארץ היתה תהו ובהו וחשך על פני תהום. " +
      "ויאמר אלהים יהי אור ויהי אור, וירא אלהים את האור כי טוב ויבדל בין האור ובין החשך. "
    ).repeat(10);
    const html = [ltr.innerHTML, rtl.innerHTML];
    window.__justif.controller = window.__justif.justify([ltr, rtl], {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
      observeResize: false,
    });
    await window.__justif.controller.ready;
    return html;
  });
  await waitForQuiescence(page, "body");

  const geometries = await Promise.all([
    readFragmentedGeometry(page, "#columns-ltr"),
    readFragmentedGeometry(page, "#columns-rtl"),
  ]);
  for (const geometry of geometries) {
    expect(geometry.enhanced).toBe(true);
    expect(geometry.fragments.length).toBeGreaterThanOrEqual(3);
    expect(geometry.lines.length).toBeGreaterThan(20);
    const firstWidth = geometry.fragments[0]!.width;
    expect(firstWidth % 1).not.toBe(0); // fractional column measure
    for (const fragment of geometry.fragments) {
      expect(Math.abs(fragment.width - firstWidth)).toBeLessThan(0.05);
    }
    for (const [index, line] of geometry.lines.entries()) {
      expect(line.width).toBeLessThan(firstWidth + 0.5);
      if (index === geometry.lines.length - 1) continue;
      const edgeError = geometry.rtl
        ? Math.abs(line.left - line.fragmentLeft)
        : Math.abs(line.right - line.fragmentRight);
      expect.soft(edgeError, `line ${index + 1} fragment edge`).toBeLessThan(0.5);
    }
  }

  const restored = await page.evaluate(() => {
    window.__justif.controller!.destroy();
    return [
      document.getElementById("columns-ltr")!.innerHTML,
      document.getElementById("columns-rtl")!.innerHTML,
    ];
  });
  expect(restored).toEqual(originals);
});

test("column migration needs no re-layout, while a column-width resize does", async ({ page }) => {
  const original = await page.evaluate(async () => {
    document.body.innerHTML = `
      <style>
        #migration-columns {
          width: 760px;
          height: 300px;
          column-count: 2;
          column-gap: 48px;
          column-fill: auto;
        }
        #migration-target {
          margin: 0;
          padding: 0;
          border: 0;
          font: 17px/24px Georgia, serif;
          text-align: justify;
        }
      </style>
      <div id="migration-columns">
        <div id="migration-lead"></div>
        <p id="migration-target"></p>
      </div>
    `;
    const p = document.getElementById("migration-target")!;
    p.textContent = (
      "In olden times when wishing still helped one, there lived a king whose daughters " +
      "were all beautiful, and the youngest was so beautiful that the sun itself was " +
      "astonished whenever it shone in her face. "
    ).repeat(3);
    const html = p.innerHTML;
    p.dataset.relayouts = "0";
    window.__justif.controller = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
      onRelayout: (paragraph: HTMLElement) => {
        paragraph.dataset.relayouts = String(Number(paragraph.dataset.relayouts) + 1);
      },
    });
    await window.__justif.controller.ready;
    return html;
  });
  await waitForQuiescence(page, "#migration-target");

  const initial = await readFragmentedGeometry(page, "#migration-target");
  expect(initial.fragments).toHaveLength(2);
  expect(initial.enhanced).toBe(true);
  const initialFirstFragmentLines = initial.lines.filter(
    (line) => Math.abs(line.fragmentLeft - initial.fragments[0]!.left) < 0.05,
  ).length;

  await page.evaluate(async () => {
    document.getElementById("migration-lead")!.style.height = "120px";
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const migrated = await readFragmentedGeometry(page, "#migration-target");
  expect(migrated.fragments).toHaveLength(2);
  const migratedFirstFragmentLines = migrated.lines.filter(
    (line) => Math.abs(line.fragmentLeft - migrated.fragments[0]!.left) < 0.05,
  ).length;
  expect(migratedFirstFragmentLines).toBeLessThan(initialFirstFragmentLines);
  expect(await page.locator("#migration-target").getAttribute("data-relayouts")).toBe("1");
  for (const [index, line] of migrated.lines.entries()) {
    if (index === migrated.lines.length - 1) continue;
    expect(Math.abs(line.right - line.fragmentRight)).toBeLessThan(0.5);
  }

  await page.evaluate(() => {
    document.getElementById("migration-columns")!.style.width = "680px";
  });
  await page.waitForFunction(
    () =>
      document.getElementById("migration-target")!.getClientRects()[0]!.width < 330 &&
      Number(document.getElementById("migration-target")!.dataset.relayouts) > 1,
  );
  await waitForQuiescence(page, "#migration-target");
  await page.evaluate(() => window.__justif.controller!.refresh());
  await waitForQuiescence(page, "#migration-target");

  const resized = await readFragmentedGeometry(page, "#migration-target");
  expect(resized.fragments[0]!.width).toBeCloseTo(316, 1);
  for (const [index, line] of resized.lines.entries()) {
    if (index === resized.lines.length - 1) continue;
    expect(Math.abs(line.right - line.fragmentRight)).toBeLessThan(0.5);
  }

  const restored = await page.evaluate(() => {
    const p = document.getElementById("migration-target")!;
    window.__justif.controller!.destroy();
    return { html: p.innerHTML, enhanced: p.hasAttribute("data-justif") };
  });
  expect(restored.html).toBe(original);
  expect(restored.enhanced).toBe(false);
});

test("unequal fragments and fragmented drop caps stay native", async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <style>
        #fallback-columns {
          width: 760px;
          height: 240px;
          column-count: 2;
          column-gap: 48px;
          column-fill: auto;
        }
        #fallback-columns p, #unequal-fragments {
          width: auto;
          margin: 0;
          padding: 0;
          border: 0;
          font: 17px/24px Georgia, serif;
          text-align: justify;
        }
        #fragmented-dropcap::first-letter {
          float: left;
          padding-right: 6px;
          font-size: 70px;
          line-height: 0.8;
        }
      </style>
      <div id="fallback-columns"><p id="fragmented-dropcap"></p></div>
      <p id="unequal-fragments"></p>
    `;
    const dropcap = document.getElementById("fragmented-dropcap")!;
    const unequal = document.getElementById("unequal-fragments")!;
    const prose =
      "Among the numerous advantages promised by a well constructed Union, none deserves " +
      "to be more accurately developed than its tendency to break and control the violence " +
      "of faction. ";
    dropcap.textContent = prose.repeat(5);
    unequal.textContent = prose;
    unequal.style.width = "356px";
    const nativeRects = unequal.getClientRects.bind(unequal);
    const first = nativeRects()[0]!;
    Object.defineProperty(unequal, "getClientRects", {
      configurable: true,
      value: () => [
        new DOMRect(first.x, first.y, 356, first.height),
        new DOMRect(first.x + 404, first.y, 320, first.height),
      ],
    });
    const originals = [dropcap.innerHTML, unequal.innerHTML];
    const skips = new Map<HTMLElement, string>();
    const ctl = window.__justif.justify([dropcap, unequal], {
      onSkip: (paragraph: HTMLElement, reason: string) => skips.set(paragraph, reason),
    });
    await ctl.ready;
    const output = {
      dropcapFragments: dropcap.getClientRects().length,
      dropcapEnhanced: dropcap.hasAttribute("data-justif"),
      dropcapReason: skips.get(dropcap),
      unequalEnhanced: unequal.hasAttribute("data-justif"),
      unequalReason: skips.get(unequal),
      unchanged: dropcap.innerHTML === originals[0] && unequal.innerHTML === originals[1],
    };
    ctl.destroy();
    return output;
  });

  expect(result.dropcapFragments).toBeGreaterThan(1);
  expect(result.dropcapEnhanced).toBe(false);
  expect(result.dropcapReason).toContain("fragmented");
  expect(result.dropcapReason).toContain("first-letter");
  expect(result.unequalEnhanced).toBe(false);
  expect(result.unequalReason).toContain("unequal widths");
  expect(result.unchanged).toBe(true);
});

test("floated ::first-letter drop caps use the remaining width on every intruded line", async ({
  page,
}) => {
  const original = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-fixture,
      #dropcap-control,
      #dropcap-punctuation {
        width: 356px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-fixture::first-letter,
      #dropcap-punctuation::first-letter {
        float: left;
        padding-right: 6px;
        font-size: 70px;
        line-height: 0.8;
      }
    `;
    document.head.append(style);

    const p = document.createElement("p");
    p.id = "dropcap-fixture";
    p.textContent =
      "Among the numerous advantages promised by a well constructed Union, " +
      "none deserves to be more accurately developed than its tendency to " +
      "break and control the violence of faction.";
    const control = document.createElement("p");
    control.id = "dropcap-control";
    control.textContent = p.textContent;
    const punctuation = document.createElement("p");
    punctuation.id = "dropcap-punctuation";
    punctuation.textContent =
      "Among the numerous advantages promised by a well constructed Union, " +
      "extraordinarily careful setting keeps punctuation in the margin.";
    const text = p.textContent;
    const punctuationText = punctuation.firstChild as Text;
    const commaAt = punctuationText.data.indexOf("Union,") + "Union".length;
    const nativeBeforeComma = document.createRange();
    nativeBeforeComma.setStart(punctuationText, commaAt - 1);
    nativeBeforeComma.setEnd(punctuationText, commaAt);
    const nativeComma = document.createRange();
    nativeComma.setStart(punctuationText, commaAt);
    nativeComma.setEnd(punctuationText, commaAt + 1);
    const nativeCommaGap =
      nativeComma.getBoundingClientRect().left - nativeBeforeComma.getBoundingClientRect().right;
    document.getElementById("host")!.replaceChildren(p, control, punctuation);
    const before = [p.outerHTML, control.outerHTML, punctuation.outerHTML];
    const box = p.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(p.firstChild!, 1);
    range.setEnd(p.firstChild!, p.firstChild!.textContent!.length);
    const nativeLines: Array<{ top: number; left: number }> = [];
    for (const rect of range.getClientRects()) {
      let line = nativeLines.find((candidate) => Math.abs(candidate.top - rect.top) < 10);
      if (line === undefined) {
        line = { top: rect.top, left: rect.left };
        nativeLines.push(line);
      } else {
        line.left = Math.min(line.left, rect.left);
      }
    }
    nativeLines.sort((a, b) => a.top - b.top);
    let nativeIntruded = 0;
    for (const line of nativeLines) {
      if (line.left > box.left + 40) nativeIntruded++;
      else break;
    }
    window.__justif.controller = window.__justif.justify([p, control, punctuation], {
      onSkip: (_paragraph: HTMLElement, reason: string) => {
        p.dataset.skipReason = reason;
      },
    });
    return { html: before, text, nativeIntruded, nativeCommaGap };
  });
  await page.evaluate(() => window.__justif.controller!.ready);
  await waitForQuiescence(page, "#dropcap-fixture");

  const result = await page.evaluate(() => {
    const p = document.getElementById("dropcap-fixture")!;
    const control = document.getElementById("dropcap-control")!;
    const punctuation = document.getElementById("dropcap-punctuation")!;
    const box = p.getBoundingClientRect();
    const controlBox = control.getBoundingClientRect();
    const lines = [...p.querySelectorAll<HTMLElement>(":scope > .justif-seg")].map((segment) => {
      const rect = segment.getBoundingClientRect();
      return { left: rect.left, right: rect.right, text: segment.textContent };
    });
    const commaAt = punctuation.textContent!.indexOf("Union,") + "Union".length;
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(punctuation, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      textNodes.push(node as Text);
    }
    const pointAt = (offset: number): { node: Text; offset: number } => {
      let seen = 0;
      for (const node of textNodes) {
        if (offset <= seen + node.data.length) return { node, offset: offset - seen };
        seen += node.data.length;
      }
      const node = textNodes[textNodes.length - 1]!;
      return { node, offset: node.data.length };
    };
    const beforeStart = pointAt(commaAt - 1);
    const commaStart = pointAt(commaAt);
    const commaEnd = pointAt(commaAt + 1);
    const beforeComma = document.createRange();
    beforeComma.setStart(beforeStart.node, beforeStart.offset);
    beforeComma.setEnd(commaStart.node, commaStart.offset);
    const comma = document.createRange();
    comma.setStart(commaStart.node, commaStart.offset);
    comma.setEnd(commaEnd.node, commaEnd.offset);
    const beforeCommaRect = beforeComma.getBoundingClientRect();
    const commaRect = comma.getBoundingClientRect();
    const hangingEnd = [...punctuation.querySelectorAll<HTMLElement>(".justif-hanging-end")].find(
      (el) => el.textContent === ",",
    ) ?? null;
    const physicalHang =
      hangingEnd === null
        ? 0
        : (parseFloat(getComputedStyle(hangingEnd.parentElement!).letterSpacing) || 0) -
          (parseFloat(getComputedStyle(hangingEnd).letterSpacing) || 0);
    return {
      enhanced: p.hasAttribute("data-justif"),
      skipReason: p.dataset.skipReason,
      text: p.textContent,
      floatedText: p.querySelector(".justif-float-source")?.textContent,
      hangingCommaRight: commaRect.right + physicalHang,
      commaGap: commaRect.left - beforeCommaRect.right,
      physicalHang,
      punctuationRight: punctuation.getBoundingClientRect().right,
      left: box.left,
      right: box.right,
      lines,
      control: {
        right: controlBox.right,
        lines: [...control.querySelectorAll<HTMLElement>(":scope > .justif-seg")].map(
          (segment) => ({
            right: segment.getBoundingClientRect().right,
            text: segment.textContent,
            allowance: Math.max(0, -(parseFloat(segment.style.marginInlineEnd) || 0)),
          }),
        ),
      },
    };
  });

  expect(result.enhanced).toBe(true);
  expect(result.skipReason).toBeUndefined();
  expect(result.text).toBe(original.text);
  // The floated source stays outside the nowrap measurement span and is a
  // real float, avoiding engine-specific ::first-letter line-box behavior.
  expect(result.floatedText).toBe("A");
  expect(result.physicalHang).toBeGreaterThan(0.5);
  expect(result.hangingCommaRight).toBeGreaterThan(result.punctuationRight + 0.5);
  // Splitting the final grapheme into its own CSS spacing unit can change a
  // sub-pixel boundary rect, but must not introduce a visible hanging gap.
  expect(Math.abs(result.commaGap - original.nativeCommaGap)).toBeLessThan(1.1);
  expect(result.lines.length).toBeGreaterThan(3);
  // Engines differ in the exact first-letter line box (Firefox overlaps two
  // lines here; Chromium/WebKit overlap three). Every line the native float
  // intrudes must stay beside it and set flush to the ordinary right edge.
  expect(original.nativeIntruded).toBeGreaterThanOrEqual(2);
  for (const [i, line] of result.lines.slice(0, original.nativeIntruded).entries()) {
    expect.soft(line.left, `intruded line ${i + 1} starts beside the float`).toBeGreaterThan(
      result.left + 40,
    );
    expect.soft(line.right, `intruded line ${i + 1} does not overflow`).toBeLessThanOrEqual(
      result.right + 0.5,
    );
    expect.soft(result.right - line.right, `intruded line ${i + 1} remains justified`).toBeLessThan(
      2,
    );
  }
  expect(result.lines[original.nativeIntruded]!.left).toBeLessThan(result.left + 1);
  for (const line of result.control.lines.slice(0, -1)) {
    const expectedRight = result.control.right + line.allowance;
    expect
      .soft(line.right - expectedRight, `control line "${line.text}" has no false overflow`)
      .toBeLessThanOrEqual(0.75);
    expect
      .soft(expectedRight - line.right, `control line "${line.text}" remains set flush`)
      .toBeLessThanOrEqual(0.75);
  }

  await page.evaluate(() => {
    document.getElementById("dropcap-fixture")!.style.width = "300px";
  });
  await waitForQuiescence(page, "#dropcap-fixture");
  const resized = await page.evaluate(() => {
    const p = document.getElementById("dropcap-fixture")!;
    const box = p.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      lines: [...p.querySelectorAll<HTMLElement>(":scope > .justif-seg")].map((segment) => {
        const rect = segment.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    };
  });
  for (const [i, line] of resized.lines.slice(0, original.nativeIntruded).entries()) {
    expect.soft(line.left, `resized intruded line ${i + 1} starts beside the float`).toBeGreaterThan(
      resized.left + 40,
    );
    expect.soft(line.right, `resized intruded line ${i + 1} does not overflow`).toBeLessThanOrEqual(
      resized.right + 0.5,
    );
  }
  expect(resized.lines[original.nativeIntruded]!.left).toBeLessThan(resized.left + 1);

  const restored = await page.evaluate(() => {
    document.getElementById("dropcap-fixture")!.style.width = "";
    window.__justif.controller!.destroy();
    return [
      document.getElementById("dropcap-fixture")!.outerHTML,
      document.getElementById("dropcap-control")!.outerHTML,
      document.getElementById("dropcap-punctuation")!.outerHTML,
    ];
  });
  expect(restored).toEqual(original.html);
});

test("a drop cap wider than its column stays native and recovers after resize", async ({ page }) => {
  const originalText = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-squeezed {
        width: 40px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-squeezed::first-letter {
        float: left;
        padding-right: 6px;
        font-size: 70px;
        line-height: 0.8;
      }
    `;
    document.head.append(style);
    const p = document.createElement("p");
    p.id = "dropcap-squeezed";
    p.textContent =
      "Among the numerous advantages promised by a well constructed Union, " +
      "none deserves to be more accurately developed.";
    document.getElementById("host")!.replaceChildren(p);
    window.__justif.controller = window.__justif.justify(p);
    return p.textContent;
  });
  await page.evaluate(() => window.__justif.controller!.ready);

  expect(await page.locator("#dropcap-squeezed[data-justif]").count()).toBe(0);
  expect(await page.locator("#dropcap-squeezed .justif-seg").count()).toBe(0);

  await page.evaluate(() => {
    document.getElementById("dropcap-squeezed")!.style.width = "356px";
  });
  await page.waitForFunction(() =>
    document.getElementById("dropcap-squeezed")!.hasAttribute("data-justif"),
  );
  await waitForQuiescence(page, "#dropcap-squeezed");
  expect(await page.locator("#dropcap-squeezed .justif-float-source").textContent()).toBe("A");
  expect(await page.locator("#dropcap-squeezed .justif-seg").count()).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.getElementById("dropcap-squeezed")!.style.width = "40px";
  });
  await page.waitForFunction(() =>
    !document.getElementById("dropcap-squeezed")!.hasAttribute("data-justif"),
  );
  const restored = await page.evaluate(() => {
    const p = document.getElementById("dropcap-squeezed")!;
    const result = {
      text: p.textContent,
      segments: p.querySelectorAll(".justif-seg, .justif-float-source").length,
    };
    window.__justif.controller!.destroy();
    return result;
  });
  expect(restored).toEqual({ text: originalText, segments: 0 });
});

test("drop-cap paragraphs with CSS hyphens: auto wrap beside the float", async ({ page }) => {
  // Chromium's beside-float fit test stops hanging the trailing break
  // space under `hyphens: auto`, pushing every intruded line below the
  // float. The enhancement neutralizes the property (inert in the
  // enhanced DOM anyway), so both paragraphs must render identically.
  const original = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-hyphens-auto,
      #dropcap-hyphens-control {
        width: 367px;
        margin: 0;
        font: 18.66px/25.75px Georgia, serif;
        text-align: justify;
      }
      #dropcap-hyphens-auto {
        hyphens: auto;
        -webkit-hyphens: auto;
      }
      #dropcap-hyphens-auto::first-letter,
      #dropcap-hyphens-control::first-letter {
        float: left;
        font-size: 3.85em;
        line-height: 0.74;
        margin: 0.03em 0.08em 0 0;
      }
    `;
    document.head.append(style);
    const text =
      "Among the numerous advantages promised by a well constructed Union, " +
      "none deserves to be more accurately developed than its tendency to " +
      "break and control the violence of faction.";
    const auto = document.createElement("p");
    auto.id = "dropcap-hyphens-auto";
    auto.lang = "en";
    auto.textContent = text;
    const control = document.createElement("p");
    control.id = "dropcap-hyphens-control";
    control.textContent = text;
    document.getElementById("host")!.replaceChildren(auto, control);
    const html = [auto.outerHTML, control.outerHTML];
    window.__justif.controller = window.__justif.justify([auto, control]);
    return html;
  });
  await page.evaluate(() => window.__justif.controller!.ready);
  await waitForQuiescence(page);

  const result = await page.evaluate(() => {
    // Segment/hyphen rects only: the floated source glyph's tall rect
    // would otherwise cluster as its own visual line.
    const read = (id: string) => {
      const p = document.getElementById(id)!;
      const box = p.getBoundingClientRect();
      const lines: Array<{ top: number; left: number; right: number }> = [];
      for (const el of p.querySelectorAll(".justif-seg, .justif-hyphen")) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0) continue;
        const line = lines.find((candidate) => Math.abs(candidate.top - r.top) < 6);
        if (line === undefined) lines.push({ top: r.top, left: r.left, right: r.right });
        else {
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
        }
      }
      lines.sort((a, b) => a.top - b.top);
      return {
        enhanced: p.hasAttribute("data-justif"),
        right: box.right,
        lines: lines.map((l) => ({ left: l.left - box.left, right: l.right })),
      };
    };
    return {
      auto: read("dropcap-hyphens-auto"),
      control: read("dropcap-hyphens-control"),
    };
  });
  expect(result.auto.enhanced).toBe(true);
  expect(result.control.enhanced).toBe(true);
  const intrudedOf = (lines: Array<{ left: number }>): number => {
    let n = 0;
    for (const line of lines) {
      if (line.left > 40) n++;
      else break;
    }
    return n;
  };
  const controlIntruded = intrudedOf(result.control.lines);
  expect(controlIntruded).toBeGreaterThanOrEqual(2);
  // The hyphens: auto paragraph wraps the float exactly like the control.
  expect(intrudedOf(result.auto.lines)).toBe(controlIntruded);
  expect(result.auto.lines.length).toBe(result.control.lines.length);
  for (const [i, line] of result.auto.lines.entries()) {
    expect
      .soft(line.left, `line ${i + 1} starts where the control's does`)
      .toBeCloseTo(result.control.lines[i]!.left, 0);
  }
  for (const [i, line] of result.auto.lines.slice(0, controlIntruded).entries()) {
    expect
      .soft(line.right, `intruded line ${i + 1} does not overflow`)
      .toBeLessThanOrEqual(result.auto.right + 0.5);
    expect
      .soft(result.auto.right - line.right, `intruded line ${i + 1} remains justified`)
      .toBeLessThan(2);
  }

  const restored = await page.evaluate(() => {
    window.__justif.controller!.destroy();
    return [
      document.getElementById("dropcap-hyphens-auto")!.outerHTML,
      document.getElementById("dropcap-hyphens-control")!.outerHTML,
    ];
  });
  expect(restored).toEqual(original);
});

test("a line that hyphenates at the float boundary stays beside the drop cap", async ({
  page,
}) => {
  // Engines judge a line's fit beside a float from its raw typographic
  // width, ignoring end margins — an inserted hyphen's optical hang must
  // be physically removed from the pseudo-hyphen's advance, or the whole
  // hyphen-ended line drops below the float at its narrow measure.
  const original = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-hyphenated {
        width: 367px;
        margin: 0;
        font: 18.66px/25.75px Georgia, serif;
        text-align: justify;
        hyphens: manual;
      }
      #dropcap-hyphenated::first-letter {
        float: left;
        font-size: 3.85em;
        line-height: 0.74;
        margin: 0.03em 0.08em 0 0;
      }
    `;
    document.head.append(style);
    const p = document.createElement("p");
    p.id = "dropcap-hyphenated";
    p.textContent =
      "When the people of America reflect that they are now called upon to " +
      "decide a question, which, in its consequences, must prove one of the " +
      "most important that ever engaged their attention, the propriety of " +
      "their taking a very comprehensive, as well as a very serious, view " +
      "of it, will be evident.";
    document.getElementById("host")!.replaceChildren(p);
    const html = p.outerHTML;
    const box = p.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(p.firstChild!, 1);
    range.setEnd(p.firstChild!, p.firstChild!.textContent!.length);
    const nativeLines: Array<{ top: number; left: number }> = [];
    for (const rect of range.getClientRects()) {
      let line = nativeLines.find((candidate) => Math.abs(candidate.top - rect.top) < 10);
      if (line === undefined) {
        line = { top: rect.top, left: rect.left };
        nativeLines.push(line);
      } else {
        line.left = Math.min(line.left, rect.left);
      }
    }
    nativeLines.sort((a, b) => a.top - b.top);
    let nativeIntruded = 0;
    for (const line of nativeLines) {
      if (line.left > box.left + 40) nativeIntruded++;
      else break;
    }
    window.__justif.controller = window.__justif.justify(p, {
      hyphenate: window.__justif.hyphenateEnUS,
    });
    return { html, nativeIntruded };
  });
  await page.evaluate(() => window.__justif.controller!.ready);
  await waitForQuiescence(page, "#dropcap-hyphenated");

  const result = await page.evaluate(() => {
    const p = document.getElementById("dropcap-hyphenated")!;
    const box = p.getBoundingClientRect();
    // Segment/hyphen rects only: the floated source glyph's tall rect
    // would otherwise cluster as its own visual line.
    const lines: Array<{ top: number; left: number; right: number; hyphenEnded: boolean }> =
      [];
    for (const el of p.querySelectorAll(".justif-seg, .justif-hyphen")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const isHyphen = el.classList.contains("justif-hyphen");
      const line = lines.find((candidate) => Math.abs(candidate.top - r.top) < 6);
      if (line === undefined) {
        lines.push({ top: r.top, left: r.left, right: r.right, hyphenEnded: isHyphen });
      } else {
        line.left = Math.min(line.left, r.left);
        if (r.right > line.right) {
          line.right = r.right;
          line.hyphenEnded = isHyphen;
        }
      }
    }
    lines.sort((a, b) => a.top - b.top);
    return {
      enhanced: p.hasAttribute("data-justif"),
      right: box.right,
      lines: lines.map((l) => ({
        left: l.left - box.left,
        right: l.right,
        hyphenEnded: l.hyphenEnded,
      })),
    };
  });
  expect(result.enhanced).toBe(true);
  expect(original.nativeIntruded).toBeGreaterThanOrEqual(2);
  // The enhanced paragraph may keep one more narrow line than the native
  // rendering showed (the scan takes the float-geometry prediction when it
  // exceeds the observed count) — never fewer, and never all of them.
  let enhancedIntruded = 0;
  for (const line of result.lines) {
    if (line.left > 40) enhancedIntruded++;
    else break;
  }
  expect(enhancedIntruded).toBeGreaterThanOrEqual(original.nativeIntruded);
  expect(enhancedIntruded).toBeLessThan(result.lines.length);
  const intruded = result.lines.slice(0, enhancedIntruded);
  // The scenario must actually exercise the hyphen-at-the-boundary path:
  // with these metrics every engine hyphenates at least one intruded line.
  expect(intruded.some((line) => line.hyphenEnded)).toBe(true);
  for (const [i, line] of intruded.entries()) {
    expect
      .soft(line.right, `intruded line ${i + 1} does not overflow`)
      .toBeLessThanOrEqual(result.right + 0.5);
    expect
      .soft(result.right - line.right, `intruded line ${i + 1} remains justified`)
      .toBeLessThan(2);
  }
  // The first line past the float returns to the full measure.
  expect(result.lines[enhancedIntruded]!.left).toBeLessThan(1);

  const restored = await page.evaluate(() => {
    window.__justif.controller!.destroy();
    return document.getElementById("dropcap-hyphenated")!.outerHTML;
  });
  expect(restored).toBe(original.html);
});

test("multi-run first letters retain each source run's inherited styling", async ({ page }) => {
  const original = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-styled {
        width: 356px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-styled::first-letter {
        float: left;
        padding-right: 6px;
        font-size: 70px;
        line-height: 0.8;
      }
      #dropcap-styled .opening { color: rgb(180, 0, 0); font-style: italic; }
      #dropcap-styled .initial { color: rgb(0, 0, 180); font-weight: 700; }
    `;
    document.head.append(style);
    const p = document.createElement("p");
    p.id = "dropcap-styled";
    p.innerHTML =
      '<span class="opening">“</span><span class="initial">A</span>mong the numerous ' +
      "advantages promised by a well constructed Union, none deserves to be more accurately " +
      "developed than its tendency to break and control the violence of faction.";
    document.getElementById("host")!.replaceChildren(p);
    const before = p.outerHTML;
    window.__justif.controller = window.__justif.justify(p);
    return before;
  });
  await page.evaluate(() => window.__justif.controller!.ready);
  await waitForQuiescence(page, "#dropcap-styled");

  const rendered = await page.evaluate(() => {
    const p = document.getElementById("dropcap-styled")!;
    const fragments = [
      ...p.querySelectorAll<HTMLElement>(".justif-float-source > .justif-float-fragment"),
    ];
    return {
      floatText: p.querySelector(".justif-float-source")?.textContent,
      fragments: fragments.map((fragment) => {
        const style = getComputedStyle(fragment);
        return {
          text: fragment.textContent,
          color: style.color,
          fontStyle: style.fontStyle,
          fontWeight: style.fontWeight,
        };
      }),
    };
  });
  expect(rendered.floatText).toBe("“A");
  expect(rendered.fragments.map((fragment) => fragment.text)).toEqual(["“", "A"]);
  expect(rendered.fragments[0]).toMatchObject({
    color: "rgb(180, 0, 0)",
    fontStyle: "italic",
  });
  expect(rendered.fragments[1]).toMatchObject({
    color: "rgb(0, 0, 180)",
    fontWeight: "700",
  });

  const restored = await page.evaluate(() => {
    window.__justif.controller!.destroy();
    return document.getElementById("dropcap-styled")!.outerHTML;
  });
  expect(restored).toBe(original);
});

test("logical drop-cap floats are modeled and unsafe inline first letters stay native", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-logical,
      #first-letter-inline,
      #first-letter-strong {
        width: 356px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-logical::first-letter {
        float: inline-start;
        padding-inline-end: 6px;
        font-size: 70px;
        line-height: 0.8;
      }
      #first-letter-inline::first-letter { font-size: 4em; }
    `;
    document.head.append(style);
    const prose =
      "Among the numerous advantages promised by a well constructed Union, " +
      "none deserves to be more accurately developed than its tendency to break and control " +
      "the violence of faction.";
    const logical = document.createElement("p");
    logical.id = "dropcap-logical";
    logical.textContent = prose;
    const inline = document.createElement("p");
    inline.id = "first-letter-inline";
    inline.textContent = prose;
    const strong = document.createElement("p");
    strong.id = "first-letter-strong";
    strong.innerHTML = `<strong>Among</strong>${prose.slice("Among".length)}`;
    document.getElementById("host")!.replaceChildren(logical, inline, strong);
    const skipped = new Map<HTMLElement, string>();
    const controller = window.__justif.justify([logical, inline, strong], {
      onSkip(paragraph: HTMLElement, reason: string) {
        skipped.set(paragraph, reason);
      },
    });
    await controller.ready;
    const paragraphRect = logical.getBoundingClientRect();
    const floatRect = logical
      .querySelector<HTMLElement>(".justif-float-source")!
      .getBoundingClientRect();
    const firstLineRect = logical
      .querySelector<HTMLElement>(":scope > .justif-seg")!
      .getBoundingClientRect();
    const out = {
      logical: {
        enhanced: logical.hasAttribute("data-justif"),
        floatText: logical.querySelector(".justif-float-source")?.textContent,
        floatAtStart: floatRect.left < paragraphRect.left + 1,
        textBesideFloat: firstLineRect.left > floatRect.right - 1,
      },
      inline: {
        enhanced: inline.hasAttribute("data-justif"),
        segments: inline.querySelectorAll(".justif-seg").length,
        reason: skipped.get(inline),
      },
      strong: {
        enhanced: strong.hasAttribute("data-justif"),
        reason: skipped.get(strong),
      },
    };
    controller.destroy();
    return out;
  });
  expect(result.logical).toEqual({
    enhanced: true,
    floatText: "A",
    floatAtStart: true,
    textBesideFloat: true,
  });
  expect(result.inline).toEqual({
    enhanced: false,
    segments: 0,
    reason: "layout-changing non-floated ::first-letter",
  });
  // A source inline's own bold font is represented by an ordinary run;
  // it must not be mistaken for pseudo-only first-letter styling.
  expect(result.strong).toEqual({ enhanced: true, reason: undefined });
});

test("refresh re-reads native drop-cap overlap geometry", async ({ page }) => {
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-refresh {
        width: 356px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-refresh::first-letter {
        float: left;
        padding-right: 6px;
        font-size: 70px;
        line-height: 0.6;
      }
      #dropcap-refresh.tall::first-letter {
        font-size: 130px;
        line-height: 1.2;
      }
    `;
    document.head.append(style);
    const p = document.createElement("p");
    p.id = "dropcap-refresh";
    p.textContent =
      "Among the numerous advantages promised by a well constructed Union, " +
      "none deserves to be more accurately developed than its tendency to break and control " +
      "the violence of faction. The value of accurate native geometry becomes clearest when " +
      "the drop cap itself changes after the initial enhancement.";
    document.getElementById("host")!.replaceChildren(p);
    window.__justif.controller = window.__justif.justify(p);
    await window.__justif.controller.ready;
  });
  await waitForQuiescence(page, "#dropcap-refresh");

  const intrudedLines = () =>
    page.evaluate(() => {
      const p = document.getElementById("dropcap-refresh")!;
      const left = p.getBoundingClientRect().left;
      let count = 0;
      for (const segment of p.querySelectorAll<HTMLElement>(":scope > .justif-seg")) {
        if (segment.getBoundingClientRect().left <= left + 40) break;
        count++;
      }
      return count;
    });
  const before = await intrudedLines();
  await page.evaluate(() => {
    const p = document.getElementById("dropcap-refresh")!;
    p.classList.add("tall");
    window.__justif.controller!.refresh();
  });
  await waitForQuiescence(page, "#dropcap-refresh");
  const after = await intrudedLines();
  expect(before).toBeGreaterThan(0);
  expect(after).toBeGreaterThan(before);
});

test("lastLineMinWidth: 1 justifies paragraph endings flush (rectangular paragraphs)", async ({ page }) => {
  // Control: with the option explicitly OFF (it defaults to 0.33 now) at
  // least one fixture ending must be genuinely short, or the flush
  // assertions below would pass vacuously.
  await enhance(page, {
    hyphenate: true,
    protrusion: false,
    hangingPunctuation: "none",
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
    hangingPunctuation: "none",
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
      hangingPunctuation: "none",
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
      hangingPunctuation: "none",
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
        hangingPunctuation: "none",
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
    const enhancedBr = byId.get("br")!.hasAttribute("data-justif");
    ctl.destroy();
    for (const el of byId.values()) el.remove();
    return { skips, enhancedFine, enhancedBr };
  });
  expect(reasons.enhancedFine).toBe(true);
  expect(reasons.enhancedBr).toBe(true);
  expect(reasons.skips["fine"]).toBeUndefined();
  expect(reasons.skips["br"]).toBeUndefined();
  expect(reasons.skips["margin"]).toContain("margin");
  expect(reasons.skips["transform"]).toContain("text-transform");
  expect(reasons.skips["stretch"]).toContain("font-stretch");
});

test("hard breaks retain native structure, empty lines, and trailing-break height", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.style.cssText = "width:520px;line-height:24px;margin:0;text-align-last:center";
    p.innerHTML =
      '<span id="hard-break-inline" style="padding:0 3px;border:1px solid transparent">' +
      'Alpha beta gamma <br data-token="kept"> delta epsilon zeta.</span>' +
      "<br><br>Tail.<br>";
    document.getElementById("host")!.append(p);
    const originalHTML = p.innerHTML;
    const nativeText = p.innerText;
    const nativeHeight = p.getBoundingClientRect().height;

    const ctl = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
    });
    await ctl.ready;
    const enhancedHTML = p.innerHTML;
    const enhancedHeight = p.getBoundingClientRect().height;
    const segmentTexts = [...p.querySelectorAll<HTMLElement>(".justif-seg")].map(
      (segment) => segment.textContent ?? "",
    );
    const output = {
      enhanced: p.hasAttribute("data-justif"),
      brCount: p.querySelectorAll("br").length,
      markedNested:
        p.querySelector("#hard-break-inline > br[data-token=kept]") !== null,
      nativeText,
      enhancedText: p.innerText,
      textAlignLast: getComputedStyle(p).textAlignLast,
      nativeHeight,
      enhancedHeight,
      trailingSpaceInSegment: segmentTexts.some((text) => /\s$/.test(text)),
      enhancedHTML,
    };
    ctl.destroy();
    return {
      ...output,
      restoredHTML: p.innerHTML,
      originalHTML,
    };
  });

  expect(result.enhanced).toBe(true);
  expect(result.brCount).toBe(4);
  expect(result.markedNested).toBe(true);
  expect(result.enhancedText).toBe(result.nativeText);
  expect(result.textAlignLast).toBe("center");
  expect(result.enhancedHeight).toBeCloseTo(result.nativeHeight, 1);
  expect(result.trailingSpaceInSegment).toBe(false);
  expect(result.enhancedHTML).not.toBe(result.originalHTML);
  expect(result.restoredHTML).toBe(result.originalHTML);
});

test("author NBSP indentation stays fixed when a hard-break segment soft-wraps", async ({
  page,
}) => {
  const sourceText = await page.evaluate(async () => {
    await document.fonts.load('16px "Junicode"');
    const p = document.createElement("p");
    p.id = "hard-break-author-nbsp";
    // Keep the first correction parked so the test observes the provisional
    // DOM too. Scrolling it into view below promotes the measured correction.
    p.style.cssText =
      'width:160px;margin:3000px 0 0;font:16px/1.45 "Junicode",Georgia,serif;' +
      "text-align:justify;padding:0;border:0";
    p.innerHTML =
      "Prelude.<br data-hard>" +
      "\u00A0\u00A0\u00A0\u00A0With gently smiling jaws!”";
    document.getElementById("host")!.replaceChildren(p);
    const sourceText = p.innerText;
    const j = window.__justif;
    j.controller = j.justify(p, { hyphenate: j.hyphenateEnUS });
    await j.controller.ready;
    return sourceText;
  });

  const readState = () =>
    page.evaluate(() => {
      const p = document.getElementById("hard-break-author-nbsp")!;
      const rectOf = (needle: string): DOMRect => {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const at = (node.nodeValue ?? "").indexOf(needle);
          if (at < 0) continue;
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          return range.getBoundingClientRect();
        }
        throw new Error(`missing text: ${needle}`);
      };
      const box = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const contentLeft =
        box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const withRect = rectOf("With");
      const jawsRect = rectOf("jaws!”");
      const fixed = [...p.querySelectorAll<HTMLElement>(".justif-seg")].find((segment) =>
        (segment.textContent ?? "").startsWith("\u00A0\u00A0\u00A0\u00A0With"),
      )!;
      const adjustable = [...p.querySelectorAll<HTMLElement>(".justif-seg")].find(
        (segment) => (segment.textContent ?? "").includes("gently smiling"),
      )!;
      return {
        enhanced: p.hasAttribute("data-justif"),
        brCount: p.querySelectorAll("br[data-hard]").length,
        lines: window.__justifLines(p).lines.length,
        renderedText: p.innerText,
        indent: withRect.left - contentLeft,
        nextLineDelta: jawsRect.top - withRect.top,
        fixedText: fixed.textContent,
        fixedWordSpacing: parseFloat(getComputedStyle(fixed).wordSpacing),
        adjustableWordSpacing: parseFloat(getComputedStyle(adjustable).wordSpacing),
      };
    });

  const provisional = await readState();

  await page.locator("#hard-break-author-nbsp").evaluate((p) => p.scrollIntoView());
  await page.waitForFunction(() => {
    const segments = [
      ...document.querySelectorAll<HTMLElement>("#hard-break-author-nbsp .justif-seg"),
    ];
    // Wait for the soft wrap to have happened; the settling itself is what
    // waitForQuiescence below is for. This used to require a zero end margin,
    // which stopped being true once protrusion was measured from the font — a
    // line ending mid-sentence now carries its own small hang.
    return segments.some((segment) => (segment.textContent ?? "").includes("gently smiling"));
  });
  await waitForQuiescence(page, "#hard-break-author-nbsp");

  const settled = await readState();

  for (const state of [provisional, settled]) {
    expect.soft(state.enhanced).toBe(true);
    expect.soft(state.brCount).toBe(1);
    expect.soft(state.lines).toBe(3); // prelude + two internally wrapped verse lines
    expect.soft(state.renderedText).toBe(sourceText);
    expect.soft(state.fixedText).toBe("\u00A0\u00A0\u00A0\u00A0With");
    expect.soft(state.fixedWordSpacing).toBeCloseTo(0, 3);
    expect.soft(state.adjustableWordSpacing).toBeGreaterThan(1);
    expect.soft(state.indent).toBeGreaterThan(12);
    expect.soft(state.indent).toBeLessThan(30);
    expect.soft(state.nextLineDelta).toBeGreaterThan(10);
  }
});

test("author NBSP and NNBSP boxes keep authored spacing and inline ancestry", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "author-no-break-boxes";
    p.style.cssText = "width:245px;word-spacing:2px";
    p.innerHTML =
      "The reference <em>Fig.\u00A07</em> stays intact while the numbered note " +
      "No.\u202F12 remains together in justified prose across several ordinary lines.";
    document.getElementById("host")!.replaceChildren(p);
    const j = window.__justif;
    j.controller = j.justify(p, { hyphenate: j.hyphenateEnUS });
    await j.controller.ready;
  });
  await waitForQuiescence(page, "#author-no-break-boxes");

  const result = await page.evaluate(() => {
    const p = document.getElementById("author-no-break-boxes")!;
    const fixed = [...p.querySelectorAll<HTMLElement>(".justif-seg")]
      .filter((segment) => /[\u00A0\u202F]/.test(segment.textContent ?? ""))
      .map((segment) => ({
        text: segment.textContent,
        wordSpacing: parseFloat(getComputedStyle(segment).wordSpacing),
        parent: segment.parentElement?.tagName,
      }));
    const rectCount = (needle: string): number => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.nodeValue ?? "").indexOf(needle);
        if (at < 0) continue;
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        return range.getClientRects().length;
      }
      return 0;
    };
    return {
      fixed,
      emCount: p.querySelectorAll("em").length,
      nbspRects: rectCount("Fig.\u00A07"),
      narrowRects: rectCount("No.\u202F12"),
    };
  });

  expect(result.fixed).toEqual([
    { text: "Fig.\u00A07", wordSpacing: 2, parent: "EM" },
    { text: "No.\u202F12", wordSpacing: 2, parent: "P" },
  ]);
  expect(result.emCount).toBe(1);
  expect(result.nbspRects).toBe(1);
  expect(result.narrowRects).toBe(1);
});

test("a divergent-NBSP font's run-boundary space renders one space wide", async ({
  page,
}) => {
  // The space at a styling-run boundary renders as U+00A0 so the boundary can
  // never become a stray wrap point, and the model prices it as an ordinary
  // space. Charter, Hoefler Text, Geneva and Skia each give U+00A0 an advance
  // of its own, and the boundary then reads as a hole (or a collision) while
  // the corrective pass pays for it out of every other gap on the line.
  // #nbsp-host carries the font stack. WebKit renders U+00A0 with the space
  // glyph outright — canvas and DOM agree there, nothing to correct, skip.
  const surplus = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById("p-nbsp")!);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    const gap = (separator: string): number =>
      ctx.measureText(`n${separator}n`).width - 2 * ctx.measureText("n").width;
    return gap("\u00A0") - gap(" ");
  });
  test.skip(Math.abs(surplus) < 1, "no font here gives U+00A0 an advance of its own");

  await enhance(page, {}, "#nbsp-host p");
  await waitForQuiescence(page, "#nbsp-host");

  const measured = await page.evaluate(() => {
    const segments = [...document.querySelectorAll<HTMLElement>("#nbsp-host .justif-seg")];
    const range = document.createRange();
    for (let i = 1; i < segments.length; i++) {
      const text = segments[i]!.textContent ?? "";
      // An interior space of the SAME segment is the exact comparison: it
      // carries this segment's word-spacing and letter-spacing too, so only
      // the two separators' glyph advances differ.
      const interior = text.indexOf(" ", 1);
      if (text.charCodeAt(0) !== 0xa0 || interior < 0) continue;
      const node = segments[i]!.firstChild as Text;
      const previous = segments[i - 1]!.getBoundingClientRect();
      range.setStart(node, 1);
      range.setEnd(node, 2);
      const afterBoundary = range.getBoundingClientRect();
      // A boundary the breaker turned into a line break renders no NBSP gap.
      if (Math.abs(afterBoundary.top - previous.top) > 1) continue;
      range.setStart(node, interior);
      range.setEnd(node, interior + 1);
      return {
        boundary: afterBoundary.left - previous.right,
        interior: range.getBoundingClientRect().width,
      };
    }
    return null;
  });

  expect(measured).not.toBeNull();
  expect(measured!.boundary).toBeCloseTo(measured!.interior, 0);
});

test("fixed no-break segments preserve dash-junction word joiners on both sides", async ({
  page,
}) => {
  const sourceText = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "fixed-dash-junctions";
    p.style.width = "310px";
    p.innerHTML =
      "The entry prefix—<em>Fig.\u00A07</em> stays indivisible, while the exit " +
      "<em>No.\u202F12—</em>suffix also remains intact in justified prose.";
    document.getElementById("host")!.replaceChildren(p);
    const source = p.textContent ?? "";
    const j = window.__justif;
    j.controller = j.justify(p, { hyphenate: j.hyphenateEnUS });
    await j.controller.ready;
    return source;
  });
  await waitForQuiescence(page, "#fixed-dash-junctions");

  const result = await page.evaluate(() => {
    const p = document.getElementById("fixed-dash-junctions")!;
    const raw = p.textContent ?? "";
    return {
      raw,
      joiners: raw.match(/\u2060/g)?.length ?? 0,
      entryProtected: raw.includes("prefix—\u2060Fig.\u00A07"),
      exitProtected: raw.includes("No.\u202F12—\u2060suffix"),
      fixedSegments: [...p.querySelectorAll<HTMLElement>(".justif-seg")]
        .filter((segment) => /[\u00A0\u202F]/.test(segment.textContent ?? ""))
        .map((segment) => segment.textContent),
    };
  });

  expect(result.joiners).toBe(2);
  expect(result.entryProtected).toBe(true);
  expect(result.exitProtected).toBe(true);
  expect(result.raw.replaceAll("\u2060", "")).toBe(sourceText);
  expect(result.fixedSegments).toEqual(["\u2060Fig.\u00A07", "No.\u202F12—"]);
});

test("hidden hard breaks are ignored while clear behavior stays native", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const hidden = document.createElement("p");
    hidden.style.width = "220px";
    hidden.innerHTML =
      "Alpha beta gamma delta <br data-hidden style='display:none'> epsilon zeta eta theta " +
      "iota kappa lambda mu nu xi omicron pi rho sigma tau.";
    const clear = document.createElement("p");
    clear.style.width = "220px";
    clear.innerHTML = "Alpha beta<br style='clear:both'>gamma delta.";
    document.getElementById("host")!.append(hidden, clear);
    const hiddenText = hidden.innerText;
    const skips = new Map<HTMLElement, string>();
    const ctl = window.__justif.justify([hidden, clear], {
      lastLineMinWidth: 0,
      onSkip: (paragraph: HTMLElement, reason: string) => skips.set(paragraph, reason),
    } as object);
    await ctl.ready;
    const output = {
      hiddenEnhanced: hidden.hasAttribute("data-justif"),
      hiddenBreakCount: hidden.querySelectorAll("br").length,
      hiddenTextPreserved: hidden.innerText === hiddenText,
      hiddenSkip: skips.get(hidden),
      clearEnhanced: clear.hasAttribute("data-justif"),
      clearSkip: skips.get(clear),
    };
    ctl.destroy();
    return output;
  });

  expect(result.hiddenEnhanced).toBe(true);
  expect(result.hiddenBreakCount).toBe(0);
  expect(result.hiddenTextPreserved).toBe(true);
  expect(result.hiddenSkip).toBeUndefined();
  expect(result.clearEnhanced).toBe(false);
  expect(result.clearSkip).toContain("clear");
});

test("a leading hard break consumes first-line indentation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.style.cssText = "width:200px;text-indent:100px;line-height:24px;margin:0";
    p.innerHTML = "<br>Alpha beta gamma delta";
    document.getElementById("host")!.append(p);
    const nativeHeight = p.getBoundingClientRect().height;
    const ctl = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
    });
    await ctl.ready;
    return {
      enhanced: p.hasAttribute("data-justif"),
      brCount: p.querySelectorAll("br").length,
      textLines: window.__justifLines(p).lines.length,
      nativeHeight,
      enhancedHeight: p.getBoundingClientRect().height,
    };
  });

  expect(result.enhanced).toBe(true);
  expect(result.brCount).toBe(1);
  expect(result.textLines).toBe(1);
  expect(result.enhancedHeight).toBeCloseTo(result.nativeHeight, 1);
});

test("hard-break paragraphs re-layout on resize without losing their breaks", async ({
  page,
}) => {
  const before = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "hard-break-resize";
    p.style.width = "440px";
    p.innerHTML =
      "The first forced segment contains enough ordinary prose to choose several balanced " +
      "lines when the available measure changes.<br data-hard>" +
      "The second segment independently chooses its lines while the authored break between " +
      "the two passages remains a real element.";
    document.getElementById("host")!.replaceChildren(p);
    const sourceText = p.innerText;
    const j = window.__justif;
    j.controller = j.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
    });
    await j.controller.ready;
    return {
      lines: window.__justifLines(p).lines.length,
      sourceText,
    };
  });
  await waitForQuiescence(page, "#hard-break-resize");

  await page.evaluate(() => {
    document.getElementById("hard-break-resize")!.style.width = "230px";
  });
  await page.waitForFunction(
    (previousLines) =>
      window.__justifLines(document.getElementById("hard-break-resize")!).lines.length >
      previousLines,
    before.lines,
  );
  await waitForQuiescence(page, "#hard-break-resize");

  const after = await page.evaluate(() => {
    const p = document.getElementById("hard-break-resize")!;
    const geometry = window.__justifLines(p);
    return {
      enhanced: p.hasAttribute("data-justif"),
      brCount: p.querySelectorAll("br[data-hard]").length,
      text: p.innerText,
      lines: geometry.lines.length,
      maxOverflow: Math.max(
        ...geometry.lines.map((line) => line.right - geometry.contentRight),
      ),
    };
  });

  expect(after.enhanced).toBe(true);
  expect(after.brCount).toBe(1);
  expect(after.text).toBe(before.sourceText);
  expect(after.lines).toBeGreaterThan(before.lines);
  expect(after.maxOverflow).toBeLessThan(0.75);
});

test("hard-break segments keep their global line offset beside a drop cap", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `
      #dropcap-hard-break {
        width: 356px;
        margin: 0;
        font: 17.6px/24.3px Georgia, serif;
        text-align: justify;
      }
      #dropcap-hard-break::first-letter {
        float: left;
        padding-right: 6px;
        font-size: 70px;
        line-height: 0.8;
      }
    `;
    document.head.append(style);
    const p = document.createElement("p");
    p.id = "dropcap-hard-break";
    p.innerHTML =
      "Among friends,<br data-hard>none deserves to be more accurately developed " +
      "than the tendency to break and control the violence of faction.";
    document.getElementById("host")!.append(p);
    const ctl = window.__justif.justify(p, { lastLineMinWidth: 0 });
    await ctl.ready;
  });
  await waitForQuiescence(page, "#dropcap-hard-break");

  const result = await page.evaluate(() => {
    const p = document.getElementById("dropcap-hard-break")!;
    const box = p.getBoundingClientRect();
    const afterBreak = [...p.querySelectorAll<HTMLElement>(".justif-seg")].find((segment) =>
      (segment.textContent ?? "").trimStart().startsWith("none"),
    );
    return {
      enhanced: p.hasAttribute("data-justif"),
      brCount: p.querySelectorAll("br[data-hard]").length,
      left: box.left,
      afterBreakLeft: afterBreak?.getBoundingClientRect().left,
    };
  });

  expect(result.enhanced).toBe(true);
  expect(result.brCount).toBe(1);
  expect(result.afterBreakLeft).toBeGreaterThan(result.left + 40);
});

test("text-align-last justify sets every hard-terminated segment as a rectangle", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.style.cssText = "text-align:justify;text-align-last:justify";
    p.innerHTML =
      "Alpha beta gamma delta epsilon<br data-hard>Alpha beta gamma delta epsilon";
    document.getElementById("host")!.append(p);
    p.style.textAlignLast = "auto";
    const range = document.createRange();
    range.selectNodeContents(p.firstChild!);
    p.style.width = `${range.getBoundingClientRect().width + 10}px`;
    p.style.textAlignLast = "justify";
    const originalStyle = p.getAttribute("style");
    const ctl = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
    });
    await ctl.ready;
    const geometry = window.__justifLines(p);
    const output = {
      enhanced: p.hasAttribute("data-justif"),
      brCount: p.querySelectorAll("br[data-hard]").length,
      textAlignLast: getComputedStyle(p).textAlignLast,
      gaps: geometry.lines.map((line) => geometry.contentRight - line.right),
    };
    ctl.destroy();
    return {
      ...output,
      restoredStyle: p.getAttribute("style"),
      originalStyle,
    };
  });

  expect(result.enhanced).toBe(true);
  expect(result.brCount).toBe(1);
  expect(result.textAlignLast).toBe("left");
  expect(result.gaps).toHaveLength(2);
  for (const gap of result.gaps) expect(Math.abs(gap)).toBeLessThan(0.75);
  expect(result.restoredStyle).toBe(result.originalStyle);
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
    const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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
    // is flush at the chip's BORDER box. Lines ending in plain text keep the
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
        hangingPunctuation: "none",
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
      const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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
    const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("re-justifies for a face that starts loading after the first layout", async ({ page }) => {
  // WebKit fires `loading` for a FontFace-API load but never `loadingdone`
  // (verified in all three engines), and the initial `fonts.load()` pass only
  // covers faces already named when justify() ran. A face that arrived after
  // that therefore reached no listener at all: the paragraph kept the
  // FALLBACK's line breaks and widths indefinitely, with no event to correct
  // it. `fonts.ready` after a `loading` event is the portable signal.
  const r = await page.evaluate(async () => {
    const FACE = "JunicodeArrivesLate";
    const host = document.getElementById("host")!;
    const p = document.createElement("p");
    // The face is NOT loaded yet, so this first justifies in the fallback.
    p.style.cssText = `font-family:"${FACE}", monospace;text-align:justify;width:300px`;
    p.textContent =
      "them the that this then they there their theme thence thermal took time " +
      "these those through thought thorough threshold therefore thereafter";
    host.append(p);

    const lines = (): string[] =>
      [...p.querySelectorAll<HTMLElement>(".justif-seg")].map((s) =>
        (s.textContent ?? "").trim(),
      );

    const controller = window.__justif.justify(p, { hyphenate: undefined });
    await controller.ready;
    const beforeLoad = lines();

    // The face arrives only now — after the controller has converged once.
    const face = new FontFace(FACE, 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(face);
    await face.load();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterLoad = lines();
    controller.destroy();
    p.remove();
    return { beforeLoad, afterLoad };
  });
  // Junicode is far narrower than the monospace fallback, so a re-layout must
  // change how the words fall. Unchanged lines mean the load went unnoticed.
  expect(r.beforeLoad.length, "fixture did not produce a multi-line paragraph")
    .toBeGreaterThan(1);
  expect(r.afterLoad, "paragraph kept its fallback layout after the font arrived")
    .not.toEqual(r.beforeLoad);
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

test("measured protrusion converges on the webfont after a late load", async ({ page }) => {
  // Regression: measured tables are cached per font SPEC, which names only a
  // family — so a table measured before a webfont arrived describes the
  // FALLBACK's letterforms, and nothing in the key distinguishes the two.
  // remeasureAll() dropped the width and calibration caches on `loadingdone`
  // but not the optical one, so the library's headline pattern (justify from a
  // render-blocking script, converge when fonts land) left protrusion
  // permanently measured from Times. Both the measured cache and the composed
  // tables built from it have to go.
  // Re-layout is driven through refresh() rather than by waiting on
  // `loadingdone`, so the test isolates cache invalidation from how each
  // engine reports font loads — WebKit does not re-lay-out on its own here,
  // which affects widths as much as protrusion and is a separate concern.
  //
  // The control must come from a FRESH page: the measured-table cache is
  // module-level and survives destroy(), so a "justify with the font already
  // present" control run in the same context would read the very same stale
  // entry and agree with the bug.
  const run = async (loadFontFirst: boolean): Promise<number[]> =>
    page.evaluate(async (loadFirst) => {
      // A real face under a name nothing else has loaded, so a measurement
      // taken before it arrives necessarily sees the monospace fallback.
      const FACE = "JunicodeLateProtrusion";
      const late = new FontFace(FACE, 'url("/demo/fonts/Junicode-Roman.ttf")');
      const host = document.createElement("div");
      host.style.cssText =
        `width:300px;font:16px/1.6 "${FACE}", monospace;position:absolute;left:-9999px`;
      const p = document.createElement("p");
      p.style.cssText = "margin:0;text-align:justify";
      p.textContent = "them the that this then they there their theme thence thermal took";
      host.append(p);
      document.body.append(host);

      const settle = async (): Promise<void> => {
        document.fonts.add(late);
        await late.load();
        await document.fonts.ready;
      };
      if (loadFirst) await settle();

      const controller = window.__justif.justify([p], { hyphenate: undefined });
      await controller.ready;
      if (!loadFirst) {
        await settle();
        controller.refresh();
        await new Promise((r) => setTimeout(r, 400));
      }
      const left = p.getBoundingClientRect().left;
      const outdents = [...p.querySelectorAll<HTMLElement>(".justif-seg")]
        .slice(1)
        .map((s) => +(left - s.getBoundingClientRect().left).toFixed(2));
      controller.destroy();
      host.remove();
      return outdents;
    }, loadFontFirst);

  const converged = await run(false);
  await page.reload(); // fresh JS context ⇒ empty measured-table cache
  await page.waitForFunction(() => window.__ready === true);
  const groundTruth = await run(true);

  expect(converged, "protrusion did not converge on the late-loaded face").toEqual(groundTruth);
});

test("a paragraph's measured protrusion doesn't depend on its siblings' variants", async ({ page }) => {
  // Regression: measured tables describe a GLYPH SET, but the per-controller
  // cache of composed tables was keyed on family+weight+style only. Small caps
  // and lowercase share all three, so whichever variant a controller measured
  // first supplied the table for BOTH — a normal paragraph's protrusion moved
  // from 0.25px to 0.44px merely because a small-caps sibling shared its
  // controller. Junicode has true small caps, so the two really do measure
  // differently wherever the canvas can shape them; where it cannot (WebKit)
  // the caps run falls back to the tables, and either way each paragraph must
  // be unaffected by its siblings, which is all this asserts.
  const r = await page.evaluate(async () => {
    await document.fonts.load('16px "Junicode"');
    await document.fonts.load('small-caps 16px "Junicode"');
    const TEXT = "them the that this then they there their theme thence thermal";
    const make = (smallCaps: boolean): HTMLParagraphElement => {
      const p = document.createElement("p");
      p.style.cssText =
        `margin:0;text-align:justify${smallCaps ? ";font-variant-caps:small-caps" : ""}`;
      p.textContent = TEXT;
      return p;
    };
    // Outdents of a target paragraph, rendered either alone or beside a
    // paragraph of the other variant under the SAME controller.
    const outdents = async (smallCaps: boolean, withSibling: boolean): Promise<number[]> => {
      const host = document.createElement("div");
      host.style.cssText = 'width:300px;font:16px/1.6 "Junicode";position:absolute;left:-9999px';
      document.body.append(host);
      const target = make(smallCaps);
      const paras = withSibling ? [target, make(!smallCaps)] : [target];
      paras.forEach((p) => host.append(p));
      const controller = window.__justif.justify(paras, {
        hyphenate: undefined,
        hangingPunctuation: false,
      });
      await controller.ready;
      const left = target.getBoundingClientRect().left;
      const values = [...target.querySelectorAll<HTMLElement>(".justif-seg")]
        .slice(1) // the first line carries the paragraph indent, not a hang
        .map((s) => +(left - s.getBoundingClientRect().left).toFixed(2));
      controller.destroy();
      host.remove();
      return [...new Set(values)].sort((a, b) => a - b);
    };
    return {
      scAlone: await outdents(true, false),
      scWith: await outdents(true, true),
      normalAlone: await outdents(false, false),
      normalWith: await outdents(false, true),
    };
  });
  expect(r.scWith, "small-caps protrusion changed when a normal sibling shared the controller")
    .toEqual(r.scAlone);
  expect(r.normalWith, "normal protrusion changed when a small-caps sibling shared the controller")
    .toEqual(r.normalAlone);
});

test("measured protrusion keeps the table's non-Latin punctuation", async ({ page }) => {
  // Regression: a measured table REPLACED the generic one outright, but the
  // raster pass only forms opinions about the Latin characters it rasterizes.
  // The Arabic and Hebrew stops the generic table carries for pure-RTL
  // paragraphs have no candidate, and `protrusionCodes` has no inheritance
  // path to them either, so switching to measured values silently un-hung
  // them: an Arabic comma went from 2.3px to 0.02px. Characters the
  // measurement never examined must still fall back to the table.
  const r = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.style.cssText =
      "width:300px;font:16px/1.8 serif;position:absolute;left:-9999px;direction:rtl";
    const p = document.createElement("p");
    p.style.cssText = "margin:0;text-align:justify";
    p.setAttribute("dir", "rtl");
    p.lang = "ar";
    p.textContent =
      "الطقس لطيف اليوم، والسماء صافية تماما، ونحن سعداء؟ الاطفال يلعبون في الحديقة، ثم يعودون الى البيت مساء، وينامون باكرا؟";
    host.append(p);
    document.body.append(host);
    const controller = window.__justif.justify([p], {
      hyphenate: undefined,
      hangingPunctuation: false,
    });
    await controller.ready;
    const box = p.getBoundingClientRect();
    // Justified lines only, selected by geometry rather than by position:
    // this is RTL, so a line STARTS at the right edge and ENDS at the left,
    // and any line that stops short of the full measure is ragged and has no
    // meaningful end edge to read.
    const out = [...p.querySelectorAll<HTMLElement>(".justif-seg")]
      .map((s) => ({ text: (s.textContent ?? "").trim(), rect: s.getBoundingClientRect() }))
      .filter((s) => s.rect.width >= box.width - 2)
      .map((s): [string, number] => [s.text.slice(-1), +(box.left - s.rect.left).toFixed(2)]);
    controller.destroy();
    host.remove();
    return out;
  });
  // Whether a line actually ENDS on one of these marks depends on the engine's
  // Arabic shaping — Firefox fits this paragraph onto a single line, leaving
  // nothing to measure. Skip there rather than assert vacuously.
  const punctuated = r.filter(([end]) => "،؛؟۔".includes(end));
  test.skip(punctuated.length === 0, "engine's Arabic layout left no punctuated line end");
  // Every such line must hang its mark. Without the fall-through these read
  // ~0.02px, i.e. flush.
  for (const [end, hang] of punctuated) {
    expect(hang, `line ending '${end}' did not hang into the margin`).toBeGreaterThan(0.3);
  }
});

test("a custom protrusion table bypasses canvas pixel readback", async ({ page }) => {
  const readbacks = await page.evaluate(async () => {
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.getImageData;
    let calls = 0;
    proto.getImageData = function (...args) {
      calls++;
      return original.apply(this, args as unknown as Parameters<typeof original>);
    };
    try {
      const p = document.createElement("p");
      p.style.cssText =
        "width:240px;text-align:justify;font:17px Georgia,serif";
      p.textContent =
        "A table-backed paragraph ends with punctuation, and carries enough text " +
        "to wrap onto several measured lines.";
      document.getElementById("host")!.replaceChildren(p);
      const controller = window.__justif.justify(p, {
        expansion: false,
        tracking: false,
        protrusion: { ".": { r: 333 } },
        hangingPunctuation: "none",
      });
      await controller.ready;
      controller.destroy();
      return calls;
    } finally {
      proto.getImageData = original;
    }
  });

  expect(readbacks).toBe(0);
});

test("measured serif protrusion retains its calibrated absolute anchors", async ({
  page,
  browserName,
}) => {
  const table = await page.evaluate(async () => {
    const face = new FontFace(
      "Junicode",
      'url("/demo/fonts/Junicode-Roman.ttf")',
    );
    document.fonts.add(await face.load());
    return window.__justif.opticalProtrusion({ family: '"Junicode"' });
  });
  expect(table).toBeDefined();
  // These are intentionally absolute rather than self-relative. They lock the
  // print-facing invariants documented by optical.ts and catch raster-window
  // contamination that cache/convergence tests cannot see.
  expect(table?.["."]?.r, "line-end period").toBeGreaterThanOrEqual(400);
  expect(table?.["."]?.r, "line-end period").toBeLessThanOrEqual(700);
  expect(table?.["-"]?.r, "line-end hyphen").toBeGreaterThanOrEqual(400);
  expect(table?.["-"]?.r, "line-end hyphen").toBeLessThanOrEqual(550);
  const r = table?.r?.r;
  if (r === undefined) {
    // WebKit's higher raster noise floor can suppress this small correction;
    // Chromium and Firefox retain it. The punctuation anchors above are
    // mandatory in every engine.
    expect(browserName).toBe("webkit");
  } else {
    expect(r, "line-end r").toBeGreaterThanOrEqual(15);
    expect(r, "line-end r").toBeLessThanOrEqual(100);
  }
});

test("measured monospace protrusion never indents a grid cell", async ({ page }) => {
  const table = await page.evaluate(async () => {
    const face = new FontFace(
      "IBM Plex Mono",
      'url("/demo/fonts/IBMPlexMono-Regular.woff2")',
    );
    document.fonts.add(await face.load());
    return window.__justif.opticalProtrusion({ family: '"IBM Plex Mono"' });
  });
  expect(table).toBeDefined();
  for (const [character, codes] of Object.entries(table ?? {})) {
    if (codes.l !== undefined) {
      expect(codes.l, `${character} has a negative line-start value`).toBeGreaterThanOrEqual(0);
    }
    if (codes.r !== undefined) {
      expect(codes.r, `${character} has a negative line-end value`).toBeGreaterThanOrEqual(0);
    }
  }
});

test("a canvas that cannot shape a font-variant is not trusted to measure it", async ({ page }) => {
  // WebKit's canvas has no `fontVariantCaps`, but assigning it still succeeds —
  // the value becomes an ordinary JS property and reads back exactly what was
  // written, so both the assignment and a readback lie. Only the rendered
  // advance tells the truth. Left unchecked, WebKit measured LOWERCASE glyphs
  // and served them as a small-caps table, silently and permanently, against
  // DOM text that really is rendered in small caps.
  const r = await page.evaluate(async () => {
    await document.fonts.load('16px "Junicode"');
    await document.fonts.load('small-caps 16px "Junicode"');
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = '32px "Junicode"';
    const plain = ctx.measureText("handgloves").width;
    (ctx as CanvasRenderingContext2D & { fontVariantCaps: string }).fontVariantCaps = "small-caps";
    const canvasShapesCaps = Math.abs(ctx.measureText("handgloves").width - plain) > 0.01;

    const span = document.createElement("span");
    span.style.cssText = 'font:32px "Junicode";position:absolute;left:-9999px';
    span.textContent = "handgloves";
    document.body.append(span);
    const domPlain = span.getBoundingClientRect().width;
    span.style.fontVariantCaps = "small-caps";
    const domShapesCaps = Math.abs(span.getBoundingClientRect().width - domPlain) > 0.01;
    span.remove();

    const table = window.__justif.opticalProtrusion({
      family: "Junicode",
      variantCaps: "small-caps",
    });
    return { canvasShapesCaps, domShapesCaps, measured: table !== undefined };
  });
  // Every engine renders true small caps for Junicode in the DOM.
  expect(r.domShapesCaps).toBe(true);
  // The rule: measure the variant only where the canvas actually applies it.
  // Elsewhere `opticalProtrusion` must decline so callers keep their tables.
  expect(r.measured, "measured a font-variant the canvas does not shape")
    .toBe(r.canvasShapesCaps);
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
      const ctl = j.justify(p, { expansion: false, tracking: false, protrusion: false, hangingPunctuation: "none" });
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
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false, tracking: true });
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
  // Tolerate sub-pixel distributed-spacing differences while requiring the
  // full painted inset beyond the glyph edge and materially outside the
  // paragraph measure.
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
      hangingPunctuation: "none",
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

test("applyLayoutOptions re-lays out in place, keeping what it does not own", async ({
  page,
}) => {
  // Same configuration as the rectangular-endings test: a roomier stretch pool
  // keeps a flush ending reachable at the fixture's own measure.
  await page.evaluate(async () => {
    const w = window as unknown as { __relayouts: number };
    w.__relayouts = 0;
    const j = window.__justif;
    j.controller?.destroy();
    j.controller = j.justify(document.querySelectorAll("#host p"), {
      hyphenate: j.hyphenateEnUS,
      protrusion: false,
      hangingPunctuation: "none",
      expansion: false,
      tracking: false,
      spacing: { stretch: 1, shrink: 1 / 3 },
      lastLineMinWidth: 1,
      onRelayout: () => w.__relayouts++,
    });
    await j.controller.ready;
  });
  await waitForQuiescence(page);

  const readState = () =>
    page.evaluate(() => {
      const p = document.getElementById("p1")!;
      const g = window.__justifLines(p);
      const last = g.lines[g.lines.length - 1]!;
      return {
        endingGap: +(g.contentRight - last.right).toFixed(2),
        enhanced: p.hasAttribute("data-justif"),
        managed: window.__justif.controller!.managed.length,
        relayouts: (window as unknown as { __relayouts: number }).__relayouts,
      };
    });

  const before = await readState();
  // Complete replacement: `spacing` and `lastLineMinWidth` are omitted, so both
  // must fall back to the library defaults rather than persisting.
  await page.evaluate(() => {
    window.__justif.controller!.applyLayoutOptions({
      protrusion: false,
      hangingPunctuation: "none",
      expansion: false,
      tracking: false,
    });
  });
  await waitForQuiescence(page);
  const after = await readState();
  const result = { before, after, relayoutsBefore: before.relayouts, relayoutsAfter: after.relayouts };

  // Rectangular endings before; the default 0.33 floor lets it be ragged after.
  expect(result.before.endingGap).toBeLessThan(1);
  expect(result.after.endingGap).toBeGreaterThan(1);
  // Still the same live enhancement — not torn down and rebuilt.
  expect(result.before.enhanced).toBe(true);
  expect(result.after.enhanced).toBe(true);
  expect(result.after.managed).toBe(result.before.managed);
  // `onRelayout` is outside LayoutOptions, so it survived — and it reports the
  // reconfiguration itself, like any other re-layout.
  expect(result.relayoutsAfter).toBeGreaterThan(result.relayoutsBefore);
});

test("applyLayoutOptions keeps the hyphenator it was constructed with", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const p = document.createElement("p");
    // A measure too narrow for the long word: hyphenation is not merely
    // preferred here, it is the only way to set the paragraph.
    p.style.cssText = "width: 120px; text-align: justify; font: 17px Georgia, serif";
    p.textContent =
      "Alpha beta antidisestablishmentarianism gamma delta epsilon zeta eta theta.";
    host.append(p);
    const skips: string[] = [];
    const controller = window.__justif.justify(p, {
      hyphenate: window.__justif.hyphenateEnUS,
      expansion: false,
      tracking: false,
      onSkip: (_el: HTMLElement, reason: string) => skips.push(reason),
    });
    await controller.ready;
    const before = p.querySelectorAll(".justif-hyphen").length;
    controller.applyLayoutOptions({ protrusion: false, hangingPunctuation: "none" });
    const after = p.querySelectorAll(".justif-hyphen").length;
    controller.destroy();
    p.remove();
    return { before, after, skips };
  });

  expect(result.skips).toEqual([]);
  expect(result.before).toBeGreaterThan(0);
  // Still hyphenating after the reconfiguration: `hyphenate` is outside
  // LayoutOptions, so replacing the layout config cannot drop it.
  expect(result.after).toBeGreaterThan(0);
});

/**
 * `protrusion: false` switches off the protrusion MODEL, not hanging: the hang
 * overlay composes over an empty base, so the eligible marks still hang their
 * own depth while ordinary glyphs sit exactly flush. That state is the only way
 * to reject a font's measured optical alignment without losing hanging quotes,
 * and it was unreachable while the two settings were entangled.
 */
test("protrusion off still hangs marks, with ordinary glyphs flush", async ({ page }) => {
  await enhance(page, {
    hyphenate: true,
    protrusion: false,
    hangingPunctuation: "line-end-only",
    expansion: false,
  });
  const paragraphs = await readGeometry(page);
  const advances = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = "17px Georgia, serif";
    return { ",": ctx.measureText(",").width, ".": ctx.measureText(".").width };
  });
  const lines = paragraphs.flatMap((p) =>
    p.lines.map((l) => ({ ...l, contentRight: p.contentRight })),
  );
  const punctuated = lines.filter((l) => !l.last && /[.,]$/.test(l.text.trim()));
  const lettered = lines.filter((l) => !l.last && /\p{L}$/u.test(l.text.trim()));
  expect(punctuated.length).toBeGreaterThan(0);
  expect(lettered.length).toBeGreaterThan(0);
  // The marks hang by their own advance, exactly as with the model on.
  for (const line of punctuated) {
    const expected = advances[line.text.trim().slice(-1) as "," | "."];
    const overhang = line.right - line.contentRight;
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeGreaterThan(0.85 * expected);
    expect(overhang, `"${line.text.slice(0, 40)}"`).toBeLessThan(expected + 1.5);
  }
  // Letters get NO optical protrusion: with the model off they are flush, which
  // is what distinguishes this from the default configuration.
  for (const line of lettered) {
    expect(
      Math.abs(line.right - line.contentRight),
      `"${line.text.slice(0, 40)}"`,
    ).toBeLessThan(0.5);
  }
});

test("protrusion and hanging policies resolve with their compatibility aliases", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.replaceChildren();
    const text =
      "“Alpha beta gamma delta epsilon zeta,” she said. “A second quotation " +
      "makes the line-start policy visible while this sentence supplies enough " +
      "punctuated text to wrap across several lines.”";
    const make = (
      id: string,
      protrusion: boolean | Record<string, { l?: number; r?: number }> | undefined,
      hangingPunctuation?:
        | true
        | false
        | "none"
        | "line-end-only"
        | "all-line-edges"
        | "first-line-and-line-ends"
        | "first-line"
        | "all-lines"
        | undefined,
    ) => {
      const p = document.createElement("p");
      p.id = id;
      p.style.cssText = "width: 245px; text-align: justify; font: 17px Georgia, serif";
      p.textContent = text;
      host.append(p);
      const controller = window.__justif.justify(p, {
        expansion: false,
        tracking: false,
        protrusion,
        hangingPunctuation,
      });
      return { p, controller };
    };
    const modes = {
      defaultMode: make("protrusion-default", undefined),
      trueMode: make("protrusion-true", true),
      lineEndOnly: make("hang-line-end-only", true, "line-end-only"),
      hangingTrue: make("hang-true", true, true),
      noFullHang: make("hang-none", true, "none"),
      hangingFalse: make("hang-false", true, false),
      protrusionOff: make("protrusion-off", false),
      protrusionOffNoHang: make("protrusion-off-no-hang", false, "none"),
      firstLine: make("hang-first-line", true, "first-line-and-line-ends"),
      oldFirstLine: make("hang-old-first-line", true, "first-line"),
      allEdges: make("hang-all-edges", true, "all-line-edges"),
      oldAllLines: make("hang-old-all-lines", true, "all-lines"),
    };
    await Promise.all(Object.values(modes).map(({ controller }) => controller.ready));
    const snapshot = (p: HTMLElement) => {
      const edge = p.getBoundingClientRect();
      return window.__justifLines(p).lines.map((line) => ({
        texts: line.texts,
        left: +(line.left - edge.left).toFixed(3),
        right: +(line.right - edge.right).toFixed(3),
      }));
    };
    return Object.fromEntries(
      Object.entries(modes).map(([name, { p }]) => [name, snapshot(p)]),
    ) as Record<keyof typeof modes, ReturnType<typeof snapshot>>;
  });

  const expectEquivalent = (
    actual: typeof result.defaultMode,
    expected: typeof result.defaultMode,
  ) => {
    expect(actual.map((line) => line.texts)).toEqual(expected.map((line) => line.texts));
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(Math.abs(actual[i]!.left - expected[i]!.left)).toBeLessThan(0.1);
      expect(Math.abs(actual[i]!.right - expected[i]!.right)).toBeLessThan(0.1);
    }
  };
  expect(result.defaultMode.length).toBeGreaterThan(2);
  expectEquivalent(result.defaultMode, result.lineEndOnly);
  expectEquivalent(result.trueMode, result.defaultMode);
  expectEquivalent(result.hangingTrue, result.defaultMode);
  expectEquivalent(result.hangingFalse, result.noFullHang);
  // NOT equivalent any more: protrusion off leaves hanging on, and the two
  // differ wherever a line ends in a hanging mark. Whether this fixture's
  // breaks land on one is incidental, so the semantics are asserted by
  // "protrusion off still hangs marks, with ordinary glyphs flush" above
  // rather than by comparing these two snapshots here.
  expect(result.protrusionOffNoHang.length).toBeGreaterThan(2);
  expectEquivalent(result.oldAllLines, result.allEdges);
  expectEquivalent(result.oldFirstLine, result.firstLine);
  // "first-line-and-line-ends" is a distinct policy: full opener on line 0,
  // line-end hangs throughout, and flush later starts.
  expect(result.firstLine).not.toEqual(result.defaultMode);
});

/**
 * Issue #14: a paragraph must never show two hang depths for the same mark.
 * In "first-line-and-line-ends" the opener hangs fully and every later line
 * start sets the full-hang characters FLUSH — the CSS `first` model. A mark
 * hung fully on one line and by optical alignment on the next reads as a
 * misaligned edge instead of as either style.
 */
test('a wrapped-line quote sets flush in "first-line-and-line-ends"', async ({
  page,
}) => {
  const edges = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const p = document.createElement("p");
    p.id = "issue14-wrapped-quote";
    p.style.cssText = "width: 1000px; text-align: justify; font: 17px Georgia, serif";
    const prefix = "“Alpha beta gamma delta epsilon zeta ";
    p.textContent = `${prefix}“Quotationthatstartsaline and the paragraph then runs on for a further line of text.`;
    host.append(p);
    // Size the measure to the prefix so the quoted word CANNOT fit line 0 —
    // deterministic across engines and fonts, unlike a hand-picked width.
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, prefix.length);
    p.style.width = `${range.getBoundingClientRect().width + 8}px`;
    const controller = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      hangingPunctuation: "first-line-and-line-ends",
    });
    await controller.ready;
    const contentLeft = p.getBoundingClientRect().left;
    const lines = window.__justifLines(p).lines.map((l) => ({
      offset: +(l.left - contentLeft).toFixed(2),
      head: l.texts[0] ?? "",
    }));
    controller.destroy();
    p.remove();
    return lines;
  });

  expect(edges.length).toBeGreaterThan(2);
  // The opener hangs: its quote sits outside the measure.
  expect(edges[0]!.head.startsWith("“")).toBe(true);
  expect(edges[0]!.offset).toBeLessThan(-1);
  // The wrapped quote-led line is the case in the report.
  const wrapped = edges.slice(1);
  expect(wrapped.filter((l) => l.head.startsWith("“")).length).toBeGreaterThan(0);
  // Every line after the first shares ONE left edge, quote-led or not. Two
  // things widen the tolerance from an exact match: measured protrusion nudges
  // letter-led lines out by a fraction of a pixel, and WebKit's range rects
  // quantize such a nudge to a whole pixel (its element rects report the true
  // 0.14px). What must not happen is a line stepping out like the opener does,
  // which is the staircase in the report.
  for (const line of wrapped) {
    expect(Math.abs(line.offset), `line "${line.head}"`).toBeLessThan(1.2);
  }
  const quoteLed = wrapped.filter((l) => l.head.startsWith("“")).map((l) => l.offset);
  const letterLed = wrapped.filter((l) => !l.head.startsWith("“")).map((l) => l.offset);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  expect(mean(quoteLed)).toBeGreaterThanOrEqual(mean(letterLed) - 0.1);
});

/**
 * Issue #14, second half: a one-line paragraph keeps its native rendering
 * (nothing to justify, no DOM rewrite) but still owes the margin its
 * line-start alignment. It is bought with an inline text-indent, so the fast
 * path survives, and it must leave no residue behind.
 */
test("a native one-line paragraph aligns its opener like its multi-line neighbour", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "width: 340px; font: 17px Georgia, serif";
    const make = (id: string, text: string) => {
      const p = document.createElement("p");
      p.id = id;
      p.style.textAlign = "justify";
      p.textContent = text;
      wrapper.append(p);
      return p;
    };
    const short = make("issue14-one-line", "“Show me some?”");
    const long = make(
      "issue14-multi-line",
      "“Show me some of them,” she replies, and the paragraph carries on long " +
        "enough to need several lines of its own.",
    );
    const plain = make("issue14-one-line-plain", "Show me some?");
    const shortBefore = short.outerHTML;
    host.append(wrapper);
    const controller = window.__justif.justify(wrapper.querySelectorAll("p"), {
      expansion: false,
      tracking: false,
    });
    await controller.ready;
    const firstGlyphOffset = (p: HTMLElement) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      range.setStart(walker.nextNode()!, 0);
      range.setEnd(range.startContainer, 1);
      return +(range.getBoundingClientRect().left - p.getBoundingClientRect().left).toFixed(2);
    };
    const out = {
      shortNative: !short.hasAttribute("data-justif"),
      shortSegments: short.querySelectorAll(".justif-seg").length,
      shortOffset: firstGlyphOffset(short),
      longEnhanced: long.hasAttribute("data-justif"),
      longOffset: firstGlyphOffset(long),
      // A one-line paragraph whose first character has no line-start
      // protrusion is not touched at all.
      plainStyle: plain.getAttribute("style"),
      plainOffset: firstGlyphOffset(plain),
      restoredExactly: "",
    };
    controller.destroy();
    out.restoredExactly = short.outerHTML === shortBefore ? "yes" : short.outerHTML;
    wrapper.remove();
    return out;
  });

  expect(result.shortNative).toBe(true);
  expect(result.shortSegments).toBe(0);
  expect(result.longEnhanced).toBe(true);
  // Both openers hang, by the same amount.
  expect(result.shortOffset).toBeLessThan(-1);
  expect(Math.abs(result.shortOffset - result.longOffset)).toBeLessThan(0.1);
  expect(result.plainStyle).toBe("text-align: justify;");
  expect(result.plainOffset).toBe(0);
  // destroy() puts the author's markup and style attribute back byte-for-byte.
  expect(result.restoredExactly).toBe("yes");
});

/**
 * An author's own first-line indent and a hanging opener meet on the same line,
 * and the hang is relative to the indent, not to the margin: the mark sits just
 * before where the indented text starts. Both paths have to agree — the enhanced
 * one buys the hang with a negative margin on the line's first segment, the
 * native one-line path with an inline `text-indent` that must carry the author's
 * own indent along with it.
 */
test("a first-line hang composes with the author's own text-indent", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    const text =
      "“Alpha beta gamma delta epsilon zeta,” she said, and the paragraph then " +
      "runs on for several further lines of ordinary text so that the wrap is " +
      "never in doubt at this measure whatever the engine decides to do.";
    const base = "width: 300px; text-align: justify; font: 17px Georgia, serif; margin: 0 0 1em";
    const make = (id: string, indent: string, content: string) => {
      const p = document.createElement("p");
      p.id = id;
      p.setAttribute("style", indent === "" ? base : `${base}; text-indent: ${indent}`);
      p.textContent = content;
      host.append(p);
      return p;
    };
    const paragraphs = {
      // The reference hang: same paragraph, no indent of its own.
      plain: make("indent-hang-none", "", text),
      positive: make("indent-hang-positive", "32px", text),
      // The classic hanging-indent idiom, where line 0 starts LEFT of the rest.
      negative: make("indent-hang-negative", "-24px", text),
      // One line, so it keeps its native rendering and pays for the hang with an
      // inline text-indent instead of a DOM rewrite.
      oneLine: make("indent-hang-one-line", "32px", "“Short quoted line.”"),
    };
    const controller = window.__justif.justify(Object.values(paragraphs), {
      expansion: false,
      tracking: false,
      hangingPunctuation: "first-line-and-line-ends",
    });
    await controller.ready;
    const read = (p: HTMLElement) => {
      const geometry = window.__justifLines(p);
      const edge = p.getBoundingClientRect().left;
      return {
        enhanced: p.hasAttribute("data-justif"),
        indent: p.style.textIndent,
        lines: geometry.lines.map((line) => ({
          left: +(line.left - edge).toFixed(2),
          right: +(line.right - geometry.contentRight).toFixed(2),
          head: line.texts[0] ?? "",
        })),
      };
    };
    return Object.fromEntries(
      Object.entries(paragraphs).map(([name, p]) => [name, read(p)]),
    ) as Record<keyof typeof paragraphs, ReturnType<typeof read>>;
  });

  // The un-indented reference: the opener hangs into the margin, later lines are
  // flush, and the hang is big enough for the comparisons below to mean anything.
  const hang = -result.plain.lines[0]!.left;
  expect(result.plain.enhanced).toBe(true);
  expect(result.plain.lines.length).toBeGreaterThan(3);
  expect(hang).toBeGreaterThan(2);

  for (const [name, indent] of [
    ["positive", 32],
    ["negative", -24],
  ] as const) {
    const { enhanced, lines } = result[name];
    expect(enhanced, name).toBe(true);
    expect(lines.length, name).toBeGreaterThan(3);
    // Line 0 starts at the author's indent, less the hang.
    expect(Math.abs(lines[0]!.left - (indent - hang)), `${name} first line`).toBeLessThan(1);
    expect(lines[0]!.head, name).toBe("“Alpha");
    // The indent belongs to line 0 alone: every later line keeps the shared
    // left edge, and every line but the last stays flush at the right.
    for (const [i, line] of lines.entries()) {
      if (i > 0) expect(Math.abs(line.left), `${name} line ${i} left`).toBeLessThan(1.2);
      if (i < lines.length - 1) {
        expect(Math.abs(line.right), `${name} line ${i} right`).toBeLessThan(1.5);
      }
    }
  }

  // The native one-line path: the indent it writes is the author's own minus the
  // same hang, so the rendered line lands where the enhanced first lines do.
  expect(result.oneLine.enhanced).toBe(false);
  expect(parseFloat(result.oneLine.indent)).toBeCloseTo(32 - hang, 1);
  expect(Math.abs(result.oneLine.lines[0]!.left - (32 - hang))).toBeLessThan(1);
});

test("an unchanged native hang does not report or mutate a relayout", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.style.cssText =
      "width:340px;text-align:justify;font:17px Georgia,serif";
    p.textContent = "“A short native line.”";
    document.getElementById("host")!.replaceChildren(p);
    let relayouts = 0;
    const controller = window.__justif.justify(p, {
      expansion: false,
      tracking: false,
      onRelayout: () => relayouts++,
    });
    await controller.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = {
      relayouts,
      style: p.getAttribute("style"),
      indent: p.style.textIndent,
    };
    let styleMutations = 0;
    const observer = new MutationObserver((records) => {
      styleMutations += records.filter(
        (record) => record.type === "attributes" && record.attributeName === "style",
      ).length;
    });
    observer.observe(p, { attributes: true, attributeFilter: ["style"] });
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    const after = {
      relayouts,
      style: p.getAttribute("style"),
      indent: p.style.textIndent,
      styleMutations,
    };
    controller.destroy();
    return { before, after };
  });

  expect(result.before.indent).not.toBe("");
  expect(result.after).toEqual({ ...result.before, styleMutations: 0 });
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

test("author emergency-break licences never strand a hyphen or blow spacing out", async ({
  page,
}) => {
  // overflow-wrap/word-break/line-break all let the engine break where the
  // text offers no opportunity. A line's ink deliberately overhangs the
  // measure (hanging hyphen + wrap-safety pad), so Chromium and Firefox read
  // it as overflowing and re-break at the segment/hyphen boundary, painting
  // the hyphen at the START of the next line. The deferred correction pass
  // then measures that coordinate as the line's painted end and stretches
  // word-spacing by most of a column width (50-75px, issue #10).
  for (const licence of [
    { "overflow-wrap": "break-word" },
    { "overflow-wrap": "anywhere" },
    { "word-break": "break-all" },
    { "line-break": "anywhere" },
  ]) {
    // A fresh document per licence. enhance() destroys the previous
    // controller first, and destroy() restores the style attribute snapshotted
    // at the FIRST justify() — writing the next licence before that would put
    // every iteration back on the first one.
    await openFixture(page);
    await page.evaluate((declarations) => {
      // Narrow measure: pass 2 must hyphenate for the licence to have a
      // segment/hyphen boundary to break at.
      document.getElementById("host")!.style.width = "230px";
      for (const p of document.querySelectorAll<HTMLElement>("#host p")) {
        for (const [property, value] of Object.entries(declarations)) {
          p.style.setProperty(property, value);
        }
      }
    }, licence);
    const label = Object.entries(licence)[0]!.join(": ");
    // Assert the licence is live on the paragraph BEFORE enhancement — which
    // deliberately overrides it — so this loop can't retest one licence four
    // times and read as four-way coverage.
    const applied = await page.evaluate(
      (property) =>
        getComputedStyle(document.querySelector<HTMLElement>("#host p")!).getPropertyValue(
          property,
        ),
      Object.keys(licence)[0]!,
    );
    expect(applied, `${label}: licence live before enhancement`).toBe(
      Object.values(licence)[0],
    );
    await enhance(page, { hyphenate: true });
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#host p")].flatMap((p) =>
        window.__justifLines(p).lines.map((l) => l.texts),
      ),
    );
    expect(lines.some((texts) => texts.includes("-")), `${label}: hyphenated`).toBe(true);
    for (const texts of lines) {
      // A hyphen belongs to the line it ends. Stranded, it leads the next one.
      expect(texts.indexOf("-"), `${label}: line "${texts.join(" ").slice(0, 40)}"`).not.toBe(0);
    }
    const spacing = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#host .justif-seg")].map(
        (s) => parseFloat(getComputedStyle(s).wordSpacing) || 0,
      ),
    );
    expect(Math.max(...spacing), `${label}: max word-spacing`).toBeLessThan(10);
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
  // A hyphenated word is findable as one word across the zero-width joint.
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

test("hyphens: none is honored on a run whose typography matches its paragraph", async ({
  page,
}) => {
  // `hyphens` is deliberately absent from the measurement cache key (it
  // cannot change a width), so a run that differs ONLY there must still get
  // its own styling context: otherwise it collapses into the paragraph's and
  // silently inherits `auto`. The distinct-key paragraph is the reference —
  // one hundredth of a pixel of letter-spacing used to be what decided
  // whether the same CSS worked.
  const result = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.style.width = "150px";
    const make = (id: string, spanStyle: string): HTMLParagraphElement => {
      const p = document.createElement("p");
      p.id = id;
      p.style.hyphens = "auto";
      p.innerHTML = `Fox <span class="target" style="${spanStyle}">incomprehensibilities</span> end.`;
      return p;
    };
    const sameKey = make("nohyph-same", "hyphens: none");
    const distinctKey = make("nohyph-distinct", "hyphens: none; letter-spacing: 0.01px");
    const control = make("nohyph-control", "");
    host.replaceChildren(sameKey, distinctKey, control);
    const c = window.__justif.justify([sameKey, distinctKey, control], {
      hyphenate: window.__justif.hyphenateEnUS,
    });
    await c.ready;
    const fragments = (p: HTMLElement): string[] =>
      [...p.querySelectorAll<HTMLElement>(".target .justif-seg")].map((s) => s.textContent ?? "");
    return {
      same: fragments(sameKey),
      distinct: fragments(distinctKey),
      control: fragments(control),
    };
  });
  // The control proves the measure really does force a break inside the word.
  expect(result.control.length).toBeGreaterThan(1);
  expect(result.same).toEqual(["incomprehensibilities"]);
  expect(result.distinct).toEqual(["incomprehensibilities"]);
});

test("find-in-page matches phrases across line breaks", async ({ page }) => {
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false });
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
      hangingPunctuation: "none",
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
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none" });
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
        hangingPunctuation: "none",
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
    const c = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("auto drop-in: configures typography from CSS custom properties", async ({ page }) => {
  const messages: Array<{ type: string; text: string }> = [];
  page.on("console", (m) => messages.push({ type: m.type(), text: m.text() }));
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  const state = await page.evaluate(() => {
    const g = window as Window & {
      justif?: { controllers: Array<{ paragraphs: readonly HTMLElement[] }> };
    };
    // Which paragraphs ended up sharing a controller IS the resolved
    // configuration: the loader groups by (language, effective config).
    const groups = g
      .justif!.controllers.map((c) => c.paragraphs.map((p) => p.id).sort())
      .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
    /** How far the furthest line's ink reaches past the content edge. */
    const overhang = (id: string) => {
      const p = document.getElementById(id)!;
      const cs = getComputedStyle(p);
      const contentRight =
        p.getBoundingClientRect().right -
        parseFloat(cs.paddingRight) -
        parseFloat(cs.borderRightWidth);
      let most = -Infinity;
      for (const seg of p.querySelectorAll<HTMLElement>(".justif-seg")) {
        most = Math.max(most, seg.getBoundingClientRect().right - contentRight);
      }
      return { most: +most.toFixed(2), enhanced: p.hasAttribute("data-justif") };
    };
    return { groups, plain: overhang("plain"), flush: overhang("flush") };
  });

  // Four distinct configurations, and membership shows how each was resolved:
  // inheritance carries the section rule to #inherited; inline style and a
  // higher-specificity class rule both reach all-line-edges; and #as-default
  // (explicitly the library default), #bogus (unparseable), #typo (misspelled
  // property) and #run-scoped (configured on an inline run, which is not a
  // paragraph) all resolve to the default and share ONE controller with #plain.
  expect(state.groups).toEqual([
    ["as-default", "bogus", "plain", "run-scoped", "type-invalid", "typo"],
    ["class-override", "inline-override"],
    ["flush"],
    ["inherited"],
  ]);

  // The options really reach the layout, not just the grouping: #plain and
  // #flush hold identical comma-dense text at the same measure, so the only
  // thing that can differ is the configuration. Compared against each other
  // rather than against an absolute edge, because the wrap guarantee gives every
  // line a sub-pixel pad of its own.
  expect(state.plain.enhanced).toBe(true);
  expect(state.flush.enhanced).toBe(true);
  expect(state.flush.most).toBeLessThan(1);
  expect(state.plain.most).toBeGreaterThan(state.flush.most + 2);

  // An out-of-range value warns once and falls back, rather than failing to
  // enhance; a misspelled property name is reported on the debug channel.
  const warnings = messages.filter((m) => m.type === "warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.text).toContain("--justif-tracking");
  expect(warnings[0]!.text).toContain("-3%");
  expect(messages.some((m) => m.text.includes("--justif-trakcing"))).toBe(true);

  // Where the properties are registered, a value of the wrong TYPE never reaches
  // the parser: the engine substitutes the initial value first, so there is
  // nothing for us to report — and #type-invalid still lands in the default
  // group above either way.
  const live = await page.evaluate(
    () =>
      typeof CSS.registerProperty === "function" &&
      CSS.supports("transition-behavior", "allow-discrete"),
  );
  if (live) {
    expect(warnings.some((m) => m.text.includes("3px"))).toBe(false);
    // Preflight ran and found nothing to displace, so the watcher is armed.
    expect(
      await page.evaluate(() =>
        document.getElementById("plain")!.hasAttribute("data-justif-watch"),
      ),
    ).toBe(true);
  }
});

test("auto drop-in: a CSS configuration change applies by itself", async ({ page }) => {
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });
  const live = await page.evaluate(
    () =>
      typeof CSS.registerProperty === "function" &&
      CSS.supports("transition-behavior", "allow-discrete"),
  );
  test.skip(!live, "engine lacks @property or allow-discrete: liveness is opt-out here");

  const read = () =>
    page.evaluate(() => {
      const p = document.getElementById("plain")!;
      const cs = getComputedStyle(p);
      const contentRight =
        p.getBoundingClientRect().right -
        parseFloat(cs.paddingRight) -
        parseFloat(cs.borderRightWidth);
      const segments = [...p.querySelectorAll<HTMLElement>(".justif-seg")];
      let most = -Infinity;
      for (const seg of segments) {
        most = Math.max(most, seg.getBoundingClientRect().right - contentRight);
      }
      return { most: +most.toFixed(2), segments: segments.length };
    });
  const overhang = async () => (await read()).most;

  const before = await read();
  expect(before.segments).toBeGreaterThan(0);
  expect(before.most).toBeGreaterThan(2);

  // Switch hanging off through the cascade, with no library call of any kind.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--justif-hanging-punctuation", "none");
  });
  // Measured against the previous value, not against the content edge: with
  // hanging off, optical protrusion still moves the edge, just far less.
  await expect.poll(overhang, { timeout: 4000 }).toBeLessThan(before.most - 1);
  const off = await read();
  // Still enhanced. Without this, a teardown would satisfy the poll above by
  // leaving nothing to measure.
  expect(off.segments).toBe(before.segments);

  // And back: the change is not one-way, and reverting rejoins the original
  // configuration rather than accumulating controllers.
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--justif-hanging-punctuation");
  });
  await expect.poll(overhang, { timeout: 4000 }).toBeGreaterThan(before.most - 0.5);
  expect((await read()).segments).toBe(before.segments);
  expect(
    await page.evaluate(
      () => (window as Window & { justif?: { controllers: unknown[] } }).justif!.controllers.length,
    ),
  ).toBe(4);
});

test('auto drop-in: "first-line-and-line-ends" is part of the CSS surface', async ({
  page,
}) => {
  // Registration is the thing only a browser can check: a keyword missing from
  // the `@property` syntax is substituted away before our parser ever sees it,
  // so the declaration would silently do nothing.
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  // Set at the root, like the liveness test: the paragraph's own style attribute
  // is the layout's working surface, so a declaration parked there does not
  // survive the next patch.
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--justif-hanging-punctuation",
      "first-line-and-line-ends",
    );
  });
  // #plain now resolves to the new policy while #as-default keeps the library
  // default explicitly, so the group they shared must split. A keyword the
  // `@property` syntax rejected would compute as `auto` and leave them together.
  // Polled: the watcher's own transition lands the new computed value a frame
  // later, so a single synchronous read still sees the old one.
  const split = () =>
    page.evaluate(async () => {
      const g = window as Window & {
        justif?: {
          reconfigure: () => Promise<void>;
          controllers: Array<{ paragraphs: readonly HTMLElement[] }>;
        };
      };
      await g.justif!.reconfigure();
      return g.justif!.controllers.some((c) => {
        const ids = c.paragraphs.map((p) => p.id);
        return ids.includes("plain") && !ids.includes("as-default");
      });
    });
  await expect.poll(split, { timeout: 4000 }).toBe(true);
  expect(
    await page.evaluate(() => document.getElementById("plain")!.hasAttribute("data-justif")),
  ).toBe(true);
});

test("auto drop-in: an author transition is never replaced", async ({ page }) => {
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  // Give one paragraph an author transition and re-preflight. Even at zero
  // specificity the watcher would win this by source order, so the loader must
  // stand down instead — the author's animation is the thing that matters.
  const state = await page.evaluate(async () => {
    const p = document.getElementById("as-default")!;
    p.style.transition = "color 200ms";
    const g = window as Window & { justif?: { reconfigure: () => Promise<void> } };
    await g.justif!.reconfigure();
    const cs = getComputedStyle(p);
    return {
      watched: p.hasAttribute("data-justif-watch"),
      property: cs.transitionProperty,
      duration: cs.transitionDuration,
      stillEnhanced: p.hasAttribute("data-justif"),
    };
  });

  expect(state.watched).toBe(false);
  expect(state.property).toBe("color");
  expect(state.duration).toBe("0.2s");
  // Liveness is what it loses, not enhancement.
  expect(state.stillEnhanced).toBe(true);
});

test("auto drop-in: reconfigure() does not re-adopt a torn-down paragraph", async ({ page }) => {
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  const after = await page.evaluate(async () => {
    const g = window as Window & {
      justif?: { unjustify: (t: Iterable<Element>) => void; reconfigure: () => Promise<void> };
    };
    const p = document.getElementById("plain")!;
    g.justif!.unjustify([p]);
    const textAfterTeardown = p.textContent;
    // A configuration change now must not bring it back: the consumer's
    // teardown is a decision, not a transient state.
    document.documentElement.style.setProperty("--justif-tracking", "none");
    await g.justif!.reconfigure();
    return {
      segments: p.querySelectorAll(".justif-seg").length,
      enhanced: p.hasAttribute("data-justif"),
      textUnchanged: p.textContent === textAfterTeardown,
    };
  });

  expect(after.segments).toBe(0);
  expect(after.enhanced).toBe(false);
  expect(after.textUnchanged).toBe(true);
});

test("auto drop-in: a one-line group still receives its hyphenator", async ({ page }) => {
  // Regression: the loader decided whether a group had been torn down while its
  // patterns were in flight by looking for `data-justif` on the elements. A
  // paragraph that fits on one line is managed but carries no such attribute,
  // so a group where every paragraph fits read as torn down and the final
  // hyphenated controller was never created. Nothing looked wrong until the
  // measure narrowed and the text wrapped — unhyphenated, forever.
  await page.route("**/dist/hyphenate/de.js", async (route) => {
    // Land the patterns well after the interim controller commits, so this
    // exercises the interim path rather than depending on paint timing.
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await page.goto("/test-e2e/fixture-auto-oneline.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  // Boot state: one line, native markup, no attribute — but managed.
  expect(await page.locator("#de-oneline .justif-seg").count()).toBe(0);
  expect(
    await page.evaluate(() => document.getElementById("de-oneline")!.hasAttribute("data-justif")),
  ).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { justif?: { controllers: Array<{ managed: readonly Element[] }> } })
          .justif!.controllers.some((c) => c.managed.length > 0),
    ),
  ).toBe(true);

  // Narrow the measure until the compound cannot fit: the paragraph promotes
  // out of native layout, and the German patterns must be there to break it.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".col")!.style.width = "200px";
  });
  await expect(page.locator("#de-oneline .justif-hyphen")).not.toHaveCount(0);
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
      hangingPunctuation: "none",
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

test("auto drop-in: an outside restore before pattern arrival is respected", async ({ page }) => {
  // The other side of `managed`: a consumer who takes the DOM back by hand
  // leaves the controller's record saying "enhanced" while the enhancement is
  // gone from the page. That must still read as torn down, or the arriving
  // patterns would re-enhance over the consumer's own markup.
  await page.route("**/dist/hyphenate/de.js", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.goto("/test-e2e/fixture-auto.html");
  await page.waitForFunction(
    () =>
      document.getElementById("de-just")?.hasAttribute("data-justif") === true,
  );
  const restored = "Diese Fassung gehört dem Aufrufer.";
  await page.evaluate((text) => {
    const p = document.getElementById("de-just")!;
    p.replaceChildren(document.createTextNode(text));
    p.removeAttribute("data-justif");
  }, restored);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });
  expect(await page.locator("#de-just .justif-seg").count()).toBe(0);
  expect(await page.evaluate(() => document.getElementById("de-just")!.textContent)).toBe(
    restored,
  );
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
    const first = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
    first.destroy(); // face still in flight
    await document.fonts.load('18px "GreekLate"', "γλ");
    const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("observeResize:false applies wrap-guarantee corrections before returning", async ({
  page,
}) => {
  // Regression: the viewport IntersectionObservers were registered only when
  // resize observation was on, so with observeResize: false every correction
  // parked forever. The synchronous viewport seed now corrects visible lines
  // before justify() returns; later observer delivery must leave them alone.
  const atReturn = await page.evaluate(() => {
    const j = window.__justif;
    j.controller?.destroy();
    j.controller = j.justify(document.querySelectorAll("#host p"), {
      hyphenate: j.hyphenateEnUS,
      protrusion: false,
      hangingPunctuation: "none",
      expansion: false,
      observeResize: false,
    });
    return document.getElementById("host")!.innerHTML;
  });
  // "They ran" is a DOM fact: every body line's provisional −1.5px wrap-safety
  // pad was replaced by a measured margin. The two that remain are the
  // paragraph endings, ragged by design and outside the correction window.
  expect(atReturn.match(/-1\.5px/g)?.length ?? 0).toBe(2);
  await page.evaluate(() => window.__justif.controller!.ready);
  await waitForQuiescence(page);
  const settled = await page.evaluate(() => document.getElementById("host")!.innerHTML);
  expect(settled).toBe(atReturn);
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
  await enhance(page, { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("Japanese: multiple flush lines, bare zero-width joints, space-free copies", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = document.getElementById("pja")!;
    const original = p.textContent!;
    const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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
      joints: p.querySelectorAll(".justif-break").length,
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
  // Line joints are bare zero-width break spans: the DOM text stays
  // byte-identical to the source — no space, NBSP, or hyphen injected
  // between characters.
  expect(r.joints).toBeGreaterThan(0);
  expect(r.text).toBe(r.original);
  // Copies too: selection across the line breaks carries no whitespace.
  expect(r.copied).not.toMatch(/[ \u00A0\u2060\u2010-]/);
  expect(r.copied.replace(/\s+/g, "")).toBe(r.original);
});

test("Japanese: kinsoku characters never start or end a rendered line", async ({ page }) => {
  const lines = await page.evaluate(async () => {
    const p = document.getElementById("pja")!;
    const ctl = window.__justif.justify(p, { protrusion: false, hangingPunctuation: "none", expansion: false });
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

test("RTL hard-break paragraphs preserve direction and forced endings", async ({ page }) => {
  const sourceText = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "rtl-hard-break";
    p.dir = "rtl";
    p.lang = "he";
    p.style.cssText =
      "width:280px;text-align:justify;text-align-last:justify";
    p.innerHTML =
      "בראשית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו וחשך על פני תהום" +
      "<br data-hard>" +
      "ויאמר אלהים יהי אור ויהי אור וירא אלהים את האור כי טוב ויבדל בין האור ובין החשך";
    document.getElementById("rtl-host")!.append(p);
    const text = p.innerText;
    const j = window.__justif;
    j.controller = j.justify(p, {
      expansion: false,
      tracking: false,
      protrusion: false,
      hangingPunctuation: "none",
      lastLineMinWidth: 0,
    });
    await j.controller.ready;
    return text;
  });
  await waitForQuiescence(page, "#rtl-hard-break");

  const geometry = await readRtlGeometry(page, "rtl-hard-break");
  const state = await page.evaluate(() => {
    const p = document.getElementById("rtl-hard-break")!;
    return {
      brCount: p.querySelectorAll("br[data-hard]").length,
      text: p.innerText,
      textAlign: getComputedStyle(p).textAlign,
      textAlignLast: getComputedStyle(p).textAlignLast,
    };
  });

  expect(geometry.enhanced).toBe(true);
  expect(geometry.lines.length).toBeGreaterThan(3);
  expect(state.brCount).toBe(1);
  expect(state.text).toBe(sourceText);
  expect(state.textAlign).toBe("right");
  expect(state.textAlignLast).toBe("right");
  for (const [i, line] of geometry.lines.entries()) {
    expect.soft(Math.abs(line.right - geometry.contentRight), `line ${i} start`).toBeLessThan(1);
  }
});

test("RTL paragraphs justify with lines flush at both edges", async ({ page }) => {
  // hyphenate passed on purpose: it must be ignored for RTL paragraphs.
  await enhance(
    page,
    { hyphenate: true, protrusion: false, hangingPunctuation: "none", expansion: false },
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
  await enhance(page, { protrusion: false, hangingPunctuation: "none" }, "#rtl-vf p"); // expansion: library default (ON)
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
  await enhance(page, { protrusion: false, hangingPunctuation: "none" }, "#rtl-host p");
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
