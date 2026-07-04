// Editor.tsx
//
// The editing surface: a GPU canvas preview (hosts the PixiJS compositor from
// "@/lib/renderer"), a Timeline along the bottom, and an Inspector on the right.
//
// Editor owns the ephemeral editing state the shared document store does NOT
// model — the playhead, play/pause and the selected zoom keyframe — and threads
// them to Timeline/Inspector via props. The renderer is fed the screen/cam
// <video> elements as frame sources on every paint (renderFrame).

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Clapperboard,
  Loader2,
  Scissors,
  Video,
  ZoomIn,
  Download,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/store";
import {
  createRenderer,
  type CursorSample,
  type Renderer,
} from "@/lib/renderer";
import { readTextFile } from "@/lib/capture";
import { cutEndAt, tickPlayClock, type PlayClock } from "@/lib/timeline";

import Timeline from "@/components/Timeline";
import Inspector from "@/components/Inspector";

function videoReady(v: HTMLVideoElement | null): v is HTMLVideoElement {
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}

/** cursor.jsonl lives beside the screen recording; swap the trailing filename. */
function cursorPathFor(screenPath: string): string {
  const i = Math.max(screenPath.lastIndexOf("/"), screenPath.lastIndexOf("\\"));
  return i < 0 ? "cursor.jsonl" : screenPath.slice(0, i + 1) + "cursor.jsonl";
}

/** Parse cursor.jsonl (one JSON object per line) into renderer cursor samples. */
function parseCursorLog(text: string): CursorSample[] {
  const out: CursorSample[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as CursorSample;
      if (
        typeof o.t === "number" &&
        typeof o.x === "number" &&
        typeof o.y === "number"
      ) {
        out.push({ t: o.t, x: o.x, y: o.y, btn: o.btn ?? null });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// Source <video>s feed the GPU texture. They must be RENDERED (not display:none) or
// Chromium won't produce frames for the WebGL upload — but kept visually hidden.
const sourceVideoStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
  left: 0,
  bottom: 0,
};

export default function Editor() {
  const project = useAppStore((s) => s.project);
  const patchProject = useAppStore((s) => s.patchProject);
  const setTrim = useAppStore((s) => s.setTrim);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const micAudioRef = useRef<HTMLAudioElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const playheadRef = useRef(0);
  const reconciledRef = useRef<string | null>(null);

  const [ready, setReady] = useState(false);
  const [playheadMs, setPlayheadMsState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedKeyframe, setSelectedKeyframe] = useState<number | null>(null);

  const screenUrl = project ? convertFileSrc(project.source.screen) : null;
  const camUrl =
    project && project.camera.file ? convertFileSrc(project.camera.file) : null;
  const micUrl =
    project && project.audio.mic ? convertFileSrc(project.audio.mic) : null;

  const setPlayhead = useCallback((ms: number) => {
    playheadRef.current = ms;
    setPlayheadMsState(ms);
  }, []);

  // composite a single frame at the current playhead from the live <video> sources
  const paint = useCallback(() => {
    const r = rendererRef.current;
    const sv = screenVideoRef.current;
    if (!r || !videoReady(sv)) return;
    r.renderFrame({
      tMs: playheadRef.current,
      source: sv,
      camera: videoReady(camVideoRef.current) ? camVideoRef.current : null,
    });
  }, []);

  // ── mount the GPU renderer once a project + canvas exist ──
  useEffect(() => {
    if (!project || !canvasRef.current) return;
    let disposed = false;
    setReady(false);
    void (async () => {
      try {
        // ponytail: preview-only resolution cap. The canvas displays at well
        // under 1920px; rendering at full source res (e.g. 4K) starved the
        // video decoder (≈50% dropped frames, ~17fps loop). Export uses its own
        // renderer instance at the chosen output res — quality unaffected.
        const cap = Math.min(
          1,
          1920 / Math.max(project.source.w, project.source.h),
        );
        const r = await createRenderer({
          project,
          width: Math.round(project.source.w * cap),
          height: Math.round(project.source.h * cap),
          canvas: canvasRef.current!,
        });
        if (disposed) {
          r.destroy();
          return;
        }
        rendererRef.current = r;
        setReady(true);
        setPlayhead(project.trim.startMs);
        // Seek the sources to the trim start so the FIRST painted frame is real
        // content — not the countdown baked into the head of screen.mp4. The
        // 'seeked' listener repaints once the frame lands.
        const sv = screenVideoRef.current;
        if (sv) sv.currentTime = project.trim.startMs / 1000;
        const cv = camVideoRef.current;
        if (cv)
          cv.currentTime = Math.max(
            0,
            (project.trim.startMs - project.camera.offsetMs) / 1000,
          );
        paint();

        // Close the V1 gap: feed the renderer the cursor path so the smoothed
        // sprite AND the continuous pan-follow have data. Best-effort.
        void (async () => {
          try {
            const text = await readTextFile(cursorPathFor(project.source.screen));
            const samples = parseCursorLog(text);
            if (disposed || rendererRef.current !== r) return;
            // The REAL cursor is baked into screen.mp4 by the capture. Feed the
            // cursor path for the zoom pan-follow only — don't draw a synthetic one.
            r.setCursor(samples, project.cursorSmoothing);
            r.setCursorVisible(false);
            if (!playing) paint();
          } catch (e) {
            console.warn("cursor path load failed", e);
          }
        })();
      } catch (e) {
        console.warn("renderer unavailable", e);
      }
    })();
    return () => {
      disposed = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setReady(false);
    };
    // re-mount only when the underlying source changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.source.screen]);

  // ── reconcile duration: the recorded mp4's real length is authoritative ──
  // (Rust's elapsed-time estimate can fall slightly short, which made the
  // timeline + playback stop before the video actually ended.)
  useEffect(() => {
    const sv = screenVideoRef.current;
    if (!sv || !project) return;
    const key = project.source.screen;
    const reconcile = () => {
      const realMs = (sv.duration || 0) * 1000;
      if (
        realMs > 0 &&
        Number.isFinite(realMs) &&
        reconciledRef.current !== key &&
        Math.abs(realMs - project.source.durationMs) > 200
      ) {
        reconciledRef.current = key;
        const wasFullTrim =
          Math.abs(project.trim.endMs - project.source.durationMs) < 50;
        patchProject({ source: { ...project.source, durationMs: realMs } });
        if (wasFullTrim) setTrim({ startMs: project.trim.startMs, endMs: realMs });
      }
    };
    sv.addEventListener("loadedmetadata", reconcile);
    if (sv.readyState >= 1) reconcile();
    return () => sv.removeEventListener("loadedmetadata", reconcile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.source.screen]);

  // ── push document edits into the renderer + repaint while paused ──
  useEffect(() => {
    const r = rendererRef.current;
    if (r && project) {
      r.setProject(project);
      if (!playing) paint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // ── repaint the current frame whenever the screen video seeks / loads ──
  useEffect(() => {
    const sv = screenVideoRef.current;
    if (!sv) return;
    const onFrame = () => {
      if (!playing) paint();
    };
    sv.addEventListener("seeked", onFrame);
    sv.addEventListener("loadeddata", onFrame);
    return () => {
      sv.removeEventListener("seeked", onFrame);
      sv.removeEventListener("loadeddata", onFrame);
    };
  }, [paint, playing, ready]);

  // ── seek (scrub): align the media clocks; the 'seeked' handler repaints ──
  const seek = useCallback(
    (ms: number) => {
      if (!project) return;
      const t = Math.max(project.trim.startMs, Math.min(project.trim.endMs, ms));
      setPlayhead(t);
      const sv = screenVideoRef.current;
      if (sv) sv.currentTime = t / 1000;
      const cv = camVideoRef.current;
      if (cv) cv.currentTime = Math.max(0, (t - project.camera.offsetMs) / 1000);
      const ma = micAudioRef.current;
      if (ma) ma.currentTime = Math.max(0, (t - project.audio.offsetMs) / 1000);
    },
    [project, setPlayhead]
  );

  // ── play loop: a CONTINUOUS performance-clock drives the playhead so the zoom +
  //    pan sample at a smooth 60fps (the <video>'s currentTime advances in source-
  //    fps steps, which made the motion choppy). The video plays naturally for
  //    A/V; the clock RE-ANCHORS to it on drift, so they stay in sync without
  //    seeking it every frame (seeking would stutter the video). ──
  useEffect(() => {
    if (!playing || !project) return;
    const sv = screenVideoRef.current;
    const cv = camVideoRef.current;
    const ma = micAudioRef.current;
    if (ma) ma.currentTime = Math.max(0, (playheadRef.current - project.audio.offsetMs) / 1000);
    void sv?.play().catch(() => {});
    void cv?.play().catch(() => {});
    void ma?.play().catch(() => {});

    const clock: PlayClock = {
      anchorPerf: performance.now(),
      anchorMs: playheadRef.current,
      lastT: playheadRef.current,
    };
    let raf = 0;

    const loop = () => {
      const now = performance.now();
      // Slewed, monotonic playhead — see tickPlayClock (timeline.ts) for why
      // this must never hard-snap backward to a lagging video clock.
      const t = tickPlayClock(clock, now, sv ? sv.currentTime * 1000 : null);

      if (t >= project.trim.endMs) {
        setPlaying(false);
        sv?.pause();
        cv?.pause();
        ma?.pause();
        setPlayhead(project.trim.endMs);
        paint();
        return;
      }

      // Skip a cut: seek the media to the cut end and re-anchor the clock there.
      const cutEnd = cutEndAt(project.cuts, t);
      if (cutEnd != null && cutEnd < project.trim.endMs) {
        if (sv) {
          sv.currentTime = cutEnd / 1000;
          void sv.play().catch(() => {});
        }
        if (cv) {
          cv.currentTime = Math.max(0, (cutEnd - project.camera.offsetMs) / 1000);
          void cv.play().catch(() => {});
        }
        if (ma) {
          ma.currentTime = Math.max(0, (cutEnd - project.audio.offsetMs) / 1000);
          void ma.play().catch(() => {});
        }
        clock.anchorPerf = now;
        clock.anchorMs = cutEnd;
        clock.lastT = cutEnd;
        setPlayhead(cutEnd);
        raf = requestAnimationFrame(loop);
        return;
      }

      // Keep the mic in sync: silent before it starts (want<0), else play and
      // correct any drift. offsetMs = where the mic begins on the video timeline.
      if (ma) {
        const want = (t - project.audio.offsetMs) / 1000;
        if (want < 0) {
          if (!ma.paused) ma.pause();
        } else {
          if (ma.paused) void ma.play().catch(() => {});
          if (Math.abs(ma.currentTime - want) > 0.2) ma.currentTime = want;
        }
      }

      setPlayhead(t);
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      sv?.pause();
      cv?.pause();
      ma?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project]);

  const togglePlay = useCallback(() => {
    if (!project) return;
    if (!playing && playheadRef.current >= project.trim.endMs - 1) {
      seek(project.trim.startMs);
    }
    setPlaying((p) => !p);
  }, [playing, project, seek]);

  // Spacebar toggles play/pause (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // Calm, state-conveying motion. 150–250ms; collapses to instant/crossfade
  // when the user prefers reduced motion.
  const reduce = useReducedMotion();
  const ease = [0.22, 1, 0.36, 1] as const;
  const tNorm = reduce ? { duration: 0 } : { duration: 0.22, ease };
  const tSnappy = reduce ? { duration: 0 } : { duration: 0.16, ease };

  // Preview depth: a soft drop shadow + a hair-line ring, with the single accent
  // ring layered on when a zoom region is selected (selection → preview, direct).
  const baseShadow =
    "0 32px 64px -28px rgba(0,0,0,0.85), 0 8px 24px -16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.07)";
  const selectedShadow =
    "0 32px 64px -28px rgba(0,0,0,0.85), 0 8px 24px -16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.07), 0 0 0 2px var(--primary)";

  if (!project) {
    // Empty state — teach the flow rather than apologize for it.
    const steps = [
      { icon: Video, label: "Record", hint: "Capture your screen" },
      { icon: Scissors, label: "Trim", hint: "Drag the clip ends" },
      { icon: ZoomIn, label: "Zoom", hint: "Add zoom blocks on the timeline" },
      { icon: Download, label: "Export", hint: "Render an MP4 or GIF" },
    ];
    return (
      <div
        className="grid h-full place-items-center p-8 text-center"
        style={{ backgroundColor: "var(--matte)" }}
      >
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={tNorm}
          className="max-w-md space-y-6"
        >
          <div className="space-y-2">
            <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-card ring-1 ring-border">
              <Clapperboard className="size-6 text-muted-foreground" />
            </div>
            <h2 className="text-base font-medium text-foreground">No recording loaded</h2>
            <p className="text-sm text-muted-foreground">
              Capture something in the Record tab — it opens here, ready to polish.
            </p>
          </div>

          <ol className="grid grid-cols-4 gap-2 text-left">
            {steps.map((s, i) => (
              <li
                key={s.label}
                className="space-y-1.5 rounded-lg bg-card/60 p-3 ring-1 ring-border/60"
              >
                <s.icon className="size-4 text-muted-foreground" />
                <div className="text-xs font-medium text-foreground">
                  {i + 1}. {s.label}
                </div>
                <div className="text-[11px] leading-snug text-muted-foreground">
                  {s.hint}
                </div>
              </li>
            ))}
          </ol>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* preview + timeline */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* stage: a generous dark matte the preview floats on */}
        <div
          className="relative grid min-h-0 flex-1 place-items-center overflow-hidden p-8 sm:p-10"
          style={{
            backgroundColor: "var(--matte)",
            backgroundImage:
              "radial-gradient(120% 90% at 50% 38%, rgba(255,255,255,0.05), transparent 70%)",
          }}
        >
          <motion.canvas
            ref={canvasRef}
            width={project.source.w}
            height={project.source.h}
            className="max-h-full max-w-full rounded-xl"
            style={{ aspectRatio: `${project.source.w} / ${project.source.h}` }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
            animate={{
              opacity: ready ? 1 : 0.4,
              scale: 1,
              boxShadow:
                selectedKeyframe != null ? selectedShadow : baseShadow,
            }}
            transition={tNorm}
          />

          {/* renderer-loading — subtle, non-blocking */}
          <AnimatePresence>
            {!ready && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tSnappy}
                className="pointer-events-none absolute inset-0 grid place-items-center"
              >
                <div className="flex items-center gap-2 rounded-full bg-card/80 px-3 py-1.5 text-xs text-muted-foreground ring-1 ring-border/60 backdrop-blur">
                  <Loader2 className="size-3.5 animate-spin" />
                  Preparing preview…
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* hidden media sources sampled by the renderer (load-bearing) */}
          <video
            ref={screenVideoRef}
            src={screenUrl ?? undefined}
            crossOrigin="anonymous"
            muted
            playsInline
            preload="auto"
            style={sourceVideoStyle}
          />
          <video
            ref={camVideoRef}
            src={camUrl ?? undefined}
            crossOrigin="anonymous"
            muted
            playsInline
            preload="auto"
            style={sourceVideoStyle}
          />
          {/* mic audio — the only audible track in preview (screen/cam are muted) */}
          <audio
            ref={micAudioRef}
            src={micUrl ?? undefined}
            crossOrigin="anonymous"
            preload="auto"
          />
        </div>

        {/* timeline docked on a slightly elevated surface */}
        <div className="shrink-0 bg-card/60 shadow-[0_-12px_32px_-24px_rgba(0,0,0,0.8)]">
          <Timeline
            playheadMs={playheadMs}
            playing={playing}
            onSeek={seek}
            onTogglePlay={togglePlay}
            selectedKeyframe={selectedKeyframe}
            onSelectKeyframe={setSelectedKeyframe}
          />
        </div>
      </div>

      {/* inspector */}
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={tNorm}
        className="h-full shrink-0"
      >
        <Card className="flex h-full w-80 flex-col gap-0 rounded-none border-y-0 border-r-0 py-0">
          <ScrollArea className="min-h-0 flex-1">
            <Inspector
              playheadMs={playheadMs}
              onSeek={seek}
              selectedKeyframe={selectedKeyframe}
              onSelectKeyframe={setSelectedKeyframe}
            />
          </ScrollArea>
        </Card>
      </motion.div>
    </div>
  );
}
