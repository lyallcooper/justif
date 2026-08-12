import { expect, type Page, test } from "@playwright/test";

/**
 * Load the demo as a first-time visitor would, after the caller has cleared
 * the saved parameters. It must be a NAVIGATION and not a reload: Firefox
 * restores form control state across a reload, and `#view` is the one control
 * the demo's init reads rather than assigns, so a restored "flicker" would
 * silently pick the flicker defaults out of a supposedly fresh load.
 */
async function freshVisit(page: Page): Promise<void> {
  await page.goto("/demo/");
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("fonts-loading"),
  );
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("explains that the demo requires JavaScript", async ({ page }) => {
    await page.goto("/demo/");

    await expect(page.getByRole("alert")).toContainText("Hello!");
  });
});

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
      hanging: rect("#hangpunct"),
      pretty: rect("#pretty"),
      blur: rect("#blur"),
    };
  });

  expect(Math.abs(layout.sample.top - layout.typeface.top)).toBeLessThan(1);
  expect(layout.sample.right).toBeLessThan(layout.typeface.left);
  expect(layout.width.top).toBeGreaterThan(layout.sample.bottom);
  expect(Math.abs(layout.width.left - layout.sample.left)).toBeLessThan(1);
  expect(Math.abs(layout.width.right - layout.typeface.right)).toBeLessThan(1);
  expect(Math.abs(layout.protrusion.top - layout.hyphenation.top)).toBeLessThan(1);
  expect(layout.hanging.top).toBeGreaterThan(layout.hyphenation.bottom);
  expect(Math.abs(layout.pretty.top - layout.blur.top)).toBeLessThan(1);
});

test("open drawer leaves the bottom of the sample scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "frankenstein");

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const geometry = await page.evaluate(() => ({
    articleBottom: document.querySelector("#enhanced")!.getBoundingClientRect().bottom,
    dockTop: document.querySelector("#dock")!.getBoundingClientRect().top,
    scrollable: document.documentElement.scrollHeight > window.innerHeight,
  }));

  expect(geometry.scrollable).toBe(true);
  expect(geometry.articleBottom).toBeLessThan(geometry.dockTop);
});

test("opening the drawer preserves the current sample viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "frankenstein");
  await page.click("#dock-toggle");
  await page.evaluate(() => window.scrollTo(0, 360));

  const viewportBefore = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll("#enhanced > p")].find((element) => {
      const { top } = element.getBoundingClientRect();
      return top >= 0 && top < innerHeight;
    });
    return {
      scrollY: window.scrollY,
      paragraphTop: paragraph?.getBoundingClientRect().top ?? null,
    };
  });

  await page.click("#dock-toggle");
  await page.waitForTimeout(250);
  const viewportAfter = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll("#enhanced > p")].find((element) => {
      const { top } = element.getBoundingClientRect();
      return top >= 0 && top < innerHeight;
    });
    return {
      scrollY: window.scrollY,
      paragraphTop: paragraph?.getBoundingClientRect().top ?? null,
    };
  });

  expect(viewportAfter.scrollY).toBe(viewportBefore.scrollY);
  expect(viewportAfter.paragraphTop).toBeCloseTo(viewportBefore.paragraphTop!, 1);
});

test("specimen sample sets its opening lines beside the drop cap", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "specimen");

  // The drop-cap paragraph is enhanced, not declined: the leading-element
  // float path accepts it.
  const para = page.locator("#enhanced > p.has-dropcap");
  await expect(para).toHaveCount(1);
  await expect(para).toHaveAttribute("data-justif", "", { timeout: 15_000 });

  // The initial renders in the subset Goudy face, not a fallback serif.
  await expect
    .poll(() =>
      page.evaluate(() => document.fonts.check('normal 400 16px "Goudy Initialen"')),
    )
    .toBe(true);

  const geometry = await para.evaluate((p) => {
    const float = p.querySelector(".dropcap-group")!.getBoundingClientRect();
    const range = document.createRange();
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let besideFloat = 0;
    let belowFloatAtMargin = 0;
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if ((n.parentElement as HTMLElement).closest(".dropcap-group") !== null) continue;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.nodeValue ?? "")) !== null) {
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const r = range.getClientRects()[0];
        if (r === undefined || r.width <= 0) continue;
        if (r.top < float.bottom - 4 && r.left > float.right - 4) besideFloat++;
        else if (r.top >= float.bottom - 4 && r.left < float.left + float.width * 0.5) {
          belowFloatAtMargin++;
        }
      }
    }
    return { besideFloat, belowFloatAtMargin };
  });
  // Opening lines set beside the initial; the paragraph resumes at the
  // margin once the float ends.
  expect(geometry.besideFloat).toBeGreaterThan(8);
  expect(geometry.belowFloatAtMargin).toBeGreaterThan(4);

  // The initial fills its box exactly: the face's metrics (ascent 80%,
  // descent 0) and the strut fallback pin the baseline, so no engine's
  // fallback half-leading may shift the glyph inside the background plate.
  const fit = await para.evaluate((p) => {
    const group = p.querySelector(".dropcap-group")!;
    const cap = group.querySelector(".dropcap")!;
    const range = document.createRange();
    range.setStart(cap.firstChild!, 0);
    range.setEnd(cap.firstChild!, 1);
    const g = group.getBoundingClientRect();
    const t = range.getClientRects()[0]!;
    return { dxLeft: t.left - g.left, dyTop: t.top - g.top, dyBottom: g.bottom - t.bottom };
  });
  expect(Math.abs(fit.dxLeft)).toBeLessThan(1);
  expect(Math.abs(fit.dyTop)).toBeLessThan(1);
  expect(Math.abs(fit.dyBottom)).toBeLessThan(1);

  // The native column shows the same structure for comparison.
  await expect(page.locator("#native > p.has-dropcap .dropcap")).toHaveText("T");
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

test("long-paragraph stress sample is one very long paragraph", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "longParagraph");

  await expect(page.locator("#native > p")).toHaveCount(1);
  await expect(page.locator("#enhanced > p")).toHaveCount(1);
  await expect(page.locator("#enhanced > p")).toHaveAttribute("data-justif", "", {
    timeout: 15_000,
  });
  await expect(page.locator("#native br")).toHaveCount(0);
  await expect(page.locator("#native > p")).toContainText(
    "theyre all so different Boylan",
  );
  expect(await page.locator("#native").evaluate((element) =>
    (element.textContent ?? "").trim().split(/\s+/).length,
  )).toBe(4_401);
});

test("flicker mode places the fleuron below both text layers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "longParagraph");
  await expect(page.locator("#enhanced > p")).toHaveAttribute("data-justif", "", {
    timeout: 15_000,
  });
  await page.click("#view-flicker");

  const geometry = await page.evaluate(() => {
    const panes = [...document.querySelectorAll<HTMLElement>(".pane")];
    const ornament = document.querySelector<HTMLElement>(".ornament")!;
    const [browserPane, justifPane] = panes;
    if (!browserPane || !justifPane) {
      throw new Error(`Expected two panes, found ${panes.length}`);
    }
    return {
      browserBottom: browserPane.getBoundingClientRect().bottom,
      justifBottom: justifPane.getBoundingClientRect().bottom,
      fleuronTop: ornament.getBoundingClientRect().top,
    };
  });
  expect(
    geometry.fleuronTop - Math.max(geometry.browserBottom, geometry.justifBottom),
    JSON.stringify(geometry),
  ).toBeGreaterThan(0);

  await page.click("#view-side");
  expect(await page.locator(".panes").evaluate((element: HTMLElement) =>
    element.style.minHeight,
  )).toBe("");
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
  await expect(page.locator('#sample optgroup[label="Prose"] option')).toHaveCount(5);
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

test("metrics read the drop cap as neither a word space nor a line", async ({ page }) => {
  await page.goto("/demo/");
  await page.click("#dock-toggle");
  await page.selectOption("#sample", "specimen");
  await page.check("#deviation");

  const rows = page.locator("#metrics table").nth(1).locator("tbody tr");
  const loosest = rows.nth(3).locator("td").nth(2);
  await expect(rows.nth(3).locator("td").nth(0)).toHaveText("loosest space");
  // The float is 0.8em of a 6.75em initial wide — the better part of the
  // measure. Counted as a space it dwarfs every real one (it reported around
  // +2300%, in both columns at once), so any plausible word space is proof
  // enough that the initial is not one. Polled: the row holds a placeholder
  // until the first analysis lands.
  await expect
    .poll(async () => Number((await loosest.textContent())!.match(/\d+/)?.[0] ?? NaN), {
      timeout: 15_000,
    })
    .toBeLessThan(500);

  // Nor does the drop cap collect a deviation mark of its own.
  const marksOverFloat = await page.locator("#enhanced").evaluate((article) => {
    const float = article.querySelector(".dropcap-group")!.getBoundingClientRect();
    return [...article.querySelectorAll(".gapmark")].filter((mark) => {
      const r = mark.getBoundingClientRect();
      return r.right > float.left + 1 && r.left < float.right - 1 &&
        r.bottom > float.top + 1 && r.top < float.bottom - 1;
    }).length;
  });
  expect(marksOverFloat).toBe(0);

  // The initial and its hanging quote sit outside the flow, so neither adds
  // a line to the count: it matches the body lines a reader can count.
  const counts = await page.evaluate(() => {
    const bodyLines = (article: Element) => {
      const range = document.createRange();
      let total = 0;
      for (const p of article.querySelectorAll("p")) {
        const tops: number[] = [];
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const parent = n.parentElement!;
          if (parent.closest(".dropcap-group") !== null) continue;
          const re = /\S+/g;
          let m;
          while ((m = re.exec(n.nodeValue ?? "")) !== null) {
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            for (const r of range.getClientRects()) {
              if (r.width > 0) tops.push(r.top);
            }
          }
        }
        tops.sort((a, b) => a - b);
        total += tops.filter((top, i) => i === 0 || top - tops[i - 1]! >= 10).length;
      }
      return total;
    };
    const reported = document.querySelector("#metrics table")!
      .querySelector("tbody tr")!.querySelectorAll("td");
    return {
      native: { measured: bodyLines(document.getElementById("native")!),
        reported: Number(reported[1]!.textContent) },
      enhanced: { measured: bodyLines(document.getElementById("enhanced")!),
        reported: Number(reported[2]!.textContent) },
    };
  });
  expect(counts.native.reported).toBe(counts.native.measured);
  expect(counts.enhanced.reported).toBe(counts.enhanced.measured);
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

  // The masthead github link is normal navigation, not part of the
  // comparison: pressing it must not swap layers.
  const ghLink = page.locator(".gh-link a");
  await ghLink.dispatchEvent("pointerdown", { button: 0 });
  await expect(page.locator("body")).not.toHaveClass(/show-browser/);
  await ghLink.dispatchEvent("pointerup", { button: 0 });

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
  await freshVisit(page);
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
  await freshVisit(page);
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

  // Wait for the paragraph to stop changing, then measure in the SAME
  // evaluation. Two separate races otherwise: the width control patches
  // paragraphs asynchronously and more than one patch can land (a read after
  // a bare geometry gate measured this segment mid-line on WebKit under load,
  // a -210px overhang), and the deferred wrap correction lands a frame or two
  // after the first plausible geometry — so an earlier read reports the
  // provisional pre-correction hang, which is 1.5px of wrap-safety pad away
  // from what actually ships.
  const geometry = await page.evaluate(async () => {
    const find = () => {
      const paragraph = [...document.querySelectorAll<HTMLElement>("#enhanced p")].find(
        (candidate) => candidate.textContent?.includes("above supplies"),
      );
      const seg = paragraph
        ? [...paragraph.querySelectorAll<HTMLElement>("code .justif-seg")].find(
            (candidate) => candidate.textContent === "{ hyphenate:",
          )
        : undefined;
      return paragraph === undefined || seg === undefined ? null : { paragraph, seg };
    };
    // Two frames head start: lets already-queued observer/rAF slices begin,
    // so the first sample doesn't read a pre-correction DOM as "settled".
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    const deadline = performance.now() + 2000;
    let previous: string | null = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 120));
      const found = find();
      const html = found?.paragraph.innerHTML ?? null;
      if (found !== null && html === previous) {
        const paragraphStyle = getComputedStyle(found.paragraph);
        const contentRight =
          found.paragraph.getBoundingClientRect().right -
          parseFloat(paragraphStyle.paddingRight) -
          parseFloat(paragraphStyle.borderRightWidth);
        return {
          overhang: found.seg.getBoundingClientRect().right - contentRight,
          background: getComputedStyle(found.seg).backgroundColor,
        };
      }
      previous = html;
      if (performance.now() > deadline) return null;
    }
  });

  expect(geometry, "paragraph settled within 2s").not.toBeNull();
  // Settled values, not the provisional ones: the colon hangs about half its
  // advance in Chromium (3.55) and Firefox (2.48). WebKit's corrective DOM
  // measurement absorbs this Courier Prime colon's modeled credit entirely
  // (0.002px), so all that can be required there is that correcting the line
  // never pulls the punctuation back inside the measure. The cross-font
  // fixture in justif.spec verifies material internal-slice hangs in every
  // engine.
  expect(geometry!.overhang).toBeGreaterThan(browserName === "webkit" ? -0.5 : 2);
  expect(geometry!.background).not.toBe("rgba(0, 0, 0, 0)");
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
  // Hanging punctuation is independent of protrusion, so switching protrusion
  // off no longer implies flush line ends: this test wants every optical margin
  // effect off, which is now two controls.
  await page.selectOption("#hangpunct", "none");
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
