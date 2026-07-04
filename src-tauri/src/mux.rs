// mux.rs — ffmpeg sidecar invocation (mux audio/video, build GIFs).
//
// Uses the bundled `binaries/ffmpeg` external binary via tauri-plugin-shell. ffmpeg only
// muxes / builds palettes here — no transcoding of the already-hardware-encoded video.

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Resolve ffmpeg's absolute path. Tauri places the bundled binary NEXT TO the app
/// executable (dev: `target/debug/ffmpeg.exe`; prod: alongside the installed exe), but
/// `.sidecar("binaries/ffmpeg")` fails to find it on Windows ("cannot find the path",
/// os error 3) — so resolve it ourselves and run it via `.command()`.
fn ffmpeg_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent dir".to_string())?;
    for name in [
        "ffmpeg.exe",
        "ffmpeg-x86_64-pc-windows-msvc.exe",
        "ffmpeg",
    ] {
        let p = dir.join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(format!("ffmpeg binary not found next to {}", dir.display()))
}

/// TEMP: append a diagnostic line to <temp>/screen-recorder/debug.log (same file the
/// frontend logger writes), so mux/ffmpeg failures are readable regardless of stdout.
fn mlog(s: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("screen-recorder").join("debug.log");
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[mux] {s}");
    }
}

/// Run the ffmpeg sidecar with `args`, returning Err with stderr on non-zero exit.
async fn run_ffmpeg(app: &AppHandle, args: Vec<String>) -> Result<(), String> {
    let args_dbg = format!("{args:?}");
    let ffmpeg = ffmpeg_path()?;
    let output = app
        .shell()
        .command(ffmpeg)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to run: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        mlog(&format!("ffmpeg args: {args_dbg}"));
        mlog(&format!("ffmpeg FAILED: {}", stderr.replace('\n', " | ")));
        Err(format!("ffmpeg exited with failure:\n{stderr}"))
    }
}

/// Mux a video with an optional audio track into `out`.
///
/// The exporter (`export.ts`) writes the composited video as a raw Annex-B H.264
/// elementary stream (no container, no timestamps), so we tell ffmpeg the input
/// format (`-f h264`) and the frame rate (`-r fps`) BEFORE `-i video`; the video
/// is then stream-copied (`-c:v copy`, no re-transcode). Audio (mic.webm) is
/// (re)encoded to AAC. A muxed `.mp4` is produced at `out`.
/// Build the ffmpeg args for muxing a raw H.264 stream + optional audio → mp4.
/// Pure (no I/O) so it can be unit-tested — see the `tests` module. `audio_offset_ms`:
/// >0 seek into the mic, <0 delay it, applied BEFORE `-i audio`.
fn build_mux_args(
    video: &str,
    audio: Option<&str>,
    out: &str,
    fps: u32,
    audio_offset_ms: i64,
) -> Vec<String> {
    // Input: raw H.264 elementary stream at `fps` (timestamps synthesized from -r).
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "h264".into(),
        "-r".into(),
        fps.to_string(),
        "-i".into(),
        video.into(),
    ];

    let audio = audio.filter(|a| !a.is_empty());
    if let Some(audio) = audio {
        // Align the mic to the trimmed video (flags go BEFORE `-i audio`).
        if audio_offset_ms > 0 {
            args.extend(["-ss".into(), format!("{:.3}", audio_offset_ms as f64 / 1000.0)]);
        } else if audio_offset_ms < 0 {
            args.extend([
                "-itsoffset".into(),
                format!("{:.3}", (-audio_offset_ms) as f64 / 1000.0),
            ]);
        }
        args.extend(["-i".into(), audio.into()]);
        args.extend([
            "-c:v".into(),
            "copy".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            // Map one video + one audio stream. NO -shortest: mic.webm from
            // MediaRecorder has no duration header, so -shortest treats the audio as
            // zero-length and drops it entirely. Video length bounds the output.
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
        ]);
    } else {
        args.extend(["-c:v".into(), "copy".into()]);
    }

    // Faststart so the muxed MP4 is web/seek friendly.
    args.extend(["-movflags".into(), "+faststart".into(), out.into()]);
    args
}

#[tauri::command]
pub async fn mux(
    app: AppHandle,
    video: String,
    audio: Option<String>,
    out: String,
    fps: u32,
    // Mic position vs the trimmed video (ms): >0 skip off its front, <0 delay it.
    audio_offset_ms: Option<i64>,
) -> Result<String, String> {
    let raw_video = video.clone(); // temp elementary stream — delete after muxing
    let args = build_mux_args(
        &video,
        audio.as_deref(),
        &out,
        fps,
        audio_offset_ms.unwrap_or(0),
    );

    run_ffmpeg(&app, args).await?;
    // Muxed OK → drop the raw elementary stream so only the .mp4 is left.
    let _ = std::fs::remove_file(&raw_video);
    Ok(out)
}

/// Generate a poster thumbnail (`thumb.jpg`) from a finalized recording.
///
/// Grabs a single frame ~1s in and scales it to 480px wide (height auto, aspect
/// preserved). Used by the dashboard library. Plain async helper (not a command):
/// `stop_recording` calls it after finalizing screen.mp4.
pub async fn make_thumbnail(app: &AppHandle, screen: &str, out: &str) -> Result<(), String> {
    run_ffmpeg(
        app,
        vec![
            "-y".into(),
            "-ss".into(),
            "1".into(),
            "-i".into(),
            screen.to_string(),
            "-vframes".into(),
            "1".into(),
            "-vf".into(),
            "scale=480:-1".into(),
            out.to_string(),
        ],
    )
    .await
}

/// Build a GIF from `input` using the high-quality palettegen/paletteuse two-pass flow.
/// `width` sets the output width (height auto, aspect preserved); `fps` the frame rate.
#[tauri::command]
pub async fn make_gif(
    app: AppHandle,
    input: String,
    out: String,
    fps: u32,
    width: u32,
) -> Result<String, String> {
    let palette = format!("{out}.palette.png");
    let filters = format!("fps={fps},scale={width}:-1:flags=lanczos");

    // Pass 1: generate an optimal palette.
    run_ffmpeg(
        &app,
        vec![
            "-y".into(),
            "-i".into(),
            input.clone(),
            "-vf".into(),
            format!("{filters},palettegen"),
            palette.clone(),
        ],
    )
    .await?;

    // Pass 2: apply the palette.
    run_ffmpeg(
        &app,
        vec![
            "-y".into(),
            "-i".into(),
            input,
            "-i".into(),
            palette.clone(),
            "-lavfi".into(),
            format!("{filters} [x]; [x][1:v] paletteuse"),
            out.clone(),
        ],
    )
    .await?;

    // Best-effort cleanup of the intermediate palette.
    let _ = std::fs::remove_file(&palette);

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::build_mux_args;

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn never_uses_shortest() {
        // -shortest drops the mic (no duration header) — must never appear.
        let a = build_mux_args("v.h264", Some("mic.webm"), "o.mp4", 60, -1266);
        assert!(!a.iter().any(|s| s == "-shortest"), "got: {a:?}");
        let b = build_mux_args("v.h264", Some("mic.webm"), "o.mp4", 60, 0);
        assert!(!b.iter().any(|s| s == "-shortest"));
    }

    #[test]
    fn audio_is_mapped_and_aac() {
        let a = build_mux_args("v.h264", Some("mic.webm"), "o.mp4", 60, 0);
        assert!(has_pair(&a, "-i", "mic.webm"));
        assert!(has_pair(&a, "-map", "0:v:0") && has_pair(&a, "-map", "1:a:0"));
        assert!(has_pair(&a, "-c:a", "aac"));
        assert!(has_pair(&a, "-c:v", "copy"));
    }

    #[test]
    fn negative_offset_delays_with_itsoffset() {
        let a = build_mux_args("v.h264", Some("mic.webm"), "o.mp4", 60, -1266);
        assert!(has_pair(&a, "-itsoffset", "1.266"), "got: {a:?}");
        assert!(!a.iter().any(|s| s == "-ss"));
        // -itsoffset must come BEFORE the audio input.
        let it = a.iter().position(|s| s == "-itsoffset").unwrap();
        let ai = a.iter().position(|s| s == "mic.webm").unwrap();
        assert!(it < ai);
    }

    #[test]
    fn positive_offset_seeks_with_ss() {
        let a = build_mux_args("v.h264", Some("mic.webm"), "o.mp4", 60, 3800);
        assert!(has_pair(&a, "-ss", "3.800"), "got: {a:?}");
        assert!(!a.iter().any(|s| s == "-itsoffset"));
    }

    #[test]
    fn no_audio_is_video_only() {
        let a = build_mux_args("v.h264", None, "o.mp4", 60, 0);
        assert!(!a.iter().any(|s| s == "-map"));
        assert!(!a.iter().any(|s| s == "-c:a"));
        assert!(has_pair(&a, "-c:v", "copy"));
    }

    #[test]
    fn empty_audio_string_is_video_only() {
        let a = build_mux_args("v.h264", Some(""), "o.mp4", 60, -100);
        assert!(!a.iter().any(|s| s == "-map"));
    }

    #[test]
    fn output_path_is_last_and_faststart_present() {
        let a = build_mux_args("v.h264", Some("mic.webm"), "out.mp4", 60, 0);
        assert_eq!(a.last().unwrap(), "out.mp4");
        assert!(has_pair(&a, "-movflags", "+faststart"));
        assert!(has_pair(&a, "-r", "60") && has_pair(&a, "-f", "h264"));
    }
}
