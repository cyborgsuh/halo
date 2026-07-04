// export.ts
//
// EXPORT PIPELINE — drives the renderer frame-by-frame at the target fps over the
// trimmed range, decodes the source via WebCodecs `VideoDecoder` (frame-accurate),
// re-encodes the composited frames via WebCodecs `VideoEncoder` (H.264, Annex-B
// elementary stream), then asks the Rust `mux` command to combine that with the
// captured mic audio into an MP4. A GIF path renders the same frames into a
// temp MP4 and calls `make_gif`.
//
//   editor preview ── same renderer ──▶ this module (frame-stepped) ──▶ VideoEncoder
//                                                                        │ Annex-B H264
//                                                  save_blob ◀───────────┘
//                                                     │
//                                              mux / make_gif (ffmpeg sidecar) ─▶ out
//
// WYSIWYG by construction: the bytes written are the exact frames the editor drew.
//
// Imports:
//   - types from "./timeline"   (Project, ZoomKeyframe-bearing document)
//   - the renderer API from "./renderer"
//   - Tauri IPC: save_blob / mux / make_gif

import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./timeline";
import { createRenderer, type Renderer, type SourceFrame } from "./renderer";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse phase the exporter is currently in. */
export type ExportPhase =
  | "prepare" // setting up decoder/encoder/renderer
  | "render" // frame-stepping + encoding
  | "flush" // draining the encoder
  | "mux" // ffmpeg muxing audio + video
  | "gif" // ffmpeg palettegen/paletteuse
  | "done";

export interface ExportProgress {
  phase: ExportPhase;
  /** Frames composited+encoded so far. */
  frame: number;
  /** Total frames to render across the trimmed range. */
  totalFrames: number;
  /** 0..1 overall completion (best-effort across phases). */
  ratio: number;
  /** Encode throughput in frames/sec (render phase only). */
  fps?: number;
  message?: string;
}

export type ProgressCallback = (p: ExportProgress) => void;

/**
 * Demuxer the decoder path needs: turn the raw source-container bytes (the
 * screen.mp4 file) into a configured H.264 track + decode-ordered chunks.
 *
 * INTEGRATION SEAM: WebView2 has no built-in MP4 demuxer, so the caller injects
 * one (e.g. an mp4box.js-backed adapter). When no demuxer is supplied, export
 * falls back to a frame-stepped <video> element (works today, less exact on
 * fractional-fps sources). Keep frame-accurate decode by wiring a real demuxer.
 */
export interface DemuxedTrack {
  config: VideoDecoderConfig;
  /** Encoded video chunks in DECODE order. */
  chunks: EncodedVideoChunk[];
}

export interface Demuxer {
  demux(data: Uint8Array): Promise<DemuxedTrack>;
}

/** The screen recording to decode + composite. */
export interface ExportSource {
  /** Raw bytes of the source container (screen.mp4). */
  blob: Blob;
  /**
   * Optional MP4 demuxer → enables the frame-accurate WebCodecs `VideoDecoder`
   * path. Without it, a <video>-element fallback is used.
   */
  demuxer?: Demuxer;
}

/** Optional webcam source for the bubble (decoded via a <video> element). */
export interface ExportCamera {
  blob: Blob;
}

interface ExportCommon {
  /** The editable document (trim, zoom, background, camera, export settings). */
  project: Project;
  /** The screen recording to render. */
  source: ExportSource;
  /** Absolute output file path (the Rust side writes here). */
  outPath: string;
  /** Optional webcam bubble source. */
  camera?: ExportCamera | null;
  /** Cancel mid-export. */
  signal?: AbortSignal;
  /** Progress notifications. */
  onProgress?: ProgressCallback;
  /**
   * Override output dimensions/fps. Defaults to `project.export`. (GIF typically
   * downscales width via `make_gif`, not here.)
   */
  width?: number;
  height?: number;
  fps?: number;
}

export interface ExportVideoOptions extends ExportCommon {
  /**
   * Absolute path to the mic audio file (mic.webm) to mux in. Omit/null to mux
   * video only.
   */
  audioPath?: string | null;
  /** Override H.264 bitrate (Mbps). Defaults to `project.export.bitrateMbps`. */
  bitrateMbps?: number;
}

export interface ExportGifOptions extends ExportCommon {
  /** GIF output width (px); height auto-scaled by ffmpeg. Default 640. */
  gifWidth?: number;
  /** GIF frame rate. Defaults to min(15, project export fps). */
  gifFps?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_S = 1000;
const US_PER_S = 1_000_000;

class AbortError extends Error {
  constructor() {
    super("Export aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

function delay(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Replace the file extension of an absolute path. */
function withExt(path: string, ext: string): string {
  const i = path.lastIndexOf(".");
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = i > sep ? path.slice(0, i) : path;
  return `${base}.${ext.replace(/^\./, "")}`;
}

function concatChunks(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Pick an H.264 codec string (profile/level) for the target resolution. */
function pickH264Codec(width: number, height: number): string {
  const px = width * height;
  // High profile (64), level by pixel budget: 3.1 / 4.0 / 5.1 / 5.2
  if (px <= 1280 * 720) return "avc1.64001f"; // 3.1
  if (px <= 1920 * 1080) return "avc1.640028"; // 4.0
  if (px <= 2560 * 1440) return "avc1.640033"; // 5.1
  return "avc1.640034"; // 5.2 (4K)
}

// WebCodecs' VideoEncoderConfig type doesn't always declare the H.264 `avc`
// bitstream-format knob; we need Annex-B so ffmpeg can read the raw elementary
// stream with `-f h264`.
type AvcEncoderConfig = VideoEncoderConfig & {
  avc?: { format?: "annexb" | "avc" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Source frame readers (decode → CanvasImageSource at a given time)
// ─────────────────────────────────────────────────────────────────────────────

interface SourceFrameReader {
  /** Returns the decoded frame nearest to (and not after) `tMs`. */
  frameAt(tMs: number): Promise<SourceFrame>;
  close(): void;
}

/**
 * Frame-accurate reader using WebCodecs `VideoDecoder` fed by an injected demuxer.
 * Export steps time monotonically forward, so we decode lazily in presentation
 * order and keep a small window of decoded frames.
 */
class DecoderFrameReader implements SourceFrameReader {
  private frames: VideoFrame[] = [];
  private fed = 0;
  private flushed = false;
  private lastReturned: VideoFrame | null = null;
  private decodeError: Error | null = null;

  private constructor(
    private readonly decoder: VideoDecoder,
    private readonly chunks: EncodedVideoChunk[],
  ) {}

  static async create(demuxer: Demuxer, data: Uint8Array): Promise<DecoderFrameReader> {
    const track = await demuxer.demux(data);
    let self!: DecoderFrameReader;
    const decoder = new VideoDecoder({
      output: (frame) => self.onFrame(frame),
      error: (e) => {
        // Record so frameAt throws instead of hanging forever.
        self.decodeError = e instanceof Error ? e : new Error(String(e));
        console.error("VideoDecoder error:", self.decodeError.message);
      },
    });
    // optimizeForLatency → emit frames ASAP; prefer-software → WebView2's hardware
    // H.264 decoder can silently stall on these streams (no output, no error).
    const cfg: VideoDecoderConfig = {
      ...track.config,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-software",
    };
    decoder.configure(cfg);
    self = new DecoderFrameReader(decoder, track.chunks);
    return self;
  }

  private onFrame(frame: VideoFrame): void {
    this.frames.push(frame);
  }

  private feed(n: number): void {
    for (let k = 0; k < n && this.fed < this.chunks.length; k++) {
      this.decoder.decode(this.chunks[this.fed++]);
    }
  }

  async frameAt(tMs: number): Promise<SourceFrame> {
    // Release the previously handed-out frame (caller is done drawing it).
    if (this.lastReturned) {
      this.lastReturned.close();
      this.lastReturned = null;
    }
    const targetUs = Math.round(tMs * MS_PER_S);

    // Decode forward until we have a frame strictly AFTER the target (so the best
    // <= target frame is known to be final), or the stream is exhausted. Poll-based:
    // keep the decode queue topped up and yield so output callbacks fire — never
    // await a single wake that might not come (which deadlocked before).
    while (!this.frames.some((f) => f.timestamp > targetUs)) {
      if (this.decodeError) throw this.decodeError;
      if (this.fed >= this.chunks.length) {
        if (!this.flushed) {
          await this.decoder.flush();
          this.flushed = true;
        }
        break; // stream exhausted + flushed → no later frame exists
      }
      if (this.decoder.decodeQueueSize < 24) {
        this.feed(24 - this.decoder.decodeQueueSize);
      }
      await delay(0); // let the decoder emit before we re-check
    }

    this.frames.sort((a, b) => a.timestamp - b.timestamp);
    let chosenIdx = -1;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].timestamp <= targetUs) chosenIdx = i;
      else break;
    }
    if (chosenIdx < 0) chosenIdx = 0; // before first frame → use the first

    // Close everything strictly before the chosen frame; keep the rest buffered.
    for (let i = 0; i < chosenIdx; i++) this.frames[i].close();
    const chosen = this.frames[chosenIdx];
    this.frames = this.frames.slice(chosenIdx + 1);
    this.lastReturned = chosen;
    return chosen as unknown as SourceFrame;
  }

  close(): void {
    if (this.lastReturned) {
      this.lastReturned.close();
      this.lastReturned = null;
    }
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

/**
 * Fallback reader: seek an <video> element. Works without a demuxer but
 * `currentTime` seeking isn't guaranteed frame-exact. Also used for the webcam.
 */
class VideoElementFrameReader implements SourceFrameReader {
  private readonly url: string;
  private readonly video: HTMLVideoElement;
  private ready: Promise<void>;

  constructor(blob: Blob) {
    this.url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = this.url;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    this.video = v;
    this.ready = new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error("export: failed to load source video"));
      // Don't let a never-firing load wedge the whole export.
      setTimeout(res, 4000);
    });
  }

  async frameAt(tMs: number): Promise<SourceFrame> {
    await this.ready;
    const v = this.video;
    const t = Math.min(Math.max(0, tMs / MS_PER_S), Math.max(0, v.duration || 0));
    // Only re-seek when >33ms stale — for a small webcam bubble that's ~30fps,
    // visually identical but ~3x fewer (slow) seeks than chasing every frame.
    if (Math.abs(v.currentTime - t) > 0.033) {
      await new Promise<void>((res) => {
        v.onseeked = () => res();
        v.currentTime = t;
      });
    }
    // The 'seeked' event already makes the frame drawable. We deliberately do NOT
    // wait on requestVideoFrameCallback — it never fires for a detached, paused
    // <video>, so it added a per-frame timeout that made export crawl.
    return v as SourceFrame;
  }

  close(): void {
    this.video.removeAttribute("src");
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(this.url);
  }
}

async function makeSourceReader(source: ExportSource): Promise<SourceFrameReader> {
  if (source.demuxer) {
    const data = new Uint8Array(await source.blob.arrayBuffer());
    return DecoderFrameReader.create(source.demuxer, data);
  }
  // Frame-accurate decode requires a demuxer; without one we degrade gracefully.
  console.warn(
    "export: no demuxer supplied — falling back to <video> seeking (not guaranteed frame-exact). " +
      "Wire an mp4box.js demuxer via ExportSource.demuxer for frame-accurate WebCodecs decode.",
  );
  return new VideoElementFrameReader(source.blob);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: render + encode the trimmed range into a raw Annex-B H.264 stream.
// ─────────────────────────────────────────────────────────────────────────────

interface EncodeResult {
  /** Concatenated Annex-B H.264 elementary stream. */
  bytes: Uint8Array;
  frames: number;
  width: number;
  height: number;
  fps: number;
}

interface EncodeParams {
  project: Project;
  source: ExportSource;
  camera?: ExportCamera | null;
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Allotted progress band for this phase, e.g. mp4 export reserves tail for mux. */
  progressMax?: number;
}

async function configureEncoder(config: AvcEncoderConfig): Promise<void> {
  // Prefer hardware; gracefully relax if the exact config isn't supported.
  const tryConfigs: AvcEncoderConfig[] = [
    config,
    { ...config, hardwareAcceleration: "no-preference" },
    { ...config, codec: "avc1.42001f", hardwareAcceleration: "no-preference" }, // baseline 3.1
  ];
  for (const c of tryConfigs) {
    try {
      const support = await VideoEncoder.isConfigSupported(c as VideoEncoderConfig);
      if (support.supported) {
        encoderRef.configure(c as VideoEncoderConfig);
        return;
      }
    } catch {
      /* try next */
    }
  }
  // Last resort: configure with the original and let it throw if truly unusable.
  encoderRef.configure(config as VideoEncoderConfig);
}

// `configureEncoder` needs the encoder instance; thread it via a module-local ref
// set immediately before the call (keeps the helper readable without a class).
let encoderRef!: VideoEncoder;

async function encodeRange(params: EncodeParams): Promise<EncodeResult> {
  const { project, width, height, fps, bitrateMbps, signal, onProgress } = params;
  const progressMax = params.progressMax ?? 1;

  const startMs = project.trim.startMs;
  const endMs = Math.max(startMs, project.trim.endMs);
  const totalFrames = Math.max(1, Math.round(((endMs - startMs) / MS_PER_S) * fps));
  const frameDurUs = Math.round(US_PER_S / fps);
  const keyInterval = Math.max(1, Math.round(fps)); // ~1s GOP → mux/seek friendly

  onProgress?.({
    phase: "prepare",
    frame: 0,
    totalFrames,
    ratio: 0,
    message: "Initializing decoder, encoder and renderer",
  });

  const reader = await makeSourceReader(params.source);
  const camReader = params.camera ? new VideoElementFrameReader(params.camera.blob) : null;
  const renderer: Renderer = await createRenderer({
    project,
    width,
    height,
    offscreen: true,
  });

  const parts: Uint8Array[] = [];
  let total = 0;
  let encodeError: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      parts.push(buf);
      total += buf.byteLength;
    },
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoderRef = encoder;

  const config: AvcEncoderConfig = {
    codec: pickH264Codec(width, height),
    width,
    height,
    bitrate: Math.max(1, Math.round(bitrateMbps)) * 1_000_000,
    framerate: fps,
    latencyMode: "quality",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "annexb" },
  };
  await configureEncoder(config);

  const t0 = performance.now();
  try {
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal);
      if (encodeError) throw encodeError;

      const sourceTimeMs = startMs + (i / fps) * MS_PER_S;
      const frame = await reader.frameAt(sourceTimeMs);
      const cam = camReader ? await camReader.frameAt(sourceTimeMs) : null;

      await renderer.renderFrame({ tMs: sourceTimeMs, source: frame, camera: cam });

      const outFrame = new VideoFrame(renderer.canvas, {
        timestamp: i * frameDurUs,
        duration: frameDurUs,
      });
      encoder.encode(outFrame, { keyFrame: i % keyInterval === 0 });
      outFrame.close();

      // Backpressure: don't let the encode queue run away.
      while (encoder.encodeQueueSize > 8) {
        throwIfAborted(signal);
        await delay(0);
      }

      const done = i + 1;
      const elapsed = (performance.now() - t0) / MS_PER_S;
      onProgress?.({
        phase: "render",
        frame: done,
        totalFrames,
        ratio: (done / totalFrames) * progressMax,
        fps: elapsed > 0 ? done / elapsed : undefined,
      });
    }

    onProgress?.({
      phase: "flush",
      frame: totalFrames,
      totalFrames,
      ratio: progressMax,
      message: "Finishing encode",
    });
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer.destroy();
    reader.close();
    camReader?.close();
  }

  return { bytes: concatChunks(parts, total), frames: totalFrames, width, height, fps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command wrappers
// ─────────────────────────────────────────────────────────────────────────────

/** Persist raw bytes to disk via the `save_blob` command (matches capture.ts). */
async function saveBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("save_blob", { path, bytes: Array.from(bytes) });
}

/**
 * Mux a video elementary stream + (optional) audio into a container via ffmpeg.
 * IPC: `mux({ video, audio, out, fps }) -> outPath`.
 * NOTE (seam): the Rust side reads `video` as a raw Annex-B H.264 stream
 * (ffmpeg `-f h264 -r <fps> -i video`) and copies it (`-c:v copy`) — no
 * re-transcode. If mux.rs expects a single `args` struct instead of flat
 * fields, change only this call.
 */
/**
 * Where the mic sits relative to the exported (trimmed) video, in ms.
 *   > 0 → mic started BEFORE the trim point → skip that much off its front.
 *   < 0 → mic started AFTER  the trim point → delay it by |value|.
 * (Export renders from trim.startMs; the mic webm begins at audio.offsetMs on the
 * source timeline. mux.rs turns this into ffmpeg `-ss` / `-itsoffset`.)
 */
export function audioMuxOffsetMs(trimStartMs: number, audioOffsetMs: number): number {
  return Math.round(trimStartMs - audioOffsetMs);
}

function muxCmd(
  video: string,
  audio: string | null,
  out: string,
  fps: number,
  audioOffsetMs = 0,
): Promise<string> {
  return invoke<string>("mux", { video, audio: audio ?? "", out, fps, audioOffsetMs });
}

/** GIF via ffmpeg palettegen/paletteuse. IPC: `make_gif(input,out,fps,width)`. */
function makeGifCmd(input: string, out: string, fps: number, width: number): Promise<string> {
  return invoke<string>("make_gif", { input, out, fps, width });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Export the project to MP4: frame-step the renderer over the trimmed range,
 * encode to H.264 (Annex-B), write the raw stream, then mux with mic audio.
 * Resolves to the output path returned by the `mux` command.
 */
export async function exportVideo(opts: ExportVideoOptions): Promise<string> {
  const ex = opts.project.export;
  const width = opts.width ?? ex.w;
  const height = opts.height ?? ex.h;
  const fps = opts.fps ?? ex.fps;
  const bitrateMbps = opts.bitrateMbps ?? ex.bitrateMbps;

  // Reserve the final 8% of the progress bar for muxing.
  const RENDER_BAND = 0.92;

  const result = await encodeRange({
    project: opts.project,
    source: opts.source,
    camera: opts.camera,
    width,
    height,
    fps,
    bitrateMbps,
    signal: opts.signal,
    onProgress: opts.onProgress,
    progressMax: RENDER_BAND,
  });

  throwIfAborted(opts.signal);

  // Write the raw H.264 elementary stream next to the output, then mux.
  const rawPath = withExt(opts.outPath, "h264");
  opts.onProgress?.({
    phase: "mux",
    frame: result.frames,
    totalFrames: result.frames,
    ratio: RENDER_BAND,
    message: "Writing video stream + muxing audio",
  });
  await saveBytes(rawPath, result.bytes);

  const audioOffsetMs = audioMuxOffsetMs(
    opts.project.trim.startMs,
    opts.project.audio.offsetMs,
  );
  const outPath = await muxCmd(
    rawPath,
    opts.audioPath ?? null,
    opts.outPath,
    fps,
    audioOffsetMs,
  );

  opts.onProgress?.({
    phase: "done",
    frame: result.frames,
    totalFrames: result.frames,
    ratio: 1,
    message: "Export complete",
  });
  return outPath;
}

/**
 * Export the project to GIF: render the same frames into a temp MP4 (video only),
 * then run ffmpeg palettegen/paletteuse via `make_gif`. Resolves to the GIF path.
 */
export async function exportGif(opts: ExportGifOptions): Promise<string> {
  const ex = opts.project.export;
  const width = opts.width ?? ex.w;
  const height = opts.height ?? ex.h;
  const renderFps = opts.fps ?? ex.fps;
  const gifFps = opts.gifFps ?? Math.min(15, renderFps);
  const gifWidth = opts.gifWidth ?? 640;

  const RENDER_BAND = 0.85;

  // Render at the GIF frame-rate to avoid wasting frames ffmpeg would drop.
  const result = await encodeRange({
    project: opts.project,
    source: opts.source,
    camera: opts.camera,
    width,
    height,
    fps: gifFps,
    bitrateMbps: Math.max(8, ex.bitrateMbps), // keep palette source clean
    signal: opts.signal,
    onProgress: opts.onProgress,
    progressMax: RENDER_BAND,
  });

  throwIfAborted(opts.signal);

  const rawPath = withExt(opts.outPath, "h264");
  const tmpMp4 = withExt(opts.outPath, "tmp.mp4");

  opts.onProgress?.({
    phase: "gif",
    frame: result.frames,
    totalFrames: result.frames,
    ratio: RENDER_BAND,
    message: "Building GIF palette",
  });

  await saveBytes(rawPath, result.bytes);
  // Mux the raw stream into a temp MP4 (no audio) for make_gif to read.
  await muxCmd(rawPath, null, tmpMp4, gifFps);
  const outPath = await makeGifCmd(tmpMp4, opts.outPath, gifFps, gifWidth);

  opts.onProgress?.({
    phase: "done",
    frame: result.frames,
    totalFrames: result.frames,
    ratio: 1,
    message: "GIF export complete",
  });
  return outPath;
}

/** Dispatch on `project.export.format`. */
export function exportProject(
  opts: ExportVideoOptions & ExportGifOptions,
): Promise<string> {
  return opts.project.export.format === "gif" ? exportGif(opts) : exportVideo(opts);
}

export { AbortError };
