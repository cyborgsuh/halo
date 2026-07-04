// Run: npx tsx src/lib/autozoom.test.ts
// Pins the pure motion math behind the premium auto-zoom feel: click-region
// merge/split, the continuous window-follow target, look-ahead pan, click
// pre-arrival/centering, jitter hold, soft edge deceleration, and the spring
// zoom ramp. Rendering is visual (integration); this is the logic that breaks.

import assert from "node:assert";
import {
  computeZoomRegions,
  MIN_REGION_MS,
  ZOOM,
  type CursorSample,
} from "./autozoom";
import {
  computeFollowPath,
  sampleFollowAt,
  sampleZoomAt,
  followTarget,
  tickPlayClock,
  type CursorFollow,
  type PlayClock,
  type ZoomRegion,
} from "./timeline";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log("  ok:", name);
};

const W = 1920;
const H = 1080;
const FOLLOW: CursorFollow = { strength: 0.68, deadzonePct: 10 }; // dz = 0.05 normalized

/** 10ms-step samples over [0, durMs]; pos(t) gives normalized (x,y). */
function mkSamples(
  durMs: number,
  pos: (t: number) => { x: number; y: number },
  clickTs: number[] = [],
): CursorSample[] {
  const clicks = new Set(clickTs);
  const out: CursorSample[] = [];
  for (let tt = 0; tt <= durMs; tt += 10) {
    const p = pos(tt);
    out.push({ t: tt, x: p.x * W, y: p.y * H, btn: clicks.has(tt) ? "down" : null });
  }
  return out;
}

// ── Region merge/split ───────────────────────────────────────────────────────

t("close nearby clicks merge into one region", () => {
  const s = mkSamples(3500, () => ({ x: 0.5, y: 0.5 }), [1000, 1800]);
  const r = computeZoomRegions(s, W, H);
  assert.equal(r.length, 1);
  assert.equal(r[0].startMs, 50); // 1000 - 950
  assert.equal(r[0].endMs, 3000); // 1800 + 1200
  assert.equal(r[0].scale, ZOOM);
});

t("distant rapid clicks split at the midpoint with a full dip", () => {
  const s = mkSamples(
    3500,
    (tt) => (tt < 1400 ? { x: 0.1, y: 0.5 } : { x: 0.9, y: 0.5 }),
    [1000, 1800],
  );
  const r = computeZoomRegions(s, W, H);
  assert.equal(r.length, 2);
  // click1 [50, 2200], click2 [850, 3000] → split at (2200 + 850) / 2 = 1525
  assert.equal(r[0].endMs, 1525);
  assert.equal(r[1].startMs, 1525);
  for (const g of r) assert.ok(g.endMs - g.startMs >= MIN_REGION_MS);
  // Full pull-back at the boundary, zoomed on both sides of it.
  assert.ok(Math.abs(sampleZoomAt(r, 1525).scale - 1) < 1e-9);
  assert.ok(sampleZoomAt(r, 1000).scale > 1.85);
  assert.ok(sampleZoomAt(r, 1800).scale > 1.5);
});

t("clicks far apart in time stay separate with a baseline gap", () => {
  const s = mkSamples(7000, () => ({ x: 0.5, y: 0.5 }), [1000, 5000]);
  const r = computeZoomRegions(s, W, H);
  assert.equal(r.length, 2);
  assert.ok(r[1].startMs > r[0].endMs);
  assert.ok(Math.abs(sampleZoomAt(r, 3000).scale - 1) < 1e-9);
});

t("degenerates: empty, no clicks, click at t=0", () => {
  assert.deepEqual(computeZoomRegions([], W, H), []);
  const noClicks = mkSamples(2000, () => ({ x: 0.5, y: 0.5 }));
  assert.deepEqual(computeZoomRegions(noClicks, W, H), []);
  const t0 = mkSamples(2000, () => ({ x: 0.5, y: 0.5 }), [0]);
  const r = computeZoomRegions(t0, W, H);
  assert.equal(r.length, 1);
  assert.equal(r[0].startMs, 0);
});

// ── Window-follow target ─────────────────────────────────────────────────────

t("followTarget is continuous at the deadzone boundary", () => {
  const dz = 0.05;
  assert.equal(followTarget(0.5, 0.5 + dz, dz), 0.5); // at boundary: hold
  const justOut = followTarget(0.5, 0.5 + dz + 1e-4, dz);
  assert.ok(Math.abs(justOut - (0.5 + 1e-4)) < 1e-12); // moves just enough
  assert.equal(followTarget(0.5, 0.52, dz), 0.5); // inside: hold
  assert.equal(followTarget(0.5, 0.3, dz), 0.3 + dz); // below: symmetric
});

// ── Follow path: look-ahead, centering, jitter, edges ────────────────────────

t("look-ahead: camera moves before the raw cursor does", () => {
  // Cursor still until 1500ms, then sweeps 0.5 → 0.8 over 400ms, then holds.
  const s = mkSamples(4000, (tt) => {
    const u = Math.min(1, Math.max(0, (tt - 1500) / 400));
    return { x: 0.5 + 0.3 * u, y: 0.5 };
  });
  const path = computeFollowPath(s, W, H, FOLLOW);
  // At t=1450 the raw cursor is still at 0.5, but the lead target (t+250ms)
  // is already outside the deadzone → the camera is already underway.
  assert.ok(sampleFollowAt(path, 1450).cx > 0.5005);
});

t("click pre-arrival: camera is centered on the click point by click time", () => {
  // Click at x=0.7 — inside the ×2 viewport margin, so dead-centering is
  // reachable. Window-follow alone would stop DZ short at 0.65.
  const s = mkSamples(
    4000,
    (tt) => {
      const u = Math.min(1, Math.max(0, (tt - 1500) / 400));
      return { x: 0.5 + 0.2 * u, y: 0.5 };
    },
    [2200],
  );
  const path = computeFollowPath(s, W, H, FOLLOW);
  assert.ok(Math.abs(sampleFollowAt(path, 2200).cx - 0.7) < 0.03);
});

t("clicks past the ×2 viewport margin settle AT the margin (no edge slam)", () => {
  // Click at x=0.8 cannot be dead-centered at ×2 — max center is 0.75; the
  // spring must settle there smoothly instead of fighting the renderer clamp.
  const s = mkSamples(
    4000,
    (tt) => {
      const u = Math.min(1, Math.max(0, (tt - 1500) / 400));
      return { x: 0.5 + 0.3 * u, y: 0.5 };
    },
    [2200],
  );
  const path = computeFollowPath(s, W, H, FOLLOW);
  const settled = sampleFollowAt(path, 3200).cx;
  assert.ok(Math.abs(settled - 0.75) < 0.005, `settled at ${settled}`);
});

t("no chatter: sub-deadzone jitter leaves the camera still", () => {
  const s = mkSamples(3000, (tt) => ({
    x: 0.5 + 0.02 * Math.sin(tt / 30),
    y: 0.5 + 0.02 * Math.sin(tt / 47),
  }));
  const path = computeFollowPath(s, W, H, FOLLOW);
  for (const p of path) {
    assert.ok(Math.abs(p.cx - 0.5) < 0.01, `cx drifted: ${p.cx}`);
    assert.ok(Math.abs(p.cy - 0.5) < 0.01, `cy drifted: ${p.cy}`);
  }
});

t("soft edge: spring decelerates into the target margin, no slam past it", () => {
  // Sweep to the right edge and hold — target clamps at 0.75 (×2 viewport).
  const s = mkSamples(3000, (tt) => {
    const u = Math.min(1, tt / 1000);
    return { x: 0.5 + 0.48 * u, y: 0.5 };
  });
  const path = computeFollowPath(s, W, H, FOLLOW);
  const last = path[path.length - 1];
  assert.ok(last.cx > 0.74 && last.cx <= 0.76, `settled at ${last.cx}`);
  for (const p of path) assert.ok(p.cx <= 0.76, `overshot margin: ${p.cx}`);
});

t("monotone tracking under steady drift (no wobble)", () => {
  const s = mkSamples(2500, (tt) => ({ x: 0.3 + (0.4 * tt) / 2500, y: 0.5 }));
  const path = computeFollowPath(s, W, H, FOLLOW);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].cx >= path[i - 1].cx - 1e-6, `moved left at i=${i}`);
  }
  assert.ok(path[path.length - 1].cx > path[0].cx + 0.1);
});

t("follow degenerates: empty, single sample, zero deadzone", () => {
  assert.deepEqual(computeFollowPath([], W, H, FOLLOW), []);
  const one = computeFollowPath([{ t: 0, x: W / 2, y: H / 2 }], W, H, FOLLOW);
  assert.equal(one.length, 1);
  const zeroDz = computeFollowPath(
    mkSamples(1000, (tt) => ({ x: 0.4 + tt / 10000, y: 0.5 })),
    W,
    H,
    { strength: 0.68, deadzonePct: 0 },
  );
  assert.equal(zeroDz.length, 101);
});

// ── Zoom ramp (ported from the old in-file self-check) ───────────────────────

t("zoom ramp: baseline outside, full inside, never overshoots", () => {
  const regions: ZoomRegion[] = [{ startMs: 1000, endMs: 4000, scale: 2 }];
  const at = (tt: number) => sampleZoomAt(regions, tt, 750).scale;
  assert.ok(Math.abs(at(0) - 1) < 1e-6);
  assert.ok(Math.abs(at(999) - 1) < 1e-6);
  assert.ok(at(2500) > 1.9);
  assert.ok(Math.abs(at(4000) - 1) < 1e-6);
  assert.ok(Math.abs(at(4500) - 1) < 1e-6);
  for (let tt = 1000; tt <= 4000; tt += 10) {
    const sc = at(tt);
    assert.ok(sc <= 2 + 1e-9 && sc >= 1 - 1e-9, `out of range at ${tt}: ${sc}`);
  }
});

// ── Playback clock (regression: the stuck/ping-pong playhead glitch) ────────

t("play clock never reverses against a video running 10% slow", () => {
  // Repro of the real bug: video decodes slower than wall time; the old hard
  // 120ms snap-back made the playhead jump backward every few hundred ms.
  const c: PlayClock = { anchorPerf: 0, anchorMs: 3000, lastT: 3000 };
  let prev = 3000;
  for (let now = 16; now <= 8000; now += 16) {
    const videoMs = 3000 + now * 0.9; // video 10% behind real time
    const t2 = tickPlayClock(c, now, videoMs);
    assert.ok(t2 >= prev, `reversed at now=${now}: ${prev} -> ${t2}`);
    prev = t2;
  }
  // ...and it converged onto the video clock instead of running away.
  assert.ok(Math.abs(prev - (3000 + 8000 * 0.9)) < 150, `diverged: ${prev}`);
});

t("play clock tracks wall time when the video keeps up", () => {
  const c: PlayClock = { anchorPerf: 0, anchorMs: 0, lastT: 0 };
  let t2 = 0;
  for (let now = 16; now <= 2000; now += 16) t2 = tickPlayClock(c, now, now);
  assert.ok(Math.abs(t2 - 2000) < 30, `drifted: ${t2}`);
});

t("play clock hard-resyncs on a real discontinuity (seek)", () => {
  const c: PlayClock = { anchorPerf: 0, anchorMs: 5000, lastT: 5000 };
  const t2 = tickPlayClock(c, 16, 1000); // video jumped back 4s (user seek)
  assert.ok(Math.abs(t2 - 1000) < 20, `should follow the seek, got ${t2}`);
});

t("play clock coasts without a video", () => {
  const c: PlayClock = { anchorPerf: 0, anchorMs: 100, lastT: 100 };
  assert.ok(Math.abs(tickPlayClock(c, 500, null) - 600) < 1e-9);
});

console.log(`\nALL ${passed} AUTOZOOM TESTS PASSED`);
