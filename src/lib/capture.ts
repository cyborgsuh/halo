// capture.ts
//
// Frontend (WebView) side of recording: microphone + webcam.
//
// The native Rust side captures the screen + cursor and owns the shared clock.
// `start_recording` returns { sessionId, startEpochMs }; we start a MediaRecorder
// for mic and one for cam, stamp each one's wall-clock start against startEpochMs
// to derive an `offsetMs` (used for A/V sync in the editor), and on stop we flush
// the blobs to disk next to the screen recording via the `save_blob` IPC command.
//
// It also exposes a live webcam MediaStream for the floating preview bubble.

import { invoke } from "@tauri-apps/api/core";

// ── IPC payload shapes (mirror the Rust command contract) ────────────────────

export interface StartRecordingOpts {
  screen: boolean;
  mic: boolean;
  cam: boolean;
  /** Monitor id from `list_monitors`; null = primary. */
  monitor?: string | null;
}

export interface StartRecordingResult {
  sessionId: string;
  /** Shared epoch (ms) all media start times are measured against. */
  startEpochMs: number;
}

export interface StopRecordingResult {
  dir: string;
  screenPath: string;
  cursorPath: string;
  w: number;
  h: number;
  fps: number;
  durationMs: number;
  /** Delay (ms) from clock start to the first encoded frame (for trim computation). */
  captureLagMs?: number;
}

export interface MonitorInfo {
  id: string;
  name: string;
  w: number;
  h: number;
  primary: boolean;
}

// ── Output file names (relative to the session dir) ──────────────────────────

export const MIC_FILE = "mic.webm";
export const CAM_FILE = "cam.webm";

// ── Capture options / results ────────────────────────────────────────────────

export interface StartCaptureOptions {
  /** Shared clock from `start_recording`. */
  startEpochMs: number;
  /** Capture the microphone. */
  mic?: boolean;
  /** Capture the webcam. */
  cam?: boolean;
  micDeviceId?: string | null;
  camDeviceId?: string | null;
}

export interface CaptureTrackResult {
  /** Absolute path the blob was written to. */
  path: string;
  /** ms the media start lagged behind startEpochMs (>= 0 typically). */
  offsetMs: number;
  bytes: number;
}

export interface CaptureResult {
  mic?: CaptureTrackResult;
  cam?: CaptureTrackResult;
}

// ── Internal state ───────────────────────────────────────────────────────────

interface Track {
  recorder: MediaRecorder;
  chunks: Blob[];
  /** Wall-clock (Date.now) at which recorder.start() was called. */
  startedEpochMs: number;
  mimeType: string;
  fileName: string;
}

interface ActiveCapture {
  startEpochMs: number;
  micStream: MediaStream | null;
  camStream: MediaStream | null;
  mic: Track | null;
  cam: Track | null;
}

let active: ActiveCapture | null = null;
/** Live webcam stream kept alive for the preview bubble (may outlive a session). */
let previewStream: MediaStream | null = null;
let previewDeviceId: string | null = null;

// ── MIME selection ───────────────────────────────────────────────────────────

function pickMime(candidates: string[], fallback: string): string {
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return fallback;
}

const AUDIO_MIME = (): string =>
  pickMime(["audio/webm;codecs=opus", "audio/webm"], "audio/webm");

const VIDEO_MIME = (): string =>
  pickMime(
    ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
    "video/webm",
  );

// ── Live cam stream for the preview bubble ───────────────────────────────────

/**
 * Acquire (or reuse) a live webcam stream for the preview bubble. The same
 * stream is reused by the cam MediaRecorder when recording starts, so the
 * preview does not flicker on record.
 */
export async function getCamStream(deviceId?: string | null): Promise<MediaStream> {
  const wanted = deviceId ?? null;
  if (previewStream && previewStream.getVideoTracks().some((t) => t.readyState === "live")) {
    if (wanted === null || wanted === previewDeviceId) return previewStream;
    // Different device requested — tear down and re-acquire.
    stopCamPreview();
  }
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: wanted ? { deviceId: { exact: wanted } } : true,
  };
  previewStream = await navigator.mediaDevices.getUserMedia(constraints);
  const settings = previewStream.getVideoTracks()[0]?.getSettings();
  previewDeviceId = settings?.deviceId ?? wanted;
  return previewStream;
}

/** Stop and release the preview webcam stream (if no recording is using it). */
export function stopCamPreview(): void {
  // Don't kill a stream that the active cam recorder is currently using.
  if (active && active.camStream === previewStream) return;
  if (previewStream) {
    for (const t of previewStream.getTracks()) t.stop();
  }
  previewStream = null;
  previewDeviceId = null;
}

// ── Start / stop capture ─────────────────────────────────────────────────────

export function isCapturing(): boolean {
  return active !== null;
}

/**
 * Begin mic + cam capture. Call AFTER `start_recording` so you can pass its
 * `startEpochMs`. Streams are acquired, MediaRecorders are started, and each
 * one's start wall-clock is stamped to derive offsetMs later.
 */
export async function startCapture(opts: StartCaptureOptions): Promise<void> {
  if (active) throw new Error("capture already in progress");

  const wantMic = opts.mic ?? false;
  const wantCam = opts.cam ?? false;

  const next: ActiveCapture = {
    startEpochMs: opts.startEpochMs,
    micStream: null,
    camStream: null,
    mic: null,
    cam: null,
  };

  try {
    if (wantMic) {
      next.micStream = await navigator.mediaDevices.getUserMedia({
        audio: opts.micDeviceId
          ? { deviceId: { exact: opts.micDeviceId } }
          : true,
        video: false,
      });
      next.mic = makeTrack(next.micStream, AUDIO_MIME(), MIC_FILE);
    }

    if (wantCam) {
      // Reuse the preview stream if it matches the requested device.
      const reusable =
        previewStream &&
        previewStream.getVideoTracks().some((t) => t.readyState === "live") &&
        (opts.camDeviceId == null || opts.camDeviceId === previewDeviceId);
      next.camStream = reusable
        ? (previewStream as MediaStream)
        : await getCamStream(opts.camDeviceId);
      next.cam = makeTrack(next.camStream, VIDEO_MIME(), CAM_FILE);
    }
  } catch (err) {
    // Roll back any streams acquired before the failure.
    if (next.micStream) for (const t of next.micStream.getTracks()) t.stop();
    if (next.camStream && next.camStream !== previewStream)
      for (const t of next.camStream.getTracks()) t.stop();
    throw err;
  }

  // Kick the recorders as close together as possible, stamping each start.
  if (next.mic) startTrack(next.mic);
  if (next.cam) startTrack(next.cam);

  active = next;
}

function makeTrack(stream: MediaStream, mimeType: string, fileName: string): Track {
  const recorder = new MediaRecorder(stream, { mimeType });
  const track: Track = {
    recorder,
    chunks: [],
    startedEpochMs: 0,
    mimeType,
    fileName,
  };
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) track.chunks.push(e.data);
  };
  return track;
}

function startTrack(track: Track): void {
  // 1s timeslices keep memory bounded for long recordings.
  track.recorder.start(1000);
  track.startedEpochMs = Date.now();
}

/**
 * Stop capture, flush blobs to `dir` (from `stop_recording`), and return the
 * written paths + per-track offsetMs. The session is cleared afterwards.
 */
export async function stopCapture(dir: string): Promise<CaptureResult> {
  if (!active) throw new Error("no capture in progress");
  const session = active;
  active = null;

  const result: CaptureResult = {};

  if (session.mic) {
    result.mic = await finalizeTrack(session.mic, dir, session.startEpochMs);
  }
  if (session.cam) {
    result.cam = await finalizeTrack(session.cam, dir, session.startEpochMs);
  }

  // Release mic stream entirely; keep the cam preview stream alive if it is the
  // shared preview stream, otherwise stop it.
  if (session.micStream) for (const t of session.micStream.getTracks()) t.stop();
  if (session.camStream && session.camStream !== previewStream) {
    for (const t of session.camStream.getTracks()) t.stop();
  }

  return result;
}

async function finalizeTrack(
  track: Track,
  dir: string,
  startEpochMs: number,
): Promise<CaptureTrackResult> {
  const blob = await stopRecorder(track);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const path = joinPath(dir, track.fileName);
  await saveBlob(path, buf);
  const offsetMs = Math.max(0, track.startedEpochMs - startEpochMs);
  return { path, offsetMs, bytes: buf.byteLength };
}

function stopRecorder(track: Track): Promise<Blob> {
  return new Promise((resolve) => {
    const build = () => new Blob(track.chunks, { type: track.mimeType });
    if (track.recorder.state === "inactive") {
      resolve(build());
      return;
    }
    track.recorder.onstop = () => resolve(build());
    track.recorder.stop();
  });
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Write raw bytes to disk via the `save_blob` Rust command. */
export async function saveBlob(path: string, bytes: Uint8Array): Promise<void> {
  // Tauri v2 invoke serializes args as JSON; a number[] round-trips to Vec<u8>.
  await invoke("save_blob", { path, bytes: Array.from(bytes) });
}

function joinPath(dir: string, file: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}/${file}`;
}

// ── Convenience IPC wrappers (optional, used by the recorder UI) ──────────────

export function startRecording(opts: StartRecordingOpts): Promise<StartRecordingResult> {
  return invoke<StartRecordingResult>("start_recording", { opts });
}

export function stopRecording(sessionId: string): Promise<StopRecordingResult> {
  return invoke<StopRecordingResult>("stop_recording", { sessionId });
}

export function listMonitors(): Promise<MonitorInfo[]> {
  return invoke<MonitorInfo[]>("list_monitors");
}

/** Read a recording artifact (e.g. cursor.jsonl) back as text via Rust. */
export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

// ── Device enumeration (for the device pickers in the store) ─────────────────

export interface MediaDevicesList {
  mics: MediaDeviceInfo[];
  cams: MediaDeviceInfo[];
}

/** Enumerate available mic/cam devices (labels require a prior permission grant). */
export async function listMediaDevices(): Promise<MediaDevicesList> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: devices.filter((d) => d.kind === "audioinput"),
    cams: devices.filter((d) => d.kind === "videoinput"),
  };
}
