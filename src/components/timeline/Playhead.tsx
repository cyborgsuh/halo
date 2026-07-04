// timeline/Playhead.tsx
//
// One draggable vertical line across all tracks. Its x is bound directly to
// `playheadMs` (no spring on position — that would lag the play loop, which
// already updates per rAF). framer-motion is used only for the grab-handle's
// hover/drag STATE feedback, and is disabled under prefers-reduced-motion.

import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import type { TimeScale } from "./shared";

export interface PlayheadProps {
  scale: TimeScale;
  playheadMs: number;
  onSeek: (ms: number) => void;
}

export default function Playhead({ scale, playheadMs, onSeek }: PlayheadProps) {
  const reduce = useReducedMotion();
  const dragging = useRef(false);
  const x = scale.xAt(playheadMs);

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary"
      style={{ transform: `translateX(${x}px)` }}
    >
      {/* grab handle at the top — the only interactive part */}
      <motion.button
        type="button"
        aria-label="Playhead"
        whileHover={reduce ? undefined : { scale: 1.15 }}
        whileTap={reduce ? undefined : { scale: 0.92 }}
        transition={{ duration: 0.15 }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
        }}
        onPointerMove={(e) => {
          if (dragging.current) onSeek(scale.timeAtX(e.clientX));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        className={cn(
          "pointer-events-auto absolute -top-1 left-1/2 size-3 -translate-x-1/2 cursor-ew-resize touch-none rounded-full border-2 border-background bg-primary outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
      />
    </div>
  );
}
