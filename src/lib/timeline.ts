// timeline.ts
//
// SHARED PROJECT TYPES (the `project.json` document shape) + timeline math.
//
// NOTE FOR INTEGRATION: this file is co-owned with the autozoom/timeline agent.
// This stage (frontend capture: capture.ts + store.ts) only needs the *type*
// definitions of the editable project, so the block below defines exactly the
// `project.json` schema from the plan. The autozoom/timeline agent appends the
// easing / interpolation / keyframe-math functions to this same file. The types
// here are the canonical contract — do not redefine them elsewhere; import from
// "@/lib/timeline".

/** Easing curves referenced by zoom keyframes. */
export type EasingName =
  | "linear"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInOutQuad";

/** The captured screen source. */
export interface ProjectSource {
  /** Relative file name of the screen recording, e.g. "screen.mp4". */
  screen: string;
  w: number;
  h: number;
  fps: number;
  durationMs: number;
}

/** Microphone audio track. */
export interface AudioTrack {
  /** Relative file name, e.g. "mic.webm". */
  mic: string;
  /** ms the mic media start lags behind the shared record clock (A/V sync). */
  offsetMs: number;
}

export type CameraShape = "circle" | "rounded" | "square";
/** Corner anchor: bottom-right / bottom-left / top-right / top-left. */
export type CameraPos = "br" | "bl" | "tr" | "tl";

/** Webcam bubble overlay. */
export interface Camera {
  /** Relative file name, e.g. "cam.webm". */
  file: string;
  shape: CameraShape;
  pos: CameraPos;
  /** Bubble size as a percentage of output width. */
  sizePct: number;
  /** ms the cam media start lags behind the shared record clock. */
  offsetMs: number;
}

/** Trim window applied to the source. */
export interface Trim {
  startMs: number;
  endMs: number;
}

export type BackgroundType = "solid" | "gradient" | "image";

/** Background / padding / framing of the composited screen. */
export interface Background {
  type: BackgroundType;
  /** Solid: "#rrggbb". Gradient: ["#a","#b"]. Image: file path / url. */
  value: string | string[];
  paddingPct: number;
  radiusPx: number;
  /** 0..1 drop-shadow strength. */
  shadow: number;
}

/**
 * LEGACY: a single auto-zoom keyframe (the V2 model). Kept ONLY so
 * `normalizeProject` can recognise and migrate old keyframe-shaped
 * `project.json` documents into the block-native `ZoomRegion[]` model. New code
 * must use `ZoomRegion`.
 */
export interface ZoomKeyframe {
  tMs: number;
  /** 1.0 = no zoom. */
  scale: number;
  /** Normalized zoom center, 0..1. */
  cx: number;
  cy: number;
  ease: EasingName;
  /** Optional dwell at this keyframe before easing to the next. */
  holdMs?: number;
}

/**
 * A block-native zoom span: from `startMs` the viewport ramps in to `scale`,
 * holds, then ramps back to 1 ending at `endMs`. Pan is decoupled (follow-path
 * driven) so there is no per-region center. Regions are stored ascending and
 * non-overlapping on `Project.zoom`.
 */
export interface ZoomRegion {
  /** Region start on the source timeline (ms). Ramp-in begins here. */
  startMs: number;
  /** Region end on the source timeline (ms). Ramp-out completes here. */
  endMs: number;
  /** Magnification at full zoom. 1.0 = no zoom. */
  scale: number;
}

/** A removed span of the source timeline (a "cut" / trim-in-the-middle). */
export interface Cut {
  startMs: number;
  endMs: number;
}

/** Sort + drop degenerate cuts. */
export function sanitizeCuts(cuts: Cut[] | undefined): Cut[] {
  return (cuts ?? [])
    .filter((c) => c && c.endMs > c.startMs)
    .map((c) => ({ startMs: Math.max(0, c.startMs), endMs: c.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
}

/** True if `tMs` falls inside any cut; returns the cut's end so playback can skip it. */
export function cutEndAt(cuts: Cut[], tMs: number): number | null {
  for (const c of cuts) {
    if (tMs >= c.startMs && tMs < c.endMs) return c.endMs;
  }
  return null;
}

/** Continuous cursor pan-follow settings (Screen Studio style). */
export interface CursorFollow {
  /** 0..1 follow aggressiveness: how tightly the viewport tracks the cursor. */
  strength: number;
  /** Central deadzone as a % of the frame; the pan only moves once the cursor leaves it. */
  deadzonePct: number;
}

/** Default cursor-follow tuning applied to fresh/loaded projects. */
export const DEFAULT_CURSOR_FOLLOW: CursorFollow = {
  strength: 0.68,
  // Window-follow holds still inside this zone (it no longer center-chases),
  // so a wider default kills drift-chatter; clicks still land dead-center via
  // the post-click centering window.
  deadzonePct: 10,
};

/** Export render settings. */
export interface ExportSettings {
  w: number;
  h: number;
  fps: number;
  format: "mp4" | "gif";
  bitrateMbps: number;
}

/** The editable document mutated by the editor (the `project.json` shape). */
export interface Project {
  version: number;
  source: ProjectSource;
  audio: AudioTrack;
  camera: Camera;
  trim: Trim;
  background: Background;
  /** Zoom regions, ascending + non-overlapping (the block-native model). */
  zoom: ZoomRegion[];
  /** Removed spans (trim-in-the-middle cuts), ascending. */
  cuts: Cut[];
  /** 0..1 low-pass smoothing applied to the rendered cursor path. */
  cursorSmoothing: number;
  /** Continuous pan-follow tuning (decoupled from the scale-only zoom keyframes). */
  cursorFollow: CursorFollow;
  /**
   * How long a zoom ramps from one scale to the next, in ms. Fixed + controllable
   * (NOT the keyframe gap) so zooms feel snappy. Lower = faster zoom.
   */
  zoomDurationMs: number;
  export: ExportSettings;
}

/** Default zoom transition duration (ms). A graceful, premium glide (not snappy).
 *  Lower = faster. Tunable per-project via the Inspector "Zoom speed" slider. */
export const DEFAULT_ZOOM_DURATION_MS = 750;

/**
 * Library metadata for one persisted recording (mirrors the Rust `RecordingMeta`
 * returned by `list_recordings`). Dashboard cards render from this; no media is
 * loaded until a recording is opened.
 */
export interface RecordingMeta {
  id: string;
  dir: string;
  screenPath: string;
  thumbPath: string | null;
  createdMs: number;
  durationMs: number;
  /** Trim window from project.json (0/0 when absent). The head of screen.mp4
   *  holds the countdown — thumbnails/badges must skip past trimStartMs. */
  trimStartMs: number;
  trimEndMs: number;
}

// ---------------------------------------------------------------------------
// Playback clock: smooth performance-clock playhead that trusts the <video> as
// the A/V truth WITHOUT ever reversing. Pure + stateful-by-argument so the
// editor play loop stays testable.
// ---------------------------------------------------------------------------

export interface PlayClock {
  anchorPerf: number;
  anchorMs: number;
  lastT: number;
}

/**
 * Advance the playhead clock one frame. `videoMs` is the video element's
 * currentTime in ms (null when no video). Under decode pressure the video runs
 * behind real time — a hard `snap to video` yanked the playhead BACKWARD every
 * few hundred ms (visible stuck/ping-pong glitch). Instead: slew the anchor
 * proportionally toward the video clock so drift converges without reversals;
 * only a real discontinuity (seek/stall, >500ms) hard-resyncs. The returned t
 * is monotonic across calls except on hard resync.
 */
export function tickPlayClock(
  c: PlayClock,
  nowPerf: number,
  videoMs: number | null,
): number {
  let t = c.anchorMs + (nowPerf - c.anchorPerf);
  if (videoMs != null) {
    const drift = videoMs - t;
    if (Math.abs(drift) > 500) {
      c.anchorPerf = nowPerf;
      c.anchorMs = videoMs;
      t = videoMs;
      c.lastT = Math.min(c.lastT, t); // allow the jump both ways on real resync
    } else if (Math.abs(drift) > 24) {
      c.anchorMs += drift * 0.08; // proportional pull; ~1s convergence at 60fps
      t = c.anchorMs + (nowPerf - c.anchorPerf);
    }
  }
  t = Math.max(t, c.lastT); // may slow, never reverse
  c.lastT = t;
  return t;
}

// ---------------------------------------------------------------------------
// Timeline math: easing curves + zoom keyframe interpolation. Pure functions,
// no React, no GPU. The renderer (preview + export) calls sampleZoomAt(t).
// ---------------------------------------------------------------------------

/** A normalized 1-arg easing curve: maps [0,1] -> [0,1]. */
export type EasingFn = (t: number) => number;

export const easeLinear: EasingFn = (t) => t;
export const easeInCubic: EasingFn = (t) => t * t * t;
export const easeOutCubic: EasingFn = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: EasingFn = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeInOutQuad: EasingFn = (t) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/** Lookup table from EasingName -> curve. */
export const EASINGS: Record<EasingName, EasingFn> = {
  linear: easeLinear,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInOutQuad,
};

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Apply a named easing curve, clamping the input to [0,1]. */
export function applyEase(name: EasingName, t: number): number {
  const fn = EASINGS[name] ?? easeInOutCubic;
  return fn(clamp01(t));
}

/** The interpolated zoom transform for a single frame. */
export interface ZoomState {
  scale: number;
  cx: number;
  cy: number;
}

const BASELINE: ZoomState = { scale: 1, cx: 0.5, cy: 0.5 };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Critically-damped spring STEP RESPONSE (closed-form, deterministic — no
 * stateful integrator). Maps an elapsed time `tau` (ms) to a 0→1 ramp that eases
 * in fast and softly settles with NO overshoot. `omega` is chosen so the ramp is
 * ~99% settled at `tau = durationMs`.
 *
 *   omega = 6.64 / max(1, durationMs)
 *   ramp(tau) = 1 - (1 + omega*tau) * e^(-omega*tau)
 */
export function springRamp(tau: number, durationMs: number): number {
  if (tau <= 0) return 0;
  const omega = 6.64 / Math.max(1, durationMs);
  const x = omega * tau;
  return 1 - (1 + x) * Math.exp(-x);
}

/**
 * Sample the zoom transform at source time `tMs`. Pure + deterministic so the
 * editor scrub and the export agree frame-for-frame.
 *
 * Region model: find the active region (`startMs <= tMs < endMs`). Inside it the
 * scale is `1 + (scale-1) * min(rampIn, rampOut)` where `rampIn` is the spring
 * step measured from `startMs` and `rampOut` is the spring step measured
 * BACKWARDS from `endMs`. So the zoom ramps 1→scale at the start, holds, then
 * ramps scale→1 ending exactly at `endMs`; short regions that never reach full
 * scale fall out naturally (the two ramps cross below `scale`). Pan stays
 * centered here (cx/cy = 0.5) — the renderer drives pan from the follow path.
 * Outside every region: baseline (scale 1, centered).
 */
export function sampleZoomAt(
  regions: ZoomRegion[],
  tMs: number,
  durationMs: number = DEFAULT_ZOOM_DURATION_MS,
): ZoomState {
  if (!regions || regions.length === 0) return { ...BASELINE };

  // Active region: first whose [startMs, endMs) contains tMs. Regions are
  // expected ascending + non-overlapping, but we scan defensively.
  let active: ZoomRegion | null = null;
  for (const r of regions) {
    if (tMs >= r.startMs && tMs < r.endMs) {
      active = r;
      break;
    }
  }
  if (!active) return { ...BASELINE };

  const dur = Math.max(1, durationMs);
  const rampIn = springRamp(tMs - active.startMs, dur);
  const rampOut = springRamp(active.endMs - tMs, dur);
  const u = Math.min(rampIn, rampOut);
  const scale = lerp(1, Math.max(1, active.scale), clamp01(u));
  return { scale, cx: 0.5, cy: 0.5 };
}

// ---------------------------------------------------------------------------
// Migration: old keyframe-shaped zoom -> ZoomRegion[]. Idempotent.
// ---------------------------------------------------------------------------

/** A keyframe-shaped object smells like the legacy V2 zoom model. */
function looksLikeKeyframe(z: unknown): z is ZoomKeyframe {
  return (
    !!z &&
    typeof z === "object" &&
    "tMs" in (z as Record<string, unknown>) &&
    !("startMs" in (z as Record<string, unknown>))
  );
}

/**
 * Fold legacy in/out keyframe pairs into regions: each zoom-in (scale > 1) opens
 * a region that closes at the next keyframe (its zoom-out, or the next in), or at
 * `durationMs` if none follows. Mirrors how the old timeline visualised spans.
 */
function keyframesToRegions(
  kfs: ZoomKeyframe[],
  durationMs: number,
): ZoomRegion[] {
  const sorted = [...kfs].sort((a, b) => a.tMs - b.tMs);
  const out: ZoomRegion[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const k = sorted[i];
    if (k.scale <= 1) continue;
    const end = i + 1 < sorted.length ? sorted[i + 1].tMs : durationMs;
    if (end > k.tMs) {
      out.push({ startMs: k.tMs, endMs: end, scale: k.scale });
    }
  }
  return sanitizeRegions(out, durationMs);
}

/**
 * Sort ascending, drop degenerate spans, clamp scale >= 1 and clip overlaps so
 * the result is the ascending + non-overlapping invariant the model promises.
 */
export function sanitizeRegions(
  regions: ZoomRegion[],
  durationMs = Infinity,
): ZoomRegion[] {
  const cleaned = (regions ?? [])
    .filter((r) => r && r.endMs > r.startMs)
    .map((r) => ({
      startMs: Math.max(0, r.startMs),
      endMs: Math.min(durationMs, r.endMs),
      scale: Math.max(1, r.scale),
    }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const out: ZoomRegion[] = [];
  for (const r of cleaned) {
    const prev = out[out.length - 1];
    if (prev && r.startMs < prev.endMs) {
      // Overlap: butt this region up against the previous one.
      r.startMs = prev.endMs;
      if (r.endMs <= r.startMs) continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * Normalize a freshly-loaded project: migrate legacy keyframe-shaped `zoom` into
 * `ZoomRegion[]`, sanitize already-region zoom, and default `zoomDurationMs` /
 * `cursorFollow` when missing. Idempotent — safe to run on every `setProject`.
 */
export function normalizeProject(p: Project): Project {
  if (!p) return p;
  const durationMs = p.source?.durationMs ?? Infinity;
  const raw = p.zoom as unknown as Array<ZoomRegion | ZoomKeyframe> | undefined;

  let zoom: ZoomRegion[];
  if (Array.isArray(raw) && raw.length > 0 && looksLikeKeyframe(raw[0])) {
    zoom = keyframesToRegions(raw as ZoomKeyframe[], durationMs);
  } else {
    zoom = sanitizeRegions((raw as ZoomRegion[]) ?? [], durationMs);
  }

  return {
    ...p,
    zoom,
    cuts: sanitizeCuts(p.cuts),
    // Motion "feel" knobs are GLOBAL, not per-clip content — always apply the
    // current defaults on load so every recording reflects the latest tuning
    // (the Inspector sliders still live-tune the open project).
    zoomDurationMs: DEFAULT_ZOOM_DURATION_MS,
    cursorFollow: { ...DEFAULT_CURSOR_FOLLOW },
  };
}

// ===========================================================================
// CONTINUOUS CURSOR PAN-FOLLOW (the V2 signature upgrade)
//
// Scale comes from the zoom regions (sampleZoomAt); PAN is decoupled and
// follows the cursor. The cursor data is fully recorded, so the follow target
// is evaluated at a LEAD time — the camera anticipates instead of trailing.
// Per output sample: window-follow target (move only enough to keep the
// cursor inside the deadzone; hold otherwise; recenter fully for a beat after
// each click) → clamp to the ×2 viewport margin (decelerate INTO the frame
// edge) → critically-damped spring. Deterministic per tMs so scrubbing and
// export agree.
// ===========================================================================

// ── Follow tunables (named knobs — calibrate on real recordings) ────────────

/**
 * How far ahead (ms) the target reads the recorded cursor. Roughly the
 * spring's settle lag (~2/omega at default strength), so the camera arrives
 * WITH the action instead of after it.
 */
export const FOLLOW_LOOKAHEAD_MS = 250;
/**
 * For this long after a click the target is the cursor ITSELF (not the
 * window), so clicks land dead-center. Kept inside the post-click zoom hold
 * (ZOOM_HOLD_MS = 1200) so centering never outlives the zoom.
 */
export const CLICK_CENTER_MS = 900;
/**
 * Follow-target clamp margin: the viewport half-extent at the ×2 auto-zoom
 * (0.5/2). Clamping the TARGET lets the spring decelerate into the frame edge
 * instead of slamming into the renderer's hard clamp mid-glide.
 * ponytail: hardcoded ×2 (a value import from autozoom.ts would be a module
 * cycle); the renderer's scale-aware clamp stays as the exact backstop for
 * hand-authored region scales.
 */
const FOLLOW_TARGET_MARGIN = 0.25;

/**
 * Critically-damped follow spring natural frequency (rad/s). The pan glides to
 * the target with NO overshoot; higher = tighter/faster tracking. `strength`
 * (0..1) interpolates between MIN (smooth, laggy) and MAX (snappy).
 */
export const FOLLOW_OMEGA_MIN = 4;
export const FOLLOW_OMEGA_MAX = 12;

// ── Follow types ────────────────────────────────────────────────────────────

/** Minimal cursor sample shape the follow math needs (t, source-px x/y).
 *  `btn` is optional — when present, "down" samples drive click-centering. */
export interface FollowInputSample {
  t: number;
  x: number;
  y: number;
  btn?: "down" | "up" | null;
}

/** One precomputed follow center: normalized (cx,cy) at source time `t`. */
export interface FollowPoint {
  t: number;
  cx: number;
  cy: number;
}

/** A precomputed follow-pan trajectory (ascending `t`). */
export type FollowPath = FollowPoint[];

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isSortedByT(samples: FollowInputSample[]): boolean {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < samples[i - 1].t) return false;
  }
  return true;
}

/**
 * Window-follow target on one axis. Inside the central margin `dz` the center
 * holds (kills micro-jitter from human hand tremor); outside it, the target
 * moves JUST enough to bring the cursor back to the deadzone edge — continuous
 * at |cursor - center| = dz, so the camera never rubber-band snaps. Clicks
 * land dead-center via the separate click-centering window, not here.
 */
export function followTarget(center: number, cursor: number, dz: number): number {
  const d = cursor - center;
  if (Math.abs(d) <= dz) return center;
  return cursor - Math.sign(d) * dz;
}

/**
 * Edge-guard: clamp a normalized follow center so the 1/scale viewport stays
 * fully inside the source frame. Shared by the renderer's per-frame transform
 * and the follow self-check.
 */
export function clampFollowCenter(
  cx: number,
  cy: number,
  scale: number,
): { cx: number; cy: number } {
  const half = 0.5 / Math.max(scale, 1);
  return {
    cx: half >= 0.5 ? 0.5 : clampN(cx, half, 1 - half),
    cy: half >= 0.5 ? 0.5 : clampN(cy, half, 1 - half),
  };
}

/**
 * Precompute the follow-pan path from raw cursor samples.
 *
 *  - `samples` carry source-pixel x/y (a superset of CursorSample is fine;
 *    `btn === "down"` samples drive click-centering when present).
 *  - `w`,`h` are the source frame dims used to normalize to 0..1.
 *  - `follow` supplies `strength` (spring stiffness) and `deadzonePct`.
 *
 * Per output sample at time t everything is evaluated at the LEAD time
 * tL = t + FOLLOW_LOOKAHEAD_MS: window-follow target (or the cursor itself
 * within CLICK_CENTER_MS of a click) → viewport-margin clamp → critically-
 * damped spring. Click pre-arrival falls out automatically: centering starts
 * FOLLOW_LOOKAHEAD_MS before the real click, and its expiry hands off
 * snap-free because the window target holds the current center.
 */
export function computeFollowPath(
  samples: FollowInputSample[],
  w: number,
  h: number,
  follow: CursorFollow,
): FollowPath {
  const out: FollowPath = [];
  if (!samples || samples.length === 0 || w <= 0 || h <= 0) return out;

  const sorted = isSortedByT(samples)
    ? samples
    : [...samples].sort((a, b) => a.t - b.t);

  const strength = clamp01(follow?.strength ?? DEFAULT_CURSOR_FOLLOW.strength);
  // Spring stiffness (rad/s): stronger = tighter tracking, less lag.
  const omega = FOLLOW_OMEGA_MIN + strength * (FOLLOW_OMEGA_MAX - FOLLOW_OMEGA_MIN);
  const dzPct = Math.max(
    0,
    follow?.deadzonePct ?? DEFAULT_CURSOR_FOLLOW.deadzonePct,
  );
  const dz = dzPct / 100 / 2; // half-width of the central deadzone, normalized

  const n = sorted.length;
  const lo = FOLLOW_TARGET_MARGIN;
  const hi = 1 - FOLLOW_TARGET_MARGIN;

  // Cursor position at lead time (linear interp between bracketing samples).
  // `j` only walks forward — lead times ascend with the sample index.
  let j = 0;
  const leadAt = (t: number): { x: number; y: number } => {
    while (j < n - 1 && sorted[j + 1].t <= t) j++;
    const a = sorted[j];
    const b = sorted[Math.min(j + 1, n - 1)];
    const span = b.t - a.t;
    const u = span <= 0 ? 0 : clamp01((t - a.t) / span);
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
  };
  // Click pointer, also forward-only: lastClickT = latest "down" at/before tL.
  let k = 0;
  let lastClickT = -Infinity;

  let cx = clampN(clamp01(sorted[0].x / w), lo, hi);
  let cy = clampN(clamp01(sorted[0].y / h), lo, hi);
  let vx = 0;
  let vy = 0;
  let prevT = sorted[0].t;
  out.push({ t: prevT, cx, cy });

  for (let i = 1; i < n; i++) {
    const s = sorted[i];
    const tL = s.t + FOLLOW_LOOKAHEAD_MS;
    while (k < n && sorted[k].t <= tL) {
      if (sorted[k].btn === "down") lastClickT = sorted[k].t;
      k++;
    }
    const lead = leadAt(tL);
    const nx = clamp01(lead.x / w);
    const ny = clamp01(lead.y / h);
    const centering = tL - lastClickT <= CLICK_CENTER_MS;
    const tx = clampN(centering ? nx : followTarget(cx, nx, dz), lo, hi);
    const ty = clampN(centering ? ny : followTarget(cy, ny, dz), lo, hi);

    // Critically-damped spring (zeta = 1) integrated to the target — buttery,
    // natural glide with NO overshoot. Substep so large frame gaps stay stable.
    const dt = Math.max(0.001, (s.t - prevT) / 1000); // seconds
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const hStep = dt / steps;
    for (let m = 0; m < steps; m++) {
      const ax = omega * omega * (tx - cx) - 2 * omega * vx;
      const ay = omega * omega * (ty - cy) - 2 * omega * vy;
      vx += ax * hStep;
      vy += ay * hStep;
      cx += vx * hStep;
      cy += vy * hStep;
    }

    cx = clamp01(cx);
    cy = clamp01(cy);
    prevT = s.t;
    out.push({ t: s.t, cx, cy });
  }

  return out;
}

/** Sample the follow center at source time `tMs` (linear interp, clamped ends). */
export function sampleFollowAt(
  path: FollowPath,
  tMs: number,
): { cx: number; cy: number } {
  if (!path || path.length === 0) return { cx: 0.5, cy: 0.5 };
  const first = path[0];
  if (tMs <= first.t) return { cx: first.cx, cy: first.cy };
  const last = path[path.length - 1];
  if (tMs >= last.t) return { cx: last.cx, cy: last.cy };

  let lo = 0;
  let hi = path.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (path[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  const span = b.t - a.t;
  const u = span <= 0 ? 0 : (tMs - a.t) / span;
  return { cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u) };
}

