// Run: npx tsx src/lib/export.test.ts
// Unit tests for export audio/video alignment (the part most likely to break with
// the countdown-trim). The actual encode/mux is WebCodecs+ffmpeg (integration);
// this pins the pure math that decides how the mic lines up with the trimmed video.

import assert from "node:assert";
import { audioMuxOffsetMs } from "./export";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log("  ok:", name);
};

// Real recording: editor trims to 2265ms; mic began at 3531ms on the source
// timeline. Mic starts AFTER the trim point → must be DELAYED by 1266ms.
t("mic after trim → negative (delay)", () => {
  assert.equal(audioMuxOffsetMs(2265, 3531), -1266);
});

// Mic started before the trim point → skip that much off its front (positive).
t("mic before trim → positive (skip)", () => {
  assert.equal(audioMuxOffsetMs(5000, 1200), 3800);
});

t("aligned start → zero", () => {
  assert.equal(audioMuxOffsetMs(3000, 3000), 0);
});

t("no trim, no offset → zero", () => {
  assert.equal(audioMuxOffsetMs(0, 0), 0);
});

t("rounds to whole ms (ffmpeg gets clean values)", () => {
  assert.equal(audioMuxOffsetMs(2265.4, 1000.1), 1265);
  assert.equal(Number.isInteger(audioMuxOffsetMs(2265.4, 1000.1)), true);
});

console.log(`\nALL ${passed} EXPORT TESTS PASSED`);
