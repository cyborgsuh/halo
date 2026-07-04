import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// No StrictMode: its dev double-mount creates+destroys the WebGL renderer twice on
// the same canvas, which crashes WebView2's GPU process. ponytail: re-add if the
// renderer lifecycle is ever made double-mount safe.
// TEMP diagnostic logger → <temp>/screen-recorder/debug.log (read by the dev).
const __log = (m: string) => {
  void invoke("append_log", { line: `[${new Date().toISOString()}] ${m}` }).catch(() => {});
};
(window as unknown as { __log: (m: string) => void }).__log = __log;

// Stop any stray ctrl+wheel page-zoom app-wide (the timeline handles its own zoom).
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false }
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
