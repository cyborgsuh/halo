// timeline/ClipTrack.tsx
//
// The video as ONE rounded clip. The region outside the trim window is dimmed;
// drag the left/right ends to trim (writes project.trim via setTrim). Edge
// handles reveal on hover and are keyboard-nudgeable.

import { useRef } from "react";
import { Film } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Trim } from "@/lib/timeline";
import { clamp, fmtClock, MIN_TRIM_MS, type TimeScale } from "./shared";

export interface ClipTrackProps {
  scale: TimeScale;
  trim: Trim;
  setTrim: (trim: Trim) => void;
  onSeek: (ms: number) => void;
}

type Edge = "start" | "end" | null;

export default function ClipTrack({ scale, trim, setTrim, onSeek }: ClipTrackProps) {
  const drag = useRef<Edge>(null);
  const { durationMs, xAt } = scale;

  const startX = xAt(trim.startMs);
  const endX = xAt(trim.endMs);

  const applyStart = (ms: number) =>
    setTrim({ startMs: clamp(ms, 0, trim.endMs - MIN_TRIM_MS), endMs: trim.endMs });
  const applyEnd = (ms: number) =>
    setTrim({
      startMs: trim.startMs,
      endMs: clamp(ms, trim.startMs + MIN_TRIM_MS, durationMs),
    });

  const onHandleDown =
    (edge: Exclude<Edge, null>) => (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = edge;
    };
  const onHandleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    const t = scale.timeAtX(e.clientX);
    if (drag.current === "start") applyStart(t);
    else applyEnd(t);
  };
  const onHandleUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onHandleKey =
    (edge: Exclude<Edge, null>) => (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 1000 : 100;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const cur = edge === "start" ? trim.startMs : trim.endMs;
      if (edge === "start") applyStart(cur + dir * step);
      else applyEnd(cur + dir * step);
    };

  return (
    <div
      className="relative h-11 w-full cursor-text select-none"
      onPointerDown={(e) => {
        // Click on the track bed (not a handle) moves the playhead there.
        if (e.target === e.currentTarget) onSeek(scale.timeAtX(e.clientX));
      }}
    >
      {/* full-length track bed (the untrimmed source, behind) */}
      <div className="pointer-events-none absolute inset-0 rounded-lg border border-border/50 bg-muted/20" />

      {/* trimmed-away regions outside the window — clearly dimmed + desaturated */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg bg-background/75 ring-1 ring-inset ring-border/40"
        style={{ width: Math.max(0, startX) }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 rounded-r-lg bg-background/75 ring-1 ring-inset ring-border/40"
        style={{ left: endX, right: 0 }}
      />

      {/* the trimmed-in clip */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 flex items-center gap-2 overflow-hidden rounded-lg px-3",
          "border border-border bg-gradient-to-b from-secondary to-secondary/70 shadow-sm",
        )}
        style={{ left: startX, width: Math.max(0, endX - startX) }}
      >
        <Film className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground/80">
          Clip
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtClock(trim.endMs - trim.startMs)}
        </span>
      </div>

      {/* trim handles */}
      <TrimHandle
        side="start"
        x={startX}
        label={`Trim start ${fmtClock(trim.startMs)}`}
        onPointerDown={onHandleDown("start")}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onKeyDown={onHandleKey("start")}
      />
      <TrimHandle
        side="end"
        x={endX}
        label={`Trim end ${fmtClock(trim.endMs)}`}
        onPointerDown={onHandleDown("end")}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onKeyDown={onHandleKey("end")}
      />
    </div>
  );
}

function TrimHandle(props: {
  side: "start" | "end";
  x: number;
  label: string;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onKeyDown={props.onKeyDown}
      style={{ left: props.x }}
      className={cn(
        "group/handle absolute inset-y-0 z-10 -ml-2 flex w-4 cursor-ew-resize touch-none items-center justify-center outline-none",
      )}
    >
      <span
        className={cn(
          "h-7 w-1 rounded-full bg-foreground/30 transition-all",
          "group-hover/handle:h-9 group-hover/handle:bg-primary",
          "group-focus-visible/handle:h-9 group-focus-visible/handle:bg-primary group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-ring/50",
          "group-active/handle:bg-primary",
        )}
      />
    </button>
  );
}
