// timeline/Ruler.tsx
//
// The time ruler: labelled major ticks (m:ss) + minor ticks. Click or drag
// anywhere to scrub. Pointer drags use setPointerCapture so the scrub keeps
// tracking even if the pointer leaves the strip.

import { useCallback, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";
import { chooseTickMs, fmtClock, type TimeScale } from "./shared";

export interface RulerProps {
  scale: TimeScale;
  /** Current playhead (only used to keep aria state meaningful). */
  playheadMs: number;
  onScrub: (ms: number) => void;
}

export default function Ruler({ scale, playheadMs, onScrub }: RulerProps) {
  const dragging = useRef(false);

  const ticks = useMemo(() => {
    const { durationMs, pxPerMs } = scale;
    if (durationMs <= 0 || pxPerMs <= 0) return [];
    const major = chooseTickMs(pxPerMs);
    const minor = major / 2;
    const out: Array<{ ms: number; major: boolean }> = [];
    for (let ms = 0; ms <= durationMs + 1; ms += minor) {
      const isMajor = Math.round(ms / minor) % 2 === 0;
      out.push({ ms, major: isMajor });
    }
    return out;
  }, [scale]);

  const scrub = useCallback(
    (clientX: number) => onScrub(scale.timeAtX(clientX)),
    [scale, onScrub],
  );

  return (
    <div
      role="slider"
      aria-label="Scrub timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(scale.durationMs)}
      aria-valuenow={Math.round(playheadMs)}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 1000 : 100;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onScrub(Math.max(0, playheadMs - step));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onScrub(Math.min(scale.durationMs, playheadMs + step));
        } else if (e.key === "Home") {
          e.preventDefault();
          onScrub(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onScrub(scale.durationMs);
        }
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        scrub(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrub(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      className={cn(
        "relative h-7 w-full cursor-text touch-none select-none",
        "rounded-md text-muted-foreground outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      {ticks.map((t, i) => {
        const left = scale.xAt(t.ms);
        return (
          <div
            key={i}
            className={cn(
              "pointer-events-none absolute bottom-0 w-px",
              t.major ? "h-3 bg-border" : "h-1.5 bg-border/50",
            )}
            style={{ left }}
          >
            {t.major && (
              <span className="absolute -top-3.5 left-1 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                {fmtClock(t.ms)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
