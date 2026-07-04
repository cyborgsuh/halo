// Recorder.tsx
//
// Record controls: monitor/source picker, mic & camera toggles, a live webcam
// preview bubble, and the start/stop button. Drives the capture helpers in
// "@/lib/capture" (which wrap the Rust IPC commands + webview MediaRecorder).
//
// Reads/writes the shared zustand store (useAppStore). All controls are shadcn.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Camera, FolderOpen, Mic, MicOff, Monitor, Square, Video } from "lucide-react";

import Countdown from "@/components/Countdown";
import {
  clearRecBarSession,
  writeRecBarSession,
} from "@/components/RecBar";
import { writeCamPreviewDevice } from "@/components/CamPreview";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAppStore } from "@/store";
import {
  DEFAULT_CURSOR_FOLLOW,
  DEFAULT_ZOOM_DURATION_MS,
  type Project,
  type ZoomRegion,
} from "@/lib/timeline";
import { computeZoomRegions, parseCursorLog } from "@/lib/autozoom";
import {
  getCamStream,
  listMonitors,
  readTextFile,
  startCapture,
  startRecording,
  stopCamPreview,
  stopCapture,
  stopRecording,
  type CaptureResult,
  type MonitorInfo,
  type StartRecordingResult,
  type StopRecordingResult,
} from "@/lib/capture";

/**
 * Load cursor.jsonl and derive auto-zoom keyframes. Best-effort: any failure
 * (missing file, parse error, too few samples) yields an empty list so the
 * recording is still editable without zoom.
 */
async function autoZoomFor(stop: StopRecordingResult): Promise<ZoomRegion[]> {
  try {
    const text = await readTextFile(stop.cursorPath);
    const samples = parseCursorLog(text);
    return computeZoomRegions(samples, stop.w, stop.h);
  } catch (e) {
    console.warn("auto-zoom generation failed", e);
    return [];
  }
}

/** Assemble a fresh editable project from a stop result + the captured a/v tracks. */
/** Countdown shown in the floating bar; capture warms during it (ms). */
const COUNTDOWN_MS = 3000;

function makeProject(
  stop: StopRecordingResult,
  cap: CaptureResult,
  zoom: ZoomRegion[],
  trimStartMs = 0,
): Project {
  const start = Math.max(0, Math.min(trimStartMs, Math.max(0, stop.durationMs - 500)));
  return {
    version: 1,
    source: {
      screen: stop.screenPath,
      w: stop.w,
      h: stop.h,
      fps: stop.fps,
      durationMs: stop.durationMs,
    },
    audio: { mic: cap.mic?.path ?? "", offsetMs: cap.mic?.offsetMs ?? 0 },
    camera: {
      file: cap.cam?.path ?? "",
      shape: "circle",
      pos: "br",
      sizePct: 18,
      offsetMs: cap.cam?.offsetMs ?? 0,
    },
    trim: { startMs: start, endMs: stop.durationMs },
    background: {
      type: "gradient",
      value: ["#1e293b", "#0f172a"],
      paddingPct: 6,
      radiusPx: 16,
      shadow: 0.4,
    },
    zoom,
    cuts: [],
    cursorSmoothing: 0.85,
    cursorFollow: { ...DEFAULT_CURSOR_FOLLOW },
    zoomDurationMs: DEFAULT_ZOOM_DURATION_MS,
    export: {
      w: stop.w,
      h: stop.h,
      fps: stop.fps,
      format: "mp4",
      bitrateMbps: 12,
    },
  };
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Session-finalization state — MODULE scope, not component refs ───────────
// The Recorder view can unmount mid-recording (user navigates to the library),
// so the stop flow must not live in component state. The "recording-stopped"
// listener is registered ONCE at App level and calls finalizeStop below.

/** tracks what a/v the active session records so stop knows whether to flush */
let capturedAv = false;
/** wall ms from the capture clock's start to when real content begins */
let contentStartMs = 0;
/** latch so the recording-stopped flow finalizes exactly once per session */
let finalizing = false;

/**
 * Finalize a stopped recording: flush mic/cam, run auto-zoom, build the project,
 * refresh the library and land on the editor. Driven by the "recording-stopped"
 * event (emitted by the floating bar or by requestStop), guarded to run once.
 * Module-level + store-via-getState so it works no matter which view is mounted.
 */
export async function finalizeStop(
  stopRes: StopRecordingResult | null,
): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  const { setRecording, setProject, resetRecording, loadRecordings, setView } =
    useAppStore.getState();

  // Hide the floating camera preview + release its camera (device key gate).
  writeCamPreviewDevice(null);
  try {
    await invoke("close_cam_preview");
  } catch {
    /* not open */
  }

  // Bring the main window back regardless of how stop was triggered.
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.setFocus();
  } catch (e) {
    console.warn("restore window failed", e);
  }
  clearRecBarSession();

  if (!stopRes) {
    // Stop failed on the bar side — recover to an editable/idle state.
    capturedAv = false;
    resetRecording();
    toast.error("Recording stopped unexpectedly.");
    return;
  }

  setRecording({ status: "stopping" });
  try {
    let cap: CaptureResult = {};
    if (capturedAv) {
      try {
        cap = await stopCapture(stopRes.dir);
      } catch (e) {
        console.warn("capture stop failed", e);
      }
    }
    capturedAv = false;

    setRecording({ status: "processing", dir: stopRes.dir });
    const zoom = await autoZoomFor(stopRes);
    // Trim the countdown bit exactly: content-start (wall ms from clock start)
    // minus the capture lag (clock start → first video frame) = video time
    // where the user's content begins.
    const trimStartMs = Math.max(0, contentStartMs - (stopRes.captureLagMs ?? 0));
    const project = makeProject(stopRes, cap, zoom, trimStartMs);
    setProject(project);
    resetRecording();
    setView("edit"); // navigate FIRST so stop always lands on the editor

    // Persist + refresh library in the background (must not block navigation).
    const id = stopRes.dir.split(/[\\/]/).filter(Boolean).pop() ?? "";
    if (id) {
      try {
        await invoke("save_project", { id, json: JSON.stringify(project) });
      } catch (e) {
        console.warn("save_project failed", e);
      }
    }
    void loadRecordings();
    toast.success("Recording ready — refine it in the editor.");
  } catch (e) {
    setRecording({ status: "idle", error: String(e) });
    toast.error("Stop failed: " + String(e));
  }
}

interface RecordingFiles {
  dir: string;
  screenPath: string;
  cursorPath: string | null;
  micPath: string | null;
  camPath: string | null;
}

/** Probe an mp4's intrinsic size + duration by loading its metadata in a detached <video>. */
function probeVideo(url: string): Promise<{ w: number; h: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.onloadedmetadata = () =>
      resolve({ w: v.videoWidth, h: v.videoHeight, durationMs: (v.duration || 0) * 1000 });
    v.onerror = () => reject(new Error("metadata load failed"));
    v.src = url;
  });
}

/** Build an editable project from a recording's on-disk files (no project.json needed). */
async function buildProjectFromFiles(files: RecordingFiles): Promise<Project> {
  const { w, h, durationMs } = await probeVideo(convertFileSrc(files.screenPath));
  let zoom: ZoomRegion[] = [];
  if (files.cursorPath) {
    try {
      const samples = parseCursorLog(await readTextFile(files.cursorPath));
      zoom = computeZoomRegions(samples, w, h);
    } catch {
      /* best effort */
    }
  }
  const stop: StopRecordingResult = {
    dir: files.dir,
    screenPath: files.screenPath,
    cursorPath: files.cursorPath ?? "",
    w,
    h,
    fps: 60,
    durationMs,
  };
  // Disk-loaded tracks have no in-memory bytes; makeProject only reads path/offsetMs.
  const cap = {
    mic: files.micPath ? { path: files.micPath, offsetMs: 0 } : undefined,
    cam: files.camPath ? { path: files.camPath, offsetMs: 0 } : undefined,
  } as unknown as CaptureResult;
  return makeProject(stop, cap, zoom);
}

/** Build an editable project from the most recent on-disk recording (no re-record). */
export async function loadLatestProject(): Promise<Project | null> {
  const files = await invoke<RecordingFiles | null>("latest_recording");
  if (!files) return null;
  return buildProjectFromFiles(files);
}

/**
 * Open a specific recording for editing. Prefers its saved project.json (so edits
 * persist); falls back to rebuilding from the raw files for older recordings that
 * predate project.json persistence, then writes the project back to self-heal.
 */
export async function loadProjectForRecording(rec: {
  id: string;
  dir: string;
  screenPath: string;
}): Promise<Project> {
  try {
    const text = await invoke<string>("load_recording", { id: rec.id });
    return JSON.parse(text) as Project;
  } catch {
    // No project.json — rebuild from the raw files (sibling cursor/mic/cam).
    const sep = rec.dir.includes("\\") ? "\\" : "/";
    const join = (name: string) => `${rec.dir}${sep}${name}`;
    const files: RecordingFiles = {
      dir: rec.dir,
      screenPath: rec.screenPath,
      cursorPath: join("cursor.jsonl"),
      micPath: join("mic.webm"),
      camPath: join("cam.webm"),
    };
    const project = await buildProjectFromFiles(files);
    try {
      await invoke("save_project", { id: rec.id, json: JSON.stringify(project) });
    } catch {
      /* best effort self-heal */
    }
    return project;
  }
}

export default function Recorder() {
  const recording = useAppStore((s) => s.recording);
  const devices = useAppStore((s) => s.devices);
  const setRecording = useAppStore((s) => s.setRecording);
  const resetRecording = useAppStore((s) => s.resetRecording);
  const setDevices = useAppStore((s) => s.setDevices);
  const setProject = useAppStore((s) => s.setProject);
  const project = useAppStore((s) => s.project);
  const setView = useAppStore((s) => s.setView);
  const loadRecordings = useAppStore((s) => s.loadRecordings);

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [showCountdown, setShowCountdown] = useState(false);

  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  // WGC start kicked off at countdown START so it's warm by the time it hits 0.
  const startPromiseRef = useRef<Promise<StartRecordingResult> | null>(null);

  const isRecording = recording.status === "recording";
  const isBusy = recording.status === "starting" || recording.status === "stopping";

  // Pre-warm the capture stack the moment the record screen opens, so the real
  // recording starts in ~100-200ms instead of ~1s (warms WGC + the MF encoder).
  // Also pre-create the overlay windows HIDDEN: their WebView2 + React boot (the
  // seconds the bar used to take to appear) happens NOW, long before it's needed.
  // They persist hidden across recordings (close_* hides, never destroys), so
  // every show() at countdown-zero is instant. CamPreview holds no camera while
  // idle — its stream is gated on the device key written at record start.
  useEffect(() => {
    void invoke("prewarm_capture").catch(() => {});
    void invoke("open_rec_bar").catch(() => {});
    void invoke("open_cam_preview").catch(() => {});
  }, []);

  // ── enumerate monitors (Rust) + cameras (webview) on mount ──
  useEffect(() => {
    void (async () => {
      try {
        const mons = await listMonitors();
        setMonitors(mons);
        if (!devices.monitorId && mons.length) {
          const primary = mons.find((m) => m.primary) ?? mons[0];
          setDevices({ monitorId: primary.id });
        }
      } catch {
        /* not in tauri / no monitors — leave empty */
      }
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        setCams(list.filter((d) => d.kind === "videoinput"));
      } catch {
        /* getUserMedia unavailable */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── live webcam preview bubble ──
  useEffect(() => {
    if (!recording.captureCam) {
      stopCamPreview();
      if (camVideoRef.current) camVideoRef.current.srcObject = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const stream = await getCamStream(devices.camDeviceId);
        if (cancelled) return;
        if (camVideoRef.current) camVideoRef.current.srcObject = stream;
      } catch (e) {
        toast.error("Camera preview failed: " + String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.captureCam, devices.camDeviceId]);

  // stop the preview stream when the recorder unmounts (unless a recording owns it)
  useEffect(
    () => () => {
      if (!useAppStore.getState().recording.sessionId) stopCamPreview();
    },
    []
  );

  // ── elapsed-time readout ──
  useEffect(() => {
    if (!isRecording || recording.startedAtMs == null) return;
    const started = recording.startedAtMs;
    setElapsed(Date.now() - started);
    const id = window.setInterval(() => setElapsed(Date.now() - started), 250);
    return () => window.clearInterval(id);
  }, [isRecording, recording.startedAtMs]);

  // ── start: instant center 3-2-1, capture warms underneath during it ──

  /**
   * Record pressed. Kick off the slow WGC init IMMEDIATELY (in the background) and
   * show the 3-2-1 in the main window (instant — no window to load). The init
   * overlaps the countdown, so by the time it hits 0 the capture is already warm.
   * The bit captured during the countdown is auto-trimmed in finalizeStop.
   */
  const requestStart = useCallback(() => {
    if (!recording.captureScreen) return;
    setRecording({ status: "starting", error: null });
    const p = startRecording({
      screen: recording.captureScreen,
      mic: recording.captureMic,
      cam: recording.captureCam,
      monitor: devices.monitorId,
    });
    p.catch(() => {}); // handled in beginRecording; avoid unhandled rejection
    startPromiseRef.current = p;

    // Placeholder session for the (already booted, hidden) bar: empty sessionId
    // keeps Stop disabled; future startedAtMs makes the timer read 00:00 at show.
    writeRecBarSession({ sessionId: "", startedAtMs: Date.now() + COUNTDOWN_MS });
    // Device key = the cam window's signal to acquire the camera ("" = default
    // device). It starts its stream NOW, during the countdown, so the bubble has
    // live video the instant it's shown. Cleared on every stop path.
    writeCamPreviewDevice(recording.captureCam ? (devices.camDeviceId ?? "") : null);

    setShowCountdown(true);
  }, [recording, devices, setRecording]);

  /** Countdown hit 0: capture is already warm — minimize + raise the overlays. */
  const beginRecording = useCallback(async () => {
    setShowCountdown(false);
    try {
      const res = await (startPromiseRef.current ??
        startRecording({
          screen: recording.captureScreen,
          mic: recording.captureMic,
          cam: recording.captureCam,
          monitor: devices.monitorId,
        }));
      startPromiseRef.current = null;

      // Reveal the pre-booted overlays. open_* is idempotent (returns instantly
      // when the window already exists — the normal case since Recorder mount).
      // Open and show fail independently so a redundant-create error can never
      // swallow the show. Non-fatal — recording continues bar-less on failure.
      try {
        await invoke("open_rec_bar");
      } catch (e) {
        console.warn("rec bar open failed", e);
      }
      try {
        await (await WebviewWindow.getByLabel("rec-bar"))?.show();
      } catch (e) {
        console.warn("rec bar show failed", e);
      }
      if (recording.captureCam) {
        try {
          await invoke("open_cam_preview");
        } catch (e) {
          console.warn("cam preview open failed", e);
        }
        try {
          await (await WebviewWindow.getByLabel("cam-preview"))?.show();
        } catch (e) {
          console.warn("cam preview show failed", e);
        }
      }

      try {
        await getCurrentWindow().minimize();
      } catch (e) {
        console.warn("minimize failed", e);
      }
      const startedAtMs = Date.now();
      // Content begins NOW (countdown done, app hidden). Record where that lands on
      // the capture clock so finalizeStop can trim the countdown bit exactly.
      contentStartMs = Math.max(0, startedAtMs - res.startEpochMs);
      writeRecBarSession({ sessionId: res.sessionId, startedAtMs });

      finalizing = false;
      setRecording({
        status: "recording",
        sessionId: res.sessionId,
        startEpochMs: res.startEpochMs,
        startedAtMs,
      });
      await emit("rec-bar-session-ready", { sessionId: res.sessionId, startedAtMs });

      capturedAv = recording.captureMic || recording.captureCam;
      if (capturedAv) {
        try {
          await startCapture({
            startEpochMs: res.startEpochMs,
            mic: recording.captureMic,
            cam: recording.captureCam,
            micDeviceId: devices.micDeviceId,
            camDeviceId: devices.camDeviceId,
          });
        } catch (e) {
          console.warn("a/v capture failed", e);
          capturedAv = false;
          toast.warning("Mic/camera unavailable — recording screen only", {
            description: "Check device permissions. The screen capture continues.",
          });
        }
      }
    } catch (e) {
      capturedAv = false;
      startPromiseRef.current = null;
      clearRecBarSession();
      writeCamPreviewDevice(null);
      try {
        await invoke("close_cam_preview");
      } catch {
        /* not open */
      }
      try {
        await invoke("close_rec_bar");
      } catch {
        /* not open */
      }
      try {
        await getCurrentWindow().unminimize();
      } catch {
        /* ignore */
      }
      setRecording({ status: "idle", error: String(e) });
      toast.error("Could not start recording: " + String(e));
    }
  }, [recording, devices, setRecording]);

  // ── stop / finalize ──
  // finalizeStop is MODULE-level (top of file) and its "recording-stopped"
  // listener lives in App.tsx — stop must finalize even when this view is
  // unmounted (user navigated to the library mid-recording).

  /** Local stop fallback (e.g. main window restored): mirror the bar's stop sequence. */
  const requestStop = useCallback(async () => {
    const sessionId = useAppStore.getState().recording.sessionId;
    if (!sessionId) return;
    setRecording({ status: "stopping" });
    try {
      const stopRes = await stopRecording(sessionId);
      await emit("recording-stopped", stopRes);
    } catch (e) {
      await emit("recording-stopped", null);
      console.warn("stop failed", e);
    } finally {
      try {
        await invoke("close_rec_bar");
      } catch {
        /* bar may already be closed */
      }
    }
  }, [setRecording]);

  const openLast = useCallback(async () => {
    try {
      const p = await loadLatestProject();
      if (!p) {
        toast.info("No previous recording found.");
        return;
      }
      setProject(p);
      setView("edit");
    } catch (e) {
      toast.error("Could not load last recording: " + String(e));
    }
  }, [setProject, setView]);

  const monitorValue = devices.monitorId ?? "";

  return (
    <div className="grid h-full w-full place-items-center p-6">
      <AnimatePresence>
        {showCountdown && (
          <Countdown
            seconds={COUNTDOWN_MS / 1000}
            onComplete={() => void beginRecording()}
          />
        )}
      </AnimatePresence>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Video className="size-5" /> Record
          </CardTitle>
          <CardDescription>
            Capture your screen with cursor tracking, mic and webcam.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* webcam preview bubble */}
          <div className="flex justify-center">
            <div
              className={
                "relative size-40 overflow-hidden rounded-full border-2 transition-colors " +
                (recording.captureCam ? "border-primary/60" : "border-dashed border-muted")
              }
            >
              {recording.captureCam ? (
                <video
                  ref={camVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-full w-full -scale-x-100 object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted-foreground">
                  <Camera className="size-7" />
                </div>
              )}
            </div>
          </div>

          {/* source / monitor */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-muted-foreground">
              <Monitor className="size-4" /> Source
            </Label>
            <Select
              value={monitorValue}
              onValueChange={(v) => setDevices({ monitorId: (v as string) || null })}
            >
              <SelectTrigger className="w-full" disabled={isRecording || isBusy}>
                <SelectValue placeholder="Primary monitor" />
              </SelectTrigger>
              <SelectContent>
                {monitors.length === 0 ? (
                  <SelectItem value="" disabled>
                    No monitors found
                  </SelectItem>
                ) : (
                  monitors.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} · {m.w}×{m.h}
                      {m.primary ? " (primary)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* toggles */}
          <div className="space-y-3">
            <ToggleRow
              icon={<Monitor className="size-4" />}
              label="Screen"
              checked={recording.captureScreen}
              disabled={isRecording || isBusy}
              onChange={(v) => setRecording({ captureScreen: v })}
            />
            <ToggleRow
              icon={
                recording.captureMic ? (
                  <Mic className="size-4" />
                ) : (
                  <MicOff className="size-4" />
                )
              }
              label="Microphone"
              checked={recording.captureMic}
              disabled={isRecording || isBusy}
              onChange={(v) => setRecording({ captureMic: v })}
            />
            <ToggleRow
              icon={<Camera className="size-4" />}
              label="Webcam"
              checked={recording.captureCam}
              disabled={isRecording || isBusy}
              onChange={(v) => setRecording({ captureCam: v })}
            />

            {recording.captureCam && cams.length > 0 && (
              <Select
                value={devices.camDeviceId ?? ""}
                onValueChange={(v) => setDevices({ camDeviceId: (v as string) || null })}
              >
                <SelectTrigger className="w-full" disabled={isRecording || isBusy}>
                  <SelectValue placeholder="Default camera" />
                </SelectTrigger>
                <SelectContent>
                  {cams.map((c, i) => (
                    <SelectItem key={c.deviceId || i} value={c.deviceId}>
                      {c.label || `Camera ${i + 1}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {recording.error && (
            <p className="text-sm text-destructive">{recording.error}</p>
          )}
        </CardContent>

        <Separator />

        <div className="flex items-center justify-between px-6 py-4">
          <div className="font-mono text-sm tabular-nums text-muted-foreground">
            {isRecording ? (
              <span className="flex items-center gap-2 text-foreground">
                <span className="size-2 animate-pulse rounded-full bg-destructive" />
                {fmtElapsed(elapsed)}
              </span>
            ) : (
              "00:00"
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isRecording && (
              <Button variant="outline" onClick={() => void openLast()} disabled={isBusy}>
                <FolderOpen className="size-4" /> Open last
              </Button>
            )}
            {isRecording ? (
              <Button variant="destructive" onClick={() => void requestStop()} disabled={isBusy}>
                <Square className="size-4" /> Stop
              </Button>
            ) : (
              <Button
                onClick={() => requestStart()}
                disabled={isBusy || showCountdown || !recording.captureScreen}
              >
                <span className="size-2.5 rounded-full bg-current" />
                {recording.status === "processing" ? "Processing…" : "Record"}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ToggleRow(props: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <Label className="flex items-center gap-2">
        {props.icon}
        {props.label}
      </Label>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(v) => props.onChange(v)}
      />
    </div>
  );
}
