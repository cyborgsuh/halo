// renderer.ts
//
// The PixiJS (v8) WebGL compositor. ONE renderer drives BOTH the editor preview
// (rAF loop, on-screen canvas) AND the export (frame-stepped, offscreen canvas →
// WebCodecs VideoEncoder). Export is WYSIWYG by construction: same passes, same
// math, just a different render target and a frame-stepped clock.
//
// Compositing passes, back to front (per the plan):
//   1. Background — solid / gradient / image, with padding, rounded corners and a
//      soft drop shadow around the framed screen.
//   2. Screen    — the source video frame, transformed by the zoom/pan sampled
//      from sampleZoomAt(tMs), clipped to the rounded frame.
//   3. Cursor    — optional smoothed cursor sprite + click-ripple FX.
//   4. Camera    — the webcam bubble, circle/rounded/square masked & anchored.
//
// The public API is the stable seam `export.ts` (and the editor) depend on:
//   createRenderer(init) -> Promise<Renderer>
//   Renderer.renderFrame(input)   // composite one frame at absolute source time
//   Renderer.canvas               // surface export grabs as a VideoFrame
//   Renderer.setProject / resize / destroy
//   Renderer.setCursor / setCursorVisible   // additive — cursor layer (editor)
//
// Project / keyframe types come from "./timeline" (NOT redefined here).

import {
  autoDetectRenderer,
  BlurFilter,
  CanvasSource,
  Container,
  FillGradient,
  Graphics,
  Matrix,
  Sprite,
  Texture,
  VideoSource,
  type ColorSource,
  type ICanvas,
  type Renderer as PixiRenderer,
} from "pixi.js";

import type { Background, Camera, Project, FollowPath } from "./timeline";
import { sampleZoomAt, computeFollowPath, sampleFollowAt } from "./timeline";

// ─────────────────────────────────────────────────────────────────────────────
// Public API (stable seam — keep compatible with export.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** A drawable source frame: a decoded VideoFrame (export) or a <video> (preview). */
export type SourceFrame = CanvasImageSource;

/** A single timestamped cursor sample (matches a `cursor.jsonl` row). */
export interface CursorSample {
  /** ms since record start (absolute source time). */
  t: number;
  /** Source-space pixel X. */
  x: number;
  /** Source-space pixel Y. */
  y: number;
  /** Mouse-button transition at this sample, if any. */
  btn: "down" | "up" | null;
}

export interface RendererInit {
  /** The editable document (background, zoom keyframes, camera, …). */
  project: Project;
  /** Output width in px (typically project.export.w). */
  width: number;
  /** Output height in px (typically project.export.h). */
  height: number;
  /**
   * Render target. Omit / pass an OffscreenCanvas for export; pass an on-screen
   * HTMLCanvasElement for the editor preview. If omitted, one is created
   * (OffscreenCanvas when `offscreen` is true, else an HTMLCanvasElement).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Create an OffscreenCanvas when no `canvas` is supplied (export path). */
  offscreen?: boolean;
  /** Antialias the GPU output. Default: true for preview, false for offscreen export. */
  antialias?: boolean;
  /** Optional cursor path for the smoothed cursor + ripple layer. */
  cursor?: CursorSample[];
}

export interface RenderInput {
  /**
   * Absolute time on the SOURCE timeline, in ms. Zoom keyframes are stored in
   * absolute source time, so pass the source time (not the trimmed/output time).
   */
  tMs: number;
  /** Decoded screen frame to composite. */
  source: SourceFrame;
  /** Optional decoded webcam frame for the bubble. */
  camera?: SourceFrame | null;
}

export interface Renderer {
  /** The surface the frame was composited onto (export grabs this as a VideoFrame). */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** Composite exactly one frame for `input.tMs`. Synchronous (returns void). */
  renderFrame(input: RenderInput): void;
  /** Swap in an edited project (background/zoom/cam tweaks) without recreating. */
  setProject(project: Project): void;
  /** Resize the output surface. */
  resize(width: number, height: number): void;
  /** Provide the cursor path; computes the EMA-smoothed trajectory once. */
  setCursor(samples: CursorSample[], smoothing?: number): void;
  /** Toggle the cursor layer without discarding the loaded path. */
  setCursorVisible(visible: boolean): void;
  /** Release GPU/canvas resources. */
  destroy(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunables (cursor / ripple FX)
// ─────────────────────────────────────────────────────────────────────────────

/** Lifetime of a click ripple, ms. */
const RIPPLE_MS = 600;
/** Ripple start / end radius in output px (scaled for 1080p, then by output size). */
const RIPPLE_R0 = 6;
const RIPPLE_R1 = 42;
/** On-screen cursor sprite height in output px (tip-anchored), scaled for 1080p. */
const CURSOR_PX = 22;
/**
 * Cursor smoothing spring stiffness (rad/s). `cursorSmoothing` 0..1 maps between
 * MAX (barely smoothed, tight) and MIN (very buttery). Critically damped → no
 * overshoot. Lower MIN = silkier motion.
 */
const CURSOR_OMEGA_MIN = 9;
const CURSOR_OMEGA_MAX = 45;

/**
 * Zoom scale at which the follow-pan reaches full strength. The focal point is
 * blended from frame-center (scale 1) toward the follow center over (1, 1+this],
 * so the pan eases in as the zoom ramps up instead of jerking on at scale 1.
 */
const FOLLOW_BLEND_RANGE = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isVideoElement(s: SourceFrame): s is HTMLVideoElement {
  return typeof HTMLVideoElement !== "undefined" && s instanceof HTMLVideoElement;
}

/** Intrinsic size of any CanvasImageSource (VideoFrame / <video> / canvas / bitmap). */
function sourceSize(s: SourceFrame): { w: number; h: number } {
  const a = s as {
    displayWidth?: number;
    displayHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    codedWidth?: number;
    codedHeight?: number;
    width?: number;
    height?: number;
  };
  const w = a.displayWidth ?? a.videoWidth ?? a.codedWidth ?? a.width ?? 0;
  const h = a.displayHeight ?? a.videoHeight ?? a.codedHeight ?? a.height ?? 0;
  return { w, h };
}

/** Load an image URL / path into a Pixi texture. Returns null on failure. */
async function loadImageTexture(url: string): Promise<Texture | null> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    return Texture.from(bitmap);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DynamicFrameTexture — a Pixi texture fed from a changing SourceFrame.
//   HTMLVideoElement → VideoSource (the GPU uploads the element directly).
//   anything else (VideoFrame / ImageBitmap / canvas) → blit into a scratch
//   2D canvas → CanvasSource. Rebuilds only when kind / identity / size changes.
// ─────────────────────────────────────────────────────────────────────────────

class DynamicFrameTexture {
  texture: Texture | null = null;

  private kind: "video" | "canvas" | null = null;
  private boundVideo: HTMLVideoElement | null = null;
  private videoSource: VideoSource | null = null;
  private canvasSource: CanvasSource | null = null;
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;

  /** Upload `frame` into the texture; returns its pixel dimensions. */
  update(frame: SourceFrame): { w: number; h: number } | null {
    if (isVideoElement(frame)) {
      if (frame.videoWidth === 0 || frame.videoHeight === 0) {
        return this.texture
          ? { w: this.texture.width, h: this.texture.height }
          : null;
      }
      if (this.kind !== "video" || this.boundVideo !== frame) {
        this.disposeSources();
        this.videoSource = new VideoSource({ resource: frame, updateFPS: 0 });
        this.texture = new Texture({ source: this.videoSource });
        this.boundVideo = frame;
        this.kind = "video";
      } else {
        this.videoSource!.update();
      }
      return { w: frame.videoWidth, h: frame.videoHeight };
    }

    const { w, h } = sourceSize(frame);
    if (w === 0 || h === 0) return null;

    this.ensureScratch(w, h);
    this.ctx!.drawImage(frame, 0, 0, w, h);

    if (this.kind !== "canvas") {
      this.disposeSources();
      this.canvasSource = new CanvasSource({ resource: this.scratch as ICanvas });
      this.texture = new Texture({ source: this.canvasSource });
      this.kind = "canvas";
    } else {
      this.canvasSource!.update();
    }
    return { w, h };
  }

  private ensureScratch(w: number, h: number): void {
    if (this.scratch && this.scratch.width === w && this.scratch.height === h) {
      return;
    }
    if (this.scratch) {
      this.scratch.width = w;
      this.scratch.height = h;
      this.canvasSource?.resize(w, h);
      return;
    }
    this.scratch =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
    this.ctx = (this.scratch as HTMLCanvasElement).getContext("2d", {
      alpha: false,
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  }

  private disposeSources(): void {
    this.texture?.destroy(false);
    this.videoSource?.destroy();
    this.canvasSource?.destroy();
    this.texture = null;
    this.videoSource = null;
    this.canvasSource = null;
    this.boundVideo = null;
  }

  destroy(): void {
    this.disposeSources();
    this.scratch = null;
    this.ctx = null;
    this.kind = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PixiRendererImpl — the compositor
// ─────────────────────────────────────────────────────────────────────────────

class PixiRendererImpl implements Renderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;

  private gpu: PixiRenderer;
  private stage = new Container();

  // Layers (stage order = composite order, back → front).
  private bgGraphics = new Graphics();
  private bgSprite = new Sprite();
  private shadowGraphics = new Graphics();
  private screenLayer = new Container();
  private screenMask = new Graphics();
  private screenSprite = new Sprite();
  private cursorSprite = new Sprite();
  private rippleGraphics = new Graphics();
  private camLayer = new Container();
  private camMask = new Graphics();
  private camSprite = new Sprite();

  private screenFrame = new DynamicFrameTexture();
  private cameraFrame = new DynamicFrameTexture();

  private project: Project;
  private content: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private lastMatrix = new Matrix();
  /** Token to invalidate stale async image-background loads. */
  private bgToken = 0;

  // Cursor state.
  private cursorEnabled = false;
  private cursorSamples: CursorSample[] = [];
  private smoothX: number[] = [];
  private smoothY: number[] = [];
  private clickIdx: number[] = [];
  /** Precomputed pan-follow trajectory (normalized centers), from setCursor. */
  private followPath: FollowPath = [];

  constructor(
    gpu: PixiRenderer,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    init: RendererInit
  ) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.width = init.width;
    this.height = init.height;
    this.project = init.project;

    this.screenSprite.anchor.set(0, 0);
    this.cursorSprite.anchor.set(0, 0); // tip at sprite origin
    this.camSprite.anchor.set(0.5, 0.5);

    this.screenLayer.addChild(
      this.screenMask,
      this.screenSprite,
      this.cursorSprite,
      this.rippleGraphics
    );
    this.screenLayer.mask = this.screenMask;

    this.camLayer.addChild(this.camMask, this.camSprite);
    this.camLayer.mask = this.camMask;

    this.bgSprite.visible = false;
    this.cursorSprite.visible = false;
    this.screenSprite.visible = false;

    this.stage.addChild(
      this.bgGraphics,
      this.bgSprite,
      this.shadowGraphics,
      this.screenLayer,
      this.camLayer
    );

    this.buildCursorTexture();
    this.applyGeometry(this.project);
    if (init.cursor) this.setCursor(init.cursor, this.project.cursorSmoothing);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setProject(project: Project): void {
    this.project = project;
    this.applyGeometry(project);
    // cursorFollow tuning may have changed → recompute the pan-follow path.
    this.rebuildFollowPath();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.gpu.resize(width, height);
    this.applyGeometry(this.project);
  }

  setCursor(samples: CursorSample[], smoothing = this.project.cursorSmoothing): void {
    this.cursorSamples = samples ?? [];
    this.cursorEnabled = this.cursorSamples.length > 0;

    const n = this.cursorSamples.length;
    this.smoothX = new Array(n);
    this.smoothY = new Array(n);
    this.clickIdx = [];

    // Critically-damped spring smoothing of the cursor path (Cursorful-style
    // glide). `smoothing` 0..1 maps to spring stiffness: higher smoothing = lower
    // omega = softer, more buttery motion. Closed-form-stable via substeps; no
    // overshoot, so the cursor never whips past the real path.
    const sm = clamp(smoothing ?? 0.6, 0, 1);
    const omega = CURSOR_OMEGA_MIN + (1 - sm) * (CURSOR_OMEGA_MAX - CURSOR_OMEGA_MIN);

    if (n > 0) {
      let px = this.cursorSamples[0].x;
      let py = this.cursorSamples[0].y;
      let vx = 0;
      let vy = 0;
      let prevT = this.cursorSamples[0].t;
      this.smoothX[0] = px;
      this.smoothY[0] = py;
      if (this.cursorSamples[0].btn === "down") this.clickIdx.push(0);

      for (let i = 1; i < n; i++) {
        const s = this.cursorSamples[i];
        const dt = Math.max(0.001, (s.t - prevT) / 1000);
        const steps = Math.max(1, Math.ceil(dt / 0.008));
        const hStep = dt / steps;
        for (let k = 0; k < steps; k++) {
          const ax = omega * omega * (s.x - px) - 2 * omega * vx;
          const ay = omega * omega * (s.y - py) - 2 * omega * vy;
          vx += ax * hStep;
          vy += ay * hStep;
          px += vx * hStep;
          py += vy * hStep;
        }
        this.smoothX[i] = px;
        this.smoothY[i] = py;
        if (s.btn === "down") this.clickIdx.push(i);
        prevT = s.t;
      }
    }

    // Decoupled pan-follow path (heavier smoothing + deadzone than the sprite).
    this.rebuildFollowPath();
  }

  /** Recompute the normalized pan-follow trajectory from the loaded samples. */
  private rebuildFollowPath(): void {
    if (this.cursorSamples.length === 0) {
      this.followPath = [];
      return;
    }
    this.followPath = computeFollowPath(
      this.cursorSamples,
      this.project.source.w,
      this.project.source.h,
      this.project.cursorFollow,
    );
  }

  setCursorVisible(visible: boolean): void {
    this.cursorEnabled = visible && this.cursorSamples.length > 0;
  }

  renderFrame(input: RenderInput): void {
    const project = this.project;

    // Pass 2: screen video + zoom/pan transform.
    const dims = this.screenFrame.update(input.source);
    if (
      this.screenFrame.texture &&
      this.screenSprite.texture !== this.screenFrame.texture
    ) {
      this.screenSprite.texture = this.screenFrame.texture;
    }
    if (dims) {
      this.screenSprite.visible = true;
      this.applyScreenTransform(project, input.tMs, dims);
    }

    // Pass 3: cursor sprite + click ripple.
    this.updateCursor(input.tMs);

    // Pass 4: camera bubble.
    if (project.camera && input.camera) {
      const cdims = this.cameraFrame.update(input.camera);
      if (
        this.cameraFrame.texture &&
        this.camSprite.texture !== this.cameraFrame.texture
      ) {
        this.camSprite.texture = this.cameraFrame.texture;
      }
      if (cdims) this.layoutCameraSprite(project.camera, cdims);
    }

    this.gpu.render({ container: this.stage });
  }

  destroy(): void {
    this.screenFrame.destroy();
    this.cameraFrame.destroy();
    this.cursorSprite.texture?.destroy(true);
    this.stage.destroy({ children: true });
    this.gpu.destroy();
  }

  // ── Internal: geometry / layout ───────────────────────────────────────────

  /** Recompute content rect, masks, shadow, background and camera placement (sync). */
  private applyGeometry(project: Project): void {
    const W = this.width;
    const H = this.height;
    const bg = project.background;

    const pad = (bg.paddingPct / 100) * Math.min(W, H);
    this.content = {
      x: pad,
      y: pad,
      w: Math.max(1, W - 2 * pad),
      h: Math.max(1, H - 2 * pad),
    };
    const c = this.content;
    const radius = Math.max(0, bg.radiusPx);

    this.drawBackground(bg, W, H);

    // Rounded-frame clip mask for the screen layer.
    this.screenMask.clear();
    this.screenMask.roundRect(c.x, c.y, c.w, c.h, radius).fill(0xffffff);

    // Soft drop shadow behind the framed screen.
    this.shadowGraphics.clear();
    this.shadowGraphics.filters = [];
    if (bg.shadow > 0) {
      const spread = Math.min(W, H) * 0.012;
      this.shadowGraphics
        .roundRect(
          c.x - spread,
          c.y - spread,
          c.w + spread * 2,
          c.h + spread * 2,
          radius + spread
        )
        .fill({ color: 0x000000, alpha: clamp(bg.shadow, 0, 1) });
      this.shadowGraphics.filters = [
        new BlurFilter({ strength: Math.max(6, Math.min(W, H) * 0.025) }),
      ];
      this.shadowGraphics.y = Math.min(W, H) * 0.01;
      this.shadowGraphics.visible = true;
    } else {
      this.shadowGraphics.visible = false;
    }

    this.layoutCamera(project.camera);
  }

  private drawBackground(bg: Background, W: number, H: number): void {
    this.bgGraphics.clear();
    this.bgSprite.visible = false;
    this.bgToken++;

    if (bg.type === "image") {
      // Fallback fill until the image resolves (and if it fails).
      this.bgGraphics.rect(0, 0, W, H).fill(0x0f172a);
      const url = Array.isArray(bg.value) ? bg.value[0] : bg.value;
      const token = this.bgToken;
      void loadImageTexture(url).then((texture) => {
        if (!texture || token !== this.bgToken) return; // superseded
        this.bgSprite.texture = texture;
        const scale = Math.max(W / texture.width, H / texture.height);
        this.bgSprite.anchor.set(0.5);
        this.bgSprite.scale.set(scale);
        this.bgSprite.position.set(W / 2, H / 2);
        this.bgSprite.visible = true;
      });
      return;
    }

    if (bg.type === "gradient") {
      const stops = Array.isArray(bg.value) ? bg.value : [bg.value, bg.value];
      const gradient = new FillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        textureSpace: "local",
        colorStops: stops.map((color, i) => ({
          offset: stops.length <= 1 ? i : i / (stops.length - 1),
          color: color as ColorSource,
        })),
      });
      this.bgGraphics.rect(0, 0, W, H).fill(gradient);
      return;
    }

    // solid
    const color = (Array.isArray(bg.value) ? bg.value[0] : bg.value) as ColorSource;
    this.bgGraphics.rect(0, 0, W, H).fill(color);
  }

  /** Camera mask + layer placement (frame-independent). */
  private layoutCamera(cam: Camera | undefined): void {
    if (!cam) {
      this.camLayer.visible = false;
      return;
    }
    this.camLayer.visible = true;

    const W = this.width;
    const H = this.height;
    const d = (cam.sizePct / 100) * W;
    const margin = Math.min(W, H) * 0.03;
    let cx: number;
    let cy: number;
    switch (cam.pos) {
      case "bl":
        cx = margin + d / 2;
        cy = H - margin - d / 2;
        break;
      case "tr":
        cx = W - margin - d / 2;
        cy = margin + d / 2;
        break;
      case "tl":
        cx = margin + d / 2;
        cy = margin + d / 2;
        break;
      case "br":
      default:
        cx = W - margin - d / 2;
        cy = H - margin - d / 2;
        break;
    }

    this.camMask.clear();
    if (cam.shape === "circle") {
      this.camMask.circle(cx, cy, d / 2).fill(0xffffff);
    } else if (cam.shape === "square") {
      this.camMask.rect(cx - d / 2, cy - d / 2, d, d).fill(0xffffff);
    } else {
      this.camMask.roundRect(cx - d / 2, cy - d / 2, d, d, d * 0.18).fill(0xffffff);
    }
    this.camSprite.position.set(cx, cy);
  }

  /** Per-frame: cover-fit the camera sprite into its bubble. */
  private layoutCameraSprite(cam: Camera, dims: { w: number; h: number }): void {
    const d = (cam.sizePct / 100) * this.width;
    const scale = Math.max(d / dims.w, d / dims.h);
    this.camSprite.scale.set(scale);
  }

  // ── Internal: per-frame screen transform & cursor ─────────────────────────

  /** Build + apply the zoom/pan matrix for the current frame. */
  private applyScreenTransform(
    project: Project,
    tMs: number,
    dims: { w: number; h: number }
  ): void {
    const z = sampleZoomAt(project.zoom, tMs, project.zoomDurationMs);
    const c = this.content;
    const sw = dims.w;
    const sh = dims.h;
    const scale = Math.max(1, z.scale);

    // Contain the source within the framed content area, then magnify by zoom.
    const s0 = Math.min(c.w / sw, c.h / sh);
    const s = s0 * scale;

    // Focal point: SCALE comes from the keyframes, PAN follows the cursor.
    // When a follow path is loaded and we are zoomed in, track the precomputed
    // follow center; blend from frame-centre toward it as the zoom ramps up so
    // the pan eases in. With no follow path, fall back to the keyframe centre
    // (preserves hand-authored cx/cy).
    let fcx: number;
    let fcy: number;
    if (scale > 1 && this.followPath.length > 0) {
      const f = sampleFollowAt(this.followPath, tMs);
      const w = clamp((scale - 1) / FOLLOW_BLEND_RANGE, 0, 1);
      fcx = 0.5 + (f.cx - 0.5) * w;
      fcy = 0.5 + (f.cy - 0.5) * w;
    } else {
      fcx = z.cx;
      fcy = z.cy;
    }

    // Edge-guard: keep the magnified viewport inside the source frame.
    const halfVW = c.w / s / sw / 2;
    const halfVH = c.h / s / sh / 2;
    const cx = halfVW >= 0.5 ? 0.5 : clamp(fcx, halfVW, 1 - halfVW);
    const cy = halfVH >= 0.5 ? 0.5 : clamp(fcy, halfVH, 1 - halfVH);

    // Map the source focal point to the centre of the content area.
    const ccx = c.x + c.w / 2;
    const ccy = c.y + c.h / 2;
    const m = this.lastMatrix;
    m.set(s, 0, 0, s, ccx - s * cx * sw, ccy - s * cy * sh);
    this.screenSprite.setFromMatrix(m);
  }

  /** Draw the smoothed cursor + any active click ripple for time `tMs`. */
  private updateCursor(tMs: number): void {
    this.rippleGraphics.clear();
    if (!this.cursorEnabled || this.cursorSamples.length === 0) {
      this.cursorSprite.visible = false;
      return;
    }

    const idx = Math.min(
      lowerBound(this.cursorSamples, tMs),
      this.cursorSamples.length - 1
    );
    const m = this.lastMatrix;

    // Interpolate between the two bracketing samples by time so the sprite glides
    // continuously instead of stepping at the 8ms sample rate.
    let csx = this.smoothX[idx];
    let csy = this.smoothY[idx];
    if (idx > 0) {
      const a = this.cursorSamples[idx - 1];
      const b = this.cursorSamples[idx];
      const span = b.t - a.t;
      const u = span > 0 ? clamp((tMs - a.t) / span, 0, 1) : 0;
      csx = this.smoothX[idx - 1] + (this.smoothX[idx] - this.smoothX[idx - 1]) * u;
      csy = this.smoothY[idx - 1] + (this.smoothY[idx] - this.smoothY[idx - 1]) * u;
    }

    // Cursor position: source px → output px through the active zoom matrix.
    const px = m.a * csx + m.c * csy + m.tx;
    const py = m.b * csx + m.d * csy + m.ty;
    this.cursorSprite.visible = true;
    this.cursorSprite.position.set(px, py);

    // Click ripple: most recent "down" within RIPPLE_MS before tMs.
    const sizeScale = Math.min(this.width, this.height) / 1080;
    for (let k = this.clickIdx.length - 1; k >= 0; k--) {
      const ci = this.clickIdx[k];
      const dt = tMs - this.cursorSamples[ci].t;
      if (dt < 0) continue;
      if (dt > RIPPLE_MS) break;
      const p = dt / RIPPLE_MS;
      const r = (RIPPLE_R0 + (RIPPLE_R1 - RIPPLE_R0) * p) * sizeScale;
      const rx = m.a * this.smoothX[ci] + m.c * this.smoothY[ci] + m.tx;
      const ry = m.b * this.smoothX[ci] + m.d * this.smoothY[ci] + m.ty;
      this.rippleGraphics
        .circle(rx, ry, r)
        .stroke({ color: 0xffffff, width: 2.5 * sizeScale, alpha: (1 - p) * 0.8 });
      break;
    }
  }

  /** Generate a crisp, polished pointer-cursor sprite texture once. */
  private buildCursorTexture(): void {
    // A well-proportioned macOS/Windows-style arrow, tip at (0,0), with a soft
    // drop shadow so it reads on any background (premium, not the flat default).
    const arrow = [0, 0, 0, 16.5, 4, 12.7, 6.6, 18.7, 9.1, 17.6, 6.6, 11.8, 11.6, 11.8];
    const shadowOff = 1.1;
    const g = new Graphics();

    // Drop shadow (offset copy of the silhouette).
    const shadow = arrow.map((v, i) => v + (i % 2 === 0 ? shadowOff : shadowOff + 0.4));
    g.poly(shadow).fill({ color: 0x000000, alpha: 0.3 });

    // Main cursor: white fill, crisp dark edge.
    g.poly(arrow)
      .fill(0xffffff)
      .stroke({ color: 0x111111, width: 1.1, alpha: 0.95, alignment: 0.5 });

    const tex = this.gpu.generateTexture({ target: g, resolution: 3 });
    this.cursorSprite.texture = tex;
    this.cursorSprite.scale.set(CURSOR_PX / 20);
    g.destroy();
  }
}

/** Binary search: first index whose sample time is >= tMs. */
function lowerBound(samples: CursorSample[], tMs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].t < tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the PixiJS compositor. Async because WebGL renderer init is async.
 *
 * Preview: pass an on-screen `canvas`. Export: pass `offscreen:true` (an
 * OffscreenCanvas is created at width×height; grab `renderer.canvas` as a
 * `VideoFrame` after each `renderFrame`).
 */
export async function createRenderer(init: RendererInit): Promise<Renderer> {
  const offscreen = init.offscreen ?? !init.canvas;
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    init.canvas ??
    (offscreen && typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(init.width, init.height)
      : Object.assign(document.createElement("canvas"), {
          width: init.width,
          height: init.height,
        }));
  canvas.width = init.width;
  canvas.height = init.height;

  const gpu = await autoDetectRenderer({
    canvas: canvas as ICanvas,
    width: init.width,
    height: init.height,
    antialias: init.antialias ?? !offscreen,
    preference: "webgl",
    clearBeforeRender: true,
    backgroundAlpha: 1,
    // Required so we can read the GPU surface back into a VideoFrame on export.
    webgl: { preserveDrawingBuffer: true },
  });

  return new PixiRendererImpl(gpu, canvas, init);
}
