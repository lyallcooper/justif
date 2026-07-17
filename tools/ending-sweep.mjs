/**
 * Paragraph-ending sweep: how wide do endings render across a real corpus
 * at several lastLineMinWidth settings? Reports the rectangle rate
 * (ending flush within 1.5px), the ending-width distribution, and hyphen
 * cost. Corpus: the Alice sample scraped from the demo's native column.
 *
 *   python3 -m http.server 5199   (repo root)
 *   node tools/ending-sweep.mjs
 */
import { chromium } from "playwright-core";

const BASE = "http://localhost:5199";
const MEASURES = [320, 450];
const SETTINGS = [0, 0.33, 0.75, 1];

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

// 1 · Corpus: Alice paragraph texts from the demo's NATIVE column (the
// enhanced column's textContent carries NBSP wrap-determinism artifacts).
await page.goto(BASE + "/demo/", { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("[data-justif]") !== null, null, {
  timeout: 20000,
});
// Switch to the full Alice sample (the default is a 3-paragraph excerpt).
// The select sits in the collapsed dock, so set it programmatically.
await page.evaluate(() => {
  const sel = document.getElementById("sample");
  sel.value = "alice";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForFunction(
  () => document.querySelectorAll(".article p").length > 400,
  null,
  { timeout: 30000 },
);
const texts = await page.evaluate(() =>
  [...document.querySelectorAll(".article p")]
    .filter((p) => !p.hasAttribute("data-justif") && p.closest("[data-justif]") === null)
    .filter((p) => p.querySelector("br") === null && p.textContent.trim().length > 120)
    .map((p) => p.textContent.trim()),
);
console.log(`corpus: ${texts.length} paragraphs (Alice, ≥120 chars, no verse)`);

// 2 · Measurement page: fixture harness + Junicode with a declared
// font-stretch range (without it the wdth axis pins and expansion is off).
await page.goto(BASE + "/test-e2e/fixture.html", { waitUntil: "load" });
await page.evaluate(async () => {
  const style = document.createElement("style");
  style.textContent = `@font-face {
    font-family: "Junicode";
    src: url("/demo/fonts/Junicode-Roman.woff2") format("woff2");
    font-weight: 300 700;
    font-stretch: 75% 125%;
    font-display: block;
  }`;
  document.head.append(style);
  await document.fonts.load('18px "Junicode"', "Alice x");
});

if (process.env.SPACING_STRETCH) {
  await page.evaluate((s) => {
    window.__sweepSpacing = { stretch: s, shrink: 1 / 3, pull: 0.7 };
  }, Number(process.env.SPACING_STRETCH));
}
for (const W of MEASURES) {
  for (const v of SETTINGS) {
    const r = await page.evaluate(
      async ({ texts, W, v }) => {
        const host = document.getElementById("host");
        host.innerHTML = "";
        const ps = texts.map((t) => {
          const p = document.createElement("p");
          p.style.cssText = `width:${W}px; font:18px/1.5 Junicode, serif; text-align:justify;`;
          p.textContent = t;
          host.append(p);
          return p;
        });
        const ctl = window.__justif.justify(ps, {
          hyphenate: window.__justif.hyphenateEnUS,
          protrusion: false,
          lastLineMinWidth: v,
          ...(window.__sweepSpacing ? { spacing: window.__sweepSpacing } : {}),
        });
        await ctl.ready;
        const endings = [];
        let hyphens = 0;
        for (const p of ps) {
          if (!p.hasAttribute("data-justif")) continue;
          const g = window.__justifLines(p);
          if (g.lines.length < 2) continue;
          const last = g.lines[g.lines.length - 1];
          endings.push(1 - (g.contentRight - last.right) / W);
          hyphens += p.querySelectorAll(".justif-hyphen").length;
        }
        ctl.destroy();
        return { endings, hyphens };
      },
      { texts, W, v },
    );
    const e = r.endings.slice().sort((a, b) => a - b);
    const rect = e.filter((x) => x >= 1 - 1.5 / W).length;
    const short = e.filter((x) => x < 1 / 3).length;
    const mean = e.reduce((s, x) => s + x, 0) / e.length;
    const q = (p) => e[Math.min(e.length - 1, Math.floor(p * e.length))];
    console.log(
      `W=${W}px v=${String(v).padEnd(4)} n=${e.length}  rect=${((100 * rect) / e.length).toFixed(1).padStart(5)}%  short<⅓=${String(short).padStart(3)}  ` +
        `mean=${(100 * mean).toFixed(1)}%  p25=${(100 * q(0.25)).toFixed(1)}%  median=${(100 * q(0.5)).toFixed(1)}%  p75=${(100 * q(0.75)).toFixed(1)}%  hyphens=${r.hyphens}`,
    );
  }
}
await browser.close();
