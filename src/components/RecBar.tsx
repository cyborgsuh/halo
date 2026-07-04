// RecBar.tsx
//
// The floating control bar shown during a recording. It lives in a SEPARATE Tauri
// window (label "rec-bar", loaded at hash "#recbar"), so it has its own JS context
// — it cannot read the main window's zustand store. Instead it talks to Rust
// directly and coordinates with the main window via a Tauri event:
//
//   Stop  →  stop_recording(sessionId)
//         →  emit("recording-stopped", <StopRecordingResult>)   (main window finalizes)
//         →  close_rec_bar()
//
// The session id + start time are handed across the window boundary through
// localStorage (same origin → shared storage), written by the main window before
// it opens the bar. See writeRecBarSession() below.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { motion } from "framer-motion";
import { Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { writeCamPreviewDevice } from "@/components/CamPreview";
import { stopRecording } from "@/lib/capture";

// ── Cross-window session handoff (localStorage is shared across same-origin windows) ──

export interface RecBarSession {
  sessionId: string;
  /** Wall-clock (Date.now) the recording began — drives the bar's elapsed timer. */
  startedAtMs: number;
}

export const REC_BAR_SESSION_KEY = "recbar.session";

export function writeRecBarSession(session: RecBarSession): void {
  try {
    localStorage.setItem(REC_BAR_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — bar will fall back to "now" for the timer */
  }
}

export function readRecBarSession(): RecBarSession | null {
  try {
    const raw = localStorage.getItem(REC_BAR_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as RecBarSession;
    return typeof o.sessionId === "string" ? o : null;
  } catch {
    return null;
  }
}

export function clearRecBarSession(): void {
  try {
    localStorage.removeItem(REC_BAR_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function RecBar() {
  // This window PERSISTS hidden across recordings (close_rec_bar hides, never
  // destroys — that's what makes it appear instantly). So session state is
  // synced CONTINUOUSLY, never latched: localStorage poll + cross-window
  // "storage" events + the "rec-bar-session-ready" nudge. A cleared session
  // (stop) resets the bar for the next recording.
  const [session, setSession] = useState<RecBarSession | null>(readRecBarSession);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const apply = () => {
      const s = readRecBarSession();
      setSession((prev) =>
        prev?.sessionId === s?.sessionId && prev?.startedAtMs === s?.startedAtMs
          ? prev
          : s,
      );
    };
    apply();
    const id = window.setInterval(apply, 150);
    window.addEventListener("storage", apply);
    const un = listen("rec-bar-session-ready", apply);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("storage", apply);
      void un.then((u) => u());
    };
  }, []);

  const sessionId = session?.sessionId ?? "";
  const ready = sessionId !== "";
  const startedAtMs = session?.startedAtMs ?? 0;

  // A new session (placeholder or real) arrived — clear the previous run's UI.
  useEffect(() => {
    setStopping(false);
  }, [sessionId, startedAtMs]);

  useEffect(() => {
    setElapsed(Date.now() - startedAtMs);
    const id = window.setInterval(() => setElapsed(Date.now() - startedAtMs), 250);
    return () => window.clearInterval(id);
  }, [startedAtMs]);

  // startedAtMs is in the FUTURE while the 3-2-1 plays → elapsed is negative.
  const counting = elapsed < 0;
  const countNum = Math.max(1, Math.ceil(-elapsed / 1000));

  const onStop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      if (sessionId) {
        // Stop native screen capture; hand the payload to the main window so it
        // can flush mic/cam, run auto-zoom and build the editable project.
        const stopRes = await stopRecording(sessionId);
        await emit("recording-stopped", stopRes);
      } else {
        // No session handoff (shouldn't happen) — still tell the main window to recover.
        await emit("recording-stopped", null);
      }
    } catch (e) {
      console.error("rec-bar: stop failed", e);
      // Surface to the main window so it can un-minimize rather than stay stuck.
      try {
        await emit("recording-stopped", null);
      } catch {
        /* ignore */
      }
    } finally {
      clearRecBarSession();
      // Hide the camera preview too and release its camera (device-key gate) —
      // same action, most reliable place to do it.
      writeCamPreviewDevice(null);
      try {
        await invoke("close_cam_preview");
      } catch {
        /* not open */
      }
      try {
        await invoke("close_rec_bar");
      } catch {
        /* window may already be hiding */
      }
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="dark flex h-screen w-screen items-center gap-3 rounded-2xl border border-border bg-card px-4 text-card-foreground select-none"
    >
      {/* live indicator */}
      <span className="relative flex size-3 items-center justify-center">
        <motion.span
          aria-hidden
          className="absolute inline-flex size-full rounded-full bg-destructive/60"
          animate={{ scale: [1, 1.9], opacity: [0.7, 0] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
        />
        <span className="relative size-3 rounded-full bg-destructive" />
      </span>

      <span className="font-mono text-lg font-medium tabular-nums">
        {counting ? `Starting in ${countNum}…` : fmtElapsed(elapsed)}
      </span>

      <Button
        variant="destructive"
        size="sm"
        className="ml-auto"
        onClick={() => void onStop()}
        disabled={stopping || !ready || counting}
      >
        <Square className="size-4" />
        {stopping ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}
