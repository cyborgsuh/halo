// CamPreview.tsx
//
// The floating webcam "presenter monitor" shown while recording. Lives in a
// SEPARATE Tauri window (label "cam-preview", loaded at hash "#campreview"),
// transparent + always-on-top + capture-EXCLUDED — so the user sees themselves
// but the bubble is NOT baked into screen.mp4 (the editor composites cam.webm).
//
// The window PERSISTS hidden across recordings (close_cam_preview hides — that's
// what makes it appear instantly). The camera is therefore GATED on the device
// key: key present ("" = default device) → hold a display stream; key absent →
// release the camera. The main window writes the key at record start and every
// stop path clears it.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export const CAM_PREVIEW_DEVICE_KEY = "campreview.deviceId";

/** null = cam off (release camera); "" = default device; else exact device id. */
export function writeCamPreviewDevice(deviceId: string | null): void {
  try {
    if (deviceId === null) localStorage.removeItem(CAM_PREVIEW_DEVICE_KEY);
    else localStorage.setItem(CAM_PREVIEW_DEVICE_KEY, deviceId);
  } catch {
    /* storage unavailable — fall back to the default camera */
  }
}

function readCamPreviewDevice(): string | null {
  try {
    return localStorage.getItem(CAM_PREVIEW_DEVICE_KEY);
  } catch {
    return null;
  }
}

export default function CamPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(readCamPreviewDevice);

  // Track the device key continuously (window outlives sessions): cross-window
  // "storage" events are the fast path, the poll is the fallback, and the
  // recording-stopped event nudges an immediate release.
  useEffect(() => {
    const apply = () => setDeviceId(readCamPreviewDevice());
    apply();
    const id = window.setInterval(apply, 500);
    window.addEventListener("storage", apply);
    const un = listen("recording-stopped", apply);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("storage", apply);
      void un.then((u) => u());
    };
  }, []);

  useEffect(() => {
    if (deviceId === null) {
      // Idle (hidden) — make sure the camera is released.
      setError(false);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(false);
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        setError(true);
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);

  return (
    // Transparent full-window drag surface; the circle sits inset so its ring +
    // shadow have room and the round edge never touches (gets cut by) the window.
    <div
      data-tauri-drag-region
      className="h-screen w-screen cursor-grab bg-transparent active:cursor-grabbing"
    >
      <div className="absolute inset-2 overflow-hidden rounded-full bg-black shadow-xl ring-2 ring-white/70">
        {error ? (
          <div className="grid size-full place-items-center bg-neutral-900 text-[11px] text-white/70">
            No camera
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="pointer-events-none size-full -scale-x-100 object-cover"
          />
        )}
      </div>
    </div>
  );
}
