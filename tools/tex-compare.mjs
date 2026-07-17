/**
 * Compare justif's justified layout against a true TeX-grade reference:
 * LuaLaTeX + microtype (protrusion + expansion) + Junicode, compiled via the
 * texlive.net latexcgi service (no local TeX installation), at exactly the
 * demo's geometry: 16px type (12bp) on a 26em measure (312bp).
 *
 * The same gap analysis runs on all three renderers — browser justify,
 * justif, and LuaTeX — via word-box extraction (Range API in the browser,
 * pdf.js for the PDF), so the comparison is metric-identical.
 *
 * Usage:  node tools/tex-compare.mjs
 * Needs:  the demo server running on :5199 (python3 -m http.server 5199)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PX_TO_BP = 0.75; // 1 CSS px = 1/96 in = 0.75 bp
const FONT_PX = 16;
const FONT_BP = FONT_PX * PX_TO_BP; // 12

const TALE =
  "In olden times when wishing still helped one, there lived a king " +
  "whose daughters were all beautiful; and the youngest was so beautiful " +
  "that the sun itself, which has seen so much, was astonished whenever it " +
  "shone in her face. Close by the king’s castle lay a great dark forest, " +
  "and under an old lime-tree in the forest was a well, and when the day " +
  "was very warm, the king’s child went out into the forest and sat down " +
  "by the side of the cool fountain; and when she was bored she took a " +
  "golden ball, and threw it up on high and caught it; and this ball was " +
  "her favorite plaything.";

// Mirrors the demo's tech sample paragraph 1 (inline code in a second
// font). MUST track demo/index.html's SAMPLES.tech verbatim — a drifted
// copy compares two different texts and reports 0/n agreement with
// nonsense spacing stats.
const TECH_TEX =
  "A browser normally breaks justified text one line at a time. It " +
  "fills the available measure, commits to a break, and stretches the " +
  "spaces that remain. This is fast and predictable, but a stubborn token " +
  "such as \\texttt{getBoundingClientRect()} can be sent intact to the " +
  "next line, leaving the preceding gaps to absorb the difference. In a " +
  "narrow column, those gaps become the first thing the eye sees.";

const SCENARIOS = [
  {
    name: "tale @ 26em (book measure)",
    sample: "tale",
    measureEm: 26,
    texBody: TALE,
    mono: false,
  },
  {
    name: "tale @ 17em (narrow — hyphenation)",
    sample: "tale",
    measureEm: 17,
    texBody: TALE,
    mono: false,
  },
  {
    name: "tech @ 22em (mixed serif + mono code, pull 0 = TeX space semantics)",
    sample: "tech",
    measureEm: 22,
    texBody: TECH_TEX,
    mono: true,
    pull: 0,
  },
];

function texDocument(scenario) {
  const measureBp = scenario.measureEm * FONT_PX * PX_TO_BP;
  const mono = scenario.mono
    ? "\\setmonofont{IBM Plex Mono Light}[Scale=0.95]\n"
    : "";
  return `\\documentclass{article}
\\usepackage[paperwidth=${measureBp}bp,paperheight=800bp,margin=0bp]{geometry}
\\usepackage{fontspec}
\\setmainfont{Junicode}
${mono}\\usepackage[stretch=20,shrink=20,step=5]{microtype}
\\pagestyle{empty}
\\parindent=0pt
\\emergencystretch=3em % match justif's default emergencyStretch:"auto"; TeX's 0 yields overfull boxes instead
\\begin{document}
\\fontsize{${FONT_BP}bp}{${(FONT_BP * 1.45).toFixed(4)}bp}\\selectfont
\\noindent ${scenario.texBody}
\\end{document}
`;
}

// ── 1. Compile via texlive.net ─────────────────────────────────────
async function compileTex(texSource) {
  const form = new FormData();
  form.append("filecontents[]", texSource);
  form.append("filename[]", "document.tex");
  form.append("engine", "lualatex");
  form.append("return", "pdf");
  const res = await fetch("https://texlive.net/cgi-bin/latexcgi", {
    method: "POST",
    body: form,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== "%PDF") {
    const log = buf.toString("utf8");
    mkdirSync("build", { recursive: true });
    writeFileSync("build/tex-compare.log", log);
    const bang = log.split("\n").filter((l) => l.startsWith("!"));
    throw new Error(
      `texlive.net did not return a PDF (full log: build/tex-compare.log).\n` +
      (bang.slice(0, 6).join("\n") || log.slice(-1200)),
    );
  }
  mkdirSync("build", { recursive: true });
  writeFileSync("build/tex-compare.pdf", buf);
  return buf;
}

// ── 2. Extract word boxes from the PDF (pdf.js operator list) ──────
// TeX writes interword glue as TJ kern adjustments, so getTextContent
// merges whole lines into single items. A minimal text-state machine over
// the operator list recovers true per-word x-positions and gap widths.
async function extractPdfLines(pdfBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;

  const boxes = [];
  let x = 0;
  let y = 0;
  let fs = 1;
  let scaleX = 1; // text-matrix x-scale = microtype expansion
  let word = null;
  const flush = () => {
    if (word !== null && word.text.length > 0) boxes.push({ ...word, right: x, top: -y });
    word = null;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.setFont) {
      fs = args[1];
    } else if (fn === OPS.setTextMatrix) {
      flush();
      const m = args[0];
      scaleX = m[0];
      x = m[4];
      y = m[5];
    } else if (fn === OPS.moveText) {
      flush();
      x += args[0];
      y += args[1];
    } else if (fn === OPS.showText) {
      for (const g of args[0]) {
        if (typeof g === "number") {
          // TJ adjustment: positive moves left (kerns), large negative
          // values are TeX's interword glue.
          const dx = ((-g / 1000) * fs) * scaleX;
          if (g < -100) flush(); // interword gap
          x += dx;
        } else {
          const w = (((g.width ?? 0) / 1000) * fs) * scaleX;
          if (word === null) word = { left: x, text: "" };
          word.text += g.unicode ?? "";
          x += w;
        }
      }
    }
  }
  flush();

  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const b of boxes) {
    const line = lines[lines.length - 1];
    if (line !== undefined && Math.abs(b.top - line.refTop) < FONT_BP * 0.7) line.boxes.push(b);
    else lines.push({ refTop: b.top, boxes: [b] });
  }
  for (const line of lines) line.boxes.sort((a, b) => a.left - b.left);
  return lines.map((line) => {
    const gaps = [];
    for (let i = 1; i < line.boxes.length; i++) {
      const w = line.boxes[i].left - line.boxes[i - 1].right;
      if (w > 0.3) gaps.push(w);
    }
    return {
      text: line.boxes.map((b) => b.text).join(" ").replace(/\s+/g, " ").trim(),
      right: Math.max(...line.boxes.map((b) => b.right)),
      gaps,
    };
  });
}

// ── 3. Extract the same data from the demo (browser + justif) ──────
async function extractBrowserLines(scenario) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  // ?pull= is the demo's headless hook (the UI slider was removed): pin
  // mixed-font space semantics for the TeX comparison.
  const query = scenario.pull !== undefined ? `?pull=${scenario.pull}` : "";
  await page.goto(`http://localhost:5199/demo/index.html${query}`);
  if (scenario.mono) {
    // Mirror the TeX document: IBM Plex Mono Light for code (TeX Live has
    // no Courier Prime). The demo only loads weight 400, so pull in 300.
    // Pin family, size, and weight so both sides render identical code
    // spans: 0.95em of 16px = 15.2px, matching the TeX Scale=0.95.
    await page.addStyleTag({
      url: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300&display=swap",
    });
    await page.addStyleTag({
      content:
        '.article code { font-family: "IBM Plex Mono", monospace !important; font-size: 0.95em !important; font-weight: 300 !important; }',
    });
  }
  await page.waitForTimeout(5000);
  const out = await page.evaluate(async (sc) => {
    // Pin every control that diverges from microtype semantics: the demo
    // defaults full hanging punctuation ON, but TeX runs microtype's
    // partial protrusion — comparing anything else is apples to oranges.
    {
      const hang = document.getElementById("hangpunct");
      if (hang && hang.value !== "off") {
        hang.value = "off";
        hang.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const tracking = document.getElementById("tracking");
      if (tracking && tracking.checked) {
        tracking.checked = false;
        tracking.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // TeX runs have no short-last-line pressure; the demo defaults the
      // slider to 0.33.
      const lastline = document.getElementById("lastline");
      if (lastline && Number(lastline.value) > 0) {
        lastline.value = "0";
        lastline.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById("sample").value = sc.sample;
    document.getElementById("sample").dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2000));
    document.getElementById("measure").value = String(sc.measureEm);
    document.getElementById("measure").dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));

    const range = document.createRange();
    const linesOf = (host) => {
      const p = document.querySelectorAll(`#${host} p`)[0]; // paragraph 1
      const boxes = [];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const re = /\S+/g;
        let m;
        while ((m = re.exec(n.nodeValue))) {
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          for (const r of range.getClientRects()) {
            if (r.width > 0)
              boxes.push({ text: m[0], left: r.left, right: r.right, top: r.top });
          }
        }
      }
      for (const h of p.querySelectorAll(".justif-hyphen")) {
        const r = h.getBoundingClientRect();
        if (r.width > 0) boxes.push({ text: "-", left: r.left, right: r.right, top: r.top });
      }
      boxes.sort((a, b) => a.top - b.top || a.left - b.left);
      const lines = [];
      for (const b of boxes) {
        const line = lines[lines.length - 1];
        if (line && b.top - line.refTop < 10) line.boxes.push(b);
        else lines.push({ refTop: b.top, boxes: [b] });
      }
      for (const line of lines) line.boxes.sort((a, b) => a.left - b.left);
      return lines.map((line) => {
        const gaps = [];
        for (let i = 1; i < line.boxes.length; i++) {
          const w = line.boxes[i].left - line.boxes[i - 1].right;
          if (w > 1) gaps.push(w);
        }
        return {
          text: line.boxes.map((b) => b.text).join(" "),
          right: Math.max(...line.boxes.map((b) => b.right)),
          gaps,
        };
      });
    };
    return { browser: linesOf("native"), justif: linesOf("enhanced") };
  }, { sample: scenario.sample, measureEm: scenario.measureEm, pull: scenario.pull });
  await browser.close();
  return out;
}

// ── 4. Shared statistics ────────────────────────────────────────────
function stats(lines, naturalSpace) {
  const justified = lines.slice(0, -1).flatMap((l) => l.gaps);
  const ratios = justified.map((g) => g / naturalSpace);
  const mean = ratios.reduce((a, b) => a + b, 0) / (ratios.length || 1);
  const dev = ratios.reduce((a, b) => a + Math.abs(b - 1), 0) / (ratios.length || 1);
  const sd = Math.sqrt(
    ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / (ratios.length || 1),
  );
  return {
    lines: lines.length,
    hyphens: lines.filter((l) => /(-|‐)$/.test(l.text.trim())).length,
    mean: (mean * 100).toFixed(0) + "%",
    dev: (dev * 100).toFixed(0) + "%",
    sd: (sd * 100).toFixed(0) + "%",
    loosest: (Math.max(...ratios) * 100).toFixed(0) + "%",
  };
}

const lastWord = (l) => {
  const t = l.text.trim();
  if (/[-‐]$/.test(t)) {
    const stripped = t.replace(/\s*[-‐]+$/, "");
    return stripped.split(" ").at(-1) + "‐";
  }
  return t.split(" ").at(-1);
};

// ── Run ─────────────────────────────────────────────────────────────
const NATURAL_PX = 3.887; // Junicode space at 16px (4.13 measured at 17px × 16/17)
const NATURAL_BP = NATURAL_PX * PX_TO_BP;

for (const scenario of SCENARIOS) {
  console.log(`\n════ ${scenario.name} ════`);
  console.log("compiling via texlive.net…");
  const pdf = await compileTex(texDocument(scenario));
  writeFileSync(`build/tex-compare-${scenario.sample}-${scenario.measureEm}.pdf`, pdf);
  const tex = await extractPdfLines(pdf);
  const { browser: nat, justif: jus } = await extractBrowserLines(scenario);

  const rows = Math.max(tex.length, jus.length, nat.length);
  console.log("line  browser              justif               LuaTeX+microtype");
  let agree = 0;
  for (let i = 0; i < rows; i++) {
    const b = nat[i] ? lastWord(nat[i]) : "—";
    const j = jus[i] ? lastWord(jus[i]) : "—";
    const t = tex[i] ? lastWord(tex[i]) : "—";
    const match = j === t;
    if (match && jus[i] && tex[i]) agree++;
    console.log(
      `${String(i + 1).padStart(3)}   ${b.padEnd(20)} ${j.padEnd(20)} ${t.padEnd(18)}${match ? " ✓" : " ✗"}`,
    );
  }
  console.log(`justif ↔ TeX break agreement: ${agree}/${rows}`);

  console.log("           lines hyph  mean  dev   σ    loosest");
  const show = (name, s) =>
    console.log(
      `${name.padEnd(10)} ${String(s.lines).padStart(4)} ${String(s.hyphens).padStart(4)}  ${s.mean.padStart(4)}  ${s.dev.padStart(4)} ${s.sd.padStart(4)}  ${s.loosest.padStart(6)}`,
    );
  show("browser", stats(nat, NATURAL_PX));
  show("justif", stats(jus, NATURAL_PX));
  show("LuaTeX", stats(tex, NATURAL_BP));
  const measureBp = scenario.measureEm * FONT_PX * PX_TO_BP;
  const overfull = tex.filter((l) => l.right > measureBp + 4).length;
  if (overfull > 0) console.log(`⚠ LuaTeX overfull lines (> 4bp past measure): ${overfull}`);
}
