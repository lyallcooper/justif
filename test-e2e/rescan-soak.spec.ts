import { expect, test } from "@playwright/test";

/**
 * Randomised churn against the re-read path.
 *
 * Every other test here targets a defect that was already known. This one exists
 * for the states nobody enumerated: it drives hundreds of author CSS changes —
 * inline and through stylesheets, some of which make a paragraph ineligible and
 * some of which make it eligible again — across paragraphs of deliberately
 * different shapes, and checks the invariants that must hold whatever sequence
 * comes up.
 *
 * Deterministic: the generator is seeded, so a failure names the exact sequence
 * that produced it and can be replayed by running the same seed.
 */

/** Content shapes with materially different enhancement paths. */
const PARAGRAPHS = [
  { id: "soak-plain", html: "The extraordinarily complicated development of unquestionably international typographical conventions demonstrates considerable responsibility, naturally, whenever compositors compare alternatives with one another." },
  { id: "soak-inline", html: "A paragraph with <em>emphasis</em>, a <a href='#x'>link</a>, and <code>inline_code()</code> that must survive being taken apart and put back together again by every single re-read." },
  { id: "soak-quotes", html: "“Alpha beta gamma delta epsilon zeta,” she said, and the sentence continues past the margin with commas, full stops. And more besides." },
  { id: "soak-break", html: "A line that ends deliberately<br>and continues underneath it, which is the hard-break path through the breaker and the writer both." },
  { id: "soak-short", html: "“Short enough for one line.”" },
  { id: "soak-cjk", html: "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。", lang: "ja" },
  { id: "soak-rtl", html: "ויאמר אלהים יהי רקיע בתוך המים ויהי מבדיל בין מים למים. ויעש אלהים את הרקיע ויבדל בין המים אשר מתחת לרקיע.", dir: "rtl" },
];

/** One author change each round. Some of these make a paragraph ineligible — the
 * decline path is as much a part of re-reading as the enhancement one. */
const CHANGES = [
  ["font-size", ["17px", "15px", "19px"]],
  ["letter-spacing", ["normal", "0.2px"]],
  ["hyphens", ["auto", "manual", "none"]],
  ["line-height", ["1.45", "1.7"]],
  ["text-indent", ["0px", "24px", "-18px"]],
  ["font-style", ["normal", "italic"]],
  ["font-weight", ["400", "700"]],
  ["word-spacing", ["normal", "1px"]],
  // Ineligible while set: the paragraph must go back to native rendering and
  // come back when it is lifted.
  ["text-transform", ["none", "none", "capitalize"]],
  ["white-space", ["normal", "normal", "pre-line"]],
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);
});

test("rescan() survives randomised author CSS churn", async ({ page }) => {
  test.slow();
  const result = await page.evaluate(
    async ([shapes, changes]) => {
      const host = document.getElementById("host")!;
      host.replaceChildren();
      const sheet = document.createElement("style");
      sheet.id = "soak-sheet";
      document.head.append(sheet);

      const elements: HTMLElement[] = [];
      for (const shape of shapes) {
        const p = document.createElement("p");
        p.id = shape.id;
        if (shape.lang !== undefined) p.lang = shape.lang;
        if (shape.dir !== undefined) p.dir = shape.dir;
        p.setAttribute(
          "style",
          "width: 280px; text-align: justify; font: 17px Georgia, serif; margin: 0 0 1em",
        );
        p.innerHTML = shape.html;
        host.append(p);
        elements.push(p);
      }
      /** Pristine markup, for the restoration check at the end. */
      const pristine = elements.map((p) => p.outerHTML);
      const text = elements.map((p) => p.textContent!.replace(/\s+/g, " ").trim());

      const controller = window.__justif.justify(elements, {
        hyphenate: window.__justif.hyphenateEnUS,
      });
      await controller.ready;

      // Seeded, so a failure is reproducible: mulberry32.
      let seed = 0x9e3779b9;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

      const failures: string[] = [];
      const inlineState = new Map<string, Map<string, string>>();
      for (let round = 0; round < 150; round++) {
        const [property, values] = pick(changes);
        const value = pick(values);
        const target = pick(elements);
        // One paragraph is never written to inline, so that the byte-for-byte
        // check at the end always has a subject: an author's own inline write is
        // theirs to keep, and rightly displaces the saved copy.
        if (random() < 0.5 && target.id !== "soak-plain") {
          // Inline, which is also what an inspector edit looks like.
          target.style.setProperty(property, value);
          const own = inlineState.get(target.id) ?? new Map<string, string>();
          own.set(property, value);
          inlineState.set(target.id, own);
        } else {
          // Through a stylesheet, which is what a class or theme looks like.
          sheet.textContent = `#${target.id} { ${property}: ${value} }`;
        }
        controller.rescan();

        for (const [index, p] of elements.entries()) {
          const enhanced = p.hasAttribute("data-justif");
          // Content is never lost, reordered, or duplicated — whatever the
          // paragraph has been through.
          const now = p.textContent!.replace(/\s+/g, " ").trim();
          if (now !== text[index]) {
            failures.push(`round ${round} ${p.id}: text changed to "${now.slice(0, 60)}"`);
          }
          if (!enhanced) continue;
          if (p.querySelectorAll(".justif-seg").length === 0) {
            failures.push(`round ${round} ${p.id}: enhanced but has no segments`);
          }
          // Nothing runs away past the measure. The allowance is generous — a
          // Japanese stop hangs a whole em under burasage — because a broken
          // layout is not subtle: it misses by tens of pixels, not by one.
          const style = getComputedStyle(p);
          const right =
            p.getBoundingClientRect().right -
            parseFloat(style.paddingRight) -
            parseFloat(style.borderRightWidth);
          const allowance = parseFloat(style.fontSize) * 1.3;
          for (const seg of p.querySelectorAll<HTMLElement>(".justif-seg")) {
            const overshoot = seg.getBoundingClientRect().right - right;
            if (overshoot > allowance) {
              failures.push(
                `round ${round} ${p.id}: segment overshoots the measure by ${overshoot.toFixed(1)}px`,
              );
            }
          }
        }
        if (failures.length > 8) break;
      }

      const controllersBefore = controller.managed.length;
      // Author styling back to exactly what it was, so teardown must reproduce
      // the original markup character for character.
      sheet.remove();
      for (const [id, own] of inlineState) {
        const p = document.getElementById(id)!;
        for (const property of own.keys()) p.style.removeProperty(property);
      }
      controller.rescan();
      controller.destroy();

      /** Markup without the style attribute, and that attribute's declarations as
       * an order-independent set — the two halves of "unchanged", separated
       * because a paragraph the author wrote to inline keeps THEIR attribute,
       * which the CSSOM has reserialized (`0 0 1em` reads back as `0px 0px 1em`).
       * Only paragraphs justif alone touched are held to the byte. */
      const parse = (html: string) => {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const el = holder.firstElementChild as HTMLElement;
        const style = el.getAttribute("style") ?? "";
        el.removeAttribute("style");
        const probe = document.createElement("span");
        probe.setAttribute("style", style);
        const declarations: string[] = [];
        for (let i = 0; i < probe.style.length; i++) {
          const property = probe.style.item(i);
          declarations.push(`${property}:${probe.style.getPropertyValue(property)}`);
        }
        return { markup: el.outerHTML, style, declarations: declarations.sort().join(";") };
      };

      /** Declarations, attributes and elements that are justif's alone: none of
       * them may outlive the teardown, whatever the author did in between. */
      const RESIDUE = [
        "text-size-adjust",
        "-webkit-text-size-adjust",
        "transition-property",
        "hanging-punctuation",
        "overflow-wrap",
        "word-break",
        "line-break",
        "contain-intrinsic-block-size",
      ];
      const changedMarkup: string[] = [];
      const notByteExact: string[] = [];
      const residue: string[] = [];
      for (const [index, p] of elements.entries()) {
        const before = parse(pristine[index]!);
        const after = parse(p.outerHTML);
        if (before.markup !== after.markup) {
          const at = [...before.markup].findIndex((c, i) => c !== after.markup[i]);
          changedMarkup.push(
            `${p.id}@${at}: "${before.markup.slice(Math.max(0, at - 30), at + 40)}" vs "${after.markup.slice(Math.max(0, at - 30), at + 40)}"`,
          );
        }
        // Untouched by the test's own inline writes: nothing but justif has been
        // near this attribute, so it has to come back character for character.
        // (Where the test DID write, the author's attribute is theirs to keep —
        // and its own cleanup is lossy, since removing a longhand the `font`
        // shorthand supplied does not put the shorthand's value back.)
        if (!inlineState.has(p.id) && before.style !== after.style) notByteExact.push(p.id);
        for (const property of RESIDUE) {
          if (p.style.getPropertyValue(property) !== "") {
            residue.push(`${p.id}: ${property}: ${p.style.getPropertyValue(property)}`);
          }
        }
        if (p.className.includes("justif")) residue.push(`${p.id}: class ${p.className}`);
        for (const attribute of p.getAttributeNames()) {
          if (attribute.startsWith("data-justif")) residue.push(`${p.id}: [${attribute}]`);
        }
        if (p.querySelector(".justif-seg, .justif-hyphen, .justif-break") !== null) {
          residue.push(`${p.id}: segments left behind`);
        }
      }
      host.replaceChildren();
      return {
        failures,
        changedMarkup,
        notByteExact,
        residue,
        inlineEdited: [...inlineState.keys()],
        managed: controllersBefore,
      };
    },
    [PARAGRAPHS, CHANGES] as const,
  );

  expect(result.failures).toEqual([]);
  // Some paragraphs are ineligible at the end of a given sequence; the run is only
  // meaningful if the controller was still managing most of them.
  expect(result.managed).toBeGreaterThan(2);
  // Teardown leaves the author's own markup, and nothing of justif's, after all
  // of that.
  expect(result.changedMarkup).toEqual([]);
  expect(result.residue).toEqual([]);
  // And for the paragraphs only justif ever wrote to, character for character.
  expect(result.notByteExact).toEqual([]);
  // The run must actually have exercised both routes.
  expect(result.inlineEdited.length).toBeGreaterThan(0);
  expect(result.inlineEdited).not.toContain("soak-plain");
});

/**
 * The same churn, through the drop-in — where the machinery is different: the
 * watcher decides WHEN to re-read, the reconciler regroups paragraphs by
 * configuration, and both react to the enhancement's own writes. Every change
 * here goes through a stylesheet, since that is what a theme, a class or an
 * inspector edit actually does, and nothing calls the library at all.
 */
test("the drop-in survives randomised author CSS churn", async ({ page }) => {
  test.slow();
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });

  const RULES = [
    ".col p { font-size: 15px }",
    ".col p { font-size: 19px }",
    ".col p { hyphens: auto }",
    ".col p { hyphens: none }",
    ".col p { letter-spacing: 0.3px }",
    ".col p { line-height: 1.8 }",
    ".col p { text-indent: 22px }",
    ".col p { word-spacing: 1px }",
    "#plain { text-transform: capitalize }",
    "#plain { white-space: pre-line }",
    ".col { width: 240px }",
    "",
  ];

  const state = await page.evaluate(async (rules) => {
    const sheet = document.createElement("style");
    document.head.append(sheet);
    const paragraphs = [...document.querySelectorAll<HTMLElement>(".col p")];
    const text = new Map(
      paragraphs.map((p) => [p.id, p.textContent!.replace(/\s+/g, " ").trim()]),
    );
    const global = window as Window & { justif?: { controllers: unknown[] } };

    let seed = 0x1f2e3d4c;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const settle = () =>
      new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(null)), 90));

    const failures: string[] = [];
    let peakControllers = 0;
    for (let round = 0; round < 24; round++) {
      sheet.textContent = rules[Math.floor(random() * rules.length)]!;
      await settle();
      peakControllers = Math.max(peakControllers, global.justif!.controllers.length);
      for (const p of paragraphs) {
        const now = p.textContent!.replace(/\s+/g, " ").trim();
        if (now !== text.get(p.id)) failures.push(`round ${round} ${p.id}: text changed`);
        if (!p.hasAttribute("data-justif")) continue;
        const style = getComputedStyle(p);
        const right =
          p.getBoundingClientRect().right -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderRightWidth);
        const allowance = parseFloat(style.fontSize) * 1.3;
        for (const seg of p.querySelectorAll<HTMLElement>(".justif-seg")) {
          const overshoot = seg.getBoundingClientRect().right - right;
          if (overshoot > allowance) {
            failures.push(`round ${round} ${p.id}: overshoots by ${overshoot.toFixed(1)}px`);
          }
        }
      }
      if (failures.length > 6) break;
    }

    // Back to no rules at all, then let it settle and prove it STAYS settled: a
    // re-read that schedules the next one leaves the page working forever.
    sheet.textContent = "";
    await settle();
    await settle();
    let passes = 0;
    for (const controller of global.justif!.controllers as Array<{
      rescan: (t?: unknown) => readonly unknown[];
    }>) {
      const original = controller.rescan.bind(controller);
      controller.rescan = (t?: unknown) => {
        passes++;
        return original(t as never);
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    sheet.remove();
    return {
      failures,
      idlePasses: passes,
      peakControllers,
      controllers: global.justif!.controllers.length,
      enhanced: paragraphs.filter((p) => p.hasAttribute("data-justif")).length,
    };
  }, RULES);

  expect(state.failures).toEqual([]);
  // The page is quiet once it has caught up.
  expect(state.idlePasses).toBe(0);
  // Controllers are regrouped, never accumulated.
  expect(state.peakControllers).toBeLessThan(12);
  expect(state.controllers).toBeLessThan(12);
  // And the paragraphs are still enhanced at the end of it.
  expect(state.enhanced).toBeGreaterThan(3);
});
