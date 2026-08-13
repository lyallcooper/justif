import { expect, test } from "@playwright/test";

/**
 * Performance regressions that a stopwatch cannot see.
 *
 * perf.spec.ts budgets wall-clock, which is the right instrument for "is this
 * fast enough" and the wrong one for "did this get worse": a shared CI runner's
 * noise is larger than most regressions, so a budget loose enough not to flake
 * only catches catastrophes. Everything here counts something deterministic
 * instead — forced layouts, rebuilt paragraphs, bytes, heap after collection —
 * so the same regression fails on any machine, by the same margin.
 *
 * The counts come from measured behaviour, not from a target: the thresholds sit
 * well above what the library does today, and are meant to catch a change in
 * KIND (work that suddenly scales with the content, a re-read that rebuilds the
 * page, a cache that never stops growing) rather than a few percent.
 */

/** Layout and style-recalculation counts, via CDP. Chromium only. */
async function counters(session: import("@playwright/test").CDPSession) {
  const { metrics } = await session.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { layouts: value("LayoutCount"), recalcs: value("RecalcStyleCount") };
}

/** Fill #host with `count` identical justifiable paragraphs. */
const FILL = (count: number) => {
  const host = document.getElementById("host")!;
  host.replaceChildren();
  const text =
    "The extraordinarily complicated development of unquestionably international " +
    "typographical conventions demonstrates considerable responsibility, naturally.";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("p");
    p.setAttribute(
      "style",
      "width:280px;text-align:justify;font:17px Georgia, serif;margin:0 0 1em",
    );
    p.textContent = text;
    host.append(p);
  }
};

test.beforeEach(async ({ page }) => {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);
});

test("the drop-in stays within its size budget", async ({ page }) => {
  const size = await page.evaluate(async () => {
    const measure = async (path: string) => {
      const bytes = new Uint8Array(await (await fetch(path)).arrayBuffer());
      if (typeof CompressionStream !== "function") return { raw: bytes.length, gzip: 0 };
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      const gzipped = new Uint8Array(await new Response(stream).arrayBuffer());
      return { raw: bytes.length, gzip: gzipped.length };
    };
    return { auto: await measure("/dist/auto.js"), index: await measure("/dist/index.js") };
  });
  // Logged, because the number is the interesting part when this fails.
  console.log(`dist/auto.js ${size.auto.raw} bytes, ${size.auto.gzip} gzipped`);
  console.log(`dist/index.js ${size.index.raw} bytes, ${size.index.gzip} gzipped`);
  // The drop-in is fetched from a CDN before first paint, so its weight is a
  // feature. Keep modest headroom over what it measures today: a dependency
  // landing in the bundle by accident is tens of kilobytes, not hundreds.
  expect(size.auto.raw, "dist/auto.js bytes").toBeLessThan(148_000);
  if (size.auto.gzip > 0) expect(size.auto.gzip, "dist/auto.js gzipped").toBeLessThan(59_000);
  expect(size.index.raw, "dist/index.js bytes").toBeLessThan(160_000);
});

test("a re-read rebuilds only what changed", async ({ page }) => {
  const result = await page.evaluate(async (fill) => {
    // eslint-disable-next-line no-eval
    (0, eval)(`(${fill})`)(120);
    const host = document.getElementById("host")!;
    const paragraphs = [...host.children] as HTMLElement[];
    const controller = window.__justif.justify(paragraphs, {
      hyphenate: window.__justif.hyphenateEnUS,
    });
    await controller.ready;

    // Which paragraphs are touched at all. Collected with takeRecords() rather
    // than from the callback: records are delivered on a microtask, and
    // disconnecting before that discards them.
    // childList only: whose CONTENT was replaced. Attribute writes are a
    // different question, asked below.
    const rebuilt = new Set<Element>();
    const observer = new MutationObserver(() => {});
    observer.observe(host, { childList: true, subtree: true });
    const attributed = new Set<Element>();
    const attributeObserver = new MutationObserver(() => {});
    attributeObserver.observe(host, { attributes: true, subtree: true });

    const target = paragraphs[42]!;
    target.style.letterSpacing = "0.25px";
    const rescanned = controller.rescan().map((p) => paragraphs.indexOf(p));
    const attribute = (records: MutationRecord[], into: Set<Element>) => {
      for (const record of records) {
        const node = record.target as Element;
        const paragraph = (node.nodeType === 1 ? node : node.parentElement)?.closest("#host > p");
        if (paragraph !== null && paragraph !== undefined) into.add(paragraph);
      }
    };
    attribute(observer.takeRecords(), rebuilt);
    attribute(attributeObserver.takeRecords(), attributed);
    observer.disconnect();
    attributeObserver.disconnect();

    const out = {
      total: paragraphs.length,
      rescanned,
      rebuilt: [...rebuilt].map((p) => paragraphs.indexOf(p as HTMLElement)),
      attributed: [...attributed].map((p) => paragraphs.indexOf(p as HTMLElement)),
    };
    controller.destroy();
    host.replaceChildren();
    return out;
  }, FILL.toString());

  expect(result.total).toBe(120);
  // One paragraph's CSS changed, so one paragraph is re-read and one rebuilt.
  // A regression here is not subtle: it is the whole page re-enhancing on every
  // theme toggle, class swap or inspector edit.
  expect(result.rescanned).toEqual([42]);
  expect(result.rebuilt).toEqual([42]);
  // Nor may a check WRITE to paragraphs it leaves alone: the page's own
  // MutationObserver sees everything justif touches, so a re-read that marks
  // every paragraph is a re-read every annotation tool on the page pays for.
  expect(result.attributed).toEqual([42]);
});

test("forced layout does not scale with the content", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "layout counts come from CDP");
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");

  const enhance = async (count: number) => {
    await page.evaluate(
      ([fill, n]) => {
        // eslint-disable-next-line no-eval
        (0, eval)(`(${fill})`)(n);
      },
      [FILL.toString(), count] as const,
    );
    const before = await counters(session);
    await page.evaluate(async () => {
      const global = window as never as { __c: { ready: Promise<void> } };
      global.__c = window.__justif.justify([...document.getElementById("host")!.children], {
        hyphenate: window.__justif.hyphenateEnUS,
      }) as never;
      await global.__c.ready;
    });
    const after = await counters(session);
    return { layouts: after.layouts - before.layouts, recalcs: after.recalcs - before.recalcs };
  };

  const small = await enhance(100);
  await page.evaluate(() => (window as never as { __c: { destroy: () => void } }).__c.destroy());
  const large = await enhance(300);
  console.log(`enhance: 100 paragraphs ${JSON.stringify(small)}, 300 ${JSON.stringify(large)}`);

  // Reads are batched, so tripling the content must not triple the forced
  // layouts: measured, both sit in the low single digits. A per-paragraph read
  // creeping into the write phase is what this catches, and it would show as
  // hundreds.
  expect(large.layouts, "forced layouts for 300 paragraphs").toBeLessThan(30);
  expect(large.layouts - small.layouts, "layouts added by 200 more paragraphs").toBeLessThan(
    15,
  );

  // And a re-read that finds nothing forces no layout at all: the comparison is
  // a computed-style read per paragraph, nothing more.
  await page.waitForTimeout(300);
  const before = await counters(session);
  const changed = await page.evaluate(
    () => (window as never as { __c: { rescan: () => readonly unknown[] } }).__c.rescan().length,
  );
  const after = await counters(session);
  console.log(
    `no-op rescan of 300: ${after.layouts - before.layouts} layouts, ${
      after.recalcs - before.recalcs
    } recalcs`,
  );
  expect(changed).toBe(0);
  expect(after.layouts - before.layouts, "forced layouts for a no-op re-read").toBe(0);
  expect(after.recalcs - before.recalcs, "style recalculations for a no-op re-read").toBeLessThan(
    6,
  );
  await page.evaluate(() => (window as never as { __c: { destroy: () => void } }).__c.destroy());
});

test("memory stops growing once the caches are warm", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "heap measurement comes from CDP");
  test.slow();
  const session = await page.context().newCDPSession(page);
  const heapKB = async () => {
    await session.send("HeapProfiler.collectGarbage");
    const { usedSize } = await session.send("Runtime.getHeapUsage");
    return Math.round(usedSize / 1024);
  };
  const cycle = () =>
    page.evaluate(async (fill) => {
      // eslint-disable-next-line no-eval
      (0, eval)(`(${fill})`)(60);
      const host = document.getElementById("host")!;
      const controller = window.__justif.justify([...host.children], {
        hyphenate: window.__justif.hyphenateEnUS,
      });
      await controller.ready;
      controller.rescan();
      controller.destroy();
      host.replaceChildren();
    }, FILL.toString());

  // Warm first: the measurement caches fill on the way in, and that growth is
  // bounded by design. What must not happen is growth that continues.
  for (let i = 0; i < 4; i++) await cycle();
  const warm = await heapKB();
  for (let i = 0; i < 8; i++) await cycle();
  const later = await heapKB();
  console.log(`heap: ${warm}KB warm, ${later}KB after 8 more cycles`);

  // Measured: ~110KB across these cycles, and flat from there. A per-document
  // leak — the kind 0.6.4 fixed — grows by megabytes over this many.
  expect(later - warm, "heap growth (KB) over 8 justify/rescan/destroy cycles").toBeLessThan(
    600,
  );
});
