#!/usr/bin/env bash
# End-to-end check that export's mux produces an mp4 with BOTH video + audio,
# using the same ffmpeg the app uses. Pairs with the `cargo test --lib mux` unit
# tests (which pin the arg shape: no -shortest, correct -ss/-itsoffset, maps).
#
# Run:  bash src-tauri/scripts/verify-mux.sh
set -euo pipefail

FF="$(dirname "$0")/../target/debug/ffmpeg.exe"
[ -x "$FF" ] || FF="$(dirname "$0")/../binaries/ffmpeg-x86_64-pc-windows-msvc.exe"
[ -x "$FF" ] || { echo "FAIL: ffmpeg not found (build the app first)"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

# Synthetic inputs: raw annexb h264 (like the exporter writes) + opus webm with no
# duration header (like a MediaRecorder mic.webm — the case -shortest used to break).
"$FF" -y -f lavfi -i "testsrc=size=320x240:rate=60:duration=2" \
  -c:v libx264 -bsf:v h264_mp4toannexb -f h264 t.h264 2>/dev/null
"$FF" -y -f lavfi -i "sine=frequency=440:duration=2" -c:a libopus -f webm t.webm 2>/dev/null

# Same arg shape as build_mux_args (negative offset -> -itsoffset, NO -shortest).
"$FF" -y -f h264 -r 60 -i t.h264 -itsoffset 0.500 -i t.webm \
  -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -movflags +faststart out.mp4 2>/dev/null

V=$("$FF" -i out.mp4 2>&1 | grep -c "Video:")
A=$("$FF" -i out.mp4 2>&1 | grep -c "Audio:")
if [ "$V" = "1" ] && [ "$A" = "1" ]; then
  echo "E2E PASS: exported mp4 has video+audio"
else
  echo "E2E FAIL: video=$V audio=$A (expected 1/1)"; exit 1
fi
