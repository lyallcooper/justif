import { test } from "@playwright/test";

/** TEMPORARY: reports what the Arabic protrusion path actually sees. */
test("DIAG rtl protrusion inputs", async ({ page }) => {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);
  const out = await page.evaluate(async () => {
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
    const cs = getComputedStyle(p);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
    const measured = window.__justif.opticalProtrusion({ family: cs.fontFamily });
    const geometry = window.__justifLines(p);
    const out = {
      fontFamily: cs.fontFamily,
      canvasFont: ctx.font,
      advArabicQuestion: +ctx.measureText("؟").width.toFixed(3),
      advArabicComma: +ctx.measureText("،").width.toFixed(3),
      advLatinA: +ctx.measureText("a").width.toFixed(3),
      measuredEntries: measured === undefined ? null : Object.keys(measured).length,
      measuredPeriod: measured?.["."] ?? null,
      lineEnds: geometry.lines.map((l) => ({
        head: l.texts[0]?.slice(0, 6) ?? "",
        // RTL: lines end at the LEFT edge.
        overhang: +(geometry.contentRight - l.right).toFixed(2),
        left: +l.left.toFixed(2),
      })),
      margins: [...p.querySelectorAll<HTMLElement>(".justif-seg")]
        .map((s) => getComputedStyle(s).marginInlineEnd)
        .filter((m) => m !== "0px")
        .slice(0, 6),
    };
    controller.destroy();
    host.remove();
    return out;
  });
  console.log("DIAG " + JSON.stringify(out));
});
