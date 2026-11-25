/**
 * Task 0B (test-only): behavioral tests for the frame projection math.
 *
 * 'frameproject' is a real worker command designed as a pure function — the
 * registry entry lives only for the duration of the call — so these tests
 * drive the REAL backend/worker.ps1 (read-only; no input is ever sent to the
 * desktop; frameproject is an isolated read command in index.js).
 *
 * The six frameprojection TODOs:
 *   1. projection identity round-trip (1:1) + deterministic double-feed;
 *   2. ToAbsolute rounding direction at the .5 boundary (AwayFromZero);
 *   3. the screenshot envelope / frame projection pair (scale 0.5 promised
 *      "multiply by 2.0000"; the projection really doubles);
 *   4. boundary coordinates outside the image refuse with BAD_REQUEST;
 *   5. DPI_CHANGED refusal (mismatched dpi);
 *   6. content-verification refusal (FRAME_CONTENT_CHANGED) and the registry
 *      retirement refusal (unknown frame id).
 *
 * Documented deviations (semantics preserved, wording frozen as shipped):
 *   - EXPIRED_FRAME as such is produced by the click path for ids the worker
 *     retired; through the frameproject/frameattach surface the unknown-id
 *     refusal is its own text ("is not in this worker's registry any more").
 *   - FRAME_STALE (window moved/resized) and DISPLAY_TOPOLOGY_CHANGED need a
 *     real window/layout change; they are not reachable from a synthetic
 *     screen frame (the virtual bounds are always re-read live), so they stay
 *     covered by the worker's own error-table contract, not faked here.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PowerShellBackend, resolvePowerShell } from "../backend/bridge.js";
import { STEP_ACTION_LIST } from "../internal/failures.mjs";
import { screenshotEnvelope } from "../internal/capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "backend", "worker.ps1");

let backend = null;
before(async () => {
  backend = new PowerShellBackend({
    scriptPath: WORKER,
    powerShell: resolvePowerShell(),
    timeoutMs: 15_000,
    startTimeoutMs: 60_000,
  });
  await backend.start();
});
after(() => {
  try { backend?.dispose(); } catch { /* already disposed */ }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
after(() => sleep(200));

/** A synthetic 1:1 screen frame; overrides replace parts of the spec. */
function frameSpec(overrides = {}) {
  const info = backend.info;
  const vx = info.virtual.x, vy = info.virtual.y;
  return {
    surface: { x: vx + 50, y: vy + 50, width: 100, height: 100 },
    ...overrides,
  };
}

function project(frame, x, y, extra = {}) {
  return backend.request("frameproject", { frame, x, y, ...extra });
}

// --------------------------------------------------------------------- TODO 1

test("the real worker speaks the host action contract", () => {
  const info = backend.info;
  assert.equal(info.protocol, 2);
  assert.equal(
    info.actions.map(String).join(","),
    STEP_ACTION_LIST.join(","),
    "the shipped worker's action list is STEP_ACTION_LIST, in order",
  );
});

test("projection identity round-trip: a 1:1 frame maps image pixels to screen pixels, deterministically", async () => {
  const spec = {
    surface: { x: 100, y: 200, width: 640, height: 480 },
  };
  const r = await project(spec, 320, 240);
  assert.equal(r.ok, true);
  assert.equal(r.x, 100 + 320, "x = surface origin + image x");
  assert.equal(r.y, 200 + 240, "y = surface origin + image y");
  assert.equal(r.drift, 0);
  assert.equal(r.guard, "no-target", "a screen frame has no window identity to check against");
  assert.equal(r.mapping, "encoded-1:1");
  assert.equal(r.recovered, false);
  // (0,0) is the corner of the image, not the screen
  const corner = await project(spec, 0, 0);
  assert.equal(corner.x, 100);
  assert.equal(corner.y, 200);
  // deterministic double-feed: same spec, same answer, bit for bit
  const again = await project(spec, 320, 240);
  assert.deepEqual(again, r);
});

// --------------------------------------------------------------------- TODO 2

test("rounding at the .5 boundary goes away from zero: crop 50, encoded 100 halves image coords", async () => {
  const spec = {
    surface: { x: 0, y: 0, width: 100, height: 100 },
    crop: { x: 0, y: 0, width: 50, height: 100 },
    encoded: { width: 100, height: 200 }, // crop/encoded = 0.5 in both axes
  };
  // px=1 -> 0.5 exactly: AwayFromZero rounds UP (the click lands at 1, not 0)
  const up = await project(spec, 1, 3);
  assert.equal(up.ok, true);
  assert.equal(up.x, 1, "0.5 rounds away from zero, so the click lands inside the pixel you pointed at");
  assert.equal(up.y, 2, "1.5 rounds away from zero too");
  // exact values do not move
  const exact = await project(spec, 2, 4);
  assert.equal(exact.x, 1);
  assert.equal(exact.y, 2);
  const zero = await project(spec, 0, 0);
  assert.equal(zero.x, 0);
  assert.equal(zero.y, 0);
});

// --------------------------------------------------------------------- TODO 3

test("envelope pair: the scale note the host writes matches the direction the worker projects", async () => {
  // a screenshot scaled 0.5 tells the model to multiply by 2 before clicking...
  const envelope = screenshotEnvelope({
    path: "shot.png", format: "png", bytes: 1,
    width: 100, height: 50,           // screen region
    imageWidth: 50, imageHeight: 25,  // encoded image (scale 0.5)
    scale: 0.5, x: 0, y: 0,
    displays: "", cursor: { x: 0, y: 0 }, activeWindow: "",
  });
  assert.ok(envelope.includes("scale: the image is 50x25 px for a 100x50 px screen region — multiply an image coordinate by 2.0000 before using it as a click target"), envelope);
  // ...and a frame with the same geometry really does double the coordinates
  const spec = {
    surface: { x: 0, y: 0, width: 100, height: 50 },
    crop: { x: 0, y: 0, width: 100, height: 50 },
    encoded: { width: 50, height: 25 },
  };
  const r = await project(spec, 10, 10);
  assert.equal(r.ok, true);
  assert.equal(r.x, 20, "the projection performs the inverse the envelope promised");
  assert.equal(r.y, 20);
  assert.equal(r.mapping, "encoded-1:1", "crop == surface, so the scale is folded into the crop ratio, not a separate mapping");
});

// --------------------------------------------------------------------- TODO 4

test("boundary coordinates: an image point outside the frame refuses before anything is dispatched", async () => {
  const spec = { surface: { x: 0, y: 0, width: 100, height: 100 } };
  const r = await project(spec, 500, 10);
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith("[BAD_REQUEST] (500,10) is outside frame __probe__, whose image is 100x100 px"), r.error);
  assert.ok(r.error.includes("this is a boundary coordinate in the image you were shown, not a screen coordinate"), "the refusal explains the coordinate system");
  assert.ok(r.error.includes("(action_sent=false)"), "nothing was sent to the desktop");
  assert.equal(typeof r.transform, "object", "the refusal still carries the transform it computed");
});

// --------------------------------------------------------------------- TODO 5

test("DPI_CHANGED: a frame recorded at another dpi refuses and asks for a new capture", async () => {
  // find a dpi value that mismatches this machine (per-monitor setups differ)
  let mismatch = 96;
  let r = await project(frameSpec({ dpi: 96 }), 10, 10);
  if (r.ok === true) {
    mismatch = 144; // 96 matched this system; 144 certainly is not it
    r = await project(frameSpec({ dpi: 144 }), 10, 10);
  }
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith("[DPI_CHANGED]"), r.error);
  assert.ok(
    new RegExp(
      "the system is at \\d+ dpi now and was at " + mismatch + " dpi when frame __probe__ was taken",
    ).test(r.error),
    r.error,
  );
  assert.ok(r.error.includes("Take a new capture"), "the recovery instruction is in the refusal");
  assert.ok(r.error.includes("(action_sent=false, recovery=computer_screenshot)"));
  assert.equal(typeof r.transform, "object");
});

// --------------------------------------------------------------------- TODO 6

test("content verification: a surface that no longer looks the same refuses, and only when asked", async () => {
  const stale = frameSpec({
    surfaceDigest: "deadbeef", // never the real digest of a live screen
    ageMs: 3000,               // older than the verify window (2500 ms default)
  });
  const refused = await project(stale, 10, 10, { verifyContent: true });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.startsWith("[FRAME_CONTENT_CHANGED]"), refused.error);
  assert.ok(refused.error.includes("frame __probe__ was taken 3000 ms ago and the surface it came from does not look the same any more"), refused.error);
  assert.ok(refused.error.includes("(action_sent=false, recovery=computer_screenshot)"));
  // without verifyContent the same stale frame projects fine — it is an opt-in guard
  const unguarded = await project(stale, 10, 10, { verifyContent: false });
  assert.equal(unguarded.ok, true);
  // and a fresh frame passes the check even when asked (age inside the window is skipped)
  const fresh = await project(frameSpec({ surfaceDigest: "deadbeef" }), 10, 10, { verifyContent: true });
  assert.equal(fresh.ok, true, "ageMs 0 is inside the verify window, so the digest is not consulted");
});

test("registry retirement: an unknown frame id refuses instead of projecting a guess", async () => {
  const r = await backend.request("frameattach", { frame: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.known, false);
  assert.equal(r.frame, "nope");
  assert.ok(r.error.includes("frame 'nope' is not in this worker's registry any more"), r.error);
});
