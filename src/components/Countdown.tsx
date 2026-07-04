// Countdown.tsx
//
// A full-window 3-2-1 overlay shown right before a recording starts. Each tick
// animates (scale + fade) via framer-motion. Configurable duration; `onComplete`
// fires exactly once after the final tick. Dark, shadcn-flavoured styling.
//
// The parent owns mount/unmount (wrap in <AnimatePresence> for the exit fade).

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface CountdownProps {
  /** How many ticks to count down from (default 3 → "3, 2, 1"). */
  seconds?: number;
  /** Called once, after the last tick elapses. */
  onComplete: () => void;
}

export default function Countdown({ seconds = 3, onComplete }: CountdownProps) {
  const [count, setCount] = useState(() => Math.max(1, Math.floor(seconds)));
  // Latch so onComplete can never fire twice (StrictMode / re-render safe).
  const done = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (count <= 0) {
      if (!done.current) {
        done.current = true;
        onCompleteRef.current();
      }
      return;
    }
    const id = window.setTimeout(() => setCount((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [count]);

  return (
    <motion.div
      className="dark fixed inset-0 z-[100] grid place-items-center bg-background/85 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="flex flex-col items-center gap-8">
        <div className="relative grid size-52 place-items-center">
          {/* breathing ring */}
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border border-primary/40"
            animate={{ scale: [1, 1.12, 1], opacity: [0.6, 0.12, 0.6] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.span
            aria-hidden
            className="absolute inset-6 rounded-full bg-primary/5"
            animate={{ scale: [0.9, 1.05, 0.9] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          />
          <AnimatePresence mode="popLayout">
            <motion.span
              key={count}
              className="font-mono text-8xl font-semibold tabular-nums text-foreground"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.6, opacity: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 24 }}
            >
              {count > 0 ? count : ""}
            </motion.span>
          </AnimatePresence>
        </div>

        <motion.p
          className="text-xs font-medium uppercase tracking-[0.35em] text-muted-foreground"
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          Recording starts
        </motion.p>
      </div>
    </motion.div>
  );
}
