import { expect, test } from "@playwright/test";

const prose = "Among the numerous advantages promised by a well constructed Union, none deserves to be more accurately developed than its tendency to break and control the violence of faction. The careful setting of every line makes the relationship visible. ";

test.beforeEach(async ({ page }) => {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);
});

for (const side of ["left", "right"] as const) {
  for (const decorated of [false, true]) {
    test(`generated inline boundaries fit beside a ${side} float (decorated=${decorated})`, async ({ page }) => {
      const original = await page.evaluate(({ prose, side, decorated }) => {
        const style = document.createElement("style");
        style.textContent = `
          #host #generated { width: 781px; margin: 0; font: italic 24px/37.92px Georgia, serif; text-align: justify; }
          #host #generated > .cap { float: ${side}; width: 68.93px; height: 113.7px; }
          #host #generated a::before { content: "※"; font: normal 20px Georgia, serif; }
          #host #generated a::after { content: "\\2197"; font: normal 24px Georgia, serif; }
          ${decorated ? '#host #generated em { padding: 0 4px; background: #eee; } #host #generated a { padding: 0 3px; border: 1px solid; }' : ''}
        `;
        document.head.append(style);
        const p = document.createElement("p");
        p.id = "generated";
        p.innerHTML = '<span class="cap"></span><em><a href="#">' + prose.trim() + '</a></em> ' + prose.repeat(3);
        document.getElementById("host")!.replaceChildren(p);
        const html = p.innerHTML;
        const text = p.textContent;
        window.__justif.controller = window.__justif.justify([p], {
          onSkip: (_p: HTMLElement, reason: string) => { p.dataset.skip = reason; },
        });
        return { html, text };
      }, { prose, side, decorated });
      await page.evaluate(() => window.__justif.controller!.ready);
      const check = async () => {
        const result = await page.evaluate(() => {
          const p = document.getElementById("generated")!;
          const link = p.querySelector("a")!;
          const cap = p.querySelector(".cap")!.getBoundingClientRect();
          const rect = p.getBoundingClientRect();
          const lines = window.__justifLines(p).lines;
          return {
            enhanced: p.hasAttribute("data-justif"), skip: (p as HTMLElement).dataset.skip,
            text: p.textContent, html: p.innerHTML, links: p.querySelectorAll("a").length,
            before: getComputedStyle(link, "::before").content,
            after: getComputedStyle(link, "::after").content,
            weldStart: link.querySelector(".justif-generated-weld-start") !== null,
            weldEnd: link.querySelector(".justif-generated-weld-end") !== null,
            cap: { top: cap.top, bottom: cap.bottom, left: cap.left, right: cap.right },
            rect: { left: rect.left, right: rect.right }, lines,
          };
        });
        // Nested decorated boxes can outgrow the corrected float band at a
        // narrow measure. Font metrics vary across engines and platforms;
        // either safe enhancement or exact native restoration is required.
        const nativeFallback = result.skip !== undefined;
        if (nativeFallback) {
          expect(decorated).toBe(true);
          expect(result.skip).toBe("corrected lines do not fit beside the float");
          expect(result.enhanced).toBe(false);
          expect(result.html).toBe(original.html);
        } else {
          expect(result.skip).toBeUndefined();
          expect(result.enhanced).toBe(true);
        }
        expect(result.text?.replace(/\u00a0/g, " ").trim()).toBe(original.text?.trim());
        expect(result.links).toBe(1);
        expect(result.before).toContain("※");
        expect(result.after).toContain("↗");
        expect(result.weldStart).toBe(!nativeFallback);
        expect(result.weldEnd).toBe(!nativeFallback);
        expect(result.lines.length).toBeGreaterThan(4);
        for (const line of result.lines.slice(0, 3)) {
          expect(line.top).toBeLessThan(result.cap.bottom);
          if (side === "left") expect(line.left).toBeGreaterThanOrEqual(result.cap.right - 3);
          else expect(line.right).toBeLessThanOrEqual(result.cap.left + 1);
        }
        expect(result.lines[3]!.top).toBeGreaterThanOrEqual(result.cap.bottom - 1);
        for (const line of result.lines) {
          expect(line.left).toBeGreaterThanOrEqual(result.rect.left - 12);
          expect(line.right).toBeLessThanOrEqual(result.rect.right + 12);
        }
      };
      await check();
      await page.evaluate(async () => {
        document.getElementById("generated")!.style.width = "640px";
        window.__justif.controller!.refresh();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await check();
      const restored = await page.evaluate(() => {
        window.__justif.controller!.destroy();
        return document.getElementById("generated")!.innerHTML;
      });
      expect(restored).toBe(original.html);
    });
  }
}

test("unsupported generated content stays native with a reason", async ({ page }) => {
  const results = await page.evaluate(async (prose) => {
    const cases = [
      ['a::after', 'content: counter(example)'],
      ['a::after', 'content: "two words"'],
      ['a::before', 'content: "X"; display: inline-block'],
      ['a::before', 'content: "X"; position: absolute'],
      ['a::before', 'content: ""; background: red'],
      ['p::before', 'content: "X"'],
      ['a::after', 'content: "X"; margin-left: 3px'],
    ];
    const out = [];
    for (const [selector, rule] of cases) {
      const host = document.createElement("div");
      host.id = `generated-case-${out.length}`;
      host.innerHTML = `<style>#${host.id} ${selector} { ${rule} }</style><p style="width:400px"><a title="↗">Union</a> ${prose}</p>`;
      document.body.append(host);
      const p = host.querySelector("p")!;
      const html = p.innerHTML;
      let reason = "";
      const controller = window.__justif.justify([p], { onSkip: (_p: HTMLElement, why: string) => { reason = why; } });
      await controller.ready;
      out.push({ reason, enhanced: p.hasAttribute("data-justif"), unchanged: html === p.innerHTML });
      controller.destroy();
    }
    return out;
  }, prose);
  for (const result of results) {
    expect(result.reason).toContain("generated");
    expect(result.enhanced).toBe(false);
    expect(result.unchanged).toBe(true);
  }
});

test("single-character break opportunities are welded to their source text", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "generated-weld";
    p.style.cssText = "width:400px;margin:0;font:24px/38px Georgia,serif;text-align:justify";
    p.innerHTML = `<a>Boundary</a> ${prose}`;
    const style = document.createElement("style");
    style.textContent = '#generated-weld a::before { content:"-" } #generated-weld a::after { content:"—" }';
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    let skip = "";
    const controller = window.__justif.justify([p], {
      onSkip: (_p: HTMLElement, reason: string) => { skip = reason; },
    });
    await controller.ready;
    const link = p.querySelector("a")!;
    const start = link.querySelector(".justif-generated-weld-start");
    const end = link.querySelector(".justif-generated-weld-end");
    const result = {
      skip,
      enhanced: p.hasAttribute("data-justif"),
      start: start !== null && getComputedStyle(start, "::before").content.includes("\u2060"),
      end: end !== null && getComputedStyle(end, "::after").content.includes("\u2060"),
    };
    controller.destroy();
    return result;
  }, prose);
  expect(result).toEqual({ skip: "", enhanced: true, start: true, end: true });
});

test("generated boundaries stay welded through nested inline owners", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "nested-generated";
    p.style.cssText = "width:80px;margin:0;font:24px/32px monospace;text-align:justify";
    p.innerHTML = 'MMM<span class="outer"><span class="inner">WORD</span></span> tail words for another line';
    const style = document.createElement("style");
    style.textContent = `
      #nested-generated .outer::before { content:"/" }
      #nested-generated .inner::before { content:"A" }
    `;
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    let skip = "";
    const controller = window.__justif.justify([p], {
      onSkip: (_p: HTMLElement, reason: string) => { skip = reason; },
    });
    await controller.ready;
    const outer = p.querySelector<HTMLElement>(".outer")!;
    const inner = p.querySelector<HTMLElement>(".inner")!;
    const first = p.firstChild!;
    const firstRange = document.createRange();
    firstRange.selectNode(first);
    const wordRange = document.createRange();
    wordRange.selectNodeContents(inner.querySelector(".justif-seg")!);
    const welds = [...p.querySelectorAll<HTMLElement>(".justif-generated-outer-weld")];
    const result = {
      skip,
      enhanced: p.hasAttribute("data-justif"),
      welds: welds.length,
      welded: welds.every((weld) => getComputedStyle(weld, "::before").content.includes("\u2060")),
      sameLine: Math.abs(firstRange.getBoundingClientRect().top - wordRange.getBoundingClientRect().top) < 1,
      before: getComputedStyle(outer, "::before").content + getComputedStyle(inner, "::before").content,
    };
    controller.destroy();
    return result;
  });
  expect(result).toEqual({
    skip: "",
    enhanced: true,
    welds: 2,
    welded: true,
    sameLine: true,
    before: '"/""A"',
  });
});

test("generated content is pinned to the state measured by the scan", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "dynamic-generated";
    p.style.cssText = "width:400px;margin:0;font:24px/38px Georgia,serif;text-align:justify";
    p.innerHTML = `<a class="present">Boundary</a> <a class="absent">Stable</a> ${prose}`;
    const style = document.createElement("style");
    style.textContent = `
      #dynamic-generated a.present::before { content:"A"; font-size:18px }
      #dynamic-generated[data-justif] a.present::before { content:"XXXXXXXX"; font-size:60px }
      #dynamic-generated[data-justif] a.absent::before { content:"XXXXXXXX" }
      #dynamic-generated[data-justif]::after { content:"XXXXXXXX" }
    `;
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    let skip = "";
    const controller = window.__justif.justify([p], {
      onSkip: (_p: HTMLElement, reason: string) => { skip = reason; },
    });
    await controller.ready;
    const present = getComputedStyle(p.querySelector(".present")!, "::before");
    const absent = getComputedStyle(p.querySelector(".absent")!, "::before");
    const result = {
      skip,
      enhanced: p.hasAttribute("data-justif"),
      present: present.content,
      size: present.fontSize,
      absent: absent.content,
      paragraph: getComputedStyle(p, "::after").content,
    };
    controller.destroy();
    return result;
  }, prose);
  expect(result).toEqual({
    skip: "",
    enhanced: true,
    present: '"A"',
    size: "18px",
    absent: "none",
    paragraph: "none",
  });
});

test("an overriding important pseudo rule restores native layout", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "important-generated";
    p.style.cssText = "width:400px;margin:0;font:24px/38px Georgia,serif;text-align:justify";
    p.innerHTML = `<a>Boundary</a> ${prose}`;
    const style = document.createElement("style");
    style.textContent = `
      #important-generated a::before { content:"A" }
      #important-generated[data-justif] a::before { content:"XXXXXXXX"!important }
    `;
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    const html = p.innerHTML;
    let skip = "";
    const controller = window.__justif.justify([p], {
      onSkip: (_p: HTMLElement, reason: string) => { skip = reason; },
    });
    await controller.ready;
    const result = {
      skip,
      enhanced: p.hasAttribute("data-justif"),
      restored: p.innerHTML === html,
    };
    controller.destroy();
    return result;
  }, prose);
  expect(result).toEqual({
    skip: "generated content changed after enhancement",
    enhanced: false,
    restored: true,
  });
});

test("generated welds do not inherit author letter spacing", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "spaced-generated";
    p.style.cssText = "width:500px;margin:0;font:24px/38px Georgia,serif;letter-spacing:10px;text-align:justify";
    p.innerHTML = `<a>Boundary</a> ${prose}`;
    const style = document.createElement("style");
    style.textContent = '#spaced-generated a::after { content:"↗" }';
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    const controller = window.__justif.justify([p]);
    await controller.ready;
    const source = p.querySelector<HTMLElement>(".justif-generated-weld-end")!;
    const outer = p.querySelector<HTMLElement>(".justif-generated-outer-weld")!;
    const result = {
      enhanced: p.hasAttribute("data-justif"),
      source: getComputedStyle(source, "::after").letterSpacing,
      outer: getComputedStyle(outer, "::before").letterSpacing,
    };
    controller.destroy();
    return result;
  }, prose);
  expect(result.enhanced).toBe(true);
  expect(result.source).not.toBe("10px");
  expect(result.outer).not.toBe("10px");
});

for (const pseudo of ["before", "after"]) {
  test(`a first-line link's ::${pseudo} stays beside a leading float`, async ({ page }) => {
    const result = await page.evaluate(async ({ prose, pseudo }) => {
      const p = document.createElement("p");
      p.id = "first-line-generated";
      p.style.cssText = "width:781px;margin:0;font:24px/37.92px Georgia,serif;text-align:justify";
      p.innerHTML = '<span style="float:left;width:68.93px;height:113.7px"></span>Among the <a>numerous</a> ' + prose.repeat(3);
      const style = document.createElement("style");
      style.textContent = `#first-line-generated a::${pseudo} { content: "↗"; font-size: 28px; padding: 0 2px; }`;
      document.head.append(style);
      document.getElementById("host")!.replaceChildren(p);
      let skip = "";
      const controller = window.__justif.justify([p], { onSkip: (_p: HTMLElement, reason: string) => { skip = reason; } });
      await controller.ready;
      const cap = p.firstElementChild!.getBoundingClientRect();
      const lines = window.__justifLines(p).lines;
      const link = p.querySelector("a")!.getBoundingClientRect();
      const result = { skip, enhanced: p.hasAttribute("data-justif"), tops: lines.slice(0, 3).map((line) => line.top), bottom: cap.bottom, linkLeft: link.left, floatRight: cap.right };
      controller.destroy();
      return result;
    }, { prose, pseudo });
    expect(result.skip).toBe("");
    expect(result.enhanced).toBe(true);
    for (const top of result.tops) expect(top).toBeLessThan(result.bottom);
    expect(result.linkLeft).toBeGreaterThan(result.floatRight);
  });
}

test("a failed float placement restores native DOM instead of keeping displaced lines", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "displaced-generated";
    p.style.cssText = "width:500px;font:24px/38px Georgia,serif";
    p.innerHTML = '<span style="float:left;width:70px;height:114px"></span>' + prose.repeat(2);
    const style = document.createElement("style");
    style.textContent = '#displaced-generated[data-justif] .justif-seg { display:inline-block!important; min-width:600px!important }';
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    const html = p.innerHTML;
    const originalStyle = p.getAttribute("style");
    let skip = "";
    const controller = window.__justif.justify([p], { onSkip: (_p: HTMLElement, reason: string) => { skip = reason; } });
    await controller.ready;
    controller.refresh();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const result = { skip, enhanced: p.hasAttribute("data-justif"), html: p.innerHTML === html, style: p.getAttribute("style") === originalStyle };
    controller.destroy();
    return result;
  }, prose);
  expect(result).toEqual({ skip: "corrected lines do not fit beside the float", enhanced: false, html: true, style: true });
});

test("a nested first-letter float source participates in placement validation", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const p = document.createElement("p");
    p.id = "nested-dropcap-displaced";
    p.style.cssText = "width:500px;margin:0;font:24px/38px Georgia,serif;text-align:justify";
    p.innerHTML = `<em>${prose.repeat(2)}</em>`;
    const style = document.createElement("style");
    style.textContent = `
      #nested-dropcap-displaced::first-letter { float:left; font-size:72px; line-height:.8 }
      #nested-dropcap-displaced[data-justif] .justif-seg { display:inline-block!important; min-width:600px!important }
    `;
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    const html = p.innerHTML;
    let skip = "";
    const controller = window.__justif.justify([p], {
      onSkip: (_p: HTMLElement, reason: string) => { skip = reason; },
    });
    await controller.ready;
    controller.refresh();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const result = {
      skip,
      enhanced: p.hasAttribute("data-justif"),
      restored: p.innerHTML === html,
    };
    controller.destroy();
    return result;
  }, prose);
  expect(result).toEqual({
    skip: "corrected lines do not fit beside the float",
    enhanced: false,
    restored: true,
  });
});

test("generated symbols preserve RTL float placement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.id = "rtl-generated";
    p.dir = "rtl";
    p.style.cssText = "width:600px;margin:0;font:24px/38px Arial,sans-serif;text-align:justify";
    const text = "זהו טקסט ארוך בעברית אשר מתאר את הדרך שבה מילים מופיעות בתוך שורות שונות של פסקה ";
    p.innerHTML = '<span style="float:right;width:70px;height:113.7px"></span><a>זהו טקסט</a> ' + text.repeat(6);
    const style = document.createElement("style");
    style.textContent = '#rtl-generated a::after { content:"↗" }';
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    let skip = "";
    const controller = window.__justif.justify([p], { onSkip: (_p: HTMLElement, reason: string) => { skip = reason; } });
    await controller.ready;
    const cap = p.firstElementChild!.getBoundingClientRect();
    const result = {
      skip, enhanced: p.hasAttribute("data-justif"), lines: window.__justifLines(p).lines.slice(0, 3),
      bottom: cap.bottom, left: cap.left,
    };
    controller.destroy();
    return result;
  });
  expect(result.skip).toBe("");
  expect(result.enhanced).toBe(true);
  expect(result.lines).toHaveLength(3);
  for (const line of result.lines) {
    expect(line.top).toBeLessThan(result.bottom);
    expect(line.right).toBeLessThanOrEqual(result.left + 3);
  }
});

test("a font used only by generated text participates in readiness and measurement", async ({ page }) => {
  const result = await page.evaluate(async (prose) => {
    const face = new FontFace("GeneratedEdge", 'url("/demo/fonts/Junicode-Roman.ttf")', { unicodeRange: "U+0057" });
    document.fonts.add(face);
    const p = document.createElement("p");
    p.id = "generated-font";
    p.style.cssText = "width:600px;margin:0;font:24px/38px Georgia,serif;text-align:justify";
    p.innerHTML = '<span style="float:left;width:70px;height:113.7px"></span><a>Among</a> ' + prose.repeat(4);
    const style = document.createElement("style");
    style.textContent = '#generated-font a::after { content:"WW"; font-family:GeneratedEdge,monospace }';
    document.head.append(style);
    document.getElementById("host")!.replaceChildren(p);
    let skip = "";
    const controller = window.__justif.justify([p], { onSkip: (_p: HTMLElement, reason: string) => { skip = reason; } });
    await controller.ready;
    const result = {
      skip, status: face.status, enhanced: p.hasAttribute("data-justif"),
      top: p.querySelector(".justif-seg")?.getBoundingClientRect().top,
      bottom: p.firstElementChild!.getBoundingClientRect().bottom,
    };
    controller.destroy();
    document.fonts.delete(face);
    return result;
  }, prose);
  expect(result.skip).toBe("");
  expect(result.status).toBe("loaded");
  expect(result.enhanced).toBe(true);
  expect(result.top).toBeLessThan(result.bottom);
});
