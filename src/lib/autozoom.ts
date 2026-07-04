// autozoom.ts
// Cursor clicks -> auto-zoom regions.
//
// Every mouse-down opens a zoom region [click - ZOOM_LEAD_MS, click + ZOOM_HOLD_MS]
// at the fixed ZOOM scale. Consecutive clicks close in BOTH time (< MERGE_GAP_MS)
// and screen space (<= FAR_FRAC) merge into one continuous region. Distant rapid
// clicks split at the temporal midpoint instead: the spring ramps in sampleZoomAt
// meet at scale 1 there, so the camera does a full pull-back -> glide -> push-in
// rather than a whip-pan at full zoom. Regions shorter than MIN_REGION_MS are
// dropped. Pan is decoupled — the follow path (timeline.ts) decides where to
// look; regions only decide when/how much to zoom.
//
// ponytail: click-driven heuristic, not ML. Tune these constants on real
// recordings; upgrade to a dwell/velocity model only if zooms feel wrong.

import type { ZoomRegion } from "./timeline";

// ── Tunables (calibration knobs) ─────────────────────────────────────────────

/** Zoom-in scale factor. */
export const ZOOM = 2.0;
/** Zoom IN this long before the click. Must exceed the zoom ramp duration
 *  (DEFAULT_ZOOM_DURATION_MS) so the glide completes BEFORE the click. */
export const ZOOM_LEAD_MS = 950;
/** Stay zoomed this long AFTER a click before zooming back out. */
export const ZOOM_HOLD_MS = 1200;
/** If the next click lands within this of the current region's end, keep zoomed
 *  (extend/merge) — "click again quickly somewhere nearby" stays in. */
export const MERGE_GAP_MS = 900;
/** Regions shorter than this are dropped — a zoom should feel deliberate. */
export const MIN_REGION_MS = 900;
/** Normalized click displacement (hypot of per-axis fractions) above which
 *  temporally-mergeable clicks SPLIT instead of merging. ~70% of the ×2
 *  viewport width — past that a full-zoom pan reads as a whip. */
export const FAR_FRAC = 0.35;

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw mouse button state in a cursor sample. */
export type MouseButton = "down" | "up" | null;

/** One line of cursor.jsonl. t = ms since record start; x,y = source px. */
export interface CursorSample {
  t: number;
  x: number;
  y: number;
  btn: MouseButton;
}

// ── Algorithm ────────────────────────────────────────────────────────────────

/**
 * Main entry: cursor.jsonl samples -> ZoomRegion[] (ascending, non-overlapping).
 * srcW/srcH normalize click displacement for the merge-vs-split decision.
 * No clicks -> no zoom.
 */
export function computeZoomRegions(
  samples: CursorSample[],
  srcW: number,
  srcH: number,
): ZoomRegion[] {
  if (samples.length < 1 || srcW <= 0 || srcH <= 0) return [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const lastT = sorted[sorted.length - 1].t;

  const clicks: { t: number; x: number; y: number }[] = [];
  for (const s of sorted) {
    if (s.btn === "down") clicks.push({ t: s.t, x: s.x, y: s.y });
  }
  if (clicks.length === 0) return [];

  const regions: ZoomRegion[] = [];
  let prev: { t: number; x: number; y: number } | null = null;
  for (const c of clicks) {
    let startMs = Math.max(0, c.t - ZOOM_LEAD_MS);
    const endMs = Math.min(lastT, c.t + ZOOM_HOLD_MS);
    const last = regions[regions.length - 1];
    // Compare against the PREVIOUS click, not the region's first: the pan
    // follows the cursor continuously, so that's where the camera already is.
    const near =
      prev !== null &&
      Math.hypot((c.x - prev.x) / srcW, (c.y - prev.y) / srcH) <= FAR_FRAC;
    if (last && startMs - last.endMs < MERGE_GAP_MS && near) {
      last.endMs = Math.max(last.endMs, endMs); // rapid nearby clicks → stay zoomed
    } else {
      if (last && startMs < last.endMs) {
        // Distant rapid clicks: split at the midpoint. Each half keeps
        // >= dt/2 + 1075ms, comfortably above MIN_REGION_MS; only clamps at
        // the recording's edges can shorten one below it (then it's dropped).
        const mid = (last.endMs + startMs) / 2;
        last.endMs = mid;
        startMs = mid;
      }
      regions.push({ startMs, endMs, scale: ZOOM });
    }
    prev = c;
  }

  return regions.filter((r) => r.endMs - r.startMs >= MIN_REGION_MS);
}
