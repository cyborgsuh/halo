// Run: npx tsx src/components/timeline/wheel.test.ts
// Pure unit tests for the timeline wheel pan/zoom logic, using the REAL wheel
// events captured from the user's touchpad (debug.log).

import assert from "node:assert";
import { wheelAction, clampView, MIN_WINDOW_MS } from "./wheel";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log("  ok:", name);
};

// Geometry: a 10s clip, 1000px lane, pointer at center, fully zoomed out.
const geomFull = { durationMs: 10000, viewportW: 1000, localX: 500, pxPerMs: 1000 / 10000 };
const view0 = { startMs: 2000, endMs: 6000 }; // a 4s window
const geomZoomed = { durationMs: 10000, viewportW: 1000, localX: 500, pxPerMs: 1000 / 4000 };

// ── The bug: the user's "scroll right" = {dx:57, dy:0, ctrl:true}. Must PAN. ──
t("real scroll-right (dx=57,dy=0) PANS, never zooms", () => {
  const r = wheelAction({ deltaX: 57, deltaY: 0 }, view0, geomZoomed);
  assert.equal(r.kind, "pan");
  assert.ok(
    Math.abs(r.view.endMs - r.view.startMs - 4000) < 1,
    "span unchanged on pan (no zoom)",
  );
  assert.ok(r.view.startMs > view0.startMs, "panned to the right");
});

t("real scroll-left (dx=-31,dy=0) PANS left", () => {
  const r = wheelAction({ deltaX: -31, deltaY: 0 }, view0, geomZoomed);
  assert.equal(r.kind, "pan");
  assert.ok(r.view.startMs < view0.startMs, "panned left");
});

// ── Vertical wheel = zoom ──
t("vertical up (dy=-100) ZOOMS IN (span shrinks)", () => {
  const r = wheelAction({ deltaX: 0, deltaY: -100 }, view0, geomZoomed);
  assert.equal(r.kind, "zoom");
  assert.ok(r.view.endMs - r.view.startMs < 4000, "span shrank");
});

t("vertical down (dy=100) ZOOMS OUT (span grows)", () => {
  const r = wheelAction({ deltaX: 0, deltaY: 100 }, view0, geomZoomed);
  assert.equal(r.kind, "zoom");
  assert.ok(r.view.endMs - r.view.startMs > 4000, "span grew");
});

t("zoom is anchored under the pointer (center stays centered)", () => {
  const r = wheelAction({ deltaX: 0, deltaY: -100 }, view0, geomZoomed);
  const centerBefore = (view0.startMs + view0.endMs) / 2; // 4000
  const centerAfter = (r.view.startMs + r.view.endMs) / 2;
  assert.ok(Math.abs(centerAfter - centerBefore) < 1, "pointer-anchored zoom keeps center");
});

// ── Clamping invariants ──
t("pan past the end clamps + preserves span", () => {
  const r = wheelAction({ deltaX: 100000, deltaY: 0 }, view0, geomZoomed);
  assert.equal(r.kind, "pan");
  assert.equal(r.view.endMs, 10000, "clamped to duration");
  assert.ok(Math.abs(r.view.endMs - r.view.startMs - 4000) < 1, "span preserved at edge");
});

t("zoom never goes below MIN_WINDOW_MS", () => {
  let v = { startMs: 0, endMs: 10000 };
  for (let i = 0; i < 50; i++) {
    const px = 1000 / (v.endMs - v.startMs);
    v = wheelAction({ deltaX: 0, deltaY: -120 }, v, { ...geomFull, pxPerMs: px }).view;
  }
  assert.ok(v.endMs - v.startMs >= MIN_WINDOW_MS - 1e-6, "span >= MIN_WINDOW_MS");
});

t("zoom out from full view stays within [0,duration]", () => {
  const r = wheelAction({ deltaX: 0, deltaY: 100 }, { startMs: 0, endMs: 10000 }, geomFull);
  assert.ok(r.view.startMs >= 0 && r.view.endMs <= 10000);
});

t("clampView keeps a degenerate window valid", () => {
  const v = clampView(9000, 9000, 10000);
  assert.ok(v.endMs - v.startMs >= MIN_WINDOW_MS);
  assert.ok(v.endMs <= 10000);
});

console.log(`\nALL ${passed} WHEEL TESTS PASSED`);
