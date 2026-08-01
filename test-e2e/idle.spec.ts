import { expect, test } from "@playwright/test";

/**
 * Does the library stop working when there is nothing left to do?
 *
 * This is a class of defect the throughput budgets in perf.spec.ts cannot see: a
 * scheduler that re-arms itself costs nothing per iteration and produces no wrong
 * output, so every correctness test passes while the page never goes idle. One
 * shipped — a re-read whose own writes fired the watcher that triggered it, 240
 * passes over two idle seconds — and it was invisible until someone thought to
 * look for it.
 *
 * The instrument is `requestAnimationFrame`, wrapped once the scenario has
 * settled. Everything the library defers goes through it (patch slices, the
 * watcher's coalescing, correction flushes), so a callback scheduled during a
 * quiet window is work nobody asked for. DOM mutations are counted alongside it,
 * since a spin that mutates is worse than one that does not.
 */

/** Watch an idle window and report what the page did during it. */
const IDLE_MS = 1200;

async function idleWork(
  page: import("@playwright/test").Page,
): Promise<{ frames: number; mutations: number }> {
  return page.evaluate(
    (durationMs) =>
      new Promise<{ frames: number; mutations: number }>((resolve) => {
        let frames = 0;
        let mutations = 0;
        const realRaf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback: FrameRequestCallback) => {
          frames++;
          return realRaf(callback);
        };
        const observer = new MutationObserver((records) => {
          mutations += records.length;
        });
        for (const root of document.querySelectorAll("#host, .col, #enhanced")) {
          observer.observe(root, { childList: true, subtree: true, attributes: true });
        }
        setTimeout(() => {
          window.requestAnimationFrame = realRaf;
          observer.disconnect();
          resolve({ frames, mutations });
        }, durationMs);
      }),
    IDLE_MS,
  );
}

test("the drop-in goes idle: after boot, after a change, after a resize", async ({
  page,
}) => {
  test.slow();
  await page.goto("/test-e2e/fixture-auto-css.html");
  await page.waitForFunction(() => (window as Window & { justif?: unknown }).justif !== undefined);
  await page.evaluate(async () => {
    await (window as Window & { justif?: { booted: Promise<void> } }).justif!.booted;
  });
  await page.waitForTimeout(600);

  const afterBoot = await idleWork(page);
  expect(afterBoot, "after boot").toEqual({ frames: 0, mutations: 0 });

  // A configuration change through the CSS surface.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--justif-tracking", "none");
  });
  await page.waitForTimeout(900);
  const afterConfig = await idleWork(page);
  expect(afterConfig, "after a --justif-* change").toEqual({ frames: 0, mutations: 0 });

  // A change to ordinary author CSS, which is re-read — the path whose own
  // writes fire the watcher that triggers it.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".col p { hyphens: auto; letter-spacing: 0.2px }";
    document.head.append(style);
  });
  await page.waitForTimeout(900);
  const afterCss = await idleWork(page);
  expect(afterCss, "after an author CSS change").toEqual({ frames: 0, mutations: 0 });

  // And after a resize, whose re-layout is drained in slices.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(1200);
  const afterResize = await idleWork(page);
  expect(afterResize, "after a resize").toEqual({ frames: 0, mutations: 0 });
});

test("the API goes idle: after justify, after a rescan, after a font loads", async ({
  page,
}) => {
  test.slow();
  await page.goto("/test-e2e/fixture.html");
  await page.waitForFunction(() => window.__ready === true);

  await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.replaceChildren();
    const text =
      "The extraordinarily complicated development of unquestionably international " +
      "typographical conventions demonstrates considerable responsibility, naturally.";
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("p");
      p.setAttribute(
        "style",
        "width:280px;text-align:justify;font:17px Georgia, serif;hyphens:auto;margin:0 0 1em",
      );
      p.textContent = text;
      host.append(p);
    }
    const global = window as never as { __c: { ready: Promise<void> } };
    global.__c = window.__justif.justify([...host.children], {
      hyphenate: window.__justif.hyphenateEnUS,
    }) as never;
    await global.__c.ready;
  });
  await page.waitForTimeout(600);
  expect(await idleWork(page), "after justify()").toEqual({ frames: 0, mutations: 0 });

  // A re-read that changes something, and one that changes nothing.
  await page.evaluate(() => {
    const global = window as never as { __c: { rescan: () => readonly unknown[] } };
    const style = document.createElement("style");
    style.textContent = "#host p { letter-spacing: 0.15px }";
    document.head.append(style);
    global.__c.rescan();
    global.__c.rescan();
  });
  await page.waitForTimeout(600);
  expect(await idleWork(page), "after rescan()").toEqual({ frames: 0, mutations: 0 });

  // Font convergence: a face arriving after the layout committed.
  await page.evaluate(async () => {
    const face = new FontFace("IdleLateFace", 'url("/demo/fonts/Junicode-Roman.ttf")');
    document.fonts.add(await face.load());
    for (const p of document.querySelectorAll<HTMLElement>("#host p")) {
      p.style.fontFamily = '"IdleLateFace", Georgia, serif';
    }
    (window as never as { __c: { rescan: () => readonly unknown[] } }).__c.rescan();
  });
  await page.waitForTimeout(1200);
  expect(await idleWork(page), "after a late font load").toEqual({ frames: 0, mutations: 0 });
});
