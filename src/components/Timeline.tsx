// Timeline.tsx
//
// The UNIFIED PRO TIMELINE. A WINDOWED time-range model: the lane is ALWAYS
// exactly the viewport width (no scroll container, so a scrollbar is structurally
// impossible). "Zoom" narrows/widens the visible window [viewStartMs, viewEndMs];
// "pan" shifts it. Every track shares one pixels<->time mapping (`TimeScale`)
// computed against that window, so Ruler/Clip/Zoom/Cut/Playhead need no changes.
//
//   Transport ─ play/pause · readout · add-zoom/cut · zoom in/out/fit
//   Ruler     ─ ticks + m:ss labels; click/drag to scrub
//   ClipTrack ─ the video as one clip; drag ends to trim
//   ZoomTrack ─ ZoomRegion blocks; drag to move/resize, dbl-click to add
//   CutTrack  ─ Cut blocks (removed spans)
//   Playhead  ─ one draggable line across all tracks

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "@/store";
import Transport from "@/components/timeline/Transport";
import Ruler from "@/components/timeline/Ruler";
import ClipTrack from "@/components/timeline/ClipTrack";
import ZoomTrack from "@/components/timeline/ZoomTrack";
import CutTrack from "@/components/timeline/CutTrack";
import Playhead from "@/components/timeline/Playhead";
import { clamp, type TimeScale } from "@/components/timeline/shared";
import { wheelAction, clampView, MIN_WINDOW_MS } from "@/components/timeline/wheel";

export interface TimelineProps {
  playheadMs: number;
  playing: boolean;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  /** Selected zoom-region index (legacy prop name kept for Editor). */
  selectedKeyframe: number | null;
  onSelectKeyframe: (i: number | null) => void;
}

/** Button zoom step. */
const ZOOM_STEP = 1.6;

export default function Timeline(props: TimelineProps) {
  const { playheadMs, playing, onSeek, selectedKeyframe, onSelectKeyframe } = props;

  const project = useAppStore((s) => s.project);
  const setTrim = useAppStore((s) => s.setTrim);
  const addZoomRegion = useAppStore((s) => s.addZoomRegion);
  const updateZoomRegion = useAppStore((s) => s.updateZoomRegion);
  const removeZoomRegion = useAppStore((s) => s.removeZoomRegion);
  const addCut = useAppStore((s) => s.addCut);
  const updateCut = useAppStore((s) => s.updateCut);
  const removeCut = useAppStore((s) => s.removeCut);

  const laneRef = useRef<HTMLDivElement | null>(null);
  const [viewportW, setViewportW] = useState(0);

  const durationMs = Math.max(1, project?.source.durationMs ?? 1);

  // The visible window. Defaults to the whole clip; resets when duration changes.
  const [view, setView] = useState({ startMs: 0, endMs: durationMs });
  useEffect(() => {
    setView({ startMs: 0, endMs: durationMs });
  }, [durationMs]);

  // Measure the lane width.
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setViewportW(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(MIN_WINDOW_MS, view.endMs - view.startMs);
  const pxPerMs = viewportW > 0 ? viewportW / span : 0;

  // One pixels<->time mapping, computed against the visible window.
  const scale = useMemo<TimeScale>(() => {
    const xAt = (ms: number) => (ms - view.startMs) * pxPerMs;
    const timeAtX = (clientX: number) => {
      const el = laneRef.current;
      if (!el || pxPerMs <= 0) return view.startMs;
      const rect = el.getBoundingClientRect();
      return clamp(view.startMs + (clientX - rect.left) / pxPerMs, 0, durationMs);
    };
    return { durationMs, pxPerMs, contentWidth: viewportW, xAt, timeAtX };
  }, [view.startMs, pxPerMs, viewportW, durationMs]);

  /** Set a window, clamped to [0,duration] with a minimum span (tested: wheel.ts). */
  const applyView = useCallback(
    (startMs: number, endMs: number) => {
      setView(clampView(startMs, endMs, durationMs));
    },
    [durationMs],
  );

  // Wheel over the timeline → pan/zoom via the unit-tested `wheelAction` (axis-based:
  // horizontal = pan, vertical = zoom — ctrl is ignored, this touchpad is unreliable
  // about it). Native + non-passive so it always preventDefaults (no page zoom/scroll).
  useEffect(() => {
    const el = laneRef.current?.parentElement; // the section-level wrapper
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      if (viewportW <= 0 || pxPerMs <= 0) return;
      const rect = laneRef.current!.getBoundingClientRect();
      const localX = clamp(ev.clientX - rect.left, 0, viewportW);
      const r = wheelAction(
        { deltaX: ev.deltaX, deltaY: ev.deltaY },
        view,
        { durationMs, viewportW, localX, pxPerMs },
      );
      setView(r.view);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, pxPerMs, viewportW, durationMs]);

  // Keep the playhead inside the window while playing.
  useEffect(() => {
    if (!playing) return;
    if (playheadMs < view.startMs || playheadMs > view.endMs) {
      const half = span / 2;
      applyView(playheadMs - half, playheadMs + half);
    }
  }, [playheadMs, playing, view.startMs, view.endMs, span, applyView]);

  const zoomAroundCenter = useCallback(
    (factor: number) => {
      const center = (view.startMs + view.endMs) / 2;
      const newSpan = clamp(span * factor, MIN_WINDOW_MS, durationMs);
      applyView(center - newSpan / 2, center + newSpan / 2);
    },
    [view.startMs, view.endMs, span, durationMs, applyView],
  );

  if (!project) return null;

  const atFull = view.startMs <= 0 && view.endMs >= durationMs;

  return (
    <section
      aria-label="Timeline"
      className="relative select-none space-y-2.5 overscroll-contain border-t bg-card/40 px-4 py-3"
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && selectedKeyframe != null) {
          e.preventDefault();
          removeZoomRegion(selectedKeyframe);
          onSelectKeyframe(null);
        }
      }}
    >
      <Transport
        playing={playing}
        onTogglePlay={props.onTogglePlay}
        playheadMs={playheadMs}
        durationMs={durationMs}
        onAddZoom={() => addZoomRegion(playheadMs)}
        onAddCut={() => addCut(playheadMs)}
        onZoomIn={() => zoomAroundCenter(1 / ZOOM_STEP)}
        onZoomOut={() => zoomAroundCenter(ZOOM_STEP)}
        onZoomToFit={() => applyView(0, durationMs)}
        canZoomIn={span > MIN_WINDOW_MS + 1}
        canZoomOut={!atFull}
      />

      {/* Full-width, clipped (no scroll → no scrollbar). The wheel listener binds here. */}
      <div className="relative overflow-hidden">
        <div ref={laneRef} className="relative space-y-1.5">
          <Ruler scale={scale} playheadMs={playheadMs} onScrub={onSeek} />
          <ClipTrack scale={scale} trim={project.trim} setTrim={setTrim} onSeek={onSeek} />
          <ZoomTrack
            scale={scale}
            regions={project.zoom}
            selected={selectedKeyframe}
            onSelect={onSelectKeyframe}
            addZoomRegion={addZoomRegion}
            updateZoomRegion={updateZoomRegion}
            onSeek={onSeek}
          />
          <CutTrack
            scale={scale}
            cuts={project.cuts}
            addCut={addCut}
            updateCut={updateCut}
            removeCut={removeCut}
            onSeek={onSeek}
          />
          <Playhead scale={scale} playheadMs={playheadMs} onSeek={onSeek} />
        </div>
      </div>
    </section>
  );
}
