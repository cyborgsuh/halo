// window.rs — floating recording bar window + Win32 capture exclusion.
//
// The recording control bar is a SEPARATE Tauri window (label "rec-bar"): small,
// frameless, always-on-top, skip-taskbar, anchored bottom-center. It loads the same
// frontend bundle at hash "#recbar" (App renders <RecBar/> for that window label).
//
// The signature trick: the bar must be visible on screen but ABSENT from screen.mp4.
// Windows Graphics Capture honors `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`,
// so we mark the bar excluded right after creating it.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
};

const BAR_W: f64 = 360.0;
const BAR_H: f64 = 64.0;
/// Gap from the bottom of the primary monitor, in logical px.
const BAR_BOTTOM_MARGIN: f64 = 48.0;

/// Primary-monitor size in LOGICAL px via the AppHandle (works from async commands,
/// unlike the per-window method). Used to position floating windows in the builder.
fn monitor_logical(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let s = m.scale_factor();
        let sz = m.size();
        if s > 0.0 {
            return (sz.width as f64 / s, sz.height as f64 / s);
        }
        return (sz.width as f64, sz.height as f64);
    }
    (1536.0, 864.0)
}


/// Mark a window as excluded from screen capture (WGC / most capture APIs honor this).
#[tauri::command]
pub fn set_capture_excluded(app: AppHandle, label: String) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window with label '{label}'"))?;
    // Tauri (windows 0.61) HWND wraps the same `*mut c_void` as our windows 0.58 HWND.
    let raw = win.hwnd().map_err(|e| format!("failed to get HWND: {e}"))?;
    let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
            .map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"))?;
    }
    Ok(())
}

/// Create the floating recording bar (idempotent) and mark it capture-excluded.
#[tauri::command]
pub async fn open_rec_bar(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("rec-bar").is_some() {
        // Already open — just (re)assert capture exclusion.
        return set_capture_excluded(app.clone(), "rec-bar".into());
    }

    // Anchor bottom-center, computed in LOGICAL px and set IN THE BUILDER. We must
    // not call any window method (set_position/primary_monitor) after build — those
    // fail with FailedToReceiveMessage from this async command on Windows (tauri
    // #2078), which left the window at its off-screen default. AppHandle's
    // primary_monitor goes through the main loop and works.
    let (lw, lh) = monitor_logical(&app);
    let x = ((lw - BAR_W) / 2.0).max(0.0);
    let y = (lh - BAR_H - BAR_BOTTOM_MARGIN).max(0.0);
    eprintln!("[rec-bar] logical {lw}x{lh} -> pos {x},{y}");

    let _win = WebviewWindowBuilder::new(
        &app,
        "rec-bar",
        WebviewUrl::App("index.html#recbar".into()),
    )
    .title("Recording")
    .inner_size(BAR_W, BAR_H)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // Created HIDDEN: the webview boots during the 3s countdown and the frontend
    // show()s it at countdown-zero, so it appears instantly. focused(false) makes
    // that first show non-activating (SW_SHOWNOACTIVATE) — the recorded app keeps focus.
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| format!("failed to create rec-bar window: {e}"))?;

    set_capture_excluded(app.clone(), "rec-bar".into())?;
    Ok(())
}

/// Hide the floating recording bar. The window (and its booted webview) PERSISTS
/// hidden so the next recording can show() it instantly — destroying it made every
/// recording re-pay the 1-2s WebView2 + bundle cold boot.
#[tauri::command]
pub fn close_rec_bar(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("rec-bar") {
        win.hide().map_err(|e| format!("failed to hide rec-bar: {e}"))?;
    }
    Ok(())
}

const CAM_SIZE: f64 = 200.0;
const CAM_MARGIN: f64 = 48.0;

/// Create the floating webcam preview (presenter monitor): a small transparent,
/// always-on-top, capture-EXCLUDED window so the user sees themselves while
/// recording without the bubble getting baked into screen.mp4 (the editor
/// composites cam.webm separately). Anchored bottom-left. Idempotent.
#[tauri::command]
pub async fn open_cam_preview(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("cam-preview").is_some() {
        return set_capture_excluded(app.clone(), "cam-preview".into());
    }

    // Bottom-left, logical px, set in the builder (no post-build window methods).
    let (_lw, lh) = monitor_logical(&app);
    let x = CAM_MARGIN;
    let y = (lh - CAM_SIZE - CAM_MARGIN).max(0.0);

    let _win = WebviewWindowBuilder::new(
        &app,
        "cam-preview",
        WebviewUrl::App("index.html#campreview".into()),
    )
    .title("Camera")
    .inner_size(CAM_SIZE, CAM_SIZE)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // Hidden + unfocused for the same countdown pre-boot reveal as the rec bar.
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| format!("failed to create cam-preview window: {e}"))?;

    set_capture_excluded(app.clone(), "cam-preview".into())?;
    Ok(())
}

/// Hide the floating webcam preview (persists hidden for instant reuse; the
/// webview releases the camera itself when the device key is cleared).
#[tauri::command]
pub fn close_cam_preview(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("cam-preview") {
        win.hide()
            .map_err(|e| format!("failed to hide cam-preview: {e}"))?;
    }
    Ok(())
}
