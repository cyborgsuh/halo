import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, Minus, Square, X } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";

// Custom window controls (the main window is frameless: decorations:false).
function WindowControls() {
  const win = getCurrentWindow();
  const btn =
    "grid h-10 w-12 place-items-center text-muted-foreground outline-none transition-colors";
  return (
    <div className="flex items-center self-stretch">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
        className={btn + " hover:bg-muted hover:text-foreground"}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => void win.toggleMaximize()}
        className={btn + " hover:bg-muted hover:text-foreground"}
      >
        <Square className="size-3" />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => void win.close()}
        className={btn + " hover:bg-destructive hover:text-white"}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
import Dashboard from "@/components/Dashboard";
import Recorder from "@/components/Recorder";
import Editor from "@/components/Editor";
import RecBar from "@/components/RecBar";
import CamPreview from "@/components/CamPreview";
import { useAppStore, type AppView } from "@/store";

// ── Window routing ───────────────────────────────────────────────────────────
// The floating recording bar is a SEPARATE Tauri window (label "rec-bar") that
// loads the same frontend at hash "#recbar". When we are that window, render the
// bare <RecBar/> chrome — no shell, no header, no nav. Everything else is the
// normal app.
function isRecBarWindow(): boolean {
  if (typeof window !== "undefined" && window.location.hash === "#recbar") return true;
  try {
    return getCurrentWindow().label === "rec-bar";
  } catch {
    // Not running under Tauri (e.g. plain web dev) — never the rec bar.
    return false;
  }
}

function isCamPreviewWindow(): boolean {
  if (typeof window !== "undefined" && window.location.hash === "#campreview") return true;
  try {
    return getCurrentWindow().label === "cam-preview";
  } catch {
    return false;
  }
}

// ── View transitions ─────────────────────────────────────────────────────────

const viewMotion = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

function ViewPane({ view }: { view: AppView }) {
  switch (view) {
    case "dashboard":
      return <Dashboard />;
    case "record":
      return <Recorder />;
    case "edit":
      return <Editor />;
    default:
      return null;
  }
}

export default function App() {
  // Decide once per mount which kind of window this is.
  const recBar = useMemo(isRecBarWindow, []);
  const camPreview = useMemo(isCamPreviewWindow, []);
  const isOverlay = recBar || camPreview;

  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const loadRecordings = useAppStore((s) => s.loadRecordings);
  const recStatus = useAppStore((s) => s.recording.status);
  const processing = recStatus === "stopping" || recStatus === "processing";

  // Populate the library on first paint of the main app.
  useEffect(() => {
    if (isOverlay) return;
    void loadRecordings();
  }, [isOverlay, loadRecordings]);

  // Overlay windows (rec-bar pill, cam-preview circle) are transparent — clear
  // the opaque body bg that index.css applies globally, or it shows as a square.
  useEffect(() => {
    if (!isOverlay) return;
    const prev = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.body.style.background = prev;
    };
  }, [isOverlay]);

  // Floating camera preview window: bare circle only.
  if (camPreview) {
    return (
      <TooltipProvider>
        <CamPreview />
      </TooltipProvider>
    );
  }

  // Floating bar window: bare chrome only.
  if (recBar) {
    return (
      <TooltipProvider>
        <div className="dark h-screen w-screen overflow-hidden bg-transparent text-foreground">
          <RecBar />
          <Toaster />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="dark flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {/* Slim header: title + nav back to the dashboard library. */}
        <header
          data-tauri-drag-region
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background pl-3 pr-0"
        >
          <button
            type="button"
            onClick={() => setView("dashboard")}
            className="mr-auto flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-block size-2 rounded-full bg-primary" aria-hidden />
            Halo
          </button>

          {view !== "dashboard" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("dashboard")}
              className="text-muted-foreground hover:text-foreground"
            >
              ← Library
            </Button>
          )}

          <WindowControls />
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className={
                "absolute inset-0 " + (view === "edit" ? "overflow-hidden" : "overflow-auto")
              }
              initial={viewMotion.initial}
              animate={viewMotion.animate}
              exit={viewMotion.exit}
              transition={viewMotion.transition}
            >
              <ViewPane view={view} />
            </motion.div>
          </AnimatePresence>
        </main>

        <AnimatePresence>
          {processing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <Loader2 className="size-7 animate-spin text-primary" />
                <p className="text-sm font-medium">Processing recording…</p>
                <p className="text-xs text-muted-foreground">
                  Finalizing video, audio and auto-zoom.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
