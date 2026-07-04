<div align="center">

# Halo

**A screen recorder that automatically zooms and pans to follow the action.**

Record your screen, and Halo turns it into a polished, zoomed, cursor-tracking
video — the kind of motion you'd normally hand-animate in an editor — with no
manual keyframing. Then trim, add a background, and export to MP4 or GIF.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

## What makes it different

Most screen recorders give you a flat capture. Halo watches where you click and
move, then **automatically zooms in on the action and glides the camera to
follow your cursor** — a smooth, critically-damped motion tuned to feel
intentional, not jittery. Rapid clicks across the screen trigger a natural
pull-back → glide → push-in instead of a jarring whip-pan.

All of it is generated automatically from the recorded cursor path, and every
zoom is fully editable afterward on the timeline.

## Features

- **Auto-zoom & auto-pan** — zooms on clicks, follows the cursor with a smooth spring, anticipates motion (look-ahead), and holds still when your hand is idle.
- **Editable timeline** — drag/resize/add/delete zoom blocks, trim the clip, cut out mid-sections.
- **Webcam bubble** — a floating, always-on-top camera preview that's excluded from the capture (composited separately, never baked into the raw screen video).
- **Microphone** — records mic audio, aligned to the trimmed timeline on export.
- **Backgrounds & framing** — gradient / solid / image backgrounds, padding, corner radius, shadow.
- **Export** — MP4 (H.264, choose resolution / fps / bitrate) or GIF, with a cancelable progress bar.
- **Instant recording UI** — the floating record bar and camera bubble appear the moment the countdown ends.

## Platform

> **Windows only.** The capture stack is built on Windows Graphics Capture,
> Media Foundation hardware encoding, and Win32 mouse hooks. It will **not**
> build or run on macOS or Linux.

## Prerequisites

| Requirement | Notes |
|---|---|
| [Node.js](https://nodejs.org/) 18+ | frontend build (Vite) |
| [Rust](https://rustup.rs/) (stable) | Tauri backend |
| WebView2 | preinstalled on Windows 11; [download](https://developer.microsoft.com/microsoft-edge/webview2/) for Windows 10 |
| **ffmpeg** | required for export & thumbnails — see below |

### ffmpeg

Halo shells out to a bundled `ffmpeg` for muxing mic audio, building GIFs, and
generating thumbnails. It is **not** included in this repo. Download a static
Windows build (e.g. from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)) and
drop the executable here, renamed to include the target triple:

```
src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
```

(Screen recording itself works without ffmpeg, but export and thumbnails won't.)

## Getting started

```bash
git clone https://github.com/cyborgsuh/screen-recorder.git
cd screen-recorder
npm install

# add ffmpeg (see above), then:
npm run tauri dev        # run the app in dev
```

## Build a release

```bash
npm run tauri build
```

The installer / executable lands in `src-tauri/target/release/bundle/`.

## Where recordings are saved

Each recording is a folder under your app data directory:

```
%APPDATA%\com.cyborgsuh.screenrecorder\recordings\rec-<timestamp>\
├─ screen.mp4      # the raw screen capture
├─ mic.webm        # microphone audio (if enabled)
├─ cam.webm        # webcam video (if enabled)
├─ cursor.jsonl    # cursor path + clicks (drives the auto-zoom)
├─ project.json    # editable project (trim, zoom blocks, background, …)
└─ thumb.jpg       # library thumbnail
```

Exports go wherever you choose in the save dialog. Recordings are **never**
uploaded anywhere — everything stays on your machine.

## How the auto-zoom works

At record time, a background thread samples the cursor (~125 Hz) and logs every
click to `cursor.jsonl`. On stop, Halo turns clicks into zoom regions and
precomputes a smooth "follow path" for the pan. During preview **and** export,
one GPU renderer applies the same zoom/pan transform per frame, so what you see
is exactly what you get. The motion math lives in
[`src/lib/autozoom.ts`](src/lib/autozoom.ts) and
[`src/lib/timeline.ts`](src/lib/timeline.ts).

## Tech stack

Tauri 2 (Rust) · React 18 + TypeScript · Vite 6 · PixiJS 8 (WebGL compositor) ·
WebCodecs (export) · ffmpeg (mux/GIF) · Zustand · Tailwind CSS 4 · shadcn/ui

## Tests

Pure logic (playback clock, auto-zoom regions, follow path, export alignment,
timeline math) has assert-based tests:

```bash
npm test
```

## License

[MIT](LICENSE) © cyborgsuh — free for personal and commercial use.
