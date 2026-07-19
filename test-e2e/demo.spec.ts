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

test("appearance control supports system, light, and dark modes", async ({ page }) => {
  const root = page.locator("html");
  const background = () => root.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/demo/");
  await expect(root).toHaveAttribute("data-theme", "system");
  expect(await background()).toBe("rgb(18, 18, 16)");

  await page.click("#dock-toggle");
  await expect(page.locator("#theme-system")).toHaveAttribute("aria-pressed", "true");
  await page.click("#theme-light");
  await expect(root).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe("rgb(255, 255, 255)");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe("rgb(255, 255, 255)");

  await page.click("#dock-toggle");
  await page.click("#theme-dark");
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await background()).toBe("rgb(18, 18, 16)");

  await page.click("#theme-system");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await background()).toBe("rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background()).toBe("rgb(18, 18, 16)");
});

test("drawer controls form compact responsive rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await page.click("#dock-toggle");

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)!;
      const label = element.closest("label") ?? element;
      const { left, right, top, bottom } = label.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      sample: rect("#sample"),
      typeface: rect("#font"),
      width: rect("#measure"),
      hyphenation: rect("#hyphenate"),
      protrusion: rect("#protrusion"),
      pretty: rect("#pretty"),
      blur: rect("#blur"),
    };
  });

  expect(Math.abs(layout.sample.top - layout.typeface.top)).toBeLessThan(1);
  expect(layout.sample.right).toBeLessThan(layout.typeface.left);
  expect(layout.width.top).toBeGreaterThan(layout.sample.bottom);
  expect(Math.abs(layout.width.left - layout.sample.left)).toBeLessThan(1);
  expect(Math.abs(layout.width.right - layout.typeface.right)).toBeLessThan(1);
  expect(Math.abs(layout.hyphenation.top - layout.protrusion.top)).toBeLessThan(1);
  expect(Math.abs(layout.pretty.top - layout.blur.top)).toBeLessThan(1);
});

test("short Alice excerpt is available as a sample", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "aliceExcerpt");

  await expect(page.locator("#native > p")).toHaveCount(3);
  await expect(page.locator("#enhanced > p")).toHaveCount(3);
  await expect(page.locator("#native > p").first()).toContainText(
    "“Perhaps it doesn’t understand English,”",
  );
});

test("Frankenstein excerpt is available as a sample", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");

  await page.selectOption("#sample", "frankenstein");
  await expect(page.locator("#native > p")).toHaveCount(6);
  await expect(page.locator("#enhanced > p")).toHaveCount(6);
  await expect(page.locator("#native > p").first()).toContainText(
    "It was on a dreary night of November",
  );
});

test("RFC 2324 is available as a quoted technical sample", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");

  await page.selectOption("#sample", "rfc2324");
  await expect(page.locator("#native > p")).toHaveCount(7);
  await expect(page.locator("#enhanced > p")).toHaveCount(7);
  await expect(page.locator("#native > p").first()).toContainText(
    "“There is coffee all over the world",
  );
  await expect(page.locator("#native")).toContainText("418 I’m a teapot");
  await expect(page.locator("#native code")).toHaveCount(2);
  await expect(page.locator("#native .smcp").filter({ hasText: "htcpcp" })).not.toHaveCount(0);
  await expect(page.locator("#native .smcp").filter({ hasText: "http" })).not.toHaveCount(0);
});

test("sample menu groups entries by type", async ({ page }) => {
  await page.goto("/demo/");

  expect(await page.locator("#sample optgroup").evaluateAll((groups) =>
    groups.map((group) => group.getAttribute("label")),
  )).toEqual([
    "Prose",
    "Technical",
    "Typography",
    "Other scripts",
  ]);
  await expect(page.locator('#sample optgroup[label="Prose"] option')).toHaveCount(4);
  await expect(page.locator('#sample optgroup[label="Technical"] option')).toHaveCount(2);
});

test("technical and specimen samples preserve their showcase markup", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");

  await page.selectOption("#sample", "tech");
  await expect(page.locator("#native > p")).toHaveCount(3);
  await expect(page.locator("#enhanced > pre")).toHaveCount(1);
  await expect(page.locator("#enhanced > pre")).not.toHaveAttribute("data-justif");
  await expect(page.locator("#native")).toContainText("getBoundingClientRect()");

  await page.selectOption("#sample", "specimen");
  await expect(page.locator("#native > p")).toHaveCount(4);
  await expect(page.locator("#native .smcp")).toHaveCount(3);
  await expect(page.locator("#native em")).toHaveCount(1);
  await expect(page.locator("#native strong")).toHaveCount(1);
  await expect(page.locator("#native a")).toHaveCount(1);
  await expect(page.locator("#native")).toContainText("Fig. 7");
  await expect(page.locator("#native")).toContainText("un­com­pro­mis­ing");
});

test("gap highlights use a symmetric grayscale ramp", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");

  const palette = () => page.evaluate(() => {
    const color = (direction: "loose" | "tight") => {
      const swatch = document.createElement("span");
      swatch.className = `gapmark ${direction}`;
      document.body.append(swatch);
      const background = getComputedStyle(swatch, "::after").backgroundColor;
      swatch.remove();
      return background;
    };
    return { loose: color("loose"), tight: color("tight") };
  });

  await page.click("#theme-light");
  expect(await palette()).toEqual({
    loose: "rgb(0, 0, 0)",
    tight: "rgb(0, 0, 0)",
  });

  await page.check("#deviation");
  await page.locator(".gapmark").first().waitFor();
  const ramp = await page.locator(".gapmark").first().evaluate((mark: HTMLElement) => ({
    opacity: Number(mark.style.opacity),
    deviation: Number(mark.title.match(/([+-]?\d+)%/)![1]) / 100,
    hostHeight: mark.getBoundingClientRect().height,
    boxHeight: parseFloat(getComputedStyle(mark, "::after").height),
    boxTop: parseFloat(getComputedStyle(mark, "::after").top),
  }));
  const ratio = 1 + ramp.deviation;
  const magnitude = ratio > 0 ? Math.max(ratio, 1 / ratio) : Infinity;
  const expectedOpacity = Math.min(1, (magnitude - 1.3) / (3 - 1.3));
  expect(Math.abs(ramp.opacity - expectedOpacity)).toBeLessThan(0.02);

  const intensity = (widthRatio: number) =>
    Math.min(1, (Math.max(widthRatio, 1 / widthRatio) - 1.3) / (3 - 1.3));
  expect(intensity(3)).toBe(1);
  expect(intensity(1 / 3)).toBe(1);
  expect(intensity(2.41)).toBeLessThan(1);
  expect(ramp.boxHeight / ramp.hostHeight).toBeCloseTo(0.7, 2);
  expect(ramp.boxTop / ramp.hostHeight).toBeCloseTo(0.5, 2);

  await page.click("#theme-dark");
  expect(await palette()).toEqual({
    loose: "rgb(255, 255, 255)",
    tight: "rgb(255, 255, 255)",
  });
});

test("metrics leave equally natural spacing unranked", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "soseki");

  const meanRow = page.locator("#metrics table").nth(1).locator("tbody tr").first();
  const browserMean = meanRow.locator("td").nth(1);
  const justifMean = meanRow.locator("td").nth(2);
  await expect(browserMean).toHaveText("100%", { timeout: 15_000 });
  await expect(justifMean).toHaveText("100%");
  await expect(browserMean).not.toHaveClass(/better|worse/);
  await expect(justifMean).not.toHaveClass(/better|worse/);
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

test("narrow windows use the 10em type specimen defaults", async ({ page }) => {
  await page.setViewportSize({ width: 455, height: 844 });
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );

  const sample = page.locator("#sample");
  const measure = page.locator("#measure");
  await expect(sample).toHaveValue("specimen");
  await expect(measure).toHaveValue("10");

  await page.click("#dock-toggle");
  await page.selectOption("#sample", "tale");
  await measure.evaluate((element: HTMLInputElement) => {
    element.value = "11";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#reset");
  await expect(sample).toHaveValue("specimen");
  await expect(measure).toHaveValue("10");

  await page.selectOption("#sample", "tale");
  await measure.evaluate((element: HTMLInputElement) => {
    element.value = "11";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.reload();
  await expect(sample).toHaveValue("tale");
  await expect(measure).toHaveValue("11");

  await page.evaluate(() => localStorage.removeItem("justif-demo-params"));
  await page.setViewportSize({ width: 456, height: 844 });
  await page.reload();
  await expect(sample).toHaveValue("aliceExcerpt");
  await expect(measure).toHaveValue("12");
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
  await expect(measure).toHaveValue("19");
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
  await expect(measure).toHaveValue("13");
  await page.click("#view-flicker");
  await expect(measure).toHaveValue("19");
});

test("line-start inline code halo protrudes while its text aligns to the measure", async ({
  page,
}) => {
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
    [...document.querySelectorAll<HTMLElement>("#enhanced p")].some(
      (p) =>
        p.textContent?.trim().startsWith("justify()") === true &&
        p.querySelector("code .justif-seg") !== null,
    ),
  );

  const geometry = await page.evaluate(() => {
    const p = [...document.querySelectorAll<HTMLElement>("#enhanced p")].find((candidate) =>
      candidate.textContent?.trim().startsWith("justify()"),
    )!;
    const code = p.querySelector<HTMLElement>("code")!;
    const seg = code.querySelector<HTMLElement>(".justif-seg")!;
    const paragraphStyle = getComputedStyle(p);
    const codeStyle = getComputedStyle(code);
    const contentLeft =
      p.getBoundingClientRect().left +
      parseFloat(paragraphStyle.paddingLeft) +
      parseFloat(paragraphStyle.borderLeftWidth);
    const firstHaloRect = [...code.getClientRects()].sort(
      (a, b) => a.top - b.top || a.left - b.left,
    )[0]!;
    const range = document.createRange();
    range.selectNodeContents(seg);
    return {
      contentLeft,
      haloLeft: firstHaloRect.left,
      glyphLeft: range.getBoundingClientRect().left,
      inset: parseFloat(codeStyle.paddingLeft) + parseFloat(codeStyle.borderLeftWidth),
      cloneMargin: parseFloat(code.style.marginInlineStart),
      segmentBackground: getComputedStyle(seg).backgroundColor,
    };
  });

  expect(geometry.inset).toBeGreaterThan(3);
  expect(geometry.cloneMargin).toBeCloseTo(-geometry.inset, 1);
  expect(geometry.contentLeft - geometry.haloLeft).toBeCloseTo(geometry.inset, 0);
  expect(Math.abs(geometry.glyphLeft - geometry.contentLeft)).toBeLessThan(0.5);
  expect(geometry.segmentBackground).not.toBe("rgba(0, 0, 0, 0)");
});

test("punctuation protrudes at an internal slice of the technical code halo", async ({
  page,
  browserName,
}) => {
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "tech");
  await page.locator("#measure").evaluate((el: HTMLInputElement) => {
    el.value = "26";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.waitForFunction(() => {
    const paragraph = [...document.querySelectorAll<HTMLElement>("#enhanced p")].find(
      (candidate) => candidate.textContent?.includes("above supplies"),
    );
    const seg = paragraph
      ? [...paragraph.querySelectorAll<HTMLElement>("code .justif-seg")].find(
          (candidate) => candidate.textContent === "{ hyphenate:",
        )
      : undefined;
    if (paragraph === undefined || seg === undefined) return false;
    const paragraphStyle = getComputedStyle(paragraph);
    const contentRight =
      paragraph.getBoundingClientRect().right -
      parseFloat(paragraphStyle.paddingRight) -
      parseFloat(paragraphStyle.borderRightWidth);
    // The width control updates before its asynchronous paragraph patch.
    // Reject the transient old segment geometry (hundreds of px away).
    return Math.abs(seg.getBoundingClientRect().right - contentRight) < 20;
  });

  const geometry = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll<HTMLElement>("#enhanced p")].find(
      (candidate) => candidate.textContent?.includes("above supplies"),
    )!;
    const seg = [...paragraph.querySelectorAll<HTMLElement>("code .justif-seg")].find(
      (candidate) => candidate.textContent === "{ hyphenate:",
    )!;
    const paragraphStyle = getComputedStyle(paragraph);
    const contentRight =
      paragraph.getBoundingClientRect().right -
      parseFloat(paragraphStyle.paddingRight) -
      parseFloat(paragraphStyle.borderRightWidth);
    return {
      overhang: seg.getBoundingClientRect().right - contentRight,
      background: getComputedStyle(seg).backgroundColor,
    };
  });

  // The default colon code hangs half its advance. Leave room for the
  // measured wrap correction while requiring a material optical hang.
  // WebKit's corrective DOM measurement absorbs most of this particular
  // Courier Prime colon's modeled 50% credit; the cross-font fixture in
  // justif.spec verifies material internal-slice hangs in every engine.
  expect(geometry.overhang).toBeGreaterThan(browserName === "webkit" ? 0.1 : 2);
  expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
});

test("protrusion off keeps the technical sample's 13em code halo inside", async ({ page }) => {
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "tech");
  await page.locator("#measure").evaluate((el: HTMLInputElement) => {
    el.value = "13";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#protrusion").uncheck();
  await page.waitForFunction(() => {
    const code = [...document.querySelectorAll<HTMLElement>("#enhanced code")].find((el) =>
      el.textContent?.includes("getBoundingClientRect()"),
    );
    return (
      code !== undefined &&
      code.querySelector(".justif-seg") !== null &&
      (parseFloat(code.style.marginInlineStart) || 0) === 0
    );
  });

  const geometry = await page.evaluate(() => {
    const p = [...document.querySelectorAll<HTMLElement>("#enhanced p")].find((candidate) =>
      candidate.textContent?.includes("getBoundingClientRect()"),
    )!;
    const code = [...p.querySelectorAll<HTMLElement>("code")].find((candidate) =>
      candidate.textContent?.includes("getBoundingClientRect()"),
    )!;
    const paragraphStyle = getComputedStyle(p);
    const contentLeft =
      p.getBoundingClientRect().left +
      parseFloat(paragraphStyle.paddingLeft) +
      parseFloat(paragraphStyle.borderLeftWidth);
    const contentRight =
      p.getBoundingClientRect().right -
      parseFloat(paragraphStyle.paddingRight) -
      parseFloat(paragraphStyle.borderRightWidth);
    const halo = code.getBoundingClientRect();
    return {
      contentLeft,
      contentRight,
      haloLeft: halo.left,
      haloRight: halo.right,
      codeMarginStart: parseFloat(code.style.marginInlineStart) || 0,
    };
  });

  expect(geometry.codeMarginStart).toBe(0);
  expect(geometry.haloLeft).toBeGreaterThanOrEqual(geometry.contentLeft - 0.5);
  expect(
    geometry.haloRight - geometry.contentRight,
    JSON.stringify(geometry),
  ).toBeLessThanOrEqual(0.5);
});

test("a code chip continuing across a line repaints its internal slice edge", async ({
  page,
}) => {
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "rfc2324");
  await page.locator("#measure").evaluate((el: HTMLInputElement) => {
    el.value = "10";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.waitForFunction(() => {
    const code = [...document.querySelectorAll<HTMLElement>("#enhanced code")].find((el) =>
      el.textContent?.includes("418 I’m a teapot"),
    );
    if (code === undefined) return false;
    const tops = [...code.querySelectorAll<HTMLElement>(".justif-seg")].map(
      (seg) => seg.getBoundingClientRect().top,
    );
    return tops.some((top) => Math.abs(top - tops[0]!) > 5);
  });

  const paint = await page.evaluate(() => {
    const code = [...document.querySelectorAll<HTMLElement>("#enhanced code")].find((el) =>
      el.textContent?.includes("418 I’m a teapot"),
    )!;
    const segments = [...code.querySelectorAll<HTMLElement>(".justif-seg")];
    const finalTop = segments[segments.length - 1]!.getBoundingClientRect().top;
    // The correction pass may legitimately settle this slice's end margin
    // at zero or above when the rendered line underfills the model. Its
    // earlier line position—not the transient correction sign—is what
    // proves this is an internal slice.
    const sliced = segments.find((seg) => seg.getBoundingClientRect().top < finalTop - 5)!;
    return {
      hasInternalSlice: sliced !== undefined,
      codeBackground: getComputedStyle(code).backgroundColor,
      sliceBackground: sliced === undefined ? "" : getComputedStyle(sliced).backgroundColor,
    };
  });

  expect(paint.hasInternalSlice).toBe(true);
  expect(paint.sliceBackground).toBe(paint.codeBackground);
});
