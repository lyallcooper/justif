import { expect, test } from "@playwright/test";

/** The fixture samples geometry immediately before each paint. The first
 * visible sample must already equal every later visible sample. */
for (const mode of ["", "?hide"] as const) {
  const recipe = mode === "" ? "render-blocking drop-in" : "hide-until-ready";

  test(`${recipe}: first visible frame is the final one`, async ({ page, browserName }) => {
    test.skip(
      mode === "" && browserName === "firefox",
      "Firefox ignores blocking=render, so it paints native justification and " +
        "reflows ~25ms later; only the page can close that gap, which ?hide does",
    );

    await page.goto(`/test-e2e/fixture-noshift.html${mode}`);
    await page.evaluate(() => window.justif!.booted);
    const afterBoot = await page.evaluate(() => window.__frames.length);
    await page.waitForFunction((start) => window.__frames.length >= start + 20, afterBoot);

    const r = await page.evaluate(() => {
      const frames = window.__frames.filter((frame) => frame.visible && frame.geometry !== "");
      let changes = 0;
      for (let i = 1; i < frames.length; i++) {
        if (frames[i]!.geometry !== frames[i - 1]!.geometry) changes++;
      }
      return {
        changes,
        samples: frames.length,
        enhanced: document.querySelectorAll("#host p[data-justif]").length,
      };
    });

    expect(r.enhanced, "all three paragraphs should enhance").toBe(3);
    expect(r.samples, "need multiple visible frame samples").toBeGreaterThan(1);
    expect(r.changes, "geometry changed after the first visible frame").toBe(0);
  });
}

declare global {
  interface Window {
    __frames: Array<{ geometry: string; visible: boolean }>;
  }
}
