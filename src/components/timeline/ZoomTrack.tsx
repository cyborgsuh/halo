// timeline/ZoomTrack.tsx
//
// Each ZoomRegion as a labelled block (×scale): drag the BODY to move, drag the
// EDGES to resize, CLICK EMPTY lane to add a ~1.5s block, click to select (drives
// the Inspector), Delete/⌫ or a button to remove. The selected block is ringed.
// Drags use setPointerCapture; the live store action runs on every move.

import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import type { ZoomRegion } from "@/lib/timeline";
import {
  clamp,
  DragZone,
  MIN_REGION_MS,
  predictAddedIndex,
  type TimeScale,
} from "./shared";

export interface ZoomTrackProps {
  scale: TimeScale;
  regions: ZoomRegion[];
  selected: number | null;
  onSelect: (i: number | null) => void;
  addZoomRegion: (startMs: number, endMs?: number, scale?: number) => void;
  updateZoomRegion: (index: number, patch: Partial<ZoomRegion>) => void;
  onSeek: (ms: number) => void;
}

/** How close (px) to an edge counts as an edge-grab vs a body-grab. */
const EDGE_PX = 9;

export default function ZoomTrack({
  scale,
  regions,
  selected,
  onSelect,
  addZoomRegion,
  updateZoomRegion,
  onSeek,
}: ZoomTrackProps) {
  const reduce = useReducedMotion();
  const { durationMs, xAt } = scale;

  // Live drag state. We resolve neighbour bounds on each move so blocks never
  // cross each other (keeps the store's ascending/non-overlapping invariant and
  // the region index stable while dragging).
  const drag = useRef<{
    index: number;
    zone: DragZone;
    grabMs: number;
    orig: ZoomRegion;
  } | null>(null);

  const bounds = (index: number) => {
    const lo = index > 0 ? regions[index - 1].endMs : 0;
    const hi = index < regions.length - 1 ? regions[index + 1].startMs : durationMs;
    return { lo, hi };
  };

  const onBlockDown =
    (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      onSelect(index);
      const r = regions[index];
      const localX = e.clientX - e.currentTarget.getBoundingClientRect().left;
      const width = e.currentTarget.getBoundingClientRect().width;
      let zone: DragZone = "move";
      if (localX <= EDGE_PX) zone = "resize-start";
      else if (localX >= width - EDGE_PX) zone = "resize-end";
      drag.current = { index, zone, grabMs: scale.timeAtX(e.clientX), orig: r };
    };

  const onBlockMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = scale.timeAtX(e.clientX);
    const { lo, hi } = bounds(d.index);
    if (d.zone === "resize-start") {
      const startMs = clamp(t, lo, d.orig.endMs - MIN_REGION_MS);
      updateZoomRegion(d.index, { startMs });
    } else if (d.zone === "resize-end") {
      const endMs = clamp(t, d.orig.startMs + MIN_REGION_MS, hi);
      updateZoomRegion(d.index, { endMs });
    } else {
      const w = d.orig.endMs - d.orig.startMs;
      const startMs = clamp(d.orig.startMs + (t - d.grabMs), lo, hi - w);
      updateZoomRegion(d.index, { startMs, endMs: startMs + w });
    }
  };

  const onBlockUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const addAt = (ms: number) => {
    const { index, startMs, endMs } = predictAddedIndex(regions, ms, durationMs);
    addZoomRegion(startMs, endMs);
    onSelect(index);
    onSeek(startMs);
  };

  return (
    <div
      onPointerDown={(e) => {
        // Click on the empty lane moves the playhead (consistent with the rest of
        // the timeline). Add a zoom with the "+ Zoom" button or double-click.
        if (e.target === e.currentTarget) onSeek(scale.timeAtX(e.clientX));
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) addAt(scale.timeAtX(e.clientX));
      }}
      className={cn(
        "relative h-10 w-full cursor-text touch-none select-none rounded-lg",
        "border border-dashed border-border/50 bg-muted/20",
      )}
    >
      {regions.map((r, i) => {
        const left = xAt(r.startMs);
        const width = Math.max(2, xAt(r.endMs) - xAt(r.startMs));
        const isSel = selected === i;
        return (
          <motion.div
            key={i}
            role="button"
            tabIndex={0}
            aria-label={`Zoom ×${r.scale.toFixed(1)} from ${Math.round(
              r.startMs,
            )} to ${Math.round(r.endMs)} ms`}
            aria-pressed={isSel}
            onPointerDown={onBlockDown(i)}
            onPointerMove={onBlockMove}
            onPointerUp={onBlockUp}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(i);
                onSeek(r.startMs);
              }
            }}
            initial={false}
            animate={{
              boxShadow: isSel
                ? "0 0 0 1.5px var(--primary)"
                : "0 0 0 0px transparent",
            }}
            transition={reduce ? { duration: 0 } : { duration: 0.18 }}
            style={{ left, width }}
            className={cn(
              "group/zoom absolute inset-y-1 flex cursor-grab items-center overflow-hidden rounded-md px-2 outline-none active:cursor-grabbing",
              isSel
                ? "bg-primary/30 text-primary-foreground"
                : "bg-primary/15 hover:bg-primary/25",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
            )}
          >
            {/* edge affordances */}
            <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-primary/0 transition-colors group-hover/zoom:bg-primary/40" />
            <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-primary/0 transition-colors group-hover/zoom:bg-primary/40" />
            <span className="pointer-events-none truncate text-[10px] font-semibold tabular-nums text-foreground/90">
              ×{r.scale.toFixed(1)}
            </span>
          </motion.div>
        );
      })}

      {regions.length === 0 && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted-foreground/70">
          Double-click or “+ Zoom” to add
        </span>
      )}
    </div>
  );
}
