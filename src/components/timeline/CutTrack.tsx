// timeline/CutTrack.tsx
//
// Cut (trim-in-the-middle) blocks: each marks a span REMOVED from the video.
// Drag the body to move, drag edges to resize, double-click empty to add,
// hover a block for its delete (×). Preview playback + export skip these spans.

import { useRef } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Cut } from "@/lib/timeline";
import { clamp, DragZone, MIN_REGION_MS, type TimeScale } from "./shared";

export interface CutTrackProps {
  scale: TimeScale;
  cuts: Cut[];
  addCut: (startMs: number, endMs?: number) => void;
  updateCut: (index: number, patch: Partial<Cut>) => void;
  removeCut: (index: number) => void;
  onSeek: (ms: number) => void;
}

const EDGE_PX = 9;

export default function CutTrack({
  scale,
  cuts,
  addCut,
  updateCut,
  removeCut,
  onSeek,
}: CutTrackProps) {
  const { durationMs, xAt } = scale;
  const drag = useRef<{ index: number; zone: DragZone; grabMs: number; orig: Cut } | null>(
    null,
  );

  const bounds = (index: number) => {
    const lo = index > 0 ? cuts[index - 1].endMs : 0;
    const hi = index < cuts.length - 1 ? cuts[index + 1].startMs : durationMs;
    return { lo, hi };
  };

  const onBlockDown = (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    let zone: DragZone = "move";
    if (localX <= EDGE_PX) zone = "resize-start";
    else if (localX >= rect.width - EDGE_PX) zone = "resize-end";
    drag.current = { index, zone, grabMs: scale.timeAtX(e.clientX), orig: cuts[index] };
  };

  const onBlockMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = scale.timeAtX(e.clientX);
    const { lo, hi } = bounds(d.index);
    if (d.zone === "resize-start") {
      updateCut(d.index, { startMs: clamp(t, lo, d.orig.endMs - MIN_REGION_MS) });
    } else if (d.zone === "resize-end") {
      updateCut(d.index, { endMs: clamp(t, d.orig.startMs + MIN_REGION_MS, hi) });
    } else {
      const w = d.orig.endMs - d.orig.startMs;
      const startMs = clamp(d.orig.startMs + (t - d.grabMs), lo, hi - w);
      updateCut(d.index, { startMs, endMs: startMs + w });
    }
  };

  const onBlockUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const addAt = (ms: number) => {
    const start = clamp(ms, 0, Math.max(0, durationMs - 1));
    addCut(start, Math.min(durationMs, start + 1000));
  };

  return (
    <div
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSeek(scale.timeAtX(e.clientX));
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) addAt(scale.timeAtX(e.clientX));
      }}
      className={cn(
        "relative h-8 w-full cursor-text touch-none select-none rounded-lg",
        "border border-dashed border-destructive/30 bg-destructive/5",
      )}
    >
      {cuts.map((c, i) => {
        const left = xAt(c.startMs);
        const width = Math.max(2, xAt(c.endMs) - xAt(c.startMs));
        return (
          <div
            key={i}
            onPointerDown={onBlockDown(i)}
            onPointerMove={onBlockMove}
            onPointerUp={onBlockUp}
            style={{ left, width }}
            className={cn(
              "group/cut absolute inset-y-1 flex cursor-grab items-center justify-center",
              "overflow-hidden rounded-md bg-destructive/30 ring-1 ring-inset ring-destructive/50",
              "active:cursor-grabbing",
            )}
          >
            <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize group-hover/cut:bg-destructive/50" />
            <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize group-hover/cut:bg-destructive/50" />
            <button
              type="button"
              aria-label="Remove cut"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => removeCut(i)}
              className="z-10 grid size-4 place-items-center rounded-sm bg-background/60 text-destructive opacity-0 transition-opacity group-hover/cut:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}

      {cuts.length === 0 && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted-foreground/60">
          Double-click or “+ Cut” to remove a section
        </span>
      )}
    </div>
  );
}
