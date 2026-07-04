// Dashboard.tsx
//
// HOME library of recordings. Renders a responsive grid of recording cards from
// the zustand store's `recordings` (populated by `loadRecordings`). Each card
// shows its thumbnail, a duration badge, a relative date, and on hover exposes
// Edit + Delete actions. A prominent "New Recording" CTA switches to the record
// view; a clean empty state shows when the library is empty.
//
// All media paths are resolved through Tauri's convertFileSrc; library mutations
// go through the pinned Rust commands (load_recording / delete_recording).

import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Film, Pencil, Plus, Trash2, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store";
import type { RecordingMeta } from "@/lib/timeline";
import { loadProjectForRecording } from "@/components/Recorder";

// ── Formatting helpers ───────────────────────────────────────────────────────

/** mm:ss (or h:mm:ss) from a millisecond duration. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** "just now" / "5 min ago" / "3 days ago" / fallback to a locale date. */
function formatRelative(createdMs: number): string {
  if (!Number.isFinite(createdMs) || createdMs <= 0) return "";
  const diff = Date.now() - createdMs;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? "day" : "days"} ago`;
  return new Date(createdMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Duration badge (inline shadcn-style; no badge.tsx in ui/*) ───────────────

function DurationBadge({ ms }: { ms: number }) {
  return (
    <span
      className={cn(
        "pointer-events-none inline-flex items-center gap-1 rounded-md",
        "bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        "text-white ring-1 ring-white/15 backdrop-blur-sm",
      )}
    >
      <Film className="size-3 opacity-80" />
      {formatDuration(ms)}
    </span>
  );
}

// ── A single recording card ──────────────────────────────────────────────────

function RecordingCard({
  rec,
  onEdit,
  onDelete,
  busy,
}: {
  rec: RecordingMeta;
  onEdit: (rec: RecordingMeta) => void;
  onDelete: (rec: RecordingMeta) => void;
  busy: boolean;
}) {
  // Thumbnail = a real frame from the recording itself (no ffmpeg poster needed).
  const [thumbFailed, setThumbFailed] = useState(false);
  const trimStart = rec.trimStartMs ?? 0;
  const [dur, setDur] = useState(() =>
    Math.max(0, (rec.trimEndMs > trimStart ? rec.trimEndMs : rec.durationMs) - trimStart),
  );
  const screenSrc = convertFileSrc(rec.screenPath);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      whileHover={{ y: -4 }}
      className="group/recording"
    >
      <Card
        size="sm"
        className="gap-0 py-0 transition-shadow duration-200 group-hover/recording:ring-foreground/25 group-hover/recording:shadow-lg group-hover/recording:shadow-black/20"
      >
        {/* Thumbnail (16:9) */}
        <div className="relative aspect-video w-full overflow-hidden rounded-t-xl bg-muted">
          {!thumbFailed ? (
            <video
              src={screenSrc}
              crossOrigin="anonymous"
              muted
              playsInline
              preload="metadata"
              draggable={false}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) {
                  const rawMs = v.duration * 1000;
                  // The head of screen.mp4 is the auto-trimmed countdown — badge
                  // shows the trimmed length, thumbnail seeks past the trim point.
                  const endMs =
                    rec.trimEndMs > trimStart ? Math.min(rec.trimEndMs, rawMs) : rawMs;
                  const span = Math.max(0, endMs - trimStart);
                  setDur(span);
                  v.currentTime = (trimStart + Math.min(1000, span * 0.1)) / 1000;
                }
              }}
              onError={() => setThumbFailed(true)}
              className="size-full object-cover transition-transform duration-300 group-hover/recording:scale-[1.03]"
            />
          ) : (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-muted to-muted/40">
              <Film className="size-8 text-muted-foreground/50" />
            </div>
          )}

          {/* Duration badge */}
          <div className="absolute bottom-2 right-2">
            <DurationBadge ms={dur} />
          </div>

          {/* Hover actions */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center gap-2",
              "bg-black/45 opacity-0 backdrop-blur-[2px] transition-opacity duration-200",
              "group-hover/recording:opacity-100 focus-within:opacity-100",
            )}
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onEdit(rec)}
            >
              <Pencil />
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => onDelete(rec)}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>

        {/* Meta footer */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="truncate text-sm font-medium" title={rec.id}>
            {rec.id}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelative(rec.createdMs)}
          </span>
        </div>
      </Card>
    </motion.div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 bg-card/40 px-6 py-20 text-center"
    >
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-muted ring-1 ring-foreground/10">
        <Film className="size-6 text-muted-foreground" />
      </div>
      <h2 className="font-heading text-lg font-medium">No recordings yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Capture your screen, mic, and camera. Your recordings will appear here,
        ready to polish and export.
      </p>
      <Button size="lg" className="mt-6" onClick={onNew}>
        <Video />
        New Recording
      </Button>
    </motion.div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const recordings = useAppStore((s) => s.recordings);
  const loadRecordings = useAppStore((s) => s.loadRecordings);
  const setView = useAppStore((s) => s.setView);
  const setProject = useAppStore((s) => s.setProject);

  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  const handleNew = () => setView("record");

  const handleEdit = async (rec: RecordingMeta) => {
    if (busyId) return;
    setBusyId(rec.id);
    try {
      // Prefers project.json; falls back to rebuilding from raw files (older
      // recordings) and self-heals by saving it back.
      const project = await loadProjectForRecording(rec);
      setProject(project);
      setView("edit");
    } catch (e) {
      console.error("open recording failed", e);
      toast.error("Couldn't open recording", {
        description: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (rec: RecordingMeta) => {
    if (busyId) return;
    const confirmed = await ask("Delete this recording permanently?", {
      title: "Delete recording",
      kind: "warning",
    });
    if (!confirmed) return;
    setBusyId(rec.id);
    try {
      await invoke("delete_recording", { id: rec.id });
      await loadRecordings();
      toast.success("Recording deleted");
    } catch (e) {
      console.error("delete_recording failed", e);
      toast.error("Couldn't delete recording", {
        description: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusyId(null);
    }
  };

  const hasRecordings = recordings.length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Library
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasRecordings
              ? `${recordings.length} ${
                  recordings.length === 1 ? "recording" : "recordings"
                }`
              : "Your recordings live here"}
          </p>
        </div>
        <Button size="lg" onClick={handleNew}>
          <Plus />
          New Recording
        </Button>
      </header>

      {/* Body */}
      {hasRecordings ? (
        <motion.div
          layout
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <AnimatePresence mode="popLayout">
            {recordings.map((rec) => (
              <RecordingCard
                key={rec.id}
                rec={rec}
                busy={busyId === rec.id}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <EmptyState onNew={handleNew} />
      )}
    </div>
  );
}
