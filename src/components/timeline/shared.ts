// timeline/shared.ts
//
// Shared math + types for the unified pro timeline. A single pixels<->time
// mapping (`TimeScale`) is derived once in Timeline.tsx from the measured lane
// width and threaded to every track, so Ruler / ClipTrack / ZoomTrack / Playhead
// all agree on x<->ms. Pure helpers only — no React state here.

import type { ZoomRegion } from "@/lib/timeline";

/** The one pixels<->time mapping every track shares. */
export interface TimeScale {
  /** Total source length (ms). */
  durationMs: number;
  /** Pixels per millisecond at the current horizontal zoom. */
  pxPerMs: number;
  /** Full content width in px (durationMs * pxPerMs). */
  contentWidth: number;
  /** ms -> px offset from the content's left edge. */
  xAt: (ms: number) => number;
  /** A viewport clientX -> source time (ms), clamped to [0, durationMs]. */
  timeAtX: (clientX: number) => number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** m:ss — the ruler / tick label format. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** m:ss.cs — the transport readout (centisecond precision). */
export function fmtClockMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const s = Math.floor(total / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** "Nice" tick spacings (ms). The ruler picks the smallest that clears minPx. */
const NICE_MS = [
  100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000,
  600000,
];

/** Choose a labelled-tick interval so each label has at least `minPx` room. */
export function chooseTickMs(pxPerMs: number, minPx = 68): number {
  if (pxPerMs <= 0) return NICE_MS[NICE_MS.length - 1];
  for (const n of NICE_MS) if (n * pxPerMs >= minPx) return n;
  return NICE_MS[NICE_MS.length - 1];
}

/** Minimum trimmed clip length (ms). */
export const MIN_TRIM_MS = 200;
/** Minimum zoom-region length (ms). */
export const MIN_REGION_MS = 300;
/** Default length of a region added by clicking empty zoom lane (ms). */
export const DEFAULT_REGION_MS = 1500;

/** Which part of a zoom block a pointer grabbed. */
export type DragZone = "move" | "resize-start" | "resize-end";

/**
 * Mirror of `store.addZoomRegion`'s clamping so the timeline can predict the
 * sorted index a freshly-added region will land at (parent owns selection).
 */
export function predictAddedIndex(
  regions: ZoomRegion[],
  startMs: number,
  durationMs: number,
): { index: number; startMs: number; endMs: number } {
  const start = clamp(startMs, 0, Math.max(0, durationMs - 1));
  const end = Math.min(durationMs, start + DEFAULT_REGION_MS);
  // Array.sort is stable; an appended region sorts after equal-start ones.
  const index = regions.filter((r) => r.startMs <= start).length;
  return { index, startMs: start, endMs: end };
}
