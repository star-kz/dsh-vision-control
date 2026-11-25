/**
 * Task 0B (test-only): behavior freeze for internal/capture.mjs.
 *
 * Two halves: the screenshot envelope text (the model-facing contract — every line it
 * prints is behavior some downstream reasoning depends on) and the capture service
 * (ownership of files on disk, content-addressed dedup, and the A → B → A honesty rule).
 * All file I/O happens inside a real temp directory; no desktop, no worker.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createCaptureService, screenshotEnvelope, resolveFormat } from "../internal/capture.mjs";

const key = (id) => String(id ?? "");
const TMP = mkdtempSync(join(tmpdir(), "dsh-capture-test-"));
after(() => { rmSync(TMP, { recursive: true, force: true }); });

// ------------------------------------------------------------------ resolveFormat

test("resolveFormat: requested format wins, then path extension, then jpeg default", () => {
  assert.equal(resolveFormat("png", "x.jpg"), "png");
  assert.equal(resolveFormat("jpeg", "x"), "jpeg");
  assert.equal(resolveFormat("jpg", "x"), "jpeg");
  assert.equal(resolveFormat(undefined, "x.png"), "png");
  assert.equal(resolveFormat(undefined, "x.jpg"), "jpeg");
  assert.equal(resolveFormat(undefined, "x.jpeg"), "jpeg");
  assert.equal(resolveFormat(undefined, "x.bmp"), "jpeg", "unknown extensions fall back to jpeg");
  assert.equal(resolveFormat(undefined, undefined), "jpeg");
});

// ------------------------------------------------------------ screenshotEnvelope

const BASE = {
  path: "c.png", width: 100, height: 50, imageWidth: 100, imageHeight: 50,
  scale: 1, format: "png", x: 5, y: 10, cursor: { x: 1, y: 2 },
  activeWindow: "W", displays: "",
};

test("envelope: 1:1 frames say image pixels are screen pixels", () => {
  const out = screenshotEnvelope(BASE);
  assert.ok(out.startsWith("<screen_capture>\nfile: c.png"), out.slice(0, 60));
  assert.ok(out.endsWith("</screen_capture>"));
  assert.ok(out.includes("image: 100x50 px (png), captured at (5,10) of the Windows virtual desktop"));
  assert.ok(out.includes("scale: image pixels are screen pixels (1:1)"));
  assert.ok(out.includes("cursor: (1, 2)"));
  assert.ok(out.includes("active window: \"W\""));
  assert.ok(out.includes("coordinates: every pixel coordinate in this image and in the computer_* tools is an ABSOLUTE virtual-desktop pixel **in physical pixels**"));
  assert.ok(out.includes("Add the capture origin (5,10) to a position measured inside the image before clicking"));
});

test("envelope: empty foreground title reads as (untitled)", () => {
  const out = screenshotEnvelope({ ...BASE, activeWindow: "" });
  assert.ok(out.includes("active window: (untitled)"));
});

test("envelope: scaled frames give the multiply factor, not a divide", () => {
  const out = screenshotEnvelope({ ...BASE, scale: 0.5, imageWidth: 50, imageHeight: 25 });
  assert.ok(out.includes("scale: the image is 50x25 px for a 100x50 px screen region — multiply an image coordinate by 2.0000 before using it as a click target"), out);
});

test("envelope: unchanged and reused are reported as distinct facts", () => {
  const both = screenshotEnvelope({ ...BASE, unchanged: true, reused: true });
  assert.ok(both.includes("unchanged: this frame is byte-identical to the *previous* frame this conversation was shown"));
  assert.ok(!both.includes("reused: this image is the same file"), "reused is suppressed when the screen really is unchanged");
  const reusedOnly = screenshotEnvelope({ ...BASE, reused: true });
  assert.ok(reusedOnly.includes("reused: this image is the same file already delivered earlier in this conversation (the attachment was not stored twice) — it is not a claim about the screen"));
  assert.ok(!reusedOnly.includes("unchanged: this frame is byte-identical"));
  const neither = screenshotEnvelope(BASE);
  assert.ok(!neither.includes("unchanged:"));
  assert.ok(!neither.includes("reused:"));
});

test("envelope: pacing states — timeout carries the budget, watch-loss carries the note", () => {
  const timeout = screenshotEnvelope({ ...BASE, stability: { state: "timeout", budgetMs: 500, polls: 3, waitedMs: 1200 } });
  assert.ok(timeout.includes("still changing: the picture had not stopped changing within the 500 ms you asked for (3 sample(s), 1200 ms)"), timeout);
  const lost = screenshotEnvelope({ ...BASE, stability: { state: "other-target", note: "the watched window went away" } });
  assert.ok(lost.includes("while waiting: the watched window went away"));
  const bare = screenshotEnvelope({ ...BASE, stability: { state: "target-lost" } });
  assert.ok(bare.includes("while waiting: target-lost"));
  const conflict = screenshotEnvelope({ ...BASE, stability: { conflict: "stable=false vs stability_ms" } });
  assert.ok(conflict.includes("pacing: stable=false vs stability_ms"));
});

test("envelope: crop regions name the image origin as a screen coordinate", () => {
  const out = screenshotEnvelope({ ...BASE, crop: { x: 10, y: 20, width: 100, height: 50 }, surfaceKind: "screen" });
  assert.ok(out.includes("region: this frame is the 100x50 px part of the captured surface at (10,20) within it — so image (0,0) is screen (5,10)"), out);
  const windowRegion = screenshotEnvelope({ ...BASE, crop: { x: 10, y: 20, width: 100, height: 50 }, surfaceKind: "wholeWindow" });
  assert.ok(windowRegion.includes("part of that window"));
});

test("envelope: capture source — window pixels vs whatever was on top", () => {
  const win = screenshotEnvelope({ ...BASE, source: "window", window: { hwnd: 99 } });
  assert.ok(win.includes("how: hwnd 99 drew its own pixels — this is that window even if something covers it on screen"));
  const screen = screenshotEnvelope({ ...BASE, source: "screen" });
  assert.ok(screen.includes("how: copied from the screen at these coordinates — whatever was on top is what you are looking at"));
});

test("envelope: frame handoff line and verification join", () => {
  const out = screenshotEnvelope({ ...BASE, frame: "f12ab", verification: ["window still alive", "pixels re-read"] });
  assert.ok(out.includes("frame: f12ab — pass it as from_frame with x,y measured *in this image*, and the projection (origin and scale) is done for you, with the frame checked before anything is dispatched"));
  assert.ok(out.includes("checked: window still alive; pixels re-read"));
});

test("envelope: timing parts in the fixed order; absent timing prints no line", () => {
  const timing = { captureMs: 5, startMs: 10, queueMs: 2, backendMs: 7, settleMs: 3, pollMs: 4, polls: 2, admitMs: 1 };
  const out = screenshotEnvelope({ ...BASE, timing });
  assert.ok(out.includes("timing: 5 ms for this call, 10 ms waiting for the worker to start, 2 ms queued behind another call, 7 ms inside the worker, settle 3 ms, stability poll 4 ms in 2 sample(s), 1 ms to attach"), out);
  assert.ok(!screenshotEnvelope(BASE).includes("timing:"));
  const partial = screenshotEnvelope({ ...BASE, timing: { captureMs: 5, admitMs: 2 } });
  assert.ok(partial.includes("timing: 5 ms for this call, 2 ms to attach"));
});

test("envelope: extra notes and display lines are indented two spaces", () => {
  const out = screenshotEnvelope({ ...BASE, displays: "#0 A 1x2\n#1 B 3x4", clipped: true, scaleNote: "png over budget became webp" });
  assert.ok(out.includes("displays:\n  #0 A 1x2\n  #1 B 3x4"));
  assert.ok(out.includes("clipped: the requested region ran past the virtual desktop and was trimmed to the part that exists"));
  assert.ok(out.includes("scale note: png over budget became webp"));
});

// ------------------------------------------------------------ capture service

function makeAttachments({ fail = false, empty = false } = {}) {
  const saved = [];
  return {
    saved,
    saveImages: async (images) => {
      saved.push(images);
      if (fail) throw new Error("attachment store exploded");
      if (empty) return [undefined];
      const img = images[0];
      return [{ attachmentId: "att-" + saved.length, mediaType: "image/webp", bytes: 1234, width: 400, height: 200, name: img.name }];
    },
  };
}

function makeCtx(attachments) {
  return { get: (name) => (name === "attachments" ? attachments : undefined) };
}

function makeService() {
  return createCaptureService({ sessionKey: key });
}

test("nextCapturePath: sequential names, jpeg→jpg, tracked as unclaimed until admitted", () => {
  const svc = makeService();
  const p1 = svc.nextCapturePath(TMP, "jpeg");
  const p2 = svc.nextCapturePath(TMP, "png");
  assert.ok(p1.startsWith(TMP), p1);
  assert.ok(p1.endsWith(`capture-${process.pid}-1.jpg`), p1);
  assert.ok(p2.endsWith(`capture-${process.pid}-2.png`), p2);
  assert.equal(svc.pendingCount(), 2);
});

test("admit without an attachment store returns the read_image note", async () => {
  const svc = makeService();
  const path = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(path, "bytes");
  const out = await svc.admit({ get: () => undefined }, path, "image/jpeg", "shot.jpg", 1);
  assert.deepEqual(out, { note: "No attachment store is mounted, so the image is not attached. Read it with the read_image tool: " + path });
});

test("admit: fresh capture returns ref-derived image fields (the ref wins over the inputs)", async () => {
  const svc = makeService();
  const path = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(path, "fresh-bytes");
  const out = await svc.admit(makeCtx(makeAttachments()), path, "image/jpeg", "shot.jpg", 1);
  assert.equal(out.image.attachmentId, "att-1");
  assert.equal(out.image.mediaType, "image/webp", "the stored ref media type wins over the requested one (lossy re-encode lesson)");
  assert.equal(out.image.bytes, 1234);
  assert.equal(out.image.width, 400);
  assert.equal(out.image.height, 200);
  assert.equal(out.image.name, "shot.jpg");
  assert.equal(out.reused, undefined);
  assert.equal(out.unchanged, undefined);
});

test("admit: immediate repeat is reused AND unchanged; A → B → A is reused but NOT unchanged", async () => {
  const svc = makeService();
  const ctx = makeCtx(makeAttachments());
  const a = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(a, "AAA");
  const b = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(b, "BBB");
  const first = await svc.admit(ctx, a, "image/jpeg", "a.jpg", 1);
  assert.equal(first.unchanged, undefined);
  const repeat = await svc.admit(ctx, a, "image/jpeg", "a.jpg", 1);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.image, first.image, "the cached image object is handed back, not rebuilt");
  const mid = await svc.admit(ctx, b, "image/jpeg", "b.jpg", 1);
  assert.equal(mid.reused, undefined);
  const back = await svc.admit(ctx, a, "image/jpeg", "a.jpg", 1);
  assert.equal(back.reused, true, "the bytes are still cached, so the attachment is reused");
  assert.equal(back.unchanged, undefined, "the screen moved twice — honesty rule: not unchanged");
});

test("admit: a failing save does not commit the frame as seen", async () => {
  const svc = makeService();
  const path = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(path, "AAA");
  const failing = makeCtx(makeAttachments({ fail: true }));
  const out = await svc.admit(failing, path, "image/jpeg", "a.jpg", 1);
  assert.ok(out.note.startsWith("The capture could not be attached (attachment store exploded). Read it with the read_image tool instead: "));
  // same bytes, now with a working store: must NOT claim unchanged
  const working = makeCtx(makeAttachments());
  const retry = await svc.admit(working, path, "image/jpeg", "a.jpg", 1);
  assert.equal(retry.unchanged, undefined, "the failed frame was never shown, so it cannot be unchanged");
  assert.equal(retry.image.attachmentId, "att-1");
});

test("admit: a save that returns no ref is not treated as attached", async () => {
  const svc = makeService();
  const path = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(path, "AAA");
  const out = await svc.admit(makeCtx(makeAttachments({ empty: true })), path, "image/jpeg", "a.jpg", 1);
  assert.deepEqual(out, { note: "The capture was not attached. Read it with the read_image tool: " + path });
});

test("admit: the dedup cache holds 8 entries — the 9th distinct frame evicts the first", async () => {
  const svc = makeService();
  const attachments = makeAttachments();
  const ctx = makeCtx(attachments);
  const paths = [];
  for (let i = 0; i < 9; i++) {
    const p = svc.nextCapturePath(TMP, "jpeg");
    writeFileSync(p, "content-" + i);
    paths.push(p);
    await svc.admit(ctx, p, "image/jpeg", "f" + i + ".jpg", 1);
  }
  assert.equal(attachments.saved.length, 9);
  // digest of frame 0 has been evicted: admitting its bytes again stores them again
  const again = await svc.admit(ctx, paths[0], "image/jpeg", "f0-again.jpg", 1);
  assert.equal(again.reused, undefined, "the evicted digest is a fresh store, not a reuse");
  assert.equal(attachments.saved.length, 10);
});

test("releaseSession deletes the session files and their .related-* siblings, and only those", async () => {
  const svc = makeService();
  const ctx = makeCtx(makeAttachments());
  const mine = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(mine, "mine");
  await svc.admit(ctx, mine, "image/jpeg", "mine.jpg", 77);
  const related = join(TMP, basename(mine) + ".related-2-9999");
  writeFileSync(related, "sibling");
  const other = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(other, "somebody-else");
  // a different session claims its own file so it is deliberately not touched
  await svc.admit(ctx, other, "image/jpeg", "other.jpg", 88);
  const before = new Set(readdirSync(TMP));
  assert.ok(before.has(basename(mine)));
  assert.ok(before.has(basename(related)));
  const handled = await svc.releaseSession(77);
  assert.ok(handled >= 2, "the base file plus the related sibling were handled");
  const after = new Set(readdirSync(TMP));
  assert.ok(!after.has(basename(mine)), "the session own capture is deleted");
  assert.ok(!after.has(basename(related)), "derived frames go with their base");
  assert.ok(after.has(basename(other)), "another session files are not touched");
  assert.equal(svc.pendingCount(), 1);
  // second release is a no-op
  assert.equal(await svc.releaseSession(77), 0);
  await svc.releaseAll();
});

test("releaseAll also sweeps the never-admitted (unclaimed) leftovers", async () => {
  const svc = makeService();
  const ctx = makeCtx(makeAttachments());
  const claimed = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(claimed, "claimed");
  await svc.admit(ctx, claimed, "image/jpeg", "c.jpg", 5);
  const orphan = svc.nextCapturePath(TMP, "jpeg");
  writeFileSync(orphan, "orphan");
  assert.equal(svc.pendingCount(), 2);
  const handled = await svc.releaseAll();
  assert.ok(handled >= 2);
  const after = new Set(readdirSync(TMP));
  assert.ok(!after.has(basename(claimed)));
  assert.ok(!after.has(basename(orphan)));
  assert.equal(svc.pendingCount(), 0);
});

test("admit claims only files the service itself produced; foreign paths pass through unclaimed", async () => {
  const svc = makeService();
  const ctx = makeCtx(makeAttachments());
  const foreign = join(TMP, "caller-specified.jpg");
  writeFileSync(foreign, "caller bytes");
  await svc.admit(ctx, foreign, "image/jpeg", "foreign.jpg", 9);
  await svc.releaseAll();
  const after = new Set(readdirSync(TMP));
  assert.ok(after.has(basename(foreign)), "a caller-specified save_path is not the service file to delete");
});
