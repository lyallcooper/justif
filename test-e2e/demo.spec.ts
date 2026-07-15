import { expect, test } from "@playwright/test";

test("comparison view controls live in the collapsed dock bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );

  await expect(page.locator("#dock-bar > .view-toggle")).toBeVisible();
  await expect(page.locator("#dock-body")).toBeHidden();
  await page.click("#view-flicker");
  await expect(page.locator("body")).toHaveClass(/flicker-mode/);
  await expect(page.locator("#hold-browser")).toBeVisible();

  const edges = await page.evaluate(() => {
    const first = document.getElementById("dock-toggle")!.getBoundingClientRect();
    const last = document.getElementById("hold-browser")!.getBoundingClientRect();
    return { left: first.left, right: last.right, viewport: document.documentElement.clientWidth };
  });
  expect(edges.left).toBeGreaterThanOrEqual(0);
  expect(edges.right).toBeLessThanOrEqual(edges.viewport);

  await page.locator("#hold-browser").dispatchEvent("pointerdown", { button: 0 });
  await expect(page.locator("body")).toHaveClass(/show-browser/);
  await page.locator("#hold-browser").dispatchEvent("pointerup", { button: 0 });
  await expect(page.locator("body")).not.toHaveClass(/show-browser/);

  await page.click("#dock-toggle");
  await expect(page.locator("#dock-body")).toBeVisible();
  await expect(page.locator("#dock-bar > .view-toggle")).toBeVisible();
});

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
