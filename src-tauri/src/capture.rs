// capture.rs — Windows Graphics Capture (WGC) of the primary/selected monitor,
// encoded to <dir>/screen.mp4 with the `windows-capture` crate's hardware encoder.
//
// Output: H264 (MPEG4 container), frame rate ~60fps, hardware-accelerated transcode.
//
// NOTE (GOP): the `windows-capture` 1.5 `VideoSettingsBuilder` does not expose a
// key-frame-interval / GOP knob, so we cannot force GOP <= 60 at the API level. The
// Media Foundation H264 encoder it drives typically inserts an IDR every ~1–2s. The
// export path (frontend `VideoDecoder`) decodes frame-accurately regardless, so this
// is not a correctness blocker — flagged in the return summary as a known limitation.

use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler, CaptureControl};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type BoxErr = Box<dyn Error + Send + Sync>;

/// Flags handed to the capture handler when it is constructed on the capture thread.
#[derive(Clone)]
pub struct CaptureFlags {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub path: String,
    /// Shared clock origin (same as the cursor logger) + a slot to record the
    /// delay until the FIRST encoded frame, so cursor times can be aligned to the
    /// video timeline (WGC takes a few hundred ms to produce its first frame).
    pub start: Instant,
    pub lag_ms: Arc<AtomicU64>,
}

/// The capture handler: owns the hardware video encoder and feeds it every frame.
pub struct CaptureHandler {
    encoder: Option<VideoEncoder>,
    start: Instant,
    lag_ms: Arc<AtomicU64>,
}

impl CaptureHandler {
    /// Finalize the encoder (flush + close the mp4). Idempotent.
    fn finish(&mut self) -> Result<(), BoxErr> {
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(())
    }
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = BoxErr;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;

        let video = VideoSettingsBuilder::new(f.width, f.height)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(f.fps)
            .bitrate(f.bitrate);

        let encoder = VideoEncoder::new(
            video,
            // No audio in the screen track; mic rides in the webview (mic.webm).
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(), // MPEG4
            &f.path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            start: f.start,
            lag_ms: f.lag_ms,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Record the time of the FIRST frame = video t0 relative to the shared clock.
        if self.lag_ms.load(Ordering::Relaxed) == 0 {
            let ms = self.start.elapsed().as_millis() as u64;
            self.lag_ms.store(ms.max(1), Ordering::Relaxed);
        }
        if let Some(encoder) = self.encoder.as_mut() {
            encoder.send_frame(frame)?;
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Handle to a running screen capture session. `stop()` consumes it.
pub struct ScreenCapture {
    control: Option<CaptureControl<CaptureHandler, BoxErr>>,
}

impl ScreenCapture {
    /// Start capturing `monitor` to `path` at `fps`/`bitrate`. Non-blocking: capture
    /// runs on its own thread.
    pub fn start(
        monitor: Monitor,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        path: String,
        start: Instant,
        lag_ms: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let flags = CaptureFlags { width, height, fps, bitrate, path, start, lag_ms };

        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::WithCursor, // bake the user's real cursor into screen.mp4
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );

        let control = CaptureHandler::start_free_threaded(settings)
            .map_err(|e| format!("failed to start screen capture: {e}"))?;

        Ok(Self { control: Some(control) })
    }

    /// Stop capturing and finalize the mp4. Returns once the file is fully written.
    pub fn stop(mut self) -> Result<(), String> {
        if let Some(control) = self.control.take() {
            // Grab a handle to the handler before consuming `control` so we can
            // finalize the encoder after the capture thread has halted.
            let callback = control.callback();
            control
                .stop()
                .map_err(|e| format!("failed to stop screen capture: {e}"))?;
            callback
                .lock()
                .finish()
                .map_err(|e| format!("failed to finalize screen.mp4: {e}"))?;
        }
        Ok(())
    }
}

/// Pre-warm the Media Foundation H264 encoder so the FIRST real recording doesn't
/// eat the ~1s one-time MF/DLL initialization cost at `start_recording` time.
/// Creates a tiny throwaway encoder, finalizes it, and deletes the file. Cheap +
/// best-effort; runs on a background thread at startup.
pub fn warmup_encoder() {
    let path = std::env::temp_dir()
        .join("screen-recorder")
        .join("warmup.mp4");
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let video = VideoSettingsBuilder::new(64, 64)
        .sub_type(VideoSettingsSubType::H264)
        .frame_rate(30)
        .bitrate(1_000_000);
    if let Ok(encoder) = VideoEncoder::new(
        video,
        AudioSettingsBuilder::default().disabled(true),
        ContainerSettingsBuilder::default(),
        path.to_string_lossy().to_string(),
    ) {
        let _ = encoder.finish();
    }
    let _ = std::fs::remove_file(&path);
}

/// Pre-warm the FULL WGC capture stack (D3D device + frame pool + MF encoder) by
/// running a brief throwaway capture. Called when the user opens the record screen,
/// so the real `start_recording` reuses the warmed stack and starts in ~100-200ms
/// instead of ~1s. Best-effort; runs on a background thread.
pub fn warmup_capture() {
    let path = std::env::temp_dir()
        .join("screen-recorder")
        .join("warmup_cap.mp4");
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    if let Ok(monitor) = Monitor::primary() {
        let w = monitor.width().unwrap_or(1280);
        let h = monitor.height().unwrap_or(720);
        let lag = Arc::new(AtomicU64::new(0));
        if let Ok(cap) = ScreenCapture::start(
            monitor,
            w,
            h,
            30,
            4_000_000,
            path.to_string_lossy().to_string(),
            Instant::now(),
            lag,
        ) {
            std::thread::sleep(Duration::from_millis(120)); // grab a couple of frames
            let _ = cap.stop();
        }
    }
    let _ = std::fs::remove_file(&path);
}

/// Information about a connected monitor for `list_monitors`.
pub struct MonitorInfo {
    pub id: usize,
    pub name: String,
    pub w: u32,
    pub h: u32,
    pub primary: bool,
}

/// Enumerate all monitors (1-based ids matching `Monitor::from_index`).
pub fn enumerate_monitors() -> Result<Vec<MonitorInfo>, String> {
    let primary_dev = Monitor::primary()
        .ok()
        .and_then(|m| m.device_name().ok());

    let monitors = Monitor::enumerate().map_err(|e| format!("failed to enumerate monitors: {e}"))?;

    let mut out = Vec::with_capacity(monitors.len());
    for (idx, m) in monitors.iter().enumerate() {
        let dev = m.device_name().unwrap_or_default();
        let name = m
            .name()
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| m.device_string().ok())
            .unwrap_or_else(|| dev.clone());
        let w = m.width().unwrap_or(0);
        let h = m.height().unwrap_or(0);
        let primary = primary_dev.as_deref() == Some(dev.as_str());
        out.push(MonitorInfo { id: idx + 1, name, w, h, primary });
    }
    Ok(out)
}

/// Resolve a monitor by 1-based id, falling back to the primary monitor.
pub fn resolve_monitor(id: Option<usize>) -> Result<Monitor, String> {
    match id {
        Some(i) if i >= 1 => {
            Monitor::from_index(i).map_err(|e| format!("monitor {i} not found: {e}"))
        }
        _ => Monitor::primary().map_err(|e| format!("no primary monitor: {e}")),
    }
}
