import { expect, test } from "@playwright/test";

/**
 * Performance budget from the project plan: ~10k words prepare+layout+patch
 * in well under 50ms warm. The "resize" number measures time-to-FIRST-flush:
 * resize re-layout is drained in slices under a ~10ms per-frame patch budget
 * with wrap-guarantee corrections deferred, so this is the latency until the
 * first paragraph's first line renders flush at the new width, not the full
 * drain. Run with generous CI headroom (3×) — the numbers logged are the
 * interesting part.
 */
test("10k-word document enhances within budget", async ({ page }) => {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);

  const timings = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.style.width = "440px";
    const base = document.getElementById("p1")!.textContent!;
    const words = base.split(/\s+/).length;
    const paragraphsNeeded = Math.ceil(10000 / words);
    host.replaceChildren(
      ...Array.from({ length: paragraphsNeeded }, () => {
        const p = document.createElement("p");
        p.textContent = base;
        return p;
      }),
    );

    const j = window.__justif;
    // Warm the word cache with a throwaway run (same text everywhere is the
    // best case; the cold number below still measures everything once).
    const t0 = performance.now();
    // protrusion off so the flush poll below has a fixed target edge.
    const c1 = j.justify(host.querySelectorAll("p"), {
      hyphenate: j.hyphenateEnUS,
      protrusion: false,
    });
    await c1.ready;
    const cold = performance.now() - t0;

    // Resize path: pure arithmetic + patch.
    const t1 = performance.now();
    host.style.width = "360px";
    await new Promise((resolve) => {
      const check = () => {
        const p = host.querySelector("p")!;
        if (p.hasAttribute("data-justif")) {
          // First visual line flush = re-layout landed for the new width.
          // __justifLines includes .justif-hyphen rects, so a line ending in
          // a pseudo-hyphen still reads as flush.
          const g = window.__justifLines(p);
          const first = g.lines[0];
          if (first !== undefined && Math.abs(first.right - g.contentRight) < 1) {
            return resolve(undefined);
          }
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const resize = performance.now() - t1;

    c1.destroy();
    return { cold, resize, paragraphs: paragraphsNeeded, words: paragraphsNeeded * words };
  });

  console.log(
    `justif perf: ${timings.words} words / ${timings.paragraphs} paragraphs — ` +
      `cold enhance ${timings.cold.toFixed(1)}ms, resize relayout ${timings.resize.toFixed(1)}ms`,
  );
  // Local budgets are calibrated on Apple-silicon dev machines; CI's shared
  // 2-core runners are ~2-4x slower (observed: WebKit resize 186ms vs ~30ms
  // local), so CI gets 4x headroom — still tight enough to catch an
  // order-of-magnitude regression, without flaking on runner variance.
  const scale = process.env.CI === undefined ? 1 : 4;
  expect(timings.cold).toBeLessThan(150 * scale);
  expect(timings.resize).toBeLessThan(100 * scale); // includes rAF waits; arithmetic is a fraction
});
