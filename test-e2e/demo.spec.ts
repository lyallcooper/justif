import { expect, test } from "@playwright/test";

test("inline code background follows protruded end punctuation", async ({ page }) => {
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "tech");
  await page.locator("#measure").evaluate((el: HTMLInputElement) => {
    el.value = "10";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>("#enhanced code .justif-seg")].some(
      (seg) =>
        seg.textContent?.trim().endsWith(":") === true &&
        parseFloat(getComputedStyle(seg).marginInlineEnd) < 0,
    ),
  );

  const paint = await page.evaluate(() => {
    const seg = [...document.querySelectorAll<HTMLElement>("#enhanced code .justif-seg")].find(
      (candidate) =>
        candidate.textContent?.trim().endsWith(":") === true &&
        parseFloat(getComputedStyle(candidate).marginInlineEnd) < 0,
    )!;
    const code = seg.closest("code")!;
    return {
      codeBackground: getComputedStyle(code).backgroundColor,
      segmentBackground: getComputedStyle(seg).backgroundColor,
      marginEnd: parseFloat(getComputedStyle(seg).marginInlineEnd),
    };
  });

  expect(paint.marginEnd).toBeLessThan(-1);
  expect(paint.codeBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint.segmentBackground).toBe(paint.codeBackground);
});
