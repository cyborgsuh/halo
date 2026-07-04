// cursor.rs — high-frequency cursor + click logger.
//
// Two producers feed one writer over a channel:
//   1. A timer thread sampling `GetCursorPos` every ~8ms (125Hz)  -> {btn:null}
//   2. A `WH_MOUSE_LL` low-level mouse hook for click events       -> {btn:"down"|"up"}
//
// Each line is appended to <dir>/cursor.jsonl as:
//   {"t":1234,"x":980,"y":540,"btn":null}
// where t = milliseconds since record start. Coordinates are in physical screen pixels
// (the process is expected to be per-monitor DPI aware, which Tauri's manifest sets).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, PeekMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, HHOOK, MSG, MSLLHOOKSTRUCT, PM_REMOVE,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN,
    WM_RBUTTONUP,
};

/// One sampled/recorded cursor line.
struct Line {
    t: u128,
    x: i32,
    y: i32,
    btn: Option<&'static str>,
}

/// State the LL mouse hook callback needs. Stored in a global guarded slot because the
/// `extern "system"` callback cannot capture environment.
struct HookState {
    tx: Sender<Line>,
    start: Instant,
}

// Only one recording is active at a time, so a single global slot is sufficient.
static HOOK_STATE: Mutex<Option<HookState>> = Mutex::new(None);

/// Owns the worker threads; `stop()` joins them and flushes the file.
pub struct CursorRecorder {
    stop: Arc<AtomicBool>,
    sampler: Option<JoinHandle<()>>,
    hook: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
}

impl CursorRecorder {
    /// Begin logging to `path`. `start` is the shared record-start clock used to compute
    /// `t` (ms) for every line — pass the same `Instant` the screen capture started at.
    pub fn start(path: String, start: Instant) -> Result<Self, String> {
        let file = File::create(&path).map_err(|e| format!("cursor.jsonl create failed: {e}"))?;

        let (tx, rx): (Sender<Line>, Receiver<Line>) = bounded(4096);
        let stop = Arc::new(AtomicBool::new(false));

        // Writer thread: drains the channel and appends JSONL until all senders drop.
        let writer = thread::spawn(move || {
            let mut w = BufWriter::new(file);
            while let Ok(line) = rx.recv() {
                let btn = match line.btn {
                    Some(b) => {
                        let mut s = String::with_capacity(b.len() + 2);
                        s.push('"');
                        s.push_str(b);
                        s.push('"');
                        s
                    }
                    None => "null".to_string(),
                };
                let _ = writeln!(
                    w,
                    "{{\"t\":{},\"x\":{},\"y\":{},\"btn\":{}}}",
                    line.t, line.x, line.y, btn
                );
            }
            let _ = w.flush();
        });

        // Publish hook state for the LL mouse hook callback.
        {
            let mut slot = HOOK_STATE.lock().unwrap();
            *slot = Some(HookState { tx: tx.clone(), start });
        }

        // Sampler thread: GetCursorPos every ~8ms.
        let sampler = {
            let stop = stop.clone();
            let tx = tx.clone();
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let mut pt = POINT::default();
                    let ok = unsafe { GetCursorPos(&mut pt) };
                    if ok.is_ok() {
                        let t = start.elapsed().as_millis();
                        // If the writer is gone, stop.
                        if tx.send(Line { t, x: pt.x, y: pt.y, btn: None }).is_err() {
                            break;
                        }
                    }
                    thread::sleep(Duration::from_millis(8));
                }
            })
        };

        // Hook thread: installs WH_MOUSE_LL and pumps messages so the hook can fire.
        let hook = {
            let stop = stop.clone();
            thread::spawn(move || {
                let hhook = unsafe {
                    SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), HINSTANCE::default(), 0)
                };
                let hhook = match hhook {
                    Ok(h) => h,
                    Err(_) => return, // hook install failed; clicks won't be logged
                };

                // Pump messages; the LL hook is dispatched during message retrieval.
                while !stop.load(Ordering::Relaxed) {
                    let mut msg = MSG::default();
                    unsafe {
                        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                    thread::sleep(Duration::from_millis(2));
                }

                unsafe {
                    let _ = UnhookWindowsHookEx(hhook);
                }
            })
        };

        // Drop our local `tx`; the only remaining senders live in the sampler thread and
        // the global HOOK_STATE, so the writer ends once both release them.
        drop(tx);

        Ok(Self {
            stop,
            sampler: Some(sampler),
            hook: Some(hook),
            writer: Some(writer),
        })
    }

    /// Stop sampling/hooking, flush and close cursor.jsonl.
    pub fn stop(mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Relaxed);

        if let Some(h) = self.sampler.take() {
            let _ = h.join();
        }
        if let Some(h) = self.hook.take() {
            let _ = h.join();
        }

        // Clear the global hook state, dropping its Sender so the writer can finish.
        {
            let mut slot = HOOK_STATE.lock().unwrap();
            *slot = None;
        }

        if let Some(h) = self.writer.take() {
            let _ = h.join();
        }
        Ok(())
    }
}

/// Low-level mouse hook procedure. Records button down/up transitions with the cursor
/// position carried by the event (physical screen pixels).
unsafe extern "system" fn low_level_mouse_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 {
        let btn: Option<&'static str> = match wparam.0 as u32 {
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN => Some("down"),
            WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP => Some("up"),
            _ => None,
        };

        if let Some(b) = btn {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if let Ok(slot) = HOOK_STATE.lock() {
                if let Some(state) = slot.as_ref() {
                    let t = state.start.elapsed().as_millis();
                    let _ = state.tx.send(Line {
                        t,
                        x: info.pt.x,
                        y: info.pt.y,
                        btn: Some(b),
                    });
                }
            }
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}
