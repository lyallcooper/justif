import { expect, test } from "@playwright/test";

test("favicon SVG adapts to the preferred color scheme", async ({ page }) => {
  await page.goto("/demo/");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute("href", "./favicon.svg?v=2");

  const renderedColors = () => page.evaluate(() => ({
    background: getComputedStyle(document.getElementById("Rounded-Rectangle")!).fill,
    mark: getComputedStyle(document.getElementById("J")!).fill,
  }));

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/demo/favicon.svg?v=2");
  expect(await renderedColors()).toEqual({
    background: "rgb(255, 255, 255)",
    mark: "rgb(0, 0, 0)",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  expect(await renderedColors()).toEqual({
    background: "rgb(0, 0, 0)",
    mark: "rgb(255, 255, 255)",
  });
});

test("comparison controls stay stable and explain flicker once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );

  await expect(page.locator("#dock-bar > .view-toggle")).toBeVisible();
  await expect(page.locator("#dock-body")).toBeHidden();
  const centerBefore = await page.locator("#dock-toggle").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.left + rect.width / 2;
  });
  const viewsBefore = await page.locator(".view-toggle").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  await page.click("#view-flicker");
  await expect(page.locator("body")).toHaveClass(/flicker-mode/);
  await expect(page.locator("#flicker-hint")).toBeVisible();
  await expect(page.locator("#flicker-hint .pointer-action")).toBeVisible();
  await expect(page.locator("#flicker-hint .touch-action")).toBeHidden();

  const edges = await page.evaluate(() => {
    const views = document.querySelector(".view-toggle")!.getBoundingClientRect();
    const dock = document.getElementById("dock")!.getBoundingClientRect();
    const label = document.getElementById("dock-toggle")!.getBoundingClientRect();
    const hint = document.getElementById("flicker-hint")!.getBoundingClientRect();
    return {
      left: views.left,
      viewsRight: views.right,
      labelLeft: label.left,
      labelCenter: label.left + label.width / 2,
      hintLeft: hint.left,
      hintRight: hint.right,
      hintCenter: hint.left + hint.width / 2,
      hintBottom: hint.bottom,
      dockTop: dock.top,
      viewport: document.documentElement.clientWidth,
    };
  });
  expect(edges.left).toBeGreaterThanOrEqual(0);
  expect(edges.viewsRight).toBeLessThanOrEqual(edges.labelLeft);
  expect(edges.hintLeft).toBeGreaterThanOrEqual(0);
  expect(edges.hintRight).toBeLessThanOrEqual(edges.viewport);
  expect(Math.abs(edges.hintCenter - edges.viewport / 2)).toBeLessThan(1);
  expect(edges.hintBottom).toBeLessThan(edges.dockTop);
  expect(Math.abs(edges.left - viewsBefore.left)).toBeLessThan(0.01);
  expect(Math.abs(edges.viewsRight - viewsBefore.right)).toBeLessThan(0.01);
  expect(Math.abs(edges.labelCenter - centerBefore)).toBeLessThan(0.01);

  await page.click("#dock-toggle");
  await expect(page.locator("#dock-body")).toBeVisible();
  await expect(page.locator("#dock-bar > .view-toggle")).toBeVisible();
  const expandedEdges = await page.evaluate(() => {
    const dock = document.getElementById("dock")!.getBoundingClientRect();
    const hint = document.getElementById("flicker-hint")!.getBoundingClientRect();
    return { dockTop: dock.top, hintBottom: hint.bottom };
  });
  expect(expandedEdges.hintBottom).toBeLessThan(expandedEdges.dockTop);

  const text = page.locator("#enhanced .justif-seg").first();
  await text.dispatchEvent("pointerdown", { button: 0 });
  await expect(page.locator("body")).toHaveClass(/show-browser/);
  await text.dispatchEvent("pointerup", { button: 0 });
  await expect(page.locator("body")).not.toHaveClass(/show-browser/);

  await page.waitForFunction(
    () => !document.getElementById("flicker-hint")!.hasAttribute("data-visible"),
    undefined,
    { timeout: 6000 },
  );
  expect(
    await page.locator("#flicker-hint").evaluate((el) => getComputedStyle(el).visibility),
  ).toBe("visible");
  await expect(page.locator("#flicker-hint")).toBeHidden({ timeout: 500 });
  await page.click("#view-side");
  await page.click("#view-flicker");
  await expect(page.locator("#flicker-hint")).toBeHidden();
});

test("flicker toast uses touch wording on coarse pointers", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("http://localhost:5199/demo/");
  await page.click("#view-flicker");
  await expect(page.locator("#flicker-hint .pointer-action")).toBeHidden();
  await expect(page.locator("#flicker-hint .touch-action")).toBeVisible();
  await context.close();
});

test("comparison views retain independent widths", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 844 });
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );

  const measure = page.locator("#measure");
  const setMeasure = (value: string) => measure.evaluate((el: HTMLInputElement, next) => {
    el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

  await expect(measure).toHaveValue("13");
  await page.click("#view-flicker");
  await expect(measure).toHaveValue("19.5");
  await setMeasure("18");

  await page.click("#view-side");
  await expect(measure).toHaveValue("13");
  await setMeasure("15");
  await page.click("#view-flicker");
  await expect(measure).toHaveValue("18");
  await page.click("#view-side");
  await expect(measure).toHaveValue("15");

  expect(await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("justif-demo-params")!);
    return saved.measureByView;
  })).toEqual({ side: 15, flicker: 18 });

  await page.reload();
  await expect(measure).toHaveValue("15");
  await page.click("#view-flicker");
  await expect(measure).toHaveValue("18");

  await page.evaluate(() => localStorage.removeItem("justif-demo-params"));
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.reload();
  await expect(measure).toHaveValue("16");
  await page.click("#view-flicker");
  await expect(measure).toHaveValue("24");
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
