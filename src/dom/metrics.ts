/**
 * Turning a paragraph's scan into the measured items a break runs on.
 *
 * The scan says what the text is and how it is styled; this is where that
 * becomes numbers — per-run glyph metrics, then the breaker's item stream,
 * split at every hard break because each `<br>`-delimited part is optimized
 * independently.
 *
 * Everything here is derived, and derived from the same four settings, so it
 * all goes stale together: a font arriving, an expansion or spacing change, a
 * different protrusion model. That is why the rebuild is one call rather than
 * a pair of assignments repeated at each site that needs it.
 *
 * Measurement targets whatever fonts are RENDERING at the moment it runs. A
 * face still loading is measured as its fallback — consistently, in canvas and
 * DOM alike — and the layout converges once it settles.
 */

import { buildItems } from "../core/items.js";
import { describeError } from "../core/errors.js";
import {
  type BuildOptions,
  type ExpansionOptions,
  ItemType,
  type RunMetrics,
} from "../core/types.js";
import { collectDomMeasurements, type FontSpec, requiresDomMeasurement } from "./measure.js";
import { type ParaPart, type ParaState, states } from "./paragraph-state.js";
import { type HardBreak, type ParagraphScan } from "./read.js";
import type { AdoptionRecord } from "./reread.js";
import {
  buildRunMetrics,
  measureFor,
  type ProtrusionSettings,
  runTexts,
} from "./segments.js";

/** The settings every derived number here depends on. Taken at use time: a
 * live controller can be reconfigured, and the next build must use the new
 * values. */
export interface MetricsOptions {
  buildOpts: BuildOptions;
  expansion: ExpansionOptions | false;
  spacing: { stretch: number; shrink: number; pull?: number };
  protrusionCtx: ProtrusionSettings;
}

/** What the metrics pass needs from the controller that owns the paragraphs. */
export interface MetricsHost {
  /** The controller's layout configuration as it stands right now. */
  layoutOptions(): MetricsOptions;
  /** Stamped into every state this pass creates, so a paragraph another
   * controller has taken over is recognizable as no longer ours. */
  readonly owner: symbol;
  /** Tell user code this paragraph was declined, and why. */
  emitSkip(p: HTMLElement, reason: string): void;
}

export function createMetricsPass(record: AdoptionRecord, host: MetricsHost) {
  const buildParts = (
    scan: ParagraphScan,
    runsMetrics: RunMetrics[],
    specByKey: Map<string, FontSpec>,
  ): ParaPart[] => {
    const { buildOpts } = host.layoutOptions();
    // RTL paragraphs never letterspace: tracking inside Arabic cursive
    // joining is typographically wrong, and engines disagree on whether
    // joined pairs receive letter-spacing at all — the width model would
    // drift by pixels per word. (Hyphenation is likewise suppressed, via
    // noHyphens in buildRunMetrics.)
    const opts = scan.direction === "rtl" ? { ...buildOpts, tracking: false as const } : buildOpts;
    const texts = runTexts(scan);
    const measure = measureFor(specByKey);
    const parts: ParaPart[] = [];
    let startRun = 0;
    const append = (endRun: number, breakAfter: HardBreak | null): void => {
      const para = buildItems(texts.slice(startRun, endRun), runsMetrics, opts, measure);
      // First-line protrusion is a property of the CSS paragraph, not of
      // each independently optimized hard-break segment. A leading <br>
      // consumes that first formatted line too, so every later segment
      // uses ordinary line-start protrusion from its first box onward.
      if (parts.length > 0) {
        for (const item of para.items) {
          if (item.type === ItemType.Box) item.lpFirst = item.lp;
        }
      }
      parts.push({ para, breakAfter });
      startRun = endRun;
    };
    for (const hardBreak of scan.hardBreaks) {
      append(hardBreak.afterRun, hardBreak);
    }
    append(texts.length, null);
    return parts;
  };

  /** Re-derive a live paragraph's metrics and items in place, against the
   * settings and font metrics as they stand now. */
  const rebuildMetrics = (state: ParaState): void => {
    const { expansion, spacing, protrusionCtx } = host.layoutOptions();
    state.runsMetrics = buildRunMetrics(state.scan, expansion, spacing, protrusionCtx);
    state.parts = buildParts(state.scan, state.runsMetrics, state.specByKey);
  };

  /**
   * Pre-shape every string that needs real DOM measurement, in ONE hidden
   * batch: variant-bearing runs (small-caps and friends) can't be measured on
   * canvas, and discovering them one paragraph at a time would pay a hidden
   * layout each. The build results are thrown away — the pass that follows
   * reads the exact cached widths. Throws are swallowed: the real pass owns
   * the per-paragraph fail-safe and will bail that paragraph alone.
   */
  const warmDomWidths = (
    entries: readonly { scan: ParagraphScan; specByKey: Map<string, FontSpec> }[],
  ): void => {
    const { expansion, spacing, protrusionCtx } = host.layoutOptions();
    collectDomMeasurements(() => {
      for (const { scan, specByKey } of entries) {
        if (!scan.specs.some(requiresDomMeasurement)) continue;
        try {
          buildParts(scan, buildRunMetrics(scan, expansion, spacing, protrusionCtx), specByKey);
        } catch {
          /* deliberately ignored; see above */
        }
      }
    });
  };

  /** The entries `warmDomWidths` needs for a batch of freshly scanned
   * paragraphs — only those whose runs actually require DOM measurement. */
  const domWidthEntriesFor = (
    scannable: readonly HTMLElement[],
  ): { scan: ParagraphScan; specByKey: Map<string, FontSpec> }[] =>
    scannable.flatMap((p) => {
      const scan = record.scanned.get(p);
      return scan === undefined || !scan.specs.some(requiresDomMeasurement)
        ? []
        : [{ scan, specByKey: new Map(scan.specs.map((spec) => [spec.key, spec])) }];
    });

  /** Phase 2: measurement + item building, against the fonts currently
   * rendering (still-loading faces measure as their fallbacks and
   * converge later). */
  const prepare = (p: HTMLElement): boolean => {
    if (states.get(p)?.enhanced) {
      record.scanned.delete(p); // another controller won the race; drop our scan
      return true;
    }
    const scan = record.scanned.get(p);
    if (scan === undefined) return false;
    record.scanned.delete(p);

    try {
      // Keyed on the MEASUREMENT key, so specs that differ only in a
      // key-excluded field (`hyphens`) collapse to one entry — deliberately:
      // they measure identically. See FontSpec.key.
      const specByKey = new Map<string, FontSpec>();
      for (const spec of scan.specs) specByKey.set(spec.key, spec);
      const state: ParaState = {
        owner: host.owner,
        original: document.createDocumentFragment(),
        originalStyleAttr: record.carriedStyleAttr.has(p)
          ? (record.carriedStyleAttr.get(p) ?? null)
          : p.getAttribute("style"),
        scan,
        runsMetrics: [],
        specByKey,
        parts: [],
        width: scan.contentWidth,
        lastPatch: "",
        enhanced: false,
        renderedFloat: null,
        nativeIndent: null,
        masked: [],
      };
      rebuildMetrics(state);
      states.set(p, state);
    } catch (error) {
      // Same fail-safe as the scan: this paragraph stays native.
      record.bailed.add(p);
      host.emitSkip(p, `threw while measuring: ${describeError(error)}`);
      return false;
    }
    return true;
  };

  return { domWidthEntriesFor, prepare, rebuildMetrics, warmDomWidths };
}
