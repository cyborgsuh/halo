// recording.rs — session state + start/stop orchestration for the capture stack.
//
// A session owns the screen capture and cursor logger, the output directory (under the
// app data dir), the shared start clock, and the source geometry. Sessions are kept in a
// global registry keyed by id so `stop_recording` can find and finalize them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::capture::{enumerate_monitors, resolve_monitor, ScreenCapture};
use crate::cursor::CursorRecorder;

/// Root directory for persisted recordings: `<app_data_dir>/recordings`.
fn recordings_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("recordings"))
}

/// Default capture frame rate (GOP/keyframe interval is encoder-controlled, see capture.rs).
const DEFAULT_FPS: u32 = 60;

/// A live recording session.
struct Session {
    dir: PathBuf,
    screen_path: PathBuf,
    cursor_path: PathBuf,
    start_instant: Instant,
    width: u32,
    height: u32,
    fps: u32,
    screen: ScreenCapture,
    cursor: CursorRecorder,
    /// Delay (ms) from the shared clock to the first encoded video frame; used to
    /// align cursor.jsonl timestamps to the video timeline on stop.
    capture_lag_ms: Arc<AtomicU64>,
}

/// Rewrite cursor.jsonl, subtracting `lag_ms` from every `t` (clamped to 0) so the
/// cursor timeline matches the video timeline (the video's first frame is `lag_ms`
/// after the shared clock origin). Best-effort: leaves the file as-is on any error.
fn align_cursor_log(path: &Path, lag_ms: u64) {
    if lag_ms == 0 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(mut v) => {
                if let Some(t) = v.get("t").and_then(|t| t.as_i64()) {
                    let shifted = (t - lag_ms as i64).max(0);
                    v["t"] = serde_json::json!(shifted);
                }
                out.push_str(&v.to_string());
                out.push('\n');
            }
            Err(_) => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    let _ = std::fs::write(path, out);
}

// Global session registry. Only a handful of sessions ever exist (usually one).
static SESSIONS: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);

fn with_sessions<T>(f: impl FnOnce(&mut HashMap<String, Session>) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Options from the frontend. `mic`/`cam` are handled in the webview; we only act on
/// `screen` + `monitor` here, but accept the full shape for a stable IPC contract.
#[derive(Debug, Deserialize)]
pub struct RecordOpts {
    #[serde(default)]
    pub screen: bool,
    #[serde(default)]
    pub mic: bool,
    #[serde(default)]
    pub cam: bool,
    #[serde(default)]
    pub monitor: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPayload {
    pub session_id: String,
    pub start_epoch_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopPayload {
    pub dir: String,
    pub screen_path: String,
    pub cursor_path: String,
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    pub duration_ms: u128,
    /// Delay (ms) from the shared clock to the first encoded frame — lets the
    /// editor compute where the post-countdown content begins.
    pub capture_lag_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct MonitorEntry {
    pub id: usize,
    pub name: String,
    pub w: u32,
    pub h: u32,
    pub primary: bool,
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Reasonable capture bitrate for the given resolution/fps (~0.1 bits/pixel/frame, clamped).
fn target_bitrate(w: u32, h: u32, fps: u32) -> u32 {
    let bpp = 0.1_f64;
    let bits = (w as f64) * (h as f64) * (fps as f64) * bpp;
    (bits as u32).clamp(8_000_000, 40_000_000)
}

/// Begin a recording: spin up screen capture + cursor logging against a fresh output dir
/// under the app data dir so the capture survives reboots/cleanup.
pub fn start(app: &AppHandle, opts: RecordOpts) -> Result<StartPayload, String> {
    let start_epoch_ms = epoch_ms();
    let session_id = format!("rec-{start_epoch_ms}");

    let dir = recordings_root(app)?.join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create output dir: {e}"))?;

    let screen_path = dir.join("screen.mp4");
    let cursor_path = dir.join("cursor.jsonl");

    let monitor = resolve_monitor(opts.monitor)?;
    let width = monitor.width().map_err(|e| format!("monitor width: {e}"))?;
    let height = monitor.height().map_err(|e| format!("monitor height: {e}"))?;
    let fps = DEFAULT_FPS;
    let bitrate = target_bitrate(width, height, fps);

    // Shared clock: cursor `t` is measured from this instant; screen frames share it
    // closely enough (both started back-to-back here).
    let start_instant = Instant::now();
    let capture_lag_ms = Arc::new(AtomicU64::new(0));

    let screen = ScreenCapture::start(
        monitor,
        width,
        height,
        fps,
        bitrate,
        screen_path.to_string_lossy().to_string(),
        start_instant,
        capture_lag_ms.clone(),
    )?;

    let cursor = match CursorRecorder::start(cursor_path.to_string_lossy().to_string(), start_instant)
    {
        Ok(c) => c,
        Err(e) => {
            // Roll back the screen capture so we don't leak a recording thread.
            let _ = screen.stop();
            return Err(e);
        }
    };

    let session = Session {
        dir,
        screen_path,
        cursor_path,
        start_instant,
        width,
        height,
        fps,
        screen,
        cursor,
        capture_lag_ms,
    };

    with_sessions(|m| m.insert(session_id.clone(), session));

    Ok(StartPayload { session_id, start_epoch_ms })
}

/// Stop a recording, finalize files, and return the stop payload.
pub fn stop(session_id: &str) -> Result<StopPayload, String> {
    let session = with_sessions(|m| m.remove(session_id))
        .ok_or_else(|| format!("unknown session id: {session_id}"))?;

    let duration_ms = session.start_instant.elapsed().as_millis();

    // Stop cursor first (cheap, just joins threads), then finalize the encoder.
    let cursor_res = session.cursor.stop();
    let screen_res = session.screen.stop();

    cursor_res?;
    screen_res?;

    // Align cursor timestamps to the video timeline (subtract the WGC first-frame
    // delay) so auto-zoom and pan-follow land on the right frame, not ~Δ late.
    let lag = session.capture_lag_ms.load(Ordering::Relaxed);
    align_cursor_log(&session.cursor_path, lag);

    Ok(StopPayload {
        capture_lag_ms: lag,
        dir: session.dir.to_string_lossy().to_string(),
        screen_path: session.screen_path.to_string_lossy().to_string(),
        cursor_path: session.cursor_path.to_string_lossy().to_string(),
        w: session.width,
        h: session.height,
        fps: session.fps,
        duration_ms,
    })
}

/// List connected monitors.
pub fn monitors() -> Result<Vec<MonitorEntry>, String> {
    Ok(enumerate_monitors()?
        .into_iter()
        .map(|m| MonitorEntry { id: m.id, name: m.name, w: m.w, h: m.h, primary: m.primary })
        .collect())
}

// ---- Tauri commands -------------------------------------------------------------------

#[tauri::command]
pub fn start_recording(app: AppHandle, opts: RecordOpts) -> Result<StartPayload, String> {
    start(&app, opts)
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle, session_id: String) -> Result<StopPayload, String> {
    let payload = stop(&session_id)?;
    // Best-effort thumbnail from the finalized screen.mp4 (ffmpeg sidecar). A failure
    // (e.g. a sub-second clip with no frame at t=1s) must not fail the stop itself.
    let thumb = std::path::Path::new(&payload.dir)
        .join("thumb.jpg")
        .to_string_lossy()
        .to_string();
    if let Err(e) = crate::mux::make_thumbnail(&app, &payload.screen_path, &thumb).await {
        eprintln!("thumbnail generation failed: {e}");
    }
    Ok(payload)
}

#[tauri::command]
pub fn list_monitors() -> Result<Vec<MonitorEntry>, String> {
    monitors()
}

/// Pre-warm the capture stack (called when the record screen opens) so the real
/// recording starts fast. Fire-and-forget on a background thread.
#[tauri::command]
pub fn prewarm_capture() {
    std::thread::spawn(crate::capture::warmup_capture);
}

/// TEMP diagnostic: append a line to <temp>/screen-recorder/debug.log.
#[tauri::command]
pub fn append_log(line: String) -> Result<(), String> {
    use std::io::Write;
    let path = std::env::temp_dir().join("screen-recorder").join("debug.log");
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Save an opaque byte blob (e.g. mic.webm / cam.webm / exported mp4) to `path`.
#[tauri::command]
pub fn save_blob(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dir: {e}"))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("failed to write {path}: {e}"))
}

/// Read a recording artifact (e.g. cursor.jsonl) back as UTF-8 text.
///
/// The capture stack writes artifacts into the OS temp dir via Rust; this is the
/// matching read path so the editor can load cursor.jsonl for auto-zoom without
/// depending on the fs-plugin path scope.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// Paths of an existing recording on disk (only files that exist are Some).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFiles {
    pub dir: String,
    pub screen_path: String,
    pub cursor_path: Option<String>,
    pub mic_path: Option<String>,
    pub cam_path: Option<String>,
}

/// Find the most recent recording dir (under app_data/recordings) that has a screen.mp4.
/// Lets the editor reopen the last capture without re-recording.
#[tauri::command]
pub fn latest_recording(app: AppHandle) -> Result<Option<RecordingFiles>, String> {
    let base = recordings_root(&app)?;
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Ok(None);
    };
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for e in entries.flatten() {
        let p = e.path();
        let screen = p.join("screen.mp4");
        if !screen.is_file() {
            continue;
        }
        let mtime = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    let Some((_, dir)) = best else { return Ok(None) };
    let exists = |name: &str| {
        let f = dir.join(name);
        f.is_file().then(|| f.to_string_lossy().to_string())
    };
    Ok(Some(RecordingFiles {
        dir: dir.to_string_lossy().to_string(),
        screen_path: dir.join("screen.mp4").to_string_lossy().to_string(),
        cursor_path: exists("cursor.jsonl"),
        mic_path: exists("mic.webm"),
        cam_path: exists("cam.webm"),
    }))
}

// ---- Library / persistence commands ---------------------------------------------------

/// Metadata for a single persisted recording, surfaced to the dashboard library.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMeta {
    pub id: String,
    pub dir: String,
    pub screen_path: String,
    pub thumb_path: Option<String>,
    pub created_ms: u128,
    pub duration_ms: u128,
    /// Trim window from project.json (0/0 when absent). The head of screen.mp4
    /// contains the countdown — thumbnails/badges must respect this.
    pub trim_start_ms: u128,
    pub trim_end_ms: u128,
}

/// ms since the UNIX epoch for a filesystem timestamp (0 if unavailable).
fn system_time_ms(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Read (durationMs, trim.startMs, trim.endMs) out of a recording's project.json
/// (zeros if missing/unparseable). as_f64 because JS persists fractional ms.
fn project_times(dir: &std::path::Path) -> (u128, u128, u128) {
    let Ok(text) = std::fs::read_to_string(dir.join("project.json")) else {
        return (0, 0, 0);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (0, 0, 0);
    };
    let num = |o: Option<&serde_json::Value>| {
        o.and_then(|d| d.as_f64()).map(|d| d.max(0.0) as u128).unwrap_or(0)
    };
    let duration = num(
        v.get("source")
            .and_then(|s| s.get("durationMs"))
            .or_else(|| v.get("durationMs")),
    );
    let trim = v.get("trim");
    (
        duration,
        num(trim.and_then(|t| t.get("startMs"))),
        num(trim.and_then(|t| t.get("endMs"))),
    )
}

/// Scan `<app_data>/recordings` and return metadata for every recording with a screen.mp4,
/// newest first.
#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<RecordingMeta>, String> {
    let base = recordings_root(&app)?;
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<RecordingMeta> = Vec::new();
    for e in entries.flatten() {
        let dir = e.path();
        let screen = dir.join("screen.mp4");
        if !screen.is_file() {
            continue;
        }
        let id = match dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let created_ms = e
            .metadata()
            .and_then(|m| m.modified())
            .map(system_time_ms)
            .unwrap_or(0);
        let thumb = dir.join("thumb.jpg");
        let thumb_path = thumb.is_file().then(|| thumb.to_string_lossy().to_string());
        let (duration_ms, trim_start_ms, trim_end_ms) = project_times(&dir);
        out.push(RecordingMeta {
            id,
            dir: dir.to_string_lossy().to_string(),
            screen_path: screen.to_string_lossy().to_string(),
            thumb_path,
            created_ms,
            duration_ms,
            trim_start_ms,
            trim_end_ms,
        });
    }
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(out)
}

/// Return the saved `project.json` text for a recording id.
#[tauri::command]
pub fn load_recording(app: AppHandle, id: String) -> Result<String, String> {
    let path = recordings_root(&app)?.join(&id).join("project.json");
    std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read project.json for {id}: {e}"))
}

/// Persist the editor's `project.json` document next to the media for a recording id.
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = recordings_root(&app)?.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create dir: {e}"))?;
    std::fs::write(dir.join("project.json"), json.as_bytes())
        .map_err(|e| format!("failed to write project.json for {id}: {e}"))
}

/// Delete a recording's directory (and all artifacts within it).
#[tauri::command]
pub fn delete_recording(app: AppHandle, id: String) -> Result<(), String> {
    let dir = recordings_root(&app)?.join(&id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("failed to delete recording {id}: {e}"))?;
    }
    Ok(())
}
