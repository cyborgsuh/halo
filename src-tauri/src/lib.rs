// Module layout (filled in by the feature build):
//   capture.rs   — WGC screen capture -> screen.mp4 (hardware encode)
//   cursor.rs    — GetCursorPos timer + low-level mouse hook -> cursor.jsonl
//   recording.rs — session state, start/stop orchestration, paths
//   mux.rs       — ffmpeg sidecar invocation (mux a/v, gif, thumbnail)
//   window.rs    — floating rec-bar window + Win32 capture exclusion

mod capture;
mod cursor;
mod mux;
mod recording;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the Media Foundation encoder off-thread so the first recording starts fast.
    std::thread::spawn(capture::warmup_encoder);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_page_load(|webview, payload| {
            // Boot-timing instrumentation for the overlay windows (dev console).
            if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                eprintln!("[page-load] {} finished", webview.label());
            }
        })
        .on_window_event(|window, event| {
            // Main died while overlays are still HIDDEN (pre-created during the
            // countdown): close them so the process can exit. Visible overlays are
            // live recording UI — leave them alone (the bar can still stop/save).
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    for label in ["rec-bar", "cam-preview"] {
                        if let Some(w) = window.app_handle().get_webview_window(label) {
                            if !w.is_visible().unwrap_or(true) {
                                let _ = w.close();
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            recording::start_recording,
            recording::stop_recording,
            recording::list_monitors,
            recording::prewarm_capture,
            recording::append_log,
            recording::save_blob,
            recording::read_text_file,
            recording::latest_recording,
            recording::list_recordings,
            recording::load_recording,
            recording::save_project,
            recording::delete_recording,
            window::open_rec_bar,
            window::close_rec_bar,
            window::open_cam_preview,
            window::close_cam_preview,
            window::set_capture_excluded,
            mux::mux,
            mux::make_gif
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
