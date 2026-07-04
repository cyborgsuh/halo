// Inspector.tsx
//
// Right-hand property panel (shadcn Tabs: Style / Camera / Zoom / Export).
// Screen-Studio airy: calm grouped sections, one control vocabulary (Field +
// Slider/Select/Button), restrained accent. Reads the document from the store
// and mutates it through the store actions. The Zoom tab is CONTEXTUAL — when a
// zoom block is selected on the timeline it surfaces that region's scale plus
// the global zoom-speed + cursor-follow motion. playhead/selection are owned by
// Editor and passed in; the Export button frame-steps the live renderer.

import { useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import {
  Download,
  Image as ImageIcon,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAppStore } from "@/store";
import { DEFAULT_ZOOM_DURATION_MS } from "@/lib/timeline";
import { exportProject, AbortError } from "@/lib/export";
import { createMp4Demuxer } from "@/lib/mp4demuxer";

export interface InspectorProps {
  playheadMs: number;
  onSeek: (ms: number) => void;
  selectedKeyframe: number | null;
  onSelectKeyframe: (i: number | null) => void;
}

const GRADIENTS: Array<[string, string]> = [
  ["#1e293b", "#0f172a"],
  ["#7c3aed", "#4f46e5"],
  ["#f43f5e", "#f97316"],
  ["#0ea5e9", "#22d3ee"],
  ["#10b981", "#064e3b"],
  ["#000000", "#1f2937"],
];
const SOLIDS = ["#0f172a", "#111827", "#020617", "#ffffff", "#f43f5e", "#6366f1"];

// ── Shared layout vocabulary ────────────────────────────────────────────────

/** A titled group: small uppercase header + generous vertical rhythm. */
function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/** A labelled control row with an optional right-aligned readout. */
function Field(props: {
  label: string;
  value?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">{props.label}</Label>
        {props.value != null && (
          <span className="font-mono text-[11px] tabular-nums text-foreground/70">
            {props.value}
          </span>
        )}
      </div>
      {props.children}
      {props.hint && (
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {props.hint}
        </p>
      )}
    </div>
  );
}

/** A calm informational panel for empty / not-applicable states. */
function Hint(props: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      {props.children}
    </p>
  );
}

function num(v: number | readonly number[]): number {
  return Array.isArray(v) ? v[0] : (v as number);
}

export default function Inspector(props: InspectorProps) {
  const project = useAppStore((s) => s.project);
  const updateBackground = useAppStore((s) => s.updateBackground);
  const updateCamera = useAppStore((s) => s.updateCamera);
  const updateExport = useAppStore((s) => s.updateExport);
  const setCursorSmoothing = useAppStore((s) => s.setCursorSmoothing);
  const patchProject = useAppStore((s) => s.patchProject);
  const updateZoomRegion = useAppStore((s) => s.updateZoomRegion);
  const removeZoomRegion = useAppStore((s) => s.removeZoomRegion);
  const addZoomRegion = useAppStore((s) => s.addZoomRegion);

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = useReducedMotion();

  if (!project) return null;
  const bg = project.background;
  const cam = project.camera;
  const exp = project.export;

  const solidColor = typeof bg.value === "string" ? bg.value : bg.value[0];
  const grad: string[] = Array.isArray(bg.value) ? bg.value : [bg.value, bg.value];

  async function pickImage() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof path === "string") updateBackground({ type: "image", value: path });
    } catch (e) {
      toast.error("Could not open file: " + String(e));
    }
  }

  async function runExport() {
    if (!project) return;
    const ext = project.export.format;
    let outPath: string | null;
    try {
      outPath = await save({
        defaultPath: `recording.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
    } catch (e) {
      toast.error("Could not choose output: " + String(e));
      return;
    }
    if (!outPath) return;

    setExporting(true);
    setProgress(0);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // pull the screen (and optional cam) media into the webview as blobs
      const srcBlob = await (await fetch(convertFileSrc(project.source.screen))).blob();
      const camBlob = project.camera.file
        ? await (await fetch(convertFileSrc(project.camera.file))).blob()
        : null;

      const out = await exportProject({
        project,
        source: { blob: srcBlob, demuxer: createMp4Demuxer() },
        camera: camBlob ? { blob: camBlob } : null,
        audioPath: project.audio.mic || null,
        outPath,
        signal: ac.signal,
        onProgress: (p) => setProgress(p.ratio),
      });
      toast.success(`Exported → ${out}`);
    } catch (e) {
      if (e instanceof AbortError) toast.info("Export cancelled");
      else toast.error("Export failed: " + String(e));
    } finally {
      abortRef.current = null;
      setExporting(false);
    }
  }

  const selectedIndex = props.selectedKeyframe;
  const selRegion =
    selectedIndex != null ? project.zoom[selectedIndex] : undefined;
  const regionCount = project.zoom.length;

  return (
    <div className="p-5">
      <Tabs defaultValue="background" className="gap-5">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="background">Style</TabsTrigger>
          <TabsTrigger value="camera">Camera</TabsTrigger>
          <TabsTrigger value="zoom">Zoom</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
        </TabsList>

        {/* ── Style / background ── */}
        <TabsContent value="background" className="space-y-6">
          <Section title="Background">
            <Field label="Type">
              <Select
                value={bg.type}
                onValueChange={(v) => updateBackground({ type: v as typeof bg.type })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gradient">Gradient</SelectItem>
                  <SelectItem value="solid">Solid</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {bg.type === "gradient" && (
              <div className="space-y-3.5">
                <div className="grid grid-cols-3 gap-2">
                  {GRADIENTS.map((g, i) => {
                    const active = grad[0] === g[0] && grad[1] === g[1];
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => updateBackground({ value: g })}
                        style={{
                          backgroundImage: `linear-gradient(135deg, ${g[0]}, ${g[1]})`,
                        }}
                        className={
                          "h-9 rounded-md ring-1 ring-inset ring-border transition-[transform,box-shadow] hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                          (active
                            ? "outline outline-2 outline-offset-2 outline-primary"
                            : "")
                        }
                        aria-label={`Gradient ${g[0]} to ${g[1]}`}
                        aria-pressed={active}
                      />
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From">
                    <input
                      type="color"
                      value={grad[0]}
                      onChange={(e) =>
                        updateBackground({ value: [e.target.value, grad[1]] })
                      }
                      className="h-8 w-full cursor-pointer rounded-md border border-input bg-transparent"
                    />
                  </Field>
                  <Field label="To">
                    <input
                      type="color"
                      value={grad[1]}
                      onChange={(e) =>
                        updateBackground({ value: [grad[0], e.target.value] })
                      }
                      className="h-8 w-full cursor-pointer rounded-md border border-input bg-transparent"
                    />
                  </Field>
                </div>
              </div>
            )}

            {bg.type === "solid" && (
              <div className="space-y-3.5">
                <div className="grid grid-cols-6 gap-2">
                  {SOLIDS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateBackground({ value: c })}
                      style={{ backgroundColor: c }}
                      className={
                        "h-8 rounded-md ring-1 ring-inset ring-border transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                        (solidColor === c
                          ? "outline outline-2 outline-offset-2 outline-primary"
                          : "")
                      }
                      aria-label={`Solid ${c}`}
                      aria-pressed={solidColor === c}
                    />
                  ))}
                </div>
                <Field label="Custom">
                  <input
                    type="color"
                    value={solidColor}
                    onChange={(e) => updateBackground({ value: e.target.value })}
                    className="h-8 w-full cursor-pointer rounded-md border border-input bg-transparent"
                  />
                </Field>
              </div>
            )}

            {bg.type === "image" && (
              <div className="space-y-2">
                <Button variant="outline" className="w-full" onClick={pickImage}>
                  <ImageIcon className="size-4" /> Choose image…
                </Button>
                {typeof bg.value === "string" && bg.value && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {bg.value}
                  </p>
                )}
              </div>
            )}
          </Section>

          <Separator />

          <Section title="Framing">
            <Field label="Padding" value={`${bg.paddingPct}%`}>
              <Slider
                value={bg.paddingPct}
                min={0}
                max={30}
                step={1}
                onValueChange={(v) => updateBackground({ paddingPct: num(v) })}
              />
            </Field>
            <Field label="Corner radius" value={`${bg.radiusPx}px`}>
              <Slider
                value={bg.radiusPx}
                min={0}
                max={64}
                step={1}
                onValueChange={(v) => updateBackground({ radiusPx: num(v) })}
              />
            </Field>
            <Field label="Shadow" value={bg.shadow.toFixed(2)}>
              <Slider
                value={bg.shadow}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(v) => updateBackground({ shadow: num(v) })}
              />
            </Field>
          </Section>
        </TabsContent>

        {/* ── Camera bubble ── */}
        <TabsContent value="camera" className="space-y-6">
          {!cam.file && (
            <Hint>
              No webcam was captured for this recording. These settings apply
              when a camera track is present.
            </Hint>
          )}

          <Section title="Bubble">
            <Field label="Shape">
              <Select
                value={cam.shape}
                onValueChange={(v) => updateCamera({ shape: v as typeof cam.shape })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="circle">Circle</SelectItem>
                  <SelectItem value="rounded">Rounded square</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Position">
              <Select
                value={cam.pos}
                onValueChange={(v) => updateCamera({ pos: v as typeof cam.pos })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="br">Bottom right</SelectItem>
                  <SelectItem value="bl">Bottom left</SelectItem>
                  <SelectItem value="tr">Top right</SelectItem>
                  <SelectItem value="tl">Top left</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Size" value={`${cam.sizePct}%`}>
              <Slider
                value={cam.sizePct}
                min={8}
                max={40}
                step={1}
                onValueChange={(v) => updateCamera({ sizePct: num(v) })}
              />
            </Field>
          </Section>

          <Separator />

          <Section title="Sync">
            <Field
              label="Offset"
              value={`${cam.offsetMs} ms`}
              hint="Nudge the camera track to line up with the screen."
            >
              <Slider
                value={cam.offsetMs}
                min={-2000}
                max={2000}
                step={10}
                onValueChange={(v) => updateCamera({ offsetMs: num(v) })}
              />
            </Field>
          </Section>
        </TabsContent>

        {/* ── Zoom (contextual on the selected block) ── */}
        <TabsContent value="zoom" className="space-y-6">
          <Section title="Zoom block">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {regionCount} block{regionCount === 1 ? "" : "s"}
                {selRegion ? ` · #${(selectedIndex ?? 0) + 1} selected` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  addZoomRegion(props.playheadMs);
                  props.onSelectKeyframe(regionCount);
                }}
              >
                <Plus className="size-4" /> Add
              </Button>
            </div>

            {regionCount > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {project.zoom.map((r, i) => (
                  <Button
                    key={i}
                    size="sm"
                    variant={selectedIndex === i ? "default" : "secondary"}
                    onClick={() => {
                      props.onSelectKeyframe(i);
                      props.onSeek(r.startMs);
                    }}
                  >
                    ×{r.scale.toFixed(1)} @ {(r.startMs / 1000).toFixed(1)}s
                  </Button>
                ))}
              </div>
            )}

            <AnimatePresence mode="wait" initial={false}>
              {selRegion && selectedIndex != null ? (
                <motion.div
                  key={`region-${selectedIndex}`}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="space-y-4 rounded-lg border border-primary/40 bg-primary/[0.04] p-3.5"
                >
                  <Field
                    label="Scale"
                    value={`×${selRegion.scale.toFixed(2)}`}
                    hint="How far this block zooms in. Pan follows the cursor; drag the block on the timeline to set its span."
                  >
                    <Slider
                      value={selRegion.scale}
                      min={1}
                      max={4}
                      step={0.05}
                      onValueChange={(v) =>
                        updateZoomRegion(selectedIndex, { scale: num(v) })
                      }
                    />
                  </Field>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      removeZoomRegion(selectedIndex);
                      props.onSelectKeyframe(null);
                    }}
                  >
                    <Trash2 className="size-4" /> Remove block
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Hint>
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
                      <Sparkles className="size-3.5" /> No block selected
                    </span>
                    <br />
                    Select a zoom block on the timeline to tune its scale — or add
                    one at the playhead.
                  </Hint>
                </motion.div>
              )}
            </AnimatePresence>
          </Section>

          <Separator />

          <Section title="Motion">
            <Field
              label="Zoom speed"
              value={`${project.zoomDurationMs ?? DEFAULT_ZOOM_DURATION_MS} ms`}
              hint="How fast every block ramps in and out. Lower = snappier."
            >
              <Slider
                value={project.zoomDurationMs ?? DEFAULT_ZOOM_DURATION_MS}
                min={120}
                max={900}
                step={10}
                onValueChange={(v) => patchProject({ zoomDurationMs: num(v) })}
              />
            </Field>
          </Section>

          <Separator />

          <Section title="Cursor follow">
            <Field
              label="Smoothing"
              value={project.cursorSmoothing.toFixed(2)}
              hint="Low-pass on the rendered cursor path."
            >
              <Slider
                value={project.cursorSmoothing}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(v) => setCursorSmoothing(num(v))}
              />
            </Field>
            <Field
              label="Follow strength"
              value={project.cursorFollow.strength.toFixed(2)}
              hint="While zoomed, how tightly the viewport tracks the cursor."
            >
              <Slider
                value={project.cursorFollow.strength}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(v) =>
                  patchProject({
                    cursorFollow: { ...project.cursorFollow, strength: num(v) },
                  })
                }
              />
            </Field>
            <Field
              label="Deadzone"
              value={`${project.cursorFollow.deadzonePct}%`}
              hint="Central area the cursor can roam before the pan moves."
            >
              <Slider
                value={project.cursorFollow.deadzonePct}
                min={0}
                max={40}
                step={1}
                onValueChange={(v) =>
                  patchProject({
                    cursorFollow: { ...project.cursorFollow, deadzonePct: num(v) },
                  })
                }
              />
            </Field>
          </Section>
        </TabsContent>

        {/* ── Export ── */}
        <TabsContent value="export" className="space-y-6">
          <Section title="Output">
            <Field label="Resolution">
              <Select
                value={`${exp.w}x${exp.h}`}
                onValueChange={(v) => {
                  const [w, h] = (v as string).split("x").map(Number);
                  updateExport({ w, h });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={`${project.source.w}x${project.source.h}`}>
                    Source ({project.source.w}×{project.source.h})
                  </SelectItem>
                  <SelectItem value="1920x1080">1080p (1920×1080)</SelectItem>
                  <SelectItem value="1280x720">720p (1280×720)</SelectItem>
                  <SelectItem value="3840x2160">4K (3840×2160)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Frame rate">
                <Select
                  value={String(exp.fps)}
                  onValueChange={(v) => updateExport({ fps: Number(v) })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="60">60 fps</SelectItem>
                    <SelectItem value="30">30 fps</SelectItem>
                    <SelectItem value="24">24 fps</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Format">
                <Select
                  value={exp.format}
                  onValueChange={(v) =>
                    updateExport({ format: v as typeof exp.format })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp4">MP4</SelectItem>
                    <SelectItem value="gif">GIF</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {exp.format === "mp4" && (
              <Field label="Bitrate" value={`${exp.bitrateMbps} Mbps`}>
                <Slider
                  value={exp.bitrateMbps}
                  min={4}
                  max={40}
                  step={1}
                  onValueChange={(v) => updateExport({ bitrateMbps: num(v) })}
                />
              </Field>
            )}
          </Section>

          <Separator />

          <div className="space-y-3">
            {exporting && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(progress * 100)}%
                </p>
              </div>
            )}

            <Button className="w-full" onClick={runExport} disabled={exporting}>
              <Download className="size-4" />
              {exporting ? "Exporting…" : `Export ${exp.format.toUpperCase()}`}
            </Button>
            {exporting && (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => abortRef.current?.abort()}
              >
                Cancel
              </Button>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
