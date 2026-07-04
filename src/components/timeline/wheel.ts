// timeline/wheel.ts
//
// Pure, testable logic for the timeline's wheel gesture (pan vs zoom) and the
// visible-window clamping. No React/DOM — so it can be unit-tested directly
// (see wheel.test.ts). The component just feeds it event deltas + geometry and
// applies the returned window.

export const MIN_WINDOW_MS = 500;

export interface View {
  startMs: number;
  endMs: number;
}

export interface WheelGeom {
  /** Total clip duration (ms). */
  durationMs: number;
  /** Lane width in px. */
  viewportW: number;
  /** Pointer x within the lane (px). */
  localX: number;
  /** px per ms at the current zoom (viewportW / span). */
  pxPerMs: number;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a proposed window to [0,duration] with a minimum span; preserves span where possible. */
export function clampView(startMs: number, endMs: number, durationMs: number): View {
  let s = startMs;
  let e = endMs;
  const wantSpan = Math.max(MIN_WINDOW_MS, e - s);
  if (e - s < MIN_WINDOW_MS) e = s + MIN_WINDOW_MS;
  if (e > durationMs) {
    e = durationMs;
    s = Math.max(0, e - wantSpan);
  }
  if (s < 0) {
    s = 0;
    e = Math.min(durationMs, s + wantSpan);
  }
  e = clampNum(e, s + MIN_WINDOW_MS, durationMs);
  return { startMs: s, endMs: e };
}

export interface WheelDeltas {
  deltaX: number;
  deltaY: number;
}

export interface WheelResult {
  kind: "pan" | "zoom";
  view: View;
}

/**
 * Decide pan vs zoom from a wheel event and return the new visible window.
 *
 * Axis-based (NOT ctrl-based): this touchpad reports scroll as `deltaX` and an
 * unreliable `ctrlKey`, so the gesture is read from the dominant axis:
 *   - HORIZONTAL (|dx| > |dy|) → PAN by dx.
 *   - VERTICAL   (otherwise)   → ZOOM around the pointer by dy.
 */
export function wheelAction(ev: WheelDeltas, view: View, geom: WheelGeom): WheelResult {
  const horizontal = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
  if (horizontal) {
    const dMs = ev.deltaX / geom.pxPerMs;
    return { kind: "pan", view: clampView(view.startMs + dMs, view.endMs + dMs, geom.durationMs) };
  }
  const span = view.endMs - view.startMs;
  const tUnder = view.startMs + geom.localX / geom.pxPerMs;
  const frac = geom.localX / geom.viewportW;
  const factor = Math.exp(ev.deltaY * 0.01); // deltaY<0 (scroll up) → zoom in
  const newSpan = clampNum(span * factor, MIN_WINDOW_MS, geom.durationMs);
  const newStart = tUnder - frac * newSpan;
  return { kind: "zoom", view: clampView(newStart, newStart + newSpan, geom.durationMs) };
}
