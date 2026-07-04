// store.ts
//
// Zustand store: the editable project document (`project.json` shape), the live
// recording state, and the selected capture devices. Project types are imported
// from "@/lib/timeline" — never redefined here.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Background,
  Camera,
  Cut,
  ExportSettings,
  Project,
  RecordingMeta,
  Trim,
  ZoomRegion,
} from "@/lib/timeline";
import { normalizeProject } from "@/lib/timeline";

/** Default length of a freshly-added zoom region (ms). ~1.5s feels deliberate. */
const DEFAULT_REGION_MS = 1500;
/** Default length of a freshly-added cut (ms). */
const DEFAULT_CUT_MS = 1000;

// ── App view (replaces the V1 shadcn Tabs-as-router) ─────────────────────────

/** Top-level screen the app shell is showing. */
export type AppView = "dashboard" | "record" | "edit";

// ── Recording state ──────────────────────────────────────────────────────────

export type RecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "processing";

export interface RecordingState {
  status: RecordingStatus;
  /** From `start_recording`. */
  sessionId: string | null;
  /** Shared clock from `start_recording`; mic/cam offsets measure against it. */
  startEpochMs: number | null;
  /** Session output dir from `stop_recording`. */
  dir: string | null;
  /** Source toggles chosen for the next/active recording. */
  captureScreen: boolean;
  captureMic: boolean;
  captureCam: boolean;
  /** Wall-clock the UI started recording (for an elapsed-time readout). */
  startedAtMs: number | null;
  /** Last error surfaced from the capture pipeline. */
  error: string | null;
}

const initialRecording: RecordingState = {
  status: "idle",
  sessionId: null,
  startEpochMs: null,
  dir: null,
  captureScreen: true,
  captureMic: true,
  captureCam: true,
  startedAtMs: null,
  error: null,
};

// ── Selected devices ─────────────────────────────────────────────────────────

export interface DeviceSelection {
  /** null = system default device. */
  micDeviceId: string | null;
  camDeviceId: string | null;
  /** null = primary monitor. */
  monitorId: string | null;
}

const initialDevices: DeviceSelection = {
  micDeviceId: null,
  camDeviceId: null,
  monitorId: null,
};

// ── Store shape ──────────────────────────────────────────────────────────────

export interface AppState {
  /** Active top-level view; the app opens on the dashboard library. */
  view: AppView;
  /** The loaded/editable project, or null before a recording is loaded. */
  project: Project | null;
  /** Library of persisted recordings (populated by loadRecordings). */
  recordings: RecordingMeta[];
  recording: RecordingState;
  devices: DeviceSelection;

  // View actions
  setView: (view: AppView) => void;

  // Library actions
  loadRecordings: () => Promise<void>;

  // Project actions
  setProject: (project: Project | null) => void;
  patchProject: (patch: Partial<Project>) => void;
  updateBackground: (patch: Partial<Background>) => void;
  updateCamera: (patch: Partial<Camera>) => void;
  updateExport: (patch: Partial<ExportSettings>) => void;
  setTrim: (trim: Trim) => void;
  /** Replace the whole zoom-region list (kept sorted by callers). */
  setZoomRegions: (regions: ZoomRegion[]) => void;
  /** Append a region; defaults to a ~1.5s ×2 block when bounds/scale omitted. */
  addZoomRegion: (startMs: number, endMs?: number, scale?: number) => void;
  updateZoomRegion: (index: number, patch: Partial<ZoomRegion>) => void;
  removeZoomRegion: (index: number) => void;
  /** Cut (trim-in-the-middle) actions, mirroring the zoom-region ones. */
  setCuts: (cuts: Cut[]) => void;
  addCut: (startMs: number, endMs?: number) => void;
  updateCut: (index: number, patch: Partial<Cut>) => void;
  removeCut: (index: number) => void;
  setCursorSmoothing: (value: number) => void;

  // Recording actions
  setRecording: (patch: Partial<RecordingState>) => void;
  resetRecording: () => void;

  // Device actions
  setDevices: (patch: Partial<DeviceSelection>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "dashboard",
  project: null,
  recordings: [],
  recording: initialRecording,
  devices: initialDevices,

  setView: (view) => set({ view }),

  loadRecordings: async () => {
    try {
      const recordings = await invoke<RecordingMeta[]>("list_recordings");
      set({ recordings });
    } catch (e) {
      console.warn("loadRecordings failed", e);
    }
  },

  setProject: (project) =>
    set({ project: project ? normalizeProject(project) : null }),

  patchProject: (patch) =>
    set((s) => (s.project ? { project: { ...s.project, ...patch } } : s)),

  updateBackground: (patch) =>
    set((s) =>
      s.project
        ? { project: { ...s.project, background: { ...s.project.background, ...patch } } }
        : s,
    ),

  updateCamera: (patch) =>
    set((s) =>
      s.project
        ? { project: { ...s.project, camera: { ...s.project.camera, ...patch } } }
        : s,
    ),

  updateExport: (patch) =>
    set((s) =>
      s.project
        ? { project: { ...s.project, export: { ...s.project.export, ...patch } } }
        : s,
    ),

  setTrim: (trim) =>
    set((s) => (s.project ? { project: { ...s.project, trim } } : s)),

  setZoomRegions: (regions) =>
    set((s) => (s.project ? { project: { ...s.project, zoom: regions } } : s)),

  addZoomRegion: (startMs, endMs, scale) =>
    set((s) => {
      if (!s.project) return s;
      const dur = s.project.source.durationMs;
      const start = Math.max(0, Math.min(startMs, Math.max(0, dur - 1)));
      const end = Math.min(dur, endMs ?? start + DEFAULT_REGION_MS);
      if (end <= start) return s;
      const region: ZoomRegion = { startMs: start, endMs: end, scale: scale ?? 2 };
      const zoom = [...s.project.zoom, region].sort(
        (a, b) => a.startMs - b.startMs,
      );
      return { project: { ...s.project, zoom } };
    }),

  updateZoomRegion: (index, patch) =>
    set((s) => {
      if (!s.project) return s;
      const zoom = s.project.zoom.map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      );
      return { project: { ...s.project, zoom } };
    }),

  removeZoomRegion: (index) =>
    set((s) => {
      if (!s.project) return s;
      const zoom = s.project.zoom.filter((_, i) => i !== index);
      return { project: { ...s.project, zoom } };
    }),

  setCuts: (cuts) =>
    set((s) => (s.project ? { project: { ...s.project, cuts } } : s)),

  addCut: (startMs, endMs) =>
    set((s) => {
      if (!s.project) return s;
      const dur = s.project.source.durationMs;
      const start = Math.max(0, Math.min(startMs, Math.max(0, dur - 1)));
      const end = Math.min(dur, endMs ?? start + DEFAULT_CUT_MS);
      if (end <= start) return s;
      const cuts = [...s.project.cuts, { startMs: start, endMs: end }].sort(
        (a, b) => a.startMs - b.startMs,
      );
      return { project: { ...s.project, cuts } };
    }),

  updateCut: (index, patch) =>
    set((s) => {
      if (!s.project) return s;
      const cuts = s.project.cuts.map((c, i) => (i === index ? { ...c, ...patch } : c));
      return { project: { ...s.project, cuts } };
    }),

  removeCut: (index) =>
    set((s) => {
      if (!s.project) return s;
      const cuts = s.project.cuts.filter((_, i) => i !== index);
      return { project: { ...s.project, cuts } };
    }),

  setCursorSmoothing: (value) =>
    set((s) =>
      s.project ? { project: { ...s.project, cursorSmoothing: value } } : s,
    ),

  setRecording: (patch) =>
    set((s) => ({ recording: { ...s.recording, ...patch } })),

  resetRecording: () => set({ recording: initialRecording }),

  setDevices: (patch) => set((s) => ({ devices: { ...s.devices, ...patch } })),
}));
